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
// 核心 API 请求
// ═════════════════════════════════════════════════════════════════════════

export async function githubFetch(
  path: string,
  token: string,
  init: RequestInit = {},
  authMode?: AuthMode,
): Promise<Response> {
  const mode = authMode ?? resolvedAuthMode
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`

  if (mode === 'header') {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    headers.set('Accept', 'application/vnd.github+json')
    headers.set('X-GitHub-Api-Version', '2022-11-28')
    const res = await fetch(url, { ...init, headers })
    if (res.status === 401 || res.status === 403) {
      let detail = `GitHub 返回 ${res.status}`
      try {
        const data = await res.clone().json()
        if (data?.message) detail = data.message
      } catch {
        // ignore
      }
      setGlobalAuthError(
        `Token 失效或权限不足（${res.status}：${detail}）。请重新登录或检查 PAT 权限。`,
      )
    }
    return res
  }

  // Query 参数模式：零自定义头 → 绝对不触发 CORS 预检
  const sep = url.includes('?') ? '&' : '?'
  const urlWithToken = `${url}${sep}access_token=${encodeURIComponent(token)}`
  const safeInit = { ...init }
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
    setGlobalAuthError(
      `Token 失效或权限不足（${res.status}：${detail}）。请重新登录或检查 PAT 权限。`,
    )
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
// Device Flow 认证
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

export type PollDeviceTokenResult =
  | { type: 'token'; token: TokenResponse }
  | { type: 'pending'; interval: number }

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

export async function writeFileBatch(
  ops: BatchFileOp[],
  message: string,
  owner: string,
  repo: string,
  token: string,
): Promise<BatchWriteResult> {
  assertCanWrite()

  const refRes = await githubFetch(`/repos/${owner}/${repo}/git/ref/heads/main`, token)
  if (!refRes.ok) {
    const err = await refRes.text().catch(() => '')
    throw new GitHubAPIError(refRes.status, err, '获取 main 分支引用失败')
  }
  const refData = (await refRes.json()) as { object: { sha: string } }
  const latestCommitSha = refData.object.sha

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
