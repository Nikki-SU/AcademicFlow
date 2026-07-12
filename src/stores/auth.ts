/**
 * 认证状态管理 (Zustand)
 * -------------------------------------------------
 * 存储当前登录态：token / user / scopes / 加载中标志 / 错误信息。
 * 数据持久层：IndexedDB via ../services/db.ts。
 */
import { create } from 'zustand'
import {
  SETTING_KEYS,
  deleteSettings,
  getSetting,
  putSetting,
} from '../services/db'
import { verifyPAT } from '../services/github'
import type { AuthState, GitHubUser } from '../types'
import { useWorkspaceStore } from './workspace'

interface AuthActions {
  /** 应用启动时调用：从 IndexedDB 恢复登录态 */
  init: () => Promise<void>
  /** 用户提交 PAT 登录 */
  login: (token: string) => Promise<void>
  /** 登出：清空 IndexedDB 中的凭据 + 内存态 */
  logout: () => Promise<void>
  /** 清错误提示 */
  clearError: () => void
}

const initialState: AuthState = {
  token: null,
  user: null,
  scopes: [],
  isLoading: false,
  isInitialized: false,
  error: null,
}

export const useAuthStore = create<AuthState & AuthActions>((set) => ({
  ...initialState,

  init: async () => {
    set({ isLoading: true })
    try {
      const token = await getSetting(SETTING_KEYS.GITHUB_TOKEN)
      if (!token) {
        set({ isInitialized: true, isLoading: false })
        return
      }

      // 有缓存 token，直接展示缓存 user（避免闪烁），后台再重新校验
      const userJson = await getSetting(SETTING_KEYS.GITHUB_USER_CACHE)
      const scopesJson = await getSetting(SETTING_KEYS.GITHUB_SCOPES)
      let cachedUser: GitHubUser | null = null
      let cachedScopes: string[] = []
      try {
        if (userJson) cachedUser = JSON.parse(userJson) as GitHubUser
        if (scopesJson) cachedScopes = JSON.parse(scopesJson) as string[]
      } catch {
        // ignore parse error
      }

      // 先用缓存点亮 UI
      set({
        token,
        user: cachedUser,
        scopes: cachedScopes,
        isInitialized: true,
        isLoading: false,
      })

      // 后台重新校验一次；若 token 已被 GitHub 吊销就清态
      try {
        const { user, scopes } = await verifyPAT(token)
        set({ user, scopes })
        await putSetting(
          SETTING_KEYS.GITHUB_USER_CACHE,
          JSON.stringify(user),
        )
        await putSetting(
          SETTING_KEYS.GITHUB_SCOPES,
          JSON.stringify(scopes),
        )
      } catch (e) {
        // token 已失效或网络不通 → 清态回登录页
        const msg = e instanceof Error ? e.message : String(e)
        await deleteSettings([
          SETTING_KEYS.GITHUB_TOKEN,
          SETTING_KEYS.GITHUB_USER_CACHE,
          SETTING_KEYS.GITHUB_SCOPES,
        ])
        set({
          token: null,
          user: null,
          scopes: [],
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

  login: async (token: string) => {
    set({ isLoading: true, error: null })
    try {
      const { user, scopes } = await verifyPAT(token)
      // 校验通过 → 持久化到 IndexedDB
      await putSetting(SETTING_KEYS.GITHUB_TOKEN, token.trim())
      await putSetting(SETTING_KEYS.GITHUB_USER_CACHE, JSON.stringify(user))
      await putSetting(SETTING_KEYS.GITHUB_SCOPES, JSON.stringify(scopes))
      set({
        token: token.trim(),
        user,
        scopes,
        isLoading: false,
        error: null,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ isLoading: false, error: msg })
      throw e
    }
  },

  logout: async () => {
    await deleteSettings([
      SETTING_KEYS.GITHUB_TOKEN,
      SETTING_KEYS.GITHUB_USER_CACHE,
      SETTING_KEYS.GITHUB_SCOPES,
    ])
    // 同步清空 workspace store，避免下次登录看到上一账号的 repo
    useWorkspaceStore.getState().reset()
    set({ ...initialState, isInitialized: true })
  },

  clearError: () => set({ error: null }),
}))
