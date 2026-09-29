/**
 * 按当地时间自动切换「当前任务」
 * -------------------------------------------------
 * 规则：处于某个**课程 / 定时任务时段**内 → 默认进入该时段归属的任务；
 * 时段结束后 → 回到进入时段前的那一次任务（「上一次的任务」）。
 *
 * - 每分钟对一次表；进入 / 离开时段才算变化，避免频繁写私库。
 * - 若用户在时段内手动切了任务，离开时段时不再粗暴回退（尊重手动选择）。
 * - 课程数据每 5 分钟重拉一次，新加的课最迟 5 分钟内生效。
 */
import { useEffect, useRef } from 'react'
import { loadCourses, timeToMinutes, type Course } from '../services/scheduleData'
import { useTaskStore } from '../stores/task'

const TICK_MS = 60_000
const RELOAD_COURSES_MS = 5 * 60_000

/** 今日星期（1..7），按本地时区 */
function todayWeekday(): number {
  const js = new Date().getDay()
  return js === 0 ? 7 : js
}

/** 当前时刻命中的时段任务 id；同刻重叠取「开始最早」的那个 */
function activeSlotTask(courses: Course[], weekday: number, min: number): string | null {
  let best: Course | null = null
  for (const c of courses) {
    if (c.weekday !== weekday || !c.taskId) continue
    const s = timeToMinutes(c.startTime)
    const e = timeToMinutes(c.endTime)
    if (e <= s || min < s || min >= e) continue
    if (!best || s < timeToMinutes(best.startTime)) best = c
  }
  return best?.taskId ?? null
}

export function useAutoTaskBySchedule(): void {
  const coursesRef = useRef<Course[]>([])
  const lastLoadRef = useRef(0)
  // 记录「当前自动切入的时段任务」与「切入前的那一次任务」，用于时段结束后回退
  const autoRef = useRef<{ slotTaskId: string | null; manualId: string | null }>({
    slotTaskId: null,
    manualId: null,
  })

  useEffect(() => {
    const reloadCourses = () => {
      lastLoadRef.current = Date.now()
      loadCourses()
        .then((cs) => {
          coursesRef.current = cs
        })
        .catch((err) => console.warn('[autoTask] 读取课程失败:', err))
    }

    const tick = () => {
      const { currentProjectId, setCurrentProject, isLoaded } = useTaskStore.getState()
      if (!isLoaded) return
      if (Date.now() - lastLoadRef.current > RELOAD_COURSES_MS) reloadCourses()

      const now = new Date()
      const slotTask = activeSlotTask(
        coursesRef.current,
        todayWeekday(),
        now.getHours() * 60 + now.getMinutes(),
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

    reloadCourses()
    tick()
    const timer = setInterval(tick, TICK_MS)
    return () => clearInterval(timer)
  }, [])
}