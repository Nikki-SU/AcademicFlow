/**
 * 全局录音状态（会议/课程页 + 悬浮录音球共用）
 * -------------------------------------------------
 * 状态放 zustand、MediaRecorder 句柄放模块级变量 —— 于是**切页面 / 路由不中断录音**：
 * 组件卸载只解绑 UI，录音与转写链路在 store 里继续跑。
 *
 * 录音：**一条 MediaRecorder 从头录到尾，绝不中断**（一节 90 分钟也不丢一秒），
 * 用 start(10000) 每 10 秒切一个 dataavailable 事件而已 —— 切片只切事件、不停采集。
 *
 * 切片后仍要能转写，靠的是**容器头复用**：第一片里带着 WebM 的 EBML/Tracks 前导
 * （Safari 是 MP4 的 ftyp+moov），把它抠出来存下来，拼到后续每一片的前面 ——
 * 于是「头 + 本片数据簇」拼出来又是一个完整可解码的文件（同 MSE 追加分段的原理）。
 * 只切事件、不停采集，既没有启停空窗，每片后端也能解。之前用 start(30000) 直接
 * 把裸数据簇发出去，后端没有头解不出来，正是「录了一分钟一个字都没有」的根因。
 *
 * 每片立即直连硅基流动转写；language 非中文且开了翻译 → 再翻译。
 * **音频片段用完即弃，不落任何存储**；只有文本进 segments，停止时才落私库。
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import { transcribeAudio, translateText, pickAudioMimeType, audioFileNameFor } from '../services/asr'
import { saveTranscript } from '../services/sessionData'
import { useSettingsStore } from './settings'
import { useSessionStore } from './session'

export type RecorderStatus = 'idle' | 'recording' | 'paused' | 'stopping'

export interface RecorderSegment {
  id: string
  /** 片段生成时刻（Unix ms） */
  at: number
  text: string
  language: string
  /** 译文；空串 = 无译文 */
  translation: string
}

interface RecorderState {
  status: RecorderStatus
  startedAt: number | null
  targetTaskId: string | null
  sessionId: string | null
  segments: RecorderSegment[]
  error: string | null
  /** 转写失败、暂存在内存里待重试的片数（>0 = 有内容还没转成，别关页面） */
  pendingCount: number
  start: (targetTaskId: string) => Promise<void>
  stop: () => Promise<void>
  /** 重试所有暂存失败的片，并把新补回的写入私库 */
  retryPending: () => Promise<void>
  setTarget: (taskId: string | null) => void
  clear: () => void
}

const IDLE = {
  status: 'idle' as RecorderStatus,
  startedAt: null as number | null,
  targetTaskId: null as string | null,
  sessionId: null as string | null,
  segments: [] as RecorderSegment[],
  error: null as string | null,
  pendingCount: 0,
}

// ── 模块级句柄（组件卸载不停录音，故不放组件里） ──
let mediaRecorder: MediaRecorder | null = null
let mediaStream: MediaStream | null = null
let stopResolve: (() => void) | null = null
/** 串行处理每一片，保证 segments 顺序与录音顺序一致 */
let chunkChain: Promise<void> = Promise.resolve()
/** 每片时长（ms）：只切 dataavailable 事件，录音本身不中断。
 *  10 秒一片 —— 越短首字越快、丢字风险越小；代价是请求更密（SenseVoice 免费，可承受）。 */
const SEGMENT_MS = 10000
/** 单片转写的「正常」超时（ms）：一次尝试卡住就中止它，避免拖住整条串行链。
 *  ⚠️ 中止 ≠ 丢弃：这一片的音频会**留在内存里等重试**（见 pendingChunks），
 *  因为音频本就不入库，丢了就真没了。 */
const CHUNK_TIMEOUT_MS = 25000
/** 补转写（对暂存片重试）的超时（ms）：宽裕些，宁可慢也要把它转出来。 */
const DRAIN_TIMEOUT_MS = 90000
/** 容器头（第一片里的 EBML/Tracks 或 ftyp+moov），拼到后续每片前面 */
let initSegmentBytes: Uint8Array | null = null
/** 转写失败、暂存待重试的片（音频仍在内存 —— 录完不停、失败不丢，停止后还能补） */
let pendingChunks: { at: number; blob: Blob }[] = []
/** 是否正在补转写（避免并发重复补同一片） */
let draining = false
/** 已写入私库的 segment id：停止时已保存的，重试补写时不再重复追加 */
const savedSegIds = new Set<string>()

/** 是不是中文（转写接口可能返回 zh / zh-CN / Chinese / cmn / yue 等） */
function isZhLanguage(lang: string): boolean {
  const l = lang.trim().toLowerCase()
  return (
    l === 'zh' ||
    l.startsWith('zh-') ||
    l.includes('chinese') ||
    l.includes('cmn') ||
    l.includes('yue')
  )
}

interface AsrRuntimeConfig {
  baseUrl: string
  apiKey: string
  model: string
  translateModel: string
  translateToZh: boolean
}

/** 每次取片都读一次最新设置（录音中改设置也能生效） */
function readAsrConfig(): AsrRuntimeConfig {
  const s = useSettingsStore.getState()
  return {
    baseUrl: (s.asrBaseUrl || '').trim() || 'https://api.siliconflow.cn/v1',
    apiKey: (s.asrApiKey || '').trim(),
    model: (s.asrModel || '').trim() || 'FunAudioLLM/SenseVoiceSmall',
    translateModel: (s.asrTranslateModel || '').trim(),
    translateToZh: !!s.asrTranslateToZh,
  }
}

/** 在字节流里找一段 ASCII 串，返回首次出现的下标（找不到 -1） */
function indexOfAscii(buf: Uint8Array, ascii: string): number {
  const needle = [...ascii].map((c) => c.charCodeAt(0))
  outer: for (let i = 0; i + needle.length <= buf.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/**
 * 从第一片数据里抠出「容器头」，供后续裸数据簇复用。
 * - WebM：Cluster 元素 ID = 1F 43 B6 75，之前的部分（EBML + Segment + Info + Tracks）就是头
 * - MP4（Safari 的 fMP4）：第一个 'moof' 之前的部分（ftyp + moov）就是头
 * 找不到就返回 null（未知容器），调用方退回「原样发送」并告警。
 */
function extractInitSegment(buf: Uint8Array, mime: string): Uint8Array | null {
  const m = mime.toLowerCase()
  if (m.includes('webm')) {
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (buf[i] === 0x1f && buf[i + 1] === 0x43 && buf[i + 2] === 0xb6 && buf[i + 3] === 0x75) {
        return buf.slice(0, i)
      }
    }
    return null
  }
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) {
    const idx = indexOfAscii(buf, 'moof')
    return idx > 0 ? buf.slice(0, idx) : null
  }
  return null
}

/** 处理一片录音数据：第一片抽头并直接转写，后续片「头 + 裸簇」拼接后再转写 */
async function processChunk(data: Blob, mimeType: string | undefined, at: number): Promise<void> {
  if (!data || data.size === 0) {
    console.warn('[recorder] 收到空分片，跳过')
    return
  }
  const mime = data.type || mimeType || 'audio/webm'
  const buf = new Uint8Array(await data.arrayBuffer())
  if (!initSegmentBytes) {
    initSegmentBytes = extractInitSegment(buf, mime)
    if (!initSegmentBytes) {
      console.warn('[recorder] 未识别的音频容器，未能抽出容器头，后续分片可能无法转写：', mime)
    }
    console.log(`[recorder] 首片到达：${buf.length} 字节，容器头 ${initSegmentBytes?.length ?? 0} 字节`)
    await handleChunk(new Blob([buf as BlobPart], { type: mime }), at)
  } else {
    console.log(`[recorder] 分片到达：${buf.length} 字节（已拼接容器头）`)
    await handleChunk(new Blob([initSegmentBytes as BlobPart, buf as BlobPart], { type: mime }), at)
  }
}

/** 单次转写一片；失败 / 超时一律 throw（重试与兜底交给 handleChunk）。 */
async function transcribeOnce(blob: Blob, at: number, timeoutMs: number): Promise<void> {
  const cfg = readAsrConfig()
  if (!cfg.apiKey) throw new Error('会议转写 Key 为空（设置 → 会议转写）')

  const startedAt = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const { text, language } = await transcribeAudio(
      blob,
      { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
      ctrl.signal,
      audioFileNameFor(blob), // 按真实容器给扩展名（Safari 录的是 mp4，不能叫 webm）
    )
    console.log(`[asr] 本片转写耗时 ${Date.now() - startedAt}ms`)
    if (!text.trim()) {
      // 端点通了但没出字（静音 / 没说话）；记一笔，别让「静默丢弃」看起来像坏了
      console.warn('[asr] 本段转写返回空文本（可能是静音或没人说话）')
      return
    }

    let translation = ''
    if (cfg.translateToZh && !isZhLanguage(language) && cfg.translateModel) {
      try {
        translation = await translateText(text, {
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.translateModel,
        })
      } catch (e) {
        // 翻译失败不影响原文入库 —— 但要显式告知，不静默
        const msg = e instanceof Error ? e.message : String(e)
        toast.error(`翻译失败：${msg}`, { duration: 8000 })
      }
    }

    const seg: RecorderSegment = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      at,
      text,
      language,
      translation,
    }
    // 按到达时间插入：补回来的片（at 是原始时刻）也能落到正确位置
    useRecorderStore.setState((s) => ({
      segments: [...s.segments, seg].sort((a, b) => a.at - b.at),
    }))
  } finally {
    clearTimeout(timer)
  }
}

/** 同步「待重试片数」到 store，供 UI 显示/重试 */
function syncPending(): void {
  useRecorderStore.setState({ pendingCount: pendingChunks.length })
}

/**
 * 补转写所有暂存失败的片。**不阻塞主链**：一次卡住就跳出，留给下一次机会
 * （每成功转一片后、以及停止时都会再调一次）。音频一直在内存里，不会丢。
 */
async function drainPending(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (pendingChunks.length > 0) {
      const item = pendingChunks[0]
      try {
        await transcribeOnce(item.blob, item.at, DRAIN_TIMEOUT_MS)
        pendingChunks.shift()
        syncPending()
      } catch (e) {
        // 还是不行（网络/Key）：保留这一片，等下次机会，绝不丢弃
        console.warn('[asr] 补转写仍失败，保留待下次：', e instanceof Error ? e.message : String(e))
        break
      }
    }
  } finally {
    draining = false
  }
}

async function handleChunk(blob: Blob, at: number): Promise<void> {
  try {
    await transcribeOnce(blob, at, CHUNK_TIMEOUT_MS)
    if (pendingChunks.length > 0) void drainPending()
  } catch (e) {
    // 超时 / 失败都**不丢弃**：这一片音频放进 pending，稍后（或停止时）再补
    const aborted = e instanceof DOMException && e.name === 'AbortError'
    const msg = aborted
      ? `本片转写超时（>${CHUNK_TIMEOUT_MS / 1000}s）`
      : e instanceof Error
        ? e.message
        : String(e)
    pendingChunks.push({ at, blob })
    syncPending()
    useRecorderStore.setState({ error: `${msg}（已暂存待重试，不会丢）` })
    toast.error(`本片转写失败，已暂存待重试（不会丢）：${msg}`, { duration: 8000 })
    if (!draining) void drainPending()
  }
}

/** 把一片数据挂到串行链上（含抽头/拼接）；到达时刻 at 一并带上，供乱序补写时排序 */
function enqueueData(data: Blob, mimeType: string | undefined): void {
  const at = Date.now()
  chunkChain = chunkChain.then(() => processChunk(data, mimeType, at)).catch(() => {})
}

export const useRecorderStore = create<RecorderState>((set, get) => ({
  ...IDLE,

  start: async (targetTaskId) => {
    const { status } = get()
    if (status === 'recording' || status === 'stopping') return

    // 上一轮还有没转成的片（音频只在内存里）：先重试补完再录，否则会被清掉丢失
    if (pendingChunks.length > 0) {
      toast.error(`上一轮还有 ${pendingChunks.length} 片没转成，先点「重试未完成」补完再开始新录音`, {
        duration: 10000,
      })
      return
    }

    const cfg = readAsrConfig()
    if (!cfg.apiKey) {
      toast.error('还没配置会议转写 Key（设置 → 会议转写）')
      return
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      toast.error('当前环境无法录音（需 HTTPS 或 localhost，且浏览器支持麦克风）')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStream = stream

      // 一条 recorder 连录到底，只每 10 秒切一个 dataavailable —— 录音零中断
      const mimeType = pickAudioMimeType()
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      mediaRecorder = recorder
      initSegmentBytes = null
      pendingChunks = []
      savedSegIds.clear()
      recorder.ondataavailable = (e) => {
        enqueueData(e.data, mimeType)
      }
      recorder.onstop = () => {
        stopResolve?.()
        stopResolve = null
      }
      recorder.onerror = (ev) => {
        const err = (ev as unknown as { error?: DOMException }).error
        const msg = err?.message || '录音器发生错误'
        set({ error: msg })
        toast.error(`录音出错：${msg}`)
      }
      recorder.start(SEGMENT_MS)

      // 课时 id 由 session store 统一持有 —— 录音与照片挂在同一节课下，
      // 于是这节课最终得到 transcript.md（本录音）+ board.md（照片识别）两份。
      set({
        status: 'recording',
        startedAt: Date.now(),
        targetTaskId,
        sessionId: useSessionStore.getState().ensure(targetTaskId),
        segments: [],
        error: null,
        pendingCount: 0,
      })
    } catch (err) {
      // 权限被拒 / 设备不可用：写 error 并提示，不静默
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg, status: 'idle' })
      toast.error(`无法开始录音：${msg}`)
    }
  },

  stop: async () => {
    const { status } = get()
    if (status !== 'recording' && status !== 'stopping') return
    set({ status: 'stopping' })

    // 停止 recorder：触发最后一次 dataavailable（头 + 尾段）与 onstop；等 onstop resolve
    const recorder = mediaRecorder
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        stopResolve = resolve
        recorder.stop()
      })
    }

    // flush：等所有分片的转写 / 翻译跑完
    await chunkChain
    // 停止后再给暂存失败的片一次机会（宽裕超时）—— 音频还在内存，尽量都转出来
    await drainPending()

    // 停掉麦克风轨道，释放设备
    mediaStream?.getTracks().forEach((t) => t.stop())
    mediaRecorder = null
    mediaStream = null
    initSegmentBytes = null

    const { targetTaskId, sessionId, segments } = get()
    if (targetTaskId && sessionId && segments.length > 0) {
      try {
        await saveTranscript(targetTaskId, sessionId, segments)
        segments.forEach((s) => savedSegIds.add(s.id))
        toast.success('本轮转写已保存到私库')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast.error(`转写保存失败：${msg}`, { duration: 8000 })
      }
    }

    if (pendingChunks.length > 0) {
      // 还有没转成的片：**绝不清空** —— 音频留在内存，UI 给「重试」，提示别关页面
      set({
        status: 'idle',
        startedAt: null,
        pendingCount: pendingChunks.length,
        error: `还有 ${pendingChunks.length} 片未转写成功，点「重试未完成」再试（音频仍在内存，先别关页面）`,
      })
      toast.error(`还有 ${pendingChunks.length} 片未转写成功，点「重试未完成」再试`, {
        duration: 12000,
      })
      return
    }
    get().clear()
  },

  retryPending: async () => {
    const { status } = get()
    if (status === 'recording' || status === 'stopping') return
    await drainPending()

    // 只补写「还没落库」的片，避免和停止时已保存的重复
    const { targetTaskId, sessionId, segments } = get()
    const fresh = segments.filter((s) => !savedSegIds.has(s.id))
    if (fresh.length > 0 && targetTaskId && sessionId) {
      try {
        await saveTranscript(targetTaskId, sessionId, fresh)
        fresh.forEach((s) => savedSegIds.add(s.id))
        toast.success(`已补写 ${fresh.length} 片到私库`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast.error(`补写失败：${msg}`, { duration: 8000 })
      }
    }

    if (pendingChunks.length === 0) {
      get().clear()
      toast.success('未完成的片已全部转写并保存')
    } else {
      set({
        pendingCount: pendingChunks.length,
        error: `仍有 ${pendingChunks.length} 片未转写成功，请检查网络 / Key 后再试`,
      })
      toast.error(`仍有 ${pendingChunks.length} 片未成功，可稍后再试`, { duration: 10000 })
    }
  },

  setTarget: (taskId) => set({ targetTaskId: taskId }),

  clear: () => {
    pendingChunks = []
    savedSegIds.clear()
    set({ ...IDLE, segments: [] })
  },
}))
