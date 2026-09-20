/**
 * 后端 workflow 安装/检测 —— 前端通过 GitHub Contents API 把 workflow 文件写入用户私库
 *
 * 为什么不内嵌在 WORKSPACE_SKELETON：
 *   - 4 个 workflow yml + 4 个 runner 脚本 (paper_convert / ai_call /
 *     mineru_connectivity_test / ai_connectivity_test) 合计 ~75KB base64
 *   - 如果初始骨架生成时就塞进去，骨架初始化包膨胀、且老用户升级没有路径
 *   - 这里做成可检测 + 可手动触发写入，老用户也能一键升级
 */

import {
  PAPER_CONVERT_YML_B64, AI_CALL_YML_B64,
  PAPER_CONVERT_MJS_B64, AI_CALL_MJS_B64, BLOCKS_MJS_B64,
  MINERU_CONNECTIVITY_TEST_YML_B64, MINERU_CONNECTIVITY_TEST_MJS_B64,
  AI_CONNECTIVITY_TEST_YML_B64, AI_CONNECTIVITY_TEST_MJS_B64,
  PIPELINE_FILES,
} from '../constants/skeleton'
import { githubFetch, writeRepoTextFile, deleteRepoFiles, base64ToUtf8 } from './github'

const MAX_PIPELINE_FILE = 500 * 1024 // 500KB — 所有 pipeline 文件都远小于此

/**
 * 老版 workflow/脚本文件名（已废弃）。
 * 它们与新版文件使用相同的 repository_dispatch event_type，会重复触发，
 * 造成每次 dispatch 出现双份 run、甚至 "no jobs were run"。
 * 引导安装时必须把这些残留文件删掉，做到真正切到新版。
 */
export const LEGACY_PIPELINE_FILES = [
  '.github/workflows/pipeline.yml',
  '.github/workflows/ai-service.yml',
  '.github/workflows/mineru-test.yml',
  '.github/workflows/ai-connectivity-test.yml',
  '.github/scripts/pipeline.mjs',
  '.github/scripts/ai-service.mjs',
  '.github/scripts/mineru-test.mjs',
  '.github/scripts/ai-connectivity-test.mjs',
] as const

export interface PipelineInstallResult {
  ok: boolean
  written?: string[]
  skipped?: string[]
  legacyDeleted?: string[]
  error?: string
  details?: { path: string; ok: boolean; error?: string }[]
}

/** 检测私库里还残留哪些老版文件（存在即返回其路径） */
export async function detectLegacyPipelineFiles(
  owner: string,
  repo: string,
  token: string,
): Promise<string[]> {
  const legacy: string[] = []
  for (const path of LEGACY_PIPELINE_FILES) {
    try {
      const res = await githubFetch(`/repos/${owner}/${repo}/contents/${encodeURI(path)}`, token)
      if (res.ok) legacy.push(path)
    } catch {
      // 读不到就当作不存在
    }
  }
  return legacy
}

/**
 * 检测用户私库是否已经安装了后端 workflow
 * 逐个试读 PIPELINE_FILES 里的 8 个文件 (4 yml + 4 mjs), 全部存在 → 已安装
 */
export async function checkPipelineInstalled(
  owner: string,
  repo: string,
  token: string,
): Promise<{ installed: boolean; missing: string[]; legacy: string[]; sizes: Record<string, number> }> {
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
  // 还要确认老版文件已清理干净，否则老 workflow 会和新版重复触发
  const legacy = await detectLegacyPipelineFiles(owner, repo, token)
  return { installed: missing.length === 0 && legacy.length === 0, missing, legacy, sizes }
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
    PAPER_CONVERT_YML_B64,
    AI_CALL_YML_B64,
    PAPER_CONVERT_MJS_B64,
    AI_CALL_MJS_B64,
    BLOCKS_MJS_B64,
    MINERU_CONNECTIVITY_TEST_YML_B64,
    MINERU_CONNECTIVITY_TEST_MJS_B64,
    AI_CONNECTIVITY_TEST_YML_B64,
    AI_CONNECTIVITY_TEST_MJS_B64,
  }
  const details: { path: string; ok: boolean; error?: string }[] = []
  const written: string[] = []
  const skipped: string[] = []

  for (const f of PIPELINE_FILES) {
    let content: string
    if ('raw' in f) {
      content = f.raw
    } else {
      const b64 = b64Map[f.b64Key]
      if (!b64) { details.push({ path: f.path, ok: false, error: `missing b64 constant: ${f.b64Key}` }); continue }
      // b64 是「UTF-8 文本的标准 base64」—— 必须按 UTF-8 解码。
      // 用 atob 会得到 latin1 串，再被 writeRepoTextFile 的 utf8ToBase64 二次编码 → 中文变乱码。
      content = base64ToUtf8(b64)
    }
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
  if (!allOk) {
    return { ok: false, written, skipped, details }
  }

  // 新版写入成功后，删除老版残留文件。
  // 老 workflow 与新版共用相同的 repository_dispatch event_type，会重复触发、
  // 产生双份 run 和 "no jobs were run"，必须清掉才算真正切到新版。
  let legacyDeleted: string[] = []
  try {
    const legacy = await detectLegacyPipelineFiles(owner, repo, token)
    if (legacy.length > 0) {
      await deleteRepoFiles(legacy, '[academicflow] remove legacy pipeline files', owner, repo, token)
      legacyDeleted = legacy
    }
  } catch (e: any) {
    details.push({ path: '(legacy cleanup)', ok: false, error: e?.message || String(e) })
    return { ok: false, written, skipped, legacyDeleted, details }
  }

  return { ok: true, written, skipped, legacyDeleted, details }
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
  { name: 'AI1_MODEL',          from: '可选。推荐 deepseek-flash / deepseek-v4-pro',
    hint: 'AI-1 的模型 ID' },
  { name: 'AI2_BASE_URL',       from: '你选择的 AI Provider 控制台',
    hint: 'AI-2（审阅位）的 API base URL' },
  { name: 'AI2_API_KEY',        from: '你选择的 AI Provider 控制台',
    hint: 'AI-2 的 API key（通常与 AI-1 共用）' },
  { name: 'AI2_MODEL',          from: '可选。推荐 deepseek-flash / deepseek-v4-pro',
    hint: 'AI-2 的模型 ID' },
] as const
