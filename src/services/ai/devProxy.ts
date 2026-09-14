/**
 * Dev proxy —— 把 AI provider 的真实 baseUrl 映射到 Vite dev server 的代理路径
 *
 * 为什么需要：
 *   浏览器没有走代理/VPN 时直连 api.deepseek.com 等会被墙，
 *   而 Vite dev server（Node.js）走 HTTPS_PROXY 环境变量能出网。
 *   所以把 fetch 改走同源 /ai-proxy/<provider>/chat/completions，
 *   Vite proxy 转发到真实 API。
 *
 * 生产模式（GitHub Pages）：
 *   没有 Vite dev server → 走不到这个 proxy，返回 null。
 *   生产环境下"测试连接"按钮会走真实 baseUrl，
 *   用户浏览器需自行有代理/VPN，或此按钮仅作为"配置校验"参考。
 *
 * provider 前缀与 vite.config.ts server.proxy 保持一致：
 *   /ai-proxy/deepseek → api.deepseek.com/v1
 *   /ai-proxy/kimi     → api.moonshot.cn/v1
 *   /ai-proxy/qiniu    → api.qnaigc.com/v1
 */

import type { AIProviderMode } from '../../types'

const DEV_PROXY_MAP: Partial<Record<AIProviderMode, string>> = {
  deepseek: '/ai-proxy/deepseek',
  kimi: '/ai-proxy/kimi',
  qiniu: '/ai-proxy/qiniu',
}

/**
 * Dev 模式下把 provider mode 映射到代理路径前缀
 * @returns 代理路径如 '/ai-proxy/deepseek'，或 null（prod / custom / 未知 provider）
 */
export function getDevProxyPrefix(mode: string): string | null {
  if (!import.meta.env.DEV) return null
  return DEV_PROXY_MAP[mode as AIProviderMode] ?? null
}

/**
 * 构造"测试连接"用的 fetch URL
 *   Dev 模式 + 已知 provider → 走 Vite proxy 绕过 CORS + 代理出网
 *   Prod / custom / unknown → 返回 baseUrl + /chat/completions
 */
export function buildTestChatUrl(baseUrl: string, providerMode: string): string {
  const proxyPrefix = getDevProxyPrefix(providerMode)
  if (proxyPrefix) {
    return `${proxyPrefix}/chat/completions`
  }
  // custom provider / prod —— 用真实 baseUrl
  const trimmed = baseUrl.replace(/\/$/, '')
  return `${trimmed}/chat/completions`
}
