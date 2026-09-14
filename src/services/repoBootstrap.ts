/**
 * Pipeline 安装/检测 —— 前端通过 GitHub Contents API 把 workflow 文件写入用户私库
 *
 * 为什么不内嵌在 WORKSPACE_SKELETON：
 *   - pipeline.yml + pipeline.mjs + ai-service.yml + ai-service.mjs 合计 ~75KB base64
 *   - 如果初始骨架生成时就塞进去，骨架初始化包膨胀、且老用户升级没有路径
 *   - 这里做成可检测 + 可手动触发写入，老用户也能一键升级
 */

import {
  PIPELINE_YML_B64, AI_SERVICE_YML_B64,
  PIPELINE_MJS_B64, AI_SERVICE_MJS_B64,
  MINERU_TEST_YML_B64, MINERU_TEST_MJS_B64,
  AI_CONNECTIVITY_TEST_YML_B64, AI_CONNECTIVITY_TEST_MJS_B64,
  PIPELINE_FILES,
} from '../constants/skeleton'
import { githubFetch, writeRepoTextFile } from './github'

const MAX_PIPELINE_FILE = 500 * 1024 // 500KB — 所有 pipeline 文件都远小于此

export interface PipelineInstallResult {
  ok: boolean
  written?: string[]
  skipped?: string[]
  error?: string
  details?: { path: string; ok: boolean; error?: string }[]
}

/**
 * 检测用户私库是否已经安装了后端 pipeline
 * 试读 pipeline.yml，存在且 size > 1000 字节 → 认为已安装
 */
export async function checkPipelineInstalled(
  owner: string,
  repo: string,
  token: string,
): Promise<{ installed: boolean; missing: string[]; sizes: Record<string, number> }> {
  const missing: string[] = []
  const sizes: Record<string, number> = {}
  for (const f of PIPELINE_FILES) {
    try {
      const res = await githubFetch(`/repos/${owner}/${repo}/contents/${encodeURI(f.path)}`, token)
      if (res.ok) {
        const data = (await res.json()) as { size?: number }
        sizes[f.path] = data.size ?? 0
        if ((data.size ?? 0) < 50) missing.push(f.path) // 太小可能是空文件
      } else {
        missing.push(f.path)
      }
    } catch {
      missing.push(f.path)
    }
  }
  return { installed: missing.length === 0, missing, sizes }
}

/**
 * 写入（或重写）pipeline 相关文件到用户私库
 * 用 Contents PUT —— 单文件，幂等，自动处理 sha
 * 所有文件都 < 1MB，走 Contents API 没问题
 */
export async function writePipelineFiles(
  owner: string,
  repo: string,
  token: string,
): Promise<PipelineInstallResult> {
  const b64Map: Record<string, string> = {
    'PIPELINE_YML_B64': PIPELINE_YML_B64,
    'AI_SERVICE_YML_B64': AI_SERVICE_YML_B64,
    'PIPELINE_MJS_B64': PIPELINE_MJS_B64,
    'AI_SERVICE_MJS_B64': AI_SERVICE_MJS_B64,
    'MINERU_TEST_YML_B64': MINERU_TEST_YML_B64,
    'MINERU_TEST_MJS_B64': MINERU_TEST_MJS_B64,
    'AI_CONNECTIVITY_TEST_YML_B64': AI_CONNECTIVITY_TEST_YML_B64,
    'AI_CONNECTIVITY_TEST_MJS_B64': AI_CONNECTIVITY_TEST_MJS_B64,
  }
  const details: { path: string; ok: boolean; error?: string }[] = []
  const written: string[] = []
  const skipped: string[] = []

  for (const f of PIPELINE_FILES) {
    const b64 = b64Map[f.b64Key]
    if (!b64) { details.push({ path: f.path, ok: false, error: `missing b64 constant: ${f.b64Key}` }); continue }
    const content = atob(b64)
    if (content.length > MAX_PIPELINE_FILE) {
      details.push({ path: f.path, ok: false, error: `file too large: ${content.length} bytes` })
      continue
    }
    try {
      await writeRepoTextFile(
        owner, repo, f.path, content, token,
        `[academicflow] install ${f.path}`,
      )
      written.push(f.path)
      details.push({ path: f.path, ok: true })
    } catch (e: any) {
      details.push({ path: f.path, ok: false, error: e?.message || String(e) })
    }
  }

  const allOk = details.every(d => d.ok)
  return { ok: allOk, written, skipped, details }
}

/**
 * 7 个必需 Secrets 的模板（用户从 Settings 页面复制粘贴到 GitHub）
 */
export const REQUIRED_SECRETS = [
  { name: 'MINERU_API_TOKEN',   from: 'MinerU 设置页面（https://op.mineru.ai）',
    hint: 'MinerU 用户中心生成的 API token' },
  { name: 'AI1_BASE_URL',       from: '你选择的 AI Provider 控制台',
    hint: 'AI-1（生成位）的 API base URL，如 https://api.deepseek.com/v1' },
  { name: 'AI1_API_KEY',        from: '你选择的 AI Provider 控制台',
    hint: 'AI-1 的 API key' },
  { name: 'AI1_MODEL',          from: '可选。推荐 deepseek-chat / moonshot-v1-32k',
    hint: 'AI-1 的模型 ID' },
  { name: 'AI2_BASE_URL',       from: '你选择的 AI Provider 控制台',
    hint: 'AI-2（审阅位）的 API base URL' },
  { name: 'AI2_API_KEY',        from: '你选择的 AI Provider 控制台',
    hint: 'AI-2 的 API key（通常与 AI-1 共用）' },
  { name: 'AI2_MODEL',          from: '可选。推荐 deepseek-chat / moonshot-v1-32k',
    hint: 'AI-2 的模型 ID' },
] as const
