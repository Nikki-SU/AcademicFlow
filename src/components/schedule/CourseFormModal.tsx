/**
 * 时段表单（加课 / 加定时任务 / 编辑时段）
 * -------------------------------------------------
 * 三种入口共用同一套字段，靠 `variant` 区分：
 * - `course`    加课：填课程名 → 页面按名称复用/新建「课程任务」（多时段共享同一任务、同色）
 * - `timed`     加定时任务：挑一个**已有任务**（如把每周组会挂到「研究」下），时段即它的重复规则
 * - `edit`      编辑已有时段：改时间 / 地点 /（定时任务）归属任务，或删除
 *
 * 时间一律用「时 / 分」两列**闭环滚轮**（TimeWheel）—— 分钟只有 5 的倍数一格，
 * 且 55 与 00 首尾相接，不会出现断口造成「到底到没到点」的视觉误解。
 * 只收集输入，落库交给页面（Schedule.tsx）。
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Modal } from './Modal'
import { TimeWheel } from './TimeWheel'
import type { Project } from '../../services/projectData'
import { WEEKDAY_LABELS } from '../../services/scheduleData'

export interface SlotFormValue {
  /** 时段名称（课程 = 课程名；定时任务 = 所选任务名） */
  title: string
  startTime: string
  endTime: string
  location: string
  /** '' = 交给页面按「课程」处理（复用/新建课程任务）；否则为已有任务 id */
  taskId: string
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

  const modalTitle =
    isEdit ? '编辑时段' : variant === 'timed' ? '加定时任务' : '加课'

  const handleSubmit = () => {
    if (!canPickTask) {
      const name = title.trim()
      if (!name) {
        toast.warning('请填写课程名称')
        return
      }
    } else if (!taskId) {
      toast.warning('请选择归属任务')
      return
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
      ? projects.find((p) => p.projectId === taskId)?.title || title.trim()
      : title.trim()
    onSubmit({ title: name, startTime, endTime, location: location.trim(), taskId })
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
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1.5">归属任务</label>
            <select
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
              className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm bg-paper-50 focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
            >
              <option value="">请选择任务…</option>
              {projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.type === 'course' ? '课程' : '研究'} · {p.title || '(未命名任务)'}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-ink-400">
              定时任务（如每周组会）可挂到「研究」等大任务下，颜色随该任务所在族。
            </p>
          </div>
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