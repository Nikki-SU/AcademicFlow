/**
 * 库内全文检索
 * ------------------------------------------------------------
 * 为什么是"本地索引"而不是 GitHub 的代码搜索 API：
 *   1) 代码搜索接口限流 10 次/分钟，输入即搜根本撑不住；
 *   2) 它只索引默认分支、且不回传可直接用的上下文片段；
 *   3) 我们要的是"点结果直接跳到正文命中处"，这需要确切文本与位置。
 * 所以这里一次性把库里的 Markdown 正文拉下来（readMdFile 自带按路径缓存，
 * 已经打开过的文档不会重复请求），在内存里做子串检索。
 *
 * 索引范围 = 知识库里的**正文**：
 *   - 文献：literatures/{slug}/{slug}.md（块文档，中英两块都在里面）
 *           没有块文档时退回 MinerU 原文 full.md / fulltext.md
 *   - 图书：textbooks/{id}/content.md（兼容 full.md / index.md）
 *   - 其他文档：documents/{id}/content.md（兼容 full.md / index.md）
 */

import { readMdFile } from './userData'
import { listBooks } from './textbookData'
import { listDocuments } from './documentData'
import { loadLiteratures, doiToSlug } from './literatureData'
import { stripMarkers } from './blocks.mjs'

export type SearchKind = 'paper' | 'book' | 'document'

/** 索引里的一篇正文 */
export interface SearchDoc {
  kind: SearchKind
  /** 文献 → DOI；图书 → 书名（= textbooks/ 下的目录名）；其他文档 → documentId */
  id: string
  title: string
  /** 去掉块标记之后的正文纯文本 */
  text: string
}

/** 一条命中片段（上下文已切好；关键词高亮交给 UI 做，检索层不插入任何标签） */
export interface SearchSnippet {
  text: string
}

export interface SearchHit {
  kind: SearchKind
  id: string
  title: string
  /** 整篇正文里的命中总次数 */
  total: number
  snippets: SearchSnippet[]
}

/** 每篇正文最多给出几条片段 */
const SNIPPETS_PER_DOC = 3
/** 片段前后各取多少字符 */
const SNIPPET_BEFORE = 60
const SNIPPET_AFTER = 90

let indexCache: SearchDoc[] | null = null
let building: Promise<SearchDoc[]> | null = null

/** 已经建好的索引（没有则为 null）—— 页面可以用它判断要不要提示"首次检索需建索引" */
export function getSearchIndex(): SearchDoc[] | null {
  return indexCache
}

/** 丢弃索引（仓库内容变更后调用） */
export function invalidateSearchIndex(): void {
  indexCache = null
}

/** 候选路径里第一个有内容的；都没有则返回空串 */
async function readFirstAvailable(paths: string[]): Promise<string> {
  for (const p of paths) {
    const r = await readMdFile(p)
    if (r?.content?.trim()) return r.content
  }
  return ''
}

/** 把一段 Markdown 变成本文检索用的纯文本：去掉块标记 + 收拢空白 */
export function toSearchText(md: string): string {
  return stripMarkers(md).replace(/\r\n?/g, '\n')
}

/** 并发上限，避免一次打几百个请求把 GitHub 触发二级限流 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

interface Target {
  kind: SearchKind
  id: string
  title: string
  paths: string[]
}

/** 收集所有待索引的正文路径 */
async function collectTargets(): Promise<Target[]> {
  const targets: Target[] = []

  // 文献：以元数据表为准（有 DOI 才有稳定标题），路径按 slug 推断
  try {
    const lits = await loadLiteratures()
    for (const l of lits) {
      if (!l.doi) continue
      const slug = doiToSlug(l.doi)
      targets.push({
        kind: 'paper',
        id: l.doi,
        title: l.title || l.doi,
        paths: [
          `literatures/${slug}/${slug}.md`,
          `literatures/${slug}/full.md`,
          `literatures/${slug}/fulltext.md`,
        ],
      })
    }
  } catch (err) {
    console.warn('[librarySearch] 文献列表读取失败，跳过文献索引：', err)
  }

  // 图书
  try {
    const books = await listBooks()
    for (const b of books) {
      if (!b.hasContent) continue
      targets.push({
        kind: 'book',
        id: b.id,
        title: b.title,
        paths: [`textbooks/${b.id}/content.md`, `textbooks/${b.id}/full.md`, `textbooks/${b.id}/index.md`],
      })
    }
  } catch (err) {
    console.warn('[librarySearch] 图书列表读取失败，跳过图书索引：', err)
  }

  // 其他文档
  try {
    const docs = await listDocuments()
    for (const d of docs) {
      if (!d.hasContent) continue
      targets.push({
        kind: 'document',
        id: d.id,
        title: d.title || d.id,
        paths: [`documents/${d.id}/content.md`, `documents/${d.id}/full.md`, `documents/${d.id}/index.md`],
      })
    }
  } catch (err) {
    console.warn('[librarySearch] 文档列表读取失败，跳过文档索引：', err)
  }

  return targets
}

/**
 * 建立（或复用）全文索引。
 * onProgress 用来在首次建索引时给用户一个进度，别让人以为卡死了。
 */
export async function buildSearchIndex(
  onProgress?: (done: number, total: number) => void,
): Promise<SearchDoc[]> {
  if (indexCache) return indexCache
  if (building) return building

  building = (async () => {
    const targets = await collectTargets()
    let done = 0
    onProgress?.(0, targets.length)

    const docs = await mapLimit(targets, 6, async (t) => {
      const raw = await readFirstAvailable(t.paths)
      done++
      onProgress?.(done, targets.length)
      if (!raw.trim()) return null
      return { kind: t.kind, id: t.id, title: t.title, text: toSearchText(raw) } satisfies SearchDoc
    })

    indexCache = docs.filter((d): d is SearchDoc => d !== null)
    building = null
    return indexCache
  })()

  return building
}

/** 把查询切成词：空白分隔，全部词都要出现（AND） */
function termsOf(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

/** 在纯文本里数一个词出现几次（大小写不敏感） */
function countOccurrences(haystackLower: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let from = 0
  while (true) {
    const at = haystackLower.indexOf(needle, from)
    if (at < 0) break
    count++
    from = at + needle.length
    if (count >= 5000) break
  }
  return count
}

/** 以某个位置为中心切一段上下文 */
function snippetAround(text: string, at: number, len: number): SearchSnippet {
  const from = Math.max(0, at - SNIPPET_BEFORE)
  const to = Math.min(text.length, at + len + SNIPPET_AFTER)
  const head = from > 0 ? '…' : ''
  const tail = to < text.length ? '…' : ''
  return { text: `${head}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${tail}` }
}

/** 在已建好的索引里检索 */
export function searchIndex(index: SearchDoc[], query: string, maxDocs = 50): SearchHit[] {
  const terms = termsOf(query)
  if (terms.length === 0) return []

  const hits: SearchHit[] = []

  for (const doc of index) {
    const lower = doc.text.toLowerCase()

    // AND 语义：任何一个词不出现，这篇就不算命中
    let total = 0
    let allPresent = true
    for (const t of terms) {
      const c = countOccurrences(lower, t)
      if (c === 0) { allPresent = false; break }
      total += c
    }
    if (!allPresent) continue

    // 片段以第一个词为准，逐条往后取，避免三条片段挤在同一处
    const snippets: SearchSnippet[] = []
    const first = terms[0]
    let from = 0
    while (snippets.length < SNIPPETS_PER_DOC) {
      const at = lower.indexOf(first, from)
      if (at < 0) break
      snippets.push(snippetAround(doc.text, at, first.length))
      from = at + first.length + SNIPPET_AFTER
    }

    hits.push({ kind: doc.kind, id: doc.id, title: doc.title, total, snippets })
  }

  hits.sort((a, b) => b.total - a.total)
  return hits.slice(0, maxDocs)
}

/** 建索引（必要时）+ 检索一步到位 */
export async function searchLibrary(
  query: string,
  onProgress?: (done: number, total: number) => void,
): Promise<SearchHit[]> {
  const index = await buildSearchIndex(onProgress)
  return searchIndex(index, query)
}

/** 检索词高亮用的正则：把词按长度降序排，避免短词先吃掉长词 */
export function buildHighlightRegex(query: string): RegExp | null {
  const terms = termsOf(query)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (terms.length === 0) return null
  return new RegExp(`(${terms.join('|')})`, 'gi')
}

export const KIND_LABEL: Record<SearchKind, string> = {
  paper: '文献',
  book: '图书',
  document: '文档',
}
