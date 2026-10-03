/**
 * 会议/课程页 · 中栏：录音 / 转写
 * -------------------------------------------------
 * 绑定 stores/recorder.ts：开始 / 停止按钮 + 实时 segments 列表。
 * 未录音时展示「最近一次会话」：
 *   · 已有 AI 修饰稿 → 块编辑器（分段、英汉逐段对照、可拖拽 / 删除 / 合并 / 改字）
 *   · 只有原始转写  → 只读原文 + 一个「AI 修饰」入口
 * 读不到一律给空状态，不报错弹窗。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Square, Loader2, FileText, Sparkles, Eye, EyeOff } from 'lucide-react'
import { toast } from 'sonner'
import { useRecorderStore } from '../../stores/recorder'
import { useSettingsStore } from '../../stores/settings'
import {
  loadLatestTranscript,
  extractTranscriptText,
  savePolishedTranscript,
} from '../../services/sessionData'
import { polishTranscript, type TranscriptBlock } from '../../services/asr'
import TranscriptEditor from './TranscriptEditor'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 已录时长 → HH:MM:SS */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

/** 片段时刻 → 本地 HH:MM:SS */
function formatClock(at: number): string {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function langLabel(lang: string): string {
  const l = lang.trim().toLowerCase()
  if (l === 'zh' || l.startsWith('zh-')) return '中文'
  if (l === 'en' || l.startsWith('en-')) return 'EN'
  return lang.trim() || '—'
}

/** 修饰稿自动落库防抖（ms）—— 用户改一段就静默存一次，不打断输入 */
const SAVE_DEBOUNCE_MS = 900

export default function SessionTranscript({ taskId }: { taskId: string | null }) {
  const status = useRecorderStore((s) => s.status)
  const segments = useRecorderStore((s) => s.segments)
  const startedAt = useRecorderStore((s) => s.startedAt)
  const error = useRecorderStore((s) => s.error)
  const start = useRecorderStore((s) => s.start)
  const stop = useRecorderStore((s) => s.stop)

  const [lastContent, setLastContent] = useState<string | null>(null)
  const [lastText, setLastText] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [blocks, setBlocks] = useState<TranscriptBlock[] | null>(null)
  const [lastLoading, setLastLoading] = useState(false)
  const [polishing, setPolishing] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [now, setNow] = useState(Date.now())

  const isRecording = status === 'recording'
  const isBusy = status === 'stopping'
  const isIdle = status === 'idle'

  // 阻止「刚加载完的 blocks」被当成用户编辑立刻回写
  const loadedRef = useRef(false)
  const saveTimer = useRef<number | null>(null)

  useEffect(() => {
    if (!isRecording) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [isRecording])

  // 仅在「空闲」时读最近一次会话；录音中 / 保存中不读（避免读到半旧数据）
  useEffect(() => {
    if (!isIdle || !taskId) {
      setLastContent(null)
      setBlocks(null)
      setSessionId(null)
      setLastText('')
      return
    }
    let cancelled = false
    setLastLoading(true)
    loadedRef.current = false
    loadLatestTranscript(taskId)
      .then((r) => {
        if (cancelled) return
        setLastContent(r?.content ?? null)
        setLastText(r ? extractTranscriptText(r.content) : '')
        setSessionId(r?.sessionId ?? null)
        setBlocks(r?.blocks ?? null)
        setShowRaw(false)
      })
      .finally(() => {
        if (cancelled) return
        setLastLoading(false)
        // 微延迟再放行，避开同一次渲染里 blocks 变更触发的保存
        window.setTimeout(() => {
          loadedRef.current = true
        }, 0)
      })
    return () => {
      cancelled = true
    }
  }, [isIdle, taskId])

  // 编辑修饰稿 → 防抖落库
  useEffect(() => {
    if (!loadedRef.current || !sessionId || !taskId || !blocks) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    const cur = blocks
    saveTimer.current = window.setTimeout(() => {
      savePolishedTranscript(taskId, sessionId, cur).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        toast.error(`转写稿保存失败：${msg}`, { duration: 8000 })
      })
    }, SAVE_DEBOUNCE_MS)
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks])

  const handleStart = async () => {
    if (!taskId) {
      toast.error('先选一个任务')
      return
    }
    await start(taskId)
  }

  const handlePolish = useCallback(async () => {
    if (!taskId || !sessionId) return
    const rawText = lastText.trim()
    if (!rawText) {
      toast.error('还没有可修饰的转写内容')
      return
    }
    const s = useSettingsStore.getState()
    const model = (s.asrPolishModel || '').trim()
    if (!model) {
      toast.error('先在 设置 → 会议转写 里填「转写稿修饰模型」')
      return
    }
    setPolishing(true)
    try {
      const next = await polishTranscript(
        rawText,
        { baseUrl: s.asrBaseUrl, apiKey: s.asrApiKey, model },
        { translateToZh: !!s.asrTranslateToZh },
      )
      await savePolishedTranscript(taskId, sessionId, next)
      setBlocks(next)
      setShowRaw(false)
      toast.success('转写稿已修饰并保存')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(msg, { duration: 10000 })
    } finally {
      setPolishing(false)
    }
  }, [taskId, sessionId, lastText])

  const elapsed = startedAt ? now - startedAt : 0

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-ink-200 bg-paper-50">
      <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-3 py-2">
        <div className="flex items-center gap-2">
          <Mic className="h-4 w-4 text-seal-600" />
          <h2 className="text-sm font-semibold text-ink-800">录音 / 转写</h2>
          {isRecording && (
            <span className="font-mono text-xs tabular-nums text-red-600">{formatElapsed(elapsed)}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* 有原始转写且非录音态 → 提供「AI 修饰 / 重新修饰」 */}
          {isIdle && sessionId && lastText && (
            <button
              type="button"
              onClick={handlePolish}
              disabled={polishing}
              title={blocks ? '重新修饰（覆盖当前修饰稿）' : '把口语化转写整理成分段书面稿'}
              className="flex items-center gap-1.5 rounded-lg border border-seal-300 px-2.5 py-1.5 text-xs font-medium text-seal-700 transition hover:bg-seal-50 disabled:opacity-60"
            >
              {polishing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              {polishing ? '修饰中…' : blocks ? '重新修饰' : 'AI 修饰'}
            </button>
          )}
          {/* 有修饰稿 → 可切看原始转写 */}
          {isIdle && blocks && (
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              title={showRaw ? '回到修饰稿' : '查看原始转写'}
              className="rounded-lg p-1.5 text-ink-500 transition hover:bg-ink-100 hover:text-ink-700"
            >
              {showRaw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          )}
          {isRecording || isBusy ? (
            <button
              type="button"
              onClick={stop}
              disabled={isBusy}
              className="flex items-center gap-1.5 rounded-lg bg-seal-600 px-3 py-1.5 text-xs font-medium text-paper-50 transition hover:bg-seal-700 disabled:opacity-60"
            >
              {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
              {isBusy ? '保存中…' : '停止并保存'}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStart}
              className="flex items-center gap-1.5 rounded-lg bg-seal-600 px-3 py-1.5 text-xs font-medium text-paper-50 transition hover:bg-seal-700"
            >
              <Mic className="h-3.5 w-3.5" />
              开始录音
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {isRecording ? (
          segments.length === 0 ? (
            <p className="py-10 text-center text-sm text-ink-400">正在录音…每 10 秒回一片转写</p>
          ) : (
            <ul className="space-y-3">
              {segments.map((seg) => (
                <li key={seg.id} className="border-b border-ink-100 pb-3 last:border-0">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-mono text-ink-400">{formatClock(seg.at)}</span>
                    <span className="rounded bg-seal-50 px-1.5 py-0.5 text-[10px] font-medium text-seal-700">
                      {langLabel(seg.language)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-ink-800">{seg.text}</p>
                  {seg.translation && (
                    <p className="mt-1.5 border-l-2 border-seal-300 bg-seal-50/30 py-1 pl-3 pr-2 text-sm leading-relaxed text-ink-700">
                      {seg.translation}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : lastLoading ? (
          <p className="py-10 text-center text-sm text-ink-400">加载最近一次会话…</p>
        ) : !lastContent ? (
          <div className="py-10 text-center">
            <Mic className="mx-auto h-6 w-6 text-ink-300" />
            <p className="mt-2 text-sm text-ink-400">还没有转写记录</p>
            <p className="mt-1 text-xs text-ink-400">
              点「开始录音」，或从右下角悬浮球开录（需先在设置里配好 Key）
            </p>
          </div>
        ) : showRaw ? (
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs text-ink-500">
              <FileText className="h-3.5 w-3.5" />
              原始转写（只读）
            </div>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink-700">
              {lastContent}
            </pre>
          </div>
        ) : blocks ? (
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs text-ink-500">
              <Sparkles className="h-3.5 w-3.5" />
              转写稿（可拖拽 / 删除 / 合并 / 改字，自动保存）
            </div>
            <TranscriptEditor blocks={blocks} onChange={setBlocks} />
          </div>
        ) : (
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs text-ink-500">
              <FileText className="h-3.5 w-3.5" />
              最近一次会话（原始转写）
            </div>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink-700">
              {lastContent}
            </pre>
            <div className="mt-4 rounded-lg border border-seal-200 bg-seal-50/50 p-3 text-xs text-ink-600">
              这份是语音原话，还比较口语。点右上角
              <span className="mx-1 font-medium text-seal-700">「AI 修饰」</span>
              重新分段、去掉口头禅，整理成可用的书面转写稿。
            </div>
          </div>
        )}

        {error && (
          <p className="mt-3 rounded bg-red-50 px-2 py-1 text-xs text-red-600">{error}</p>
        )}
      </div>
    </section>
  )
}