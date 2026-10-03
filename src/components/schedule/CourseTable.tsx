/**
 * 课程表（左栏 · 竖排时间轴）
 * -------------------------------------------------
 * 布局：**一天一列**（周一…周五，周末有课时才出现），纵向是时间轴。
 * - 时间按 5 分钟刻度对齐：同一时刻在不同列里落在同一 y 位置，一眼对上。
 * - 课块文案**完整显示**：列宽就是课块可用的横向空间（不再按课程时长把方块压窄），
 *   长名字直接折行，不需要点开才看得到。
 * - 同一时段重叠的课块自动**并排分列**，不会互相盖住。
 * - 每块按时段所属任务的**根色**着色（课程表 / 任务列表 / DDL 全局同色）。
 * - **一周视图**：表头每天**先日期、后星期**（周一到周日，周末有课 / 调休才出现）。
 * - **DDL 死线**：有截止时间的任务，只在**它到期的那一天**（本周这一天）对应列画一条
 *   **红色粗线**（不再按「周几」每周重画）；默认不写任何文字（不挡课）；悬停或点击才
 *   浮出任务名 + 时间，并让 DDL 清单 / 任务栏里对应条目**亮起**（联动由 Schedule.tsx 的 highlightId 统一驱动）。
 * - 点块 = 编辑（改时间 / 地点 /（定时任务）归属任务，或删除）。
 * 尺寸全部走 index.css 的 --ui-* 流体口径（时间轴列宽 --ui-axis、列高 --ui-lane、
 * 字号 --ui-text-*），不再有任何写死的像素值。
 * 数据落库全交给页面（Schedule.tsx），本组件只呈现与收集输入。
 */
import { useMemo, useState } from 'react'
import { CalendarPlus, CalendarX, Clock, Repeat, TrendingUp, X } from 'lucide-react'
import type { Course, ExtraDay, TodayPlan } from '../../services/scheduleData'
import { timeToMinutes, weekdayOfDate, WEEKDAY_LABELS } from '../../services/scheduleData'
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

/** Unix ms → 当天分钟数（0..1439）；0 / 非法 → -1 */
function minutesOfDay(ts: number): number {
  if (!ts) return -1
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return -1
  return d.getHours() * 60 + d.getMinutes()
}

/** Unix ms → YYYY-MM-DD HH:MM */
function formatDue(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
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
  todayPlan,
  ddls,
  highlightId,
  onHighlight,
  onPickDdl,
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
  todayPlan: TodayPlan
  /** 有截止时间的任务（DDL）——在课表对应周几 / 时刻画红线 */
  ddls: Project[]
  /** 当前亮起的 DDL 任务 id（课表红线 / DDL 清单 / 任务栏联动） */
  highlightId: string | null
  /** 悬停红线：置亮 / 清除 */
  onHighlight: (id: string | null) => void
  /** 点击红线：钉住（再次点击取消） */
  onPickDdl: (id: string) => void
  onCreateSlot: (variant: 'course' | 'timed', value: SlotFormValue) => void
  onUpdateSlot: (courseId: string, value: SlotFormValue, all: boolean) => void
  onDeleteCourse: (courseId: string) => void
  onAddExtraDay: (date: string, note: string, followWeekday: number) => void
  onDeleteExtraDay: (date: string) => void
}) {
  const [form, setForm] = useState<
    | { mode: 'create'; variant: 'course' | 'timed' }
    | { mode: 'edit'; courseId: string; all: boolean }
    | null
  >(null)
  const [showExtra, setShowExtra] = useState(false)

  // ---------- 本周日期：表头「先日期、后星期」，死线也按本周这一天来画 ----------
  // 课表是一周视图（周一到周日），所以要先把本周每一天的**日期**算出来。
  const todayDate = useMemo(() => {
    const n = new Date()
    return new Date(n.getFullYear(), n.getMonth(), n.getDate())
  }, [])
  const weekDates = useMemo(() => {
    const wd = todayDate.getDay() === 0 ? 7 : todayDate.getDay()
    const monday = new Date(todayDate)
    monday.setDate(todayDate.getDate() - (wd - 1))
    const map = new Map<number, Date>()
    for (let w = 1; w <= 7; w++) {
      const d = new Date(monday)
      d.setDate(monday.getDate() + (w - 1))
      map.set(w, d)
    }
    return map
  }, [todayDate])
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

  // 只有**落在本周**的 DDL 才进课表：死线不再按「周几」每周重画，只在到期那天出现
  const weekDdls = useMemo(() => {
    const mon = weekDates.get(1)!
    const sun = weekDates.get(7)!
    const start = mon.getTime()
    const end = new Date(sun.getFullYear(), sun.getMonth(), sun.getDate(), 23, 59, 59, 999).getTime()
    return ddls.filter((p) => p.dueAt >= start && p.dueAt <= end)
  }, [ddls, weekDates])

  // ---------- 时间轴范围：按数据算出，向整点取整，至少 5 小时 ----------
  // DDL 的时刻也计入范围，否则落在课表时间窗外的死线红线看不到。
  const { rangeStart, rangeEnd } = useMemo(() => {
    const mins: number[] = []
    for (const c of courses) {
      const s = timeToMinutes(c.startTime)
      const e = timeToMinutes(c.endTime)
      if (e > 0) mins.push(s, e)
    }
    for (const p of weekDdls) {
      const m = minutesOfDay(p.dueAt)
      if (m >= 0) mins.push(m)
    }
    if (mins.length === 0) return { rangeStart: 8 * 60, rangeEnd: 18 * 60 }
    const start = Math.floor(Math.min(...mins) / 60) * 60
    let end = Math.ceil(Math.max(...mins) / 60) * 60
    if (end - start < 300) end = start + 300
    return { rangeStart: start, rangeEnd: end }
  }, [courses, weekDdls])

  const hourTicks = useMemo(() => {
    const ticks: number[] = []
    for (let m = rangeStart; m <= rangeEnd; m += 60) ticks.push(m)
    return ticks
  }, [rangeStart, rangeEnd])

  // ---------- 要显示的天：周一~周五恒显；周末有课 / 有调休才出现 ----------
  const days = useMemo(() => {
    const active = new Set<number>()
    for (const c of courses) {
      if (c.repeat === 'once') {
        // 单次只落在它那一天：只有正好在本周才占一列
        if (!c.date) continue
        const wd = weekdayOfDate(c.date)
        const col = weekDates.get(wd)
        if (col && isSameDay(new Date(`${c.date}T00:00:00`), col)) active.add(wd)
      } else if (c.weekday >= 1 && c.weekday <= 7) {
        active.add(c.weekday)
      }
    }
    // 调休按它「指定的周几」占列（补周六可能上的是周三的课）
    for (const d of extraDays) if (d.followWeekday >= 1 && d.followWeekday <= 7) active.add(d.followWeekday)
    const list = [1, 2, 3, 4, 5]
    for (const w of [6, 7]) if (active.has(w)) list.push(w)
    return list
  }, [courses, extraDays, weekDates])

  // 某一天（周几）要排的课：每周时段按 weekday 归列；单次时段只归到它日期所在的那一列
  const coursesOf = (weekday: number) => {
    const col = weekDates.get(weekday)
    return courses.filter((c) => {
      if (c.repeat === 'once') {
        return !!c.date && !!col && isSameDay(new Date(`${c.date}T00:00:00`), col)
      }
      return c.weekday === weekday
    })
  }

  // 某一天（周几）要画的 DDL 红线：只画**到期日正好是这一列日期**的那几条
  const ddlsOf = (weekday: number) => {
    const col = weekDates.get(weekday)
    if (!col) return []
    return weekDdls
      .map((p) => ({ project: p, min: minutesOfDay(p.dueAt), d: new Date(p.dueAt) }))
      .filter((x) => isSameDay(x.d, col) && x.min >= rangeStart && x.min <= rangeEnd)
  }

  // 今天生效的周几（假期 / 周末为 null → 不高亮任何列）；见 scheduleData.resolveToday
  const today = todayPlan.weekday
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
  const showNow = nowMin >= rangeStart && nowMin <= rangeEnd

  const editCourse =
    form?.mode === 'edit' ? courses.find((c) => c.courseId === form.courseId) ?? null : null
  // 同一任务（课程 / 定时任务）的全部时段 —— 「整门课一起编辑」时用
  const editSiblings = editCourse ? courses.filter((c) => c.taskId === editCourse.taskId) : []

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
            onClick={() => setForm({ mode: 'create', variant: 'course' })}
            className="flex items-center gap-ui-gap-sm rounded bg-seal-600 px-ui-gap-sm py-ui-gap-sm text-ui-xs font-medium text-paper-50 transition hover:bg-seal-700"
          >
            <CalendarPlus className="h-ui-icon-sm w-ui-icon-sm" />
            加课
          </button>
          <button
            onClick={() => setForm({ mode: 'create', variant: 'timed' })}
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

      {/* 今日状态条：放假 / 调休补班 / 补班待指定 */}
      {todayPlan.holiday && (
        <div className="flex items-center gap-ui-gap-sm border-b border-ink-100 bg-seal-50 px-ui-gap py-ui-gap-sm text-ui-xs text-seal-700">
          <CalendarX className="h-ui-icon-sm w-ui-icon-sm" />
          今天「{todayPlan.holiday}」放假 · 不上课，课程表不排课
        </div>
      )}
      {!todayPlan.holiday && todayPlan.makeup && !todayPlan.unsetMakeup && todayPlan.weekday && (
        <div className="flex items-center gap-ui-gap-sm border-b border-ink-100 bg-amber-50 px-ui-gap py-ui-gap-sm text-ui-xs text-amber-700">
          <Repeat className="h-ui-icon-sm w-ui-icon-sm" />
          今天调休补班 · 按「{WEEKDAY_LABELS[todayPlan.weekday]}」的课表上课
        </div>
      )}
      {!todayPlan.holiday && todayPlan.unsetMakeup && (
        <div className="flex items-center gap-ui-gap-sm border-b border-ink-100 bg-amber-50 px-ui-gap py-ui-gap-sm text-ui-xs text-amber-700">
          <Repeat className="h-ui-icon-sm w-ui-icon-sm" />
          今天是官方调休补班日，但还没指定按周几上课 · 点右上「调休」设置
        </div>
      )}

      {extraDays.length > 0 && (
        <div className="flex flex-wrap gap-ui-gap-sm border-b border-ink-100 px-ui-gap py-ui-gap-sm">
          {extraDays.map((d) => (
            <span
              key={d.date}
              className="inline-flex items-center gap-ui-gap-sm rounded-full bg-seal-100 px-ui-gap-sm py-0.5 text-ui-xs text-seal-700"
            >
              {d.date}
              {d.followWeekday >= 1 && d.followWeekday <= 7
                ? ` · 按${WEEKDAY_LABELS[d.followWeekday]}`
                : ''}
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
        {/* 表头：日期 + 星期（与下方时间轴网格严格对齐） */}
        <div className="flex gap-ui-gap-sm">
          <div className="w-ui-axis shrink-0" />
          <div className="grid flex-1 gap-ui-gap-sm" style={{ gridTemplateColumns: dayCols }}>
            {days.map((w) => {
              const d = weekDates.get(w)
              const isTodayCol = !!d && isSameDay(d, todayDate)
              return (
                <div
                  key={w}
                  className={`rounded-md py-1 text-center font-mono text-ui-xs leading-tight ${
                    isTodayCol
                      ? 'bg-seal-600 font-semibold text-paper-50 shadow-card'
                      : 'text-ink-500'
                  }`}
                >
                  {/* 先日期、后星期：一眼知道这一列是哪一天 */}
                  <div className="text-ui-2xs opacity-80">
                    {d ? `${d.getMonth() + 1}/${d.getDate()}` : ''}
                  </div>
                  <div>{WEEKDAY_LABELS[w]}</div>
                </div>
              )
            })}
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
                    isToday
                      ? 'border-seal-300 bg-seal-50 ring-1 ring-inset ring-seal-200'
                      : 'border-ink-100 bg-paper-100'
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
                      className="absolute inset-x-0 z-20 border-t-2 border-hl-red"
                      style={{ top: `${pct(nowMin, rangeStart, rangeEnd)}%` }}
                    />
                  )}
                  {/* 时段块：文案完整折行显示，不截断 */}
                  {placed.map(({ course: c, top, height, left, width }) => {
                    const color = colorForRoot(slotRootId(c, byId))
                    const isCurrent = !!c.taskId && c.taskId === currentId
                    const label = byId.get(c.taskId)?.title || c.title || '(未命名)'
                    const once = c.repeat === 'once'
                    return (
                      <button
                        key={c.courseId}
                        onClick={() => setForm({ mode: 'edit', courseId: c.courseId, all: false })}
                        title={`${label}${once ? `（单次 · ${c.date}）` : ''}  ${c.startTime}–${c.endTime}${
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
                          {once && (
                            <span className="mr-1 rounded bg-paper-50/25 px-1 text-ui-2xs font-normal">
                              单次
                            </span>
                          )}
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
                  {placed.length === 0 && ddlsOf(w).length === 0 && (
                    <span className="absolute inset-0 flex items-center justify-center text-ui-2xs text-ink-300">
                      无课
                    </span>
                  )}
                  {/* DDL 死线：统一红色粗线，默认不写字（不挡课）；悬停 / 点击显示内容并联动高亮 */}
                  {ddlsOf(w).map(({ project: dp, min }) => {
                    const active = highlightId === dp.projectId
                    const top = pct(min, rangeStart, rangeEnd)
                    const label = dp.title || '(未命名任务)'
                    return (
                      <div
                        key={dp.projectId}
                        className="absolute inset-x-0 z-30"
                        style={{ top: `${top}%` }}
                      >
                        <button
                          type="button"
                          onMouseEnter={() => onHighlight(dp.projectId)}
                          onMouseLeave={() => onHighlight(null)}
                          onClick={() => onPickDdl(dp.projectId)}
                          title={`DDL · ${label} · ${formatDue(dp.dueAt)}`}
                          aria-label={`DDL ${label} ${formatDue(dp.dueAt)}`}
                          className="absolute inset-x-0 flex h-3 -translate-y-1/2 items-center"
                        >
                          <span
                            className={`h-[3px] w-full rounded-full bg-hl-red-deep transition ${
                              active
                                ? 'shadow-[0_0_0_2px_rgba(158,58,50,0.30)]'
                                : 'opacity-80 hover:opacity-100'
                            }`}
                          />
                        </button>
                        {active && (
                          <div
                            className={`absolute z-40 w-max max-w-full rounded border border-hl-red bg-paper-50 px-1.5 py-1 text-ui-2xs shadow-lg ${
                              top > 80 ? 'bottom-1.5' : 'top-1.5'
                            }`}
                          >
                            <div className="truncate font-medium text-hl-red-deep">{label}</div>
                            <div className="whitespace-nowrap text-ink-500">
                              {formatDue(dp.dueAt)}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>

        <div className="mt-ui-gap flex items-center gap-ui-gap-sm pl-[calc(var(--ui-axis)+var(--ui-gap-sm))] text-ui-2xs text-ink-400">
          <TrendingUp className="h-ui-icon-sm w-ui-icon-sm" />
          纵向为时间轴（5 分钟刻度），点色块可改时间 / 归属或删除；
          <span className="mx-0.5 inline-block h-[3px] w-4 rounded-full bg-hl-red-deep align-middle" />
          = DDL 死线（默认不写字，悬停 / 点击看详情并联动高亮）
        </div>
      </div>

      {/* 新增时段（加课 / 加定时任务，均可一次加多个时段） */}
      {form?.mode === 'create' && (
        <CourseFormModal
          variant={form.variant}
          projects={projects}
          onClose={() => setForm(null)}
          onSubmit={(value) => {
            onCreateSlot(form.variant, value)
            setForm(null)
          }}
        />
      )}

      {/* 编辑 / 删除已有时段（可选「整门课一起编辑」）*/}
      {form?.mode === 'edit' && editCourse && (
        <CourseFormModal
          key={form.all ? 'all' : 'one'}
          variant="edit"
          projects={projects}
          lockTask={isCourseSlot(editCourse, byId)}
          editScope={{
            canToggle: editSiblings.length > 1,
            all: form.all,
            onToggle: (all) => setForm((f) => (f?.mode === 'edit' ? { ...f, all } : f)),
          }}
          initial={{
            title: byId.get(editCourse.taskId)?.title || editCourse.title,
            taskId: editCourse.taskId,
            repeat: editCourse.repeat,
            slots: (form.all ? editSiblings : [editCourse]).map((c) => ({
              weekday: c.weekday,
              startTime: snapTime(c.startTime),
              endTime: snapTime(c.endTime),
              location: c.location,
              date: c.date,
            })),
          }}
          onClose={() => setForm(null)}
          onSubmit={(value) => {
            onUpdateSlot(editCourse.courseId, value, form.all)
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
          onSubmit={(date, note, followWeekday) => {
            onAddExtraDay(date, note, followWeekday)
            setShowExtra(false)
          }}
        />
      )}
    </section>
  )
}
