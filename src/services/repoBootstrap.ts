/**
 * 后端 workflow 安装/检测 —— 前端通过 GitHub Contents API 把 workflow 文件写入用户私库
 *
 * 为什么不内嵌在 WORKSPACE_SKELETON：
 *   - workflow yml + runner 脚本合计 ~470KB base64
 *   - 如果初始骨架生成时就塞进去，骨架初始化包膨胀、且老用户升级没有路径
 *   - 这里做成可检测 + 可写入；写入由 pipelineAutoSync 在版本更新后**自动**触发，
 *     用户无需手动操作（旧版「设置页点重写后端」已移除）
 *
 * ⚠️ 写入是**无条件覆盖**（见 writePipelineFiles）：本地嵌入的副本必须与
 *    academicflow-workspace@main 上正在运行的版本保持一致。任何一边先行改动而
 *    另一边没跟上，重装一次就会造成「前端把后端打回旧版」或「装了别人不认识的版本」。
 *    同步方法见 docs/BACKEND_PENDING.md。
 */

import {
  PAPER_CONVERT_YML_B64, AI_CALL_YML_B64,
  PAPER_CONVERT_MJS_B64, AI_CALL_MJS_B64, BLOCKS_MJS_B64,
  DUAL_ENGINE_RUNNER_MJS_B64,
  MINERU_CONNECTIVITY_TEST_YML_B64, MINERU_CONNECTIVITY_TEST_MJS_B64,
  AI_CONNECTIVITY_TEST_YML_B64, AI_CONNECTIVITY_TEST_MJS_B64,
  PIPELINE_FILES,
  buildDailyTrackingYml,
} from '../constants/skeleton'
import { githubFetch, writeRepoTextFile, deleteRepoFiles, base64ToUtf8 } from './github'
import { loadTrackingPlans, planCronSpecs } from './trackingPlanData'
import { APP_VERSION } from '../constants/version'

const MAX_PIPELINE_FILE = 500 * 1024 // 500KB — 所有 pipeline 文件都远小于此

/**
 * 私库里的「后端 workflow 版本副本」（与 data-version.csv 同机制，ADJ-126）。
 * writePipelineFiles 成功时写入当前 `APP_VERSION.backend`；自动同步启动时读它比对：
 *   一致 → 直接跳过（1 次 API 读，不做全量内容比对）；
 *   缺失 / 落后 → 强制重写 workflow + 写回新版本（不兼容旧版一律更新）。
 */
export const BACKEND_VERSION_PATH = 'settings/backend-version.csv'

/** 读私库记录的后端 workflow 版本。读不到 / 非法 → null（视为未安装，强制同步） */
export async function loadStoredBackendVersion(
  owner: string,
  repo: string,
  token: string,
): Promise<number | null> {
  try {
    const res = await githubFetch(`/repos/${owner}/${repo}/contents/${encodeURI(BACKEND_VERSION_PATH)}`, token)
    if (!res.ok) return null
    const data = (await res.json()) as { content?: string }
    if (!data.content) return null
    const line = (base64ToUtf8(data.content).split(/\r?\n/)[1] ?? '').trim()
    const v = Number(line.split(',')[0])
    return Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/** 把当前后端版本写进私库副本（workflow 写入成功后调用；失败仅告警，下次同步自动重写） */
async function writeBackendVersion(owner: string, repo: string, token: string): Promise<void> {
  try {
    const content = `version,updated_at\n${APP_VERSION.backend},${Date.now()}\n`
    await writeRepoTextFile(
      owner, repo, BACKEND_VERSION_PATH, content, token,
      '[academicflow] record backend pipeline version',
    )
  } catch (err) {
    console.warn('[repoBootstrap] 写入后端版本副本失败（下次同步会重试）:', err)
  }
}

/** b64 常量 → 内容；写入 / 检测共用（检测要拿本地期望内容去比对私库版本） */
const b64Map: Record<string, string> = {
  PAPER_CONVERT_YML_B64,
  AI_CALL_YML_B64,
  PAPER_CONVERT_MJS_B64,
  AI_CALL_MJS_B64,
  BLOCKS_MJS_B64,
  DUAL_ENGINE_RUNNER_MJS_B64,
  MINERU_CONNECTIVITY_TEST_YML_B64,
  MINERU_CONNECTIVITY_TEST_MJS_B64,
  AI_CONNECTIVITY_TEST_YML_B64,
  AI_CONNECTIVITY_TEST_MJS_B64,
}

/**
 * 本地嵌入的期望内容（重装时会写进私库的那份）。
 * - daily-tracking.yml 的 schedule 取决于当前启用计划，是动态内容，这里返回 null，
 *   调用方单独按计划现算再比对；
 * - 其它文件用 raw（yml / mjs 直接 import）或 b64 常量（UTF-8 文本的标准 base64）。
 */
function localExpectedContent(f: (typeof PIPELINE_FILES)[number]): string | null {
  if ('raw' in f) return f.raw
  const b64 = b64Map[f.b64Key]
  return b64 ? base64ToUtf8(b64) : null
}

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

export interface PipelineCheckResult {
  installed: boolean
  missing: string[]
  legacy: string[]
  /** 私库内容与前端嵌入版本不一致（落后于新版）的文件路径 */
  outdated: string[]
  sizes: Record<string, number>
}

/**
 * 检测用户私库的后端 workflow 是否就绪，且是否与前端嵌入版本一致。
 *
 * 逐文件读 PIPELINE_FILES：
 *   - 读不到 / 太小 → missing（没装或空文件）
 *   - 读到了，但内容 ≠ 本地期望版本 → outdated（装的是旧版，静默用旧后端正是各种
 *     「前端改了、私库还在跑老行为」的根因，比如课程材料不进管线的旧 session_images）
 * 再加 legacy 残留检测。三者全清才算 installed。
 */
export async function checkPipelineInstalled(
  owner: string,
  repo: string,
  token: string,
): Promise<PipelineCheckResult> {
  const missing: string[] = []
  const outdated: string[] = []
  const sizes: Record<string, number> = {}
  // daily-tracking 的期望内容取决于当前启用计划，需先取计划再逐文件比对
  const plans = await loadTrackingPlans()
  for (const f of PIPELINE_FILES) {
    try {
      const res = await githubFetch(`/repos/${owner}/${repo}/contents/${encodeURI(f.path)}`, token)
      if (res.ok) {
        const data = (await res.json()) as { size?: number; content?: string }
        sizes[f.path] = data.size ?? 0
        const remoteContent = data.content ? base64ToUtf8(data.content) : ''
        if (remoteContent.length < 50) { missing.push(f.path); continue } // 太小可能是空文件
        const expected =
          f.path === '.github/workflows/daily-tracking.yml'
            ? buildDailyTrackingYml(planCronSpecs(plans))
            : localExpectedContent(f)
        if (expected !== null && remoteContent !== expected) outdated.push(f.path)
      } else {
        missing.push(f.path)
      }
    } catch {
      missing.push(f.path)
    }
  }
  // 还要确认老版文件已清理干净，否则老 workflow 会和新版重复触发
  const legacy = await detectLegacyPipelineFiles(owner, repo, token)
  return {
    installed: missing.length === 0 && legacy.length === 0 && outdated.length === 0,
    missing,
    legacy,
    outdated,
    sizes,
  }
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
  const details: { path: string; ok: boolean; error?: string }[] = []
  const written: string[] = []
  const skipped: string[] = []

  for (const f of PIPELINE_FILES) {
    let content: string
    if (f.path === '.github/workflows/daily-tracking.yml') {
      // 动态 cron：该文件的 schedule 取决于当前启用计划，重装时按 plans.csv 现算，
      // 不能直接用默认（无 cron）版本，否则会把用户已有的定时计划清空。
      content = buildDailyTrackingYml(planCronSpecs(await loadTrackingPlans()))
    } else {
      const expected = localExpectedContent(f)
      if (expected === null) { details.push({ path: f.path, ok: false, error: `missing content constant for ${f.path}` }); continue }
      content = expected
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

  // 全部写入成功后记录版本副本（ADJ-126）：下次启动读它比对，一致即跳过全量检测
  await writeBackendVersion(owner, repo, token)

  return { ok: true, written, skipped, legacyDeleted, details }
}

/**
 * 8 个必需 Secrets 的模板（用户从 Settings 页面复制粘贴到 GitHub）
 */
export const REQUIRED_SECRETS = [
  { name: 'MINERU_API_TOKEN',   from: 'MinerU 设置页面（https://op.mineru.ai）',
    hint: 'MinerU 用户中心生成的 API token' },
  { name: 'SIMPLETEX_TOKEN',    from: 'SimpleTex 用户中心（https://simpletex.cn/user/center）',
    hint: '「用户授权令牌」里的 UAT，公式识图用（只有一个 key）' },
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
