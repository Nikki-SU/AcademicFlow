/**
 * AcademicFlow 全局类型定义
 */

/** GitHub 用户信息（GET /user 返回的核心字段） */
export interface GitHubUser {
  login: string
  id: number
  name: string | null
  avatar_url: string
  html_url: string
  email: string | null
  bio: string | null
}

/** 登录态 */
export interface AuthState {
  /** GitHub Personal Access Token */
  token: string | null
  /** 当前登录用户信息 */
  user: GitHubUser | null
  /** PAT 授权的 scope 列表（从 X-OAuth-Scopes 响应头解析） */
  scopes: string[]
  /** 是否正在初始化 / 校验中 */
  isLoading: boolean
  /** 初始化时是否已尝试从 IndexedDB 读取过 token（用于避免首次渲染时误跳登录页） */
  isInitialized: boolean
  /** 上次登录/验证的错误信息 */
  error: string | null
}

/** PAT 验证成功后的返回结果 */
export interface PATVerifyResult {
  user: GitHubUser
  scopes: string[]
  /** 剩余速率配额（X-RateLimit-Remaining） */
  rateLimitRemaining: number
}

/** GitHub API 错误 */
export class GitHubAPIError extends Error {
  status: number
  /** GitHub 返回的原始 message，如"Bad credentials"、"API rate limit exceeded"等 */
  githubMessage: string

  constructor(status: number, githubMessage: string, friendly?: string) {
    super(friendly || githubMessage)
    this.name = 'GitHubAPIError'
    this.status = status
    this.githubMessage = githubMessage
  }
}
