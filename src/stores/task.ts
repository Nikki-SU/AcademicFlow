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

/** 读取失败后的自动重试：间隔 4s、最多 3 次；仍失败才退回「未选」，绝不无限「加载中」 */
const RETRY_MS = 4000
const MAX_RETRY = 3

export const useTaskStore = create<TaskState>((set, get) => ({
  currentProjectId: null,
  isLoaded: false,
  isLoading: false,
  retryCount: 0,

  loadCurrent: async () => {
    if (get().isLoaded || get().isLoading) return
    set({ isLoading: true })
    try {
      const id = await loadCurrentTaskId()
      set({ currentProjectId: id, isLoaded: true, isLoading: false, retryCount: 0 })
    } catch (e) {
      // 只有「真失败」（非 404）才走到这里（见 projectData.readProjectId）：
      // 断网 / 鉴权失败 → 自动重试，别把它当成「没选任务」永久吞掉。
      const tries = get().retryCount + 1
      if (tries <= MAX_RETRY) {
        console.warn(`[task] 读取当前任务失败（第 ${tries} 次），${RETRY_MS / 1000}s 后重试:`, e)
        set({ isLoading: false, retryCount: tries })
        setTimeout(() => void get().loadCurrent(), RETRY_MS)
      } else {
        console.warn('[task] 多次读取当前任务均失败，暂显「未选任务」:', e)
        set({ isLoaded: true, isLoading: false })
      }
    }
  },

  setCurrentProject: async (projectId) => {
    if (get().currentProjectId === projectId) return
    set({ currentProjectId: projectId })
    await saveCurrentTaskId(projectId)
  },

  reset: () => set({ currentProjectId: null, isLoaded: false, isLoading: false, retryCount: 0 }),
}))
