/**
 * 联网检索 —— 走 ai_call workflow 的 web_search handler
 *
 * 与 callAI 的区别只在后端 handler：
 *   - ai_call 里 task_type='web_search'，由后端按 provider 能力挑一个可用槽位：
 *     DeepSeek（Anthropic 兼容端点 + web_search_20250305）/ 智谱 GLM / OpenRouter /
 *     讯飞星火。火山方舟（收下工具但不真检索）与硅基流动（无原生联网）会被后端
 *     明确拒绝，不静默降级。
 *   - 密钥在 runner 里取 AI1_xxx / AI2_xxx（Secrets），前端不传也不读本地 Key。
 *
 * 前端要知道「当前两个槽位到底能不能联网」，用下面导出的 webSearchCapability /
 * resolveWebSearchSupport —— 判定口径与后端 PROVIDERS/UNSUPPORTED 一一对应，
 * 免得界面显示「能联网」而后端报不支持。
 *
 * 产物：temp/ai/web_search/search_{ts}_{rand}.json
 */
import type { AIThinkingMode } from '../../types'
import { AI_PROVIDERS, type AIProviderMode } from '../../types'
import { dispatchAiCall } from '../workflowClient'
import { readRepoTextFile } from '../github'
import { abortError, cancelRemoteAiRun } from './abort'
import { useAuthStore } from '../../stores/auth'
import { useSettingsStore } from '../../stores/settings'
import { useWorkspaceStore } from '../../stores/workspace'

export interface WebSearchSource {
  title: string
  url: string
}

export interface WebSearchResult {
  content: string
  sources: WebSearchSource[]
}

export interface WebSearchRequest {
  /** 系统提示（可选） */
  system?: string
  user: string
  /** 最多检索几次，默认 5（前端不传则用后端默认值） */
  maxUses?: number
  /** 推理模式：不传 = 后端不发 thinking 参数，沿用模型默认 */
  thinking?: AIThinkingMode
  /**
   * 结果文件路径（可选覆盖）。调用方需要「页面刷新 / 组件卸载后还能接回这次任务」时，
   * 由调用方先 `newWebSearchOutputPath()` 生成并持久化，再传进来；不传则内部生成。
   */
  outputPath?: string
  signal?: AbortSignal
}

// ═════════════════════════════════════════════════════════════════════
// 联网能力判定 —— 口径必须与后端 ai_call.mjs 的 PROVIDERS / UNSUPPORTED 一致
// ═════════════════════════════════════════════════════════════════════

export type WebSearchCapability = 'supported' | 'unsupported' | 'unknown'

export interface WebSearchSupport {
  /** 两个槽位里是否至少有一个能真正联网 */
  supported: boolean
  /** 不能联网时的可读原因（supported=true 时为空串） */
  reason: string
  /** 能联网时，后端实际会挑中的槽位 */
  slot?: { label: string; providerLabel: string; baseUrl: string }
}

const WEB_SEARCH_PROVIDERS = [
  { label: 'DeepSeek', hostRe: /(^|\.)deepseek\.com$/ },
  { label: '智谱 GLM', hostRe: /(^|\.)bigmodel\.cn$/ },
  { label: 'OpenRouter', hostRe: /(^|\.)openrouter\.ai$/ },
  { label: '讯飞星火', hostRe: /(^|\.)xf-yun\.com$/ },
]

const WEB_SEARCH_UNSUPPORTED = [
  {
    label: '火山方舟',
    hostRe: /(^|\.)volces\.com$/,
    reason: '订阅端点接受 web_search 工具但不真正检索（实测返回 200、引文为空、模型自述无法联网）',
  },
  { label: '硅基流动', hostRe: /(^|\.)siliconflow\.(cn|com)$/, reason: '没有原生联网检索能力' },
]

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl || '').hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 单个端点是否能联网 */
export function webSearchCapability(baseUrl: string): WebSearchCapability {
  const host = hostOf(baseUrl)
  if (!host) return 'unknown'
  if (WEB_SEARCH_UNSUPPORTED.some((p) => p.hostRe.test(host))) return 'unsupported'
  if (WEB_SEARCH_PROVIDERS.some((p) => p.hostRe.test(host))) return 'supported'
  return 'unknown'
}

/**
 * 按当前设置里的两个槽位算「联网开关能不能开」。
 * 只按 provider 主机名判定，不调用 getDualEngineConfig() —— 那里缺 Key 会抛异常，
 * 渲染期不能让它炸掉面板；缺 Key / 缺模型由后端在真正检索时给可读错误。
 */
export function resolveWebSearchSupport(): WebSearchSupport {
  const s = useSettingsStore.getState()
  const slots: { label: string; mode: AIProviderMode; baseUrl: string }[] = [
    {
      label: 'AI-1',
      mode: s.aiProviderMode,
      baseUrl:
        s.aiProviderMode === 'custom'
          ? s.customAi1BaseUrl.trim()
          : AI_PROVIDERS[s.aiProviderMode]?.baseUrl || '',
    },
    {
      label: 'AI-2',
      mode: s.ai2ProviderMode,
      baseUrl:
        s.ai2ProviderMode === 'custom'
          ? s.customAi2BaseUrl.trim()
          : AI_PROVIDERS[s.ai2ProviderMode]?.baseUrl || '',
    },
  ]

  const details: string[] = []
  for (const slot of slots) {
    const host = hostOf(slot.baseUrl)
    const provider = WEB_SEARCH_PROVIDERS.find((p) => p.hostRe.test(host))
    if (provider) {
      return {
        supported: true,
        reason: '',
        slot: { label: slot.label, providerLabel: provider.label, baseUrl: slot.baseUrl },
      }
    }
    const bad = WEB_SEARCH_UNSUPPORTED.find((p) => p.hostRe.test(host))
    if (bad) details.push(`${slot.label} 是${bad.label}：${bad.reason}`)
    else if (!host) details.push(`${slot.label} 没有配置端点`)
    else details.push(`${slot.label}（${host}）不在已支持联网的 provider 列表内`)
  }

  return {
    supported: false,
    reason: `当前没有支持联网检索的槽位。${details.join('；')}。支持联网的 provider：${WEB_SEARCH_PROVIDERS.map((p) => p.label).join(' / ')}`,
  }
}

function getBackendContext(): { token: string; owner: string; repoName: string } {
  const { token, user } = useAuthStore.getState()
  const repoName = useWorkspaceStore.getState().repo?.name
  const owner = user?.login
  if (!token || !owner || !repoName) {
    throw new Error('未登录或私库未配置 — 无法触发后端 AI 服务')
  }
  return { token, owner, repoName }
}

/**
 * 构造唯一的 output_path。
 * 对外导出：调用方要「切走 / 刷新后还能接回这次任务」时，先自己生成并持久化，
 * 再通过 WebSearchRequest.outputPath 传进来。
 */
export function newWebSearchOutputPath(): string {
  return `temp/ai/web_search/search_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`
}

/**
 * 只轮询已有 output_path（不重复 dispatch）。
 * 供「任务已经派发过、但界面被卸载 / 页面被刷新」的一方重新接上这次任务。
 */
export async function pollWebSearchResult(
  outputPath: string,
  signal?: AbortSignal,
): Promise<WebSearchResult> {
  const { token, owner, repoName } = getBackendContext()

  // 与 chat / dual-engine 对齐：后端 job 上限 50min，前端轮询给到 60min，
  // 免得后端还在检索、前端先报超时（旧值 15min 会把慢检索误判成失败）。
  const maxAttempts = 1200 // 3s × 1200 = 60min
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) throw abortError()
    await new Promise((r) => setTimeout(r, 3000))
    if (signal?.aborted) throw abortError()

    try {
      const raw = await readRepoTextFile(owner, repoName, outputPath, token)
      if (!raw) continue
      const parsed = JSON.parse(raw.content)
      if (parsed.error) throw new Error(`后端联网检索失败: ${parsed.error}`)
      // 后端是先写 output_path 再 commit，文件出现即写全；done 只是双重保险
      if (!parsed.done) continue
      return {
        content: parsed.content || '',
        sources: Array.isArray(parsed.sources) ? parsed.sources : [],
      }
    } catch (e: any) {
      if (e?.message?.includes('后端联网检索失败')) throw e
      // 文件还没 commit 出来，或 JSON 还没写全 → 继续等
    }
  }
  throw new Error('联网检索超时（60 分钟未返回）')
}

export async function callWebSearch(req: WebSearchRequest): Promise<WebSearchResult> {
  const { token, owner, repoName } = getBackendContext()

  const outputPath = req.outputPath ?? newWebSearchOutputPath()
  const taskId = `web_search_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

  const inputJson: Record<string, unknown> = { user: req.user }
  if (req.system) inputJson.system = req.system
  if (req.maxUses) inputJson.max_uses = req.maxUses
  if (req.thinking) inputJson.thinking = req.thinking

  const dispatchedAt = new Date().toISOString()
  await dispatchAiCall(taskId, 'web_search', inputJson, outputPath, 1, owner, repoName, token)

  // 用户点「停止」：停轮询 + 尽力取消后端 run（详见 ai/abort.ts）
  const onAbort = () => cancelRemoteAiRun(owner, repoName, token, dispatchedAt)
  if (req.signal) {
    if (req.signal.aborted) onAbort()
    else req.signal.addEventListener('abort', onAbort, { once: true })
  }

  // 与 chat / dual-engine 对齐：后端 job 上限 50min，前端轮询给到 60min，
  // 免得后端还在检索、前端先报超时（旧值 15min 会把慢检索误判成失败）。
  try {
    return await pollWebSearchResult(outputPath, req.signal)
  } finally {
    // 任务结束后不再响应 abort，免得 UI 清理时误伤下一次的 run
    req.signal?.removeEventListener('abort', onAbort)
  }
}
