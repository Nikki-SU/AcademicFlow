/**
 * 后台任务列表组件
 * -------------------------------------------------
 * 独立组件：显示串行后台任务队列的列表，每行包含：
 *  - 标题 + 类型（转换文献 / 转换课本）
 *  - 四节点进度条（转换 → 标注 → 翻译 → 提词）
 *  - 当前 step 描述
 *  - 状态（pending/running/done/failed/aborted）
 *  - 创建时间
 *  - 取消按钮（仅 pending 状态可用）
 */
import { CheckCircle2, Loader2, XCircle, Clock, AlertCircle, Trash2 } from 'lucide-react'
import {
  type BackgroundTask,
  type TaskStatus,
  NODE_LABELS,
  STAGE_META,
} from '../stores/taskQueue'

export interface BackgroundTaskListProps {
  tasks: BackgroundTask[]
  on_abort: (id: string) => void
  on_remove?: (id: string) => void
}

const TOTAL_NODES = 4

type NodeState = 'pending' | 'current' | 'done' | 'error'

/** 直接读 task.node_index，零映射 */
function computeNodeStates(task: BackgroundTask): NodeState[] {
  const states: NodeState[] = []
  const idx = task.node_index
  if (task.status === 'done') {
    return ['done', 'done', 'done', 'done']
  }
  if (task.status === 'failed') {
    for (let i = 0; i < TOTAL_NODES; i++) {
      states.push(i < idx ? 'done' : i === idx ? 'error' : 'pending')
    }
    return states
  }
  if (task.status === 'aborted') {
    for (let i = 0; i < TOTAL_NODES; i++) {
      states.push(i < idx ? 'done' : i === idx ? 'error' : 'pending')
    }
    return states
  }
  for (let i = 0; i < TOTAL_NODES; i++) {
    states.push(i < idx ? 'done' : i === idx ? 'current' : 'pending')
  }
  return states
}

function NodeIcon({ state }: { state: NodeState }) {
  switch (state) {
    case 'done':
      return <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
    case 'current':
      return <Loader2 className="w-4 h-4 text-indigo-500 animate-spin shrink-0" />
    case 'error':
      return <XCircle className="w-4 h-4 text-red-500 shrink-0" />
    default:
      return (
        <div className="w-4 h-4 rounded-full border-2 border-slate-300 shrink-0" />
      )
  }
}

function NodeBar({ from, to }: { from: NodeState; to: NodeState }) {
  let color = 'bg-slate-200'
  if (from === 'done' && (to === 'current' || to === 'done' || to === 'error')) {
    color = 'bg-green-500'
  } else if (from === 'current') {
    color = 'bg-indigo-300'
  } else if (to === 'error') {
    color = 'bg-red-400'
  }
  return <div className={`flex-1 h-1 rounded-full mx-1 ${color}`} />
}

function FourNodeProgress({ task }: { task: BackgroundTask }) {
  const states = computeNodeStates(task)

  // 计算节点内进度百分比（用于 current 节点的内圈进度填充）
  const currentIdx = states.findIndex((s) => s === 'current')
  const nodeProgress =
    currentIdx >= 0 ? task.progress : states.every((s) => s === 'done') ? 100 : 0

  return (
    <div className="flex items-center gap-0.5 min-w-[200px]">
      {states.map((state, i) => (
        <div key={i} className="flex items-center flex-1 last:flex-none">
          <div className="relative">
            <NodeIcon state={state} />
            {/* current 节点显示进度百分比 */}
            {state === 'current' && (
              <span className="absolute -bottom-4 left-1/2 -translate-x-1/2 text-[10px] text-indigo-600 font-mono whitespace-nowrap">
                {Math.round(nodeProgress)}%
              </span>
            )}
          </div>
          {i < states.length - 1 && (
            <NodeBar from={state} to={states[i + 1]} />
          )}
        </div>
      ))}
    </div>
  )
}

function StatusBadge({ status }: { status: TaskStatus }) {
  const config: Record<TaskStatus, { label: string; className: string; icon: typeof Clock }> = {
    pending: {
      label: '排队中',
      className: 'bg-slate-100 text-slate-600',
      icon: Clock,
    },
    running: {
      label: '运行中',
      className: 'bg-blue-100 text-blue-700',
      icon: Loader2,
    },
    done: {
      label: '已完成',
      className: 'bg-green-100 text-green-700',
      icon: CheckCircle2,
    },
    failed: {
      label: '失败',
      className: 'bg-red-100 text-red-700',
      icon: AlertCircle,
    },
    aborted: {
      label: '已中止',
      className: 'bg-slate-100 text-slate-500',
      icon: XCircle,
    },
  }
  const { label, className, icon: Icon } = config[status]
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${className}`}>
      <Icon className={`w-3 h-3 ${status === 'running' ? 'animate-spin' : ''}`} />
      {label}
    </span>
  )
}

function TypeBadge({ type }: { type: BackgroundTask['type'] }) {
  if (type === 'paper_convert') {
    return (
      <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-indigo-50 text-indigo-600 border border-indigo-200">
        转换文献
      </span>
    )
  }
  return (
    <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-50 text-amber-700 border border-amber-200">
      转换课本
    </span>
  )
}

function formatTime(ts: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  const now = Date.now()
  const diff = now - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function TaskRow({
  task,
  on_abort,
  on_remove,
}: {
  task: BackgroundTask
  on_abort: (id: string) => void
  on_remove?: (id: string) => void
}) {
  const canAbort = task.status === 'pending' || task.status === 'running'

  return (
    <div className="flex items-center gap-4 py-3 px-4 bg-white rounded-lg border border-slate-200 hover:border-slate-300 transition">
      {/* 左侧：标题 + 类型 */}
      <div className="flex-1 min-w-0 max-w-[220px]">
        <div className="flex items-center gap-1.5 mb-1">
          <TypeBadge type={task.type} />
          <span className="font-medium text-slate-800 text-sm truncate" title={task.title}>
            {task.title}
          </span>
        </div>
        <div className="text-xs text-slate-500 truncate" title={task.message}>
          {task.message || STAGE_META[task.stage]?.label || '处理中...'}
        </div>
      </div>

      {/* 中间：四节点进度 */}
      <div className="flex-shrink-0 w-[300px] pb-4">
        <FourNodeProgress task={task} />
      </div>

      {/* 右侧：状态 + 时间 + 操作 */}
      <div className="flex items-center gap-3">
        <StatusBadge status={task.status} />
        <span className="text-xs text-slate-400 whitespace-nowrap">
          {formatTime(task.created_at)}
        </span>

        {/* 取消按钮：仅 pending/running 可用 */}
        {canAbort && (
          <button
            onClick={() => on_abort(task.id)}
            className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500 hover:text-red-600 hover:bg-red-50 rounded transition"
            title={task.status === 'running' ? '中止当前任务' : '取消排队'}
          >
            <XCircle className="w-3.5 h-3.5" />
            {task.status === 'running' ? '中止' : '取消'}
          </button>
        )}

        {/* 删除按钮：已完成/失败/中止的任务可清理 */}
        {on_remove && (task.status === 'done' || task.status === 'failed' || task.status === 'aborted') && (
          <button
            onClick={() => on_remove(task.id)}
            className="flex items-center gap-1 px-2 py-1 text-xs text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition"
            title="从列表移除"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

export function BackgroundTaskList({ tasks, on_abort, on_remove }: BackgroundTaskListProps) {
  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-slate-400">
        <Clock className="w-10 h-10 mb-2 opacity-50" />
        <p className="text-sm">暂无后台任务</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* 节点标签行 */}
      <div className="flex items-center gap-4 px-4 pb-1">
        <div className="flex-1 min-w-0 max-w-[220px]" />
        <div className="flex-shrink-0 w-[300px]">
          <div className="flex items-center justify-between text-[10px] text-slate-400 px-0">
            {NODE_LABELS.map((label, i) => (
              <span key={i} className="text-center" style={{ width: '60px' }}>
                {label}
              </span>
            ))}
          </div>
        </div>
        <div className="flex-shrink-0 w-[160px]" />
      </div>

      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          on_abort={on_abort}
          on_remove={on_remove}
        />
      ))}
    </div>
  )
}

