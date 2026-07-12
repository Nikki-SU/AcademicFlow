/**
 * 双引擎运行时间线（M3.5.1）
 * -------------------------------------------------
 * 四节点横向进度条：① AI-1 生成 → ② AI-2 核查 → ③ 引证校验 → ④ 完成。
 * 每个节点三态：
 *   - pending：待运行（灰）
 *   - running：进行中（蓝，转圈 icon + 实时秒表）
 *   - done：已完成（绿，✓ icon + 定格总耗时）
 *   - error：中途异常（红，⚠ icon）—— 只有出错节点单独染红，其余按已达到状态展示
 *
 * 秒表由父组件传入（elapsedText），父组件用 useEffect setInterval 触发 rerender。
 */
import { AlertTriangle, CheckCircle, Loader2 } from 'lucide-react'
import type { JSX } from 'react'
import type { DualEngineStage } from '../../types'

/** 节点状态 */
export type NodeStatus = 'pending' | 'running' | 'done' | 'error'

interface StageTimelineProps {
  stage: DualEngineStage
  /** 各节点秒表文本；running 状态传"已 X.Xs"，done 状态传"X.Xs" */
  ai1Text: string | null
  ai2Text: string | null
  totalText: string | null
  /** 是否处于错误态（stage='error' 时判断错在哪一节点） */
  errorAtStage: DualEngineStage | null
}

/** 根据 stage 计算各节点状态 */
function computeStatuses(
  stage: DualEngineStage,
  errorAtStage: DualEngineStage | null,
): {
  ai1: NodeStatus
  ai2: NodeStatus
  verify: NodeStatus
  done: NodeStatus
} {
  // 错误态：错在哪一节点，就该节点标 error，之前的节点保持 done，之后的保持 pending
  if (stage === 'error' && errorAtStage) {
    const errIdx =
      errorAtStage === 'ai1_running'
        ? 1
        : errorAtStage === 'ai2_running'
          ? 2
          : errorAtStage === 'verifying'
            ? 3
            : 0
    return {
      ai1: errIdx === 1 ? 'error' : errIdx > 1 ? 'done' : 'pending',
      ai2: errIdx === 2 ? 'error' : errIdx > 2 ? 'done' : 'pending',
      verify: errIdx === 3 ? 'error' : 'pending',
      done: 'pending',
    }
  }

  const ai1: NodeStatus =
    stage === 'idle'
      ? 'pending'
      : stage === 'ai1_running'
        ? 'running'
        : 'done'
  const ai2: NodeStatus =
    stage === 'idle' || stage === 'ai1_running' || stage === 'ai1_done'
      ? 'pending'
      : stage === 'ai2_running'
        ? 'running'
        : 'done'
  const verify: NodeStatus =
    stage === 'verifying'
      ? 'running'
      : stage === 'finished'
        ? 'done'
        : 'pending'
  const done: NodeStatus = stage === 'finished' ? 'done' : 'pending'
  return { ai1, ai2, verify, done }
}

/** 单节点渲染 */
function Node({
  index,
  label,
  status,
  text,
}: {
  index: number
  label: string
  status: NodeStatus
  text: string | null
}) {
  const styleByStatus: Record<NodeStatus, string> = {
    pending: 'border-slate-200 bg-slate-50 text-slate-400',
    running: 'border-indigo-300 bg-indigo-50 text-indigo-700',
    done: 'border-green-300 bg-green-50 text-green-800',
    error: 'border-red-300 bg-red-50 text-red-800',
  }
  const iconByStatus: Record<NodeStatus, JSX.Element> = {
    pending: (
      <span className="w-3.5 h-3.5 rounded-full border border-current inline-block" />
    ),
    running: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
    done: <CheckCircle className="w-3.5 h-3.5" />,
    error: <AlertTriangle className="w-3.5 h-3.5" />,
  }
  const marker = ['①', '②', '③', '④'][index - 1] ?? ''
  return (
    <div
      className={`flex-1 min-w-0 flex flex-col items-center gap-0.5 px-2 py-2 rounded-md border text-xs transition-colors ${styleByStatus[status]}`}
    >
      <div className="flex items-center gap-1.5">
        {iconByStatus[status]}
        <span className="font-medium whitespace-nowrap">
          {marker} {label}
        </span>
      </div>
      <span className="font-mono text-[11px] leading-tight min-h-[14px]">
        {text ?? '\u00A0'}
      </span>
    </div>
  )
}

function StageTimeline({
  stage,
  ai1Text,
  ai2Text,
  totalText,
  errorAtStage,
}: StageTimelineProps) {
  const { ai1, ai2, verify, done } = computeStatuses(stage, errorAtStage)
  return (
    <div className="flex items-stretch gap-1.5">
      <Node index={1} label="AI-1 生成" status={ai1} text={ai1Text} />
      <Node index={2} label="AI-2 核查" status={ai2} text={ai2Text} />
      <Node index={3} label="引证校验" status={verify} text={null} />
      <Node index={4} label="完成" status={done} text={totalText} />
    </div>
  )
}

export default StageTimeline
