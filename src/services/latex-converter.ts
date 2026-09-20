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
import { callAI } from './ai/client'
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

/**
 * 把期刊模板摊成一份**完整规格**交给 AI。
 *
 * 为什么不只给 documentclass + 宏包名：只报这几个参数，AI 只能按通用 article
 * 硬套，出来不像那个期刊。这里把导言区原文、正文命令骨架、以及所有格式备注
 * 一并给出 —— AI 才有足够依据「照着这个期刊的样子写」。
 */
function buildTemplateSpec(template: JournalTemplate): string {
  const twoColNote = template.two_column
    ? '双栏排版（twocolumn），注意图表位置和文字流动'
    : '单栏排版'

  const lines: string[] = [
    `- 期刊名称：${template.name}`,
    `- documentclass：\\documentclass${template.document_options ? `[${template.document_options}]` : ''}{${template.document_class}}`,
    `- 排版方式：${twoColNote}`,
    `- 引用样式：${template.bibtex_style || '（模板未标注）'}`,
  ]
  if (template.font_size) lines.push(`- 正文字号：${template.font_size}pt`)
  if (template.packages.length > 0) lines.push(`- 宏包：${template.packages.join(', ')}`)
  if (template.title_format_note) lines.push(`- 标题格式要求：${template.title_format_note}`)
  if (template.abstract_format_note) lines.push(`- 摘要格式要求：${template.abstract_format_note}`)
  if (template.reference_format_note) lines.push(`- 参考文献格式：${template.reference_format_note}`)

  // 导言区原文（\documentclass 到 \begin{document} 之间）：模板里的自定义命令、
  // 长度设置、宏包选项都在这里。AI 知道这些命令存在，才不会自己瞎定义一个同名的。
  const tex = (template.template_tex || '').trim()
  const beginAt = tex.indexOf('\\begin{document}')
  if (beginAt > 0) {
    const preamble = tex.slice(0, beginAt).trim()
    if (preamble) {
      lines.push('', '- 模板导言区原文（正文里可以直接使用其中定义的命令）：', '```latex', preamble, '```')
    }
  }
  if (template.custom_preamble) {
    lines.push('', '- 自定义前置代码：', '```latex', template.custom_preamble, '```')
  }

  // 正文命令骨架：结构范式（示例文字不要抄）
  const skeleton = extractSkeletonOutline(template.template_tex)
  if (skeleton) {
    lines.push(
      '',
      '- 模板正文的命令骨架（**严格照这个结构写**：标题/作者/摘要/章节/参考文献的写法与顺序；',
      '  其中的示例文字只是结构示范，不要抄进正式稿）：',
      '```latex',
      skeleton,
      '```',
    )
  }

  return lines.join('\n')
}

function buildAI1SystemPrompt(template: JournalTemplate): string {
  return [
    '你是一名专业的学术 LaTeX 排版助手。你的任务是将 Markdown 格式的学术论文',
    '转换为符合特定期刊模板要求的 LaTeX 正文代码。',
    '',
    '【目标期刊模板完整规格】',
    buildTemplateSpec(template),
    '',
    '【转换规则（严格遵守）】',
    '1. 只输出 LaTeX 正文部分（\\begin{document} 和 \\end{document} 之间的内容），',
    '   不要包含 \\documentclass、\\usepackage、\\begin{document}、\\end{document}。',
    '2. **样式全部由上面的模板规格决定**：文档类、宏包、栏数、字号、标题/摘要/参考文献',
    '   的写法都照模板来；不要自行引入模板规格之外的宏包或排版命令。',
    '3. Markdown 标题转换为 LaTeX 对应层级：',
    '   # → \\title（论文标题）',
    '   ## → \\section',
    '   ### → \\subsection',
    '   #### → \\subsubsection',
    '4. 如果 Markdown 中有 "作者" 或 "Author" 信息，转换为 \\author{...}。',
    '5. 如果有 "摘要" 或 "Abstract" 段落，按模板骨架里的摘要环境写法放置。',
    '6. 引用标记处理：',
    '   - Markdown 中的 [@doi:10.xxx/xxx] 或 [@10.xxx/xxx] 保持原样不动',
    '   - 不要把 DOI 转换成具体的引用编号；后续系统会统一处理引用替换',
    '7. 公式：',
    '   - 行内公式 $...$ 保持不变（LaTeX 原生支持）',
    '   - 独立公式 $$...$$ 转换为 \\begin{equation}...\\end{equation}',
    '8. 表格：Markdown 表格转换为 LaTeX table 环境，按模板风格调整；双栏时用 table*。',
    '9. 图片：![caption](url) 转换为 figure 环境，含 \\includegraphics 和 \\caption；双栏时用 figure*。',
    '10. 列表：itemize / enumerate 环境。',
    '11. 粗体 **text** → \\textbf{text}，斜体 *text* → \\textit{text}。',
    '12. 代码块 → verbatim 或 lstlisting 环境。',
    '',
    '【块锚点（重要，用于后续「只改改动的段落」）】',
    'Markdown 原文按空行被切成若干「块」，每块前面都标了形如 `<!--af:blk:XXXX-->` 的块号。',
    '输出时，**每个块对应的 LaTeX 片段都要用注释锚点包起来**，格式严格如下（一字不差）：',
    '   %⟦af:blk:XXXX⟧',
    '   ...该块转换出来的 LaTeX...',
    '   %⟦/af:blk:XXXX⟧',
    `其中 XXXX 就是该块在 Markdown 里的块号（不含 \`<!--af:blk:\` 前缀与 \`-->\` 后缀）。`,
    '一个块拆成多个 LaTeX 命令也要全部包在同一对锚点里；锚点行必须各自独占一行。',
    '锚点是 LaTeX 注释，不影响编译，但**不能省略、不能改名、不能嵌套**。',
    '',
    '【输出要求】',
    '- 只输出 LaTeX 代码，不要任何解释说明文字',
    '- 不要用 markdown 代码块包裹',
    '- 保持正确的缩进和换行',
    '- 确保代码可直接编译',
  ].join('\n')
}

function buildAI1UserPrompt(markdown: string): string {
  const blocks = splitMarkdownBlocks(markdown)
  const marked = blocks
    .map((b) => `<!--af:blk:${b.id}-->\n${b.text}`)
    .join('\n\n')
  return [
    '【Markdown 原文（按块标注块号）】',
    marked,
    '',
    '请将上述 Markdown 论文转换为 LaTeX 正文代码。要求：',
    '- 每个块对应的 LaTeX 片段用 %⟦af:blk:块号⟧ … %⟦/af:blk:块号⟧ 包起来（见 system 说明）',
    '- [@doi:xxx] 或 [@10.xxx/xxx] 形式的引用标记保持原样，不要替换',
  ].join('\n')
}

// ============================================================
// 块锚点：让「改 md 只重写改动的那几段」成为可能
// ============================================================

/** 一个 Markdown 块（按空行切分的最小单位，含围栏代码/表格/行间公式整块） */
export interface MarkdownBlock {
  /** 稳定块号：内容 sha 的短摘要（内容不变 → 块号不变），重复内容追加序号 */
  id: string
  /** 块类型，仅供展示与调试 */
  kind: 'heading' | 'fence' | 'table' | 'formula' | 'image' | 'list' | 'text'
  /** 块的原文（不含块号标注） */
  text: string
}

/** 32 位 FNV-1a，纯前端、确定性 —— 只用来给块生成稳定 id，不用于安全场景 */
function shortHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

function classifyBlock(text: string): MarkdownBlock['kind'] {
  const t = text.trimStart()
  if (/^#{1,6}\s/.test(t)) return 'heading'
  if (/^(```|~~~)/.test(t)) return 'fence'
  if (/^\$\$/.test(t)) return 'formula'
  if (/^!\[/.test(t)) return 'image'
  if (/^\|/.test(t) && t.includes('|', 1)) return 'table'
  if (/^([-*+]|\d+\.)\s/.test(t)) return 'list'
  return 'text'
}

/**
 * 把 Markdown 按块切开（确定性，不调 AI）。
 * 规则：空行分块；围栏代码块 / 行间公式 / 表格整段算一块（内部空行不切）。
 * id 由内容哈希生成 → 同一段文字改了才是新 id，没改的块 id 稳定不变。
 */
export function splitMarkdownBlocks(md: string): MarkdownBlock[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const rawBlocks: string[] = []
  let buf: string[] = []
  let fence: string | null = null
  let inMath = false

  const flush = () => {
    const text = buf.join('\n').replace(/\s+$/, '')
    if (text.trim()) rawBlocks.push(text)
    buf = []
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (fence) {
      buf.push(line)
      if (trimmed.startsWith(fence)) fence = null
      continue
    }
    if (inMath) {
      buf.push(line)
      if (trimmed.endsWith('$$')) inMath = false
      continue
    }
    const fenceOpen = trimmed.match(/^(```|~~~)/)
    if (fenceOpen) {
      fence = fenceOpen[1]
      buf.push(line)
      continue
    }
    if (trimmed.startsWith('$$')) {
      buf.push(line)
      if (!(trimmed.length > 2 && trimmed.endsWith('$$'))) inMath = true
      continue
    }
    if (trimmed === '') {
      flush()
      continue
    }
    buf.push(line)
  }
  flush()

  const seen = new Map<string, number>()
  return rawBlocks.map((text) => {
    const base = shortHash(text)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return {
      id: n === 0 ? base : `${base}-${n}`,
      kind: classifyBlock(text),
      text,
    }
  })
}

const ANCHOR_OPEN_RE = /^[ \t]*%⟦af:blk:([^⟧]+)⟧[ \t]*$/gm
const ANCHOR_CLOSE_RE = /^[ \t]*%⟦\/af:blk:([^⟧]+)⟧[ \t]*$/gm

export interface AnchorCheck {
  /** 正文里出现的块号（有序） */
  found: string[]
  /** prompt 里给了、但正文里没找到的块号 */
  missing: string[]
  /** 有开无合 / 有合无开 / 嵌套错乱 */
  malformed: string[]
}

/** 校验 AI 输出的锚点是否完整成对（AI 漏写锚点必须被发现，不能静默） */
export function checkAnchors(latex: string, expectedIds: string[]): AnchorCheck {
  const opens: string[] = []
  const closes: string[] = []
  let m: RegExpExecArray | null
  ANCHOR_OPEN_RE.lastIndex = 0
  while ((m = ANCHOR_OPEN_RE.exec(latex))) opens.push(m[1])
  ANCHOR_CLOSE_RE.lastIndex = 0
  while ((m = ANCHOR_CLOSE_RE.exec(latex))) closes.push(m[1])

  const malformed: string[] = []
  const found: string[] = []
  for (const id of opens) {
    if (closes.includes(id)) found.push(id)
    else malformed.push(id)
  }
  for (const id of closes) if (!opens.includes(id)) malformed.push(id)

  const missing = expectedIds.filter((id) => !found.includes(id))
  return { found, missing, malformed: [...new Set(malformed)] }
}

/** 从带锚点的 LaTeX 正文里抽出 块号 → 片段（含锚点行本身） */
export function extractAnchoredFragments(body: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /^[ \t]*%⟦af:blk:([^⟧]+)⟧[ \t]*\n([\s\S]*?)^[ \t]*%⟦\/af:blk:\1⟧[ \t]*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) out.set(m[1], m[0])
  return out
}

export function wrapAnchor(id: string, tex: string): string {
  return `%⟦af:blk:${id}⟧\n${tex.replace(/\s+$/, '')}\n%⟦/af:blk:${id}⟧`
}

/**
 * 取正文里**没有**被锚点包住的部分。
 * 典型是 assembleFullLatex 追加的 `\bibliographystyle{...}` / `\bibliography{...}` ——
 * 重建正文时必须把它原样接回去，否则参考文献就没了。
 */
function extractNonAnchored(body: string): string {
  return body
    .replace(/^[ \t]*%⟦af:blk:[^⟧]+⟧[ \t]*\n[\s\S]*?^[ \t]*%⟦\/af:blk:[^⟧]+⟧[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 用「新的 Markdown 块序列」重建 LaTeX 正文：
 *   - 块号不变的块 → 直接复用旧片段（**不重新生成，文字不会被 AI 顺手改动**）
 *   - 新增 / 改动 / 锚点丢失的块 → 交给 generateBlocks 重新生成
 *   - 旧稿里有、新 md 里没有的块 → 丢弃（等于删除）
 * 未包在锚点里的部分（导言区之后的 \bibliography 之类）原样保留在末尾。
 *
 * 注意：这是纯函数，generateBlocks 由调用方注入 —— 便于单测，也便于换实现。
 */
export async function rebuildBodyFromBlocks(
  oldLatex: string,
  newMd: string,
  generateBlocks: (blocks: MarkdownBlock[]) => Promise<string>,
): Promise<{ latex: string; reused: number; regenerated: number; dropped: number }> {
  const beginTag = '\\begin{document}'
  const endTag = '\\end{document}'
  const beginAt = oldLatex.indexOf(beginTag)
  const endAt = oldLatex.lastIndexOf(endTag)
  const head = beginAt === -1 ? '' : oldLatex.slice(0, beginAt + beginTag.length)
  const body = beginAt === -1 || endAt <= beginAt ? '' : oldLatex.slice(beginAt + beginTag.length, endAt)
  const tail = endAt > beginAt ? oldLatex.slice(endAt) : ''

  const oldFragments = extractAnchoredFragments(body)
  const blocks = splitMarkdownBlocks(newMd)

  const needGenerate: MarkdownBlock[] = []
  for (const b of blocks) if (!oldFragments.has(b.id)) needGenerate.push(b)

  let generated = ''
  if (needGenerate.length > 0) generated = await generateBlocks(needGenerate)
  const newFragments = extractAnchoredFragments(generated)

  const pieces: string[] = []
  let reused = 0
  let regenerated = 0
  for (const b of blocks) {
    const reusedFrag = oldFragments.get(b.id)
    if (reusedFrag) {
      pieces.push(reusedFrag)
      reused++
      continue
    }
    const frag = newFragments.get(b.id)
    if (frag) {
      pieces.push(frag)
      regenerated++
    } else {
      // AI 没给这个块的锚点 —— 不猜、不静默丢，交给调用方在返回值里体现
      pieces.push(`%⟦af:blk:${b.id}⟧\n% TODO: 该块未能生成 LaTeX（AI 未返回对应锚点）\n%⟦/af:blk:${b.id}⟧`)
    }
  }

  const dropped = [...oldFragments.keys()].filter((id) => !blocks.some((b) => b.id === id)).length

  // 锚点外的正文（\bibliographystyle / \bibliography 等）原样接回末尾
  const leftover = extractNonAnchored(body)
  const newBody = [pieces.join('\n\n'), leftover].filter((s) => s.trim() !== '').join('\n\n')

  return {
    latex: [head, '', newBody, '', tail].filter((s) => s !== '').join('\n').trimEnd(),
    reused,
    regenerated,
    dropped,
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
  const withBib = [
    body,
    '',
    `\\bibliographystyle{${template.bibtex_style}}`,
    `\\bibliography{${bibFileName}}`,
  ].join('\n')

  // 模板有完整骨架时就用它当外壳：导言区原样保留，只把 \begin{document} 与
  // \end{document} 之间的正文换掉。
  // 这比按字段重新拼更保真 —— 宏包选项（\usepackage[colorlinks]{hyperref}）、
  // 宏包顺序、\newcommand 之类的自定义命令一个都不会丢。上传期刊官方
  // sample .tex 当模板时，出的稿子才真的长得像那个期刊。
  const shell = (template.template_tex || '').trim()
  if (shell) {
    const beginTag = '\\begin{document}'
    const endTag = '\\end{document}'
    const beginAt = shell.indexOf(beginTag)
    const endAt = shell.lastIndexOf(endTag)
    if (beginAt !== -1 && endAt > beginAt) {
      return [shell.slice(0, beginAt + beginTag.length), '', withBib, '', shell.slice(endAt)].join(
        '\n',
      )
    }
    // 骨架不完整（只存了导言区、或文件被截断）→ 落到下面按字段拼
  }

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
  // 默认只列 XeLaTeX WASM 运行时（public/xelatex）里确实存在的包。
  // 那个运行时是精简版 TeX 发行版：很多常见「非核心」包
  // （amssymb / booktabs / caption / natbib / tabularx / multirow …）都没有，
  // 期刊文档类（elsarticle / IEEEtran / acmart / revtex）也没有，
  // 写进去会直接 `File not found` 编译失败 —— 之前 amssymb 就在默认列表里，
  // 导致每一份生成出来的文档都编不过。
  // 用户模板自带的 packages 不做过滤：缺包时让 TeX 明确报错，
  // 比静默丢包（排版悄悄变样）更可预期。
  const defaultPackages = ['amsmath', 'graphicx', 'hyperref']
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

  lines.push('\\begin{document}')
  lines.push('')

  // 正文 + 参考文献（\title / \author / \maketitle 由 AI 生成的 body 自带）
  lines.push(withBib)
  lines.push('')

  lines.push('\\end{document}')

  return lines.join('\n')
}

/**
 * 用期刊模板拼一份「能直接编译」的最小骨架文档。
 * -------------------------------------------------
 * 模板调试场景下，用户可能还没往 template.tex 里写过任何东西，
 * 但代码板需要有个可编译的起点，否则空代码板一上来就报错。
 *
 * 注意 body 只能是「\begin{document} 与 \end{document} 之间的正文」：
 * 环境包裹和末尾的 \bibliographystyle / \bibliography 都由 assembleFullLatex 负责，
 * 这里再写一遍就会拼出重复的 \begin{document} / \end{document}，直接编译不过。
 */
export function buildLatexSkeletonFromTemplate(template: JournalTemplate): string {
  const body = [
    '\\title{论文标题}',
    '\\author{作者}',
    '\\date{\\today}',
    '\\maketitle',
    '',
    '\\begin{abstract}',
    '摘要内容。',
    '\\end{abstract}',
    '',
    '\\section{引言}',
    '正文内容。',
  ]
  return assembleFullLatex(body.join('\n'), template)
}

// ============================================================
// 解析上传的 .tex → 模板
// ============================================================

/** 从 .tex 里解析出的模板要素 */
export interface ParsedLatexTemplate {
  /** 文档类名；文档里没有 \documentclass 时为空串（此时别拿它去覆盖已有模板） */
  documentClass: string
  documentOptions: string
  packages: string[]
  /** 文档里没有 \bibliographystyle 时为空串 */
  bibtexStyle: string
  /** 仅当确有 \documentclass 时才有意义；没有 \documentclass 时恒为 false，不代表单栏 */
  twoColumn: boolean
  fontSize?: number
  /** 导言区里除 \documentclass / \usepackage 之外的部分（\newcommand、\setlength…） */
  preamble: string
}

/** 去掉行尾注释，但别把转义的 \% 当成注释起点 */
function stripTexComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '%' && line[i - 1] !== '\\') return line.slice(0, i)
  }
  return line
}

/**
 * 解析一份 .tex，抽出可复用的模板要素。
 *
 * 用途：期刊官方给的 sample .tex、或自己中过的一篇的 tex，直接丢进来就变成模板 ——
 * 比让 AI 从「投稿须知」的文字里猜 documentclass 和宏包靠谱得多（那是纯猜测）。
 * 全程确定性正则，不调 AI：上传即得，也不会有幻觉。
 *
 * 注意 `packages` 只记名字，宏包选项（\usepackage[colorlinks]{hyperref} 里的
 * colorlinks）不会保留 —— 但只要整份骨架存进 template_tex，最终拼装时会直接
 * 复用它当外壳（见 assembleFullLatex），选项照样不丢。只有骨架不完整、
 * 退回按字段拼装时才会丢掉选项。
 */
export function parseLatexTemplate(tex: string): ParsedLatexTemplate {
  const lines = tex.split(/\r?\n/)
  const bodyAt = lines.findIndex((l) => stripTexComment(l).includes('\\begin{document}'))
  const head = bodyAt === -1 ? lines : lines.slice(0, bodyAt)

  let documentClass = ''
  let documentOptions = ''
  const packages: string[] = []
  const preambleLines: string[] = []

  for (const line of head) {
    const code = stripTexComment(line)

    const dc = code.match(/\\documentclass\s*(\[[^\]]*\])?\s*\{([^}]+)\}/)
    if (dc) {
      documentClass = dc[2].trim()
      documentOptions = (dc[1] || '').replace(/^\[|\]$/g, '').trim()
      continue
    }

    const uses = [...code.matchAll(/\\usepackage\s*(\[[^\]]*\])?\s*\{([^}]+)\}/g)]
    if (uses.length > 0) {
      for (const m of uses) {
        for (const name of m[2].split(',')) {
          const n = name.trim()
          if (n && !packages.includes(n)) packages.push(n)
        }
      }
      // 一行里除了 \usepackage 还夹着别的东西时，把剩下的部分留在导言区
      const rest = code.replace(/\\usepackage\s*(\[[^\]]*\])?\s*\{[^}]+\}/g, '').trim()
      if (rest) preambleLines.push(rest)
      continue
    }

    preambleLines.push(line)
  }

  // \bibliographystyle 一般在 \begin{document} 之后，所以全文找
  const bib = tex.match(/\\bibliographystyle\s*\{([^}]+)\}/)

  const opts = documentOptions
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const pt = opts.map((o) => o.match(/^(\d+)pt$/)?.[1]).find(Boolean)

  return {
    documentClass,
    documentOptions,
    packages,
    bibtexStyle: bib ? bib[1].trim() : '',
    twoColumn: opts.includes('twocolumn'),
    fontSize: pt ? parseInt(pt, 10) : undefined,
    preamble: preambleLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  }
}

/**
 * 从模板骨架里抽出「结构」喂给 AI：正文区内以反斜杠开头的行
 * （\title、\author、\maketitle、\begin{abstract}、\section、\bibliography…）。
 *
 * 只给命令骨架、丢掉示例正文 —— 既让 AI 知道该照什么结构写，
 * 又不会把 sample 里的示例文字抄进正式稿。
 */
function extractSkeletonOutline(templateTex?: string): string {
  const tex = (templateTex || '').trim()
  if (!tex) return ''
  const beginTag = '\\begin{document}'
  const endTag = '\\end{document}'
  const beginAt = tex.indexOf(beginTag)
  const endAt = tex.lastIndexOf(endTag)
  if (beginAt === -1 || endAt <= beginAt) return ''
  const body = tex.slice(beginAt + beginTag.length, endAt)

  const seen = new Set<string>()
  const outline: string[] = []
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('\\')) continue
    if (line.length > 200) continue
    const key = line.slice(0, 60)
    if (seen.has(key)) continue
    seen.add(key)
    outline.push(line)
    if (outline.length >= 40) break
  }
  return outline.join('\n')
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
// AI-2：是否符合期刊模板（与「忠于 md」是两件事，分开审）
// ============================================================

export interface TemplateComplianceReport {
  passed: boolean
  summary: string
  issues: Array<{ area: string; problem: string; suggestion: string }>
}

/**
 * 让 AI-2 拿模板规格去审生成的 LaTeX。
 *
 * 为什么单独审、不塞进双引擎的忠实性循环：双引擎的通过/重试只认
 * supported/added/contradicted 三态，那是「有没有编造」的判据；
 * 「合不合模板」是另一套判据，混进去会把两条独立的信号搅在一起。
 * 这里独立跑一次，结果单独报给用户，让他自己决定改不改。
 */
export async function reviewTemplateCompliance(params: {
  latex: string
  template: JournalTemplate
  ai2: { baseUrl: string; apiKey: string; model: string }
  onProgress?: LatexConvertProgress
}): Promise<TemplateComplianceReport> {
  const { latex, template, ai2, onProgress } = params
  onProgress?.({ stage: 'ai_reviewing', message: 'AI-2: 检查是否符合期刊模板…' })

  const system = [
    '你是一名严格的期刊 LaTeX 模板合规审查员。你会收到【期刊模板规格】和一份【待审 LaTeX 稿】。',
    '你的任务：判断这份稿子是否符合该期刊模板的排版要求。',
    '',
    '【审查维度】',
    '1. documentclass 与选项是否与模板一致（栏数、字号）。',
    '2. 是否使用了模板规格之外、模板导言区没有的宏包或自定义命令。',
    '3. 标题 / 作者 / 摘要 / 章节 / 参考文献的写法与顺序是否与模板骨架一致。',
    '4. 双栏期刊的图表是否用了 table* / figure*；单栏却用了带星号环境也算不符。',
    '',
    '【严格要求】',
    '1. 只根据【期刊模板规格】判断，不要凭你对其它期刊的印象下结论。',
    '2. 每条 issue 必须指出具体位置（引用稿中的片段）与改法。',
    '3. 没有把握就不要报 —— 宁可漏报也不要编造规则。',
    '4. 输出严格 JSON，不要 markdown 代码块。',
    '',
    '【输出 JSON 结构】',
    '{',
    '  "passed": boolean,',
    '  "issues": [{ "area": string, "problem": string, "suggestion": string }],',
    '  "summary": string',
    '}',
  ].join('\n')

  const user = [
    '【期刊模板规格】',
    buildTemplateSpec(template),
    '',
    '【待审 LaTeX 稿】',
    latex,
    '',
    '请按 system 指令输出合规审查 JSON。',
  ].join('\n')

  try {
    const resp = await callAI({
      baseUrl: ai2.baseUrl,
      apiKey: ai2.apiKey,
      model: ai2.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    })
    return parseCompliance(resp.content)
  } catch (err) {
    // 审查失败不影响出稿 —— 如实报告「没审成」，而不是假装通过
    return {
      passed: false,
      issues: [],
      summary: `模板合规审查未能执行：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

function parseCompliance(raw: string): TemplateComplianceReport {
  let text = raw.trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) text = text.slice(first, last + 1)
  try {
    const parsed = JSON.parse(text) as {
      passed?: boolean
      issues?: Array<{ area?: string; problem?: string; suggestion?: string }>
      summary?: string
    }
    return {
      passed: Boolean(parsed.passed),
      summary: String(parsed.summary ?? ''),
      issues: Array.isArray(parsed.issues)
        ? parsed.issues.map((i) => ({
            area: String(i.area ?? ''),
            problem: String(i.problem ?? ''),
            suggestion: String(i.suggestion ?? ''),
          }))
        : [],
    }
  } catch {
    return { passed: false, issues: [], summary: `审查返回的不是合法 JSON：${raw.slice(0, 300)}` }
  }
}

// ============================================================
// 改 md 后：只重写改动的那几块，其余原样保留
// ============================================================

export interface PatchLatexParams {
  /** 上一次转换出来的完整 LaTeX（带块锚点） */
  oldLatex: string
  /** 用户改过的 Markdown */
  newMarkdown: string
  template: JournalTemplate
  ai1: { baseUrl: string; apiKey: string; model: string }
  /** 传了就顺带跑一遍模板合规审查 */
  ai2?: { baseUrl: string; apiKey: string; model: string }
  onProgress?: LatexConvertProgress
}

export interface PatchLatexResult {
  latex: string
  /** 复用的段落数（未被 AI 重写） */
  reused: number
  /** 重新生成的段落数 */
  regenerated: number
  /** 因 md 中已删除而丢弃的段落数 */
  dropped: number
  /** 重生成部分的锚点自检 */
  anchorCheck: AnchorCheck
  compliance?: TemplateComplianceReport
}

/**
 * 「文字改动走 md 侧」的落点。
 *
 * oldLatex 是上一次转换的产物，每个 md 块都被 %⟦af:blk:id⟧ 锚点包着。
 * 这里按「新 md 的块序列」重排：
 *   块号没变的 → 直接搬旧片段（一个字都不会被 AI 动）
 *   块号变了 / 新增 → 只把这几个块交给 AI 重写
 * 于是「改一句话」不会触发整篇重转，也不会让 AI 顺手改掉别的段落。
 *
 * ⚠️ 前提是老稿确实带锚点。老稿不带锚点（比如是手改过的、或早期版本生成的）
 *    就没法定位，此时返回值里 regenerated 会等于全部块数 —— 调用方应当提示用户
 *    「这等于整篇重转」，必要时让用户先重新生成一次带锚点的稿子。
 */
export async function patchLatexFromMarkdown(params: PatchLatexParams): Promise<PatchLatexResult> {
  const { oldLatex, newMarkdown, template, ai1, ai2, onProgress } = params

  const blocks = splitMarkdownBlocks(newMarkdown)
  const allIds = blocks.map((b) => b.id)
  onProgress?.({
    stage: 'ai_converting',
    message: `比对改动段落（共 ${blocks.length} 块）…`,
  })

  const generateBlocks = async (targets: MarkdownBlock[]): Promise<string> => {
    const user = [
      '【需要重新生成的 Markdown 块（只有这些，其余块请勿输出）】',
      targets.map((b) => `<!--af:blk:${b.id}-->\n${b.text}`).join('\n\n'),
      '',
      '要求：',
      '- 每个块输出为对应的 LaTeX 片段，并用 %⟦af:blk:块号⟧ … %⟦/af:blk:块号⟧ 包起来',
      '- 块号必须与上面给定的完全一致，不要新增/合并/省略块',
      '- 只输出这些块的 LaTeX，不要输出其余任何内容',
      '- [@doi:xxx] 引用标记保持原样',
    ].join('\n')

    const resp = await callAI({
      baseUrl: ai1.baseUrl,
      apiKey: ai1.apiKey,
      model: ai1.model,
      messages: [
        { role: 'system', content: buildAI1SystemPrompt(template) },
        { role: 'user', content: user },
      ],
    })
    let out = resp.content.trim()
    const fence = out.match(/```(?:latex|tex)?\s*([\s\S]*?)```/i)
    if (fence) out = fence[1].trim()
    return out
  }

  const rebuilt = await rebuildBodyFromBlocks(oldLatex, newMarkdown, generateBlocks)

  const anchorCheck = checkAnchors(rebuilt.latex, allIds)
  if (anchorCheck.missing.length > 0 || anchorCheck.malformed.length > 0) {
    onProgress?.({
      stage: 'ai_reviewing',
      message:
        `锚点自检未通过：缺 ${anchorCheck.missing.length} 个、异常 ${anchorCheck.malformed.length} 个。` +
        '受影响段落已标记 TODO，请人工核对或整篇重转。',
    })
  }

  const result: PatchLatexResult = {
    latex: rebuilt.latex,
    reused: rebuilt.reused,
    regenerated: rebuilt.regenerated,
    dropped: rebuilt.dropped,
    anchorCheck,
  }

  if (ai2) {
    result.compliance = await reviewTemplateCompliance({
      latex: rebuilt.latex,
      template,
      ai2,
      onProgress,
    })
  }

  onProgress?.({
    stage: 'done',
    message: `完成：复用 ${rebuilt.reused} 段 / 重写 ${rebuilt.regenerated} 段 / 删除 ${rebuilt.dropped} 段`,
  })
  return result
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

    // ---- 阶段 6: 块锚点自检 ----
    // 锚点是「以后改 md 只重写改动段落」的前提。AI 经常会漏写几个锚点，
    // 这里如实报出来 —— 用户在代码板里一眼能看到哪些段落没被锚住。
    const expectedIds = splitMarkdownBlocks(markdown).map((b) => b.id)
    const anchorCheck = checkAnchors(fullLatex, expectedIds)
    if (anchorCheck.missing.length > 0 || anchorCheck.malformed.length > 0) {
      onProgress?.({
        stage: 'ai_reviewing',
        message:
          `块锚点自检：缺 ${anchorCheck.missing.length} 个 / 异常 ${anchorCheck.malformed.length} 个。` +
          '缺锚点的段落在「改 md 局部更新」时无法复用，需要重写。',
      })
    }

    // ---- 阶段 7: AI-2 模板合规审查（与忠实性审查是两条独立信号） ----
    let compliance: TemplateComplianceReport | undefined
    if (enableReview) {
      compliance = await reviewTemplateCompliance({ latex: fullLatex, template, ai2, onProgress })
    }

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
      anchor_check: anchorCheck,
      template_compliance: compliance,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress?.({ stage: 'error', message: `转换失败：${msg}`, detail: err })
    throw err
  }
}
