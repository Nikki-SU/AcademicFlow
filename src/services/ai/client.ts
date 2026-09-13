/**
 * AI 服务底层客户端 — 已迁 GitHub Actions 后端
 *
 * 前端只做：dispatch + poll + 解析结果。
 * 实际 AI 调用跑在 ai-service.mjs chat handler 上。
 * baseUrl / apiKey / model 在 runner 里从 GitHub Actions Secrets 拿，
 * 前端传了也会被忽略（保留参数只是为了接口签名不变）。
 */
import type { AIRequest, AIResponse } from '../../types'
import { dispatchAi } from '../workflowClient'
import { readRepoTextFile } from '../github'
import { useAuthStore } from '../../stores/auth'
import { useWorkspaceStore } from '../../stores/workspace'

// ═════════════════════════════════════════════════════════════════════
// Error classes — 仍然用于 models.ts 的前端直连查询（拉模型清单 / 查余额）
// ═════════════════════════════════════════════════════════════════════

export class AIError extends Error {
  status: number
  providerMessage: string
  constructor(status: number, providerMessage: string, friendly?: string) {
    super(friendly || providerMessage)
    this.name = 'AIError'
    this.status = status
    this.providerMessage = providerMessage
  }
}
export class AIAuthError extends AIError {
  constructor(msg: string) { super(401, msg, 'AI 服务凭据无效或已过期'); this.name = 'AIAuthError' }
}
export class AIQuotaError extends AIError {
  constructor(msg: string) { super(402, msg, 'AI 服务余额不足'); this.name = 'AIQuotaError' }
}
export class AIPermissionError extends AIError {
  constructor(msg: string) { super(403, msg, 'AI 服务权限受限'); this.name = 'AIPermissionError' }
}
export class AIRateLimitError extends AIError {
  constructor(msg: string) { super(429, msg, 'AI 服务触发限流'); this.name = 'AIRateLimitError' }
}
export class AINetworkError extends AIError {
  constructor(msg: string) { super(0, msg, 'AI 服务网络异常'); this.name = 'AINetworkError' }
}
export class AIClientError extends AIError {
  constructor(status: number, msg: string) { super(status, msg); this.name = 'AIClientError' }
}
export class AITimeoutError extends AIError {
  timeoutMs: number
  constructor(timeoutMs: number) {
    super(0, `AI request timed out after ${timeoutMs}ms`, `AI 请求超时（${(timeoutMs / 1000).toFixed(0)}s）`)
    this.name = 'AITimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** 构造唯一的 output_path */
function buildOutputPath(): string {
  return `temp/ai/chat/call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`
}

/** 轮询 output_path 直到出现 + 可解析 */
async function pollResult(
  outputPath: string,
  owner: string,
  repo: string,
  token: string,
  signal?: AbortSignal,
): Promise<AIResponse> {
  const maxAttempts = 200 // 3s × 200 = 10min
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) {
      throw new DOMException('用户取消', 'AbortError')
    }
    await new Promise((r) => setTimeout(r, 3000))
    if (signal?.aborted) {
      throw new DOMException('用户取消', 'AbortError')
    }
    try {
      const raw = await readRepoTextFile(owner, repo, outputPath, token)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed.error) throw new Error(`后端 AI 失败: ${parsed.error}`)
        // ai-service.mjs chat handler 输出: { content, usage, finish_reason, model, done, completed_at }
        return {
          content: parsed.content || '',
          usage: parsed.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          finishReason: parsed.finish_reason || 'stop',
          modelId: parsed.model || '',
        }
      }
    } catch (e: any) {
      // 文件还没 commit 继续等；如果是已知失败类型直接抛
      if (e?.message?.includes('后端 AI 失败')) throw e
    }
  }
  throw new Error('AI 后端任务超时（10 分钟未返回）')
}

/** 统一获取后端上下文 */
function getBackendContext(): { token: string; owner: string; repoName: string } {
  const { token, user } = useAuthStore.getState()
  const repoName = useWorkspaceStore.getState().repo?.name
  const owner = user?.login
  if (!token || !owner || !repoName) {
    throw new Error('未登录或私库未配置 — 无法触发后端 AI 服务')
  }
  return { token, owner, repoName }
}

export async function callAI(req: AIRequest): Promise<AIResponse> {
  const { token, owner, repoName } = getBackendContext()

  const outputPath = buildOutputPath()
  const taskId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

  // 把 messages + 可选参数传给后端 chat handler
  const inputJson: Record<string, any> = { messages: req.messages }
  if (req.temperature !== undefined) inputJson.temperature = req.temperature
  if (req.maxTokens !== undefined) inputJson.maxTokens = req.maxTokens

  await dispatchAi(taskId, 'chat', inputJson, outputPath, 1, owner, repoName, token)
  return pollResult(outputPath, owner, repoName, token, req.signal)
}

/** 带 AbortSignal 的 AI 调用（长任务支持取消） */
export async function callAIWithSignal(
  req: AIRequest,
  externalSignal?: AbortSignal,
): Promise<AIResponse> {
  return callAI({ ...req, signal: externalSignal })
}
