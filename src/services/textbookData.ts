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

import { readCsvFile, writeCsvFile, readMdFile, writeMdFile, getRepoContext } from './userData'
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

/** 整本正文的标准文件名（SPEC 约定）；历史命名 full.md / index.md 由迁移规整，不在这里兼容 */
const BOOK_CONTENT_FILE = 'content.md'

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
      hasContent: paths.has(`${TEXTBOOKS_DIR}/${id}/${BOOK_CONTENT_FILE}`),
    }))
}

/** 读取一本书的整本正文；没有正文时返回空串（阅读页据此显示「待转换」） */
export async function loadBookContent(bookId: string, force = false): Promise<string> {
  const result = await readMdFile(`${TEXTBOOKS_DIR}/${bookId}/${BOOK_CONTENT_FILE}`, force)
  return result?.content?.trim() ? result.content : ''
}

/**
 * 覆写一本书的整本正文（图书内容编辑 / 大纲层级改写共用这一条写路径）。
 * 写的是同一份 `textbooks/{书名}/content.md`：MinerU 提取不准，用户要能手动修。
 */
export async function saveBookContent(bookId: string, content: string): Promise<void> {
  await writeMdFile(
    `${TEXTBOOKS_DIR}/${bookId}/${BOOK_CONTENT_FILE}`,
    content,
    `Update textbook content: ${bookId}`,
  )
}

/**
 * 判断一本书的整本正文产物是否已经生成。
 *
 * 兜底用：book_convert 跑完时先写 `.progress.json {stage:done}` 再立刻删掉，
 * 5s 一次的前端轮询基本抓不到那个 done（写和删之间只有几毫秒）。这时如果
 * 任务里又没存住 run id，前端就会永远停在最后一帧 `mineru_download`。
 * 所以直接看产物文件在不在 —— 在 = 转换确实完成了。
 *
 * 返回值：true 有产物；false 没有；null = 仓库树没拉到（网络/权限问题，别据此判定）。
 */
export async function bookHasContent(bookId: string): Promise<boolean | null> {
  const paths = await fetchTextbookPaths()
  if (!paths) return null
  return paths.has(`${TEXTBOOKS_DIR}/${bookId}/${BOOK_CONTENT_FILE}`)
}
