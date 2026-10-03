/**
 * 阅读对象（文献 / 图书 / 其他文档）的统一标识与存储路径
 * -------------------------------------------------
 * 阅读页同时支持三种对象，它们只在 pipeline 上有区别，阅读侧的数据结构完全对称：
 *   文献 paper    → literatures/{doi-slug}/
 *   图书 book     → textbooks/{书名}/
 *   其他文档 document → documents/{目录名}/
 *
 * 每个对象目录下：
 *   notes/{名称}.md                 笔记（一篇文档可以有多个命名笔记）
 *   notes/images/                   笔记里的图片
 *   annotations/annotations.csv     批注
 *   ai-chat.md                      问 AI 的对话记录（一本书 / 一篇文献一个大对话）
 *   reading-progress.json           阅读进度（读到哪个标题）
 *
 * 所有阅读侧服务都通过 DocRef + 本模块的 path helper 定位文件，
 * 不再各自硬编码 literatures/ 前缀。
 */

import JSZip from 'jszip'
import { readMdFile, writeMdFile, getRepoContext, invalidateCache } from './userData'
import { githubFetch, deleteRepoFiles, writeFileBatch } from './github'
import { doiToSlug } from './literatureData'

export type DocKind = 'paper' | 'book' | 'document'

export interface DocRef {
  kind: DocKind
  /** paper = DOI；book = 书名；document = documents/ 下的目录名 */
  id: string
}

/** 对象在仓库里的根目录（不带尾斜杠） */
export function docBasePath(ref: DocRef): string {
  if (ref.kind === 'book') return `textbooks/${ref.id}`
  if (ref.kind === 'document') return `documents/${ref.id}`
  return `literatures/${doiToSlug(ref.id)}`
}

export function notesDir(ref: DocRef): string {
  return `${docBasePath(ref)}/notes`
}

/** 问 AI 对话记录（整篇一个大对话） */
export function chatPath(ref: DocRef): string {
  return `${docBasePath(ref)}/ai-chat.md`
}

/** 阅读进度（读到哪个标题，下次打开跳回去） */
export function progressPath(ref: DocRef): string {
  return `${docBasePath(ref)}/reading-progress.json`
}

/** 笔记内图片的子目录名（相对笔记目录）；全站一份，改这里三处一起变 */
export const NOTE_IMAGE_SUBDIR = 'images'

/** 笔记图片目录（仓库路径，不带尾斜杠）：{笔记目录}/images */
export function noteImageDir(ref: DocRef): string {
  return `${notesDir(ref)}/${NOTE_IMAGE_SUBDIR}`
}

/** 走云端管线的源附件落盘目录（Word / PDF 放这里，与 notes/ 隔离） */
export function attachmentsDir(ref: DocRef): string {
  return `${docBasePath(ref)}/attachments`
}

const WORD_MIME = 'application/msword'

/**
 * 是否属于「必须先转 PDF 再进管线」的附件（Word / PDF）。
 * 这类本地读不出可靠的 markdown（丢标题层级 / 图 / 版式），一律走 note 云端管线：
 *   Word → LibreOffice → PDF → MinerU → markdown；PDF 直通 MinerU。
 */
export function isPipelineAttachment(file: File): boolean {
  const lower = file.name.toLowerCase()
  if (/\.(docx?|pdf)$/.test(lower)) return true
  return (
    file.type === 'application/pdf' ||
    file.type === DOCX_MIME ||
    file.type === WORD_MIME
  )
}

// ============================================================
// 笔记（一篇文档可有多个命名笔记）
// ============================================================
//
// 存储：{docBasePath}/notes/{名称}.md；图片在 {docBasePath}/notes/images/。
// 笔记名即文件名（去掉 .md），因此禁止含路径分隔符等危险字符（sanitizeNoteName）。

/** 单个笔记的 .md 路径 */
export function notePath(ref: DocRef, name: string): string {
  return `${notesDir(ref)}/${name}.md`
}

/** 规整笔记名：去掉路径分隔与 Windows 非法字符；空则回退「未命名」 */
export function sanitizeNoteName(raw: string): string {
  const cleaned = (raw || '')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 60)
  return cleaned || '未命名'
}

/**
 * 全仓库文件路径集合（带短 TTL 缓存）。
 * 笔记列表、以及「其他文档」里的笔记条目都靠它一次拉取。
 * 新建 / 删除 / 重命名笔记后调用 invalidateNoteTree() 让它失效。
 */
let treeCache: { at: number; paths: Set<string> } | null = null
const TREE_TTL = 15_000

async function repoTreePaths(force = false): Promise<Set<string> | null> {
  if (!force && treeCache && Date.now() - treeCache.at < TREE_TTL) return treeCache.paths
  const ctx = getRepoContext()
  if (!ctx) return treeCache?.paths ?? null
  try {
    const res = await githubFetch(
      `/repos/${ctx.owner}/${ctx.repo}/git/trees/main?recursive=1`,
      ctx.token,
    )
    if (!res.ok) return treeCache?.paths ?? null
    const data = (await res.json()) as { tree?: Array<{ path: string; type: string }> }
    const paths = new Set<string>()
    for (const e of data.tree ?? []) if (e.type === 'blob') paths.add(e.path)
    treeCache = { at: Date.now(), paths }
    return paths
  } catch {
    return treeCache?.paths ?? null
  }
}

/** 让文件树缓存立即失效（笔记结构发生增删改后调用） */
export function invalidateNoteTree() {
  treeCache = null
}

/** 列出一个文档的全部笔记名（notes/ 根下的 .md；images/ 等子目录不算） */
export async function listNotes(ref: DocRef): Promise<string[]> {
  const paths = await repoTreePaths()
  if (!paths) return []
  const prefix = `${notesDir(ref)}/`
  const names: string[] = []
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue
    const rest = p.slice(prefix.length)
    if (rest.includes('/')) continue
    if (!/\.md$/i.test(rest)) continue
    names.push(rest.slice(0, -3))
  }
  return names.sort((a, b) => a.localeCompare(b, 'zh'))
}

/**
 * 判断某篇笔记的产物（.md）是否已生成 —— 供 note_convert 任务完成时兜底。
 *
 * 为什么需要：后端跑完先写 `.progress.json {stage:done}` 再**立即删掉**，
 * 5s 一次的前端轮询基本抓不到那个 done；一旦任务连 run id 都没存住，前端就会
 * 永远停在最后一帧。所以直接看产物在不在 —— 在 = 转换确实完成了。
 *
 * 返回值：true 有产物；false 没有；null = 仓库树没拉到（网络/权限问题，别据此判定）。
 */
export async function noteHasContent(basePath: string, noteName: string): Promise<boolean | null> {
  const paths = await repoTreePaths(true)
  if (!paths) return null
  return paths.has(`${basePath}/notes/${noteName}.md`)
}

export async function loadNote(ref: DocRef, name: string): Promise<string> {
  const result = await readMdFile(notePath(ref, name))
  return result?.content || ''
}

export async function saveNote(ref: DocRef, name: string, content: string): Promise<void> {
  await writeMdFile(notePath(ref, name), content, `Update note ${name}`)
}

export async function createNote(ref: DocRef, name: string, content = ''): Promise<void> {
  await writeMdFile(notePath(ref, name), content, `Create note ${name}`)
  invalidateNoteTree()
}

export async function deleteNote(ref: DocRef, name: string): Promise<void> {
  const ctx = getRepoContext()
  if (!ctx) throw new Error('工作区尚未就绪，无法删除笔记')
  const path = notePath(ref, name)
  await deleteRepoFiles([path], `Delete note ${name}`, ctx.owner, ctx.repo, ctx.token)
  invalidateCache(path)
  invalidateNoteTree()
}

export async function renameNote(ref: DocRef, oldName: string, newName: string): Promise<void> {
  const content = await loadNote(ref, oldName)
  await writeMdFile(notePath(ref, newName), content, `Rename note ${oldName} → ${newName}`)
  const ctx = getRepoContext()
  if (ctx) {
    await deleteRepoFiles(
      [notePath(ref, oldName)],
      `Rename note ${oldName} → ${newName}`,
      ctx.owner,
      ctx.repo,
      ctx.token,
    )
  }
  invalidateCache(notePath(ref, oldName))
  invalidateNoteTree()
}

/**
 * 扫描全仓库，列出所有文档的笔记文件（不带标题，标题由调用方按 parent 反查）。
 * 路径形如 {root}/{parentId}/notes/{名称}.md —— parentId 可能含 `/`（书名/文档名），
 * 所以从右往左解析。
 */
export interface NoteFileRef {
  parentKind: DocKind
  parentId: string
  name: string
}

export async function listAllNoteFiles(): Promise<NoteFileRef[]> {
  const paths = await repoTreePaths()
  if (!paths) return []
  const re = /^(literatures|textbooks|documents)\/(.+)\/notes\/([^/]+)\.md$/i
  const out: NoteFileRef[] = []
  for (const p of paths) {
    const m = re.exec(p)
    if (!m) continue
    out.push({
      parentKind: m[1] === 'literatures' ? 'paper' : m[1] === 'textbooks' ? 'book' : 'document',
      parentId: m[2],
      name: m[3],
    })
  }
  return out
}

/** 笔记所在的那篇文档的 DocRef */
export function noteParentRef(ref: NoteFileRef): DocRef {
  return { kind: ref.parentKind, id: ref.parentId }
}

/** 笔记的唯一标识串（笔记列表选中态、docKey、检索命中都靠它） */
export function noteRefKey(ref: NoteFileRef): string {
  return `note:${ref.parentKind}:${ref.parentId}:${ref.name}`
}

/**
 * NoteFileRef ↔ URL 参数（doc=note:...）。
 * 用 JSON 而不是 `a:b:c` 拼串：书名 / 目录名 / 笔记名都可能含分隔符，
 * 拼串解析会歧义，JSON 不会。
 */
export function encodeNoteFileRef(ref: NoteFileRef): string {
  return JSON.stringify({ parentKind: ref.parentKind, parentId: ref.parentId, name: ref.name })
}

export function decodeNoteFileRef(s: string): NoteFileRef | null {
  try {
    const o = JSON.parse(s) as Partial<NoteFileRef>
    const kinds = ['paper', 'book', 'document']
    if (
      o &&
      typeof o.parentKind === 'string' &&
      kinds.includes(o.parentKind) &&
      typeof o.parentId === 'string' &&
      o.parentId &&
      typeof o.name === 'string' &&
      o.name
    ) {
      return { parentKind: o.parentKind as DocKind, parentId: o.parentId, name: o.name }
    }
  } catch {
    // 非 JSON（旧参数 / 手改的 URL）→ 交给调用方忽略
  }
  return null
}

// ============================================================
// 从附件导入笔记
// ============================================================
//
// 直接可读的附件（本模块负责）：
//   .md / .markdown / .txt   直接当 markdown
//   .zip                     内含 markdown 各成一篇笔记；图片收进 notes/images/；
//                            内含 docx 用 JSZip（zip 内文档，只想要文字，走轻量抽取）
//
// 读不了的附件（Word / PDF）不在这里硬猜，交给 note 云端管线（Word→PDF→MinerU）：
//   .doc / .docx / .pdf      isPipelineAttachment() → enqueueNoteConvert()
//   本地直读只会把 docx 抽成"有字就完事"的降级品——丢标题层级、丢图片、丢版式，
//   与「先约束再容错」相悖，所以一律走管线。
//
// 导入时把图片引用统一改写成**仓库绝对路径**（notes/images/xxx），
// 与编辑器写图落盘的口径一致（VditorEditor 也是写仓库绝对路径）。

export interface NoteImageFile {
  /** 仓库内目标路径（已含 notes/images/） */
  repoPath: string
  blob: Blob
}

export interface ImportedNote {
  name: string
  markdown: string
  images: NoteImageFile[]
}

const NOTE_IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** 文件名（去目录、去扩展名）→ 笔记名 */
function baseNameOf(name: string): string {
  return sanitizeNoteName((name.split('/').pop() || name).replace(/\.[^.]+$/, '').trim())
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** 取一个 w:p / w:tc 内的纯文本（w:t 文本、w:tab / w:br 记空格） */
function docxNodeText(el: Element): string {
  const out: string[] = []
  const walk = (n: Node) => {
    if (n.nodeType !== 1) return
    const e = n as Element
    if (e.nodeName === 'w:t') { out.push(e.textContent ?? ''); return }
    if (e.nodeName === 'w:tab' || e.nodeName === 'w:br') { out.push(' '); return }
    e.childNodes.forEach(walk)
  }
  el.childNodes.forEach(walk)
  return out.join('').replace(/\s+/g, ' ').trim()
}

/** docx → markdown（保留段落顺序与表格的基本结构） */
async function docxToMarkdown(blob: Blob): Promise<string> {
  const zip = await JSZip.loadAsync(blob)
  const xml = await zip.file('word/document.xml')?.async('string')
  if (!xml) throw new Error('不是有效的 .docx（缺少 word/document.xml）')
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const body = doc.getElementsByTagName('w:body')[0]
  const lines: string[] = []
  for (const node of Array.from(body?.children ?? [])) {
    if (node.nodeName === 'w:p') {
      const text = docxNodeText(node)
      if (text) lines.push(text)
    } else if (node.nodeName === 'w:tbl') {
      const rows = Array.from(node.getElementsByTagName('w:tr')).map((tr) =>
        Array.from(tr.getElementsByTagName('w:tc')).map((tc) =>
          docxNodeText(tc).replace(/\|/g, '\\|'),
        ),
      )
      if (rows.length) {
        lines.push('')
        lines.push(`| ${rows[0].join(' | ')} |`)
        lines.push(`| ${rows[0].map(() => '---').join(' | ')} |`)
        for (const r of rows.slice(1)) lines.push(`| ${r.join(' | ')} |`)
        lines.push('')
      }
    }
  }
  return lines.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 规整图片名（去路径、去非法字符），保证落在 notes/images/ 下不冲突 */
function safeImageName(raw: string, used: Set<string>): string {
  const leaf = raw.split('/').pop() || 'image'
  const dot = leaf.lastIndexOf('.')
  const stem = (dot > 0 ? leaf.slice(0, dot) : leaf).replace(/[^\w\u4e00-\u9fa5.-]+/g, '-') || 'image'
  const ext = dot > 0 ? leaf.slice(dot) : '.png'
  let name = `${stem}${ext}`
  let n = 2
  while (used.has(name)) { name = `${stem}-${n}${ext}`; n++ }
  used.add(name)
  return name
}

/**
 * 解析一批上传的附件 → 待写入的笔记（需要 DocRef 以决定图片落盘目录）。
 * 会抛可读错误（不认识的类型 / PDF / 旧 doc），由调用方 toast 出来。
 */
export async function extractNoteAttachmentsFor(
  docRef: DocRef,
  files: File[],
): Promise<ImportedNote[]> {
  const imgDir = noteImageDir(docRef)
  const out: ImportedNote[] = []

  for (const file of files) {
    const lower = file.name.toLowerCase()
    if (/\.(md|markdown|txt)$/.test(lower)) {
      out.push({ name: baseNameOf(file.name), markdown: await file.text(), images: [] })
      continue
    }
    if (/\.zip$/.test(lower) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed') {
      out.push(...(await extractFromZip(file, imgDir)))
      continue
    }
    if (isPipelineAttachment(file)) {
      // 调用方应在进入本函数前把管线附件分流出去。走到这里说明分流漏了，
      // 显式报错，绝不回退成本地直读给一份"看着像结果"的降级品。
      throw new Error(`内部错误：${file.name} 属于管线附件，应交给 enqueueNoteConvert 处理`)
    }
    throw new Error(`不认识的附件类型：${file.name}（可直接读 .md / .txt / .zip；Word / PDF 走转换管线）`)
  }
  return out.filter((n) => n.markdown.trim() || n.images.length > 0)
}

async function extractFromZip(file: File | Blob, imgDir: string): Promise<ImportedNote[]> {
  const zip = await JSZip.loadAsync(file)
  const mds: { path: string; content: string }[] = []
  /** 图片：小写相对路径 → blob（先全部异步读出来，后面的同步 replace 才能直接用） */
  const imageBlobs = new Map<string, Blob>()

  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue
    if (entry.name.startsWith('__MACOSX/')) continue
    if (entry.name.split('/').some((seg) => seg.startsWith('.'))) continue
    if (/\.(md|markdown|txt)$/i.test(entry.name)) {
      mds.push({ path: entry.name, content: await entry.async('string') })
      continue
    }
    if (/\.docx$/i.test(entry.name)) {
      mds.push({ path: entry.name, content: await docxToMarkdown(await entry.async('blob')) })
      continue
    }
    if (NOTE_IMAGE_EXT.test(entry.name)) {
      imageBlobs.set(entry.name.toLowerCase(), await entry.async('blob'))
    }
  }

  const notes: ImportedNote[] = []
  const used = new Set<string>()
  for (const md of mds) {
    const images: NoteImageFile[] = []
    // 把 md 里引用到的图片收进来，并把引用改写成仓库绝对路径
    const markdown = md.content.replace(
      /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g,
      (full, alt: string, href: string, title = '') => {
        const key = decodeURIComponent(href).replace(/^\.\//, '').replace(/^\//, '').toLowerCase()
        const leaf = key.split('/').pop() || key
        // 先按完整相对路径找，再退到按文件名找
        let matched: string | undefined
        let blob: Blob | undefined
        if (imageBlobs.has(key)) {
          matched = key
          blob = imageBlobs.get(key)
        } else {
          for (const [k, b] of imageBlobs) {
            if (k === leaf || k.endsWith(`/${leaf}`)) { matched = k; blob = b; break }
          }
        }
        if (!blob || !matched) return full
        const name = safeImageName(matched, used)
        images.push({ repoPath: `${imgDir}/${name}`, blob })
        return `![${alt}](${imgDir}/${name}${title})`
      },
    )
    notes.push({ name: baseNameOf(md.path), markdown, images })
  }
  return notes
}

/** 把解析出的笔记写入仓库（先传图片，再写 md；顺序保证 md 里的图先就位） */
export async function saveImportedNote(docRef: DocRef, note: ImportedNote): Promise<void> {
  const ctx = getRepoContext()
  if (!ctx) throw new Error('工作区尚未就绪，无法保存笔记')
  if (note.images.length > 0) {
    const ops = await Promise.all(
      note.images.map(async (img) => ({
        path: img.repoPath,
        content: arrayBufferToBase64(await img.blob.arrayBuffer()),
        encoding: 'base64' as const,
      })),
    )
    await writeFileBatch(ops, `Add ${note.images.length} note image(s)`, ctx.owner, ctx.repo, ctx.token)
  }
  await writeMdFile(notePath(docRef, note.name), note.markdown, `Import note ${note.name}`)
  invalidateNoteTree()
}

// ============================================================
// 问 AI 对话记录（整篇一个大对话，md 落盘，人可读可手改）
// ============================================================

export async function loadReadingChat(ref: DocRef): Promise<string> {
  const result = await readMdFile(chatPath(ref))
  return result?.content || ''
}

export async function saveReadingChat(ref: DocRef, content: string): Promise<void> {
  await writeMdFile(chatPath(ref), content, 'Update reading AI chat')
}

// ============================================================
// 阅读进度（读到哪个标题，下次打开跳回去）
// ============================================================

export interface ReadingProgress {
  /** 正文里对应标题的锚点 id（如 book-h-42）；换显示模式会变，只当兜底 */
  anchor: string
  /** 标题文本 —— 锚点 id 每次渲染按顺序生成，文本更耐用，优先按它定位 */
  heading: string
  level: number
  /**
   * 上次用的显示模式（原文 / 全中文 / 全英文 / 中英对照）。
   * 模式也是"读到哪儿"的一部分：同一段话在中文模式下读到第 3 节，切成原文还应该在附近，
   * 而不是被打回默认的"原文"。只有文献有这个概念，图书/其他文档为空。
   */
  mode?: string
  /**
   * 兜底锚点：读到的那个正文块（data-block-id，如 b-42 / en-42 / cn-42）。
   * 很多 MinerU 出来的正文根本没有 h1~h6（小节标题被排成了普通段落），
   * 只记标题的话这种文档永远存不下进度 —— 所以块锚点是真正保底的那一层。
   */
  block?: string
  /**
   * 落盘那一刻，上面那个块的顶边相对**视口顶边**的像素偏移（通常为负，因为块在视口上方）。
   * 只记块号的话，大段读久了会被拉回该段**开头**，段落一长就"跳回上一屏"；
   * 带上偏移才能精确回到当初看到的那一行。
   */
  blockOffset?: number
  /** 再兜底：整篇滚动比例 0~1。连块都找不到了（重排版/换模式）就回到大概位置 */
  ratio?: number
  /** ISO 时间，落盘后可直接看懂是什么时候读的 */
  updated_at: string
}

export async function loadProgress(ref: DocRef): Promise<ReadingProgress | null> {
  // 强制读远端：进度可能是在另一台机器上更新的，本地缓存会把它盖掉
  const result = await readMdFile(progressPath(ref), true)
  if (!result?.content) return null
  try {
    const parsed = JSON.parse(result.content) as ReadingProgress
    // 有任意一种定位信息就算有效：标题 / 标题锚点 / 块锚点 / 滚动比例
    const usable =
      !!(parsed?.heading || parsed?.anchor || parsed?.block) || typeof parsed?.ratio === 'number'
    return usable ? parsed : null
  } catch {
    return null
  }
}

export async function saveProgress(ref: DocRef, progress: ReadingProgress): Promise<void> {
  await writeMdFile(progressPath(ref), JSON.stringify(progress, null, 2), 'Update reading progress')
}
