/**
 * 双引擎运行时间线（M3.5.1 · M3.6 加轮次徽章）
 * -------------------------------------------------
 * 四节点横向进度条：① AI-1 生成 → ② AI-2 核查 → ③ 引证校验 → ④ 完成。
 * 每个节点三态：pending / running / done / error
 *
 * M3.6 新增：
 *   - 顶部一行"第 N/M 轮 · 原因"轮次徽章
 *   - AI-2 自我纠错时（stage='ai2_self_correct_running'），节点 2 显示"AI-2 自纠"
 *   - reason='ai2_self_correct' 时，节点 1（AI-1）视为 done 保留（AI-1 未重跑）
 */
import { AlertTriangle, CheckCircle, Loader2, RotateCcw } from 'lucide-react'
import type { JSX } from 'react'
import type { AttemptReason, DualEngineStage } from '../../types'

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
  /** M3.6: 当前轮次（1..maxAttempts） */
  attempt?: number
  /** M3.6: 最大轮数 */
  maxAttempts?: number
  /** M3.6: 本轮触发原因 */
  reason?: AttemptReason
}

/** 根据 stage 计算各节点状态（M3.6: 加 ai2_self_correct_running / attempt_start） */
function computeStatuses(
  stage: DualEngineStage,
  errorAtStage: DualEngineStage | null,
  reason: AttemptReason | undefined,
): {
  ai1: NodeStatus
  ai2: NodeStatus
  verify: NodeStatus
  done: NodeStatus
} {
  // 错误态：错在哪一节点，就该节点标 error
  if (stage === 'error' && errorAtStage) {
    const errIdx =
      errorAtStage === 'ai1_running'
        ? 1
        : errorAtStage === 'ai2_running' ||
            errorAtStage === 'ai2_self_correct_running'
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

  // AI-2 自纠：AI-1 直接算 done（未重跑，但输出保留）
  if (reason === 'ai2_self_correct') {
    const ai2: NodeStatus =
      stage === 'ai2_self_correct_running' || stage === 'ai2_running'
        ? 'running'
        : stage === 'ai2_done' || stage === 'verifying' || stage === 'finished'
          ? 'done'
          : 'pending'
    const verify: NodeStatus =
      stage === 'verifying'
        ? 'running'
        : stage === 'finished'
          ? 'done'
          : 'pending'
    const done: NodeStatus = stage === 'finished' ? 'done' : 'pending'
    return { ai1: 'done', ai2, verify, done }
  }

  const ai1: NodeStatus =
    stage === 'idle' || stage === 'attempt_start'
      ? 'pending'
      : stage === 'ai1_running'
        ? 'running'
        : 'done'
  const ai2: NodeStatus =
    stage === 'idle' ||
    stage === 'attempt_start' ||
    stage === 'ai1_running' ||
    stage === 'ai1_done'
      ? 'pending'
      : stage === 'ai2_running' || stage === 'ai2_self_correct_running'
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

/** M3.6: 归因原因转 UI 文案 */
function reasonLabel(reason: AttemptReason | undefined): string {
  if (!reason) return ''
  if (reason === 'first_run') return '首次运行'
  if (reason === 'ai1_rewrite') return 'AI-1 重写'
  return 'AI-2 自纠'
}

function reasonColor(reason: AttemptReason | undefined): string {
  if (reason === 'ai1_rewrite') return 'bg-amber-100 text-amber-800 border-amber-300'
  if (reason === 'ai2_self_correct')
    return 'bg-purple-100 text-purple-800 border-purple-300'
  return 'bg-slate-100 text-slate-700 border-slate-300'
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
      <span className="font-mono text-[0.6875rem] leading-tight min-h-[0.875rem]">
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
  attempt,
  maxAttempts,
  reason,
}: StageTimelineProps) {
  const { ai1, ai2, verify, done } = computeStatuses(
    stage,
    errorAtStage,
    reason,
  )
  const ai2Label = reason === 'ai2_self_correct' ? 'AI-2 自纠' : 'AI-2 核查'
  const showBadge = attempt && maxAttempts

  return (
    <div className="space-y-1.5">
      {/* M3.6 轮次徽章（跑过至少一轮才显示） */}
      {showBadge && (
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono border rounded ${reasonColor(reason)}`}
          >
            {(reason === 'ai1_rewrite' || reason === 'ai2_self_correct') && (
              <RotateCcw className="w-3 h-3" />
            )}
            第 {attempt}/{maxAttempts} 轮 · {reasonLabel(reason)}
          </span>
          {maxAttempts > 1 && attempt < maxAttempts && (
            <span className="text-[0.6875rem] text-slate-500">
              未通过将自动进入下一轮（最多 {maxAttempts} 轮）
            </span>
          )}
        </div>
      )}
      <div className="flex items-stretch gap-1.5">
        <Node index={1} label="AI-1 生成" status={ai1} text={ai1Text} />
        <Node index={2} label={ai2Label} status={ai2} text={ai2Text} />
        <Node index={3} label="引证校验" status={verify} text={null} />
        <Node index={4} label="完成" status={done} text={totalText} />
      </div>
    </div>
  )
}

export default StageTimeline
