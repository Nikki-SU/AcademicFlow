/**
 * 后台监控面板 —— Management 页右侧常驻 sticky 面板
 * -------------------------------------------------
 * 用户上传 PDF 后，整条 pipeline（排队 → MinerU → 标注 → 翻译 → 提词）
 * **实时**在这里可视化，不藏在弹窗里，不藏在 toast 里。
 *
 * 只有一栏内容：taskQueue 里的任务，四节点进度条 + 当前 stage + 耗时。
 * 刻意做窄（四个点各有约定俗成的含义，不需要宽度），好把宽度让给左侧
 * 文献列表 —— 列表条目一旦被挤到要左右滑动，就非常难用。
 */
import {
  Activity,
  CheckCircle2,
  Clock,
  AlertTriangle,
  XCircle,
  ListTodo,
  Loader2,
} from 'lucide-react'
import { NODE_LABELS, STAGE_META } from '../stores/taskQueue'

// taskQueue 类型直接用 any 避免 import 循环（zustand store 返回类型）
type TaskQueue = any

// ──── 四节点进度条 ────
const NODE_COLOR: Record<'pending' | 'current' | 'done' | 'error', string> = {
  pending: 'bg-ink-200',
  current: 'bg-blue-500 animate-pulse',
  done: 'bg-green-500',
  error: 'bg-red-500',
}

function NodeDot({ state }: { state: 'pending' | 'current' | 'done' | 'error' }) {
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${NODE_COLOR[state]}`} />
}

function FourNodeBar({ nodeIndex, status }: { nodeIndex: number; status: string }) {
  const states: ('pending' | 'current' | 'done' | 'error')[] = NODE_LABELS.map((_, i) => {
    if (status === 'failed' || status === 'aborted') {
      if (i === nodeIndex) return 'error'
      return i < nodeIndex ? 'done' : 'pending'
    }
    if (i < nodeIndex) return 'done'
    if (i === nodeIndex) return status === 'running' ? 'current' : 'pending'
    return 'pending'
  })
  return (
    <div className="flex items-center gap-0.5">
      {states.map((s, i) => (
        <NodeDot key={i} state={s} />
      ))}
    </div>
  )
}

// ──── 实时任务列表 ────
function LiveTaskList({ taskQueue }: { taskQueue: TaskQueue }) {
  const tasks = taskQueue.tasks
  if (tasks.length === 0) {
    return (
      <div className="py-8 text-center text-ink-400 text-xs">
        <ListTodo className="w-8 h-8 mx-auto mb-2 opacity-50" />
        暂无后台任务
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {tasks.map((t: any) => {
        const meta = t.node_index !== undefined ? STAGE_META[t.node_index as keyof typeof STAGE_META] : null
        return (
          <div
            key={t.id}
            className="border border-ink-200 rounded-lg p-2.5 bg-paper-50 hover:border-ink-300 transition"
          >
            <div className="flex items-center gap-2 mb-1.5">
              <FourNodeBar nodeIndex={t.node_index ?? 0} status={t.status} />
              <span className="flex-1 min-w-0 text-xs font-medium text-ink-700 truncate" title={t.title}>
                {t.title}
              </span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${
                  t.status === 'running'
                    ? 'bg-blue-100 text-blue-700'
                    : t.status === 'pending'
                    ? 'bg-ink-100 text-ink-600'
                    : t.status === 'done'
                    ? 'bg-green-100 text-green-700'
                    : 'bg-red-100 text-red-700'
                }`}
              >
                {t.status}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-ink-500">
              {t.status === 'failed' && <AlertTriangle className="w-3 h-3 text-red-500" />}
              {t.status === 'aborted' && <XCircle className="w-3 h-3 text-ink-400" />}
              {t.status === 'done' && <CheckCircle2 className="w-3 h-3 text-green-500" />}
              {t.status === 'running' && <Loader2 className="w-3 h-3 text-blue-500 animate-spin" />}
              {t.status === 'pending' && <Clock className="w-3 h-3 text-ink-400" />}
              <span className="truncate">{meta?.label ?? t.stage ?? '—'}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ──── 主面板 ────
export default function BackendMonitorPanel({ taskQueue }: { taskQueue: TaskQueue }) {
  const runningCount = taskQueue.tasks.filter((t: any) => t.status === 'running').length
  const pendingCount = taskQueue.tasks.filter((t: any) => t.status === 'pending').length

  return (
    <div className="bg-paper-50 border border-ink-200 rounded-xl shadow-sm overflow-hidden">
      {/* 面板标题 */}
      <div className="px-2.5 py-2 bg-paper-100 border-b border-ink-200">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Activity className="w-4 h-4 text-seal-600 shrink-0" />
          <span className="font-medium text-sm text-ink-800">后台监控</span>
          {runningCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded-full">
              <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />
              {runningCount} 运行中
            </span>
          )}
          {pendingCount > 0 && (
            <span className="text-[10px] text-ink-500">· {pendingCount} 排队</span>
          )}
        </div>
      </div>

      {/* 内容 */}
      <div className="p-2.5">
        <LiveTaskList taskQueue={taskQueue} />
      </div>
    </div>
  )
}
