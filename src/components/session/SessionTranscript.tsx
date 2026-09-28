/**
 * 会议/课程页 · 中栏：录音 / 转写
 * -------------------------------------------------
 * 绑定 stores/recorder.ts：开始 / 停止按钮 + 实时 segments 列表。
 * 未录音时展示「最近一次会话」的 transcript.md（能读就读，读不到给空状态，不报错弹窗）。
 */
import { useEffect, useState } from 'react'
import { Mic, Square, Loader2, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { useRecorderStore } from '../../stores/recorder'
import { loadLatestTranscript } from '../../services/sessionData'

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

export default function SessionTranscript({ taskId }: { taskId: string | null }) {
  const status = useRecorderStore((s) => s.status)
  const segments = useRecorderStore((s) => s.segments)
  const startedAt = useRecorderStore((s) => s.startedAt)
  const error = useRecorderStore((s) => s.error)
  const start = useRecorderStore((s) => s.start)
  const stop = useRecorderStore((s) => s.stop)

  const [lastContent, setLastContent] = useState<string | null>(null)
  const [lastLoading, setLastLoading] = useState(false)
  const [now, setNow] = useState(Date.now())

  const isRecording = status === 'recording'
  const isBusy = status === 'stopping'
  const isIdle = status === 'idle'

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
      return
    }
    let cancelled = false
    setLastLoading(true)
    loadLatestTranscript(taskId)
      .then((r) => {
        if (!cancelled) setLastContent(r?.content ?? null)
      })
      .finally(() => {
        if (!cancelled) setLastLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isIdle, taskId])

  const handleStart = async () => {
    if (!taskId) {
      toast.error('先选一个任务')
      return
    }
    await start(taskId)
  }

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

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {isRecording ? (
          segments.length === 0 ? (
            <p className="py-10 text-center text-sm text-ink-400">正在录音…每 30 秒回一片转写</p>
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
                    <p className="mt-1 border-l-2 border-seal-200 pl-2 text-sm leading-relaxed text-ink-500">
                      {seg.translation}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : lastLoading ? (
          <p className="py-10 text-center text-sm text-ink-400">加载最近一次会话…</p>
        ) : lastContent ? (
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs text-ink-500">
              <FileText className="h-3.5 w-3.5" />
              最近一次会话（只读）
            </div>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink-700">
              {lastContent}
            </pre>
          </div>
        ) : (
          <div className="py-10 text-center">
            <Mic className="mx-auto h-6 w-6 text-ink-300" />
            <p className="mt-2 text-sm text-ink-400">还没有转写记录</p>
            <p className="mt-1 text-xs text-ink-400">
              点「开始录音」，或从右下角悬浮球开录（需先在设置里配好 Key）
            </p>
          </div>
        )}

        {error && (
          <p className="mt-3 rounded bg-red-50 px-2 py-1 text-xs text-red-600">{error}</p>
        )}
      </div>
    </section>
  )
}
