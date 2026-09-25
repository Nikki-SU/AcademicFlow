/**
 * 联网检索 —— DeepSeek 原生 web_search（走 ai_call workflow）
 *
 * 与 callAI 的区别只在后端 handler：
 *   - ai_call 里 task_type='web_search'，直连 api.deepseek.com/anthropic/v1/messages
 *     并带上内置 web_search 工具，模型会先检索再作答，结果里附来源列表。
 *     （OpenAI 兼容端点的 /chat/completions 会忽略 web_search，所以这一步绕不开。）
 *   - 密钥在 runner 里取 AI1_*，前端不需要本地 API Key —— 所以这里不读 settings，
 *     也就没有「请先填写 AI-1 位的 API Key」这道卡。
 *
 * 产物：temp/ai/web_search/search_{ts}_{rand}.json
 */
import type { AIThinkingMode } from '../../types'
import { dispatchAiCall } from '../workflowClient'
import { readRepoTextFile } from '../github'
import { abortError, cancelRemoteAiRun } from './abort'
import { useAuthStore } from '../../stores/auth'
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
  signal?: AbortSignal
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

export async function callWebSearch(req: WebSearchRequest): Promise<WebSearchResult> {
  const { token, owner, repoName } = getBackendContext()

  const outputPath = `temp/ai/web_search/search_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`
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

  // 联网比普通 chat 慢（先检索再写），预算给到 15 分钟
  const maxAttempts = 300 // 3s × 300
  try {
    for (let i = 0; i < maxAttempts; i++) {
      if (req.signal?.aborted) throw abortError()
      await new Promise((r) => setTimeout(r, 3000))
      if (req.signal?.aborted) throw abortError()

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
    throw new Error('联网检索超时（15 分钟未返回）')
  } finally {
    // 任务结束后不再响应 abort，免得 UI 清理时误伤下一次的 run
    req.signal?.removeEventListener('abort', onAbort)
  }
}
