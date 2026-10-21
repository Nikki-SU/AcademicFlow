/**
 * 后台监控看板 —— Management 页右侧常驻面板
 * -------------------------------------------------
 * 用户上传 PDF 后，整条 pipeline（排队 → MinerU → 标注 → 翻译 → 提词）
 * **实时**在这里可视化，不藏在弹窗里，不藏在 toast 里。
 *
 * 看板三层信息：
 *   1. 顶部四格计数（运行 / 排队 / 完成 / 失败），点一格就只看这一类 —— 失败多时一眼收拢
 *   2. 每个任务的四节点条 + 当前阶段 + 耗时
 *   3. **失败时必须说清失败在哪一步**：红点落在真实节点上，另给「失败于 ② 标注 · AI-1 打标」+ 原始错误
 *
 * 刻意做窄：四个点各有约定俗成的含义，不需要宽度，好把宽度让给左侧文献列表。
 */
import { useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  ListTodo,
  Loader2,
  Trash2,
  XCircle,
} from 'lucide-react'
import { NODE_LABELS, STAGE_META, type PipelineStage } from '../stores/taskQueue'
import { formatDuration } from '../services/pipeline-trace'

// taskQueue 类型直接用 any 避免 import 循环（zustand store 返回类型）
type TaskQueue = any

type NodeState = 'pending' | 'current' | 'done' | 'error'

// ──── 四节点进度条 ────
const NODE_COLOR: Record<NodeState, string> = {
  pending: 'bg-ink-200',
  current: 'bg-blue-500 animate-pulse',
  done: 'bg-green-500',
  error: 'bg-red-500',
}

function NodeDot({ state }: { state: NodeState }) {
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${NODE_COLOR[state]}`} />
}

function FourNodeBar({ nodeIndex, status }: { nodeIndex: number; status: string }) {
  const states: NodeState[] = NODE_LABELS.map((_, i) => {
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

// ──── 文案与状态映射 ────
const STATUS_TEXT: Record<string, string> = {
  running: '运行中',
  pending: '排队',
  done: '完成',
  failed: '失败',
  aborted: '已取消',
}

const STATUS_BADGE: Record<string, string> = {
  running: 'bg-blue-100 text-blue-700',
  pending: 'bg-ink-100 text-ink-600',
  done: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  aborted: 'bg-red-100 text-red-700',
}

const NODE_STEP_NO = ['①', '②', '③', '④']

/** 失败 / 中止时真实所在的节点：优先 metadata.failed_node（失败前冻结的真实节点） */
function realNodeOf(t: any): number {
  const n = t.metadata?.failed_node
  if (typeof n === 'number' && n >= 0 && n <= 3) return n
  return typeof t.node_index === 'number' ? t.node_index : 0
}

/**
 * 一行里显示的阶段名。
 * 进终态后 stage 必然是 'failed'，真实阶段只能从 metadata.failed_stage 取回。
 */
function stageLabelOf(t: any): string {
  const failedStage =
    typeof t.metadata?.failed_stage === 'string' ? (t.metadata.failed_stage as PipelineStage) : undefined
  const stage = (t.status === 'failed' && failedStage ? failedStage : t.stage) as PipelineStage | undefined
  if (!stage) return '—'
  return STAGE_META[stage]?.label ?? stage
}

/** 失败卡片里的「失败于 ② 标注」 */
function failedNodeText(t: any): string {
  const node = realNodeOf(t)
  return `${NODE_STEP_NO[node] ?? ''} ${NODE_LABELS[node] ?? ''}`.trim()
}

/** 耗时：运行中是已运行、排队中是已等待、终态是总耗时 */
function elapsedOf(t: any): string | null {
  const start = typeof t.created_at === 'number' ? t.created_at : 0
  if (!start) return null
  const end = typeof t.updated_at === 'number' ? t.updated_at : Date.now()
  const prefix = t.status === 'running' ? '已运行' : t.status === 'pending' ? '已等待' : '耗时'
  return `${prefix} ${formatDuration(Math.max(0, end - start))}`
}

/** 任务在列表里的排序权重：在跑的永远在最上面，失败紧跟其后（别让失败被淹没） */
const STATUS_ORDER: Record<string, number> = { running: 0, pending: 1, failed: 2, aborted: 3, done: 4 }

type Filter = 'all' | 'running' | 'pending' | 'done' | 'failed'

const STATS: { key: Filter; label: string; dot: string; num: string }[] = [
  { key: 'running', label: '运行', dot: 'bg-blue-500 animate-pulse', num: 'text-blue-700' },
  { key: 'pending', label: '排队', dot: 'bg-ink-300', num: 'text-ink-600' },
  { key: 'done', label: '完成', dot: 'bg-green-500', num: 'text-green-700' },
  { key: 'failed', label: '失败', dot: 'bg-red-500', num: 'text-red-700' },
]

// ──── 失败详情：说清哪一步 + 原始错误（长了可展开） ────
function FailureDetail({ task }: { task: any }) {
  const [open, set_open] = useState(false)
  const raw = typeof task.error === 'string' && task.error.trim() ? task.error.trim() : ''
  const detail = raw || (typeof task.message === 'string' ? task.message : '')
  const truncatable = detail.length > 48 || detail.includes('\n')

  return (
    <div className="mt-1 rounded-control-sm border border-red-200 bg-red-50/70 px-1.5 py-1">
      <p className="text-ui-2xs font-medium text-red-700">
        失败于 {failedNodeText(task)} · {stageLabelOf(task)}
      </p>
      {detail && (
        <p
          className={`mt-0.5 whitespace-pre-wrap break-words text-ui-2xs leading-snug text-red-600/90 ${
            open || !truncatable ? '' : 'line-clamp-2'
          }`}
        >
          {detail}
        </p>
      )}
      {truncatable && (
        <button
          type="button"
          onClick={() => set_open((v) => !v)}
          className="mt-0.5 inline-flex items-center gap-0.5 text-ui-2xs text-red-600/80 transition-colors hover:text-red-700"
        >
          <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
          {open ? '收起' : '展开错误'}
        </button>
      )}
    </div>
  )
}

// ──── 任务行 ────
function TaskRow({ task }: { task: any }) {
  const is_failed = task.status === 'failed'
  const is_aborted = task.status === 'aborted'
  const node_index = is_failed ? realNodeOf(task) : task.node_index ?? 0
  const elapsed = elapsedOf(task)

  return (
    <div className="py-2">
      <div className="flex items-center gap-2">
        <FourNodeBar nodeIndex={node_index} status={task.status} />
        <p className="min-w-0 flex-1 truncate text-ui-xs font-medium text-ink-700" title={task.title}>
          {task.title}
        </p>
        <span className={`shrink-0 px-1.5 py-0.5 text-ui-2xs rounded-control-sm ${STATUS_BADGE[task.status] ?? 'bg-ink-100 text-ink-600'}`}>
          {STATUS_TEXT[task.status] ?? task.status}
        </span>
      </div>

      <div className="mt-0.5 flex items-center gap-1 text-ui-2xs text-ink-500">
        {is_failed && <AlertTriangle className="w-3 h-3 shrink-0 text-red-500" />}
        {is_aborted && <XCircle className="w-3 h-3 shrink-0 text-ink-400" />}
        {task.status === 'done' && <CheckCircle2 className="w-3 h-3 shrink-0 text-green-500" />}
        {task.status === 'running' && <Loader2 className="w-3 h-3 shrink-0 text-blue-500 animate-spin" />}
        {task.status === 'pending' && <Clock className="w-3 h-3 shrink-0 text-ink-400" />}
        {/* 中止也要说清停在哪一步，否则和「失败于提词」一样是假信息 */}
        {is_aborted ? (
          <span className="truncate">中止于 {failedNodeText(task)} · {stageLabelOf(task)}</span>
        ) : (
          <span className="truncate">{is_failed ? '失败' : stageLabelOf(task)}</span>
        )}
        {elapsed && <span className="shrink-0 text-ink-400">· {elapsed}</span>}
      </div>

      {is_failed && <FailureDetail task={task} />}
    </div>
  )
}

// ──── 列表 ────
function TaskList({ taskQueue, filter }: { taskQueue: TaskQueue; filter: Filter }) {
  const tasks = taskQueue.tasks
  const visible = useMemo(() => {
    const filtered = filter === 'all' ? tasks : tasks.filter((t: any) => t.status === filter)
    return [...filtered].sort(
      (a: any, b: any) =>
        (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
        (b.updated_at ?? 0) - (a.updated_at ?? 0),
    )
  }, [tasks, filter])

  if (visible.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center py-8 text-center text-ink-400 text-ui-xs">
        <ListTodo className="w-8 h-8 mx-auto mb-2 opacity-50" />
        {filter === 'all' ? '暂无后台任务' : `暂无${STATUS_TEXT[filter] ?? ''}任务`}
      </div>
    )
  }

  return (
    <div className="af-divided">
      {visible.map((t: any) => (
        <TaskRow key={t.id} task={t} />
      ))}
    </div>
  )
}

// ──── 主面板 ────
export default function BackendMonitorPanel({ taskQueue }: { taskQueue: TaskQueue }) {
  // 'all' 表示不筛选；点同一格再点一次即取消筛选
  const [filter, set_filter] = useState<Filter>('all')

  const counts = useMemo(() => {
    const tasks = taskQueue.tasks as any[]
    const base: Record<Filter, number> = { all: tasks.length, running: 0, pending: 0, done: 0, failed: 0 }
    for (const t of tasks) {
      if (t.status === 'running') base.running++
      else if (t.status === 'pending') base.pending++
      else if (t.status === 'done') base.done++
      else if (t.status === 'failed' || t.status === 'aborted') base.failed++
    }
    return base
  }, [taskQueue.tasks])

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper-50 border border-ink-200 rounded-card shadow-sm overflow-hidden">
      {/* 面板标题 */}
      <div className="af-line-b px-2.5 py-2 bg-paper-100 shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <Activity className="w-4 h-4 text-seal-600 shrink-0" />
            <span className="font-medium text-ui-sm text-ink-800">后台监控</span>
          </div>
          {counts.all > 0 && (
            <button
              type="button"
              onClick={() => taskQueue.clear_finished_tasks()}
              title="只清除已完成 / 失败 / 已取消的记录，运行中与排队中的保留"
              className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 text-ui-2xs text-ink-500 rounded-control-sm transition-colors hover:text-red-600 hover:bg-red-50"
            >
              <Trash2 className="w-3 h-3" />
              清除 {counts.done + counts.failed}
            </button>
          )}
        </div>
      </div>

      {/* 看板计数条：点一格只看这一类，再点一次回到全部 */}
      <div className="af-line-b shrink-0 grid grid-cols-4 bg-paper-50">
        {STATS.map((s, i) => {
          const active = filter === s.key
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => set_filter(active ? 'all' : s.key)}
              title={active ? '再点一次显示全部任务' : `只看${s.label}中的任务`}
              className={`flex flex-col items-center gap-0.5 py-1.5 transition-colors ${
                i > 0 ? 'af-line-l' : ''
              } ${active ? 'bg-paper-100' : 'hover:bg-paper-100'}`}
            >
              <span className="inline-flex items-center gap-1">
                <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                <span className={`text-ui-sm font-semibold tabular-nums ${counts[s.key] > 0 ? s.num : 'text-ink-300'}`}>
                  {counts[s.key]}
                </span>
              </span>
              <span className={`text-ui-2xs ${active ? 'text-ink-700 font-medium' : 'text-ink-400'}`}>{s.label}</span>
            </button>
          )
        })}
      </div>

      {/* 内容：拉满剩余高度，任务多时在面板内部滚动，不带动整页 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5">
        <TaskList taskQueue={taskQueue} filter={filter} />
      </div>
    </div>
  )
}
