/**
 * 引用服务：DOI 归一化 · 元数据解析 · BibTeX 生成 · 排序
 * -------------------------------------------------
 * 核心功能：
 * - 从各种 DOI 格式（纯 DOI / https://doi.org/... / dx.doi.org/...）归一化
 * - 从 Markdown 中提取引用标记（支持 [@doi:xxx]、[@10.xxx/xxx]、直接粘贴 DOI 链接）
 * - 调用 CrossRef API 获取文献元数据
 * - IndexedDB 缓存（避免重复请求）
 * - 生成 BibTeX
 * - 按出现顺序 / 作者年份 / 字母排序
 */
import { db } from './db'
import type { CitationEntry, DoiNormalizeResult } from '../types'

/** CrossRef API 基础 URL */
const CROSSREF_API_BASE = 'https://api.crossref.org'

/** 引用缓存 TTL（7 天，ms） */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

// ============================================================
// DOI 归一化
// ============================================================

/**
 * 归一化 DOI：从各种输入格式中提取纯 DOI（10.xxx/xxx）
 *
 * 支持的输入格式：
 * - 纯 DOI: 10.1038/nature12345
 * - DOI 链接: https://doi.org/10.1038/nature12345
 * - http 前缀: http://doi.org/10.1038/nature12345
 * - dx.doi.org: https://dx.doi.org/10.1038/nature12345
 * - 带尾部斜杠: https://doi.org/10.1038/nature12345/
 * - doi: 前缀: doi:10.1038/nature12345
 */
export function normalizeDoi(input: string): DoiNormalizeResult {
  const raw = input.trim()

  if (!raw) {
    return { valid: false, raw }
  }

  let cleaned = raw

  // 去掉常见的 URL 前缀
  cleaned = cleaned.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
  cleaned = cleaned.replace(/^doi:\s*/i, '')
  cleaned = cleaned.replace(/^https?:\/\/.*?doi\.org\//i, '')

  // 去掉尾部斜杠
  cleaned = cleaned.replace(/\/+$/, '')

  // 去掉 URL query 和 hash
  cleaned = cleaned.split('?')[0].split('#')[0]

  // URL 解码（处理 %2F 等）
  try {
    cleaned = decodeURIComponent(cleaned)
  } catch {
    // 解码失败就用原始的
  }

  // DOI 正则：10.xxxx/xxxx（前缀是 10. + 4位以上数字/点，斜杠后是任意字符）
  const doiRegex = /^10\.\d{4,}(\.\d+)*\/.+$/i

  if (doiRegex.test(cleaned)) {
    return {
      valid: true,
      doi: cleaned.toLowerCase(),
      raw,
    }
  }

  return { valid: false, raw }
}

/**
 * 批量归一化 DOI，返回有效 DOI 列表（去重）
 */
export function normalizeDois(inputs: string[]): {
  valid: string[]
  invalid: string[]
} {
  const validSet = new Set<string>()
  const invalid: string[] = []

  for (const input of inputs) {
    const result = normalizeDoi(input)
    if (result.valid && result.doi) {
      validSet.add(result.doi)
    } else if (input.trim()) {
      invalid.push(input)
    }
  }

  return {
    valid: Array.from(validSet),
    invalid,
  }
}

// ============================================================
// 从 Markdown 提取引用
// ============================================================

/**
 * 从 Markdown 文本中提取所有引用标记
 *
 * 支持的引用语法：
 * - [@doi:10.1038/nature12345]
 * - [@10.1038/nature12345]
 * - 直接的 DOI 链接: https://doi.org/10.1038/nature12345
 * - \cite{doi:10.1038/nature12345}（LaTeX 格式）
 *
 * 返回：按出现顺序排列的 DOI 列表（已去重但保持首次出现顺序）
 */
export function extractCitationsFromMarkdown(markdown: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  const addDoi = (doi: string) => {
    const normalized = normalizeDoi(doi)
    if (normalized.valid && normalized.doi && !seen.has(normalized.doi)) {
      seen.add(normalized.doi)
      result.push(normalized.doi)
    }
  }

  // 1. 匹配 [@doi:xxx] 或 [@xxx] 格式
  const citeBracketRegex = /\[@(?:doi:)?([^\]]+)\]/gi
  let match
  while ((match = citeBracketRegex.exec(markdown)) !== null) {
    addDoi(match[1])
  }

  // 2. 匹配 \cite{...} 格式（LaTeX）
  const citeLatexRegex = /\\cite\{([^}]+)\}/gi
  while ((match = citeLatexRegex.exec(markdown)) !== null) {
    const keys = match[1].split(',')
    for (const key of keys) {
      const trimmed = key.trim()
      // 去掉可能的 doi: 前缀
      const doi = trimmed.replace(/^doi:/i, '')
      addDoi(doi)
    }
  }

  // 3. 匹配直接的 DOI 链接（https://doi.org/...）
  const doiLinkRegex = /https?:\/\/(dx\.)?doi\.org\/(10\.\d{4,}(\.\d+)*\/[^\s<>"')\]]+)/gi
  while ((match = doiLinkRegex.exec(markdown)) !== null) {
    addDoi(match[2])
  }

  // 4. 匹配行内纯 DOI（10.xxxx/xxxx 格式）
  // 注意：这个放最后，避免误匹配
  const pureDoiRegex = /(?<!\w)(10\.\d{4,}(\.\d+)*\/[^\s<>"')\],;]+)/gi
  while ((match = pureDoiRegex.exec(markdown)) !== null) {
    // 排除已经在链接里的
    const beforeChar = markdown.charAt(match.index - 1)
    if (beforeChar !== '/' && beforeChar !== ':') {
      addDoi(match[1])
    }
  }

  return result
}

// ============================================================
// CrossRef API 调用
// ============================================================

/**
 * 从 CrossRef 获取单篇文献的元数据
 */
async function fetchFromCrossref(doi: string): Promise<CitationEntry | null> {
  try {
    const url = `${CROSSREF_API_BASE}/works/${encodeURIComponent(doi)}`
    const resp = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'AcademicFlow/1.0 (mailto:contact@example.com)',
      },
    })

    if (!resp.ok) {
      if (resp.status === 404) return null
      throw new Error(`CrossRef API error: ${resp.status}`)
    }

    const data = (await resp.json()) as {
      message?: {
        title?: string[]
        author?: Array<{
          family?: string
          given?: string
          name?: string
        }>
        'container-title'?: string[]
        issued?: {
          'date-parts'?: Array<number[]>
        }
        volume?: string
        issue?: string
        page?: string
        publisher?: string
        DOI?: string
      }
    }

    const msg = data.message
    if (!msg) return null

    const authors: string[] = []
    if (Array.isArray(msg.author)) {
      for (const a of msg.author) {
        if (a.family) {
          const name = a.given ? `${a.family}, ${a.given}` : a.family
          authors.push(name)
        } else if (a.name) {
          authors.push(a.name)
        }
      }
    }

    let year: number | undefined
    if (msg.issued?.['date-parts']?.[0]?.[0]) {
      year = msg.issued['date-parts'][0][0]
    }

    return {
      doi: (msg.DOI || doi).toLowerCase(),
      title: msg.title?.[0] || '',
      authors,
      journal: msg['container-title']?.[0],
      year,
      volume: msg.volume,
      issue: msg.issue,
      pages: msg.page,
      publisher: msg.publisher,
      source: 'crossref',
      fetched_at: Date.now(),
    }
  } catch (err) {
    console.warn(`[citation] CrossRef fetch failed for ${doi}:`, err)
    return null
  }
}

// ============================================================
// 缓存管理
// ============================================================

/** 检查缓存是否有效 */
function isCacheValid(entry: CitationEntry): boolean {
  return Date.now() - entry.fetched_at < CACHE_TTL_MS
}

/**
 * 批量获取引用元数据（优先读缓存，缓存 miss 则调 CrossRef）
 */
export async function getCitationEntries(
  dois: string[],
): Promise<{
  entries: CitationEntry[]
  failed: string[]
}> {
  const entries: CitationEntry[] = []
  const failed: string[] = []
  const toFetch: string[] = []

  // 1. 先查缓存
  for (const doi of dois) {
    const cached = await db.citation_cache.get(doi)
    if (cached && isCacheValid(cached)) {
      entries.push(cached)
    } else {
      toFetch.push(doi)
    }
  }

  // 2. 批量 fetch（串行，避免触发 CrossRef 限流）
  for (const doi of toFetch) {
    const entry = await fetchFromCrossref(doi)
    if (entry) {
      entries.push(entry)
      // 写入缓存
      await db.citation_cache.put(entry).catch(() => {
        // 缓存写入失败不影响主流程
      })
    } else {
      failed.push(doi)
    }
  }

  return { entries, failed }
}

// ============================================================
// BibTeX 生成
// ============================================================

/**
 * 生成 BibTeX cite key（基于第一作者姓 + 年份 + 标题首词）
 */
function generateCiteKey(entry: CitationEntry): string {
  let key = ''

  // 第一作者姓
  if (entry.authors.length > 0) {
    const firstAuthor = entry.authors[0]
    const lastName = firstAuthor.split(',')[0].trim()
    // 只保留字母
    key += lastName.replace(/[^a-zA-Z]/g, '').toLowerCase()
  } else {
    key += 'anon'
  }

  // 年份
  if (entry.year) {
    key += entry.year
  }

  // 标题首词
  if (entry.title) {
    const firstWord = entry.title
      .split(/\s+/)
      .find((w) => w.length > 3 && /^[a-zA-Z]/.test(w))
    if (firstWord) {
      key += firstWord.charAt(0).toUpperCase() + firstWord.slice(1).toLowerCase()
    }
  }

  // 兜底：用 DOI
  if (!key || key.length < 5) {
    key = 'doi_' + entry.doi.replace(/[^a-zA-Z0-9]/g, '_')
  }

  return key
}

/**
 * 将单条引用转换为 BibTeX 格式
 */
function entryToBibtex(entry: CitationEntry, citeKey: string): string {
  const lines: string[] = []
  lines.push(`@article{${citeKey},`)

  if (entry.title) {
    lines.push(`  title = {${entry.title}},`)
  }

  if (entry.authors.length > 0) {
    const authorStr = entry.authors.join(' and ')
    lines.push(`  author = {${authorStr}},`)
  }

  if (entry.journal) {
    lines.push(`  journal = {${entry.journal}},`)
  }

  if (entry.year) {
    lines.push(`  year = {${entry.year}},`)
  }

  if (entry.volume) {
    lines.push(`  volume = {${entry.volume}},`)
  }

  if (entry.issue) {
    lines.push(`  number = {${entry.issue}},`)
  }

  if (entry.pages) {
    lines.push(`  pages = {${entry.pages}},`)
  }

  if (entry.publisher) {
    lines.push(`  publisher = {${entry.publisher}},`)
  }

  lines.push(`  doi = {${entry.doi}},`)
  lines.push('}')

  return lines.join('\n')
}

/**
 * 批量生成 BibTeX
 * @param entries 引用条目列表
 * @param doiOrder DOI 出现顺序（用于排序）
 * @param sortMode 排序方式
 */
export function generateBibtex(
  entries: CitationEntry[],
  sortMode: 'appearance' | 'author-year' | 'alphabetical' = 'appearance',
  doiOrder: string[] = [],
): {
  bibtex: string
  citeKeys: Record<string, string> // DOI -> cite key
} {
  const citeKeys: Record<string, string> = {}
  let sortedEntries = [...entries]

  // 排序
  switch (sortMode) {
    case 'appearance':
      // 按出现顺序排序
      sortedEntries.sort((a, b) => {
        const idxA = doiOrder.indexOf(a.doi)
        const idxB = doiOrder.indexOf(b.doi)
        if (idxA === -1 && idxB === -1) return 0
        if (idxA === -1) return 1
        if (idxB === -1) return -1
        return idxA - idxB
      })
      break
    case 'author-year':
      sortedEntries.sort((a, b) => {
        const authorA = a.authors[0]?.split(',')[0]?.toLowerCase() || ''
        const authorB = b.authors[0]?.split(',')[0]?.toLowerCase() || ''
        if (authorA !== authorB) return authorA.localeCompare(authorB)
        return (b.year || 0) - (a.year || 0)
      })
      break
    case 'alphabetical':
      sortedEntries.sort((a, b) => a.title.localeCompare(b.title))
      break
  }

  // 生成 cite key 和 bibtex
  const bibtexEntries: string[] = []
  const usedKeys = new Set<string>()

  for (const entry of sortedEntries) {
    let key = generateCiteKey(entry)
    // 处理重名
    let suffix = ''
    let counter = 1
    while (usedKeys.has(key + suffix)) {
      counter++
      suffix = String.fromCharCode(96 + counter) // a, b, c...
    }
    key = key + suffix
    usedKeys.add(key)
    citeKeys[entry.doi] = key
    bibtexEntries.push(entryToBibtex(entry, key))
  }

  return {
    bibtex: bibtexEntries.join('\n\n'),
    citeKeys,
  }
}

// ============================================================
// 排序工具
// ============================================================

/**
 * 按指定方式排序 DOI 列表
 */
export function sortDois(
  dois: string[],
  entries: CitationEntry[],
  sortMode: 'appearance' | 'author-year' | 'alphabetical',
): string[] {
  const entryMap = new Map(entries.map((e) => [e.doi, e]))

  return [...dois].sort((a, b) => {
    const entryA = entryMap.get(a)
    const entryB = entryMap.get(b)

    if (!entryA && !entryB) return 0
    if (!entryA) return 1
    if (!entryB) return -1

    switch (sortMode) {
      case 'appearance':
        return 0 // 出现顺序即原顺序
      case 'author-year': {
        const authorA = entryA.authors[0]?.split(',')[0]?.toLowerCase() || ''
        const authorB = entryB.authors[0]?.split(',')[0]?.toLowerCase() || ''
        if (authorA !== authorB) return authorA.localeCompare(authorB)
        return (entryB.year || 0) - (entryA.year || 0)
      }
      case 'alphabetical':
        return entryA.title.localeCompare(entryB.title)
      default:
        return 0
    }
  })
}
