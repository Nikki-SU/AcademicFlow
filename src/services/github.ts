/**
 * GitHub API 客户端
 * -------------------------------------------------
 * 所有请求都从浏览器直接打到 api.github.com（该端点支持 CORS，允许 *）。
 * 请求头带用户自持的 PAT（Personal Access Token）。
 *
 * 认证策略：
 *   1. Header 模式（标准）：Authorization: Bearer <token> + 自定义头 → 触发 CORS 预检
 *   2. Query 模式（降级）：?access_token=<token> + 零自定义头 → 不触发 CORS 预检
 *      当 Header 模式被网络/VPN/防火墙拦截时，自动降级到 Query 模式。
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

// ═════════════════════════════════════════════════════════════════════════
// 全局串行写队列 —— 所有 GitHub 写入操作自动排队，一个一个来
// 防止并发 GET sha + PUT 造成 409 sha mismatch
// ═════════════════════════════════════════════════════════════════════════

let _writeQueue: Promise<unknown> = Promise.resolve()

/**
 * 把一个写操作加入全局串行队列。
 * 返回 Promise<T> —— 队列中排在它前面的操作全部完成后才会执行。
 * 前一个操作如果 throw，不影响后续操作继续执行（队列永远不卡死）。
 */
function enqueueWrite<T>(op: () => Promise<T>, label?: string): Promise<T> {
  const result = _writeQueue.then(
    () => op(),
    () => op(), // 前一个失败了也照样执行
  )
  // 让队列吞掉当前操作的错误，保证后面的还能继续
  _writeQueue = result.catch(() => {})
  if (label) {
    console.log(`[writeQueue] ← ${label}（队列中，等待前面的写操作完成...）`)
    result.then(
      () => console.log(`[writeQueue] ✅ ${label} 完成`),
      (e) => console.warn(`[writeQueue] ❌ ${label} 失败: ${e instanceof Error ? e.message : e}`),
    )
  }
  return result
}

// ═════════════════════════════════════════════════════════════════════════
// 认证模式管理
// ═════════════════════════════════════════════════════════════════════════

export type AuthMode = 'header' | 'query'

let resolvedAuthMode: AuthMode = 'header'

export function setResolvedAuthMode(mode: AuthMode) {
  resolvedAuthMode = mode
}

export function getResolvedAuthMode(): AuthMode {
  return resolvedAuthMode
}

// ═════════════════════════════════════════════════════════════════════════
// 连通性诊断
// ═════════════════════════════════════════════════════════════════════════

export interface ConnectivityResult {
  /** api.github.com + 自定义头（触发 CORS 预检，测试 Header 模式） */
  apiHeader: 'ok' | 'fail'
  /** api.github.com + 零自定义头（不触发预检，测试 Query 模式路径） */
  apiSimple: 'ok' | 'fail'
  detail: string
}

async function probeApi(withHeaders: boolean): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const init: RequestInit = {
      method: 'GET',
      signal: ctrl.signal,
      cache: 'no-store',
    }
    if (withHeaders) {
      init.headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }
    }
    // withHeaders=true → 带自定义头 → 触发 CORS 预检
    // withHeaders=false → 零自定义头 → 不触发预检
    // GitHub API 对 api.github.com 返回 Access-Control-Allow-Origin: *，所以只要网络通就能读响应
    await fetch(`${API_BASE}/user`, init)
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function testGitHubConnectivity(): Promise<ConnectivityResult> {
  const [headerOk, simpleOk] = await Promise.all([
    probeApi(true),
    probeApi(false),
  ])

  let detail = ''
  if (headerOk && simpleOk) {
    detail = 'GitHub API 连通性完全正常。如果登录仍失败，可能是 token 本身的问题（格式、scope、过期等）。'
  } else if (!headerOk && simpleOk) {
    detail = '✅ api.github.com 可达\n' +
      '❌ CORS 预检被拦截\n\n' +
      '你的网络/VPN 拦截了带自定义头的 CORS 预检请求（OPTIONS 方法）。\n' +
      '系统会自动降级为 Query 参数认证（token 放在 URL 中，不触发预检），登录应当正常。'
  } else if (!headerOk && !simpleOk) {
    detail = '❌ api.github.com 完全不可达\n\n' +
      '你的网络/VPN 完全阻断了对 api.github.com 的访问。\n' +
      '请确认 VPN 配置是否正确，或联系网络管理员放行 api.github.com 的 HTTPS 出站请求。'
  } else {
    detail = '⚠️ 诊断异常：Header 模式可达但简单请求不可达，请联系管理员。'
  }

  return {
    apiHeader: headerOk ? 'ok' : 'fail',
    apiSimple: simpleOk ? 'ok' : 'fail',
    detail,
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 全端点连通性诊断（Settings 页用）
// ═════════════════════════════════════════════════════════════════════════

export interface EndpointProbeResult {
  /** 端点标识 */
  key: string
  /** 显示名称 */
  label: string
  /** 完整 URL */
  url: string
  /** 是否可达 */
  ok: boolean
  /** HTTP 状态码（0 表示网络错误） */
  status: number
  /** 耗时（毫秒） */
  latencyMs: number
  /** 错误信息（失败时） */
  error?: string
}

interface ProbeOptions {
  headers?: Record<string, string>
  timeoutMs?: number
  /** 期待的 HTTP 状态码（默认 200-399） */
  expectedStatusMin?: number
  expectedStatusMax?: number
}

/** 通用 URL 探针 —— fetch + 超时，返回状态码和耗时 */
async function probeUrl(
  url: string,
  opts: ProbeOptions = {},
): Promise<{ ok: boolean; status: number; latencyMs: number; error?: string }> {
  const timeoutMs = opts.timeoutMs ?? 8000
  const expectedMin = opts.expectedStatusMin ?? 200
  const expectedMax = opts.expectedStatusMax ?? 399
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const start = performance.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      cache: 'no-store',
      headers: opts.headers,
      referrerPolicy: 'no-referrer',
    })
    const latencyMs = Math.round(performance.now() - start)
    const ok = res.status >= expectedMin && res.status <= expectedMax
    return { ok, status: res.status, latencyMs }
  } catch (e: unknown) {
    const latencyMs = Math.round(performance.now() - start)
    const errMsg = e instanceof Error ? e.message : String(e)
    const isAbort = e instanceof DOMException && e.name === 'AbortError'
    return {
      ok: false,
      status: 0,
      latencyMs,
      error: isAbort ? `超时（${timeoutMs}ms）` : errMsg,
    }
  } finally {
    clearTimeout(timer)
  }
}

export interface FullConnectivityReport {
  endpoints: EndpointProbeResult[]
  summary: string
  allOk: boolean
  headerModeOk: boolean
  queryModeOk: boolean
  /** 流程级别的成功: 只要有一个模式能通就叫通 (githubFetch 内部有 fallback) */
  flowOk: boolean
}

/**
 * 连通性测试 —— Settings 页使用
 *
 * 有 token 时: 真测 /user 的两种认证方式 (Header Bearer / Query access_token)
 * 无 token 时: 测网络层 (带自定义头触发 CORS 预检 vs 零头简单请求)
 *
 * endpoint key 直接用 'header' / 'query', 和 ConnectivityPanel 的 Step.key 精确对应,
 * 杜绝大小写不一致导致的 "永远匹配不到 → 永远打叉" bug.
 */
export async function testFullGitHubConnectivity(
  token?: string,
): Promise<FullConnectivityReport> {
  type Endpoint = {
    key: 'header' | 'query'
    label: string
    url: string
    opts?: ProbeOptions
  }

  const endpoints: Endpoint[] = token
    ? [
        {
          key: 'header',
          label: 'Header 模式 (Authorization: Bearer xxx)',
          url: `${API_BASE}/user`,
          opts: {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            expectedStatusMin: 200,
            expectedStatusMax: 299,
          },
        },
        {
          key: 'query',
          label: 'Query 模式 (?access_token=xxx)',
          url: `${API_BASE}/user?access_token=${encodeURIComponent(token)}`,
          opts: {
            expectedStatusMin: 200,
            expectedStatusMax: 299,
          },
        },
      ]
    : [
        {
          key: 'header',
          label: 'Header 模式 (带自定义头, 触发 CORS 预检)',
          url: `${API_BASE}/user`,
          opts: {
            headers: {
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            expectedStatusMin: 200,
            expectedStatusMax: 499, // 401 也算"网络通"
          },
        },
        {
          key: 'query',
          label: 'Query 模式 (零自定义头, 不触发预检)',
          url: `${API_BASE}/zen`,
          opts: {
            expectedStatusMin: 200,
            expectedStatusMax: 399,
          },
        },
      ]

  const results = await Promise.all(
    endpoints.map(async (ep) => {
      const r = await probeUrl(ep.url, ep.opts)
      return {
        key: ep.key,
        label: ep.label,
        url: ep.url,
        ...r,
      } satisfies EndpointProbeResult
    }),
  )

  const headerModeOk = results.find((r) => r.key === 'header')?.ok ?? false
  const queryModeOk = results.find((r) => r.key === 'query')?.ok ?? false
  const allOk = results.every((r) => r.ok)
  // 流程是否通：只要有一个认证模式能拿到 2xx, githubFetch 就能跑
  //   - githubFetch 内部已经有 Header → Query 自动 fallback
  //   - 对用户来说 "有一个能用" 就够了
  const flowOk = headerModeOk || queryModeOk

  let summary = ''
  if (token) {
    if (allOk) summary = '✅ GitHub API 流程完全通 (两种认证模式都成功)'
    else if (flowOk) {
      // 只有一个模式成功也不叫"失败"——系统自动用能通的那个
      const onlyHeader = headerModeOk && !queryModeOk
      const onlyQuery = !headerModeOk && queryModeOk
      if (onlyHeader) summary = '✅ GitHub API 可用 (Header 模式成功, Query 模式失败不影响)'
      else if (onlyQuery) summary = '✅ GitHub API 可用 (Header 失败但 Query 模式可用, 已自动降级)'
    } else summary = '❌ GitHub API 完全不可用! token 无效或网络阻断 api.github.com'
  } else {
    if (allOk) summary = '✅ api.github.com 网络正常 (未带 token, 仅测网络层)'
    else if (flowOk) summary = '⚠️ 网络部分受阻 (但至少一种路径可用)'
    else summary = '❌ api.github.com 完全不可达! 请检查 VPN/代理'
  }

  return {
    endpoints: results,
    summary,
    allOk,
    headerModeOk,
    queryModeOk,
    flowOk, // 新增: 流程级别的成功判定
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 核心 API 请求
// ═════════════════════════════════════════════════════════════════════════

export async function githubFetch(
  path: string,
  token: string,
  init: RequestInit = {},
  authMode?: AuthMode,
  isWrite?: boolean,
): Promise<Response> {
  const mode = authMode ?? resolvedAuthMode
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`

  // 自动判断写操作：HTTP method 为 PUT/POST/PATCH/DELETE 或显式传 isWrite=true
  const method = (init.method ?? 'GET').toUpperCase()
  const effectiveIsWrite = isWrite ?? ['PUT', 'POST', 'PATCH', 'DELETE'].includes(method)

  const triggerAuthError = (status: number, detail: string) => {
    if (effectiveIsWrite) {
      setGlobalAuthError(
        `Token 失效或权限不足（${status}：${detail}）。请重新登录或检查 PAT 权限。`,
      )
    } else {
      // 读请求 401/403 只记日志，不冻结写操作（避免一次 GET 抖动永久锁死应用）
      console.warn(`[githubFetch] 读请求 ${init.method ?? 'GET'} ${path} 返回 ${status}: ${detail}`)
    }
  }

  if (mode === 'header') {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    headers.set('Accept', 'application/vnd.github+json')
    headers.set('X-GitHub-Api-Version', '2022-11-28')
    const res = await fetch(url, { cache: 'no-store', ...init, headers })
    if (res.status === 401 || res.status === 403) {
      // ⚠️ Header 模式失败 → 自动 fallback 到 Query 模式
      // 有些 PAT / GitHub Enterprise / 特定环境对 Header 认证有限制,
      // 但 Query 参数模式通常都能通。
      console.warn(`[githubFetch] Header 模式 ${res.status}, 自动 fallback 到 Query 模式`)
      const sep = url.includes('?') ? '&' : '?'
      const fallbackUrl = `${url}${sep}access_token=${encodeURIComponent(token)}`
      const safeInit = { cache: 'no-store' as RequestCache, ...init }
      delete safeInit.headers
      const fallbackRes = await fetch(fallbackUrl, safeInit)
      if (fallbackRes.status === 401 || fallbackRes.status === 403) {
        let detail = `GitHub 返回 ${fallbackRes.status}`
        try {
          const data = await fallbackRes.clone().json()
          if (data?.message) detail = data.message
        } catch {
          // ignore
        }
        triggerAuthError(fallbackRes.status, detail)
      }
      return fallbackRes
    }
    return res
  }

  // Query 参数模式：零自定义头 → 绝对不触发 CORS 预检
  const sep = url.includes('?') ? '&' : '?'
  const urlWithToken = `${url}${sep}access_token=${encodeURIComponent(token)}`
  const safeInit = { cache: 'no-store' as RequestCache, ...init }
  delete safeInit.headers
  const res = await fetch(urlWithToken, safeInit)
  if (res.status === 401 || res.status === 403) {
    let detail = `GitHub 返回 ${res.status}`
    try {
      const data = await res.clone().json()
      if (data?.message) detail = data.message
    } catch {
      // ignore
    }
    triggerAuthError(res.status, detail)
  }
  return res
}

export function parseScopes(res: Response): string[] {
  const raw = res.headers.get('X-OAuth-Scopes') || ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// ═════════════════════════════════════════════════════════════════════════
// PAT 验证
// ═════════════════════════════════════════════════════════════════════════

export async function verifyPAT(token: string): Promise<PATVerifyResult> {
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

  // 自动降级：先试 Header，失败自动转 Query
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

  const response = res!

  if (!response.ok) {
    let msg = `HTTP ${response.status}`
    try {
      const data = await response.json()
      if (data?.message) msg = data.message
    } catch {
      // ignore
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

  let expiresAt: number | undefined
  const tokenExpiration = response.headers.get('github-authentication-token-expiration')
  if (tokenExpiration) {
    const parsed = new Date(tokenExpiration).getTime()
    if (!isNaN(parsed)) expiresAt = parsed
  }

  return { user, scopes, rateLimitRemaining, expiresAt, authMode: usedAuthMode }
}

// ═════════════════════════════════════════════════════════════════════════
// PAT 创建 URL
// ═════════════════════════════════════════════════════════════════════════

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
// M2: workspace 私库操作
// ═════════════════════════════════════════════════════════════════════════

import type { GitHubRepo } from '../types'
import type { SkeletonFile } from '../constants/skeleton'

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

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function base64ToUtf8(base64: string): string {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i)
  }
  return new TextDecoder('utf-8').decode(bytes)
}

// 原始二进制 → base64（用于上传 PDF / 图片等二进制文件）
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

// base64 → Uint8Array（用于下载后还原二进制文件）
function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

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

export async function initEmptyRepoSkeleton(
  owner: string,
  repo: string,
  files: SkeletonFile[],
  message: string,
  token: string,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const base = `/repos/${owner}/${repo}`

  onProgress?.('检测仓库状态…')
  const empty = await isRepoEmpty(owner, repo, token)

  let baseCommitSha: string
  let baseTreeSha: string
  let filesToUpload: SkeletonFile[]

  if (empty) {
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
    filesToUpload = files.slice(1)
  } else {
    onProgress?.('拉取 main HEAD…')
    const refRes = await githubFetch(`${base}/git/refs/heads/main`, token)
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
    filesToUpload = files
  }

  if (filesToUpload.length === 0) {
    onProgress?.(`完成，commit：${baseCommitSha.slice(0, 8)}`)
    return baseCommitSha
  }

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
// md/csv 文件读写
// ═════════════════════════════════════════════════════════════════════════

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

/** 下载二进制文件（PDF / 图片等），返回 Blob */
export async function downloadRepoBinaryFile(
  owner: string,
  repo: string,
  path: string,
  token: string,
  mime = 'application/octet-stream',
): Promise<{ blob: Blob; sha: string; size: number } | null> {
  const res = await githubFetch(
    `/repos/${owner}/${repo}/contents/${encodeURI(path)}`,
    token,
  )
  if (res.status === 404) return null
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new GitHubAPIError(res.status, err, `下载二进制文件失败：${err}`)
  }
  const data = (await res.json()) as { content: string; sha: string; encoding: string; size?: number }
  const bytes = base64ToBytes(data.content.replace(/\n/g, ''))
  return {
    blob: new Blob([bytes as BlobPart], { type: mime }),
    sha: data.sha,
    size: data.size ?? bytes.length,
  }
}

/** 上传二进制文件（PDF / 图片等），返回 sha。内部用串行写队列避免 409 */
export async function uploadRepoBinaryFile(
  owner: string,
  repo: string,
  path: string,
  file: File | Blob,
  token: string,
  message?: string,
): Promise<string> {
  return enqueueWrite(async () => {
    assertCanWrite()
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    const b64 = bytesToBase64(bytes)

    // 和 writeRepoTextFile 一样的 sha mismatch 重试逻辑
    const deadline = Date.now() + 5 * 60 * 1000

    for (let attempt = 1; ; attempt++) {
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
        // 文件不存在
      }

      const body: Record<string, unknown> = {
        message: message || `Upload ${path.split('/').pop()}`,
        content: b64,
        branch: 'main',
      }
      if (existingSha) body.sha = existingSha

      const res = await githubFetch(
        `/repos/${owner}/${repo}/contents/${encodeURI(path)}`,
        token,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )

      if (res.ok) {
        const result = (await res.json()) as { content: { sha: string } }
        return result.content.sha
      }

      const err = await res.text().catch(() => '')
      const isShaMismatch =
        res.status === 409 ||
        (res.status === 422 && /sha/.test(err)) ||
        /does not match/.test(err)

      if (!isShaMismatch || Date.now() > deadline) {
        throw new GitHubAPIError(res.status, err, `上传二进制文件失败：${err}`)
      }

      const wait = Math.min(200 * Math.pow(2, attempt - 1), 5000)
      await new Promise((r) => setTimeout(r, wait))
    }
  }, `upload binary ${path}`)
}

export async function writeRepoTextFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  token: string,
  message?: string,
): Promise<string> {
  return enqueueWrite(async () => {
    assertCanWrite()
    const encoded = utf8ToBase64(content)

    // 409 sha mismatch / 422 sha 校验失败 → 无限重试（指数退避，封顶 5s）
    // 硬保护：5 分钟超时自动放弃，防止死循环
    const deadline = Date.now() + 5 * 60 * 1000

    for (let attempt = 1; ; attempt++) {
      // --- Step 1: GET 最新 sha ---
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

      // --- Step 2: PUT ---
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

      if (res.ok) {
        const result = (await res.json()) as { content: { sha: string } }
        return result.content.sha
      }

      // --- Step 3: 判断错误类型 ---
      const err = await res.text().catch(() => '')
      const isShaMismatch =
        res.status === 409 ||
        (res.status === 422 && err.includes('does not match'))

      if (!isShaMismatch) {
        // 非 sha 问题直接抛（401 token 失效、404 repo 不存在等）
        throw new GitHubAPIError(res.status, err, `写入文件失败：${err}`)
      }

      // 超时保护
      if (Date.now() > deadline) {
        throw new GitHubAPIError(
          408,
          '并发竞争超时（5 分钟内未能写入）',
          `写入 ${path} 失败：多个进程同时修改，重试超时`,
        )
      }

      // 指数退避：200ms → 400ms → 800ms → ... → 封顶 5s
      const delay = Math.min(200 * Math.pow(2, attempt - 1), 5000)
      if (attempt === 1) {
        console.warn(
          `[writeRepoTextFile] ${path} 发生并发竞争，开始重试（第 1 次，等 ${delay}ms）`,
        )
      } else if (attempt % 3 === 0) {
        console.warn(
          `[writeRepoTextFile] ${path} 仍在竞争中（第 ${attempt} 次）`,
        )
      }
      await new Promise((r) => setTimeout(r, delay))
      // 继续下一轮循环
    }
  }, `write ${path}`)
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
 * 用 Git Blob API 单独上传一个 blob
 * 单个 blob 最大 100MB（GitHub 硬限制，足够装 MinerU 图片和 markdown）
 * 返回 blob sha，后续 tree 用 sha 引用就不会爆 Tree API 的 JSON body 限制
 */
async function createBlob(
  owner: string,
  repo: string,
  token: string,
  contentB64: string,
  encoding: 'base64' | 'utf-8' = 'base64',
): Promise<{ sha: string; url: string }> {
  const res = await githubFetch(`/repos/${owner}/${repo}/git/blobs`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: contentB64, encoding }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new GitHubAPIError(res.status, err, `创建 blob 失败 (${res.status})`)
  }
  return (await res.json()) as { sha: string; url: string }
}

/**
 * 用 Tree API 做"读-改-写"原子操作
 *
 * 并发竞争策略：**排队等，不放弃**。遇到 409/422（sha mismatch / ref 过期）时：
 *   - 重新拉 main HEAD 和 base_tree（所以前一个任务 commit 之后，下一个自动能看到新 sha）
 *   - 指数退避：200ms → 400ms → 800ms → 1600ms → 封顶 5s
 *   - 最长等待 5 分钟硬超时保护（防止网络彻底断了死循环）
 *   - 非竞争类错误（401/403/500）直接抛出，不重试
 */
async function runTreeTransaction(
  owner: string,
  repo: string,
  token: string,
  message: string,
  buildTreeItems: () => Array<{
    path: string
    mode: '100644'
    type: 'blob'
    content?: string
    encoding?: 'base64'
    sha?: string | null
  }>,
  label: string,
): Promise<BatchWriteResult> {
  const START = Date.now()
  const HARD_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟硬超时
  const MAX_BACKOFF_MS = 5000
  let attempt = 0

  // 只在 attempt === 0 时返回"这个竞争错误应该重试"，否则都应该重试
  const shouldRetry = (err: unknown): boolean => {
    if (err instanceof GitHubAPIError) {
      // 401/403 → token 有问题，不重试
      if (err.status === 401 || err.status === 403) return false
      // 404 → 仓库/路径不存在，不重试
      if (err.status === 404) return false
      // 422/409 → 竞争/sha mismatch，重试
      if (err.status === 409 || err.status === 422) return true
      // 5xx → GitHub 服务器问题，也重试（等它恢复）
      if (err.status >= 500 && err.status < 600) return true
      // 其他 → 默认重试（保险起见）
      return true
    }
    // 非 GitHubAPIError（网络超时、fetch 异常等）→ 重试
    return true
  }

  while (true) {
    attempt++
    try {
      const elapsed = Date.now() - START
      if (elapsed > HARD_TIMEOUT_MS) {
        throw new Error(
          `[${label}] 竞争重试耗尽（已等 ${Math.round(elapsed / 1000)}s，超过 5 分钟硬超时）`,
        )
      }
      if (attempt > 1) {
        console.log(
          `[${label}] 第 ${attempt} 次尝试（已等 ${Math.round(elapsed / 1000)}s，队列中...）`,
        )
      }

      // 1. 拉 main HEAD
      const refRes = await githubFetch(`/repos/${owner}/${repo}/git/refs/heads/main`, token)
      if (!refRes.ok) {
        const err = await refRes.text().catch(() => '')
        throw new GitHubAPIError(refRes.status, err, '获取 main 分支引用失败')
      }
      const refData = (await refRes.json()) as { object: { sha: string } }
      const latestCommitSha = refData.object.sha

      // 2. 拉 commit → 拿 base_tree
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

      // 3. 创建新 tree
      const treeItems = buildTreeItems()
      const treeRes = await githubFetch(`/repos/${owner}/${repo}/git/trees`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems }),
      })
      if (!treeRes.ok) {
        const err = await treeRes.text().catch(() => '')
        throw new GitHubAPIError(treeRes.status, err, '创建 tree 失败')
      }
      const treeData = (await treeRes.json()) as { sha: string }
      const newTreeSha = treeData.sha

      // 4. 创建 commit
      const newCommitRes = await githubFetch(`/repos/${owner}/${repo}/git/commits`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, tree: newTreeSha, parents: [latestCommitSha] }),
      })
      if (!newCommitRes.ok) {
        const err = await newCommitRes.text().catch(() => '')
        throw new GitHubAPIError(newCommitRes.status, err, '创建 commit 失败')
      }
      const newCommitData = (await newCommitRes.json()) as { sha: string }
      const newCommitSha = newCommitData.sha

      // 5. 更新 ref
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

      if (attempt > 1) {
        console.log(
          `[${label}] ✅ 成功！第 ${attempt} 次尝试，commit=${newCommitSha.slice(0, 7)}，总耗时 ${Math.round((Date.now() - START) / 1000)}s`,
        )
      }
      return { commitSha: newCommitSha, treeSha: newTreeSha }
    } catch (err) {
      if (!shouldRetry(err)) {
        // 非竞争错误，直接抛
        throw err instanceof Error ? err : new Error(String(err))
      }
      const backoff = Math.min(200 * Math.pow(2, attempt - 1), MAX_BACKOFF_MS)
      if (attempt <= 2 || attempt % 5 === 0) {
        console.warn(
          `[${label}] 竞争/错误 → ${backoff}ms 后重试...`,
          err instanceof Error ? err.message : String(err),
        )
      }
      await new Promise((r) => setTimeout(r, backoff))
      continue
    }
  }
}

/**
 * 批量写入/更新仓库内文件
 *
 * 架构：先把每个文件通过 Git Blob API 单独上传（单个 blob 最大 100MB，真正无大小限制），
 * 拿到 sha 后再用 Tree API 做原子 tree + commit + ref 更新。
 * 这样 Tree API 的 JSON body 里只剩 path + sha，彻底避开 Tree API 的隐式 body 大小限制。
 *
 * 并发竞争时 base_tree 或 ref 过期（422/409）会自动重试 3 次。
 */
export async function writeFileBatch(
  ops: BatchFileOp[],
  message: string,
  owner: string,
  repo: string,
  token: string,
): Promise<BatchWriteResult> {
  return enqueueWrite(async () => {
    assertCanWrite()

    // Step 1: 并行上传所有 blob，拿 sha
    const blobResults = await Promise.all(
      ops.map(async (op) => {
        const isUtf8 = op.encoding === 'utf-8'
        const b64 = isUtf8 ? utf8ToBase64(op.content) : op.content
        console.log(
          `[writeFileBatch] upload blob: ${op.path} (${(b64.length * 0.75 / 1024).toFixed(1)} KB base64)`,
        )
        const blob = await createBlob(owner, repo, token, b64, 'base64')
        return { path: op.path, sha: blob.sha }
      }),
    )

    console.log(`[writeFileBatch] 所有 blob 上传完成，共 ${blobResults.length} 个`)

    // Step 2: tree 只引用 sha（body 只有几 KB，不受大小限制）
    return runTreeTransaction(
      owner,
      repo,
      token,
      message,
      () =>
        blobResults.map(({ path, sha }) => ({
          path,
          mode: '100644' as const,
          type: 'blob' as const,
          sha,
        })),
      'writeFileBatch',
    )
  }, `batch write ${ops.length} files`)
}

/**
 * 批量删除仓库内文件（Tree API sha: null 语义 + 并发重试）
 * paths: 相对仓库根目录的文件路径数组（如 "literatures/A/fulltext.md"）
 * 目录会被自动清理（Tree API 不支持删目录，只删文件）
 */
export async function deleteRepoFiles(
  paths: string[],
  message: string,
  owner: string,
  repo: string,
  token: string,
): Promise<BatchWriteResult> {
  return enqueueWrite(async () => {
    assertCanWrite()

    return runTreeTransaction(
      owner,
      repo,
      token,
      message,
      () =>
        paths.map((path) => ({
          path,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: null,
        })),
      'deleteRepoFiles',
    )
  }, `delete ${paths.length} files`)
}

export async function dispatchWorkflow(
  eventType: string,
  payload: Record<string, any>,
  owner: string,
  repo: string,
  token: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${owner}/${repo}/dispatches`
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
  })
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    throw new Error(`dispatch ${eventType} failed: ${resp.status} ${txt.slice(0, 200)}`)
  }
  console.log(`[dispatch] ${eventType} sent ? /repos/${owner}/${repo}/actions`)
}
