/**
 * workflowClient —— 前端与 GitHub Actions 后端的交互层
 *
 * 三件事：
 *   1. dispatchPipeline / dispatchAi  → 触发 workflow
 *   2. getLatestRun                   → 查最近一次 run 状态
 *   3. pollProgressJson               → 轮询 progress.json
 */

import { dispatchWorkflow, readRepoTextFile, githubFetch } from './github'

export interface PipelineProgress {
  stage: string
  node?: number
  pct?: number
  message?: string
  updated_at?: string
  error?: string | null
  done?: boolean
}

export interface RunStatus {
  run_id: number
  status: 'queued' | 'in_progress' | 'completed' | 'failure' | 'cancelled' | string
  conclusion?: 'success' | 'failure' | 'cancelled' | 'skipped' | null
  html_url: string
  created_at: string
  updated_at: string
}

// ===================== dispatch =====================

export async function dispatchPipeline(
  doi: string,
  title: string,
  pdf_path: string,
  owner: string,
  repo: string,
  token: string,
): Promise<void> {
  await dispatchWorkflow('paper_convert', { doi, title, pdf_path }, owner, repo, token)
}

export async function dispatchAi(
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

// ===================== run 查询 =====================

export async function getLatestRun(
  eventType: 'paper_convert' | 'ai_call',
  owner: string,
  repo: string,
  token: string,
): Promise<RunStatus | null> {
  const res = await githubFetch(
    `/repos/${owner}/${repo}/actions/runs?event=${eventType}&per_page=1`,
    token,
  )
  if (!res.ok) return null
  const data = (await res.json()) as { workflow_runs?: any[] }
  const run = data.workflow_runs?.[0]
  if (!run) return null
  return {
    run_id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    html_url: run.html_url,
    created_at: run.created_at,
    updated_at: run.updated_at,
  }
}

export async function getRun(
  runId: number,
  owner: string,
  repo: string,
  token: string,
): Promise<RunStatus | null> {
  const res = await githubFetch(
    `/repos/${owner}/${repo}/actions/runs/${runId}`,
    token,
  )
  if (!res.ok) return null
  const run = await res.json()
  return {
    run_id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    html_url: run.html_url,
    created_at: run.created_at,
    updated_at: run.updated_at,
  }
}

// ===================== progress 轮询 =====================

/**
 * 读 literatures/{slug}/.progress.json
 *   - 不存在 → 返回 null（任务还没开始或已清理）
 *   - 存在   → parse 成 PipelineProgress
 *   - done/failed → 调用方停止轮询
 */
export async function pollProgressJson(
  slug: string,
  owner: string,
  repo: string,
  token: string,
): Promise<PipelineProgress | null> {
  const content = await readRepoTextFile(
    owner, repo, `literatures/${slug}/.progress.json`, token,
  ).catch(() => null)
  if (!content) return null
  try { return JSON.parse(content) as PipelineProgress } catch { return null }
}

export interface PollOptions {
  intervalMs?: number
  maxAttempts?: number
  signal?: AbortSignal
  onProgress?: (p: PipelineProgress) => void
}

/**
 * 轮询到 done / failed 或超时
 * 返回最终 progress（或 null 如果从未出现）
 */
export async function pollUntilDone(
  slug: string,
  owner: string,
  repo: string,
  token: string,
  opts: PollOptions = {},
): Promise<PipelineProgress | null> {
  const interval = opts.intervalMs ?? 5000
  const maxAttempts = opts.maxAttempts ?? 120 // 5s × 120 = 10min
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
