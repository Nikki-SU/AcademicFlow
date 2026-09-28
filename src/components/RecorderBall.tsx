/**
 * 全局悬浮录音球
 * -------------------------------------------------
 * 挂在 Layout 顶层，fixed bottom-right，跨页面 / 跨任务持续录音，不绑架用户。
 * 状态全在 stores/recorder.ts —— 本组件只做 UI 绑定，卸载不影响录音。
 */
import { useEffect, useState } from 'react'
import { Mic, Square, ChevronDown, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useRecorderStore } from '../stores/recorder'
import { useTaskStore } from '../stores/task'

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

/** 语种徽标文案 */
function langLabel(lang: string): string {
  const l = lang.trim().toLowerCase()
  if (l === 'zh' || l.startsWith('zh-')) return '中'
  if (l === 'en' || l.startsWith('en-')) return 'EN'
  return lang.trim().slice(0, 6).toUpperCase() || '—'
}

export default function RecorderBall() {
  const status = useRecorderStore((s) => s.status)
  const startedAt = useRecorderStore((s) => s.startedAt)
  const segments = useRecorderStore((s) => s.segments)
  const error = useRecorderStore((s) => s.error)
  const start = useRecorderStore((s) => s.start)
  const stop = useRecorderStore((s) => s.stop)

  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(Date.now())

  const isRecording = status === 'recording'
  const isBusy = status === 'stopping'

  // 录音中每秒走表
  useEffect(() => {
    if (!isRecording) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [isRecording])

  // 停止后收起浮层
  useEffect(() => {
    if (status === 'idle') setExpanded(false)
  }, [status])

  const handleStart = async () => {
    const target = useTaskStore.getState().currentProjectId
    if (!target) {
      toast.error('先选一个任务')
      return
    }
    await start(target)
  }

  const handleStop = async () => {
    setExpanded(false)
    await stop()
  }

  const elapsed = startedAt ? now - startedAt : 0
  const latest = segments.length > 0 ? segments[segments.length - 1].text : ''

  // ── 未录音：一个小圆球 ──
  if (!isRecording && !isBusy) {
    return (
      <div className="fixed bottom-6 right-6 z-40">
        <button
          type="button"
          onClick={handleStart}
          title="开始录音（会议/课程）"
          className="flex h-14 w-14 items-center justify-center rounded-full bg-seal-600 text-paper-50 shadow-lift transition hover:bg-seal-700 active:scale-95"
        >
          <Mic className="h-6 w-6" />
        </button>
      </div>
    )
  }

  // ── 录音中 / 保存中 ──
  return (
    <div className="fixed bottom-6 right-6 z-40 flex max-w-[calc(100vw-3rem)] flex-col items-end gap-2">
      {expanded && (
        <div className="w-80 max-w-full overflow-hidden rounded-xl border border-ink-200 bg-paper-50 shadow-lift">
          <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2">
            <span className="text-xs font-semibold text-ink-700">本轮转写</span>
            <span className="text-[11px] text-ink-400">{segments.length} 条</span>
          </div>
          <div className="max-h-72 overflow-y-auto px-3 py-2">
            {segments.length === 0 ? (
              <p className="py-6 text-center text-xs text-ink-400">等待第一片转写…</p>
            ) : (
              <ul className="space-y-3">
                {segments.map((seg) => (
                  <li key={seg.id} className="border-b border-ink-100 pb-2 last:border-0">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="font-mono text-ink-400">{formatClock(seg.at)}</span>
                      <span className="rounded bg-seal-50 px-1.5 py-0.5 text-[10px] font-medium text-seal-700">
                        {langLabel(seg.language)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-snug text-ink-800">{seg.text}</p>
                    {seg.translation && (
                      <p className="mt-0.5 text-sm leading-snug text-ink-500">{seg.translation}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="border-t border-ink-100 p-2">
            <button
              type="button"
              onClick={handleStop}
              disabled={isBusy}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-seal-600 px-3 py-2 text-sm font-medium text-paper-50 transition hover:bg-seal-700 disabled:opacity-60"
            >
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
              {isBusy ? '保存中…' : '停止并保存'}
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? '收起' : '展开本轮转写'}
        className="flex items-center gap-2 rounded-full bg-seal-600 py-2 pl-3 pr-4 text-paper-50 shadow-lift transition hover:bg-seal-700"
      >
        <span className="relative flex h-3 w-3 items-center justify-center">
          <span className="absolute h-3 w-3 animate-ping rounded-full bg-red-400 opacity-75" />
          <span className="h-3 w-3 rounded-full bg-red-500" />
        </span>
        <span className="font-mono text-sm tabular-nums">{formatElapsed(elapsed)}</span>
        {latest && (
          <span className="hidden max-w-[10rem] truncate text-xs text-paper-100 sm:block">
            {latest}
          </span>
        )}
        <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {error && (
        <span className="max-w-xs truncate rounded bg-red-50 px-2 py-0.5 text-[11px] text-red-600">
          {error}
        </span>
      )}
    </div>
  )
}
