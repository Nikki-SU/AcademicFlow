/**
 * LaTeX 转换服务：AI 驱动的 Markdown → 期刊 LaTeX 排版
 * -------------------------------------------------
 * 核心流程：
 * 1. 提取 Markdown 中的引用（DOI）
 * 2. 调用 runDualEngine（AI-1 转换 + AI-2 忠实性核查 + 引证锚定 + [NOT_IN_SOURCE] tag）
 *    复用 dual-engine.ts 的完整双引擎基础设施，确保所有 AI 可信检索场景逻辑一致
 * 3. 将引用标记替换为 \cite{key}
 * 4. 根据期刊模板组装完整 LaTeX 文档
 * 5. 生成 BibTeX
 */
import { runDualEngine } from './ai/dual-engine'
import type { DualEngineProgressCallback } from '../types'
import {
  extractCitationsFromMarkdown,
  getCitationEntries,
  generateBibtex,
} from './citation'
import type { JournalTemplate, LatexConversionResult } from '../types'

/** 转换进度回调 */
export type LatexConvertProgress = (stage: {
  stage:
    | 'extracting_citations'
    | 'fetching_citation_data'
    | 'ai_converting'
    | 'ai_reviewing'
    | 'assembling'
    | 'done'
    | 'error'
  message?: string
  detail?: unknown
}) => void

interface ConvertParams {
  markdown: string
  template: JournalTemplate
  ai1: {
    baseUrl: string
    apiKey: string
    model: string
  }
  ai2: {
    baseUrl: string
    apiKey: string
    model: string
  }
  /** 引用排序方式 */
  citationSortMode?: 'appearance' | 'author-year' | 'alphabetical'
  /** 是否启用 AI-2 审查（默认 true） */
  enableReview?: boolean
  onProgress?: LatexConvertProgress
}

// ============================================================
// AI-1: Markdown → LaTeX 正文转换
// ============================================================

function buildAI1SystemPrompt(template: JournalTemplate): string {
  const twoColNote = template.two_column
    ? '双栏排版（twocolumn），注意图表位置和文字流动。'
    : '单栏排版。'

  return [
    '你是一名专业的学术 LaTeX 排版助手。你的任务是将 Markdown 格式的学术论文',
    '转换为符合特定期刊要求的 LaTeX 正文代码。',
    '',
    '【目标期刊模板】',
    `- 期刊名称：${template.name}`,
    `- 文档类：${template.document_class}${template.document_options ? ` [${template.document_options}]` : ''}`,
    `- 引用样式：${template.bibtex_style}`,
    `- 排版方式：${twoColNote}`,
    template.title_format_note ? `- 标题格式要求：${template.title_format_note}` : '',
    template.abstract_format_note ? `- 摘要格式要求：${template.abstract_format_note}` : '',
    template.reference_format_note ? `- 参考文献格式：${template.reference_format_note}` : '',
    template.custom_preamble ? `- 自定义前置代码：${template.custom_preamble}` : '',
    '',
    '【转换规则（严格遵守）】',
    '1. 只输出 LaTeX 正文部分（\\begin{document} 和 \\end{document} 之间的内容），',
    '   不要包含 \\documentclass、\\usepackage、\\begin{document}、\\end{document}。',
    '2. Markdown 标题转换为 LaTeX 对应层级：',
    '   # → \\title',
    '   ## → \\section',
    '   ### → \\subsection',
    '   #### → \\subsubsection',
    '3. 第一个 # 标题是论文标题，用 \\title{...} 包裹。',
    '4. 如果 Markdown 中有 "作者" 或 "Author" 信息，转换为 \\author{...}。',
    '5. 如果有 "摘要" 或 "Abstract" 段落，放在 \\begin{abstract}...\\end{abstract} 中。',
    '6. 引用标记处理：',
    '   - Markdown 中的 [@doi:10.xxx/xxx] 或 [@10.xxx/xxx] 保持原样不动',
    '   - 不要把 DOI 转换成具体的引用编号',
    '   - 后续系统会统一处理引用替换',
    '7. 公式：',
    '   - 行内公式 $...$ 保持不变（LaTeX 原生支持）',
    '   - 独立公式 $$...$$ 转换为 \\begin{equation}...\\end{equation}',
    '8. 表格：Markdown 表格转换为 LaTeX table 环境，根据期刊风格调整。',
    '9. 图片：![caption](url) 转换为 \\begin{figure}...\\end{figure}，',
    '   包含 \\includegraphics 和 \\caption。注意双栏时用 figure* 环境。',
    '10. 列表：itemize / enumerate 环境。',
    '11. 粗体 **text** → \\textbf{text}，斜体 *text* → \\textit{text}。',
    '12. 代码块 → verbatim 或 lstlisting 环境。',
    '13. 引用标记（[@...]）在正文中出现的位置保持不变，稍后系统会统一替换。',
    '',
    '【输出要求】',
    '- 只输出 LaTeX 代码，不要任何解释说明文字',
    '- 不要用 markdown 代码块包裹',
    '- 保持正确的缩进和换行',
    '- 确保代码可直接编译',
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n')
}

function buildAI1UserPrompt(markdown: string): string {
  return [
    '【Markdown 原文】',
    markdown,
    '',
    '请将上述 Markdown 论文转换为 LaTeX 正文代码。',
    '注意：[@doi:xxx] 或 [@10.xxx/xxx] 形式的引用标记保持原样，不要替换。',
  ].join('\n')
}

// ============================================================
// 引用替换：将 [@doi:xxx] 替换为 \cite{key}
// ============================================================

function replaceCitationMarkers(
  latexBody: string,
  citeKeys: Record<string, string>,
): string {
  let result = latexBody

  // 替换 [@doi:10.xxx/xxx] 和 [@10.xxx/xxx] 格式
  result = result.replace(
    /\[@(?:doi:)?([^\]]+)\]/gi,
    (match, doiRaw: string) => {
      // 可能有多个引用用逗号分隔：[@doi:10.a, @doi:10.b]
      const parts = doiRaw.split(/[;,]/).map((s) => s.trim())
      const keys: string[] = []

      for (const part of parts) {
        // 去掉可能的 @ 前缀
        const clean = part.replace(/^@/, '').replace(/^doi:/i, '').trim()
        // 归一化查找
        const normalized = clean.toLowerCase()
        const foundKey = citeKeys[normalized]
        if (foundKey) {
          keys.push(foundKey)
        } else {
          // 没找到就保留原始 DOI
          keys.push(`doi:${clean}`)
        }
      }

      if (keys.length > 0) {
        return `\\cite{${keys.join(',')}}`
      }
      return match
    },
  )

  // 也处理直接的 DOI 链接（https://doi.org/...）
  // 注意：只有当 DOI 链接是作为引用标记出现时才替换
  // 这里不替换正文叙述中的 DOI 链接，只替换引用标记格式的

  return result
}

// ============================================================
// 组装完整 LaTeX 文档
// ============================================================

function assembleFullLatex(
  body: string,
  template: JournalTemplate,
  bibFileName: string = 'references.bib',
): string {
  const lines: string[] = []

  // documentclass
  const clsOptions = template.document_options || ''
  if (clsOptions) {
    lines.push(`\\documentclass[${clsOptions}]{${template.document_class}}`)
  } else {
    lines.push(`\\documentclass{${template.document_class}}`)
  }
  lines.push('')

  // 宏包
  const defaultPackages = [
    'amsmath',
    'amssymb',
    'graphicx',
    'booktabs',
    'hyperref',
  ]
  const allPackages = [...defaultPackages, ...template.packages]
  // 去重
  const seen = new Set<string>()
  for (const pkg of allPackages) {
    if (!seen.has(pkg)) {
      seen.add(pkg)
      lines.push(`\\usepackage{${pkg}}`)
    }
  }
  lines.push('')

  // 自定义前置代码
  if (template.custom_preamble) {
    lines.push(template.custom_preamble)
    lines.push('')
  }

  // 标题相关（从 body 中提取 \title 和 \author）
  // 注意：AI 生成的 body 里已经包含 \title 和 \author，会在 document 环境中使用

  lines.push('\\begin{document}')
  lines.push('')

  // 正文
  lines.push(body)
  lines.push('')

  // 参考文献
  lines.push('\\bibliographystyle{' + template.bibtex_style + '}')
  lines.push('\\bibliography{' + bibFileName + '}')
  lines.push('')

  lines.push('\\end{document}')

  return lines.join('\n')
}

/**
 * 用期刊模板拼一份「能直接编译」的最小骨架文档。
 * -------------------------------------------------
 * 模板调试场景下，用户可能还没往 template.tex 里写过任何东西，
 * 但代码板需要有个可编译的起点，否则空代码板一上来就报错。
 */
export function buildLatexSkeletonFromTemplate(template: JournalTemplate): string {
  const body = [
    '\\title{论文标题}',
    '\\author{作者}',
    '\\date{\\today}',
    '',
    '\\begin{document}',
    '\\maketitle',
    '',
    '\\begin{abstract}',
    '摘要内容。',
    '\\end{abstract}',
    '',
    '\\section{引言}',
    '正文内容。',
    '',
    '\\bibliographystyle{' + template.bibtex_style + '}',
    '\\bibliography{references}',
    '',
    '\\end{document}',
  ]
  return assembleFullLatex(body.join('\n'), template)
}

// ============================================================
// AI 修改 LaTeX 代码（模板调试 / 代码板润色）
// ============================================================

interface RefineLatexParams {
  /** 当前 LaTeX 代码：既是修改对象，也是忠实性核查的基准 */
  latex: string
  /** 用户的修改指令，如「改成双栏」「摘要压到 200 字以内」 */
  instruction: string
  /** 目标期刊模板，提供 documentclass / 引用样式等上下文 */
  template?: JournalTemplate | null
  /**
   * 可信检索：把期刊投稿须知原文一并作为 ground truth 交给 AI。
   * 关闭时 AI 只能依据当前代码 + 自身知识作答。
   */
  guidelines?: string
  ai1: {
    baseUrl: string
    apiKey: string
    model: string
  }
  ai2: {
    baseUrl: string
    apiKey: string
    model: string
  }
  enableReview?: boolean
  onProgress?: LatexConvertProgress
}

export interface RefineLatexResult {
  latex: string
  reviewPassed?: boolean
  reviewIssues?: Array<{ type: string; description: string; suggestion: string }>
  ai_raw_output: string
  duration_ms: number
}

/**
 * 让 AI 按指令修改现有 LaTeX 代码。
 * -------------------------------------------------
 * 复用 runDualEngine：AI-1 改代码，AI-2 拿「原始代码 / 投稿须知」做忠实性核查 ——
 * 防止 AI 顺手替用户改需求之外的东西，或凭空编造投稿须知里没有的排版要求。
 */
export async function refineLatexWithAI(
  params: RefineLatexParams,
): Promise<RefineLatexResult> {
  const {
    latex,
    instruction,
    template,
    guidelines,
    ai1,
    ai2,
    enableReview = true,
    onProgress,
  } = params

  const startTime = Date.now()

  // 源材料 = 当前代码 +（可信检索时的）投稿须知原文；
  // AI-2 的每条 claim 都必须能在这份材料里锚定到原文。
  const sourceParts: string[] = ['【当前 LaTeX 代码】', latex]
  if (guidelines && guidelines.trim()) {
    sourceParts.push('', '【期刊投稿须知原文】', guidelines)
  }
  if (template) {
    sourceParts.push(
      '',
      '【目标期刊模板参数】',
      `- 期刊名称：${template.name}`,
      `- 文档类：${template.document_class}${template.document_options ? ` [${template.document_options}]` : ''}`,
      `- 引用样式：${template.bibtex_style}`,
      `- 排版方式：${template.two_column ? '双栏（twocolumn）' : '单栏'}`,
      template.custom_preamble ? `- 自定义前置代码：${template.custom_preamble}` : '',
    )
  }
  const sourceMaterial = sourceParts.filter((line) => line !== '').join('\n')

  const ai1RolePrompt = [
    '你是一名专业的学术 LaTeX 排版工程师。用户会提供一份【源材料】（当前 LaTeX 代码，',
    '可能还包含期刊投稿须知原文）和一条【修改指令】，你要按指令修改 LaTeX 代码。',
    '',
    '【核心约束（必须严格遵守）】',
    '1. 只做【修改指令】要求的那件事，其余内容原样保留（含注释、空行、宏包顺序）。',
    '2. 禁止引入指令未要求的新内容；禁止删改与指令无关的正文、图表、引用。',
    '3. 若指令要求的内容在源材料中找不到依据，不要编造，用 [NOT_IN_SOURCE] 标注该处。',
    '4. 输出必须是完整、可直接编译的 LaTeX 源码（保留 \\documentclass 与 \\begin{document}）。',
    '5. 只输出 LaTeX 代码，不要任何解释文字，不要用 markdown 代码块包裹。',
  ].join('\n')

  const ai1Instruction = [
    '请按下面的【修改指令】修改【当前 LaTeX 代码】。',
    '',
    '【修改指令】',
    instruction,
    '',
    '输出要求：',
    '- 输出修改后的完整 LaTeX 源码（可编译）',
    '- 不要 markdown 代码块，不要解释',
  ].join('\n')

  const dualEngineProgress: DualEngineProgressCallback = (event) => {
    switch (event.stage) {
      case 'ai1_running':
        onProgress?.({ stage: 'ai_converting', message: `AI-1: 修改 LaTeX 代码（第 ${event.attempt} 轮）...` })
        break
      case 'ai1_done':
        onProgress?.({ stage: 'ai_converting', message: 'AI-1 修改完成，准备 AI-2 核查...' })
        break
      case 'ai2_running':
        onProgress?.({ stage: 'ai_reviewing', message: `AI-2: 修改忠实性核查中（第 ${event.attempt} 轮）...` })
        break
      case 'ai2_self_correct_running':
        onProgress?.({ stage: 'ai_reviewing', message: `AI-2: 引证锚定自纠中（第 ${event.attempt} 轮）...` })
        break
      case 'verifying':
        onProgress?.({ stage: 'ai_reviewing', message: '引证锚定校验中...' })
        break
      case 'attempt_failed_retry':
        onProgress?.({ stage: 'ai_reviewing', message: `第 ${event.attempt} 轮未通过，准备重试...` })
        break
      case 'finished':
        onProgress?.({ stage: 'ai_reviewing', message: '双引擎核查完成' })
        break
      case 'error':
        onProgress?.({ stage: 'error', message: `双引擎错误：${event.errorMessage}` })
        break
    }
  }

  try {
    const dualResult = await runDualEngine({
      taskType: 'latex_conversion',
      sourceMaterial,
      ai1Instruction,
      ai1,
      ai2,
      onProgress: dualEngineProgress,
      ai1RolePrompt,
      ...(enableReview ? {} : { maxAttempts: 1 }),
    })

    let nextLatex = dualResult.ai1Output.trim()
    const fenceMatch = nextLatex.match(/```(?:latex|tex)?\s*([\s\S]*?)```/i)
    if (fenceMatch) nextLatex = fenceMatch[1].trim()

    const duration = Date.now() - startTime
    onProgress?.({ stage: 'done', message: `完成！耗时 ${(duration / 1000).toFixed(1)}s` })

    return {
      latex: nextLatex,
      reviewPassed: dualResult.finalPassed,
      reviewIssues: dualResult.ai2Feedback.claims
        .filter((c) => c.verdict !== 'supported')
        .map((c) => ({
          type: c.verdict,
          description: c.claim,
          suggestion: c.explanation,
        })),
      ai_raw_output: dualResult.ai1Output,
      duration_ms: duration,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress?.({ stage: 'error', message: `修改失败：${msg}`, detail: err })
    throw err
  }
}

// ============================================================
// 主转换函数
// ============================================================

export async function convertMarkdownToLatex(
  params: ConvertParams,
): Promise<LatexConversionResult> {
  const {
    markdown,
    template,
    ai1,
    ai2,
    citationSortMode = 'appearance',
    enableReview = true,
    onProgress,
  } = params

  const startTime = Date.now()

  try {
    // ---- 阶段 1: 提取引用 ----
    onProgress?.({ stage: 'extracting_citations', message: '提取 Markdown 中的引用...' })
    const citedDois = extractCitationsFromMarkdown(markdown)

    // ---- 阶段 2: 获取引用元数据 ----
    onProgress?.({
      stage: 'fetching_citation_data',
      message: `获取 ${citedDois.length} 篇文献的元数据...`,
    })
    const { entries, failed } = await getCitationEntries(citedDois)

    // ---- 阶段 3+4: 调用 runDualEngine（AI-1 转换 + AI-2 忠实性核查 + 引证锚定 + [NOT_IN_SOURCE]） ----
    // 复用 dual-engine.ts 的完整双引擎基础设施，确保所有 AI 可信检索场景逻辑一致：
    //   - AI-1 基于 Markdown 源材料生成 LaTeX，缺失字段用 [NOT_IN_SOURCE] tag 诚实标注
    //   - 引证锚定：AI-2 给出的 source_span 必须能在源材料中 grep 到
    //   - 分层归因重试：引证失败→AI-2自纠；忠实性失败→AI-1重写；最多 5 轮
    onProgress?.({ stage: 'ai_converting', message: 'AI-1: Markdown → LaTeX 转换中...' })

    const dualEngineProgress: DualEngineProgressCallback = (event) => {
      switch (event.stage) {
        case 'ai1_running':
          onProgress?.({ stage: 'ai_converting', message: `AI-1: Markdown → LaTeX 转换中（第 ${event.attempt} 轮）...` })
          break
        case 'ai1_done':
          onProgress?.({ stage: 'ai_converting', message: 'AI-1 转换完成，准备 AI-2 核查...' })
          break
        case 'ai2_running':
          onProgress?.({ stage: 'ai_reviewing', message: `AI-2: 忠实性核查中（第 ${event.attempt} 轮）...` })
          break
        case 'ai2_self_correct_running':
          onProgress?.({ stage: 'ai_reviewing', message: `AI-2: 引证锚定自纠中（第 ${event.attempt} 轮）...` })
          break
        case 'verifying':
          onProgress?.({ stage: 'ai_reviewing', message: '引证锚定校验中...' })
          break
        case 'attempt_failed_retry':
          onProgress?.({ stage: 'ai_reviewing', message: `第 ${event.attempt} 轮未通过，准备重试...` })
          break
        case 'finished':
          onProgress?.({ stage: 'ai_reviewing', message: '双引擎核查完成' })
          break
        case 'error':
          onProgress?.({ stage: 'error', message: `双引擎错误：${event.errorMessage}` })
          break
      }
    }

    const ai1RolePrompt = buildAI1SystemPrompt(template)
    const ai1Instruction = buildAI1UserPrompt(markdown)

    let latexBody: string
    let reviewPassed: boolean | undefined
    let reviewIssues: Array<{ type: string; description: string; suggestion: string }> | undefined
    let ai1RawOutput = ''

    if (enableReview) {
      const dualResult = await runDualEngine({
        taskType: 'latex_conversion',
        sourceMaterial: markdown,
        ai1Instruction,
        ai1,
        ai2,
        onProgress: dualEngineProgress,
        ai1RolePrompt,
      })

      latexBody = dualResult.ai1Output.trim()
      ai1RawOutput = dualResult.ai1Output
      reviewPassed = dualResult.finalPassed
      reviewIssues = dualResult.ai2Feedback.claims
        .filter((c) => c.verdict !== 'supported')
        .map((c) => ({
          type: c.verdict,
          description: c.claim,
          suggestion: c.explanation,
        }))
    } else {
      // 不启用审查时，直接调 AI-1（通过 runDualEngine 的 maxAttempts=1 退化为单次调用）
      const dualResult = await runDualEngine({
        taskType: 'latex_conversion',
        sourceMaterial: markdown,
        ai1Instruction,
        ai1,
        ai2,
        onProgress: dualEngineProgress,
        ai1RolePrompt,
        maxAttempts: 1,
      })
      latexBody = dualResult.ai1Output.trim()
      ai1RawOutput = dualResult.ai1Output
    }

    // 去掉可能的代码块包裹
    const fenceMatch = latexBody.match(/```(?:latex|tex)?\s*([\s\S]*?)```/i)
    if (fenceMatch) {
      latexBody = fenceMatch[1].trim()
    }

    // ---- 阶段 5: 生成 BibTeX + 替换引用标记 ----
    onProgress?.({ stage: 'assembling', message: '组装完整 LaTeX 文档...' })

    const { bibtex, citeKeys } = generateBibtex(
      entries,
      citationSortMode,
      citedDois,
    )

    // 替换正文中的引用标记
    latexBody = replaceCitationMarkers(latexBody, citeKeys)

    // 组装完整文档
    const fullLatex = assembleFullLatex(latexBody, template)

    // ---- 完成 ----
    const duration = Date.now() - startTime
    onProgress?.({ stage: 'done', message: `完成！耗时 ${(duration / 1000).toFixed(1)}s` })

    return {
      latex: fullLatex,
      citations: citedDois,
      citation_entries: entries,
      failed_dois: failed,
      bibtex,
      ai_raw_output: ai1RawOutput,
      duration_ms: duration,
      journal_template_id: template.id,
      review_passed: reviewPassed,
      review_issues: reviewIssues,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress?.({ stage: 'error', message: `转换失败：${msg}`, detail: err })
    throw err
  }
}
