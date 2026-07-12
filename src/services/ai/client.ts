/**
 * AI 服务底层客户端（OpenAI 兼容协议）
 * -------------------------------------------------
 * 对应 SPEC v0.3 §9.1。所有 AI 请求统一走这里，硅基流动/自定义端点都用同一套。
 *
 * 错误处理策略：
 *   401 → AIAuthError（凭据无效，上层 toast + 引导去设置页）
 *   402 → AIQuotaError（余额不足，CTA：去充钱）
 *   403 → AIPermissionError（权限受限/劝退模型，CTA：去改身份或换模型）
 *   429 → AIRateLimitError（限流）
 *   5xx / 网络错误 → AINetworkError（可重试 1 次由上层决定）
 *   AbortError → AITimeoutError（M3.5.1 新增，硬超时 90s）
 *   其他 4xx → AIClientError
 *
 * M3.6.1: 402 和 403 语义完全不同（穷 vs 没资格），必须拆开引导用户到正确后台页面。
 *
 * M3.5.1: 每次请求硬性 90s 超时（AbortSignal），防止服务端挂起时 UI 无限等待。
 *   90s 上限选取：DeepSeek-R1 推理模型正常单次 30-60s，留 30s 富余；超时即分类为
 *   AITimeoutError 让 UI 明确提示，避免用户误以为在正常跑（可能是网络阻塞/模型排队/额度问题）。
 */
import type { AIRequest, AIResponse } from '../../types'

/** AI 请求硬超时（ms）—— 覆盖 R1 推理模型正常场景 */
const DEFAULT_TIMEOUT_MS = 90_000

/** AI 请求异常基类 */
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
  constructor(msg: string) {
    super(401, msg, 'AI 服务凭据无效或已过期，请到设置页检查 API Key')
    this.name = 'AIAuthError'
  }
}

export class AIQuotaError extends AIError {
  constructor(msg: string) {
    super(402, msg, 'AI 服务余额不足（HTTP 402）—— 请到服务商充值')
    this.name = 'AIQuotaError'
  }
}

/** M3.6.1: 403 权限受限（模型访问权限、实名认证、劝退模型等） */
export class AIPermissionError extends AIError {
  constructor(msg: string) {
    super(403, msg, 'AI 服务权限受限（HTTP 403）—— 可能是模型无访问权限、账户身份限制或劝退模型')
    this.name = 'AIPermissionError'
  }
}

export class AIRateLimitError extends AIError {
  constructor(msg: string) {
    super(429, msg, 'AI 服务触发限流，请稍后重试')
    this.name = 'AIRateLimitError'
  }
}

export class AINetworkError extends AIError {
  constructor(msg: string) {
    super(0, msg, 'AI 服务网络异常，请检查连接后重试')
    this.name = 'AINetworkError'
  }
}

/** M3.5.1: 请求超时（AbortSignal 触发） */
export class AITimeoutError extends AIError {
  timeoutMs: number
  constructor(timeoutMs: number) {
    super(
      0,
      `AI request timed out after ${timeoutMs}ms`,
      `AI 请求超时（${(timeoutMs / 1000).toFixed(0)}s 未响应）—— 可能是网络阻塞、模型排队或账户异常`,
    )
    this.name = 'AITimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export class AIClientError extends AIError {
  constructor(status: number, msg: string) {
    super(status, msg)
    this.name = 'AIClientError'
  }
}

/** 拼接 chat completions 端点：兼容 base_url 尾部带/不带 /v1 */
function buildChatEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

/**
 * 提取错误响应中的服务商 message
 * OpenAI 兼容协议错误体一般是 {error:{message,type,code}} 或 {message}
 */
async function parseErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return `HTTP ${res.status}`
  try {
    const json = JSON.parse(text)
    const msg =
      json?.error?.message ||
      json?.message ||
      json?.error ||
      JSON.stringify(json)
    return typeof msg === 'string' ? msg : JSON.stringify(msg)
  } catch {
    return text.slice(0, 500)
  }
}

/**
 * 调用 OpenAI 兼容 chat completion 接口
 *
 * 使用示例：
 * ```ts
 * const resp = await callAI({
 *   baseUrl: 'https://api.siliconflow.cn/v1',
 *   apiKey: 'sk-xxx',
 *   model: 'Qwen/Qwen2.5-72B-Instruct',
 *   messages: [{ role: 'user', content: 'hello' }],
 *   temperature: 0.3,
 * })
 * console.log(resp.content, resp.usage.total_tokens)
 * ```
 */
export async function callAI(req: AIRequest): Promise<AIResponse> {
  const endpoint = buildChatEndpoint(req.baseUrl)
  const body = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 0.3,
    max_tokens: req.maxTokens ?? 2048,
    stream: false,
  }

  const controller = new AbortController()
  const timeoutMs = DEFAULT_TIMEOUT_MS
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.apiKey}`,
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AITimeoutError(timeoutMs)
    }
    throw new AINetworkError(err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timeoutId)
  }

  if (!res.ok) {
    const providerMsg = await parseErrorBody(res)
    if (res.status === 401) throw new AIAuthError(providerMsg)
    if (res.status === 402) throw new AIQuotaError(providerMsg)
    if (res.status === 403) throw new AIPermissionError(providerMsg)
    if (res.status === 429) throw new AIRateLimitError(providerMsg)
    if (res.status >= 500) throw new AINetworkError(providerMsg)
    throw new AIClientError(res.status, providerMsg)
  }

  const data = (await res.json()) as {
    choices?: {
      message?: { content?: string; role?: string }
      finish_reason?: string
    }[]
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      total_tokens?: number
    }
    model?: string
  }

  const choice = data.choices?.[0]
  const content = choice?.message?.content ?? ''
  const usage = data.usage ?? {}

  return {
    content,
    usage: {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    },
    finishReason: choice?.finish_reason ?? 'stop',
    modelId: data.model ?? req.model,
  }
}
