/**
 * MinerU 流程时间线（M3.7 子组件）
 * -------------------------------------------------
 * 展示 5 阶段的通过 / 进行中 / 未开始状态
 */
import { CheckCircle2, Loader2 } from 'lucide-react'
import type { MineruProgressEvent, MineruStage } from '../../types'
import { STAGE_LABEL, STAGE_ORDER } from './mineru-stages'

export function MineruProgressTimeline(props: {
  current: MineruStage
  logs: MineruProgressEvent[]
}) {
  const idx = STAGE_ORDER.indexOf(props.current)
  const isDone = props.current === 'done'
  const isFailed = props.current === 'failed'
  const lastMsg = props.logs[props.logs.length - 1]?.message

  return (
    <div className="p-3 bg-slate-50 border border-slate-200 rounded-md space-y-2">
      <div className="text-xs font-semibold text-slate-700">流程进度</div>
      <ol className="space-y-1">
        {STAGE_ORDER.filter((s) => s !== 'done').map((s, i) => {
          const passed = idx > i || isDone
          const active = idx === i && !isDone && !isFailed
          return (
            <li
              key={s}
              className={`text-xs flex items-center gap-2 ${
                passed
                  ? 'text-green-700'
                  : active
                    ? 'text-indigo-700 font-medium'
                    : 'text-slate-400'
              }`}
            >
              {passed ? (
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              ) : active ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
              ) : (
                <div className="w-3.5 h-3.5 rounded-full border border-current shrink-0" />
              )}
              <span>{STAGE_LABEL[s]}</span>
            </li>
          )
        })}
      </ol>
      {lastMsg && (
        <p className="text-xs text-slate-500 font-mono truncate">{lastMsg}</p>
      )}
    </div>
  )
}
