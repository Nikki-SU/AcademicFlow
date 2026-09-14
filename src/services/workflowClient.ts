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
  conclusion?: string | null   // GitHub API 可能新增值（如 startup_failure），不硬编码联合类型
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

export async function dispatchMineruTest(
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
 * 后端 dispatch 事件类型 → workflow yml 的 `name:` 字段映射
 *
 * GitHub Actions API 的 /actions/runs?event= 参数值是底层触发源
 *   （push / pull_request / repository_dispatch / workflow_dispatch 等），
 *   不是我们 payload 里的自定义 event_type。
 * 所以 repository_dispatch 触发的所有 run 在 API 里 event 全是 "repository_dispatch"，
 *   无法直接按 event_type 过滤。必须先拉最近一批，再按 workflow name 筛。
 */
const EVENT_TYPE_TO_WORKFLOW_NAME = {
  paper_convert:            'Paper Pipeline',
  ai_call:                  'AI Service',
  mineru_connectivity_test: 'MinerU Connectivity Test',
  ai_connectivity_test:     'AI Connectivity Test',
} as const

/**
 * 拉最新一次 repository_dispatch run（按 created_at 降序）
 *   - eventType 只用来匹配 workflow name（API event 参数全是 "repository_dispatch"）
 *   - minCreatedAt 如果给了，只返回 created_at > 这个值的 run（用来避开 dispatch 前的旧 run）
 */
export async function getLatestRun(
  eventType: keyof typeof EVENT_TYPE_TO_WORKFLOW_NAME,
  owner: string,
  repo: string,
  token: string,
  minCreatedAt?: string,
): Promise<RunStatus | null> {
  const workflowName = EVENT_TYPE_TO_WORKFLOW_NAME[eventType]
  const res = await githubFetch(
    `/repos/${owner}/${repo}/actions/runs?event=repository_dispatch&per_page=50`,
    token,
  )
  if (!res.ok) return null
  interface _GhRunLite { id: number; status: string; conclusion: string | null; html_url: string; created_at: string; updated_at: string; name: string }
  const data = (await res.json()) as { workflow_runs?: _GhRunLite[] }
  // 按 created_at 降序（API 默认），过滤掉 minCreatedAt 之前的旧 run
  const candidate = data.workflow_runs?.find((r) => {
    if (r.name !== workflowName) return false
    if (minCreatedAt && r.created_at <= minCreatedAt) return false
    return true
  })
  if (!candidate) return null
  return {
    run_id: candidate.id,
    status: candidate.status,
    conclusion: candidate.conclusion,
    html_url: candidate.html_url,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
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
  const raw = await readRepoTextFile(
    owner, repo, `literatures/${slug}/.progress.json`, token,
  ).catch(() => null)
  if (!raw) return null
  try { return JSON.parse(raw.content) as PipelineProgress } catch { return null }
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
