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
import { readCsvFile, writeCsvFile } from './userData'

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
 * 把代码内容涂成空格（换行保留）。
 * 长度与原串严格一致 —— 这是后面能直接用下标替换原文的前提。
 */
function maskCode(md: string): string {
  const chars = md.split('')
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < chars.length; k++) {
      if (chars[k] !== '\n') chars[k] = ' '
    }
  }

  // 围栏代码块：``` 或 ~~~（配对，允许信息串）
  const fenceRe = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n\2[^\n]*|$)/g
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(md))) blank(m.index, m.index + m[0].length)

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

/** 扫出全部图片（文档顺序 = 渲染后 <img> 顺序） */
export function parseImages(md: string): MarkdownImage[] {
  const masked = maskCode(md)
  const out: MarkdownImage[] = []
  const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(masked))) {
    // 从原文里取 src（masked 里 src 原样保留，因为不含反引号/围栏）
    const srcMatch = /\(([^)\s]+)/.exec(md.slice(m.index))
    out.push({
      index: out.length,
      alt: m[1],
      src: srcMatch ? srcMatch[1] : '',
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return out
}

/** 扫出全部 markdown 表格（连续以 | 开头/结尾的行，且含对齐行） */
export function parseTables(md: string): MarkdownTable[] {
  const lines = md.split('\n')
  const isRow = (line: string) => /^\s*\|.*\|\s*$/.test(line)
  const isSep = (line: string) =>
    /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-')

  const out: MarkdownTable[] = []
  let i = 0
  while (i < lines.length) {
    if (!isRow(lines[i])) {
      i++
      continue
    }
    let j = i
    while (j < lines.length && isRow(lines[j])) j++
    const block = lines.slice(i, j)
    // 合法表格：至少 表头 + 对齐行（+ 数据行）
    if (block.length >= 2 && isSep(block[1])) {
      const rows = block
        .filter((_, idx) => idx !== 1)
        .map((line) =>
          line
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((c) => c.trim()),
        )
      out.push({ index: out.length, rows, startLine: i, endLine: j - 1 })
    }
    i = j
  }
  return out
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
