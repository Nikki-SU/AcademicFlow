/**
 * 期刊规范 AI 提取服务
 * -------------------------------------------------
 * 功能：从投稿须知（Markdown/纯文本/HTML）中提取期刊排版参数
 * 输出：结构化的期刊模板配置（document class / 引用样式 / 双栏 / 字号 等）
 *
 * 设计原则：
 * - 用户粘贴投稿须知 → AI-1 提取结构化参数 → AI-2 忠实性核查 + 引证锚定 → 生成可复用模板
 * - 复用 dual-engine.ts 的完整双引擎基础设施，确保所有 AI 可信检索场景逻辑一致
 * - 投稿须知原文 = 唯一 ground truth（sourceMaterial）；AI-1 的提取结果必须可在原文中找到 span 支撑
 * - 提取结果供用户确认和修改，不做 100% 准确保证
 */
import { runDualEngine } from './ai/dual-engine'
import type { DualEngineProgressCallback } from '../types'
import type { JournalTemplate } from '../types'

/** AI 提取结果 */
export interface ExtractedGuidelines {
  /** 期刊全称 */
  name: string
  /** 期刊简称 */
  short_name?: string
  /** 出版社 */
  publisher?: string
  /** 推荐的 LaTeX document class */
  document_class: string
  /** 文档选项（逗号分隔） */
  document_options?: string
  /** 推荐的宏包列表 */
  packages: string[]
  /** BibTeX 引用样式 */
  bibtex_style: string
  /** 是否双栏 */
  two_column: boolean
  /** 字号（pt） */
  font_size: number
  /** 页边距配置 */
  margins?: {
    top?: string
    bottom?: string
    left?: string
    right?: string
  }
  /** 标题格式说明（给排版 AI 用） */
  title_format_note?: string
  /** 摘要格式说明 */
  abstract_format_note?: string
  /** 参考文献格式说明 */
  reference_format_note?: string
  /** 图表格式说明 */
  figure_table_note?: string
  /** 自定义前置代码建议 */
  custom_preamble?: string
  /** 字数限制说明 */
  word_limit_note?: string
  /** AI 对提取结果的置信度说明 */
  confidence_note: string
  /** 提取的关键格式点列表（给用户确认） */
  key_points: string[]
}

/**
 * 从投稿须知文本中提取期刊格式规范（双引擎版）
 * -------------------------------------------------
 * - AI-1：拿投稿须知原文（ground truth）→ 提取结构化参数 JSON
 * - AI-2：拿 (投稿须知原文, AI-1 JSON) → 核查每个字段是否真实来自原文
 * - 引证锚定：AI-2 给出的 source_span 必须能在投稿须知原文中 grep 到
 * - 分层归因重试：AI-1 加戏→重写；AI-2 编造 span→自纠；最多 5 轮
 *
 * @param params.guidelinesText 投稿须知原文（唯一 ground truth）
 * @param params.ai1 AI-1 端点配置
 * @param params.ai2 AI-2 端点配置
 * @param params.onProgress 可选的双引擎进度回调
 */
export async function extractGuidelinesWithAI(params: {
  guidelinesText: string
  ai1: { baseUrl: string; apiKey: string; model: string }
  ai2: { baseUrl: string; apiKey: string; model: string }
  onProgress?: DualEngineProgressCallback
}): Promise<ExtractedGuidelines> {
  const { guidelinesText, ai1, ai2, onProgress } = params

  // 截取前 8000 字符（避免 token 超限，投稿须知的关键信息一般在前半部分）
  const truncated = guidelinesText.slice(0, 8000)
  const sourceMaterial = guidelinesText.length > 8000
    ? `${truncated}\n\n（注：原文共 ${guidelinesText.length} 字，已截取前 8000 字作为核查范围）`
    : guidelinesText

  // AI-1 角色 prompt：替换默认的"学术总结助手"为"期刊规范提取助手"
  // [NOT_IN_SOURCE] tag 指令由 dual-engine 自动追加，确保投稿须知未提及的字段被诚实标注
  const ai1RolePrompt = [
    '你是一名专业的学术期刊格式分析助手。用户会提供一段【源材料】（投稿须知原文）和一条【任务指令】，',
    '你需要按指令提取期刊排版的关键参数，并以 JSON 格式输出。',
    '',
    '【核心约束（必须严格遵守）】',
    '1. 只使用【源材料】中的信息，禁止引入源材料未提及的外部知识、常识、推测或对其他期刊的记忆。',
    '2. 若源材料信息不足以确定某字段，宁可留空或用最保守的默认值（如 document_class 默认 article），也不要猜测/补全/编造。',
    '3. 忠于原文字面含义，不泛化、不外推、不改写数字/字号/边距/期刊名。',
    '4. 输出严格 JSON 格式，不要任何额外文字、不要 markdown 代码块包裹。',
    '5. 中文输出说明性内容（key_points, confidence_note 等）。',
  ].join('\n')

  // AI-1 任务指令：定义输出 JSON schema + 提取规则
  const ai1Instruction = [
    '请仔细阅读上述源材料（投稿须知），提取期刊排版的关键参数，严格按以下 JSON 结构输出：',
    '',
    '{',
    '  "name": "期刊全称",',
    '  "short_name": "期刊简称/缩写（如有）",',
    '  "publisher": "出版社名称",',
    '  "document_class": "推荐的 LaTeX 文档类，如 article / elsarticle / IEEEtran / acmart 等。如果没有明确说明，用 article",',
    '  "document_options": "文档类选项，如 twocolumn,12pt 等",',
    '  "packages": ["需要的宏包列表，如 amsmath, graphicx, booktabs 等"],',
    '  "bibtex_style": "BibTeX 引用样式，如 unsrt / apalike / ieeetr / plain / IEEEtran 等。如果不确定，用 unsrt",',
    '  "two_column": true/false,',
    '  "font_size": 正文字号（数字，单位 pt）,',
    '  "margins": {"top": "上边距，如 2.5cm", "bottom": "下边距", "left": "左边距", "right": "右边距"},',
    '  "title_format_note": "标题格式的详细说明（给排版 AI 看）",',
    '  "abstract_format_note": "摘要格式说明",',
    '  "reference_format_note": "参考文献格式说明",',
    '  "figure_table_note": "图表格式说明",',
    '  "custom_preamble": "建议的自定义 LaTeX 前置代码（如果有特殊要求）",',
    '  "word_limit_note": "字数限制说明（如果有）",',
    '  "confidence_note": "你对提取结果的置信度说明，哪些信息是确定的，哪些是推断的",',
    '  "key_points": ["提取的关键格式点列表，用简洁中文列出，供用户快速核对"]',
    '}',
    '',
    '【提取规则】',
    '1. 只基于投稿须知中的明确信息，不确定的字段留空或用最保守的默认值。',
    '2. document_class：如果期刊提供了 LaTeX 模板，用对应的文档类；否则用 article。',
    '3. two_column：如果明确说双栏/two-column/twocolumn 就是 true，否则默认 false。',
    '4. font_size：如果提到用 10pt/11pt/12pt，提取数字；没有明确说明默认 12。',
    '5. bibtex_style：根据期刊常用样式推断，不确定时用 unsrt。',
    '6. packages：只列必要的宏包，如 amsmath, graphicx, amssymb, booktabs, hyperref。',
    '7. key_points：列出 5-10 个最重要的格式要点，让用户能快速核对。',
  ].join('\n')

  // 调用双引擎（AI-1 提取 + AI-2 核查 + 引证锚定 + 分层归因重试）
  const dualResult = await runDualEngine({
    taskType: 'faithfulness_check',
    sourceMaterial,
    ai1Instruction,
    ai1: ai1,
    ai2: ai2,
    ai1RolePrompt,
    onProgress,
  })

  const extracted = parseExtractionResult(dualResult.ai1Output)

  // 把双引擎审阅结果附加到 confidence_note（让用户看到 AI-2 的核查结论）
  const reviewSummary = dualResult.finalPassed
    ? 'AI-2 忠实性核查通过：所有字段均可锚定到投稿须知原文。'
    : `AI-2 忠实性核查未通过（${dualResult.attempts.length} 轮）：${dualResult.ai2Feedback.summary || '部分字段可能未严格来自原文，请人工核对'}。`
  extracted.confidence_note = `${reviewSummary}\n\n${extracted.confidence_note}`

  return extracted
}

/**
 * 解析 AI 提取结果
 */
function parseExtractionResult(rawOutput: string): ExtractedGuidelines {
  let jsonText = rawOutput.trim()

  // 去掉可能的代码块包裹
  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonText = fenceMatch[1].trim()

  // 找到第一个 { 和最后一个 }
  const firstBrace = jsonText.indexOf('{')
  const lastBrace = jsonText.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    jsonText = jsonText.slice(firstBrace, lastBrace + 1)
  }

  try {
    const parsed = JSON.parse(jsonText)
    return {
      name: String(parsed.name || '未命名期刊'),
      short_name: parsed.short_name ? String(parsed.short_name) : undefined,
      publisher: parsed.publisher ? String(parsed.publisher) : undefined,
      document_class: String(parsed.document_class || 'article'),
      document_options: parsed.document_options ? String(parsed.document_options) : undefined,
      packages: Array.isArray(parsed.packages) ? parsed.packages.map(String) : [],
      bibtex_style: String(parsed.bibtex_style || 'unsrt'),
      two_column: Boolean(parsed.two_column),
      font_size: Number(parsed.font_size) || 12,
      margins: parsed.margins || undefined,
      title_format_note: parsed.title_format_note ? String(parsed.title_format_note) : undefined,
      abstract_format_note: parsed.abstract_format_note ? String(parsed.abstract_format_note) : undefined,
      reference_format_note: parsed.reference_format_note ? String(parsed.reference_format_note) : undefined,
      figure_table_note: parsed.figure_table_note ? String(parsed.figure_table_note) : undefined,
      custom_preamble: parsed.custom_preamble ? String(parsed.custom_preamble) : undefined,
      word_limit_note: parsed.word_limit_note ? String(parsed.word_limit_note) : undefined,
      confidence_note: String(parsed.confidence_note || 'AI 提取结果，请人工核对'),
      key_points: Array.isArray(parsed.key_points) ? parsed.key_points.map(String) : [],
    }
  } catch (err) {
    console.warn('[guideline-extractor] JSON parse failed, raw output:', rawOutput.slice(0, 500))
    throw new Error('AI 返回结果解析失败，请重试')
  }
}

/**
 * 将提取结果应用到模板（创建或更新）
 */
export function applyExtractedToTemplate(
  template: Partial<JournalTemplate>,
  extracted: ExtractedGuidelines,
): Partial<JournalTemplate> {
  return {
    ...template,
    name: extracted.name,
    short_name: extracted.short_name,
    publisher: extracted.publisher,
    document_class: extracted.document_class,
    document_options: extracted.document_options,
    packages: extracted.packages,
    bibtex_style: extracted.bibtex_style,
    two_column: extracted.two_column,
    font_size: extracted.font_size,
    margins: extracted.margins,
    title_format_note: extracted.title_format_note,
    abstract_format_note: extracted.abstract_format_note,
    reference_format_note: extracted.reference_format_note,
    custom_preamble: extracted.custom_preamble,
    notes: (template.notes ? template.notes + '\n\n' : '') +
      `AI 提取置信度：${extracted.confidence_note}\n\n` +
      `关键格式点：\n${extracted.key_points.map((p) => `- ${p}`).join('\n')}`,
  }
}
