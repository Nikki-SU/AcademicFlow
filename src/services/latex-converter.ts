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
    '9. 图片：![caption](url "width=60% height=40%") 转换为 figure 环境，含 \\includegraphics 和 \\caption；双栏时用 figure*。',
    '   - url 原样抄进 \\includegraphics{url}，不要改写、不要加目录前缀',
    '   - 引号里的 width / height 是这张图占正文宽高的比例，按比例换算：',
    '     width=60% → \\includegraphics[width=0.6\\textwidth]{url}；height=40% → height=0.4\\textheight；',
    '     两个都写了就都放进可选参数；没写尺寸就不加 []',
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

/** 只删掉锚点注释行，正文一个字不动 */
export function stripAnchorLines(tex: string): string {
  return tex
    .replace(/^[ \t]*%⟦\/?af:blk:[^⟧]+⟧[ \t]*\r?\n?/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
}

// ── 块 → 片段 映射（sidecar） ─────────────────────────────────

export interface LatexBlockMapEntry {
  /** 稳定块号（md 块内容的哈希） */
  id: string
  kind: MarkdownBlock['kind']
  /** 生成这份 tex 时的 md 块原文（局部更新时拿它做 diff） */
  text: string
  /** 该块对应的 LaTeX 片段（**不含**锚点注释行） */
  fragment: string
}

/**
 * .tex 旁边的「块映射」文件（projects/<id>/latex-map.json）。
 *
 * 为什么不把锚点写在 .tex 里：用户是要**看并改**这份 .tex 的，
 * 里面躺着一堆 `%⟦af:blk:xxx⟧` 内部注释是纯噪音。
 * 映射单独存一份，tex 保持干净；手改 tex 之后靠片段原文重新定位。
 */
export interface LatexSidecar {
  version: 1
  template_id: string
  blocks: LatexBlockMapEntry[]
  /**
   * 生成时的 DOI → cite key 表。
   * 局部更新时新生成的段落里是 `[@doi:...]` 标记，要用这张表换成 `\cite{key}`，
   * 否则新旧段落会出现两套引用写法。
   */
  cite_keys?: Record<string, string>
}

/**
 * 把 AI 输出里的锚点拆成 sidecar，同时把锚点行从 .tex 里抹掉。
 * missing = AI 漏写锚点的块号 —— 这些块拿不到片段，局部更新时只能整段重写。
 */
export function buildSidecarFromAnchored(
  anchoredBody: string,
  md: string,
  templateId: string,
  citeKeys?: Record<string, string>,
): { cleanBody: string; sidecar: LatexSidecar; missing: string[] } {
  const blocks = splitMarkdownBlocks(md)
  const fragMap = extractAnchoredFragments(anchoredBody)
  const entries: LatexBlockMapEntry[] = []
  const missing: string[] = []
  for (const b of blocks) {
    const raw = fragMap.get(b.id)
    const fragment = raw ? stripAnchorLines(raw).trim() : ''
    if (!fragment) {
      missing.push(b.id)
      continue
    }
    entries.push({ id: b.id, kind: b.kind, text: b.text, fragment })
  }
  return {
    cleanBody: stripAnchorLines(anchoredBody).trim(),
    sidecar: { version: 1, template_id: templateId, blocks: entries, cite_keys: citeKeys },
    missing,
  }
}

// ── 确定性文字替换（不调 AI） ─────────────────────────────────

/** 词 + 空白切分：空白单独成 token，保证 diff 后的拼接能还原原样 */
function tokenizeWords(s: string): string[] {
  return s.match(/\s+|[^\s]+/g) || []
}

interface DiffRun {
  oldText: string
  newText: string
  /** 改动前后的邻近原文（定位不唯一时用来加长上下文） */
  beforeCtx: string
  afterCtx: string
}

/** LCS 匹配对（词级）—— 段落都很短，O(n·m) 足够 */
function lcsMatches(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return out
}

/** 取出「不匹配的连续段」——这些就是需要替换的地方 */
function diffRuns(oldText: string, newText: string, ctxTokens = 4): DiffRun[] {
  const a = tokenizeWords(oldText)
  const b = tokenizeWords(newText)
  const matches = lcsMatches(a, b)
  const runs: DiffRun[] = []
  let ai = 0
  let bj = 0
  const push = (aEnd: number, bEnd: number) => {
    if (aEnd === ai && bEnd === bj) return
    runs.push({
      oldText: a.slice(ai, aEnd).join(''),
      newText: b.slice(bj, bEnd).join(''),
      beforeCtx: a.slice(Math.max(0, ai - ctxTokens), ai).join(''),
      afterCtx: a.slice(aEnd, aEnd + ctxTokens).join(''),
    })
  }
  for (const [mi, mj] of matches) {
    push(mi, mj)
    ai = mi + 1
    bj = mj + 1
  }
  push(a.length, b.length)
  return runs
}

/** 空白压平 + 原文下标映射：tex 里的换行/缩进不该妨碍字面匹配 */
function normalizeWithMap(s: string): { text: string; map: number[] } {
  const chars: string[] = []
  const map: number[] = []
  let prevWs = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (/\s/.test(ch)) {
      if (!prevWs) {
        chars.push(' ')
        map.push(i)
      }
      prevWs = true
    } else {
      chars.push(ch)
      map.push(i)
      prevWs = false
    }
  }
  return { text: chars.join(''), map }
}

const normalizeText = (s: string) => s.replace(/\s+/g, ' ').trim()

/** fragment 里给 md 文本补常见的 LaTeX 转义（原样找不到时的第二次尝试） */
function escapeForTex(s: string): string {
  return s.replace(/([&%$#_{}])/g, '\\$1')
}

/**
 * 在 fragment 里定位 needle，要求**唯一命中**（唯一性靠加长上下文来争取）。
 * 返回的是 fragment 原文坐标，以及命中时使用的规范化串长度（用来回推内层偏移）。
 */
function locateUnique(
  haystack: string,
  variants: string[],
): { start: number; end: number; used: string } | null {
  const h = normalizeWithMap(haystack)
  for (const v of variants) {
    const t = normalizeText(v)
    if (!t) continue
    const at = h.text.indexOf(t)
    if (at === -1) continue
    if (h.text.indexOf(t, at + 1) !== -1) continue // 不唯一 → 换更长的变体
    return { start: h.map[at], end: h.map[at + t.length - 1] + 1, used: v }
  }
  return null
}

export interface DeterministicEditResult {
  ok: boolean
  fragment: string
  /** 实际完成的替换处数 */
  applied: number
  /** ok=false 时说明为什么没敢改（要如实告诉用户「这段交给 AI 了」） */
  reason?: string
}

/**
 * 把「md 块内的一处文字改动」**原样搬到**该块的 LaTeX 片段上。
 * 全程不调 AI、不做任何润色 —— 只把 diff 出来的旧文字替换成新文字。
 *
 * 找不到 / 不唯一 / 改动跨了 LaTeX 语法时返回 ok=false，
 * 由调用方决定回退到 AI 重写，并把 reason 亮给用户。
 */
export function applyDeterministicTextEdit(
  oldText: string,
  newText: string,
  fragment: string,
): DeterministicEditResult {
  if (oldText === newText) return { ok: true, fragment, applied: 0 }
  const runs = diffRuns(oldText, newText)
  if (runs.length === 0) return { ok: true, fragment, applied: 0 }

  let out = fragment
  let applied = 0

  // 从后往前改：前面的替换不会影响后面 needle 的定位
  for (let k = runs.length - 1; k >= 0; k--) {
    const run = runs[k]

    // 纯插入（oldText 为空）：拿前文当锚点，插到锚点之后
    if (!run.oldText.trim()) {
      const anchor = run.beforeCtx.trim()
      if (!anchor) return { ok: false, fragment, applied, reason: '插入位置前面没有可定位的原文' }
      const hit = locateUnique(out, [anchor])
      if (!hit) return { ok: false, fragment, applied, reason: `插入锚点定位不到或不唯一：「${anchor.slice(-24)}」` }
      out = out.slice(0, hit.end) + run.newText + out.slice(hit.end)
      applied++
      continue
    }

    // 修改 / 删除：先试原样，再试补了 LaTeX 转义的版本；都不唯一就加长上下文
    const variants = [
      run.oldText,
      escapeForTex(run.oldText),
      `${run.beforeCtx}${run.oldText}${run.afterCtx}`,
      `${run.beforeCtx}${escapeForTex(run.oldText)}${run.afterCtx}`,
    ]
    const hit = locateUnique(out, variants)
    if (!hit) {
      return {
        ok: false,
        fragment,
        applied,
        reason: `这段文字在 tex 里找不到或出现多次：「${run.oldText.slice(0, 30)}」`,
      }
    }

    // 上下文变体命中时，只替换里层那段，别把上下文一起吃进去
    const usedNorm = normalizeText(hit.used)
    const oldNorm = normalizeText(run.oldText)
    if (usedNorm !== oldNorm) {
      // 按 haystack 的规范化坐标，回推「里层那段」的原文区间
      const h = normalizeWithMap(out)
      const matchAt = h.text.indexOf(usedNorm)
      if (matchAt === -1) return { ok: false, fragment, applied, reason: '定位漂移，已放弃逐字替换' }
      const innerAt = matchAt + normalizeText(run.beforeCtx).length
      if (h.text.slice(innerAt, innerAt + oldNorm.length) !== oldNorm) {
        return { ok: false, fragment, applied, reason: '定位漂移，已放弃逐字替换' }
      }
      const s = h.map[innerAt]
      const e = h.map[innerAt + oldNorm.length - 1] + 1
      out = out.slice(0, s) + run.newText.replace(/\s+$/, '') + out.slice(e)
      applied++
      continue
    }

    out = out.slice(0, hit.start) + run.newText + out.slice(hit.end)
    applied++
  }

  return { ok: true, fragment: out, applied }
}

/** 在 .tex 里找某段片段的落点（片段原文可能被手改过，找不到就是 null） */
function locateFragment(latex: string, fragment: string): number {
  const t = fragment.trim()
  if (!t) return -1
  const at = latex.indexOf(t)
  if (at === -1) return -1
  return latex.indexOf(t, at + 1) === -1 ? at : -1
}

/** 取一段片段的首行摘要，用于给用户看的提示文案 */
function snippet(text: string, n = 24): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, n)
}

/**
 * 代码板被整篇替换之后，把映射里**还能对上号**的片段留下，对不上的丢掉。
 * 用在「让 AI 改代码（样式）」之后：样式改动通常不动正文，片段照样能定位；
 * 动了正文的那些片段会失效，与其留着错位，不如丢掉（下次会整段重写）。
 */
export function resyncSidecar(latex: string, sidecar: LatexSidecar): LatexSidecar {
  const kept = sidecar.blocks.filter((b) => locateFragment(latex, b.fragment) !== -1)
  return { ...sidecar, blocks: kept }
}

// ============================================================
// 引用替换：将 [@doi:xxx] 替换为 \cite{key}
// ============================================================

/** natbib 提供的引用命令 —— 用了这些就必须挂 natbib 宏包 */
const NATBIB_COMMANDS = new Set([
  'citep', 'citet', 'Citep', 'Citet', 'citealp', 'citealt',
  'citeauthor', 'citeyear', 'citeyearpar',
])

/** 模板里的正文引用命令，默认数字式的 \cite */
export function resolveCiteCommand(template: JournalTemplate): string {
  const cmd = (template.citation_command || 'cite').trim().replace(/^\\/, '')
  return cmd || 'cite'
}

function replaceCitationMarkers(
  latexBody: string,
  citeKeys: Record<string, string>,
  command = 'cite',
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
        return `\\${command}{${keys.join(',')}}`
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
  const templatePackages = [...template.packages]
  // 正文用了 natbib 的引用命令就得挂上 natbib，否则 \citep 一类直接未定义
  const citeCmd = resolveCiteCommand(template)
  if (
    NATBIB_COMMANDS.has(citeCmd) &&
    !templatePackages.some((p) => p.replace(/^.*\//, '') === 'natbib')
  ) {
    templatePackages.push('natbib')
  }
  const allPackages = [...defaultPackages, ...templatePackages]
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
// 改 md 后：只更正改动的那几处，其余原文一个字不动
// ============================================================

export interface PatchFromSidecarParams {
  /** 当前代码板里的完整 LaTeX（可能是用户手改过的） */
  currentLatex: string
  /** 用户改过的 Markdown */
  newMarkdown: string
  /** 上次生成 tex 时留下的块映射（projects/<id>/latex-map.json） */
  sidecar: LatexSidecar
  template: JournalTemplate
  ai1: { baseUrl: string; apiKey: string; model: string }
  /** 传了就顺带跑一遍模板合规审查 */
  ai2?: { baseUrl: string; apiKey: string; model: string }
  onProgress?: LatexConvertProgress
}

export interface PatchFromSidecarResult {
  latex: string
  /** 更新后的块映射，要一起存回 sidecar 文件 */
  sidecar: LatexSidecar
  /** 逐字替换直接改好的段数（**没花 AI 调用、也不可能被改措辞**） */
  deterministic: number
  /** 交给 AI 重写的段数 */
  regenerated: number
  /** 因 md 里删掉而移除的段数 */
  dropped: number
  /** 一个字都没动的段数 */
  untouched: number
  /** 需要人看的说明（哪些段回退了 AI、哪些段因为被手改过而没同步） */
  notes: string[]
  compliance?: TemplateComplianceReport
}

/**
 * 「文字改动走 md 侧」的落点 —— 这是**正确路径**，不是整篇重转。
 *
 * 做法是「外科手术式」的，不是重建整篇：
 *   1. 块号没变的段 → 原样不动。
 *   2. 块号变了（md 里改了字的段）：
 *        a. 先做**确定性文字替换** —— 把 diff 出来的旧文字在新片段里换成新文字，
 *           不调 AI、不润色、离线可用；
 *        b. 只有替换不成（改动跨了 LaTeX 语法、或文字掺了公式/转义）才回退 AI 重写，
 *           并把「这一段回退了」如实写进 notes。
 *   3. 新增段 → AI 生成后插在前一段之后。
 *   4. 删除段 → 从 tex 里精确移除。
 *   5. 用户手改过的段（片段原文在 tex 里找不到）→ **不碰 tex**，只记进 notes，
 *      宁可不改也不把稿子改花。
 */
export async function patchLatexFromSidecar(
  params: PatchFromSidecarParams,
): Promise<PatchFromSidecarResult> {
  const { currentLatex, newMarkdown, sidecar, template, ai1, ai2, onProgress } = params

  const blocks = splitMarkdownBlocks(newMarkdown)
  const notes: string[] = []
  onProgress?.({ stage: 'ai_converting', message: `比对改动段落（共 ${blocks.length} 块）…` })

  const byId = new Map(sidecar.blocks.map((b) => [b.id, b]))
  let latex = currentLatex
  const nextEntries: LatexBlockMapEntry[] = []
  const needAi: MarkdownBlock[] = []
  /** 被手改过、这次不动 tex 的块 → 只更新 md 侧文字记录 */
  const staleOnly = new Map<string, string>()

  let deterministic = 0
  let untouched = 0

  for (const b of blocks) {
    const prev = byId.get(b.id)
    if (!prev) {
      needAi.push(b)
      continue
    }
    if (prev.text === b.text) {
      nextEntries.push(prev)
      untouched++
      continue
    }
    // md 里改了字 —— 先看这段在 tex 里还在不在（用户可能手改过）
    if (locateFragment(latex, prev.fragment) === -1) {
      notes.push(`「${snippet(b.text)}」这一段你在 .tex 里手改过，本次没有动代码板，请自行核对合并`)
      staleOnly.set(b.id, b.text)
      continue
    }
    const det = applyDeterministicTextEdit(prev.text, b.text, prev.fragment)
    if (det.ok) {
      latex = latex.replace(prev.fragment, det.fragment)
      nextEntries.push({ ...prev, text: b.text, fragment: det.fragment })
      deterministic++
    } else {
      notes.push(`「${snippet(b.text)}」无法逐字替换（${det.reason || '未知原因'}），已交给 AI 重写这一段`)
      needAi.push(b)
    }
  }

  const regenerated = needAi.length
  if (needAi.length > 0) {
    onProgress?.({
      stage: 'ai_converting',
      message: `${deterministic} 段已逐字改好；${needAi.length} 段需要 AI 重写…`,
    })
    const user = [
      '【需要重新生成的 Markdown 块（只有这些）】',
      needAi.map((b) => `<!--af:blk:${b.id}-->\n${b.text}`).join('\n\n'),
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

    const { sidecar: aiSidecar, missing } = buildSidecarFromAnchored(
      out,
      needAi.map((b) => b.text).join('\n\n'),
      template.id,
    )
    const fragById = new Map(aiSidecar.blocks.map((e) => [e.id, e.fragment]))

    for (const b of needAi) {
      const raw = fragById.get(b.id)
      if (!raw) {
        notes.push(`AI 没返回「${snippet(b.text)}」这一段的 LaTeX，已跳过（md 里有、代码板里没有）`)
        continue
      }
      // 新生成的片段里还是 [@doi:...] 标记，要用同一份 key 表换成 \cite{...}，
      // 否则新段落会和旧段落出现两套引用写法
      const fragment = replaceCitationMarkers(raw, sidecar.cite_keys || {})
      const prev = byId.get(b.id)
      const pos = findInsertPosition(latex, blocks, b, byId, nextEntries)
      latex = latex.slice(0, pos) + fragment + '\n\n' + latex.slice(pos)
      nextEntries.push({ id: b.id, kind: b.kind, text: b.text, fragment })
      if (prev) if (missing.includes(b.id)) notes.push(`「${snippet(b.text)}」重写后仍未带锚点，已按整段插入`)
    }
  }

  // 被手改过的块：只更新 md 文字，tex 保持用户手改后的样子
  for (const b of blocks) {
    const stale = staleOnly.get(b.id)
    if (stale !== undefined) {
      const prev = byId.get(b.id)!
      nextEntries.push({ ...prev, text: stale })
    }
  }

  // md 里删掉的段 → 从 tex 精确移除
  let dropped = 0
  const aliveIds = new Set(blocks.map((b) => b.id))
  for (const entry of sidecar.blocks) {
    if (aliveIds.has(entry.id)) continue
    const at = locateFragment(latex, entry.fragment)
    if (at !== -1) {
      latex = (latex.slice(0, at) + latex.slice(at + entry.fragment.length)).replace(/\n{3,}/g, '\n\n')
      dropped++
    } else {
      notes.push(`md 里删掉了「${snippet(entry.text)}」，但它在 .tex 里被手改过，没能精确移除，请自行核对`)
    }
  }

  const finalSidecar: LatexSidecar = {
    version: 1,
    template_id: template.id,
    blocks: blocks
      .map((b) => nextEntries.find((e) => e.id === b.id))
      .filter((e): e is LatexBlockMapEntry => Boolean(e)),
  }

  const result: PatchFromSidecarResult = {
    latex,
    sidecar: finalSidecar,
    deterministic,
    regenerated,
    dropped,
    untouched,
    notes,
  }

  if (ai2) {
    result.compliance = await reviewTemplateCompliance({ latex, template, ai2, onProgress })
  }

  onProgress?.({
    stage: 'done',
    message:
      `完成：逐字改 ${deterministic} 段 / AI 重写 ${regenerated} 段 / 删除 ${dropped} 段 / 未动 ${untouched} 段`,
  })
  return result
}

/**
 * 给「新增的块」找插入位置：优先插在**前一个已定位块**的片段之后；
 * 前面没有就插在**后一个已定位块**之前；都没有就插在 \begin{document} 之后。
 * 返回 latex 里的字符下标。
 */
function findInsertPosition(
  latex: string,
  blocks: MarkdownBlock[],
  target: MarkdownBlock,
  byId: Map<string, LatexBlockMapEntry>,
  placed: LatexBlockMapEntry[],
): number {
  const idx = blocks.findIndex((b) => b.id === target.id)
  const placedIds = new Set(placed.map((p) => p.id))

  for (let i = idx - 1; i >= 0; i--) {
    const prev = byId.get(blocks[i].id)
    if (prev && placedIds.has(prev.id)) {
      const at = locateFragment(latex, prev.fragment)
      if (at !== -1) return at + prev.fragment.length
    }
  }
  for (let i = idx + 1; i < blocks.length; i++) {
    const nxt = byId.get(blocks[i].id)
    if (nxt && placedIds.has(nxt.id)) {
      const at = locateFragment(latex, nxt.fragment)
      if (at !== -1) return at
    }
  }
  const beginTag = '\\begin{document}'
  const beginAt = latex.indexOf(beginTag)
  return beginAt === -1 ? latex.length : beginAt + beginTag.length
}

// ============================================================
// 主转换函数
// ============================================================

/** 转换结果 + 块映射（sidecar 要单独落盘，所以不塞进共享的 LatexConversionResult 类型） */
export type LatexConvertResult = LatexConversionResult & { sidecar: LatexSidecar }

export async function convertMarkdownToLatex(
  params: ConvertParams,
): Promise<LatexConvertResult> {
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
    latexBody = replaceCitationMarkers(latexBody, citeKeys, resolveCiteCommand(template))

    // md 里的图片是仓库路径（projects/<id>/images/a.png），编译时图片就挂在 images/ 下。
    // 这里把仓库前缀削掉，让 \includegraphics 的路径和挂载位置对上 —— 不指望 AI 记得改。
    latexBody = latexBody.replace(/projects\/[^/{}]+\/(images\/)/g, '$1')

    // ---- 阶段 6: 拆出「块 → 片段」映射，并把锚点注释从 .tex 里抹掉 ----
    // 用户是要看并手改这份 .tex 的，正文里不该躺着一堆内部注释；
    // 映射单独存 sidecar，局部更新时按片段原文定位。
    const { cleanBody, sidecar, missing } = buildSidecarFromAnchored(
      latexBody,
      markdown,
      template.id,
      citeKeys,
    )
    const anchorCheck = checkAnchors(latexBody, splitMarkdownBlocks(markdown).map((b) => b.id))
    if (missing.length > 0) {
      onProgress?.({
        stage: 'ai_reviewing',
        message:
          `${missing.length} 个段落 AI 没给出对应的 LaTeX 片段，这些段落在「局部更新」时会整段重写。`,
      })
    }

    // 组装完整文档（正文已无锚点注释）
    const fullLatex = assembleFullLatex(cleanBody, template)

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
      sidecar,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    onProgress?.({ stage: 'error', message: `转换失败：${msg}`, detail: err })
    throw err
  }
}
