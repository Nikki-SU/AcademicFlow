/**
 * 教材/图书数据服务
 * -------------------------------------------------
 * SPEC §4.6 / §3：教材数据存储在 GitHub 私库 textbooks/textbooks.csv
 *
 * 列以私库现有文件为准（后端那边就是这套表头）：
 *   textbook_id,title,author,publisher,year,notes,added_at
 *
 * 图书正文落盘约定：
 * - `textbooks/{书名}/content.md` — 整本正文（PDF → MinerU → 按页拼接）
 * - 书名即主键：书基本不会重名，所以目录名就是书名（textbook_id 也用书名）
 *
 * 阅读页按「目录」发现图书，因此不依赖 textbooks.csv 的字段顺序。
 */

import { readCsvFile, writeCsvFile, readMdFile, getRepoContext } from './userData'
import { githubFetch } from './github'

export interface Textbook {
  textbookId: string
  title: string
  author: string
  publisher: string
  year: number
  notes: string
  addedAt: number
}

const TEXTBOOKS_PATH = 'textbooks/textbooks.csv'
const TEXTBOOK_HEADERS = [
  'textbook_id', 'title', 'author', 'publisher', 'year', 'notes', 'added_at',
]

export async function loadTextbooks(force = false): Promise<Textbook[]> {
  return readCsvFile(
    TEXTBOOKS_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      return rows.slice(1).map((r) => ({
        textbookId: r[0] || '',
        title: r[1] || '',
        author: r[2] || '',
        publisher: r[3] || '',
        year: parseInt(r[4] || '0', 10),
        notes: r[5] || '',
        addedAt: parseInt(r[6] || '0', 10),
      }))
    },
    force,
  )
}

export async function saveTextbooks(textbooks: Textbook[]): Promise<void> {
  await writeCsvFile(
    TEXTBOOKS_PATH,
    textbooks,
    TEXTBOOK_HEADERS,
    (t) => [
      t.textbookId,
      t.title,
      t.author,
      t.publisher,
      String(t.year),
      t.notes,
      String(t.addedAt),
    ],
  )
}

// ============================================================
// 图书（整本）阅读
// ============================================================

const TEXTBOOKS_DIR = 'textbooks'

/** 整本正文的候选文件名：优先 content.md（SPEC 约定），兼容历史命名 */
const BOOK_CONTENT_CANDIDATES = ['content.md', 'full.md', 'index.md']

export interface BookSummary {
  /** 书名（= `textbooks/` 下的目录名，同时也是 textbook_id） */
  id: string
  title: string
  /** 是否已经有整本正文 */
  hasContent: boolean
}

/** 一次性拉全仓库树，取出 textbooks/ 下的文件路径（发现图书目录，不依赖 CSV） */
async function fetchTextbookPaths(): Promise<Set<string> | null> {
  const ctx = getRepoContext()
  if (!ctx) return null
  try {
    const res = await githubFetch(
      `/repos/${ctx.owner}/${ctx.repo}/git/trees/main?recursive=1`,
      ctx.token,
    )
    if (!res.ok) return null
    const data = (await res.json()) as { tree?: Array<{ path: string; type: string }> }
    const paths = new Set<string>()
    for (const entry of data.tree ?? []) {
      if (entry.type === 'blob' && entry.path.startsWith(`${TEXTBOOKS_DIR}/`)) {
        paths.add(entry.path)
      }
    }
    return paths
  } catch {
    return null
  }
}

/** 列出图书：`textbooks/` 下的每个一级目录 = 一本书，目录名即书名 */
export async function listBooks(): Promise<BookSummary[]> {
  const paths = await fetchTextbookPaths()
  if (!paths) return []
  const names = new Set<string>()
  for (const path of paths) {
    const rest = path.slice(TEXTBOOKS_DIR.length + 1)
    const slash = rest.indexOf('/')
    if (slash > 0) names.add(rest.slice(0, slash))
  }
  return [...names]
    .sort((a, b) => a.localeCompare(b, 'zh'))
    .map((id) => ({
      id,
      title: id,
      hasContent: BOOK_CONTENT_CANDIDATES.some((n) => paths.has(`${TEXTBOOKS_DIR}/${id}/${n}`)),
    }))
}

/** 读取一本书的整本正文；没有正文时返回空串（阅读页据此显示「待转换」） */
export async function loadBookContent(bookId: string, force = false): Promise<string> {
  for (const name of BOOK_CONTENT_CANDIDATES) {
    const result = await readMdFile(`${TEXTBOOKS_DIR}/${bookId}/${name}`, force)
    if (result?.content?.trim()) return result.content
  }
  return ''
}
