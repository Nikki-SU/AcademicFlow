/**
 * aligned.md —— 三阶段确定性索引对齐
 * =====================================
 *
 * 阶段 1 (AI-1 Clean)：纯清理 + 全量保留图片/表格/公式
 * 阶段 2 (AI-1 Tag)：加无编号标记 <!-- PARA_EN --> / <!-- IMG --> / <!-- TABLE --> / <!-- REF_ALL -->
 * 阶段 3 (纯代码 Enumerate)：扫标记 → 编号 → aligned.md 骨架
 *
 * 最终标记语法（HTML 注释，零 markdown 冲突）：
 *   <!-- PARA en idx/total -->      文字正文（要翻译）
 *   <!-- PARA cn idx/total -->      中文译文
 *   <!-- IMG between X and Y -->    图片（不翻译）
 *   <!-- TABLE between X and Y -->  表格（要翻译）
 *   <!-- REF ALL -->                参考文献整体（不翻译）
 *
 * 公式（LaTeX $...$ / $$...$$）不打标，不翻译，保持原样。
 */

// ============================================================
// 类型
// ============================================================

export type ContentNodeType = 'en' | 'cn' | 'img' | 'table' | 'ref'

export interface ContentNode {
  type: ContentNodeType
  idx?: number         // en/cn 的段落 idx（1-based）
  total?: number       // 正文段总数（校验用）
  beforeIdx?: number   // img/table：前一段的 idx
  afterIdx?: number    // img/table：后一段的 idx
  path?: string        // img：图片路径
  content?: string     // en/cn/table/ref：markdown 文本
}

export interface ParsedAlignedMd {
  nodes: ContentNode[]
  totalPara: number
  hasRef: boolean
  refContent?: string
}

// ============================================================
// 正则 —— 最终标记（enumerate 之后）
// ============================================================

// group1 区分类型：en/cn/img/table/ref
const FINAL_MARK_RE =
  /<!--\s*(PARA\s+(en|cn)\s+(\d+)\/(\d+)|IMG\s+between\s+(\d+)\s+and\s+(\d+)|TABLE\s+between\s+(\d+)\s+and\s+(\d+)|REF\s+ALL)\s*-->/g

// 第二遍 tag 阶段的无编号标记
const TAG_ONLY_RE = /<!--\s*(PARA_EN|IMG|TABLE|REF_ALL)\s*-->/g

// ============================================================
// 阶段 3：纯代码 enumerate —— 把无编号标记变成带编号的 aligned.md
// 输入：tagged.md（AI-1 第二遍的输出）
// 输出：aligned.md 骨架（还没翻译，只带 PARA en）
// ============================================================

/**
 * Fallback：当 AI-1 Tag 阶段漏打 PARA_EN 标签时，
 * 自动扫描 MinerU/Clean 后的原始 Markdown，给正文段落补标。
 *
 * 判定为"正文段落"的条件（连续非空行块）：
 *   - 包含至少一个字母/数字字符
 *   - 不是图片 ![
 *   - 不是表格（所有非空行都以 | 开头）
 *   - 不是代码块（在 ``` ... ``` 之间）
 *   - 不是 HTML 注释
 *   - 不是纯公式（$...$ / $$...$$）
 *   - 不是独立的列表项/标题/引用（除非紧跟正文）
 */
function autoInsertParaTags(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let inCodeBlock = false
  let buf: string[] = [] // 当前段落缓冲
  let bufIsTable = false

  const flushBuf = () => {
    if (buf.length === 0) return
    const block = buf.join('\n')
    const nonEmpty = buf.filter((l) => l.trim()).length
    const hasLetter = /[A-Za-z\u4e00-\u9fa5\d]/.test(block)
    const isImgOnly = buf.every((l) => !l.trim() || l.trim().startsWith('!['))
    const isTableOnly = bufIsTable
    const isFormulaOnly = buf.every((l) => !l.trim() || /^\s*\$\$?[\s\S]*\$\$?\s*$/.test(l.trim()))

    out.push(...buf)
    buf = []
    bufIsTable = false

    if (nonEmpty > 0 && hasLetter && !isImgOnly && !isTableOnly && !isFormulaOnly) {
      out.push('<!-- PARA_EN -->')
    }
  }

  for (const line of lines) {
    // 代码块切换
    if (/^\s*```/.test(line)) {
      flushBuf()
      inCodeBlock = !inCodeBlock
      out.push(line)
      continue
    }
    if (inCodeBlock) {
      out.push(line)
      continue
    }
    // HTML 注释行 — 直接 flush buffer 再输出
    if (/^\s*<!--.*-->\s*$/.test(line)) {
      flushBuf()
      out.push(line)
      continue
    }
    // 空行 — flush buffer
    if (!line.trim()) {
      flushBuf()
      out.push(line)
      continue
    }
    // 图片行 — flush buffer 再输出，不进正文
    if (/^\s*!\[/.test(line)) {
      flushBuf()
      out.push(line)
      continue
    }
    // 表格开头行 — flush buffer，标记后续为表格
    if (/^\s*\|/.test(line)) {
      if (buf.length === 0) {
        buf = [line]
        bufIsTable = true
      } else {
        flushBuf()
        buf = [line]
        bufIsTable = true
      }
      continue
    }
    // 表格续行
    if (bufIsTable) {
      buf.push(line)
      if (!/^\s*\|/.test(line)) {
        flushBuf()
      }
      continue
    }
    // 正常正文行
    buf.push(line)
  }
  flushBuf()
  return out.join('\n')
}

export function enumerateTaggedMd(taggedMd: string): string {
  // ---- Fallback：如果完全没有 PARA_EN，自动补标 ----
  if (!/<!--\s*PARA_EN\s*-->/.test(taggedMd)) {
    const before = taggedMd
    taggedMd = autoInsertParaTags(taggedMd)
    console.warn('[enumerateTaggedMd] AI-1 Tag 输出无 PARA_EN，已自动补标。' +
      ` 原长=${before.length} 补标后=${taggedMd.length}`)
  }

  const lines = taggedMd.split('\n')
  const out: string[] = []
  let paraIdx = 0
  const totalPara = lines.filter((l) => /<!--\s*PARA_EN\s*-->/.test(l)).length

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // PARA_EN → 编号
    if (/<!--\s*PARA_EN\s*-->/.test(line)) {
      paraIdx++
      out.push(`<!-- PARA en ${paraIdx}/${totalPara} -->`)
      continue
    }

    // IMG → 借 paraIdx 定位
    if (/<!--\s*IMG\s*-->/.test(line)) {
      const before = paraIdx
      const after = paraIdx + 1
      out.push(`<!-- IMG between ${before} and ${after} -->`)
      continue
    }

    // TABLE → 借 paraIdx 定位
    if (/<!--\s*TABLE\s*-->/.test(line)) {
      const before = paraIdx
      const after = paraIdx + 1
      out.push(`<!-- TABLE between ${before} and ${after} -->`)
      continue
    }

    // REF_ALL → 变成 REF ALL
    if (/<!--\s*REF_ALL\s*-->/.test(line)) {
      out.push(`<!-- REF ALL -->`)
      continue
    }

    out.push(line)
  }

  return out.join('\n')
}

// ============================================================
// 解析：aligned.md → ParsedAlignedMd（渲染用）
// ============================================================

export function parseAlignedMd(md: string): ParsedAlignedMd {
  const nodes: ContentNode[] = []
  let hasRef = false
  let refContent: string | undefined
  let totalPara = 0

  interface Mark {
    type: ContentNodeType
    idx?: number
    total?: number
    beforeIdx?: number
    afterIdx?: number
    start: number
    end: number
  }

  const marks: Mark[] = []
  FINAL_MARK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FINAL_MARK_RE.exec(md)) !== null) {
    const full = m[1]
    let type: ContentNodeType
    let idx: number | undefined
    let total: number | undefined
    let beforeIdx: number | undefined
    let afterIdx: number | undefined

    if (full.startsWith('PARA en')) {
      type = 'en'
      idx = parseInt(m[2]!, 10)
      total = parseInt(m[3]!, 10)
    } else if (full.startsWith('PARA cn')) {
      type = 'cn'
      idx = parseInt(m[4]!, 10)
      total = parseInt(m[5]!, 10)
    } else if (full.startsWith('IMG')) {
      type = 'img'
      beforeIdx = parseInt(m[6]!, 10)
      afterIdx = parseInt(m[7]!, 10)
    } else if (full.startsWith('TABLE')) {
      type = 'table'
      beforeIdx = parseInt(m[8]!, 10)
      afterIdx = parseInt(m[9]!, 10)
    } else {
      type = 'ref'
    }

    let end = m.index + m[0].length
    if (md[end] === '\r') end++
    if (md[end] === '\n') end++
    marks.push({ type, idx, total, beforeIdx, afterIdx, start: m.index, end })
  }

  if (marks.length === 0) return { nodes: [], totalPara: 0, hasRef: false }

  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i]
    const start = cur.end
    const end = i + 1 < marks.length ? marks[i + 1].start : md.length
    const content = md.slice(start, end).trim()

    if (cur.type === 'ref') {
      hasRef = true
      refContent = content
      continue
    }
    if (cur.type === 'img') {
      let path = content
      const match = content.match(/!\[[^\]]*\]\(([^)]+)\)/)
      if (match) path = match[1] ?? content
      nodes.push({ type: 'img', beforeIdx: cur.beforeIdx, afterIdx: cur.afterIdx, path, content })
      continue
    }
    if (cur.type === 'table') {
      nodes.push({ type: 'table', beforeIdx: cur.beforeIdx, afterIdx: cur.afterIdx, content })
      continue
    }
    if (cur.type === 'en' || cur.type === 'cn') {
      nodes.push({ type: cur.type, idx: cur.idx, total: cur.total, content })
      if (cur.type === 'en' && cur.total && cur.total > totalPara) totalPara = cur.total
    }
  }

  return { nodes, totalPara, hasRef, refContent }
}

// ============================================================
// 组装：给 enumerate 后的骨架加 cn 译文，生成最终 aligned.md
// ============================================================

export interface EnItem {
  idx: number
  total: number
  en: string
  cn?: string
}

export interface TableItem {
  beforeIdx: number
  afterIdx: number
  en: string   // 原始英文表格 markdown
  cn?: string  // 中文译文表格 markdown
}

export interface BuildFinalInput {
  enItems: EnItem[]
  imgs: { beforeIdx: number; afterIdx: number; content: string }[]
  tables: TableItem[]
  ref?: string
}

export function buildFinalAlignedMd(input: BuildFinalInput): string {
  const lines: string[] = []
  const total = input.enItems.length

  for (let i = 0; i < total; i++) {
    const en = input.enItems[i]!

    lines.push(`<!-- PARA en ${en.idx}/${total} -->`)
    lines.push(en.en.trim())
    lines.push('')

    if (en.cn?.trim()) {
      lines.push(`<!-- PARA cn ${en.idx}/${total} -->`)
      lines.push(en.cn.trim())
      lines.push('')
    }

    // 这段后面的 TABLE
    const nextIdx = en.idx + 1
    const tablesAfter = input.tables.filter((t) => t.beforeIdx === en.idx && t.afterIdx === nextIdx)
    for (const tbl of tablesAfter) {
      lines.push(`<!-- TABLE between ${tbl.beforeIdx} and ${tbl.afterIdx} -->`)
      lines.push(tbl.en.trim())
      lines.push('')
      if (tbl.cn?.trim()) {
        lines.push(`<!-- TABLE cn ${tbl.beforeIdx}-${tbl.afterIdx} -->`)
        lines.push(tbl.cn.trim())
        lines.push('')
      }
    }

    // 这段后面的 IMG
    const imgsAfter = input.imgs.filter((img) => img.beforeIdx === en.idx && img.afterIdx === nextIdx)
    for (const img of imgsAfter) {
      lines.push(`<!-- IMG between ${img.beforeIdx} and ${img.afterIdx} -->`)
      lines.push(img.content.trim())
      lines.push('')
    }
  }

  if (input.ref?.trim()) {
    lines.push(`<!-- REF ALL -->`)
    lines.push(input.ref.trim())
  }

  return lines.join('\n')
}

// ============================================================
// 校验
// ============================================================

export function validateAlignedMd(parsed: ParsedAlignedMd): string[] {
  const errors: string[] = []
  const enIdx = parsed.nodes.filter((n) => n.type === 'en').map((n) => n.idx!)
  const cnIdx = parsed.nodes.filter((n) => n.type === 'cn').map((n) => n.idx!)

  for (let i = 0; i < enIdx.length; i++) {
    if (enIdx[i] !== i + 1) errors.push(`英文段序列断裂：期望 idx=${i + 1}，实际=${enIdx[i]}`)
  }
  if (!cnIdx.every((idx) => enIdx.includes(idx))) errors.push(`中文段包含不存在的英文 idx`)
  if (parsed.totalPara !== enIdx.length) errors.push(`声明 total=${parsed.totalPara} 但实际英文段=${enIdx.length}`)

  const validIdx = new Set(enIdx)
  for (const node of parsed.nodes.filter((n) => n.type === 'img' || n.type === 'table')) {
    const b = node.beforeIdx!
    const a = node.afterIdx!
    if (!validIdx.has(b) && b !== 0) errors.push(`${node.type} 引用不存在的前一段 idx=${b}`)
    if (!validIdx.has(a) && a !== parsed.totalPara + 1) {
      errors.push(`${node.type} 引用不存在的后一段 idx=${a}`)
    }
  }
  return errors
}

// ============================================================
// 给 AI 的规范（三阶段）
// ============================================================

export const CLEAN_PROMPT = `
你是一名学术文本清理助手。对 MinerU 转换的 Markdown 原文做以下处理：

【删除】页码（如 "Page 1 / 12"、"— 1 —"）、页眉页脚（重复出现在每页顶部/底部的作者名、期刊名、标题缩写）、基金号、通讯作者邮箱、纯空行、明显的 OCR 噪声（如单独出现的乱码字符）。

【拼接】被分页截断的同一段落。如果一段文字在某页末尾被截断，下一页开头继续，要拼成一个完整段落。

【完整保留 · 一条都不能丢】
- 所有 \`![caption](path)\` 图片语法，位置不变，路径不变
- 所有 LaTeX 公式：行内 \`$...$\`、块级 \`$$...$$\`
- 所有 Markdown 表格 \`| col1 | col2 |\`
- 所有代码块、列表、引用、标题

【原文锚点 · 必须加】
清理后的每个非空段落前面加一行 \`<!-- SRC 原文第 X 行 -->\`，标记这段内容在原文中首次出现的行号。行号从 1 开始计原文物理行（包括空行）。被拼接的段落标起始行号（如跨页拼接的就标第一段的起始行）。

示例：
  <!-- SRC 原文第 12 行 -->
  This is a paragraph from the original paper...

  <!-- SRC 原文第 45 行 -->
  ![Figure 1](images/fig1.png)

  <!-- SRC 原文第 67 行 -->
  | Col A | Col B |
  |-------|-------|

严格禁止编造任何原文中不存在的文字。只输出清理后带锚点的 markdown。
`

// SRC 锚点正则
export const SRC_ANCHOR_RE = /<!--\s*SRC\s*原文第\s*(\d+)\s*行\s*-->/g

// ============================================================
// 引证校验辅助
// ============================================================

/** 纯代码 diff：对比原文和清理后的文本，列出所有被剪掉的原文片段 */
export function computeCutSegments(original: string, cleaned: string): string[] {
  const origLines = original.split('\n')
  // 从 cleaned 里提取所有 SRC 锚点覆盖的原文行范围
  const coveredLines = new Set<number>()
  let m: RegExpExecArray | null
  SRC_ANCHOR_RE.lastIndex = 0
  while ((m = SRC_ANCHOR_RE.exec(cleaned)) !== null) {
    const startLine = parseInt(m[1]!, 10)
    // 下一个锚点之前的 cleaned 内容大致覆盖到这里
    const nextAnchor = cleaned.indexOf('<!-- SRC 原文第', m.index + 1)
    const thisCleanedBlock = nextAnchor === -1 ? cleaned.slice(m.index) : cleaned.slice(m.index, nextAnchor)
    const cleanedLines = thisCleanedBlock.split('\n').filter((l) => !l.startsWith('<!-- SRC'))

    // 粗略估算覆盖多少原文行
    for (let i = startLine; i < startLine + cleanedLines.length + 3 && i <= origLines.length; i++) {
      coveredLines.add(i)
    }
  }

  // 收集被剪掉的片段（连续未被覆盖的原文行）
  const cuts: string[] = []
  let buf: string[] = []
  for (let i = 1; i <= origLines.length; i++) {
    if (!coveredLines.has(i)) {
      buf.push(origLines[i - 1]!)
    } else if (buf.length > 0) {
      const snippet = buf.join('\n').trim()
      if (snippet.length > 0) cuts.push(snippet)
      buf = []
    }
  }
  if (buf.length > 0) {
    const snippet = buf.join('\n').trim()
    if (snippet.length > 0) cuts.push(snippet)
  }
  return cuts
}

/** AI-2 引证校验 prompt */
export const CITATION_CHECK_PROMPT = `
你是一名严谨的学术文本审核员。请审核 AI-1 对一篇学术论文 Markdown 的清理结果是否合格。

你将收到：
1. 【原始全文】：MinerU 转换后的原始 Markdown
2. 【清理结果】：AI-1 清理后的 Markdown（每段前带 <!-- SRC 原文第 X 行 --> 锚点）
3. 【被剪掉的片段】：纯代码 diff 识别出的 AI-1 从原文中删除的所有片段列表

请检查三项：
A. 【无编造】清理结果中的每一段文字是否都在原始全文中逐字出现（允许空格/换行微调）？
B. 【无误删】被剪掉的片段是否全是噪声（页码、页眉页脚、基金号、通讯邮箱、空行、OCR 乱码）？有没有疑似正文、图片、表格、公式被误删？
C. 【锚点有效】清理结果中所有 <!-- SRC 原文第 X 行 --> 的行号是否都在原文范围内？

如果三项都通过，返回：{"passed": true}
如果有任何一项不通过，返回：{"passed": false, "errors": ["具体问题 1", "具体问题 2"]}
`

export const TAG_PROMPT = `
你是一名学术文本分段助手。对已经清理好的 markdown，按以下规则**只加标记、不改内容**：

标记语法（HTML 注释，不会被 markdown 渲染）：

1. 纯文字段落 → 紧接段落后加一行 \`<!-- PARA_EN -->\`
   - 只有包含正常正文文字的段落才打这个标记
   - 标题行（# 开头）、列表项（-/* 开头）如果是正文的一部分，也要加

2. 图片 \`![caption](path)\` → 紧接图片行后加一行 \`<!-- IMG -->\`

3. Markdown 表格 \`| col | col |\` → 紧接表格最后一行后加一行 \`<!-- TABLE -->\`

4. 参考文献部分（\`References\` / \`Bibliography\` / \`REFERENCES\` 标题之后的所有条目）→ 整体在最后一条之后加一行 \`<!-- REF_ALL -->\`

【禁止】
- 禁止删除、移动、重命名任何内容
- 禁止修改图片路径、表格格式、公式格式
- 禁止给公式（\`$...$\` / \`$$...$$\`）打任何标记
- 禁止给空行打标记

只输出加好标记的 markdown，不要额外解释。
`

export const TRANSLATE_PROMPT = (sourceType: 'para' | 'table') => `
你是一名严谨的学术翻译助手。将以下${sourceType === 'para' ? '英文段落' : '英文表格'}翻译成准确、流畅的中文。

要求：
- 保留所有 Markdown 格式（列表、代码块、标题、表格管道符）
- 保留专业术语、化学式、数学公式、引用标记、数字
- 表格翻译时保持列数和对齐方式
- 只输出译文，不要额外说明
`
