/**
 * AI 模型清单拉取 + 缓存
 * -------------------------------------------------
 * 对应 SPEC v0.3 §9.3。M3 阶段只做硅基流动 /v1/models 的拉取 + IndexedDB 24h 缓存。
 *
 * 硅基流动 /v1/models 端点契约（2026-07-13 实测）：
 *   - 方法：GET https://api.siliconflow.cn/v1/models
 *   - 认证：Authorization: Bearer <key>（不带 → 401 "Invalid token"）
 *   - CORS：Access-Control-Allow-Origin: *（前端可直连）
 *   - 响应：OpenAI 兼容 {object:'list', data:[{id, object, created, owned_by}]}
 *   - 当前列表规模：91 项（含 chat/embedding/rerank/tts/image/video 各类模型）
 */
import type { AIModel } from '../../types'
import { getSetting, putSetting, SETTING_KEYS } from '../db'
import {
  AIAuthError,
  AIClientError,
  AINetworkError,
  AIQuotaError,
  AIRateLimitError,
} from './client'

/** 硅基流动 API base URL（预置常量） */
export const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1'

/** 模型清单缓存 TTL：24 小时 */
export const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 用于 AI 双引擎场景的模型 id 前缀白名单
 * 从 /v1/models 91 个里过滤出适合 chat/reasoning 用途的（排除 embedding/rerank/tts/image/video）
 */
const CHAT_MODEL_ALLOW_PREFIXES = [
  'Qwen/Qwen2.5',
  'Qwen/Qwen3',
  'deepseek-ai/DeepSeek',
  'Pro/deepseek-ai/DeepSeek',
  'meta-llama/Llama',
  'zai-org/GLM',
  'Pro/zai-org/GLM',
  'moonshotai/Kimi',
  'Pro/moonshotai/Kimi',
  'MiniMaxAI/MiniMax',
  'Pro/MiniMaxAI/MiniMax',
  'ByteDance-Seed/Seed',
  'Tongyi-Zhiwen/QwenLong',
  'internlm/internlm',
  'THUDM/GLM',
]

/** 排除非 chat 类模型（embedding / rerank / tts / image / video / audio） */
const CHAT_MODEL_DENY_KEYWORDS = [
  'embedding',
  'reranker',
  'CosyVoice',
  'SenseVoice',
  'Kolors',
  'PaddleOCR',
  'Qwen-Image',
  'Qwen3-Coder',
  'Wan-AI',
]

/** 判定一个 model id 是否为 chat/reasoning 类模型（用于 UI 下拉过滤） */
export function isChatModel(modelId: string): boolean {
  const hasAllow = CHAT_MODEL_ALLOW_PREFIXES.some((p) => modelId.startsWith(p))
  if (!hasAllow) return false
  const hasDeny = CHAT_MODEL_DENY_KEYWORDS.some((k) => modelId.includes(k))
  return !hasDeny
}

/** 复用 client.ts 的错误分类 */
async function parseErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return `HTTP ${res.status}`
  try {
    const json = JSON.parse(text)
    const msg = json?.error?.message || json?.message || JSON.stringify(json)
    return typeof msg === 'string' ? msg : JSON.stringify(msg)
  } catch {
    return text.slice(0, 500)
  }
}

/**
 * 从硅基流动拉取 /v1/models 完整列表
 * @throws AIAuthError / AIQuotaError / AIRateLimitError / AINetworkError / AIClientError
 */
export async function fetchSiliconflowModels(apiKey: string): Promise<AIModel[]> {
  if (!apiKey || !apiKey.trim()) {
    throw new AIAuthError('未配置硅基流动 API Key')
  }

  let res: Response
  try {
    res = await fetch(`${SILICONFLOW_BASE_URL}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    })
  } catch (err) {
    throw new AINetworkError(err instanceof Error ? err.message : String(err))
  }

  if (!res.ok) {
    const providerMsg = await parseErrorBody(res)
    if (res.status === 401) throw new AIAuthError(providerMsg)
    if (res.status === 402 || res.status === 403)
      throw new AIQuotaError(res.status, providerMsg)
    if (res.status === 429) throw new AIRateLimitError(providerMsg)
    if (res.status >= 500) throw new AINetworkError(providerMsg)
    throw new AIClientError(res.status, providerMsg)
  }

  const data = (await res.json()) as { data?: AIModel[] }
  return data.data ?? []
}

/** 从 IndexedDB 读取缓存的模型清单，返回 null 表示无缓存或已过期 */
export async function loadCachedModels(): Promise<AIModel[] | null> {
  const raw = await getSetting(SETTING_KEYS.AI_MODELS_CACHE_SILICONFLOW)
  const atRaw = await getSetting(SETTING_KEYS.AI_MODELS_CACHE_AT)
  if (!raw || !atRaw) return null
  const at = Number(atRaw)
  if (!Number.isFinite(at)) return null
  if (Date.now() - at > MODELS_CACHE_TTL_MS) return null
  try {
    return JSON.parse(raw) as AIModel[]
  } catch {
    return null
  }
}

/** 保存模型清单到 IndexedDB */
export async function saveModelsCache(models: AIModel[]): Promise<number> {
  const now = Date.now()
  await putSetting(SETTING_KEYS.AI_MODELS_CACHE_SILICONFLOW, JSON.stringify(models))
  await putSetting(SETTING_KEYS.AI_MODELS_CACHE_AT, String(now))
  return now
}

/** 读取缓存的拉取时间戳（用于 UI 展示"上次更新于 xx"） */
export async function loadCachedModelsFetchedAt(): Promise<number | null> {
  const atRaw = await getSetting(SETTING_KEYS.AI_MODELS_CACHE_AT)
  if (!atRaw) return null
  const at = Number(atRaw)
  return Number.isFinite(at) ? at : null
}

/**
 * M3.5.1: 拉取硅基流动账户信息（余额 / 状态）
 *
 * 端点：GET /v1/user/info
 * 认证：Authorization: Bearer <key>
 * 返回结构（硅基流动 2026-07 契约）：
 *   { code, message, status, data: { id, name, email, image, isAdmin, balance,
 *     status, introduction, role, chargeBalance, totalBalance, category, ... } }
 * 我们只关心 data.totalBalance / data.chargeBalance / data.status / data.name。
 *
 * @throws AIAuthError / AIQuotaError / AIRateLimitError / AINetworkError / AIClientError
 */
export async function fetchSiliconflowUserInfo(apiKey: string): Promise<{
  totalBalance: string
  chargeBalance?: string
  status?: string
  name?: string
}> {
  if (!apiKey || !apiKey.trim()) {
    throw new AIAuthError('未配置硅基流动 API Key')
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15_000)

  let res: Response
  try {
    res = await fetch(`${SILICONFLOW_BASE_URL}/user/info`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AINetworkError('user/info 请求超时（15s 未响应）')
    }
    throw new AINetworkError(err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timeoutId)
  }

  if (!res.ok) {
    const providerMsg = await parseErrorBody(res)
    if (res.status === 401) throw new AIAuthError(providerMsg)
    if (res.status === 402 || res.status === 403)
      throw new AIQuotaError(res.status, providerMsg)
    if (res.status === 429) throw new AIRateLimitError(providerMsg)
    if (res.status >= 500) throw new AINetworkError(providerMsg)
    throw new AIClientError(res.status, providerMsg)
  }

  const raw = (await res.json()) as {
    data?: {
      totalBalance?: string | number
      chargeBalance?: string | number
      balance?: string | number
      status?: string
      name?: string
    }
  }
  const data = raw?.data ?? {}
  const totalBalance =
    data.totalBalance !== undefined
      ? String(data.totalBalance)
      : data.balance !== undefined
        ? String(data.balance)
        : '0'
  return {
    totalBalance,
    chargeBalance:
      data.chargeBalance !== undefined ? String(data.chargeBalance) : undefined,
    status: data.status,
    name: data.name,
  }
}
