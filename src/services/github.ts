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
import { assertCanWrite, setGlobalAuthError } from './authError'

const API_BASE = 'https://api.github.com'

/** M1 阶段最小 scope 要求（M2 起会用到 workflow / delete_repo 等） */
export const REQUIRED_SCOPE = 'repo'

export interface ConnectivityResult {
  /** github.com 基础连通（no-cors 模式，不测 CORS） */
  githubDotCom: 'ok' | 'fail'
  /** api.github.com + Header 模式（会触发 CORS 预检） */
  apiWithHeader: 'ok' | 'fail'
  /** api.github.com + Query 模式（不应触发 CORS 预检） */
  apiWithQuery: 'ok' | 'fail'
  /** 可读的诊断结论 */
  detail: string
}

/**
 * 网络探测
 * @param corsMode true=发送带自定义头的请求（触发 CORS 预检），false=简单请求（不触发预检）
 */
async function probe(url: string, corsMode: boolean = false): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const init: RequestInit = {
      method: 'GET',
      signal: ctrl.signal,
      cache: 'no-store',
    }
    if (corsMode) {
      init.headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }
    } else {
      // no-cors 模式：允许跨域但不读取响应，专门用来测网络可达性
      init.mode = 'no-cors'
    }
    await fetch(url, init)
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * GitHub 连通性诊断（3 维探测）
 * -------------------------------------------------
 *   1. github.com 主页（no-cors 模式，仅测网络可达性）
 *   2. api.github.com + 自定义头（触发 CORS 预检，测试 Header 模式）
 *   3. api.github.com 无自定义头（不触发预检，模拟 Query 模式请求）
 *
 * 组合判断：
 *   github.com OK + Header FAIL + Query OK → CORS 预检被拦，Query 参数认证可用
 *   github.com OK + Header FAIL + Query FAIL → api.github.com 被封
 *   全部 OK → 网络正常
 *   github.com FAIL → 完全无外网
 */
export async function testGitHubConnectivity(): Promise<ConnectivityResult> {
  const [githubOk, headerOk, queryOk] = await Promise.all([
    probe('https://github.com', false),
    probe('https://api.github.com/user', true),
    probe('https://api.github.com/user', false),
  ])

  let detail = ''
  if (githubOk && headerOk) {
    detail = 'GitHub 连通性完全正常。如果登录仍失败，可能是 token 本身的问题（格式、scope、过期等）。'
  } else if (githubOk && !headerOk && queryOk) {
    detail = '✅ github.com 可达\n' +
      '✅ api.github.com 可达\n' +
      '❌ CORS 预检被拦截\n\n' +
      '你的网络/VPN 拦截了带自定义头的 CORS 预检请求。\n' +
      '系统已自动降级为 Query 参数认证（token 放在 URL 中，不触发预检），登录应当正常。'
  } else if (githubOk && !headerOk && !queryOk) {
    detail = '✅ github.com 可达\n' +
      '❌ api.github.com 完全不可达\n\n' +
      '你的网络/VPN 在域名层面封锁了 api.github.com。\n' +
      '请确认 VPN 是否开启，或联系网络管理员放行 api.github.com。'
  } else if (!githubOk) {
    detail = '❌ github.com 不可达\n\n' +
      '完全无法连接到 GitHub。请检查：\n' +
      '① 是否已连外网 / VPN\n' +
      '② DNS 是否能解析 github.com\n' +
      '③ 防火墙是否放行 HTTPS 出站连接'
  } else {
    detail = `诊断结果：github.com=${githubOk ? 'OK' : 'FAIL'}, ` +
      `Header 模式=${headerOk ? 'OK' : 'FAIL'}, ` +
      `Query 模式=${queryOk ? 'OK' : 'FAIL'}\n\n` +
      '如果登录仍有问题，请联系管理员或调整 VPN 配置。'
  }

  return {
    githubDotCom: githubOk ? 'ok' : 'fail',
    apiWithHeader: headerOk ? 'ok' : 'fail',
    apiWithQuery: queryOk ? 'ok' : 'fail',
    detail,
  }
}

/**
 * 通用请求封装：自动带鉴权、统一错误处理、返回原始 Response
 * -------------------------------------------------
 * 双认证策略：
 *   1. 优先 Authorization Header（标准、安全，但触发 CORS 预检）
 *   2. 若预检被拦（NetworkError），自动降级为 ?access_token= Query 参数（不触发预检）
 *
 * 这样无论用户网络环境如何，都能通过至少一种方式访问 GitHub API。
 */
export type AuthMode = 'header' | 'query'

/**
 * 全局认证模式：由 verifyPAT 写入，所有后续请求自动采用已验证通过的模式。
 * 默认为 'header'（标准 Authorization 头方式），降级后自动切换为 'query'。
 */
let resolvedAuthMode: AuthMode = 'header'

export function setResolvedAuthMode(mode: AuthMode) {
  resolvedAuthMode = mode
}

export function getResolvedAuthMode(): AuthMode {
  return resolvedAuthMode
}

export async function githubFetch(
  path: string,
  token: string,
  init: RequestInit = {},
  authMode?: AuthMode,
): Promise<Response> {
  const mode = authMode ?? resolvedAuthMode
  const baseUrl = path.startsWith('http') ? path : `${API_BASE}${path}`

  if (mode === 'header') {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/vnd.github+json')
    headers.set('X-GitHub-Api-Version', '2022-11-28')
    headers.set('Authorization', `Bearer ${token}`)
    const res = await fetch(baseUrl, { ...init, headers })
    if (res.status === 401 || res.status === 403) {
      handleAuthError(res)
    }
    return res
  }

  // Query 参数模式：彻底零自定义头，保证不触发任何 CORS 预检
  // GitHub API 默认返回 JSON，不需要 Accept 头
  // 这是在严格网络环境下唯一可靠的方式
  const sep = baseUrl.includes('?') ? '&' : '?'
  const urlWithToken = `${baseUrl}${sep}access_token=${encodeURIComponent(token)}`
  // 只保留 method/signal/body，完全丢弃 headers
  const { headers: _omit, ...safeInit } = init
  const res = await fetch(urlWithToken, safeInit)
  if (res.status === 401 || res.status === 403) {
    handleAuthError(res)
  }
  return res
}

function handleAuthError(res: Response) {
  setGlobalAuthError(
    `Token 失效或权限不足（${res.status}）。请重新登录或检查 PAT 权限。`,
  )
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

  let res: Response | null = null
  let usedAuthMode: AuthMode = 'header'

  // 2 步降级：Header（标准）→ Query（绕预检）
  // 这两步都走 api.github.com（该域名原生支持 CORS）
  // Query 模式只发 Accept 头（简单头），不触发 CORS 预检
  try {
    res = await githubFetch('/user', trimmed, {}, 'header')
  } catch {
    try {
      res = await githubFetch('/user', trimmed, {}, 'query')
      usedAuthMode = 'query'
      setResolvedAuthMode('query')
    } catch (e2) {
      const errMsg = e2 instanceof Error ? e2.message : String(e2)
      throw new Error(
        `无法连接到 GitHub API。\n` +
        `最后错误：${errMsg}\n\n` +
        `可能原因：\n` +
        `① 你的网络/VPN 完全阻断了对 api.github.com 的访问\n` +
        `② GitHub 服务临时不可用\n` +
        `请确认 VPN 已开启，并尝试刷新页面或切换网络。`,
      )
    }
  }

  const response = res

  if (!response.ok) {
    let msg = `HTTP ${response.status}`
    try {
      const data = await response.json()
      if (data?.message) msg = data.message
    } catch {
      // ignore json parse error
    }

    if (response.status === 401) {
      throw new GitHubAPIError(
        401,
        msg,
        'PAT 无效或已过期。请去 GitHub 重新生成，或检查是否粘贴完整。',
      )
    }
    if (response.status === 403) {
      throw new GitHubAPIError(403, msg, `GitHub 拒绝请求：${msg}`)
    }
    throw new GitHubAPIError(response.status, msg)
  }

  const scopes = parseScopes(response)

  // 检查最小 scope 要求
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw new Error(
      `PAT 缺少必需的 "${REQUIRED_SCOPE}" 权限（当前 scope: [${
        scopes.join(', ') || '空'
      }]）。请去 GitHub 编辑 PAT 补上勾选。`,
    )
  }

  const user = (await response.json()) as GitHubUser
  const rateLimitRemaining = parseInt(
    response.headers.get('X-RateLimit-Remaining') || '0',
    10,
  )

  // GitHub 在部分场景下通过响应头返回 token 过期时间（Fine-grained PAT 创建/校验）
  let expiresAt: number | undefined
  const tokenExpiration = response.headers.get('github-authentication-token-expiration')
  if (tokenExpiration) {
    const parsed = new Date(tokenExpiration).getTime()
    if (!isNaN(parsed)) expiresAt = parsed
  }

  return { user, scopes, rateLimitRemaining, expiresAt, authMode: usedAuthMode }
}

/** 生成 Fine-grained PAT 创建页 URL（预填名称/描述/过期时间/仓库权限）
 * 说明：GitHub  Fine-grained PAT 创建页支持通过 URL 参数预填字段，
 * 仓库选择需要用户手动勾选（首次登录时目标私库可能尚未创建）。
 */
export function buildPATCreateURL(): string {
  const params = new URLSearchParams({
    name: 'AcademicFlow',
    description: 'AcademicFlow 以 GitHub 为后端的个人学术工作流工具',
    expires_in: '90',
    repo_access: 'selected',
    contents: 'write',
    metadata: 'read',
    workflows: 'write',
  })
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`
}

// ═════════════════════════════════════════════════════════════════════════
// Device Flow 认证（主路径，无后端无密钥）
// ═════════════════════════════════════════════════════════════════════════

const GITHUB_CLIENT_ID = 'Ov23li6yK83u4S1YxNnP'

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface TokenResponse {
  access_token: string
  token_type: string
  scope: string
}

export interface TokenError {
  error: string
  error_description?: string
  error_uri?: string
}

/**
 * 获取 Device Code
 * POST https://github.com/login/device/code
 */
export async function getDeviceCode(): Promise<DeviceCodeResponse> {
  try {
    const res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        scope: 'repo',
      }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as TokenError
      throw new Error(err.error_description || `Device Flow 失败: ${err.error}`)
    }
    return (await res.json()) as DeviceCodeResponse
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    const isCorsOrNetwork =
      errMsg.includes('Failed to fetch') ||
      errMsg.includes('NetworkError') ||
      errMsg.includes('Load failed') ||
      errMsg.includes('ERR_BLOCKED') ||
      errMsg.includes('ERR_NETWORK')
    if (isCorsOrNetwork) {
      throw new Error(
        `无法连接到 GitHub (github.com)。\n` +
        `详情：${errMsg}\n\n` +
        `可能是网络/代理拦截了 CORS 预检请求。请检查网络连接，或使用登录页的「网络诊断」按钮排查。`,
      )
    }
    throw e
  }
}

/** 轮询结果：成功返回 token；pending 时返回下一次轮询间隔（秒） */
export type PollDeviceTokenResult =
  | { type: 'token'; token: TokenResponse }
  | { type: 'pending'; interval: number }

/**
 * 轮询获取 Access Token
 * POST https://github.com/login/oauth/access_token
 * @param deviceCode 设备码
 * @param currentInterval 当前轮询间隔（秒）
 * @returns TokenResponse 成功时；pending 时返回新的轮询间隔
 */
export async function pollDeviceToken(
  deviceCode: string,
  currentInterval: number,
): Promise<PollDeviceTokenResult> {
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
    const data = (await res.json()) as TokenResponse | TokenError
    if ('error' in data) {
      if (data.error === 'authorization_pending') {
        return { type: 'pending', interval: currentInterval }
      }
      if (data.error === 'slow_down') {
        // GitHub 要求遇到 slow_down 时把轮询间隔增加 5 秒
        return { type: 'pending', interval: currentInterval + 5 }
      }
      if (data.error === 'expired_token') throw new Error('授权码已过期，请重新获取')
      if (data.error === 'access_denied') throw new Error('你拒绝了授权')
      throw new Error(data.error_description || `Token 获取失败: ${data.error}`)
    }
    return { type: 'token', token: data }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    const isCorsOrNetwork =
      errMsg.includes('Failed to fetch') ||
      errMsg.includes('NetworkError') ||
      errMsg.includes('Load failed') ||
      errMsg.includes('ERR_BLOCKED') ||
      errMsg.includes('ERR_NETWORK')
    if (isCorsOrNetwork) {
      throw new Error(
        `与 GitHub 断开连接 (github.com)。\n` +
        `详情：${errMsg}\n\n` +
        `授权轮询被网络中断。请确认网络/代理能访问 github.com，然后重试。`,
      )
    }
    throw e
  }
}

// ═════════════════════════════════════════════════════════════════════════
// M2: workspace 私库操作
// ═════════════════════════════════════════════════════════════════════════

import type { GitHubRepo } from '../types'
import type { SkeletonFile } from '../constants/skeleton'

/**
 * 检查用户名下某个私库是否存在
 * @returns 存在时返回 GitHubRepo；不存在时返回 null；其它错误抛出
 */
export async function checkRepoExists(
  owner: string,
  repo: string,
  token: string,
): Promise<GitHubRepo | null> {
  const res = await githubFetch(`/repos/${owner}/${repo}`, token)
  if (res.status === 404) return null
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const d = await res.json()
      if (d?.message) msg = d.message
    } catch {
      // ignore
    }
    throw new GitHubAPIError(res.status, msg, `检测仓库失败：${msg}`)
  }
  return (await res.json()) as GitHubRepo
}

/**
 * 创建私库
 * POST /user/repos  Body: {name, private:true, auto_init:false, description}
 * v0.3 §10.3 明确不用 auto_init，我们自控首 commit。
 */
export async function createPrivateRepo(
  name: string,
  description: string,
  token: string,
): Promise<GitHubRepo> {
  const res = await githubFetch('/user/repos', token, {
    method: 'POST',
    body: JSON.stringify({
      name,
      description,
      private: true,
      auto_init: false,
      has_issues: false,
      has_projects: false,
      has_wiki: false,
    }),
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const d = await res.json()
      if (d?.message) msg = d.message
    } catch {
      // ignore
    }
    if (res.status === 422) {
      throw new GitHubAPIError(422, msg, `私库名冲突或参数错：${msg}`)
    }
    throw new GitHubAPIError(res.status, msg, `创建私库失败：${msg}`)
  }
  return (await res.json()) as GitHubRepo
}

/**
 * 将文本内容 base64 编码（UTF-8 安全）
 * 浏览器 btoa 只能处理 latin1，中文会抛错，用 TextEncoder 走一遍
 */
function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * 将 base64 内容解码为文本（UTF-8 安全）
 * 浏览器 atob 只能处理 latin1，中文会乱码，用 TextDecoder 走一遍
 */
function base64ToUtf8(base64: string): string {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i)
  }
  return new TextDecoder('utf-8').decode(bytes)
}

/**
 * 检测仓库是否为空（无任何 commit / 无默认分支）
 * -------------------------------------------------
 * 空仓库的判定信号：`GET /repos/{owner}/{repo}/branches` 返回空数组。
 * 空仓库不能直接 POST /git/blobs（GitHub 会返回 409 "Git Repository is empty."）。
 */
export async function isRepoEmpty(
  owner: string,
  repo: string,
  token: string,
): Promise<boolean> {
  const res = await githubFetch(`/repos/${owner}/${repo}/branches`, token)
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new GitHubAPIError(res.status, err, `检测分支列表失败：${err}`)
  }
  const branches = (await res.json()) as unknown[]
  return branches.length === 0
}

/**
 * 用 Git Data API 给仓库写入初始骨架 commit
 * -------------------------------------------------
 * 兼容两种起始状态：
 *   A. **完全空仓库**（无任何 commit / 无 main 分支）
 *      GitHub 的 POST /git/blobs 会返回 409 "Git Repository is empty."
 *      → 先用 Contents API PUT 引导第一个文件（触发 initial commit + 自动建 main）
 *      → 剩余 11 个文件走 Git Data API 追加模式（有 base_tree + parents + PATCH refs）
 *   B. **已有 initial commit**（比如上次骨架初始化失败，但仓库已被引导过）
 *      → 直接走 Git Data API 追加模式，把所有骨架文件补齐
 *
 * @param owner   仓库 owner 用户名
 * @param repo    仓库名
 * @param files   骨架文件列表
 * @param message commit message
 * @param token   PAT
 * @param onProgress 进度回调（可选）
 * @returns 最终 commit 的 sha
 */
export async function initEmptyRepoSkeleton(
  owner: string,
  repo: string,
  files: SkeletonFile[],
  message: string,
  token: string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const base = `/repos/${owner}/${repo}`

  // Step 0: 判定是否需要引导 commit
  onProgress?.('检测仓库状态…')
  const empty = await isRepoEmpty(owner, repo, token)

  let baseCommitSha: string
  let baseTreeSha: string
  let filesToUpload: SkeletonFile[]

  if (empty) {
    // 空仓库：用 Contents API PUT 引导第一个文件（自动创建 main 分支 + initial commit）
    if (files.length === 0) {
      throw new Error('骨架文件列表为空，无法初始化')
    }
    const bootstrap = files[0]
    onProgress?.(`引导仓库首个 commit（${bootstrap.path}）…`)
    const putRes = await githubFetch(
      `${base}/contents/${encodeURI(bootstrap.path)}`,
      token,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'chore: bootstrap workspace',
          content: utf8ToBase64(bootstrap.content),
          branch: 'main',
        }),
      },
    )
    if (!putRes.ok) {
      const err = await putRes.text().catch(() => '')
      throw new GitHubAPIError(putRes.status, err, `引导 commit 失败：${err}`)
    }
    const putResult = (await putRes.json()) as {
      commit: { sha: string; tree: { sha: string } }
    }
    baseCommitSha = putResult.commit.sha
    baseTreeSha = putResult.commit.tree.sha
    // 骨架剩余项（除去已引导的第一个）
    filesToUpload = files.slice(1)
  } else {
    // 已有 initial commit：拿 main HEAD 作为 base
    onProgress?.('拉取 main HEAD…')
    const refRes = await githubFetch(`${base}/git/ref/heads/main`, token)
    if (!refRes.ok) {
      const err = await refRes.text().catch(() => '')
      throw new GitHubAPIError(refRes.status, err, `拉取 main 引用失败：${err}`)
    }
    const ref = (await refRes.json()) as { object: { sha: string } }
    baseCommitSha = ref.object.sha

    const commitRes = await githubFetch(
      `${base}/git/commits/${baseCommitSha}`,
      token,
    )
    if (!commitRes.ok) {
      const err = await commitRes.text().catch(() => '')
      throw new GitHubAPIError(commitRes.status, err, `拉取 commit 失败：${err}`)
    }
    const c = (await commitRes.json()) as { tree: { sha: string } }
    baseTreeSha = c.tree.sha
    // 全量骨架都补
    filesToUpload = files
  }

  // 如果引导已经把唯一骨架文件写完了（极端情况：骨架只有 1 项），直接返回
  if (filesToUpload.length === 0) {
    onProgress?.(`完成，commit：${baseCommitSha.slice(0, 8)}`)
    return baseCommitSha
  }

  // Step 1: 剩余每个文件创建一个 blob
  const treeEntries: {
    path: string
    mode: '100644'
    type: 'blob'
    sha: string
  }[] = []
  let idx = 0
  for (const f of filesToUpload) {
    idx++
    onProgress?.(`上传骨架文件 ${idx}/${filesToUpload.length}：${f.path}`)
    const blobRes = await githubFetch(`${base}/git/blobs`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: utf8ToBase64(f.content),
        encoding: 'base64',
      }),
    })
    if (!blobRes.ok) {
      const err = await blobRes.text().catch(() => '')
      throw new GitHubAPIError(
        blobRes.status,
        err,
        `创建 blob 失败（文件：${f.path}）：${err}`,
      )
    }
    const blob = (await blobRes.json()) as { sha: string }
    treeEntries.push({
      path: f.path,
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    })
  }

  // Step 2: 创建 tree（追加模式，有 base_tree）
  onProgress?.('组装 tree 结构…')
  const treeRes = await githubFetch(`${base}/git/trees`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: treeEntries,
    }),
  })
  if (!treeRes.ok) {
    const err = await treeRes.text().catch(() => '')
    throw new GitHubAPIError(treeRes.status, err, `创建 tree 失败：${err}`)
  }
  const tree = (await treeRes.json()) as { sha: string }

  // Step 3: 创建 commit（追加模式，有 parents）
  onProgress?.('创建骨架 commit…')
  const commitRes = await githubFetch(`${base}/git/commits`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [baseCommitSha],
    }),
  })
  if (!commitRes.ok) {
    const err = await commitRes.text().catch(() => '')
    throw new GitHubAPIError(commitRes.status, err, `创建 commit 失败：${err}`)
  }
  const newCommit = (await commitRes.json()) as { sha: string }

  // Step 4: 更新 refs/heads/main（PATCH，因为分支已存在）
  onProgress?.('更新 main 分支…')
  const refUpdateRes = await githubFetch(
    `${base}/git/refs/heads/main`,
    token,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sha: newCommit.sha,
        force: false,
      }),
    },
  )
  if (!refUpdateRes.ok) {
    const err = await refUpdateRes.text().catch(() => '')
    throw new GitHubAPIError(
      refUpdateRes.status,
      err,
      `更新 main 分支失败：${err}`,
    )
  }

  onProgress?.(`完成，骨架 commit：${newCommit.sha.slice(0, 8)}`)
  return newCommit.sha
}

// ═════════════════════════════════════════════════════════════════════════
// md/csv 文件读写（spec §1.2：只允许 Markdown + CSV 落盘）
// ═════════════════════════════════════════════════════════════════════════

/**
 * 从仓库读取文本文件（md/csv）
 * @returns 文件内容；文件不存在时返回 null
 */
export async function readRepoTextFile(
  owner: string,
  repo: string,
  path: string,
  token: string,
): Promise<{ content: string; sha: string } | null> {
  const res = await githubFetch(
    `/repos/${owner}/${repo}/contents/${encodeURI(path)}`,
    token,
  )
  if (res.status === 404) return null
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new GitHubAPIError(res.status, err, `读取文件失败：${err}`)
  }
  const data = (await res.json()) as { content: string; sha: string; encoding: string }
  const content = base64ToUtf8(data.content.replace(/\n/g, ''))
  return { content, sha: data.sha }
}

/**
 * 向仓库写入文本文件（md/csv）
 * @returns 写入后的文件 sha
 */
export async function writeRepoTextFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  token: string,
  message?: string,
): Promise<string> {
  assertCanWrite()
  const encoded = utf8ToBase64(content)

  let existingSha: string | undefined
  try {
    const getRes = await githubFetch(
      `/repos/${owner}/${repo}/contents/${encodeURI(path)}`,
      token,
    )
    if (getRes.ok) {
      const fileData = (await getRes.json()) as { sha: string }
      existingSha = fileData.sha
    }
  } catch {
    // 文件不存在，忽略
  }

  const body: Record<string, unknown> = {
    message: message || `Update ${path}`,
    content: encoded,
    branch: 'main',
  }
  if (existingSha) {
    body.sha = existingSha
  }

  const res = await githubFetch(
    `/repos/${owner}/${repo}/contents/${encodeURI(path)}`,
    token,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new GitHubAPIError(res.status, err, `写入文件失败：${err}`)
  }

  const result = (await res.json()) as { content: { sha: string } }
  return result.content.sha
}

export interface BatchFileOp {
  path: string
  content: string
  encoding?: 'utf-8' | 'base64'
}

export interface BatchWriteResult {
  commitSha: string
  treeSha: string
}

/**
 * 批量写入文件（使用 Git Trees API，一次 commit）
 */
export async function writeFileBatch(
  ops: BatchFileOp[],
  message: string,
  owner: string,
  repo: string,
  token: string,
): Promise<BatchWriteResult> {
  assertCanWrite()

  // 1. 获取当前 HEAD 的 commit sha
  const refRes = await githubFetch(`/repos/${owner}/${repo}/git/ref/heads/main`, token)
  if (!refRes.ok) {
    const err = await refRes.text().catch(() => '')
    throw new GitHubAPIError(refRes.status, err, '获取 main 分支引用失败')
  }
  const refData = (await refRes.json()) as { object: { sha: string } }
  const latestCommitSha = refData.object.sha

  // 2. 获取当前 commit 的 tree sha
  const commitRes = await githubFetch(
    `/repos/${owner}/${repo}/git/commits/${latestCommitSha}`,
    token,
  )
  if (!commitRes.ok) {
    const err = await commitRes.text().catch(() => '')
    throw new GitHubAPIError(commitRes.status, err, '获取最新 commit 失败')
  }
  const commitData = (await commitRes.json()) as { tree: { sha: string } }
  const baseTreeSha = commitData.tree.sha

  // 3. 构造 tree 节点
  const treeItems = ops.map((op) => {
    const content = op.encoding === 'base64' ? op.content : utf8ToBase64(op.content)
    return {
      path: op.path,
      mode: '100644' as const,
      type: 'blob' as const,
      content,
      encoding: 'base64' as const,
    }
  })

  // 4. 创建新 tree
  const treeRes = await githubFetch(`/repos/${owner}/${repo}/git/trees`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: treeItems,
    }),
  })
  if (!treeRes.ok) {
    const err = await treeRes.text().catch(() => '')
    throw new GitHubAPIError(treeRes.status, err, '创建 tree 失败')
  }
  const treeData = (await treeRes.json()) as { sha: string }
  const newTreeSha = treeData.sha

  // 5. 创建新 commit
  const newCommitRes = await githubFetch(`/repos/${owner}/${repo}/git/commits`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      tree: newTreeSha,
      parents: [latestCommitSha],
    }),
  })
  if (!newCommitRes.ok) {
    const err = await newCommitRes.text().catch(() => '')
    throw new GitHubAPIError(newCommitRes.status, err, '创建 commit 失败')
  }
  const newCommitData = (await newCommitRes.json()) as { sha: string }
  const newCommitSha = newCommitData.sha

  // 6. 更新 main 分支引用
  const updateRes = await githubFetch(
    `/repos/${owner}/${repo}/git/refs/heads/main`,
    token,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: newCommitSha }),
    },
  )
  if (!updateRes.ok) {
    const err = await updateRes.text().catch(() => '')
    throw new GitHubAPIError(updateRes.status, err, '更新 main 分支失败')
  }

  return {
    commitSha: newCommitSha,
    treeSha: newTreeSha,
  }
}
