/**
 * 全局录音状态（会议/课程页 + 悬浮录音球共用）
 * -------------------------------------------------
 * 状态放 zustand、MediaRecorder 句柄放模块级变量 —— 于是**切页面 / 路由不中断录音**：
 * 组件卸载只解绑 UI，录音与转写链路在 store 里继续跑。
 *
 * 每 30 秒切一段：**每段都单独起停一次 MediaRecorder**（不是 start(30000) 的
 * 分片）—— 这样每一段都是**完整可解码的独立音频文件**。用 start(30000) 切出来的
 * 第 2 段起只有数据簇、没有容器头，后端（硅基流动）解不出来，正是「录了一分钟
 * 一个字都没有」的根因。每段立即直连硅基流动转写；language 非中文且开了翻译 → 再翻译。
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
let rotateTimer: ReturnType<typeof setInterval> | null = null
let stopResolve: (() => void) | null = null
/** 串行处理每一段，保证 segments 顺序与录音顺序一致 */
let chunkChain: Promise<void> = Promise.resolve()
/** 每段时长（ms）：一段一段独立起停，保证每段都是完整容器 */
const SEGMENT_MS = 30000

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

/** 起一段独立录音：onstop 时把这一整段（完整容器）交给转写链路 */
function startRecorderCycle(stream: MediaStream): void {
  const mimeType = pickAudioMimeType()
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
  mediaRecorder = recorder
  const chunks: BlobPart[] = [] // 闭包持有，避免与下一段的缓冲区串台
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data)
  }
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
    if (blob.size > 0) enqueueChunk(blob)
    stopResolve?.()
    stopResolve = null
  }
  recorder.onerror = (ev) => {
    const err = (ev as unknown as { error?: DOMException }).error
    const msg = err?.message || '录音器发生错误'
    useRecorderStore.setState({ error: msg })
    toast.error(`录音出错：${msg}`)
  }
  recorder.start()
}

/** 到点换段：停掉当前段（触发转写），立刻用同一个 stream 起下一段 */
function rotateRecorder(): void {
  // 已经不在录音状态就别再起新段（避免和 stop() 抢）
  if (useRecorderStore.getState().status !== 'recording') return
  const stream = mediaStream
  if (!stream) return
  const old = mediaRecorder
  if (old && old.state !== 'inactive') old.stop()
  startRecorderCycle(stream)
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

function enqueueChunk(blob: Blob): void {
  chunkChain = chunkChain.then(() => handleChunk(blob)).catch(() => {})
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

      // 起第一段，并每 30 秒换一段（每段都是完整独立文件，后端可解码）
      startRecorderCycle(stream)
      rotateTimer = setInterval(rotateRecorder, SEGMENT_MS)

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

    // 先停掉换段定时器，收尾不再切新段
    if (rotateTimer) {
      clearInterval(rotateTimer)
      rotateTimer = null
    }

    // 停掉当前段：触发 onstop → 这一段入库；等它 resolve
    const recorder = mediaRecorder
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        stopResolve = resolve
        recorder.stop()
      })
    }

    // flush：等所有段的转写 / 翻译跑完
    await chunkChain

    // 停掉麦克风轨道，释放设备
    mediaStream?.getTracks().forEach((t) => t.stop())
    mediaRecorder = null
    mediaStream = null

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
