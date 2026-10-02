/**
 * 时段表单（加课 / 加定时任务 / 编辑时段）
 * -------------------------------------------------
 * 三种入口共用同一套字段，靠 `variant` 区分：
 * - `course`    加课：填课程名 → 页面按名称复用/新建「课程任务」（多时段共享同一任务、同色）
 * - `timed`     加定时任务：先选**大类**（研究 / 课程），再选该大类下的**归属任务**（可留空）；
 *               留空则用「任务名称」在所选大类下新建一个顶级任务，时段即它的重复规则
 * - `edit`      编辑已有时段：改时间 / 地点 /（定时任务）归属任务，或删除（归属必选，不允许留空）
 *
 * 时间一律用「时 / 分」两列**闭环滚轮**（TimeWheel）—— 分钟只有 5 的倍数一格，
 * 且 55 与 00 首尾相接，不会出现断口造成「到底到没到点」的视觉误解。
 * 只收集输入，落库交给页面（Schedule.tsx）。
 */
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Modal } from './Modal'
import { TimeWheel } from './TimeWheel'
import { TaskPicker, buildParentOptions } from './TaskPicker'
import type { Project, ProjectType } from '../../services/projectData'
import { WEEKDAY_LABELS } from '../../services/scheduleData'

export interface SlotFormValue {
  /** 时段名称（课程 = 课程名；定时任务 = 所选任务名 / 新建任务名） */
  title: string
  startTime: string
  endTime: string
  location: string
  /** '' = 交给页面按「课程」处理（复用/新建课程任务）；否则为已有任务 id */
  taskId: string
  /** 定时任务新建顶级任务时用的大类；课程时段恒为 'course' */
  type: ProjectType
}

/** 把分钟数按 5 分钟取整后转 HH:MM，作为时间输入的默认值 */
export function snapTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '')
  if (!m) return ''
  const total = Math.round((parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) / 5) * 5
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(total / 60))}:${p(total % 60)}`
}

export function CourseFormModal({
  variant,
  projects,
  lockTask = false,
  initial,
  weekday,
  onWeekdayChange,
  onClose,
  onSubmit,
  onDelete,
}: {
  variant: 'course' | 'timed' | 'edit'
  projects: Project[]
  /** 归属任务是否锁死：课程时段锁在自己的课程任务上（改归属会破坏「一门课一个任务」） */
  lockTask?: boolean
  initial?: { title: string; startTime: string; endTime: string; location: string; taskId: string }
  /** 新增时段时的星期（1..7）；编辑态不需要 */
  weekday?: number
  onWeekdayChange?: (weekday: number) => void
  onClose: () => void
  onSubmit: (value: SlotFormValue) => void
  onDelete?: () => void
}) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [startTime, setStartTime] = useState(snapTime(initial?.startTime ?? ''))
  const [endTime, setEndTime] = useState(snapTime(initial?.endTime ?? ''))
  const [location, setLocation] = useState(initial?.location ?? '')
  const [taskId, setTaskId] = useState(initial?.taskId ?? '')

  const isEdit = variant === 'edit'
  // 归属任务可选 = 非课程（加定时任务、或编辑一个挂在普通任务下的时段）
  const canPickTask = variant === 'timed' || (isEdit && !lockTask)

  // 归属用两层选择：大类 + 该大类下的任务（TaskPicker）。编辑时初始大类取自现挂任务
  const parentOptions = useMemo(() => buildParentOptions(projects), [projects])
  const [type, setType] = useState<ProjectType | ''>(
    () => projects.find((p) => p.projectId === (initial?.taskId ?? ''))?.type ?? '',
  )

  const modalTitle =
    isEdit ? '编辑时段' : variant === 'timed' ? '加定时任务' : '加课'

  const handleSubmit = () => {
    if (!canPickTask) {
      const name = title.trim()
      if (!name) {
        toast.warning('请填写课程名称')
        return
      }
    } else {
      if (!type) {
        toast.warning('请选择大类')
        return
      }
      // 编辑：必须把时段挂到某个已有任务上；新增：留空 = 用「任务名称」新建该大类下的顶级任务
      if (isEdit && !taskId) {
        toast.warning('请选择归属任务')
        return
      }
      if (!isEdit && !taskId && !title.trim()) {
        toast.warning('请填写任务名称')
        return
      }
    }
    if (!startTime || !endTime) {
      toast.warning('请填写开始与结束时间')
      return
    }
    if (endTime <= startTime) {
      toast.warning('结束时间必须晚于开始时间')
      return
    }
    const name = canPickTask
      ? taskId
        ? projects.find((p) => p.projectId === taskId)?.title || title.trim()
        : title.trim()
      : title.trim()
    onSubmit({
      title: name,
      startTime,
      endTime,
      location: location.trim(),
      taskId,
      type: canPickTask ? (type as ProjectType) : 'course',
    })
  }

  return (
    <Modal
      title={modalTitle}
      onClose={onClose}
      footer={
        <>
          {isEdit && onDelete && (
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
        {!isEdit && onWeekdayChange && (
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1.5">星期</label>
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 4, 5, 6, 7].map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => onWeekdayChange(w)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                    weekday === w
                      ? 'border-seal-400 bg-seal-50 font-medium text-seal-700'
                      : 'border-ink-200 text-ink-600 hover:border-ink-300'
                  }`}
                >
                  {WEEKDAY_LABELS[w]}
                </button>
              ))}
            </div>
          </div>
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
            <p className="mt-1 text-xs text-ink-400">
              同名课程会自动归到同一个「课程任务」，可分别在周二、周四各加一节。
            </p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1.5">开始时间</label>
            <TimeWheel value={startTime} onChange={setStartTime} />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1.5">结束时间</label>
            <TimeWheel value={endTime} onChange={setEndTime} />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-ink-700 mb-1.5">地点</label>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="如：三教 201（可留空）"
            className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
          />
        </div>
      </div>
    </Modal>
  )
}