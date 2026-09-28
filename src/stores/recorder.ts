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
 *
 * 转写（三条硬约束）：
 *   ① **不丢**：某片转写失败/超时，音频会暂存到 IndexedDB（services/pendingAudio），
 *      绝不丢弃，转成功即从本地删掉。页面刷新也能续 —— 音频不入私库（ADJ-48），
 *      所以本地暂存是唯一的安全网。
 *   ② **严格顺序**：每片在到达时分配单调递增的 seq；实时列表按 seq 排序；落库时
 *      按「时刻」归并进 transcript.md（见 sessionData.mergeTranscript），补回来的
 *      早片会插到正确位置，绝不追加到末尾。
 *   ③ **并发**：最多 MAX_CONCURRENCY 片同时在转（直连 ASR，请求彼此独立），
 *      既不互相堵、又不会把接口打爆；顺序由 seq 兜住，不靠串行。
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import { transcribeAudio, translateText, pickAudioMimeType, audioFileNameFor } from '../services/asr'
import { saveTranscript } from '../services/sessionData'
import {
  putPending,
  deletePending,
  listPending,
  countPending,
  type PendingAudioRecord,
} from '../services/pendingAudio'
import { useSettingsStore } from './settings'
import { useSessionStore } from './session'

export type RecorderStatus = 'idle' | 'recording' | 'paused' | 'stopping'

export interface RecorderSegment {
  id: string
  /** 片序（单调递增）：严格顺序的唯一依据 */
  seq: number
  /** 片段产生时刻（Unix ms），用于展示时间与落库归并 */
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
  /** 暂存在 IndexedDB 里、还没转成的片数（>0 = 点「重试未完成」） */
  pendingCount: number
  start: (targetTaskId: string) => Promise<void>
  stop: () => Promise<void>
  /** 重试所有暂存失败的片，并把新补回的写入私库 */
  retryPending: () => Promise<void>
  /** App 启动时调用：把历史遗留的待转写片续转掉（刷新不丢） */
  resume: () => Promise<void>
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
/** 容器头（第一片里的 EBML/Tracks 或 ftyp+moov），拼到后续每片前面 */
let initSegmentBytes: Uint8Array | null = null

/** 每片时长（ms）：只切 dataavailable 事件，录音本身不中断 */
const SEGMENT_MS = 10000
/** 单片转写的「正常」超时（ms）：一次尝试卡住就中止它，交给本地暂存 + 重试 */
const CHUNK_TIMEOUT_MS = 25000
/** 补转写（重试暂存片）的超时（ms）：宽裕些，宁可慢也要把它转出来 */
const DRAIN_TIMEOUT_MS = 90000
/** 同时进行的转写请求上限（直连 ASR，请求独立；顺序由 seq 保证，不靠串行） */
const MAX_CONCURRENCY = 3

/** 「抽头 + 拼接」串行链：保证第一片先抽到容器头，后续片才有头可拼 */
let prepChain: Promise<void> = Promise.resolve()
/** 全局单调片序：同一课时可能录多段，seq 不重置，避免暂存 id 撞车 */
let seqCounter = 0
/** 正在进行的转写 promise（停止时要等它们全部收尾，否则会漏写） */
const inFlight = new Set<Promise<void>>()
/** 并发信号量 */
let activeCount = 0
const waiters: Array<() => void> = []
/** 正在进行的补转写：并发调用共享同一次（避免重复补同一批、也让 stop 能等到它） */
let drainPromise: Promise<void> | null = null

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

// ── 并发信号量 ──
function acquire(): Promise<void> {
  if (activeCount < MAX_CONCURRENCY) {
    activeCount++
    return Promise.resolve()
  }
  return new Promise((resolve) => waiters.push(resolve))
}
function release(): void {
  activeCount--
  const next = waiters.shift()
  if (next) {
    activeCount++
    next()
  }
}
/** 等所有在途转写收尾（含它们触发的补转写） */
async function waitAllInFlight(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.all([...inFlight])
  }
}

const pendingId = (sessionId: string, seq: number) => `${sessionId}:${seq}`

/**
 * 单次转写一片；成功返回 segment（静音/无人说话返回 null），失败/超时一律 throw。
 * 只负责转，不碰 store / 暂存 —— 那些交给调用方，便于并发编排。
 */
async function transcribeOnce(
  blob: Blob,
  seq: number,
  at: number,
  timeoutMs: number,
): Promise<RecorderSegment | null> {
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
    console.log(`[asr] seq=${seq} 本片转写耗时 ${Date.now() - startedAt}ms`)
    if (!text.trim()) {
      // 端点通了但没出字（静音 / 没人说话）；记一笔，别让「静默」看起来像坏了
      console.warn(`[asr] seq=${seq} 转写返回空文本（可能是静音或没人说话）`)
      return null
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

    return {
      id: `${Date.now()}_${seq}`,
      seq,
      at,
      text,
      language,
      translation,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 按 seq 插入实时列表 —— 并发下各片回来顺序不定，靠 seq 兜住严格顺序 */
function addLiveSegment(seg: RecorderSegment): void {
  useRecorderStore.setState((s) => ({
    segments: [...s.segments, seg].sort((a, b) => a.seq - b.seq),
  }))
}

/** 把一片失败的音频暂存到 IndexedDB（不丢），并同步待转写计数 */
async function persistFailed(seq: number, at: number, blob: Blob): Promise<void> {
  const { targetTaskId, sessionId } = useRecorderStore.getState()
  if (!targetTaskId || !sessionId) {
    console.warn('[recorder] 无归属课时，无法暂存音频片', seq)
    return
  }
  await putPending({
    id: pendingId(sessionId, seq),
    taskId: targetTaskId,
    sessionId,
    seq,
    at,
    mime: blob.type || 'audio/webm',
    blob,
  })
}

async function syncPending(): Promise<void> {
  const n = await countPending()
  useRecorderStore.setState({ pendingCount: n })
}

/**
 * 补转所有暂存的片。**不阻塞新片**：按课时分组，组内并发（受信号量约束）。
 * 顺序担保：转出的文本按「时刻」归并进 transcript.md，早片会插到正确位置。
 * 只有**落库成功**才删本地暂存 —— 不能「转成了却没写进去」。
 * 并发调用共享同一次运行，`stop` 因而能确定性地等到补转结束。
 */
function drainPending(): Promise<void> {
  if (drainPromise) return drainPromise
  drainPromise = (async () => {
    try {
      const all = await listPending()
      if (all.length === 0) return
      const groups = new Map<string, PendingAudioRecord[]>()
      for (const rec of all) {
        const arr = groups.get(rec.sessionId)
        if (arr) arr.push(rec)
        else groups.set(rec.sessionId, [rec])
      }
      await Promise.all([...groups.values()].map((recs) => drainSession(recs)))
    } finally {
      await syncPending()
      drainPromise = null
    }
  })()
  return drainPromise
}

async function drainSession(recs: PendingAudioRecord[]): Promise<void> {
  const done: { rec: PendingAudioRecord; seg: RecorderSegment | null }[] = []
  await Promise.all(
    recs.map(async (rec) => {
      await acquire()
      try {
        const seg = await transcribeOnce(rec.blob, rec.seq, rec.at, DRAIN_TIMEOUT_MS)
        done.push({ rec, seg })
      } catch (e) {
        // 还是不行（网络 / Key）：留在 IndexedDB，等下次机会，绝不丢弃
        console.warn(
          '[recorder] 补转写仍失败，保留待下次：',
          e instanceof Error ? e.message : String(e),
        )
      } finally {
        release()
      }
    }),
  )
  if (done.length === 0) return

  const texts = done.filter((d) => d.seg).map((d) => d.seg as RecorderSegment)
  if (texts.length > 0) {
    const { taskId, sessionId } = done[0].rec
    try {
      await saveTranscript(taskId, sessionId, texts)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast.error(`补写转写失败：${msg}（音频仍在本地，稍后可重试）`, { duration: 8000 })
      return // 不删暂存：留待下次，避免「转成了却没落库」
    }
  }
  // 转到文本且落库成功（或空文本=静音）→ 从本地删掉，别把 IndexedDB 撑爆
  await Promise.all(done.map((d) => deletePending(d.rec.id)))

  // 若属于当前正在展示的课时，同步进实时列表
  const cur = useRecorderStore.getState()
  for (const d of done) {
    if (d.seg && cur.sessionId === d.rec.sessionId) addLiveSegment(d.seg)
  }
}

/** 处理一片直播数据（首次尝试）；失败即暂存 + 触发补转写。整段包成一个 in-flight promise */
function startLiveAttempt(seq: number, at: number, blob: Blob): void {
  const p = (async () => {
    let failed = false
    await acquire()
    try {
      const seg = await transcribeOnce(blob, seq, at, CHUNK_TIMEOUT_MS)
      if (seg) addLiveSegment(seg)
      // 若这片之前失败暂存过，成功即删
      const sid = useRecorderStore.getState().sessionId
      if (sid) await deletePending(pendingId(sid, seq))
    } catch (e) {
      failed = true
      const aborted = e instanceof DOMException && e.name === 'AbortError'
      const msg = aborted
        ? `本片转写超时（>${CHUNK_TIMEOUT_MS / 1000}s）`
        : e instanceof Error
          ? e.message
          : String(e)
      await persistFailed(seq, at, blob)
      useRecorderStore.setState({ error: `${msg}（已暂存本地，可重试）` })
      toast.error(`本片转写失败，已暂存本地待重试：${msg}`, { duration: 8000 })
    } finally {
      release()
    }
    // 释放信号量后再补转（否则补转抢不到槽位会死锁）
    if (failed || (await countPending()) > 0) await drainPending()
  })()
  inFlight.add(p)
  void p.finally(() => inFlight.delete(p))
}

/**
 * 把一片挂到「抽头 + 拼接」串行链上：seq / at 在**到达时**就定下（= 严格顺序），
 * 抽头与拼接串行（保证第一片的头先被抽到），转写本身并发跑（startLiveAttempt）。
 */
function enqueueData(data: Blob, mimeType: string | undefined): void {
  const seq = seqCounter++
  const at = Date.now()
  prepChain = prepChain
    .then(async () => {
      if (!data || data.size === 0) {
        console.warn('[recorder] 收到空分片，跳过')
        return
      }
      const mime = data.type || mimeType || 'audio/webm'
      const buf = new Uint8Array(await data.arrayBuffer())
      let blob: Blob
      if (!initSegmentBytes) {
        initSegmentBytes = extractInitSegment(buf, mime)
        if (!initSegmentBytes) {
          console.warn('[recorder] 未识别的音频容器，未能抽出容器头，后续分片可能无法转写：', mime)
        }
        console.log(`[recorder] 首片 seq=${seq}：${buf.length} 字节，容器头 ${initSegmentBytes?.length ?? 0} 字节`)
        blob = new Blob([buf as BlobPart], { type: mime })
      } else {
        console.log(`[recorder] 分片 seq=${seq}：${buf.length} 字节（已拼接容器头）`)
        blob = new Blob([initSegmentBytes as BlobPart, buf as BlobPart], { type: mime })
      }
      startLiveAttempt(seq, at, blob)
    })
    .catch(() => {})
}

export const useRecorderStore = create<RecorderState>((set, get) => ({
  ...IDLE,

  start: async (targetTaskId) => {
    const { status } = get()
    if (status === 'recording' || status === 'stopping') return

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

    await prepChain // 等所有分片完成「抽头 + 派发」
    await waitAllInFlight() // 等所有在途转写收尾（否则它们的文本会漏写）
    await drainPending() // 给失败的片（本轮 + 历史）最后一次补转机会

    // 停掉麦克风轨道，释放设备
    mediaStream?.getTracks().forEach((t) => t.stop())
    mediaRecorder = null
    mediaStream = null
    initSegmentBytes = null

    const { targetTaskId, sessionId, segments } = get()
    if (targetTaskId && sessionId && segments.length > 0) {
      try {
        await saveTranscript(targetTaskId, sessionId, segments)
        toast.success('本轮转写已保存到私库')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast.error(`转写保存失败：${msg}`, { duration: 8000 })
      }
    }

    const remaining = await countPending()
    if (remaining > 0) {
      // 还有没转成的片：本地暂存着，关页面也不丢，给个明确的重试入口
      set({
        status: 'idle',
        startedAt: null,
        pendingCount: remaining,
        error: `还有 ${remaining} 片未转写成功，点「重试未完成」再试（已存本地，关页面也不丢）`,
      })
      toast.error(`还有 ${remaining} 片未转写成功，点「重试未完成」再试`, { duration: 12000 })
    } else {
      get().clear()
    }
  },

  retryPending: async () => {
    const { status } = get()
    if (status === 'recording' || status === 'stopping') return
    await drainPending()
    const remaining = await countPending()
    set({ pendingCount: remaining })
    if (remaining === 0) {
      get().clear()
      toast.success('未完成的片已全部转写并补写进私库')
    } else {
      set({ error: `仍有 ${remaining} 片未转写成功，请检查网络 / Key 后再试` })
      toast.error(`仍有 ${remaining} 片未成功，可稍后再试`, { duration: 10000 })
    }
  },

  resume: async () => {
    await syncPending()
    if ((await countPending()) > 0) void drainPending()
  },

  setTarget: (taskId) => set({ targetTaskId: taskId }),

  clear: () => {
    // 只清 UI 状态；**不动 IndexedDB**（待转写音频是安全网，除非已成功否则不能删）
    set({ ...IDLE, segments: [] })
    void syncPending()
  },
}))
