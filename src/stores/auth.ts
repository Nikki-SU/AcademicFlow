/**
 * 认证状态管理 (Zustand)
 * -------------------------------------------------
 * 存储当前登录态：token / user / scopes / method / loginAt / expiresAt / 加载中标志 / 错误信息。
 * 数据持久层：IndexedDB auth object store via ../services/db.ts（spec §1.12.2）。
 */
import { create } from 'zustand'
import {
  deleteAuth,
  getAuth,
  putAuth,
} from '../services/db'
import { verifyPAT } from '../services/github'
import type { AuthState, GitHubUser } from '../types'
import { useWorkspaceStore } from './workspace'

interface AuthActions {
  /** 应用启动时调用：从 IndexedDB 恢复登录态 */
  init: () => Promise<void>
  /** 用户登录（支持 Device Flow 和 PAT） */
  login: (token: string, method: 'device_flow' | 'pat', expiresAt?: number) => Promise<void>
  /** 登出：清空 IndexedDB 中的凭据 + 内存态 */
  logout: () => Promise<void>
  /** 清错误提示 */
  clearError: () => void
}

const initialState: AuthState = {
  token: null,
  user: null,
  scopes: [],
  method: null,
  loginAt: null,
  expiresAt: null,
  isLoading: false,
  isInitialized: false,
  error: null,
}

export const useAuthStore = create<AuthState & AuthActions>((set) => ({
  ...initialState,

  init: async () => {
    set({ isLoading: true })
    try {
      const authRow = await getAuth()
      if (!authRow) {
        set({ isInitialized: true, isLoading: false })
        return
      }

      let cachedUser: GitHubUser | null = null
      let cachedScopes: string[] = []
      try {
        cachedUser = JSON.parse(authRow.user_data) as GitHubUser
        cachedScopes = authRow.scope.split(',').map(s => s.trim()).filter(Boolean)
      } catch {
        // ignore parse error
      }

      set({
        token: authRow.access_token,
        user: cachedUser,
        scopes: cachedScopes,
        method: authRow.method,
        loginAt: authRow.login_at,
        expiresAt: authRow.expires_at,
        isInitialized: true,
        isLoading: false,
      })

      try {
        const { user, scopes } = await verifyPAT(authRow.access_token)
        set({ user, scopes })
        await putAuth({
          method: authRow.method,
          access_token: authRow.access_token,
          scope: scopes.join(','),
          login_at: authRow.login_at,
          expires_at: authRow.expires_at,
          github_username: user.login,
          github_user_id: user.id,
          user_data: JSON.stringify(user),
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        await deleteAuth()
        set({
          token: null,
          user: null,
          scopes: [],
          method: null,
          loginAt: null,
          expiresAt: null,
          error: `登录态已过期，请重新登录：${msg}`,
        })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({
        error: `初始化失败：${msg}`,
        isInitialized: true,
        isLoading: false,
      })
    }
  },

  login: async (token: string, method: 'device_flow' | 'pat', expiresAt?: number) => {
    set({ isLoading: true, error: null })
    try {
      const { user, scopes } = await verifyPAT(token)
      const now = Date.now()
      await putAuth({
        method,
        access_token: token.trim(),
        scope: scopes.join(','),
        login_at: now,
        expires_at: expiresAt ?? null,
        github_username: user.login,
        github_user_id: user.id,
        user_data: JSON.stringify(user),
      })
      set({
        token: token.trim(),
        user,
        scopes,
        method,
        loginAt: now,
        expiresAt: expiresAt ?? null,
        isLoading: false,
        error: null,
      })
      useWorkspaceStore.getState().checkAndMaybeInit()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ isLoading: false, error: msg })
      throw e
    }
  },

  logout: async () => {
    await deleteAuth()
    useWorkspaceStore.getState().reset()
    set({ ...initialState, isInitialized: true })
  },

  clearError: () => set({ error: null }),
}))
