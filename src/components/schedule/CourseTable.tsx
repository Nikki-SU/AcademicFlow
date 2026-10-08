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
 * - **调休日**：那一天对应的列**直接上「被跟随周几」的课表**（如 10 号补上周三的课），
 *   表头只点一句「按周三」并可在此移除 —— 不用另贴一条文字条目让人自己脑补。
 * - **期末周起**：不再展示这门课的「每周课块」（课已上完），但考试等**单次**事项照常显示
 *   —— 期末周只是课表上不排这门课，任务本身并没过期（过期见校历放假 / 子树最晚子 DDL）。
 * - **DDL 死线**：进了右栏 DDL 的任务（非周期任务、且在一个月内），只在**它到期的那一天**（本周这一天）对应列画一条
 *   **红色粗线**（不再按「周几」每周重画）；默认不写任何文字（不挡课）；悬停或点击才
 *   浮出任务名 + 时间，并让 DDL 清单 / 任务栏里对应条目**亮起**（联动由 Schedule.tsx 的 highlightId 统一驱动）。
 * - 点块 = 编辑（改时间 / 地点 /（定时任务）归属任务，或删除）。
 * 尺寸全部走 index.css 的 --ui-* 流体口径（时间轴列宽 --ui-axis、列高 --ui-lane、
 * 字号 --ui-text-*），不再有任何写死的像素值。
 * 数据落库全交给页面（Schedule.tsx），本组件只呈现与收集输入。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, CalendarPlus, Clock, X } from 'lucide-react'
import type { Course, ExtraDay, SchoolCalendar, TodayPlan } from '../../services/scheduleData'
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

/** Date → 本地 YYYY-MM-DD（用于和调休记录的 date 对齐） */
function dateKeyOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
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
  examWeekStartMs,
  calendar,
  savingCalendar,
  onChangeCalendar,
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
  /** 需要交付的 DDL 任务（= 右栏 DDL 那份已筛好的清单）——在课表对应日期画红线 */
  ddls: Project[]
  /** 校历「期末周开始」当天 00:00 的 Unix ms；0 = 未设。期末周起隐藏每周课块（单次照常） */
  examWeekStartMs: number
  /** 校历（开学日 / 期末周开始 / 学期结束）：课程表的一部分，就地可改 */
  calendar: SchoolCalendar
  /** 校历正在保存（改一项即存） */
  savingCalendar: boolean
  onChangeCalendar: (patch: Partial<SchoolCalendar>) => void
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
  // 校历浮层：点「调休」右边的「校历」按钮才展开，不在页面里常驻暴露
  const [showCalendar, setShowCalendar] = useState(false)
  const calendarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (calendarRef.current && !calendarRef.current.contains(e.target as Node)) {
        setShowCalendar(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

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

  // 期末周起，「每周课块」不再展示（这门课已不用再上）；考试等「单次」事项照常显示。
  const hiddenByExamWeek = (col: Date | undefined) =>
    !!col && examWeekStartMs > 0 && col.getTime() >= examWeekStartMs

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
      // 期末周起已隐藏的每周课块不参与时间轴范围，避免为「看不见的课」留出空白
      if (c.repeat !== 'once' && hiddenByExamWeek(weekDates.get(c.weekday))) continue
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
  }, [courses, weekDdls, weekDates, examWeekStartMs])

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
        // 期末周起该列不再排每周课，也就不必为一个「空列」把周末撑出来
        if (hiddenByExamWeek(weekDates.get(c.weekday))) continue
        active.add(c.weekday)
      }
    }
    // 调休日：按它**自己日期所在的那一列**占位（补班的往往是某个周六/周日，
    // 那一列要出现并改上「被跟随周几」的课），而不是加一列「被跟随的周几」
    for (const d of extraDays) {
      const wd = weekdayOfDate(d.date)
      const col = weekDates.get(wd)
      if (col && isSameDay(new Date(`${d.date}T00:00:00`), col)) active.add(wd)
    }
    const list = [1, 2, 3, 4, 5]
    for (const w of [6, 7]) if (active.has(w)) list.push(w)
    return list
  }, [courses, extraDays, weekDates, examWeekStartMs])

  // 调休日：日期 → 记录。某一列若是调休日，就改上「被跟随周几」的课表
  const extraByDate = useMemo(() => new Map(extraDays.map((d) => [d.date, d])), [extraDays])

  // 某一列要排的课：每周时段按 weekday 归列；单次时段只归到它日期所在的那一列。
  // 若这一列是**调休日**，直接改用「被跟随周几」的课表（如 10 号补上周三的课）——
  // 让课表**自己**就是那一天实际上课的样子，而不是另贴一条文字提示。
  const coursesOf = (weekday: number) => {
    const col = weekDates.get(weekday)
    const ed = col ? extraByDate.get(dateKeyOf(col)) : undefined
    const effWeekday = ed ? ed.followWeekday : weekday
    const hideWeekly = hiddenByExamWeek(col)
    return courses.filter((c) => {
      if (c.repeat === 'once') {
        return !!c.date && !!col && isSameDay(new Date(`${c.date}T00:00:00`), col)
      }
      // 期末周起不再展示每周课块；考试等单次事项走上面的分支，照常显示
      if (hideWeekly) return false
      return effWeekday >= 1 && effWeekday <= 7 && c.weekday === effWeekday
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

  // 今天是否真排课（假期 / 无课周末 = null）；「高亮哪一列」一律按**日期**判断，
  // 这样调休日高亮的是「那一天」那一列（而不是它被跟随的周几）——见下方 isToday。
  const classesOnToday = todayPlan.weekday !== null
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
  const showNow = nowMin >= rangeStart && nowMin <= rangeEnd

  const editCourse =
    form?.mode === 'edit' ? courses.find((c) => c.courseId === form.courseId) ?? null : null
  // 同一任务（课程 / 定时任务）的全部时段 —— 「整门课一起编辑」时用
  const editSiblings = editCourse ? courses.filter((c) => c.taskId === editCourse.taskId) : []

  // 天列栅格：列数随「显示几天」变化，所以用内联 style（动态 repeat）
  const dayCols = `repeat(${days.length}, minmax(0, 1fr))`

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-card border border-ink-200 bg-paper-50">
      <div className="af-line-b flex items-center justify-between gap-ui-gap px-ui-gap py-ui-gap-sm">
        <h2 className="flex items-center gap-ui-gap-sm text-ui-sm font-semibold text-ink-800">
          <Clock className="h-ui-icon w-ui-icon text-seal-600" />
          课程表
        </h2>
        <div className="flex items-center gap-ui-gap-sm">
          <button
            onClick={() => setForm({ mode: 'create', variant: 'course' })}
            className="flex items-center gap-ui-gap-sm rounded-control-sm bg-seal-600 px-ui-gap-sm py-ui-gap-sm text-ui-xs font-medium text-paper-50 transition hover:bg-seal-700"
          >
            <CalendarPlus className="h-ui-icon-sm w-ui-icon-sm" />
            加课
          </button>
          <button
            onClick={() => setForm({ mode: 'create', variant: 'timed' })}
            className="rounded-control-sm border border-ink-200 px-ui-gap-sm py-ui-gap-sm text-ui-xs text-ink-600 transition hover:border-seal-300 hover:text-seal-600"
            title="把组会等定时任务加进课表"
          >
            定时任务
          </button>
          <button
            onClick={() => setShowExtra(true)}
            className="rounded-control-sm border border-ink-200 px-ui-gap-sm py-ui-gap-sm text-ui-xs text-ink-500 transition hover:border-seal-300 hover:text-seal-600"
          >
            调休
          </button>
          {/* 校历：课程表的一部分 —— 不在页面里常驻暴露，点此按钮才展开浮层就地编辑 */}
          <div className="relative" ref={calendarRef}>
            <button
              onClick={() => setShowCalendar((v) => !v)}
              className="flex items-center gap-ui-gap-sm rounded-control-sm border border-ink-200 px-ui-gap-sm py-ui-gap-sm text-ui-xs text-ink-500 transition hover:border-seal-300 hover:text-seal-600"
              title="校历：开学 / 期末周 / 放假"
            >
              <CalendarDays className="h-ui-icon-sm w-ui-icon-sm" />
              校历
            </button>
            {showCalendar && (
              <div className="absolute right-0 top-full z-30 mt-1 w-56 rounded-control border border-ink-200 bg-paper-50 p-ui-gap-sm shadow-lg">
                {(
                  [
                    { key: 'semesterStart' as const, label: '开学' },
                    { key: 'examWeekStart' as const, label: '期末周' },
                    { key: 'semesterEnd' as const, label: '放假' },
                  ]
                ).map(({ key, label }) => (
                  <label key={key} className="flex items-center justify-between gap-ui-gap-sm py-1 text-ui-xs text-ink-500">
                    {label}
                    <input
                      type="date"
                      value={calendar[key]}
                      onChange={(e) => onChangeCalendar({ [key]: e.target.value })}
                      className="rounded-control-sm border border-ink-200 bg-paper-50 px-ui-gap-sm py-0.5 font-mono text-ui-2xs text-ink-700 focus:outline-none focus:ring-2 focus:ring-seal-500"
                    />
                  </label>
                ))}
                {savingCalendar && <div className="pt-1 text-ui-2xs text-ink-400">保存中…</div>}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-ui-gap">
        {/* 表头：日期 + 星期（与下方时间轴网格严格对齐） */}
        <div className="flex gap-ui-gap-sm">
          <div className="w-ui-axis shrink-0" />
          <div className="grid flex-1 gap-ui-gap-sm" style={{ gridTemplateColumns: dayCols }}>
            {days.map((w) => {
              const d = weekDates.get(w)
              const isTodayCol = !!d && isSameDay(d, todayDate)
              // 这一列是不是调休日？是的话点明「按周几」，并可在此移除
              const ed = d ? extraByDate.get(dateKeyOf(d)) : undefined
              const follow = ed && ed.followWeekday >= 1 && ed.followWeekday <= 7 ? ed.followWeekday : 0
              return (
                <div
                  key={w}
                  className={`rounded-control-sm py-1 text-center font-mono text-ui-xs leading-tight ${
                    isTodayCol
                      ? 'bg-seal-600 font-semibold text-paper-50 shadow-card'
                      : ed
                        ? 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200'
                        : 'text-ink-500'
                  }`}
                >
                  {/* 先日期、后星期：一眼知道这一列是哪一天 */}
                  <div className="text-ui-2xs opacity-80">
                    {d ? `${d.getMonth() + 1}/${d.getDate()}` : ''}
                  </div>
                  {ed ? (
                    // 调休日：这一列上的课就是「被跟随周几」的课，表头只点一句（可点 × 移除）
                    <div className="flex items-center justify-center gap-0.5">
                      <span>{follow ? `按${WEEKDAY_LABELS[follow]}` : '调休'}</span>
                      <button
                        onClick={() => onDeleteExtraDay(ed.date)}
                        title="移除该调休日"
                        aria-label={`移除调休日 ${ed.date}`}
                        className="opacity-60 transition hover:opacity-100"
                      >
                        <X className="h-ui-icon-sm w-ui-icon-sm" />
                      </button>
                    </div>
                  ) : (
                    <div>{WEEKDAY_LABELS[w]}</div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* 主体：左=时间刻度，右=每天一列；高度撑满剩余空间，不再叠一个独立视口比例 */}
        <div className="mt-ui-gap-sm flex min-h-0 flex-1 gap-ui-gap-sm">
          <div className="relative w-ui-axis shrink-0">
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

          <div className="grid h-full flex-1 grid-rows-1 gap-ui-gap-sm" style={{ gridTemplateColumns: dayCols }}>
            {days.map((w) => {
              const placed = layoutLane(coursesOf(w), rangeStart, rangeEnd)
              const colDate = weekDates.get(w)
              // 高亮「今天」按日期判断：调休日高亮的就是那一天那一列（而非它被跟随的周几）
              const isToday = !!colDate && isSameDay(colDate, todayDate)
              return (
                <div
                  key={w}
                  className={`relative overflow-hidden rounded-control-sm border ${
                    isToday
                      ? 'border-seal-300 bg-seal-50 ring-1 ring-inset ring-seal-200'
                      : 'border-ink-100 bg-paper-100'
                  }`}
                >
                  {/* 整点网格线 */}
                  {hourTicks.map((m) => (
                    <span
                      key={m}
                      className="absolute inset-x-0 border-t border-ink-100"
                      style={{ top: `${pct(m, rangeStart, rangeEnd)}%` }}
                    />
                  ))}
                  {/* 当前时刻指示（只在真正排课的今天画；假期 / 无课周末不画） */}
                  {isToday && classesOnToday && showNow && (
                    <span
                      className="absolute inset-x-0 z-20 border-t-2 border-hl-blue"
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
                        className={`absolute z-10 flex flex-col items-start overflow-hidden rounded-control-sm px-ui-gap-sm py-0.5 text-left ${color.bg} ${
                          isCurrent ? 'ring-2 ring-ink-800' : ''
                        }`}
                      >
                        <span className="w-full text-ui-xs font-medium leading-tight text-paper-50 [overflow-wrap:anywhere]">
                          {once && (
                            <span className="mr-1 rounded-control-sm bg-paper-50/25 px-1 text-ui-2xs font-normal">
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
                  {/* DDL 死线：统一红色粗线，线上直接标「死线」；悬停 / 点击显示内容并联动高亮 */}
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
                          className="absolute inset-x-0 flex h-3 -translate-y-1/2 items-center gap-1"
                        >
                          <span
                            className={`h-[0.21vw] flex-1 rounded-full bg-hl-red-deep transition ${
                              active
                                ? 'shadow-[0_0_0_0.14vw_rgba(158,58,50,0.30)]'
                                : 'opacity-80 hover:opacity-100'
                            }`}
                          />
                          <span className="shrink-0 font-mono text-ui-2xs font-medium leading-none text-hl-red-deep">
                            死线
                          </span>
                        </button>
                        {active && (
                          <div
                            className={`absolute z-40 w-max max-w-full rounded-control-sm border border-hl-red bg-paper-50 px-1.5 py-1 text-ui-2xs shadow-lg ${
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
