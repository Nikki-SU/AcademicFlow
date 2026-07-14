/**
 * LaTeX 转换服务：AI 驱动的 Markdown → 期刊 LaTeX 排版
 * -------------------------------------------------
 * 核心流程：
 * 1. 提取 Markdown 中的引用（DOI）
 * 2. 调用 AI-1 将 Markdown 转换为 LaTeX 正文（期刊模板感知）
 * 3. 调用 AI-2 做格式核查（确保符合期刊要求）
 * 4. 将引用标记替换为 \cite{key}
 * 5. 根据期刊模板组装完整 LaTeX 文档
 * 6. 生成 BibTeX
 */
import { callAI } from './ai/client'
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
// AI-2: 格式核查
// ============================================================

function buildAI2SystemPrompt(template: JournalTemplate): string {
  return [
    '你是一名严格的 LaTeX 格式审查助手。你的任务是检查 AI 生成的 LaTeX 正文',
    '是否符合目标期刊的排版要求。',
    '',
    '【目标期刊模板】',
    `- 期刊名称：${template.name}`,
    `- 文档类：${template.document_class}`,
    `- 引用样式：${template.bibtex_style}`,
    `- 双栏：${template.two_column ? '是' : '否'}`,
    '',
    '【审查清单】',
    '1. 标题层级是否正确（\\section / \\subsection 等）',
    '2. 摘要是否在 abstract 环境中',
    '3. 公式环境是否正确',
    '4. 表格和图片环境是否正确（双栏是否用了 figure* / table*）',
    '5. 引用标记 [@...] 是否保持原样未被修改',
    '6. 是否有 Markdown 语法残留（如 **、*、# 等）',
    '7. 特殊字符是否正确转义（%, &, _, # 等）',
    '',
    '【输出格式】严格 JSON',
    '{',
    '  "passed": boolean,',
    '  "issues": [',
    '    { "type": "error"|"warning", "line": number|null, "description": "问题描述", "suggestion": "修改建议" }',
    '  ],',
    '  "summary": "整体评价（中文）"',
    '}',
  ].join('\n')
}

function buildAI2UserPrompt(latexBody: string): string {
  return [
    '【待审查的 LaTeX 正文】',
    latexBody,
    '',
    '请按 system 指令审查这段 LaTeX 代码，输出 JSON。',
  ].join('\n')
}

function parseAI2Review(rawOutput: string): {
  passed: boolean
  issues: Array<{ type: string; line: number | null; description: string; suggestion: string }>
  summary: string
} {
  let jsonText = rawOutput.trim()

  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonText = fenceMatch[1].trim()

  const firstBrace = jsonText.indexOf('{')
  const lastBrace = jsonText.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    jsonText = jsonText.slice(firstBrace, lastBrace + 1)
  }

  try {
    const parsed = JSON.parse(jsonText)
    return {
      passed: Boolean(parsed.passed),
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      summary: String(parsed.summary || ''),
    }
  } catch {
    return {
      passed: false,
      issues: [],
      summary: rawOutput.slice(0, 500),
    }
  }
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

    // ---- 阶段 3: AI-1 转换 ----
    onProgress?.({ stage: 'ai_converting', message: 'AI-1: Markdown → LaTeX 转换中...' })
    const ai1Resp = await callAI({
      baseUrl: ai1.baseUrl,
      apiKey: ai1.apiKey,
      model: ai1.model,
      messages: [
        { role: 'system', content: buildAI1SystemPrompt(template) },
        { role: 'user', content: buildAI1UserPrompt(markdown) },
      ],
      temperature: 0.2,
      maxTokens: 4096,
    })
    let latexBody = ai1Resp.content.trim()

    // 去掉可能的代码块包裹
    const fenceMatch = latexBody.match(/```(?:latex|tex)?\s*([\s\S]*?)```/i)
    if (fenceMatch) {
      latexBody = fenceMatch[1].trim()
    }

    // ---- 阶段 4: AI-2 审查（可选） ----
    let ai2RawOutput = ''
    if (enableReview) {
      onProgress?.({ stage: 'ai_reviewing', message: 'AI-2: 格式审查中...' })
      try {
        const ai2Resp = await callAI({
          baseUrl: ai2.baseUrl,
          apiKey: ai2.apiKey,
          model: ai2.model,
          messages: [
            { role: 'system', content: buildAI2SystemPrompt(template) },
            { role: 'user', content: buildAI2UserPrompt(latexBody) },
          ],
          temperature: 0.1,
          maxTokens: 2048,
        })
        ai2RawOutput = ai2Resp.content
        // TODO: 如果审查不通过，可以触发重写（演示版暂不做自动重写）
        const review = parseAI2Review(ai2RawOutput)
        if (!review.passed) {
          console.warn('[latex-converter] AI-2 review not passed:', review.summary)
        }
      } catch (err) {
        console.warn('[latex-converter] AI-2 review failed:', err)
      }
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
      ai_raw_output: ai1Resp.content,
      duration_ms: duration,
      journal_template_id: template.id,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress?.({ stage: 'error', message: `转换失败：${msg}`, detail: err })
    throw err
  }
}
