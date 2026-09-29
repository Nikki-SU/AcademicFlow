/**
 * 课程表（左栏 · 竖排时间轴）
 * -------------------------------------------------
 * 布局：**一天一行**（周一…周五，周末有课时才出现），横向是时间轴。
 * - 时间按 5 分钟刻度对齐：同一时间在不同行里落在同一 x 位置，一眼对上。
 * - 行高固定 + 轴范围由数据算出（按 5 分钟吸附），不会出现参差、也不产生拉动条。
 * - 每块按时段所属任务的**根色**着色（课程表 / 任务列表 / DDL 全局同色）。
 * - 点块 = 编辑（改时间 / 地点 /（定时任务）归属任务，或删除）。
 * 数据落库全交给页面（Schedule.tsx），本组件只呈现与收集输入。
 */
import { useMemo, useState } from 'react'
import { CalendarPlus, Clock, TrendingUp, X } from 'lucide-react'
import type { Course, ExtraDay } from '../../services/scheduleData'
import { timeToMinutes, WEEKDAY_LABELS, weekdayOfDate } from '../../services/scheduleData'
import type { Project } from '../../services/projectData'
import { colorForRoot, getRootId } from '../../services/taskColors'
import { CourseFormModal, snapTime, type SlotFormValue } from './CourseFormModal'
import { ExtraDayModal } from './ExtraDayModal'

/** 时段属于「课程」还是「定时任务」：课程任务（根、type=course）锁归属，其余可改归属 */
function isCourseSlot(course: Course, byId: Map<string, Project>): boolean {
  const p = course.taskId ? byId.get(course.taskId) : undefined
  return !!p && p.type === 'course' && !p.parentId
}

/** 取块的颜色：优先按所属任务的根色（同族同色），旧数据无 taskId 时按标题散列 */
function slotRootId(course: Course, byId: Map<string, Project>): string {
  const p = course.taskId ? byId.get(course.taskId) : undefined
  if (p) return getRootId(p, byId)
  return course.taskId || course.title || course.courseId
}

/** 分钟 → 时间轴上的百分比 */
function pct(min: number, start: number, end: number): number {
  if (end <= start) return 0
  return ((min - start) / (end - start)) * 100
}

/** 今日星期（1..7），按本地时区 */
function todayWeekday(): number {
  const js = new Date().getDay()
  return js === 0 ? 7 : js
}

export function CourseTable({
  courses,
  extraDays,
  projects,
  byId,
  currentId,
  onCreateSlot,
  onUpdateSlot,
  onDeleteCourse,
  onAddExtraDay,
  onDeleteExtraDay,
}: {
  courses: Course[]
  extraDays: ExtraDay[]
  projects: Project[]
  byId: Map<string, Project>
  currentId: string | null
  onCreateSlot: (weekday: number, variant: 'course' | 'timed', value: SlotFormValue) => void
  onUpdateSlot: (courseId: string, value: SlotFormValue) => void
  onDeleteCourse: (courseId: string) => void
  onAddExtraDay: (date: string, note: string) => void
  onDeleteExtraDay: (date: string) => void
}) {
  const [form, setForm] = useState<
    | { mode: 'create'; variant: 'course' | 'timed'; weekday: number }
    | { mode: 'edit'; courseId: string }
    | null
  >(null)
  const [showExtra, setShowExtra] = useState(false)

  // ---------- 时间轴范围：按数据算出，向整点取整，至少 5 小时 ----------
  const { rangeStart, rangeEnd } = useMemo(() => {
    const mins: number[] = []
    for (const c of courses) {
      const s = timeToMinutes(c.startTime)
      const e = timeToMinutes(c.endTime)
      if (e > 0) mins.push(s, e)
    }
    if (mins.length === 0) return { rangeStart: 8 * 60, rangeEnd: 18 * 60 }
    const start = Math.floor(Math.min(...mins) / 60) * 60
    let end = Math.ceil(Math.max(...mins) / 60) * 60
    if (end - start < 300) end = start + 300
    return { rangeStart: start, rangeEnd: end }
  }, [courses])

  const hourTicks = useMemo(() => {
    const ticks: number[] = []
    for (let m = rangeStart; m <= rangeEnd; m += 60) ticks.push(m)
    return ticks
  }, [rangeStart, rangeEnd])

  // ---------- 要显示的天：周一~周五恒显；周末有课 / 有调休才出现 ----------
  const days = useMemo(() => {
    const active = new Set<number>()
    for (const c of courses) if (c.weekday >= 1 && c.weekday <= 7) active.add(c.weekday)
    for (const d of extraDays) active.add(weekdayOfDate(d.date))
    const list = [1, 2, 3, 4, 5]
    for (const w of [6, 7]) if (active.has(w)) list.push(w)
    return list
  }, [courses, extraDays])

  const coursesOf = (weekday: number) =>
    courses
      .filter((c) => c.weekday === weekday)
      .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime))

  const today = todayWeekday()
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
  const showNow = nowMin >= rangeStart && nowMin <= rangeEnd

  const editCourse =
    form?.mode === 'edit' ? courses.find((c) => c.courseId === form.courseId) ?? null : null

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-ink-200 bg-paper-50">
      <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink-800">
          <Clock className="h-4 w-4 text-seal-600" />
          课程表
        </h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setForm({ mode: 'create', variant: 'course', weekday: 1 })}
            className="flex items-center gap-1 rounded bg-seal-600 px-2 py-1 text-xs font-medium text-paper-50 transition hover:bg-seal-700"
          >
            <CalendarPlus className="h-3.5 w-3.5" />
            加课
          </button>
          <button
            onClick={() => setForm({ mode: 'create', variant: 'timed', weekday: 1 })}
            className="rounded border border-ink-200 px-2 py-1 text-xs text-ink-600 transition hover:border-seal-300 hover:text-seal-600"
            title="把组会等定时任务加进课表"
          >
            定时任务
          </button>
          <button
            onClick={() => setShowExtra(true)}
            className="rounded border border-ink-200 px-2 py-1 text-xs text-ink-500 transition hover:border-seal-300 hover:text-seal-600"
          >
            调休
          </button>
        </div>
      </div>

      {extraDays.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-ink-100 px-3 py-2">
          {extraDays.map((d) => (
            <span
              key={d.date}
              className="inline-flex items-center gap-1 rounded-full bg-seal-100 px-2 py-0.5 text-xs text-seal-700"
            >
              {d.date}
              {d.note ? ` · ${d.note}` : ''}
              <button
                onClick={() => onDeleteExtraDay(d.date)}
                className="hover:text-seal-900"
                aria-label={`删除调休日 ${d.date}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* 时间刻度轴 */}
        <div className="flex items-end">
          <div className="w-9 shrink-0" />
          <div className="relative h-4 flex-1">
            {hourTicks.map((m) => (
              <span
                key={m}
                className="absolute -translate-x-1/2 font-mono text-[10px] leading-none text-ink-400"
                style={{ left: `${pct(m, rangeStart, rangeEnd)}%` }}
              >
                {String(m / 60).padStart(2, '0')}
              </span>
            ))}
          </div>
          <div className="w-4 shrink-0" />
        </div>

        {/* 一天一行 */}
        <div className="mt-1 space-y-1">
          {days.map((w) => {
            const list = coursesOf(w)
            const isToday = w === today
            return (
              <div key={w} className="flex items-center">
                <div
                  className={`w-9 shrink-0 font-mono text-[11px] ${
                    isToday ? 'font-semibold text-seal-700' : 'text-ink-500'
                  }`}
                >
                  {WEEKDAY_LABELS[w]}
                </div>
                <div
                  className={`relative h-8 flex-1 overflow-hidden rounded border ${
                    isToday ? 'border-seal-200 bg-seal-50/40' : 'border-ink-100 bg-paper-100'
                  }`}
                >
                  {/* 整点网格线 */}
                  {hourTicks.map((m) => (
                    <span
                      key={m}
                      className="absolute inset-y-0 border-l border-ink-100"
                      style={{ left: `${pct(m, rangeStart, rangeEnd)}%` }}
                    />
                  ))}
                  {/* 当前时刻指示 */}
                  {isToday && showNow && (
                    <span
                      className="absolute inset-y-0 z-20 border-l-2 border-red-400"
                      style={{ left: `${pct(nowMin, rangeStart, rangeEnd)}%` }}
                    />
                  )}
                  {/* 时段块 */}
                  {list.map((c) => {
                    const s = timeToMinutes(c.startTime)
                    const e = timeToMinutes(c.endTime)
                    const color = colorForRoot(slotRootId(c, byId))
                    const isCurrent = !!c.taskId && c.taskId === currentId
                    const left = pct(s, rangeStart, rangeEnd)
                    const width = pct(e, rangeStart, rangeEnd) - left
                    const label = c.title || byId.get(c.taskId)?.title || '(未命名)'
                    return (
                      <button
                        key={c.courseId}
                        onClick={() => setForm({ mode: 'edit', courseId: c.courseId })}
                        title={`${label}  ${c.startTime}–${c.endTime}${
                          c.location ? `  @${c.location}` : ''
                        }`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        className={`absolute inset-y-0.5 z-10 flex items-center overflow-hidden rounded px-1.5 text-left ${color.bg} ${
                          isCurrent ? 'ring-2 ring-ink-800' : ''
                        }`}
                      >
                        <span className="truncate text-[11px] font-medium leading-none text-paper-50">
                          {label}
                        </span>
                      </button>
                    )
                  })}
                  {list.length === 0 && (
                    <span className="absolute inset-0 flex items-center justify-center text-[10px] text-ink-300">
                      无课
                    </span>
                  )}
                </div>
                <div className="w-4 shrink-0" />
              </div>
            )
          })}
        </div>

        <div className="mt-2 flex items-center gap-1 pl-9 text-[10px] text-ink-400">
          <TrendingUp className="h-3 w-3" />
          横向为时间轴（5 分钟刻度），点色块可改时间 / 归属或删除
        </div>
      </div>

      {/* 新增时段 */}
      {form?.mode === 'create' && (
        <CourseFormModal
          variant={form.variant}
          projects={projects}
          weekday={form.weekday}
          onWeekdayChange={(w) =>
            setForm((f) => (f?.mode === 'create' ? { ...f, weekday: w } : f))
          }
          onClose={() => setForm(null)}
          onSubmit={(value) => {
            onCreateSlot(form.weekday, form.variant, value)
            setForm(null)
          }}
        />
      )}

      {/* 编辑 / 删除已有时段 */}
      {form?.mode === 'edit' && editCourse && (
        <CourseFormModal
          variant="edit"
          projects={projects}
          lockTask={isCourseSlot(editCourse, byId)}
          initial={{
            title:
              editCourse.title || byId.get(editCourse.taskId)?.title || '',
            startTime: snapTime(editCourse.startTime),
            endTime: snapTime(editCourse.endTime),
            location: editCourse.location,
            taskId: editCourse.taskId,
          }}
          onClose={() => setForm(null)}
          onSubmit={(value) => {
            onUpdateSlot(editCourse.courseId, value)
            setForm(null)
          }}
          onDelete={() => {
            onDeleteCourse(editCourse.courseId)
            setForm(null)
          }}
        />
      )}

      {showExtra && (
        <ExtraDayModal
          onClose={() => setShowExtra(false)}
          onSubmit={(date, note) => {
            onAddExtraDay(date, note)
            setShowExtra(false)
          }}
        />
      )}
    </section>
  )
}