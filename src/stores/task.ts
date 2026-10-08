/**
 * 任务全局状态（「当前任务」）
 * -------------------------------------------------
 * 「当前任务」= 我现在在干哪个任务。写作 / 阅读 / 会议页共用同一个它，
 * 不再各自为政（见 架构.md §2.2.1 / ADJ-32~35）。
 *
 * 存储：私库 `settings/current-task.md`（**跨设备同步**，Rosa 拍板），
 * 不走本机 localStorage —— 换设备打开就是同一个任务。读写见 projectData。
 */
import { create } from 'zustand'
import { loadCurrentTaskId, saveCurrentTaskId } from '../services/projectData'

interface TaskState {
  /** 当前任务 id；null = 未选 */
  currentProjectId: string | null
  /** 是否已从私库拉取过（避免重复拉取） */
  isLoaded: boolean
  /** 已发起过拉取（正常 / 失败都算），用于防止并发重复请求 */
  isLoading: boolean
  /** 已自动重试次数（读取成功即清零） */
  retryCount: number
  /** 从私库拉取当前任务（工作区就绪后调用一次） */
  loadCurrent: () => Promise<void>
  /** 切换当前任务：先更新本地状态，再持久化到私库（返回持久化的 Promise） */
  setCurrentProject: (projectId: string | null) => Promise<void>
  reset: () => void
}

/**
 * 读取失败后的自动重试：
 * - 前 3 次：间隔 4s（快速重试，扛偶发抖动）
 * - 之后：每分钟兜底重试（网络恢复后能自愈）
 * 全程不把「读失败」谎报成「未选任务」——`isLoaded` 留 false，UI 如实显示「加载中」。
 */
const RETRY_MS = 4000
const MAX_RETRY = 3
const RELOAD_MS = 60000

/** 单例重试定时器：避免多个调用方（App 启动 / 各页挂载）各排一个定时器、重复叠加 */
let retryTimer: ReturnType<typeof setTimeout> | null = null

function scheduleRetry(delay: number) {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    retryTimer = null
    void useTaskStore.getState().loadCurrent()
  }, delay)
}

function clearRetry() {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

export const useTaskStore = create<TaskState>((set, get) => ({
  currentProjectId: null,
  isLoaded: false,
  isLoading: false,
  retryCount: 0,

  loadCurrent: async () => {
    // 只挡并发重复请求；不再「一辈子只拉一次」——
    // 每次打开网页 / 各页挂载都会重新拉取，保证跨设备改动即时可见。
    if (get().isLoading) return
    set({ isLoading: true })
    try {
      const id = await loadCurrentTaskId()
      clearRetry()
      set({ currentProjectId: id, isLoaded: true, isLoading: false, retryCount: 0 })
    } catch (e) {
      // 只有「真失败」（非 404）才走到这里（见 projectData.readProjectId）：
      // 断网 / 鉴权失败 → 自动重试，别把它当成「没选任务」永久吞掉。
      const tries = get().retryCount + 1
      const delay = tries <= MAX_RETRY ? RETRY_MS : RELOAD_MS
      console.warn(`[task] 读取当前任务失败（第 ${tries} 次），${delay / 1000}s 后重试:`, e)
      // 关键：不设 isLoaded=true —— UI 继续如实显示「加载中」，不谎报「未选任务」。
      set({ isLoading: false, retryCount: tries })
      scheduleRetry(delay)
    }
  },

  setCurrentProject: async (projectId) => {
    if (get().currentProjectId === projectId) return
    set({ currentProjectId: projectId })
    await saveCurrentTaskId(projectId)
  },

  reset: () => {
    clearRetry()
    set({ currentProjectId: null, isLoaded: false, isLoading: false, retryCount: 0 })
  },
}))
