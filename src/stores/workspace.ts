/**
 * Workspace 状态管理 (Zustand)
 * -------------------------------------------------
 * M2：负责用户 GitHub 私库 `academicflow-workspace` 的检测 + 初始化。
 *
 * 状态机：
 *   初始态 → checkAndMaybeInit() → { repo: null, isChecked: true } ← 未 onboarding
 *                              ↘  { repo: <repo>, isChecked: true } ← 已 onboarding
 *   Onboarding 页手动点按钮 → createAndInit()
 *     → progress 分步更新 → 完成后 set repo
 */
import { create } from 'zustand'
import {
  DEFAULT_WORKSPACE_REPO_NAME,
  INITIAL_COMMIT_MESSAGE,
  WORKSPACE_REPO_DESCRIPTION,
  WORKSPACE_SKELETON,
} from '../constants/skeleton'
import {
  checkRepoExists,
  createPrivateRepo,
  initEmptyRepoSkeleton,
} from '../services/github'
import type { WorkspaceState } from '../types'
import { useAuthStore } from './auth'

interface WorkspaceActions {
  /**
   * 应用启动后 / 登录后调用：检测私库是否已存在。
   * 存在则 set repo；不存在只 set isChecked=true（不自动创建，由 Onboarding 页手动触发）
   */
  checkAndMaybeInit: () => Promise<void>
  /**
   * Onboarding 页面点击"初始化我的工作空间"按钮触发。
   * 完整流程：createPrivateRepo → initEmptyRepoSkeleton（12 项文件）
   */
  createAndInit: () => Promise<void>
  /** 登出时重置 */
  reset: () => void
  /** 清错误 */
  clearError: () => void
}

const initialState: WorkspaceState = {
  isChecked: false,
  isLoading: false,
  repo: null,
  progress: null,
  error: null,
}

export const useWorkspaceStore = create<WorkspaceState & WorkspaceActions>(
  (set, get) => ({
    ...initialState,

    checkAndMaybeInit: async () => {
      // 已经检测过就不重复
      if (get().isChecked || get().isLoading) return

      const { token, user } = useAuthStore.getState()
      if (!token || !user) {
        // 未登录，不做检测
        return
      }

      set({ isLoading: true, error: null })
      try {
        const repo = await checkRepoExists(
          user.login,
          DEFAULT_WORKSPACE_REPO_NAME,
          token,
        )
        set({
          repo,
          isChecked: true,
          isLoading: false,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        set({
          isChecked: true,
          isLoading: false,
          error: `检测工作区失败：${msg}`,
        })
      }
    },

    createAndInit: async () => {
      const { token, user } = useAuthStore.getState()
      if (!token || !user) {
        set({ error: '未登录，无法创建工作区' })
        return
      }
      if (get().isLoading) return

      set({ isLoading: true, error: null, progress: '正在创建私库…' })
      try {
        // Step 1: 创建私库
        const repo = await createPrivateRepo(
          DEFAULT_WORKSPACE_REPO_NAME,
          WORKSPACE_REPO_DESCRIPTION,
          token,
        )
        set({ progress: `私库已创建：${repo.full_name}` })

        // Step 2: 首次 commit 骨架 12 项文件
        await initEmptyRepoSkeleton(
          repo.owner.login,
          repo.name,
          WORKSPACE_SKELETON,
          INITIAL_COMMIT_MESSAGE,
          token,
          (msg) => set({ progress: msg }),
        )

        set({
          repo,
          isChecked: true,
          isLoading: false,
          progress: null,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        set({
          isLoading: false,
          error: `初始化工作区失败：${msg}`,
          progress: null,
        })
        throw e
      }
    },

    reset: () => set({ ...initialState }),

    clearError: () => set({ error: null }),
  }),
)
