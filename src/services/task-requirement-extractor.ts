/**
 * 任务要求 AI 提炼服务（ADJ-75）
 * -------------------------------------------------
 * 从任务材料（详细描述 + 文本附件原文）里提炼「需满足的条件」，分两类：
 *   - 要求     → 蓝点（requirement）
 *   - 注意事项 → 红点（caution）
 * 两者本质都是条件，一律作为待办（可勾选完成）；输出供用户核对 / 增改删。
 *
 * 复用 dual-engine 的双引擎基础设施（AI-1 生成 + AI-2 忠实性核查），
 * 与 guideline-extractor 同一套范式：源材料 = 唯一 ground truth，AI-1 只许忠实转写。
 *
 * 先约束，再容错（ADJ-68 / 70）：
 * - prompt 里把 JSON schema 逐字写死、给合法示例、明令禁止代码块 / 多余文字 / 别名键名；
 * - 解析层只做「去掉可能的 ```json 围栏 + 截取首尾花括号」这类安全网，
 *   核心字段缺失 / 类型不对 → 抛可读错误让用户重试，绝不静默降级成空。
 */
import { runDualEngine } from './ai/dual-engine'
import type { DualEngineProgressCallback } from '../types'
import type { TaskNote } from './projectData'

/** AI-1 角色 prompt：替换默认「学术总结助手」，并再次强调忠实 + 严格 JSON */
const AI1_ROLE_PROMPT = [
  '你是「任务要求提取助手」。用户会提供【源材料】（某个任务的详细描述 / 附件原文）与一条【任务指令】，',
  '你要从材料里提取出这个任务「必须满足的条件」，并以 JSON 格式输出。',
  '',
  '【核心约束（必须严格遵守）】',
  '1. 【源材料】是唯一权威依据。只允许提取材料里**明确写到**的条件，逐字忠于原意。',
  '2. 严禁编造、补全、推测、外推任何材料中没有出现的内容。',
  '3. 材料里没写到的，不要凭空添加；确实没有条件就返回空数组。',
  '4. 输出严格 JSON 格式，不要任何额外文字，不要用 markdown 代码块包裹。',
  '5. 用简洁的中文表达每条条件。',
].join('\n')

/** AI-1 任务指令：把输出 JSON schema 逐字钉死 */
const AI1_INSTRUCTION = [
  '请仔细阅读【源材料】，提取这个任务需要满足的条件，严格按以下 JSON 结构输出：',
  '',
  '{',
  '  "requirements": ["要求条目：材料明确规定的硬性条件（如交付物、格式、范围、字数、截止要求等）"],',
  '  "cautions": ["注意事项条目：材料里提醒要留意、易忽略、易出错、有额外约束的点"]',
  '}',
  '',
  '【输出规则】',
  '1. requirements 与 cautions 两个键都必须出现，值都是字符串数组；没有条目就写空数组 []。',
  '2. 每条一句话，简洁明确；不要加序号、不要加「要求：」这类前缀、不要与其他条目重复。',
  '3. 只允许使用【源材料】里明确写到内容；材料没提的，绝不添加。',
  '4. 只输出 JSON 本身，不要代码块包裹、不要任何解释性文字。',
].join('\n')

/**
 * 从任务材料里用 AI 提炼「要求 / 注意事项」（双引擎版）。
 *
 * @param params.sourceMaterial 任务材料原文（详细描述 + 附件文字），唯一 ground truth
 * @param params.ai1 AI-1 端点配置
 * @param params.ai2 AI-2 端点配置
 * @param params.onProgress 可选的双引擎进度回调
 * @param params.signal 可选的中断信号
 */
export async function extractTaskRequirementsWithAI(params: {
  sourceMaterial: string
  ai1: { baseUrl: string; apiKey: string; model: string }
  ai2: { baseUrl: string; apiKey: string; model: string }
  onProgress?: DualEngineProgressCallback
  signal?: AbortSignal
}): Promise<TaskNote[]> {
  const { sourceMaterial, ai1, ai2, onProgress, signal } = params

  if (!sourceMaterial.trim()) {
    // 材料为空绝不允许凭空生成 —— 直接抛可读错误，不触发任何 AI 调用
    throw new Error('没有可提炼的材料：请先填写详细描述，或添加可读取的文本附件')
  }

  const dualResult = await runDualEngine({
    taskType: 'faithfulness_check',
    sourceMaterial,
    ai1Instruction: AI1_INSTRUCTION,
    ai1RolePrompt: AI1_ROLE_PROMPT,
    ai1,
    ai2,
    onProgress,
    signal,
  })

  return parseTaskNotes(dualResult.ai1Output)
}

/**
 * 解析 AI 提炼结果。
 * 约定格式：`{ "requirements": string[], "cautions": string[] }`。
 * 解析层仅兜「代码块围栏 / 前后夹带文字」两种等价形态；核心字段缺失或类型不对
 * 一律抛错，不猜别名、不静默降级。
 */
function parseTaskNotes(rawOutput: string): TaskNote[] {
  let jsonText = rawOutput.trim()

  // 去掉可能的代码块包裹
  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonText = fenceMatch[1].trim()

  // 截取第一个 { 到最后一个 }（兜 AI 前后夹带说明文字）
  const firstBrace = jsonText.indexOf('{')
  const lastBrace = jsonText.lastIndexOf('}')
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error('AI 返回结果不是约定的 JSON，请重试')
  }
  jsonText = jsonText.slice(firstBrace, lastBrace + 1)

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    console.warn('[task-requirement-extractor] JSON parse failed, raw output:', rawOutput.slice(0, 500))
    throw new Error('AI 返回结果解析失败，请重试')
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AI 返回结果格式不正确，请重试')
  }
  const obj = parsed as Record<string, unknown>
  const requirements = obj.requirements
  const cautions = obj.cautions

  // 两个核心键至少要以数组形式出现一个；都不是数组 → 视为未按契约返回
  if (!Array.isArray(requirements) && !Array.isArray(cautions)) {
    throw new Error('AI 返回结果缺少「要求 / 注意事项」字段，请重试')
  }

  const toNotes = (arr: unknown, kind: TaskNote['kind']): TaskNote[] => {
    if (!Array.isArray(arr)) return []
    return arr
      .map((v) => String(v).trim())
      .filter((t) => t.length > 0)
      .map((text) => ({ kind, text, done: false }))
  }

  return [...toNotes(requirements, 'requirement'), ...toNotes(cautions, 'caution')]
}
