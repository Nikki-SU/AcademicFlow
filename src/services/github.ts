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
