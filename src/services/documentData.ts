/**
 * 其他文档数据服务
 * -------------------------------------------------
 * 「其他文档」= 用户自己导入的 markdown，直接阅读，不经过 MinerU 转换。
 * 阅读侧结构与图书完全对称，区别只在正文来源（图书是转换产物，文档是导入的原文）。
 *
 * 存储约定：
 *   documents/documents.csv              索引（document_id,title,author,source,added_at）
 *   documents/{目录名}/content.md        正文
 *
 * 为什么要有索引表而不是像图书那样只靠目录名：
 *   图书书名基本不会重名，且标题就等于目录名；用户导入的 markdown 文件名五花八门
 *   （`未命名.md`、`1.md`、`README.md`…），必须允许「标题 ≠ 目录名」。目录名只当主键。
 *
 * 目录发现与索引表并存：索引里有但目录没有 → hasContent=false；目录有但索引没有
 * （导入写正文成功、写索引失败）→ 用目录名兜底显示，不至于变成看不见的孤儿文件。
 */

import { readCsvFile, writeCsvFile, readMdFile, getRepoContext } from './userData'
import { githubFetch, writeFileBatch, deleteRepoFiles, type BatchFileOp } from './github'
import JSZip from 'jszip'

export interface DocEntry {
  documentId: string
  title: string
  author: string
  source: string
  addedAt: number
}

export interface DocumentSummary {
  /** documents/ 下的目录名，同时也是主键 */
  id: string
  title: string
  author: string
  /** 是否已经有正文 */
  hasContent: boolean
}

const DOCS_DIR = 'documents'
const DOCS_PATH = 'documents/documents.csv'
const DOC_HEADERS = ['document_id', 'title', 'author', 'source', 'added_at']
const DOC_CONTENT_CANDIDATES = ['content.md', 'full.md', 'index.md']

export async function loadDocuments(force = false): Promise<DocEntry[]> {
  return readCsvFile(
    DOCS_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      return rows
        .slice(1)
        .map((r) => ({
          documentId: (r[0] || '').trim(),
          title: (r[1] || '').trim(),
          author: (r[2] || '').trim(),
          source: (r[3] || '').trim(),
          addedAt: parseInt(r[4] || '0', 10),
        }))
        .filter((e) => e.documentId)
    },
    force,
  )
}

export async function saveDocuments(entries: DocEntry[]): Promise<void> {
  await writeCsvFile(
    DOCS_PATH,
    entries,
    DOC_HEADERS,
    (e) => [e.documentId, e.title, e.author, e.source, String(e.addedAt)],
  )
}

/** 一次性拉全仓库树，取出 documents/ 下的文件路径 */
async function fetchDocumentPaths(): Promise<Set<string> | null> {
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
      if (entry.type === 'blob' && entry.path.startsWith(`${DOCS_DIR}/`)) {
        paths.add(entry.path)
      }
    }
    return paths
  } catch {
    return null
  }
}

/** 列出其他文档：索引表 + documents/ 下的目录，两边取并集 */
export async function listDocuments(): Promise<DocumentSummary[]> {
  const [entries, paths] = await Promise.all([loadDocuments(), fetchDocumentPaths()])
  const hasContent = (id: string) =>
    paths ? DOC_CONTENT_CANDIDATES.some((n) => paths.has(`${DOCS_DIR}/${id}/${n}`)) : false

  const byId = new Map<string, DocumentSummary>()
  for (const e of entries) {
    byId.set(e.documentId, {
      id: e.documentId,
      title: e.title || e.documentId,
      author: e.author,
      hasContent: hasContent(e.documentId),
    })
  }
  // 索引里没有的目录（写正文成功但索引没写上）也要列出来，别让文件变成孤儿
  for (const path of paths ?? []) {
    const rest = path.slice(DOCS_DIR.length + 1)
    const slash = rest.indexOf('/')
    if (slash <= 0) continue
    const id = rest.slice(0, slash)
    if (byId.has(id)) continue
    byId.set(id, { id, title: id, author: '', hasContent: hasContent(id) })
  }

  const order = new Map(entries.map((e) => [e.documentId, e.addedAt]))
  return [...byId.values()].sort((a, b) => {
    const d = (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0)
    return d !== 0 ? d : a.title.localeCompare(b.title, 'zh')
  })
}

/** 读取正文；没有正文时返回空串（阅读页据此显示「暂无内容」） */
export async function loadDocumentContent(documentId: string, force = false): Promise<string> {
  for (const name of DOC_CONTENT_CANDIDATES) {
    const result = await readMdFile(`${DOCS_DIR}/${documentId}/${name}`, force)
    if (result?.content?.trim()) return result.content
  }
  return ''
}

/** 标题 → 目录名。保留中文，只清掉路径非法字符 */
export function documentSlug(title: string): string {
  const s = title
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 60)
    .trim()
  return s || 'untitled'
}

/** 文件名 → 标题（去掉目录与扩展名） */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split('/').pop() || fileName
  return base.replace(/\.(md|markdown|txt)$/i, '').trim() || base
}

export interface ImportItem {
  title: string
  author?: string
  source?: string
  content: string
}

/**
 * 批量导入 markdown。
 *
 * 正文用 writeFileBatch 一次性提交（zip 里几十个文件也只产生一个 commit），
 * 之后再更新索引表 —— 顺序不能反：先写正文，万一索引失败还能靠目录兜底显示；
 * 反过来就会出现「有记录没正文」的空壳。
 */
export async function importMarkdownDocs(items: ImportItem[]): Promise<DocumentSummary[]> {
  const usable = items.filter((it) => it.content.trim())
  if (usable.length === 0) return []

  const ctx = getRepoContext()
  if (!ctx) throw new Error('工作区未就绪，无法写入仓库')

  const existing = await loadDocuments()
  const used = new Set(existing.map((e) => e.documentId))
  const ops: BatchFileOp[] = []
  const added: DocEntry[] = []
  const now = Date.now()

  for (const it of usable) {
    const base = documentSlug(it.title)
    let id = base
    let n = 2
    while (used.has(id)) id = `${base}-${n++}`
    used.add(id)
    ops.push({
      path: `${DOCS_DIR}/${id}/content.md`,
      content: it.content.trim() + '\n',
      encoding: 'utf-8',
    })
    added.push({
      documentId: id,
      title: it.title.trim() || id,
      author: it.author?.trim() ?? '',
      source: it.source?.trim() ?? '',
      addedAt: now,
    })
  }

  await writeFileBatch(ops, `Import ${ops.length} document(s)`, ctx.owner, ctx.repo, ctx.token)
  await saveDocuments([...added, ...existing])

  return added.map((e) => ({
    id: e.documentId,
    title: e.title,
    author: e.author,
    hasContent: true,
  }))
}

/** 重命名 / 改作者：只动索引表，不搬目录（目录名是主键，搬了要连带搬笔记批注） */
export async function updateDocumentEntry(
  documentId: string,
  patch: Partial<Pick<DocEntry, 'title' | 'author'>>,
): Promise<void> {
  const entries = await loadDocuments(true)
  await saveDocuments(entries.map((e) => (e.documentId === documentId ? { ...e, ...patch } : e)))
}

/**
 * 列出某个文档目录下**真实存在**的文件。
 *
 * 必须列真实的：Tree API 删除用的是 `sha: null`，路径在 base tree 里不存在时
 * GitHub 直接回 422 `GitRPC::BadObjectState`，整个删除都会失败
 * （之前硬编码 content.md/full.md/notes.md…7 个候选路径，文档通常只有 content.md，
 *  于是「删除」永远删不掉，还会把写队列卡在 5 分钟重试里）。
 */
async function listDocumentFiles(id: string): Promise<string[]> {
  const ctx = getRepoContext()
  if (!ctx) return []
  const dirPath = `${DOCS_DIR}/${id}`
  const res = await githubFetch(
    `/repos/${ctx.owner}/${ctx.repo}/git/trees/main?recursive=1`,
    ctx.token,
  )
  if (!res.ok) return []
  try {
    const data = (await res.json()) as { tree?: Array<{ path: string; type: string }> }
    return (data.tree ?? [])
      .filter((e) => e.type === 'blob' && e.path.startsWith(`${dirPath}/`))
      .map((e) => e.path)
  } catch {
    return []
  }
}

/** 删除：连同目录一起删（正文 + 笔记 + 批注 + 对话 + 进度） */
export async function deleteDocuments(documentIds: string[]): Promise<void> {
  const ctx = getRepoContext()
  if (!ctx) throw new Error('工作区未就绪，无法写入仓库')

  const entries = await loadDocuments(true)
  const keep = entries.filter((e) => !documentIds.includes(e.documentId))
  if (keep.length !== entries.length) await saveDocuments(keep)

  const paths: string[] = []
  for (const id of documentIds) paths.push(...(await listDocumentFiles(id)))
  if (paths.length === 0) return
  await deleteRepoFiles(paths, `Delete documents (${documentIds.length})`, ctx.owner, ctx.repo, ctx.token)
}

/** 从 zip 里取出所有 markdown / 纯文本条目 */
export async function readMarkdownZip(
  file: File | Blob,
): Promise<{ name: string; content: string }[]> {
  const zip = await JSZip.loadAsync(file)
  const out: { name: string; content: string }[] = []
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue
    if (!/\.(md|markdown|txt)$/i.test(entry.name)) continue
    // macOS 打包产物与隐藏文件不要
    if (entry.name.startsWith('__MACOSX/')) continue
    if (entry.name.split('/').some((seg) => seg.startsWith('.'))) continue
    out.push({ name: entry.name, content: await entry.async('string') })
  }
  return out
}
