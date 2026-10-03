/**
 * 日程页数据服务
 * -------------------------------------------------
 * 日程页是跨项目的「总页面」，两张表都落 GitHub 私库（业务数据只准 md + csv）：
 * - schedule/courses.csv    — 课程表条目（每周固定时间，不因过期而归档）
 * - schedule/extra_days.csv — 调休日（把某个周末日期标为工作日）
 *
 * 写法对齐 projectData.ts 的 loadProjects/saveProjects：
 * 表头字符串必须与 src/constants/skeleton.ts 的 CSV_HEADERS 完全一致（顺序也一致）。
 */

import { readCsvFile, writeCsvFile, readMdFile, writeMdFile } from './userData'
import type { Project } from './projectData'

/**
 * 时段（课程表条目）
 * -------------------------------------------------
 * 一行 = 一个「每周固定时段」。时段本身不是任务，它**归属**一个任务：
 * - 课程：归属 type='course' 的任务（一门课一个任务，多个时段挂同一 taskId）
 * - 定时任务（如每周组会）：归属任意任务（可挂在「研究」大类下），时段即它的重复规则
 * 渲染时按 taskId 找到任务、按任务所在族的根色着色，课程表 / 任务列表 / DDL 全局同色。
 */
/** 时段重复方式：weekly=每周固定（课程 / 每周组会）；once=单次（考试等一次性事项，用 date 定位） */
export type RepeatMode = 'weekly' | 'once'

export interface Course {
  courseId: string
  /** 时段标题（展示以所属任务标题为准，此处保留一份冗余副本） */
  title: string
  /** 1..7（1=周一 … 7=周日）；单次时段由 date 推出，仍写一份保持一致 */
  weekday: number
  /** HH:MM */
  startTime: string
  /** HH:MM */
  endTime: string
  location: string
  createdAt: number
  /** 所属任务 id（课程任务 or 定时任务）；一律由迁移保证非空 */
  taskId: string
  /** 重复方式（迁移保证存在）：weekly / once */
  repeat: RepeatMode
  /** 单次时段的日期 YYYY-MM-DD；weekly 恒为空串 */
  date: string
}

/** 本地的今天，YYYY-MM-DD */
export function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 「离现在最近的某个星期几」对应的日期（YYYY-MM-DD）。
 * 含今天：今天正好是该周几就返回今天，否则返回本周（或下周）最近的那一天。
 */
export function nearestDateOfWeekday(weekday: number): string {
  const d = new Date()
  const todayWd = d.getDay() === 0 ? 7 : d.getDay()
  const delta = (((weekday - todayWd) % 7) + 7) % 7
  d.setDate(d.getDate() + delta)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** HH:MM → 当日分钟数（非法返回 0） */
export function timeToMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '')
  if (!m) return 0
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
}

/** 当日分钟数 → HH:MM（按 5 分钟取整，落回 0..1439） */
export function minutesToTime(min: number): string {
  const snapped = Math.max(0, Math.min(1439, Math.round(min / 5) * 5))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(snapped / 60))}:${p(snapped % 60)}`
}

/** 1..7 → 中文星期；越界返回空串 */
export const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const

/** 调休日：把某个周末日期标为工作日，并指定它按**周几的课表**上课 */
export interface ExtraDay {
  /** YYYY-MM-DD */
  date: string
  note: string
  /** 按周几的课表：0=未指定（当天不排课）；1..7=周一…周日 */
  followWeekday: number
}

const COURSES_PATH = 'schedule/courses.csv'
// ⚠️ 必须与 src/constants/skeleton.ts 的 CSV_HEADERS.courses 完全一致（顺序也一致）
//    task_id 为上一轮新增（时段归属的任务）；repeat / date 为本轮新增（单次定时任务），
//    一律追加末尾（守「新列一律追加末尾」）。
const COURSE_HEADERS = [
  'course_id', 'title', 'weekday', 'start_time', 'end_time', 'location', 'created_at', 'task_id',
  'repeat', 'date',
]

const EXTRA_DAYS_PATH = 'schedule/extra_days.csv'
// ⚠️ 必须与 src/constants/skeleton.ts 的 CSV_HEADERS.extra_days 完全一致（顺序也一致）
//    follow_weekday 为本轮新增（补班按周几的课表），追加末尾（守「新列一律追加末尾」）。
const EXTRA_DAY_HEADERS = ['date', 'note', 'follow_weekday']

/** 由 YYYY-MM-DD 求 weekday（1..7，1=周一 … 7=周日）；非法日期返回 0 */
export function weekdayOfDate(dateStr: string): number {
  // 补 T00:00:00 让日期按**本地时区**解析，避免被当成 UTC 后跨日错位
  const d = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(d.getTime())) return 0
  const js = d.getDay() // 0=周日 … 6=周六
  return js === 0 ? 7 : js
}


export async function loadCourses(force = false): Promise<Course[]> {
  return readCsvFile(
    COURSES_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      return rows.slice(1).map((r) => ({
        courseId: r[0] || '',
        title: r[1] || '',
        // weekday 由迁移（services/migrations.ts）保证落在 1..7，这里不做旧格式兜底
        weekday: parseInt(r[2], 10),
        startTime: r[3] || '',
        endTime: r[4] || '',
        location: r[5] || '',
        createdAt: parseInt(r[6] || '0', 10),
        taskId: r[7] || '',
        // repeat / date 列由迁移（services/migrations.ts）保证存在，这里不做旧格式兜底
        repeat: (r[8] as RepeatMode) || 'weekly',
        date: r[9] || '',
      }))
    },
    force,
  )
}

export async function saveCourses(courses: Course[]): Promise<void> {
  await writeCsvFile(
    COURSES_PATH,
    courses,
    COURSE_HEADERS,
    (c) => [
      c.courseId,
      c.title,
      String(c.weekday),
      c.startTime,
      c.endTime,
      c.location,
      String(c.createdAt),
      c.taskId || '',
      c.repeat || 'weekly',
      c.date || '',
    ],
  )
}

export async function loadExtraDays(force = false): Promise<ExtraDay[]> {
  return readCsvFile(
    EXTRA_DAYS_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      return rows.slice(1).map((r) => ({
        date: r[0] || '',
        note: r[1] || '',
        // follow_weekday 由迁移（services/migrations.ts）保证存在，这里不做旧格式兜底
        followWeekday: parseInt(r[2], 10),
      }))
    },
    force,
  )
}

export async function saveExtraDays(days: ExtraDay[]): Promise<void> {
  await writeCsvFile(
    EXTRA_DAYS_PATH,
    days,
    EXTRA_DAY_HEADERS,
    (d) => [d.date, d.note, String(d.followWeekday || 0)],
  )
}

/** 今天该怎么排课（由「日期 + 调休 + 节假日」共同决定） */
export interface TodayPlan {
  /** 生效的周几课表（1..7）；null = 今天不上课 */
  weekday: number | null
  /** 若今天法定放假，放假名（否则 null） */
  holiday: string | null
  /** 今天是否调休补班日 */
  makeup: boolean
  /** 官方标为补班、但用户还没在「调休」里指定按周几 → 需要提示去设置 */
  unsetMakeup: boolean
}

/**
 * 解析某一天的排课：**假期 → 不上课**；**调休补班 → 按用户指定的周几**；周末默认无课。
 * holidays 传空表即等价于「没有节假日数据」，退化为旧的「纯周几」行为。
 */
export function resolveToday(
  dateStr: string,
  extraDays: ExtraDay[],
  holidays: Map<string, { name: string; date: string; isOffDay: boolean }>,
): TodayPlan {
  const h = holidays.get(dateStr)
  // 法定放假：当天一律不上课（自动切课、今天高亮都要跳过）
  if (h && h.isOffDay) return { weekday: null, holiday: h.name, makeup: false, unsetMakeup: false }

  // 调休补班：以用户手动登记的调休日为准
  const ed = extraDays.find((d) => d.date === dateStr)
  if (ed) {
    if (ed.followWeekday >= 1 && ed.followWeekday <= 7) {
      return { weekday: ed.followWeekday, holiday: null, makeup: true, unsetMakeup: false }
    }
    return { weekday: null, holiday: null, makeup: true, unsetMakeup: true }
  }

  const wd = weekdayOfDate(dateStr)
  if (wd === 0) return { weekday: null, holiday: null, makeup: false, unsetMakeup: false }
  if (wd >= 6) {
    // 周末：官方若标为补班日 → 提示用户去「调休」指定按周几；否则默认无课
    const officialMakeup = !!h && !h.isOffDay
    return { weekday: null, holiday: null, makeup: officialMakeup, unsetMakeup: officialMakeup }
  }
  // 普通工作日：按当天真实周几
  return { weekday: wd, holiday: null, makeup: false, unsetMakeup: false }
}

// ═════════════════════════════════════════════════════════════════════
// 校历（学期开始 / 期末周开始 / 学期结束）
// -------------------------------------------------
// 用户要求：加一个校历 —— 这个学期什么时候开学、什么时候进入期末周、什么时候结束。
// 它是「课程的结束时间」的默认来源：一门课的结束时间 = 期末周第一天（可单门覆盖）。
// 落 `schedule/calendar.md`（业务数据只准 md + csv），与课程表同域，换设备即同步。
// ═════════════════════════════════════════════════════════════════════
export interface SchoolCalendar {
  /** YYYY-MM-DD，空串 = 未设 */
  semesterStart: string
  /** YYYY-MM-DD，空串 = 未设；课程的结束时间默认取它 */
  examWeekStart: string
  /** YYYY-MM-DD，空串 = 未设 */
  semesterEnd: string
}

export const EMPTY_CALENDAR: SchoolCalendar = {
  semesterStart: '',
  examWeekStart: '',
  semesterEnd: '',
}

const CALENDAR_PATH = 'schedule/calendar.md'

export async function loadCalendar(): Promise<SchoolCalendar> {
  const doc = await readMdFile(CALENDAR_PATH)
  const content = doc?.content || ''
  const out: SchoolCalendar = { ...EMPTY_CALENDAR }
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('- ')) continue
    const body = t.slice(2)
    const idx = body.indexOf(': ')
    if (idx < 0) continue
    const key = body.slice(0, idx).trim()
    const value = body.slice(idx + 2).trim()
    if (key === 'semester_start') out.semesterStart = value
    else if (key === 'exam_week_start') out.examWeekStart = value
    else if (key === 'semester_end') out.semesterEnd = value
  }
  return out
}

export async function saveCalendar(c: SchoolCalendar): Promise<void> {
  const body = [
    '- semester_start: ' + c.semesterStart,
    '- exam_week_start: ' + c.examWeekStart,
    '- semester_end: ' + c.semesterEnd,
  ].join('\n')
  const md = `# 校历\n\n${body}\n\n---\n`
  await writeMdFile(CALENDAR_PATH, md, 'Update school calendar')
}

/** YYYY-MM-DD → 本地时区当日 00:00（endOfDay= 当日 23:59）的 Unix ms；非法 / 空 → 0 */
export function msOfDate(dateStr: string, endOfDay = false): number {
  if (!dateStr) return 0
  const d = new Date(`${dateStr}T${endOfDay ? '23:59' : '00:00'}:00`)
  return Number.isNaN(d.getTime()) ? 0 : d.getTime()
}

/**
 * 一个任务的「有效结束时间」—— 判断它是不是 DDL 的唯一标准。
 * - 显式设了 `dueAt` → 就用它；
 * - 否则，如果是「课程」，默认取校历的**期末周第一天**（一门课上到期末周结束）；
 * - 其余 → 0（无结束时间，不是 DDL）。
 * 不落库、只用于展示与筛选，故改校历能立刻反映到所有课程。
 */
export function effectiveDueAt(p: Project, cal: SchoolCalendar): number {
  if (p.dueAt > 0) return p.dueAt
  if (p.type === 'course' && cal.examWeekStart) return msOfDate(cal.examWeekStart, true)
  return 0
}
