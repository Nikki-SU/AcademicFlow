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

import { readCsvFile, writeCsvFile } from './userData'

/** 课程表条目 */
export interface Course {
  courseId: string
  title: string
  /** 1..7（1=周一 … 7=周日） */
  weekday: number
  /** HH:MM */
  startTime: string
  /** HH:MM */
  endTime: string
  location: string
  createdAt: number
}

/** 调休日：把某个周末日期标为工作日 */
export interface ExtraDay {
  /** YYYY-MM-DD */
  date: string
  note: string
}

const COURSES_PATH = 'schedule/courses.csv'
// ⚠️ 必须与 src/constants/skeleton.ts 的 CSV_HEADERS.courses 完全一致（顺序也一致）
const COURSE_HEADERS = [
  'course_id', 'title', 'weekday', 'start_time', 'end_time', 'location', 'created_at',
]

const EXTRA_DAYS_PATH = 'schedule/extra_days.csv'
// ⚠️ 必须与 src/constants/skeleton.ts 的 CSV_HEADERS.extra_days 完全一致（顺序也一致）
const EXTRA_DAY_HEADERS = ['date', 'note']

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
        // 老数据 / 手改文件里 weekday 非法时兜底为 1，避免整列消失
        weekday: parseInt(r[2] || '1', 10) || 1,
        startTime: r[3] || '',
        endTime: r[4] || '',
        location: r[5] || '',
        createdAt: parseInt(r[6] || '0', 10),
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
    (d) => [d.date, d.note],
  )
}
