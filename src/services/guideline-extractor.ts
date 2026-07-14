/**
 * 期刊规范 AI 提取服务
 * -------------------------------------------------
 * 功能：从投稿须知（Markdown/纯文本/HTML）中提取期刊排版参数
 * 输出：结构化的期刊模板配置（document class / 引用样式 / 双栏 / 字号 等）
 *
 * 设计原则：
 * - 用户粘贴投稿须知 → AI 提取 → 生成可复用模板
 * - 提取结果供用户确认和修改，不做 100% 准确保证
 * - 提取时同时生成 "格式说明" 字段，告诉 AI 排版时的注意事项
 */
import { callAI } from './ai/client'
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

const SYSTEM_PROMPT = `你是一名专业的学术期刊格式分析助手。你的任务是从投稿须知中提取期刊排版的关键参数。

请仔细阅读投稿须知，提取以下信息并以 JSON 格式输出：

{
  "name": "期刊全称",
  "short_name": "期刊简称/缩写（如有）",
  "publisher": "出版社名称",
  "document_class": "推荐的 LaTeX 文档类，如 article / elsarticle / IEEEtran / acmart 等。如果没有明确说明，用 article",
  "document_options": "文档类选项，如 twocolumn,12pt 等",
  "packages": ["需要的宏包列表，如 amsmath, graphicx, booktabs 等"],
  "bibtex_style": "BibTeX 引用样式，如 unsrt / apalike / ieeetr / plain / IEEEtran 等。如果不确定，用 unsrt",
  "two_column": true/false,
  "font_size": 正文字号（数字，单位 pt）,
  "margins": {
    "top": "上边距，如 2.5cm",
    "bottom": "下边距",
    "left": "左边距",
    "right": "右边距"
  },
  "title_format_note": "标题格式的详细说明（给排版 AI 看），包括层级、字体、大小写要求等",
  "abstract_format_note": "摘要格式说明，包括位置、字数限制等",
  "reference_format_note": "参考文献格式说明，包括排序方式、引用编号格式等",
  "figure_table_note": "图表格式说明，包括位置、编号、标题位置等",
  "custom_preamble": "建议的自定义 LaTeX 前置代码（如果有特殊要求）",
  "word_limit_note": "字数限制说明（如果有）",
  "confidence_note": "你对提取结果的置信度说明，哪些信息是确定的，哪些是推断的",
  "key_points": ["提取的关键格式点列表，用简洁中文列出，供用户快速核对"]
}

提取规则：
1. 只基于投稿须知中的明确信息，不确定的字段留空或用最保守的默认值
2. document_class：如果期刊提供了 LaTeX 模板，用对应的文档类；否则用 article
3. two_column：如果明确说双栏/two-column/twocolumn 就是 true，否则默认 false
4. font_size：如果提到用 10pt/11pt/12pt，提取数字；没有明确说明默认 12pt
5. bibtex_style：根据期刊常用样式推断，不确定时用 unsrt
6. packages：只列必要的宏包，如 amsmath, graphicx, amssymb, booktabs, hyperref
7. key_points：列出 5-10 个最重要的格式要点，让用户能快速核对

输出要求：
- 严格 JSON 格式，不要任何额外文字
- 不要用 markdown 代码块包裹
- 中文输出说明性内容（key_points, confidence_note 等）`

/**
 * 从投稿须知文本中提取期刊格式规范
 */
export async function extractGuidelinesWithAI(params: {
  guidelinesText: string
  baseUrl: string
  apiKey: string
  model: string
}): Promise<ExtractedGuidelines> {
  const { guidelinesText, baseUrl, apiKey, model } = params

  // 截取前 8000 字符（避免 token 超限，投稿须知的关键信息一般在前半部分）
  const truncated = guidelinesText.slice(0, 8000)

  const userPrompt = `【投稿须知内容】
${truncated}

${guidelinesText.length > 8000 ? `\n（注：原文共 ${guidelinesText.length} 字，已截取前 8000 字进行分析）\n` : ''}

请从上述投稿须知中提取期刊排版参数，按 system 指令输出 JSON。`

  const resp = await callAI({
    baseUrl,
    apiKey,
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.1,
    maxTokens: 2048,
  })

  return parseExtractionResult(resp.content)
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
