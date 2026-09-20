/**
 * workflowClient —— 前端与 GitHub Actions 后端的交互层
 *
 * 所有函数的 event_type 参数，同时也是:
 *   - dispatch payload 里的 event_type（传给 GitHub）
 *   - workflow yml 的 `name:` 字段（run 过滤用）
 *   三者同名，零映射。
 */

import { dispatchWorkflow, readRepoTextFile, githubFetch } from './github'
import type { PipelineStage } from '../stores/taskQueue'

export interface PipelineProgress {
  stage: PipelineStage
  node?: number
  pct?: number
  message?: string
  updated_at?: string
  error?: string | null
  done?: boolean
  /** 失败时后端告知：重试会从哪一阶段继续（已存档的中间产物会被复用） */
  resume_from?: string
  /** 失败时后端告知：已经存档、重试不会重跑的阶段列表 */
  checkpointed?: string[]
}

export interface RunStatus {
  id: number
  status: 'queued' | 'in_progress' | 'completed' | 'failure' | 'cancelled' | string
  conclusion?: string | null
  html_url: string
  created_at: string
  updated_at: string
}

export type WorkflowEvent =
  | 'paper_convert'
  | 'book_convert'
  | 'ai_call'
  | 'mineru_connectivity_test'
  | 'ai_connectivity_test'
  | 'latex_compile'

// ===================== dispatch =====================

export async function dispatchPaperConvert(
  doi: string,
  title: string,
  pdf_path: string,
  owner: string,
  repo: string,
  token: string,
): Promise<void> {
  await dispatchWorkflow('paper_convert', { doi, title, pdf_path }, owner, repo, token)
}

export async function dispatchBookConvert(
  bookId: string,
  title: string,
  pdf_path: string,
  owner: string,
  repo: string,
  token: string,
): Promise<void> {
  await dispatchWorkflow('book_convert', { book_id: bookId, title, pdf_path }, owner, repo, token)
}

export async function dispatchAiCall(
  task_id: string,
  task_type: string,
  input_json: Record<string, any>,
  output_path: string,
  ai_engine: 1 | 2 = 1,
  owner: string,
  repo: string,
  token: string,
): Promise<void> {
  await dispatchWorkflow(
    'ai_call',
    { task_id, task_type, input_json, output_path, ai_engine },
    owner, repo, token,
  )
}

export async function dispatchMineruConnectivityTest(
  owner: string,
  repo: string,
  token: string,
): Promise<void> {
  await dispatchWorkflow('mineru_connectivity_test', {}, owner, repo, token)
}

export async function dispatchAiConnectivityTest(
  owner: string,
  repo: string,
  token: string,
  target: 'ai1' | 'ai2' | 'both' = 'both',
): Promise<void> {
  await dispatchWorkflow('ai_connectivity_test', { target }, owner, repo, token)
}

// ===================== run 查询 =====================

/**
 * 拉最新一次 repository_dispatch run
 *   - eventType 同时匹配 run.name（yml 的 name: 字段）
 *   - GitHub API 的 event 参数只有底层触发源，所有 repository_dispatch 触发的 run 的 event 全是 "repository_dispatch"
 *   - 所以必须先拉一批，再按 run.name 过滤
 *
 * 认证: 默认 Header 模式 (用户实测稳定), githubFetch 内部在 401/403 时
 * 自动 fallback 到 Query 模式 —— 一个调用点覆盖两条通道, 不再手工重试。
 * cache: no-store 已在 githubFetch 内强制设置, 杜绝 SW/HTTP 缓存返回旧 run 列表。
 */
export async function getLatestRun(
  eventType: WorkflowEvent,
  owner: string,
  repo: string,
  token: string,
  minCreatedAt?: string,
): Promise<RunStatus | null> {
  let res: Response
  try {
    res = await githubFetch(
      `/repos/${owner}/${repo}/actions/runs?event=repository_dispatch&per_page=50`,
      token,
    )
  } catch (e) {
    console.warn(`[getLatestRun] ${eventType} 网络异常:`, e)
    return null
  }
  if (!res.ok) {
    console.warn(`[getLatestRun] ${eventType} HTTP ${res.status}`)
    return null
  }
  interface _GhRunLite { id: number; status: string; conclusion: string | null; html_url: string; created_at: string; updated_at: string; name: string }
  const data = (await res.json()) as { workflow_runs?: _GhRunLite[] }
  const all = data.workflow_runs ?? []
  const sameName = all.filter((r) => r.name === eventType)
  const candidate = sameName.find((r) => !minCreatedAt || r.created_at > minCreatedAt)
  console.log(
    `[getLatestRun] ${eventType} 拉到 ${all.length} 个 dispatch run, ` +
    `同名 ${sameName.length} 个${minCreatedAt ? `, 阈值 ${minCreatedAt}` : ''} → ` +
    (candidate ? `命中 #${candidate.id} (${candidate.created_at})` : '无新 run'),
  )
  if (!candidate) return null
  return {
    id: candidate.id,
    status: candidate.status,
    conclusion: candidate.conclusion,
    html_url: candidate.html_url,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
  }
}

export async function getRun(
  id: number,
  owner: string,
  repo: string,
  token: string,
): Promise<RunStatus | null> {
  let res: Response
  try {
    res = await githubFetch(`/repos/${owner}/${repo}/actions/runs/${id}`, token)
  } catch (e) {
    console.warn(`[getRun] #${id} 网络异常:`, e)
    return null
  }
  if (!res.ok) {
    console.warn(`[getRun] #${id} HTTP ${res.status}`)
    return null
  }
  const run = await res.json()
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    html_url: run.html_url,
    created_at: run.created_at,
    updated_at: run.updated_at,
  }
}

// ===================== progress 轮询 =====================

async function readProgressAt(
  progressPath: string,
  owner: string,
  repo: string,
  token: string,
): Promise<PipelineProgress | null> {
  const raw = await readRepoTextFile(owner, repo, progressPath, token).catch(() => null)
  if (!raw) return null
  try { return JSON.parse(raw.content) as PipelineProgress } catch { return null }
}

export async function pollProgressJson(
  slug: string,
  owner: string,
  repo: string,
  token: string,
): Promise<PipelineProgress | null> {
  return readProgressAt(`literatures/${slug}/.progress.json`, owner, repo, token)
}

/** 图书转换进度：textbooks/{bookId}/.progress.json（stage 名与文献 pipeline 一致） */
export async function pollBookProgressJson(
  bookId: string,
  owner: string,
  repo: string,
  token: string,
): Promise<PipelineProgress | null> {
  return readProgressAt(`textbooks/${bookId}/.progress.json`, owner, repo, token)
}

export interface PollOptions {
  intervalMs?: number
  maxAttempts?: number
  signal?: AbortSignal
  onProgress?: (p: PipelineProgress) => void
}

/** 轮询到 done / failed 或超时 */
export async function pollUntilDone(
  slug: string,
  owner: string,
  repo: string,
  token: string,
  opts: PollOptions = {},
): Promise<PipelineProgress | null> {
  const interval = opts.intervalMs ?? 5000
  const maxAttempts = opts.maxAttempts ?? 120
  let last: PipelineProgress | null = null
  for (let i = 0; i < maxAttempts; i++) {
    if (opts.signal?.aborted) return last
    await new Promise(r => setTimeout(r, interval))
    const p = await pollProgressJson(slug, owner, repo, token)
    if (p) {
      last = p
      opts.onProgress?.(p)
      if (p.stage === 'done' || p.stage === 'failed') break
    }
  }
  return last
}
