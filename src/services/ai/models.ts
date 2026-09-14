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

/** 硅基流动 API base URL（预置常量） */

/** 模型清单缓存 TTL：24 小时 */
export const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 用于 AI 双引擎场景的模型 id 前缀白名单
 * 从 /v1/models 过滤出适合 chat/reasoning 用途的（排除 embedding/rerank/tts/image/video）
 *
 * 覆盖三家主流 provider 的命名风格：
 *   - 硅基流动：Qwen/Qwen3-32B, deepseek-ai/DeepSeek-V3, moonshotai/Kimi-K2
 *   - 官方直连：deepseek-chat, deepseek-v4-pro, kimi-k2.6
 *   - 七牛云聚合：deepseek/deepseek-v4-flash, minimax/minimax-m2.5, moonshotai/kimi-k2.6
 */
const CHAT_MODEL_ALLOW_PREFIXES = [
  // 硅基流动风格
  'Qwen/Qwen', 'Qwen/Qwen2', 'Qwen/Qwen3',
  'deepseek-ai/DeepSeek', 'Pro/deepseek-ai/DeepSeek',
  'meta-llama/Llama',
  'zai-org/GLM', 'Pro/zai-org/GLM',
  'moonshotai/Kimi', 'Pro/moonshotai/Kimi',
  'MiniMaxAI/MiniMax', 'Pro/MiniMaxAI/MiniMax',
  'ByteDance-Seed/Seed',
  'Tongyi-Zhiwen/QwenLong',
  'internlm/internlm',
  'THUDM/GLM',
  // 七牛云聚合风格（小写 vendor/ 前缀）
  'deepseek/', 'moonshotai/', 'minimax/', 'qwen/', 'bytedance/',
  'qwen-', 'doubao-', 'glm-', 'kimi-k', 'deepseek-v3', 'deepseek-r1',
  // 官方直连风格（无前缀）
  'deepseek-chat', 'deepseek-v4', 'deepseek-v3', 'deepseek-r1',
  'kimi-k2', 'kimi-k3',
  'minimax-m',
  // 其他
  'MiniMax-M1', 'MiniMax-M3',
]

/** 排除非 chat 类模型（embedding / rerank / tts / image / video / audio / vision） */
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
  'vision',
  '-vl-',
  'vl-',
  'vl/',
]

/** 判定一个 model id 是否为 chat/reasoning 类模型（用于 UI 下拉过滤） */
export function isChatModel(modelId: string): boolean {
  if (!modelId || !modelId.trim()) return false
  const id = modelId.trim()
  const hasAllow = CHAT_MODEL_ALLOW_PREFIXES.some((p) => id.startsWith(p))
  if (!hasAllow) return false
  const hasDeny = CHAT_MODEL_DENY_KEYWORDS.some((k) => id.toLowerCase().includes(k.toLowerCase()))
  return !hasDeny
}

/**
 * 根据 model id 推断厂商/提供方
 *
 * 三家主流 provider 命名风格：
 *   - 硅基流动：Pro/deepseek-ai/DeepSeek-V3、moonshotai/Kimi-K2.5、MiniMaxAI/MiniMax-M2
 *   - 七牛云：deepseek/deepseek-v4-flash、moonshotai/kimi-k2.6、minimax/minimax-m2.5
 *   - 官方直连：deepseek-chat、kimi-k2.6（无前缀可从模型名推断）
 */
export function getModelVendor(modelId: string): string {
  const id = modelId.trim()
  if (!id) return '未知'
  const lower = id.toLowerCase()
  // 七牛云小写前缀优先匹配
  if (lower.startsWith('deepseek/')) return 'DeepSeek / 深度求索'
  if (lower.startsWith('moonshotai/')) return 'Kimi / 月之暗面'
  if (lower.startsWith('minimax/')) return 'MiniMax / 稀宇'
  if (lower.startsWith('qwen/')) return '通义千问 / 阿里'
  if (lower.startsWith('bytedance/')) return '豆包 / 字节跳动'
  // 硅基流动大小写混合前缀
  if (id.startsWith('Qwen/') || id.startsWith('Tongyi-Zhiwen/') || id.startsWith('THUDM/')) {
    return '通义千问 / 阿里'
  }
  if (id.startsWith('deepseek-ai/') || id.startsWith('Pro/deepseek-ai/')) {
    return 'DeepSeek / 深度求索'
  }
  if (id.startsWith('meta-llama/') || id.startsWith('Meta/')) {
    return 'Llama / Meta'
  }
  if (id.startsWith('zai-org/') || id.startsWith('Pro/zai-org/')) {
    return 'GLM / 智谱'
  }
  if (id.startsWith('moonshotai/') || id.startsWith('Pro/moonshotai/')) {
    return 'Kimi / 月之暗面'
  }
  if (id.startsWith('MiniMaxAI/') || id.startsWith('Pro/MiniMaxAI/')) {
    return 'MiniMax / 稀宇'
  }
  if (id.startsWith('ByteDance-Seed/')) {
    return '豆包 / 字节跳动'
  }
  if (id.startsWith('internlm/')) {
    return 'InternLM / 书生'
  }
  // 无前缀官方模型
  if (lower.startsWith('deepseek')) return 'DeepSeek / 深度求索'
  if (lower.startsWith('kimi')) return 'Kimi / 月之暗面'
  if (lower.startsWith('minimax') || id.startsWith('MiniMax')) return 'MiniMax / 稀宇'
  if (lower.startsWith('qwen')) return '通义千问 / 阿里'
  if (lower.startsWith('doubao')) return '豆包 / 字节跳动'
  if (lower.startsWith('glm')) return 'GLM / 智谱'
  if (lower.startsWith('llama')) return 'Llama / Meta'
  return '其他'
}

