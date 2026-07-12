/**
 * GitHub API 客户端
 * -------------------------------------------------
 * 所有请求都从浏览器直接打到 api.github.com（该端点支持 CORS，允许 *）。
 * 请求头带用户自持的 PAT（Personal Access Token）。
 *
 * 相关文档：
 * - https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api
 * - https://docs.github.com/en/rest/users/users#get-the-authenticated-user
 */
import { GitHubAPIError, type GitHubUser, type PATVerifyResult } from '../types'

const API_BASE = 'https://api.github.com'

/** M1 阶段最小 scope 要求（M2 起会用到 workflow / delete_repo 等） */
export const REQUIRED_SCOPE = 'repo'

/**
 * 通用请求封装：自动带鉴权头、统一错误处理、返回原始 Response（便于读 headers）
 */
export async function githubFetch(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('Accept', 'application/vnd.github+json')
  headers.set('X-GitHub-Api-Version', '2022-11-28')

  const res = await fetch(url, { ...init, headers })
  return res
}

/**
 * 从响应头解析 scope 列表
 * X-OAuth-Scopes: "repo, workflow" -> ["repo", "workflow"]
 */
export function parseScopes(res: Response): string[] {
  const raw = res.headers.get('X-OAuth-Scopes') || ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 验证 PAT 有效性 + scope 权限
 *
 * @throws GitHubAPIError 401 = token 无效/过期，403 = 速率限制或权限不足
 * @throws Error(scope 不足) = token 有效但缺 repo scope
 */
export async function verifyPAT(token: string): Promise<PATVerifyResult> {
  // 基础格式校验：GitHub PAT 一般以 ghp_ / github_pat_ / gho_ / ghu_ 开头
  const trimmed = token.trim()
  if (!trimmed) {
    throw new Error('PAT 不能为空')
  }
  if (!/^(gh[pousr]_|github_pat_)/i.test(trimmed)) {
    throw new Error(
      'PAT 格式看着不太对（GitHub PAT 通常以 ghp_ 或 github_pat_ 开头）。请检查是否复制完整。',
    )
  }

  let res: Response
  try {
    res = await githubFetch('/user', trimmed)
  } catch (e) {
    // 网络错误、CORS 错误、DNS 错误等
    throw new Error(
      `网络请求失败：${e instanceof Error ? e.message : String(e)}。请检查网络或 VPN。`,
    )
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const data = await res.json()
      if (data?.message) msg = data.message
    } catch {
      // ignore json parse error
    }

    if (res.status === 401) {
      throw new GitHubAPIError(
        401,
        msg,
        'PAT 无效或已过期。请去 GitHub 重新生成，或检查是否粘贴完整。',
      )
    }
    if (res.status === 403) {
      throw new GitHubAPIError(403, msg, `GitHub 拒绝请求：${msg}`)
    }
    throw new GitHubAPIError(res.status, msg)
  }

  const scopes = parseScopes(res)

  // 检查最小 scope 要求
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw new Error(
      `PAT 缺少必需的 "${REQUIRED_SCOPE}" 权限（当前 scope: [${
        scopes.join(', ') || '空'
      }]）。请去 GitHub 编辑 PAT 补上勾选。`,
    )
  }

  const user = (await res.json()) as GitHubUser
  const rateLimitRemaining = parseInt(
    res.headers.get('X-RateLimit-Remaining') || '0',
    10,
  )

  return { user, scopes, rateLimitRemaining }
}

/** 生成"一键创建 PAT"URL（预填 scope 和描述） */
export function buildPATCreateURL(): string {
  const params = new URLSearchParams({
    scopes: 'repo,workflow',
    description: 'AcademicFlow',
  })
  return `https://github.com/settings/tokens/new?${params.toString()}`
}
