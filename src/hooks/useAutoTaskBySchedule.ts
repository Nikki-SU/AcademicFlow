/**
 * 按当地时间自动切换「当前任务」
 * -------------------------------------------------
 * 规则：处于某个**课程 / 定时任务时段**内 → 默认进入该时段归属的任务；
 * 时段结束后 → 回到进入时段前的那一次任务（「上一次的任务」）。
 *
 * 节假日感知（本轮新增）：
 * - **法定放假当天**一律不切课（那天不上课）；
 * - **调休补班日**按用户登记的「按周几的课表」切课；
 * - 普通周末默认无课（官方标为补班但用户未登记 → 不切，避免乱导）。
 * 判定见 services/scheduleData.ts 的 resolveToday()。
 *
 * - 每分钟对一次表；进入 / 离开时段才算变化，避免频繁写私库。
 * - 若用户在时段内手动切了任务，离开时段时不再粗暴回退（尊重手动选择）。
 * - 课程 / 调休 / 节假日每 5 分钟重拉一次，新加的课最迟 5 分钟内生效。
 */
import { useEffect, useRef } from 'react'
import { loadCourses, loadExtraDays, resolveToday, timeToMinutes, type Course, type ExtraDay } from '../services/scheduleData'
import { loadYearHolidays, todayDateStr, type HolidayMap } from '../services/holidays'
import { useTaskStore } from '../stores/task'

const TICK_MS = 60_000
const RELOAD_MS = 5 * 60_000

/**
 * 当前时刻命中的时段任务 id；同刻重叠取「开始最早」的那个。
 * 每周时段按 weekday 命中；单次时段只在它自己那一天命中（过了就不再出现）。
 */
function activeSlotTask(courses: Course[], weekday: number, min: number, today: string): string | null {
  let best: Course | null = null
  for (const c of courses) {
    if (!c.taskId) continue
    if (c.repeat === 'once') {
      if (c.date !== today) continue
    } else if (c.weekday !== weekday) {
      continue
    }
    const s = timeToMinutes(c.startTime)
    const e = timeToMinutes(c.endTime)
    if (e <= s || min < s || min >= e) continue
    if (!best || s < timeToMinutes(best.startTime)) best = c
  }
  return best?.taskId ?? null
}

export function useAutoTaskBySchedule(): void {
  const coursesRef = useRef<Course[]>([])
  const extraDaysRef = useRef<ExtraDay[]>([])
  const holidaysRef = useRef<HolidayMap>(new Map())
  const lastLoadRef = useRef(0)
  // 记录「当前自动切入的时段任务」与「切入前的那一次任务」，用于时段结束后回退
  const autoRef = useRef<{ slotTaskId: string | null; manualId: string | null }>({
    slotTaskId: null,
    manualId: null,
  })

  useEffect(() => {
    const reload = () => {
      lastLoadRef.current = Date.now()
      const year = new Date().getFullYear()
      loadCourses()
        .then((cs) => {
          coursesRef.current = cs
        })
        .catch((err) => console.warn('[autoTask] 读取课程失败:', err))
      loadExtraDays()
        .then((eds) => {
          extraDaysRef.current = eds
        })
        .catch((err) => console.warn('[autoTask] 读取调休日失败:', err))
      loadYearHolidays(year)
        .then((h) => {
          holidaysRef.current = h
        })
        .catch((err) => console.warn('[autoTask] 读取节假日失败:', err))
    }

    const tick = () => {
      const { currentProjectId, setCurrentProject, isLoaded } = useTaskStore.getState()
      if (!isLoaded) return
      if (Date.now() - lastLoadRef.current > RELOAD_MS) reload()

      const now = new Date()
      const today = todayDateStr()
      // 假期 → 不上课；调休 → 按指定周几；周末 → 无课（见 resolveToday）
      const plan = resolveToday(today, extraDaysRef.current, holidaysRef.current)
      // 每周时段只在「今天确实要上课」时命中；单次时段按自己的日期命中（考试可能就在周末）
      const slotTask = activeSlotTask(
        coursesRef.current,
        plan.weekday ?? 0,
        now.getHours() * 60 + now.getMinutes(),
        today,
      )
      const prev = autoRef.current
      if (slotTask === prev.slotTaskId) return

      if (slotTask) {
        // 进入时段：记住此刻的任务，切到课程 / 定时任务
        autoRef.current = { slotTaskId: slotTask, manualId: currentProjectId }
        if (currentProjectId !== slotTask) void setCurrentProject(slotTask)
      } else {
        // 离开时段：若仍停在被自动切入的任务上，回到之前的那一次任务
        if (prev.slotTaskId && currentProjectId === prev.slotTaskId && prev.manualId) {
          void setCurrentProject(prev.manualId)
        }
        autoRef.current = { slotTaskId: null, manualId: null }
      }
    }

    reload()
    tick()
    const timer = setInterval(tick, TICK_MS)
    return () => clearInterval(timer)
  }, [])
}