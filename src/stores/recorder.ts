/**
 * 全局录音状态（会议/课程页 + 悬浮录音球共用）
 * -------------------------------------------------
 * 状态放 zustand、MediaRecorder 句柄放模块级变量 —— 于是**切页面 / 路由不中断录音**：
 * 组件卸载只解绑 UI，录音与转写链路在 store 里继续跑。
 *
 * 录音：**一条 MediaRecorder 从头录到尾，绝不中断**（一节 90 分钟也不丢一秒），
 * 用 start(30000) 每 30 秒切一个 dataavailable 事件而已。
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
  start: (targetTaskId: string) => Promise<void>
  stop: () => Promise<void>
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
}

// ── 模块级句柄（组件卸载不停录音，故不放组件里） ──
let mediaRecorder: MediaRecorder | null = null
let mediaStream: MediaStream | null = null
let stopResolve: (() => void) | null = null
/** 串行处理每一片，保证 segments 顺序与录音顺序一致 */
let chunkChain: Promise<void> = Promise.resolve()
/** 每片时长（ms）：只切 dataavailable 事件，录音本身不中断 */
const SEGMENT_MS = 30000
/** 容器头（第一片里的 EBML/Tracks 或 ftyp+moov），拼到后续每片前面 */
let initSegmentBytes: Uint8Array | null = null

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
async function processChunk(data: Blob, mimeType: string | undefined): Promise<void> {
  if (!data || data.size === 0) return
  const mime = data.type || mimeType || 'audio/webm'
  const buf = new Uint8Array(await data.arrayBuffer())
  if (!initSegmentBytes) {
    initSegmentBytes = extractInitSegment(buf, mime)
    if (!initSegmentBytes) {
      console.warn('[recorder] 未识别的音频容器，未能抽出容器头，后续分片可能无法转写：', mime)
    }
    await handleChunk(new Blob([buf as BlobPart], { type: mime }))
  } else {
    await handleChunk(new Blob([initSegmentBytes as BlobPart, buf as BlobPart], { type: mime }))
  }
}

async function handleChunk(blob: Blob): Promise<void> {
  const cfg = readAsrConfig()
  if (!cfg.apiKey) {
    // 录音中途把 Key 删了：不静默，明确报出来
    toast.error('会议转写 Key 为空，本段未转写（设置 → 会议转写）', { duration: 8000 })
    return
  }
  try {
    const { text, language } = await transcribeAudio(
      blob,
      { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model },
      undefined,
      audioFileNameFor(blob), // 按真实容器给扩展名（Safari 录的是 mp4，不能叫 webm）
    )
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
      at: Date.now(),
      text,
      language,
      translation,
    }
    useRecorderStore.setState((s) => ({ segments: [...s.segments, seg] }))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    useRecorderStore.setState({ error: msg })
    toast.error(`转写失败：${msg}`, { duration: 8000 })
  }
}

/** 把一片数据挂到串行链上（含抽头/拼接），保证 segments 顺序 = 录音顺序 */
function enqueueData(data: Blob, mimeType: string | undefined): void {
  chunkChain = chunkChain.then(() => processChunk(data, mimeType)).catch(() => {})
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

      // 一条 recorder 连录到底，只每 30 秒切一个 dataavailable —— 录音零中断
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

      set({
        status: 'recording',
        startedAt: Date.now(),
        targetTaskId,
        sessionId: String(Date.now()),
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

    // flush：等所有分片的转写 / 翻译跑完
    await chunkChain

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
    get().clear()
  },

  setTarget: (taskId) => set({ targetTaskId: taskId }),

  clear: () => set({ ...IDLE, segments: [] }),
}))
