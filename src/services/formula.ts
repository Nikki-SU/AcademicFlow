/**
 * 公式 / 图片 / 表格 的解析与就地改写
 * ------------------------------------------------------------
 * 为什么不用正则一把梭：
 *   md 里的 `$` 既可能是公式定界符，也可能是正文里的美元符号、或者代码块里的字符。
 *   所以先把「围栏代码块 + 行内代码」按原长度涂成空格（保留索引），再在涂过的文本上
 *   定位公式 —— 这样拿到的 start/end 直接就是原文下标，能精确替换，不会误伤代码。
 *
 * 这一层只做「机器可判定的」部分：定界符识别、下标定位、替换。
 * 「这个公式对不对」交给人和 AI，不在这里猜。
 */
import { marked, type Token } from 'marked'
import { readCsvFile, writeCsvFile } from './userData'
import { formatImageSize, type ImageSize } from './editorImages'

export interface FormulaToken {
  kind: 'inline' | 'block'
  /** 定界符内部的 LaTeX 源码（不含 $ / $$） */
  tex: string
  /** 原文切片，含定界符（用于原位替换） */
  raw: string
  /** 在 md 中的起始下标 */
  start: number
  /** 在 md 中的结束下标（不含） */
  end: number
}

export interface MarkdownImage {
  /** 在文档中第几张图（从 0 开始，与渲染后 <img> 的顺序一致） */
  index: number
  alt: string
  src: string
  /** title 位 —— 本项目借它存尺寸（width=60% height=40%） */
  title: string
  start: number
  end: number
}

export interface MarkdownTable {
  index: number
  /** 表头 + 数据行（已去掉首尾竖线、按未转义竖线切分）；对齐行不计入 */
  rows: string[][]
  /** 原文行号（从 0 开始），方便定位 */
  startLine: number
  endLine: number
}

/**
 * 深度遍历 marked 的 token 树。
 * 为什么要递归：图片可能嵌在列表项、引用、表格单元格里，
 * 只看顶层 token 会漏。
 */
function walkTokens(tokens: Token[], visit: (t: Token) => void) {
  for (const t of tokens) {
    visit(t)
    const bag = t as unknown as Record<string, unknown>
    if (Array.isArray(bag.tokens)) walkTokens(bag.tokens as Token[], visit)
    if (Array.isArray(bag.items)) walkTokens(bag.items as Token[], visit)
    if (Array.isArray(bag.header)) walkTokens(bag.header as Token[], visit)
    if (Array.isArray(bag.rows)) {
      for (const row of bag.rows as Token[][]) if (Array.isArray(row)) walkTokens(row, visit)
    }
  }
}

/** 用 marked 词法分析，失败时回退空数组（不因为解析异常让整个校对面板挂掉） */
function lex(md: string): Token[] {
  try {
    return marked.lexer(md)
  } catch {
    return []
  }
}

/**
 * 把代码内容涂成空格（换行保留）。
 * 长度与原串严格一致 —— 这是后面能直接用下标替换原文的前提。
 *
 * 代码区域来自 marked 的 `code` token（围栏块 + 缩进块都能认出来），
 * 再补扫一遍行内代码 `...`；比纯正则可靠 —— 自己写围栏正则时
 * 缩进代码块（4 空格）是漏的。
 */
function maskCode(md: string): string {
  const chars = md.split('')
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < chars.length; k++) {
      if (chars[k] !== '\n') chars[k] = ' '
    }
  }

  // 块级代码：按文档顺序在原文里定位（重复内容用游标依次匹配，不会错位）
  let cursor = 0
  for (const t of lex(md)) {
    if (t.type !== 'code') continue
    const raw = t.raw
    if (!raw) continue
    const at = md.indexOf(raw, cursor)
    if (at === -1) continue
    blank(at, at + raw.length)
    cursor = at + raw.length
  }

  const masked = chars.join('')
  // 行内代码：`...`（不跨行）
  const inlineRe = /`[^`\n]*`/g
  const chars2 = masked.split('')
  let m2: RegExpExecArray | null
  while ((m2 = inlineRe.exec(masked))) {
    for (let k = m2.index; k < m2.index + m2[0].length; k++) {
      if (chars2[k] !== '\n') chars2[k] = ' '
    }
  }
  return chars2.join('')
}

/**
 * 扫出全部公式（文档顺序）。
 * 行内判定偏保守：定界符内若首尾有空白、或看起来更像散文（含空格且完全没有
 * LaTeX 记号），一律不当公式 —— 否则 "$5 and $6" 这种会被误判成公式。
 */
export function parseFormulas(md: string): FormulaToken[] {
  const masked = maskCode(md)
  const out: FormulaToken[] = []
  const n = masked.length
  let i = 0

  while (i < n) {
    const ch = masked[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch !== '$') {
      i++
      continue
    }

    const isBlock = masked[i + 1] === '$'
    const openLen = isBlock ? 2 : 1
    const contentStart = i + openLen

    // 找闭合定界符
    let j = contentStart
    let close = -1
    while (j < n) {
      if (masked[j] === '\\') {
        j += 2
        continue
      }
      if (masked[j] === '$') {
        if (isBlock) {
          if (masked[j + 1] === '$') {
            close = j
            break
          }
          j++
        } else {
          // 行内：遇到 $$ 说明不是它的闭合，跳过去
          if (masked[j + 1] === '$') {
            j += 2
            continue
          }
          close = j
          break
        }
      } else {
        j++
      }
    }

    if (close === -1) {
      i += openLen
      continue
    }

    const tex = md.slice(contentStart, close)
    if (!isBlock) {
      const looksFormula =
        tex.trim().length > 0 &&
        !/^\s/.test(tex) &&
        !/\s$/.test(tex) &&
        // 含空格又完全没有 LaTeX 记号 → 当散文
        !(/\s/.test(tex) && !/[\\^_{}=+\-*/<>()[\]|]/.test(tex))
      if (!looksFormula) {
        i = close + 1
        continue
      }
    } else if (!tex.trim()) {
      i = close + 2
      continue
    }

    out.push({
      kind: isBlock ? 'block' : 'inline',
      tex,
      raw: md.slice(i, close + openLen),
      start: i,
      end: close + openLen,
    })
    i = close + openLen
  }

  return out
}

/** 用新源码替换第 index 个公式（kind 省略则沿用原公式的行内/行间类型） */
export function replaceNthFormula(
  md: string,
  index: number,
  nextTex: string,
  nextKind?: 'inline' | 'block',
): string {
  const tokens = parseFormulas(md)
  const token = tokens[index]
  if (!token) return md
  const kind = nextKind ?? token.kind
  const delim = kind === 'block' ? '$$' : '$'
  return md.slice(0, token.start) + `${delim}${nextTex}${delim}` + md.slice(token.end)
}

/**
 * 把「源码与 matchTex 相同」的公式**全部**替换成新源码。
 * 用于校对里的「全局变换」：同一条复用公式在正文里出现多处，一次改完。
 * 从后往前替换，保证前面的下标不因长度变化而失效。
 */
export function replaceFormulaOccurrences(
  md: string,
  matchTex: string,
  nextTex: string,
  nextKind?: 'inline' | 'block',
): string {
  const tokens = parseFormulas(md)
  const matches = tokens.filter((t) => t.tex.trim() === matchTex.trim())
  let out = md
  for (let i = matches.length - 1; i >= 0; i--) {
    const t = matches[i]
    const delim = (nextKind ?? t.kind) === 'block' ? '$$' : '$'
    out = out.slice(0, t.start) + `${delim}${nextTex}${delim}` + out.slice(t.end)
  }
  return out
}

/**
 * 删掉正文里这几个公式（连同定界符一起删）。
 *
 * 从后往前删：前面的下标不会因为长度变化而失效。
 * 只删公式本身，周围的空格/换行原样留着 —— 用户自己排的版不该被动。
 */
export function deleteFormulas(md: string, indexes: number[]): string {
  if (indexes.length === 0) return md
  const tokens = parseFormulas(md)
  const wanted = new Set(indexes)
  const targets = tokens.filter((_, i) => wanted.has(i))
  let out = md
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i]
    out = out.slice(0, t.start) + out.slice(t.end)
  }
  return out
}

/**
 * 扫出全部图片（文档顺序 = 渲染后 <img> 顺序）。
 *
 * 走 marked 的 image token：alt / src / title 的边界都由真正的 Markdown 解析器
 * 判定，自己写正则时「alt 里有括号」「src 里有空格」这类写法很容易切错。
 */
export function parseImages(md: string): MarkdownImage[] {
  const found: Token[] = []
  walkTokens(lex(md), (t) => {
    if (t.type === 'image') found.push(t)
  })

  const out: MarkdownImage[] = []
  let cursor = 0
  found.forEach((img, i) => {
    const bag = img as unknown as { raw?: string; text?: string; href?: string; title?: string }
    const raw = String(bag.raw || '')
    let start = -1
    if (raw) {
      const at = md.indexOf(raw, cursor)
      if (at !== -1) {
        start = at
        cursor = at + raw.length
      }
    }
    out.push({
      index: i,
      alt: String(bag.text || ''),
      src: String(bag.href || ''),
      title: String(bag.title || ''),
      start,
      end: start === -1 ? -1 : start + raw.length,
    })
  })
  return out
}

/** 拼一张图的 markdown；路径含空格或括号时用尖括号包住，否则 markdown 会解析错 */
export function imageMarkdown(alt: string, src: string, title = ''): string {
  const href = /[\s()]/.test(src) ? `<${src}>` : src
  return `![${alt}](${href}${title ? ` "${title}"` : ''})`
}

/** 改写第 index 张图的尺寸（写进 title 位），其余部分保持原样 */
export function setImageSize(md: string, index: number, size: ImageSize): string {
  const img = parseImages(md)[index]
  if (!img || img.start === -1) return md
  return (
    md.slice(0, img.start) +
    imageMarkdown(img.alt, img.src, formatImageSize(size)) +
    md.slice(img.end)
  )
}

/**
 * 扫出全部 markdown 表格。
 *
 * 走 marked 的 table token：表头 / 数据行由解析器给出（对齐行天然不在里面，
 * 单元格里的转义竖线也不会被切错），比按行正则稳。
 */
export function parseTables(md: string): MarkdownTable[] {
  const found: Token[] = []
  walkTokens(lex(md), (t) => {
    if (t.type === 'table') found.push(t)
  })

  const out: MarkdownTable[] = []
  let cursor = 0
  found.forEach((t, i) => {
    const bag = t as unknown as {
      header?: Array<{ text?: string }>
      rows?: Array<Array<{ text?: string }>>
      raw?: string
    }
    const rows: string[][] = []
    if (Array.isArray(bag.header)) rows.push(bag.header.map((c) => String(c?.text ?? '').trim()))
    for (const r of bag.rows || []) rows.push(r.map((c) => String(c?.text ?? '').trim()))

    const raw = String(bag.raw || '')
    let startLine = 0
    let endLine = 0
    if (raw) {
      const at = md.indexOf(raw, cursor)
      if (at !== -1) {
        startLine = md.slice(0, at).split('\n').length - 1
        endLine = startLine + raw.replace(/\n$/, '').split('\n').length - 1
        cursor = at + raw.length
      }
    }
    out.push({ index: i, rows, startLine, endLine })
  })
  return out
}

// ────────────────────────────────────────────────────────────
// 表格行列增删
// ────────────────────────────────────────────────────────────

/**
 * 表格行列增删。
 *
 * `at` 的含义随 op 变：
 *  - 行操作：**数据行**下标，0 = 表头下面第一行（表头不参与增删 —— markdown 里
 *    表头必须是第一行、第二行必须是 `| --- |`，在它上面插一行整张表就不再是表格了）
 *  - 列操作：**列**下标，0 = 第一列
 *
 * 和旧版「只作用在末尾」的区别：这里能指定位置。用户的诉求是「在这行下面加一行 /
 * 把这列删掉」，而不是「在表格屁股后面追加一列再去挪」。
 */
export type TableOp =
  | 'addRowAbove'
  | 'addRowBelow'
  | 'addColLeft'
  | 'addColRight'
  | 'delRow'
  | 'delCol'

/**
 * 按**未转义**的竖线把一行切成片段（保留首尾那两个空片段）。
 * 之所以保留每个片段的原文，是为了插入时只往数组里塞一个新格子、其余字符原样接回去 ——
 * 用户自己调过的对齐、单元格里的空格都不会被"重建式"改写冲掉。
 * 返回 null 表示这行根本不是表格行（一个竖线都没有）。
 */
function splitCells(line: string): string[] | null {
  const parts: string[] = []
  let buf = ''
  let sawPipe = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\' && i + 1 < line.length) {
      buf += ch + line[i + 1]
      i++
      continue
    }
    if (ch === '|') {
      sawPipe = true
      parts.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  parts.push(buf)
  return sawPipe ? parts : null
}

/**
 * 一行片段里实际有几个单元格。
 * 首尾那两个空片段是行首 / 行尾竖线切出来的，不算单元格；
 * 但**尾竖线可以省略**（`| a | b` 也是合法的表格行），这时最后一片本身就是单元格。
 */
function countCells(parts: string[]): number {
  const tail = parts[parts.length - 1] === '' ? 1 : 0
  return Math.max(0, parts.length - 1 - tail)
}

export function editTable(md: string, tableIndex: number, op: TableOp, at: number): string {
  const table = parseTables(md)[tableIndex]
  if (!table) return md

  const lines = md.split('\n')
  const { startLine, endLine } = table
  /** 第二行是 | --- | 分隔行，加列时它要补的是 --- 而不是空格 */
  const sepLine = startLine + 1
  /** 第一条数据行；它上面两行是表头与分隔行 */
  const firstDataLine = startLine + 2
  const dataCount = Math.max(0, endLine - firstDataLine + 1)

  const header = splitCells(lines[startLine] ?? '')
  const colCount = header ? countCells(header) || 1 : (table.rows[0]?.length ?? 1)
  const blankRow = () => `|${'  |'.repeat(Math.max(1, colCount))}`

  if (op === 'addRowAbove' || op === 'addRowBelow') {
    if (at < 0 || at > dataCount) return md
    if (op === 'addRowAbove' && at >= dataCount) return md
    lines.splice(firstDataLine + at + (op === 'addRowBelow' ? 1 : 0), 0, blankRow())
  } else if (op === 'delRow') {
    // 只剩一行数据就不删了 —— 删完第二行不再是分隔行，整张表会散成普通文字
    if (dataCount <= 1 || at < 0 || at >= dataCount) return md
    lines.splice(firstDataLine + at, 1)
  } else {
    if (at < 0 || at >= colCount) return md
    // 只剩一列就不删了 —— 没有竖线的表格不是表格
    if (op === 'delCol' && colCount <= 1) return md
    // 表头 / 分隔行 / 每条数据行都要同步改，少改一行列数就对不上，表格直接崩
    const insertAt = op === 'addColLeft' ? at : at + 1
    for (let i = startLine; i <= endLine; i++) {
      const parts = splitCells(lines[i] ?? '')
      if (!parts) continue
      if (op === 'delCol') parts.splice(at + 1, 1)
      else parts.splice(insertAt + 1, 0, i === sepLine ? ' --- ' : '  ')
      lines[i] = parts.join('|')
    }
  }

  return lines.join('\n')
}

// ────────────────────────────────────────────────────────────
// 公式收藏（跨项目复用）
// ────────────────────────────────────────────────────────────

export interface FormulaFavorite {
  id: string
  latex: string
  display: 'inline' | 'block'
  note: string
  createdAt: number
}

const FAVORITES_PATH = 'formulas/favorites.csv'
const FAVORITES_HEADERS = ['id', 'latex', 'display', 'note', 'createdAt']

function parseFavorites(rows: string[][]): FormulaFavorite[] {
  const out: FormulaFavorite[] = []
  for (const row of rows) {
    if (!row[0] || row[0] === FAVORITES_HEADERS[0]) continue
    out.push({
      id: row[0],
      latex: row[1] ?? '',
      display: row[2] === 'block' ? 'block' : 'inline',
      note: row[3] ?? '',
      createdAt: Number(row[4]) || 0,
    })
  }
  return out
}

export async function loadFormulaFavorites(force = false): Promise<FormulaFavorite[]> {
  return readCsvFile(FAVORITES_PATH, parseFavorites, force)
}

/** 就地改收藏列表（内部负责整表回写） */
async function persistFavorites(list: FormulaFavorite[]): Promise<void> {
  await writeCsvFile(FAVORITES_PATH, list, FAVORITES_HEADERS, (f) => [
    f.id,
    f.latex,
    f.display,
    f.note,
    String(f.createdAt),
  ])
}

/** 收藏一条公式；已收藏（latex 完全相同）则返回 false 不动 */
export async function addFormulaFavorite(
  latex: string,
  display: 'inline' | 'block',
  note = '',
): Promise<boolean> {
  const list = await loadFormulaFavorites(true)
  const key = latex.trim()
  if (list.some((f) => f.latex.trim() === key)) return false
  list.push({
    id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    latex,
    display,
    note,
    createdAt: Date.now(),
  })
  await persistFavorites(list)
  return true
}

export async function removeFormulaFavorite(id: string): Promise<void> {
  const list = await loadFormulaFavorites(true)
  await persistFavorites(list.filter((f) => f.id !== id))
}
