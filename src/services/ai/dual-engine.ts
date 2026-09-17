/**
 * AI 双引擎编排（M3.6）—— GitHub Actions 后端版
 *
 * 前端现在只做三件事：
 *   1. dispatch ai_call workflow（task_type=dual_engine）
 *   2. poll 结果文件直到后端 commit 完成
 *   3. 把 JSON 反序列化成 DualEngineResult 返回给调用方
 *
 * 实际的 M3.6 分层归因 + 引证锚定逻辑跑在后端 runner 上：
 *   .github/scripts/dual-engine-runner.mjs
 *   .github/scripts/ai-service.mjs (dual_engine handler)
 *
 * 接口签名保持不变 —— 所有调用方（Learn/Writing/cover-figure/guideline-extractor/latex-converter/stores）零改动。
 */
import type {
  DualEngineRunParams,
  DualEngineResult,
  DualEngineProgressCallback,
} from '../../types'
import { dispatchAiCall } from '../workflowClient'
import { readRepoTextFile } from '../github'
import { useAuthStore } from '../../stores/auth'
import { useWorkspaceStore } from '../../stores/workspace'

/** 后端结果文件的 output_path 模板 —— 临时文件，不需要用户管理 */
function buildOutputPath(taskType: string): string {
  const ts = Date.now()
  return `temp/ai/dual_engine/${taskType}_${ts}.json`
}

/** 把后端 dual_engine-runner 的 JSON 输出转成前端 DualEngineResult */
function parseBackendResult(raw: string): DualEngineResult {
  const parsed = JSON.parse(raw)
  // ai-service.mjs 输出格式: { task_id, task_type, data: <DualEngineResult>, ...done, completed_at }
  if (parsed.error) {
    throw new Error(`后端 dual_engine 失败: ${parsed.error}`)
  }
  const data = parsed.data || parsed
  return data as DualEngineResult
}

/**
 * 轮询 output_path 直到文件出现且可解析
 * 后端 commit 文件需要几秒，所以间隔 3s，最多等 20 分钟
 */
async function pollResultFile(
  outputPath: string,
  owner: string,
  repo: string,
  token: string,
  onProgress?: DualEngineProgressCallback,
): Promise<DualEngineResult> {
  const maxAttempts = 400 // 3s × 400 = 20min
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    try {
      const result = await readRepoTextFile(owner, repo, outputPath, token)
      if (result) {
        return parseBackendResult(result.content)
      }
    } catch {
      // 文件还没 commit，继续等
    }
    // 每 10 次轮询（30s）发一次轻量 progress
    if (i % 10 === 0 && i > 0) {
      onProgress?.({
        stage: 'ai1_running',
        attempt: 1,
        maxAttempts: 5,
        reason: 'first_run',
      })
    }
  }
  throw new Error('双引擎后端任务超时（20 分钟未返回结果）')
}

export async function runDualEngine(
  params: DualEngineRunParams,
): Promise<DualEngineResult> {
  const { token, user } = useAuthStore.getState()
  const repoName = useWorkspaceStore.getState().repo?.name
  const owner = user?.login

  if (!token || !owner || !repoName) {
    throw new Error('未登录或私库未配置 — 无法触发后端 AI 服务')
  }

  const outputPath = buildOutputPath(params.taskType)
  const taskId = `dual_engine_${params.taskType}_${Date.now()}`

  // 构造给后端的 input_json
  // ai1/ai2 可选 — DualEngineTestPanel 会传（用户在 Settings 页改了 Key）；不传则 runner 用 GitHub Secrets
  const inputJson = {
    taskType: params.taskType,
    sourceMaterial: params.sourceMaterial,
    ai1Instruction: params.ai1Instruction,
    ai1RolePrompt: params.ai1RolePrompt,
    maxAttempts: params.maxAttempts,
    ai1: params.ai1,
    ai2: params.ai2,
  }

  // 通知 UI "后端任务已触发"
  params.onProgress?.({
    stage: 'attempt_start',
    attempt: 1,
    maxAttempts: params.maxAttempts ?? 5,
    reason: 'first_run',
  })
  params.onProgress?.({
    stage: 'ai1_running',
    attempt: 1,
    maxAttempts: params.maxAttempts ?? 5,
    reason: 'first_run',
  })

  // dispatch
  await dispatchAiCall(taskId, 'dual_engine', inputJson, outputPath, 1, owner, repoName, token)

  // poll 结果
  const result = await pollResultFile(outputPath, owner, repoName, token, params.onProgress)

  // finished
  params.onProgress?.({
    stage: 'finished',
    attempt: result.attempts.length,
    maxAttempts: result.maxAttempts,
    reason: result.finalPassed ? 'first_run' : 'ai1_rewrite',
  })

  return result
}
