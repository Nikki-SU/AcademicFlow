/**
 * workflowClient —— 前端与 GitHub Actions 后端的交互层
 *
 * 所有函数的 event_type 参数，同时也是:
 *   - dispatch payload 里的 event_type（传给 GitHub）
 *   - workflow yml 的 `name:` 字段（run 过滤用）
 *   三者同名，零映射。
 */

import { dispatchWorkflow, readRepoTextFile, writeRepoTextFile, githubFetch } from './github'
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

/**
 * repository_dispatch 的 client_payload 硬上限是 64 KB（超了 GitHub 直接 422
 * `client_payload is too large`，任务根本不会起）。留出 JSON 外层包装的余量。
 */
const DISPATCH_PAYLOAD_LIMIT = 48 * 1024

/**
 * 触发 ai_call。
 *
 * input_json 里装的是整篇正文级别的源材料（写作页转 LaTeX、可信检索都是），
 * 一篇长稿轻易超过 64 KB —— 内联进 client_payload 就会被 GitHub 拒掉。
 * 所以超过阈值时改走「大输入落盘」：先把 input_json 写进仓库，
 * dispatch 只带 input_path，后端从自己的 checkout 里读（见 ai_call.mjs）。
 * 小输入仍然内联，保持链路最短。
 */
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
  const base = { task_id, task_type, output_path, ai_engine }
  const inlinePayload = { ...base, input_json }

  if (JSON.stringify(inlinePayload).length <= DISPATCH_PAYLOAD_LIMIT) {
    await dispatchWorkflow('ai_call', inlinePayload, owner, repo, token)
    return
  }

  const inputPath = `temp/ai/incoming/${task_id}.json`
  await writeRepoTextFile(
    owner, repo, inputPath, JSON.stringify(input_json),
    token, `chore(ai): stash oversized input for ${task_id}`,
  )
  await dispatchWorkflow('ai_call', { ...base, input_path: inputPath }, owner, repo, token)
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

/** 取消一个 run（用户点「停止」用）。失败只返回 false，不抛 —— 停止本身不该因为取消失败而失败 */
export async function cancelRun(
  id: number,
  owner: string,
  repo: string,
  token: string,
): Promise<boolean> {
  try {
    const res = await githubFetch(
      `/repos/${owner}/${repo}/actions/runs/${id}/cancel`,
      token,
      { method: 'POST' },
    )
    if (!res.ok) console.warn(`[cancelRun] #${id} HTTP ${res.status}`)
    return res.ok
  } catch (e) {
    console.warn(`[cancelRun] #${id} 异常:`, e)
    return false
  }
}

/**
 * 取消「某个 dispatch 之后新建的、同名 workflow 的 run」。
 *
 * run 出现在列表里有一点延迟（dispatch 刚发出时可能还查不到），所以退避重试几次；
 * 全程只做尽力而为，找不到就放弃。
 */
export async function cancelLatestRun(
  eventType: WorkflowEvent,
  owner: string,
  repo: string,
  token: string,
  sinceIso?: string,
): Promise<boolean> {
  const active = ['queued', 'requested', 'waiting', 'pending', 'in_progress']
  for (let i = 0; i < 3; i++) {
    const run = await getLatestRun(eventType, owner, repo, token, sinceIso)
    if (run && active.includes(run.status)) {
      const ok = await cancelRun(run.id, owner, repo, token)
      if (ok) {
        console.log(`[cancelLatestRun] ${eventType} #${run.id} 已请求取消`)
        return true
      }
    }
    if (i < 2) await new Promise((r) => setTimeout(r, 2000))
  }
  return false
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
