/**
 * MinerU 调试控制台（M3.6.3-b）
 * -------------------------------------------------
 * 位置：设置页 > MinerU 测试面板底部（仅 debugMode=true 时挂载）
 * 定位：展示每次 fetch 的 method / url / status / 耗时 / 错误详情，
 *      让 Rosa 能"看到"pipeline 卡在哪一步。
 *
 * 事件来源：runMineruSingleFile(opts.onDebug) → client.ts 里 emitDebug
 * 交互：
 *   - 折叠/展开
 *   - 一键复制全部日志到剪贴板（方便贴给 Agent 定位）
 *   - 清空
 *
 * 分发前关闭方式：Settings 里把 mineruDebugMode 关掉即可（默认 true）。
 */
import { Copy, Eraser, ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { MineruDebugEvent } from '../../types'
import { STAGE_LABEL } from './mineru-stages'

interface Props {
  events: MineruDebugEvent[]
  onClear: () => void
  startedAt?: number | null
}

const KIND_STYLE: Record<
  MineruDebugEvent['kind'],
  { label: string; className: string }
> = {
  request: { label: '→ REQ', className: 'bg-blue-100 text-blue-800' },
  response: { label: '← RES', className: 'bg-green-100 text-green-800' },
  error: { label: '✗ ERR', className: 'bg-red-100 text-red-800' },
  info: { label: 'ℹ INFO', className: 'bg-slate-100 text-slate-700' },
}

/** 秒级时间戳（HH:mm:ss.SSS） */
function formatTs(at: number): string {
  const d = new Date(at)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** 相对开始时间（+X.Xs） */
function formatRel(at: number, startedAt: number): string {
  const ms = at - startedAt
  if (ms < 1000) return `+${ms}ms`
  return `+${(ms / 1000).toFixed(1)}s`
}

export function MineruDebugConsole(props: Props) {
  const { events, onClear, startedAt } = props
  const [expanded, setExpanded] = useState(true)

  const summary = useMemo(() => {
    const req = events.filter((e) => e.kind === 'request').length
    const res = events.filter((e) => e.kind === 'response').length
    const err = events.filter((e) => e.kind === 'error').length
    return { req, res, err }
  }, [events])

  const copyAll = async () => {
    const t0 = startedAt ?? events[0]?.at ?? Date.now()
    const lines = events.map((ev) => {
      const ts = formatTs(ev.at)
      const rel = formatRel(ev.at, t0)
      const style = KIND_STYLE[ev.kind].label
      const phase = STAGE_LABEL[ev.phase] ?? ev.phase
      const status = ev.status !== undefined ? ` [${ev.status}]` : ''
      const dur =
        ev.durationMs !== undefined ? ` (${ev.durationMs}ms)` : ''
      const meth = ev.method ? ` ${ev.method}` : ''
      const url = ev.url ? ` ${ev.url}` : ''
      const errName = ev.errorName ? ` ${ev.errorName}` : ''
      const detail = ev.detail ? `\n    ${ev.detail}` : ''
      return `${ts}  ${rel.padStart(8)}  ${style}  ${phase}${meth}${url}${status}${dur}${errName}${detail}`
    })
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      toast.success(`已复制 ${events.length} 条日志到剪贴板`)
    } catch {
      toast.error('复制失败，请手动选中')
    }
  }

  if (events.length === 0) {
    return (
      <div className="p-3 bg-slate-50 border border-dashed border-slate-300 rounded-md">
        <div className="text-xs text-slate-500 font-mono">
          🐛 Debug Console — 等待事件（跑一次 MinerU 全流程后这里会挂满 request/response 日志）
        </div>
      </div>
    )
  }

  const t0 = startedAt ?? events[0]?.at ?? Date.now()

  return (
    <div className="border border-slate-300 rounded-md bg-slate-950 text-slate-100 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-slate-800 border-b border-slate-700">
        <button
          type="button"
          onClick={() => setExpanded((s) => !s)}
          className="flex items-center gap-1.5 text-xs font-mono text-slate-200 hover:text-white"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
          🐛 Debug Console
          <span className="ml-2 text-slate-400">
            {events.length} 条 · req {summary.req} · res {summary.res}
            {summary.err > 0 && (
              <span className="text-red-400"> · err {summary.err}</span>
            )}
          </span>
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copyAll}
            className="flex items-center gap-1 px-2 py-1 text-xs font-mono text-slate-300
                       hover:text-white hover:bg-slate-700 rounded"
            title="复制全部到剪贴板"
          >
            <Copy className="w-3 h-3" />
            复制
          </button>
          <button
            type="button"
            onClick={onClear}
            className="flex items-center gap-1 px-2 py-1 text-xs font-mono text-slate-300
                       hover:text-white hover:bg-slate-700 rounded"
            title="清空"
          >
            <Eraser className="w-3 h-3" />
            清空
          </button>
        </div>
      </div>

      {/* Body */}
      {expanded && (
        <div className="max-h-96 overflow-y-auto p-2 font-mono text-[0.6875rem] leading-relaxed">
          {events.map((ev, i) => {
            const style = KIND_STYLE[ev.kind]
            return (
              <div
                key={i}
                className={`flex gap-2 py-0.5 ${
                  ev.kind === 'error' ? 'bg-red-950/40' : ''
                }`}
              >
                {/* 时间列 */}
                <span className="shrink-0 w-12 text-slate-500">
                  {formatRel(ev.at, t0)}
                </span>
                {/* 类型徽章 */}
                <span
                  className={`shrink-0 px-1.5 rounded text-[0.625rem] font-semibold ${style.className}`}
                >
                  {style.label}
                </span>
                {/* 阶段 */}
                <span className="shrink-0 text-indigo-300">
                  {STAGE_LABEL[ev.phase] ?? ev.phase}
                </span>
                {/* 详情 */}
                <span className="flex-1 min-w-0 text-slate-200 break-all">
                  {ev.method && (
                    <span className="text-yellow-300">{ev.method} </span>
                  )}
                  {ev.url && <span className="text-slate-400">{ev.url}</span>}
                  {ev.status !== undefined && (
                    <span
                      className={`ml-1 ${
                        ev.status >= 400
                          ? 'text-red-400'
                          : ev.status >= 300
                            ? 'text-yellow-400'
                            : 'text-green-400'
                      }`}
                    >
                      [{ev.status}]
                    </span>
                  )}
                  {ev.durationMs !== undefined && (
                    <span className="ml-1 text-cyan-300">
                      ({ev.durationMs}ms)
                    </span>
                  )}
                  {ev.errorName && (
                    <span className="ml-1 text-red-300">
                      {ev.errorName}
                    </span>
                  )}
                  {ev.detail && (
                    <div className="pl-4 mt-0.5 text-slate-300 whitespace-pre-wrap">
                      {ev.detail}
                    </div>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
