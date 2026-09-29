/**
 * 课程表（左栏 · 竖排时间轴）
 * -------------------------------------------------
 * 布局：**一天一列**（周一…周五，周末有课时才出现），纵向是时间轴。
 * - 时间按 5 分钟刻度对齐：同一时刻在不同列里落在同一 y 位置，一眼对上。
 * - 课块文案**完整显示**：列宽就是课块可用的横向空间（不再按课程时长把方块压窄），
 *   长名字直接折行，不需要点开才看得到。
 * - 同一时段重叠的课块自动**并排分列**，不会互相盖住。
 * - 每块按时段所属任务的**根色**着色（课程表 / 任务列表 / DDL 全局同色）。
 * - 点块 = 编辑（改时间 / 地点 /（定时任务）归属任务，或删除）。
 * 尺寸全部走 index.css 的 --ui-* 流体口径（时间轴列宽 --ui-axis、列高 --ui-lane、
 * 字号 --ui-text-*），不再有任何写死的像素值。
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

/** 取块的颜色：按所属任务的根色（同族同色） */
function slotRootId(course: Course, byId: Map<string, Project>): string {
  const p = byId.get(course.taskId)
  return p ? getRootId(p, byId) : course.taskId
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

/** 一列里摆好位置的课块 */
interface Placed {
  course: Course
  top: number
  height: number
  left: number
  width: number
}

/**
 * 把一天的课摆进时间轴：按开始时间排序，用贪心列分配处理**重叠**
 * （标准区间着色：事件按起点排序后依次放进第一个「上一件事已结束」的列）。
 * 结果：不重叠时独占整列宽；重叠时并排分列，谁也不会盖住谁。
 */
function layoutLane(list: Course[], start: number, end: number): Placed[] {
  const items = list
    .map((c) => ({ c, s: timeToMinutes(c.startTime), e: timeToMinutes(c.endTime) }))
    .filter((it) => it.e > 0)
    .sort((a, b) => a.s - b.s || a.e - b.e)
  const colEnds: number[] = []
  const assigned: { c: Course; s: number; e: number; col: number }[] = []
  for (const it of items) {
    let col = 0
    while (col < colEnds.length && colEnds[col] > it.s) col++
    colEnds[col] = it.e
    assigned.push({ ...it, col })
  }
  const nCols = Math.max(1, colEnds.length)
  return assigned.map(({ c, s, e, col }) => {
    const top = pct(s, start, end)
    const bottom = pct(e, start, end)
    return {
      course: c,
      top,
      height: Math.max(bottom - top, 0),
      left: (col / nCols) * 100,
      width: 100 / nCols,
    }
  })
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
    courses.filter((c) => c.weekday === weekday)

  const today = todayWeekday()
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
  const showNow = nowMin >= rangeStart && nowMin <= rangeEnd

  const editCourse =
    form?.mode === 'edit' ? courses.find((c) => c.courseId === form.courseId) ?? null : null

  // 天列栅格：列数随「显示几天」变化，所以用内联 style（动态 repeat）
  const dayCols = `repeat(${days.length}, minmax(0, 1fr))`

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-ink-200 bg-paper-50">
      <div className="flex items-center justify-between gap-ui-gap border-b border-ink-100 px-ui-gap py-ui-gap-sm">
        <h2 className="flex items-center gap-ui-gap-sm text-ui-sm font-semibold text-ink-800">
          <Clock className="h-ui-icon w-ui-icon text-seal-600" />
          课程表
        </h2>
        <div className="flex items-center gap-ui-gap-sm">
          <button
            onClick={() => setForm({ mode: 'create', variant: 'course', weekday: 1 })}
            className="flex items-center gap-ui-gap-sm rounded bg-seal-600 px-ui-gap-sm py-ui-gap-sm text-ui-xs font-medium text-paper-50 transition hover:bg-seal-700"
          >
            <CalendarPlus className="h-ui-icon-sm w-ui-icon-sm" />
            加课
          </button>
          <button
            onClick={() => setForm({ mode: 'create', variant: 'timed', weekday: 1 })}
            className="rounded border border-ink-200 px-ui-gap-sm py-ui-gap-sm text-ui-xs text-ink-600 transition hover:border-seal-300 hover:text-seal-600"
            title="把组会等定时任务加进课表"
          >
            定时任务
          </button>
          <button
            onClick={() => setShowExtra(true)}
            className="rounded border border-ink-200 px-ui-gap-sm py-ui-gap-sm text-ui-xs text-ink-500 transition hover:border-seal-300 hover:text-seal-600"
          >
            调休
          </button>
        </div>
      </div>

      {extraDays.length > 0 && (
        <div className="flex flex-wrap gap-ui-gap-sm border-b border-ink-100 px-ui-gap py-ui-gap-sm">
          {extraDays.map((d) => (
            <span
              key={d.date}
              className="inline-flex items-center gap-ui-gap-sm rounded-full bg-seal-100 px-ui-gap-sm py-0.5 text-ui-xs text-seal-700"
            >
              {d.date}
              {d.note ? ` · ${d.note}` : ''}
              <button
                onClick={() => onDeleteExtraDay(d.date)}
                className="hover:text-seal-900"
                aria-label={`删除调休日 ${d.date}`}
              >
                <X className="h-ui-icon-sm w-ui-icon-sm" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-ui-gap">
        {/* 表头：星期标签（与下方时间轴网格严格对齐） */}
        <div className="flex gap-ui-gap-sm">
          <div className="w-ui-axis shrink-0" />
          <div className="grid flex-1 gap-ui-gap-sm" style={{ gridTemplateColumns: dayCols }}>
            {days.map((w) => (
              <div
                key={w}
                className={`text-center font-mono text-ui-xs ${
                  w === today ? 'font-semibold text-seal-700' : 'text-ink-500'
                }`}
              >
                {WEEKDAY_LABELS[w]}
              </div>
            ))}
          </div>
        </div>

        {/* 主体：左=时间刻度，右=每天一列 */}
        <div className="mt-ui-gap-sm flex gap-ui-gap-sm">
          <div className="relative w-ui-axis shrink-0" style={{ height: 'var(--ui-lane)' }}>
            {hourTicks.map((m) => (
              <span
                key={m}
                className="absolute right-1 -translate-y-1/2 font-mono text-ui-2xs leading-none text-ink-400"
                style={{ top: `${pct(m, rangeStart, rangeEnd)}%` }}
              >
                {String(m / 60).padStart(2, '0')}
              </span>
            ))}
          </div>

          <div className="grid flex-1 gap-ui-gap-sm" style={{ gridTemplateColumns: dayCols }}>
            {days.map((w) => {
              const placed = layoutLane(coursesOf(w), rangeStart, rangeEnd)
              const isToday = w === today
              return (
                <div
                  key={w}
                  className={`relative overflow-hidden rounded border ${
                    isToday ? 'border-seal-200 bg-seal-50/40' : 'border-ink-100 bg-paper-100'
                  }`}
                  style={{ height: 'var(--ui-lane)' }}
                >
                  {/* 整点网格线 */}
                  {hourTicks.map((m) => (
                    <span
                      key={m}
                      className="absolute inset-x-0 border-t border-ink-100"
                      style={{ top: `${pct(m, rangeStart, rangeEnd)}%` }}
                    />
                  ))}
                  {/* 当前时刻指示 */}
                  {isToday && showNow && (
                    <span
                      className="absolute inset-x-0 z-20 border-t-2 border-red-400"
                      style={{ top: `${pct(nowMin, rangeStart, rangeEnd)}%` }}
                    />
                  )}
                  {/* 时段块：文案完整折行显示，不截断 */}
                  {placed.map(({ course: c, top, height, left, width }) => {
                    const color = colorForRoot(slotRootId(c, byId))
                    const isCurrent = !!c.taskId && c.taskId === currentId
                    const label = byId.get(c.taskId)?.title || c.title || '(未命名)'
                    return (
                      <button
                        key={c.courseId}
                        onClick={() => setForm({ mode: 'edit', courseId: c.courseId })}
                        title={`${label}  ${c.startTime}–${c.endTime}${
                          c.location ? `  @${c.location}` : ''
                        }`}
                        style={{
                          top: `${top}%`,
                          height: `${height}%`,
                          left: `${left}%`,
                          width: `${width}%`,
                        }}
                        className={`absolute z-10 flex flex-col items-start overflow-hidden rounded px-ui-gap-sm py-0.5 text-left ${color.bg} ${
                          isCurrent ? 'ring-2 ring-ink-800' : ''
                        }`}
                      >
                        <span className="w-full text-ui-xs font-medium leading-tight text-paper-50 [overflow-wrap:anywhere]">
                          {label}
                        </span>
                        {c.location && (
                          <span className="w-full text-ui-2xs leading-tight text-paper-50/80 [overflow-wrap:anywhere]">
                            {c.location}
                          </span>
                        )}
                      </button>
                    )
                  })}
                  {placed.length === 0 && (
                    <span className="absolute inset-0 flex items-center justify-center text-ui-2xs text-ink-300">
                      无课
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="mt-ui-gap flex items-center gap-ui-gap-sm pl-[calc(var(--ui-axis)+var(--ui-gap-sm))] text-ui-2xs text-ink-400">
          <TrendingUp className="h-ui-icon-sm w-ui-icon-sm" />
          纵向为时间轴（5 分钟刻度），点色块可改时间 / 归属或删除
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
            title: byId.get(editCourse.taskId)?.title || editCourse.title,
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
