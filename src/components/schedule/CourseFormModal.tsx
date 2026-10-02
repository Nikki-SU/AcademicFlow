/**
 * 时段表单（加课 / 加定时任务 / 编辑时段）
 * -------------------------------------------------
 * 三种入口共用同一套字段，靠 `variant` 区分：
 * - `course`    加课：填课程名 → 页面按名称复用/新建「课程任务」（多时段共享同一任务、同色）
 * - `timed`     加定时任务：先选**大类**（研究 / 课程），再选该大类下的**归属任务**（可留空）；
 *               留空则用「任务名称」在所选大类下新建一个顶级任务，时段即它的重复规则
 * - `edit`      编辑已有时段：改时间 / 地点 /（定时任务）归属任务，或删除
 *
 * **多时段**：默认一个时段，可「+ 添加时段」。每个时段 = 星期几 + 起止时间 + 地点，
 * 各时段可不同（一门课一周两天、同或不同时间 / 地点都能一次加完）。
 * 新时段默认**沿用第一个时段的时间**；**地点留空**则沿用第一个时段的地点。
 *
 * 时间一律用「时 / 分」两列**闭环滚轮**（TimeWheel）—— 分钟只有 5 的倍数一格，
 * 且 55 与 00 首尾相接，不会出现断口造成「到底到没到点」的视觉误解。
 * 只收集输入，落库交给页面（Schedule.tsx）。
 */
import { useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from './Modal'
import { TimeWheel } from './TimeWheel'
import { TaskPicker, buildParentOptions } from './TaskPicker'
import type { Project, ProjectType } from '../../services/projectData'
import { WEEKDAY_LABELS } from '../../services/scheduleData'

/** 单个时段输入（星期几 + 起止 + 地点），weekday ∈ 1..7 */
export interface SlotInput {
  weekday: number
  startTime: string
  endTime: string
  location: string
}

export interface SlotFormValue {
  /** 时段名称（课程 = 课程名；定时任务 = 所选任务名 / 新建任务名） */
  title: string
  /** 待写入的时段（至少一个） */
  slots: SlotInput[]
  /** '' = 交给页面按「课程」处理（复用/新建课程任务）；否则为已有任务 id */
  taskId: string
  /** 定时任务新建顶级任务时用的大类；课程时段恒为 'course' */
  type: ProjectType
}

/** 表单内部行：星期未选时用 '' */
interface SlotRow {
  weekday: number | ''
  startTime: string
  endTime: string
  location: string
}

/** 把分钟数按 5 分钟取整后转 HH:MM，作为时间输入的默认值 */
export function snapTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '')
  if (!m) return ''
  const total = Math.round((parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) / 5) * 5
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(total / 60))}:${p(total % 60)}`
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7]

export function CourseFormModal({
  variant,
  projects,
  lockTask = false,
  initial,
  editScope,
  onClose,
  onSubmit,
  onDelete,
}: {
  variant: 'course' | 'timed' | 'edit'
  projects: Project[]
  /** 归属任务是否锁死：课程时段锁在自己的课程任务上（改归属会破坏「一门课一个任务」） */
  lockTask?: boolean
  /** 编辑：初始时段（单时段编辑 = 1 个；整门课编辑 = 该任务全部时段） */
  initial?: { title: string; taskId: string; slots: SlotInput[] }
  /** 编辑：是否显示「整门课一起编辑」勾选框 */
  editScope?: { canToggle: boolean; all: boolean; onToggle: (all: boolean) => void }
  onClose: () => void
  onSubmit: (value: SlotFormValue) => void
  onDelete?: () => void
}) {
  const isEdit = variant === 'edit'
  // 归属任务可选 = 非课程（加定时任务、或编辑一个挂在普通任务下的时段）
  const canPickTask = variant === 'timed' || (isEdit && !lockTask)

  const [title, setTitle] = useState(initial?.title ?? '')
  const [taskId, setTaskId] = useState(initial?.taskId ?? '')
  const [slots, setSlots] = useState<SlotRow[]>(() =>
    initial && initial.slots.length > 0
      ? initial.slots.map((s) => ({
          weekday: s.weekday,
          startTime: snapTime(s.startTime),
          endTime: snapTime(s.endTime),
          location: s.location,
        }))
      : [{ weekday: '', startTime: '08:00', endTime: '09:00', location: '' }],
  )

  // 归属用两层选择：大类 + 该大类下的任务（TaskPicker）。编辑时初始大类取自现挂任务
  const parentOptions = useMemo(() => buildParentOptions(projects), [projects])
  const [type, setType] = useState<ProjectType | ''>(
    () => projects.find((p) => p.projectId === (initial?.taskId ?? ''))?.type ?? '',
  )

  const modalTitle =
    isEdit ? '编辑时段' : variant === 'timed' ? '加定时任务' : '加课'

  const updateSlot = (i: number, patch: Partial<SlotRow>) =>
    setSlots((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  const addSlot = () =>
    setSlots((prev) => {
      const first = prev[0]
      // 时间沿用第一个时段（可见、可改）；地点留空 → 提交时沿用第一个
      return [...prev, { weekday: '', startTime: first.startTime, endTime: first.endTime, location: '' }]
    })

  const removeSlot = (i: number) => setSlots((prev) => prev.filter((_, idx) => idx !== i))

  const handleSubmit = () => {
    // 名称 / 归属校验
    if (!canPickTask) {
      if (!title.trim()) {
        toast.warning('请填写课程名称')
        return
      }
    } else {
      if (!type) {
        toast.warning('请选择大类')
        return
      }
      if (isEdit && !taskId) {
        toast.warning('请选择归属任务')
        return
      }
      if (!isEdit && !taskId && !title.trim()) {
        toast.warning('请填写任务名称')
        return
      }
    }
    // 每个时段都要有星期与合法时间
    for (let i = 0; i < slots.length; i++) {
      const r = slots[i]
      if (!r.weekday) {
        toast.warning(`请为第 ${i + 1} 个时段选择星期`)
        return
      }
      if (!r.startTime || !r.endTime) {
        toast.warning(`请填写第 ${i + 1} 个时段的起止时间`)
        return
      }
      if (r.endTime <= r.startTime) {
        toast.warning(`第 ${i + 1} 个时段的结束时间必须晚于开始时间`)
        return
      }
    }

    const first = slots[0]
    const outSlots: SlotInput[] = slots.map((r) => ({
      weekday: r.weekday as number,
      startTime: r.startTime,
      endTime: r.endTime,
      // 地点留空 → 沿用第一个时段的地点
      location: r.location.trim() || first.location.trim(),
    }))

    const name = canPickTask
      ? taskId
        ? projects.find((p) => p.projectId === taskId)?.title || title.trim()
        : title.trim()
      : title.trim()

    onSubmit({
      title: name,
      slots: outSlots,
      taskId,
      type: canPickTask ? (type as ProjectType) : 'course',
    })
  }

  return (
    <Modal
      title={modalTitle}
      onClose={onClose}
      maxWidth="max-w-xl"
      footer={
        <>
          {isEdit && onDelete && !editScope?.all && (
            <button
              onClick={onDelete}
              className="mr-auto px-4 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition"
            >
              删除时段
            </button>
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-ink-600 hover:bg-ink-100 rounded-lg transition"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            className="px-4 py-2 text-sm text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-lg transition font-medium"
          >
            {isEdit ? '保存' : '添加'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {/* 编辑范围：单时段 / 整门课全部时段（需勾选） */}
        {editScope?.canToggle && (
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-ink-200 bg-paper-100 px-3 py-2 text-sm text-ink-700">
            <input
              type="checkbox"
              checked={editScope.all}
              onChange={(e) => editScope.onToggle(e.target.checked)}
            />
            编辑该任务的全部时段（共 {slots.length} 个）
          </label>
        )}

        {canPickTask ? (
          <>
            <TaskPicker
              parentOptions={parentOptions}
              type={type}
              onTypeChange={setType}
              parentId={taskId}
              onParentChange={setTaskId}
              allowTopLevel={!isEdit}
            />
            {!isEdit && !taskId && (
              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1.5">任务名称</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="如：每周组会"
                  className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
                <p className="mt-1 text-xs text-ink-400">
                  归属任务留空时，将用此名在所选大类下新建一个顶级任务；定时任务（如每周组会）即挂在它下面。
                </p>
              </div>
            )}
          </>
        ) : (
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1.5">课程名称</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="如：高等数学"
              autoFocus
              className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
            />
            {!isEdit && (
              <p className="mt-1 text-xs text-ink-400">
                同名课程会自动归到同一个「课程任务」，可一次添加多个时段（如周二、周四）。
              </p>
            )}
          </div>
        )}

        {/* 时段列表 */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-ink-700">时段</span>
            <button
              type="button"
              onClick={addSlot}
              className="flex items-center gap-1 rounded-lg border border-ink-200 px-2.5 py-1 text-ui-xs text-ink-600 transition hover:border-seal-300 hover:text-seal-600"
            >
              <Plus className="h-3.5 w-3.5" />
              添加时段
            </button>
          </div>

          {slots.map((row, i) => (
            <div key={i} className="space-y-3 rounded-lg border border-ink-200 bg-paper-50 p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-ink-400">时段 {i + 1}</span>
                <select
                  value={row.weekday}
                  onChange={(e) =>
                    updateSlot(i, { weekday: e.target.value ? Number(e.target.value) : '' })
                  }
                  className="ml-auto rounded-lg border border-ink-300 bg-paper-50 px-3 py-1.5 text-sm focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
                >
                  <option value="">选择星期…</option>
                  {WEEKDAYS.map((w) => (
                    <option key={w} value={w}>{WEEKDAY_LABELS[w]}</option>
                  ))}
                </select>
                {slots.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeSlot(i)}
                    className="p-1 text-ink-400 transition hover:text-red-500"
                    aria-label={`删除时段 ${i + 1}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-ink-700">开始时间</label>
                  <TimeWheel value={row.startTime} onChange={(v) => updateSlot(i, { startTime: v })} />
                </div>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-ink-700">结束时间</label>
                  <TimeWheel value={row.endTime} onChange={(v) => updateSlot(i, { endTime: v })} />
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-ink-700">地点</label>
                <input
                  type="text"
                  value={row.location}
                  onChange={(e) => updateSlot(i, { location: e.target.value })}
                  placeholder={
                    i > 0
                      ? slots[0].location.trim() || '留空则同第一个时段'
                      : '如：三教 201（可留空）'
                  }
                  className="w-full rounded-lg border border-ink-300 px-3 py-2 text-sm focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
                />
              </div>
            </div>
          ))}

          {slots.length > 1 && (
            <p className="text-xs text-ink-400">
              新时段默认沿用第一个时段的时间；地点留空则沿用第一个时段的地点。
            </p>
          )}
        </div>
      </div>
    </Modal>
  )
}