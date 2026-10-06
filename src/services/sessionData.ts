/**
 * 会议/课程会话数据（转写 + 采集图片落私库）
 * -------------------------------------------------
 * 目录约定（挂在**当前任务分支**下，见 架构.md ADJ-45 / ADJ-48）：
 *   projects/{taskId}/sessions/{sessionId}/transcript.md
 *       录音转写（md：标题 + 每条 `- [HH:MM:SS]（语种）原文`，
 *       有译文则空一行后接一条独立块 `  > 译文：…` —— 原文与译文各自成块，
 *       像文献页那样「一块原文一块译文」，不把译文塞成原文的子项）
 *   projects/{taskId}/sessions/{sessionId}/images/
 *       本节课采集的照片（二进制，走 github 二进制上传）
 *   projects/{taskId}/sessions/{sessionId}/board.md
 *       本节课所有照片经 MinerU 识别后合并成的**一份** md（后台 workflow 产出）
 *
 * 一节课 = 一个 transcript.md + 一个 board.md，两者同属一个 sessionId。
 * 音频**不进私库**：音频只在内存里转写，用完即弃；这里只落文本与图片。
 */
import { readMdFile, writeMdFile, getRepoContext } from './userData'
import { githubFetch, listRepoFilesInDir, deleteRepoFiles, writeFileBatch } from './github'
import { uploadEditorImage } from './editorImages'
import { dispatchSessionImages, pollSessionImagesProgress } from './workflowClient'
import { serializeBlocks, readDocument, type Item, type BlockNode } from './blocks.mjs'
import type { TranscriptBlock } from './asr'

/** 一条转写片段（与 stores/recorder.ts 的 segment 同构） */
export interface TranscriptSegment {
  id: string
  /** 片段生成时刻（Unix ms） */
  at: number
  text: string
  language: string
  /** 译文；空串 = 无译文 */
  translation: string
}

/**
 * 采集图片变更广播：悬浮采集球传图后派发、会议页右栏监听并重载，
 * 让「球」和「页」两处看到的图片列表始终一致。
 * detail 带 { taskId, sessionId } —— 监听方只在与自己当前课时一致时才重载。
 */
export const SESSION_IMAGES_CHANGED = 'af:session-images-changed'

/** 会话目录：projects/{taskId}/sessions/{sessionId} */
export function sessionDir(taskId: string, sessionId: string): string {
  return `projects/${taskId}/sessions/${sessionId}`
}

/** 会话照片目录：projects/{taskId}/sessions/{sessionId}/images */
export function sessionImagesDir(taskId: string, sessionId: string): string {
  return `${sessionDir(taskId, sessionId)}/images`
}

/** 会话照片识别结果：projects/{taskId}/sessions/{sessionId}/board.md */
export function sessionBoardPath(taskId: string, sessionId: string): string {
  return `${sessionDir(taskId, sessionId)}/board.md`
}

/** 一张采集图片（listRepoFilesInDir 的最小信息） */
export interface SessionImageFile {
  name: string
  path: string
  size: number
}

/**
 * 列出某课时采集的照片。目录不存在 / 未登录时返回空数组（空状态），不报错。
 * 只认图片扩展名 —— 目录里若混入了别的文件（异常数据）不展示。
 */
export async function listSessionImages(
  taskId: string,
  sessionId: string,
): Promise<SessionImageFile[]> {
  const ctx = getRepoContext()
  if (!ctx) return []
  const files = await listRepoFilesInDir(ctx.owner, ctx.repo, sessionImagesDir(taskId, sessionId), ctx.token)
  return files
    .filter((f) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 上传一张照片到**某课时**的 images/，返回它写进仓库的路径。
 * 走 uploadEditorImage（同一套命名 / 去重 / 二进制上传）。
 */
export async function uploadSessionImage(
  taskId: string,
  sessionId: string,
  file: File,
): Promise<string> {
  return uploadEditorImage({
    // docPath 只用来推导图片目录：.../sessions/{sessionId}/session.md → 同级 images/
    docPath: `${sessionDir(taskId, sessionId)}/session.md`,
    file,
    fileName: file.name,
    sub: 'images',
  })
}

/**
 * 上传任意课程材料（PDF / PPT / Word 等）到某课时的 materials/，返回仓库路径。
 * 走 writeFileBatch 二进制写入，保留原始文件名（避免图片命名规范化逻辑干扰）。
 */
export async function uploadSessionMaterial(
  taskId: string,
  sessionId: string,
  file: File,
): Promise<string> {
  const ctx = getRepoContext()
  if (!ctx) throw new Error('未登录或工作区未就绪')
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  const safeName = file.name.replace(/[/\\]+/g, '_')
  const path = `${sessionDir(taskId, sessionId)}/materials/${Date.now()}_${safeName}`
  await writeFileBatch(
    [{ path, content: btoa(bin), encoding: 'base64' }],
    'Add session course material',
    ctx.owner,
    ctx.repo,
    ctx.token,
  )
  return path
}

/** 列出某课时的课程材料（materials/ 下非图片文件）；目录不存在返回空数组 */
export async function listSessionMaterials(
  taskId: string,
  sessionId: string,
): Promise<SessionImageFile[]> {
  const ctx = getRepoContext()
  if (!ctx) return []
  const files = await listRepoFilesInDir(
    ctx.owner,
    ctx.repo,
    `${sessionDir(taskId, sessionId)}/materials`,
    ctx.token,
  )
  return files
    .filter((f) => !/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 读取某课时的照片识别结果 board.md；没有 / 读不到返回 null（空状态），不抛 */
export async function readSessionBoard(
  taskId: string,
  sessionId: string,
): Promise<string | null> {
  try {
    const doc = await readMdFile(sessionBoardPath(taskId, sessionId))
    return doc?.content ?? null
  } catch {
    return null
  }
}

/** 覆盖写入某课时的照片识别结果 board.md（用户手动编辑后落库）；写失败 throw */
export async function saveSessionBoard(
  taskId: string,
  sessionId: string,
  md: string,
): Promise<void> {
  await writeMdFile(sessionBoardPath(taskId, sessionId), md, 'Save session board')
}

/** 逐张删除采集图片（走 Tree API 批量删除）。失败会 throw，由调用方 toast，不静默。 */
export async function deleteTaskImages(paths: string[]): Promise<void> {
  const ctx = getRepoContext()
  if (!ctx) throw new Error('未登录或工作区未就绪，图片无法删除')
  await deleteRepoFiles(paths, 'Delete session images', ctx.owner, ctx.repo, ctx.token)
}

/** 广播「本节课照片变了」；带 { taskId, sessionId }，监听方只在课时一致时重载 */
export function notifySessionImagesChanged(taskId: string, sessionId: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(SESSION_IMAGES_CHANGED, { detail: { taskId, sessionId } }),
  )
}

/**
 * 触发并等待「本节课照片 → MinerU → board.md」。
 *
 * 先 dispatch（后端从私库读 images/，逐张识别后合并成一份 board.md），
 * 再轮询 .progress.json 跟踪进度。**完成判据是产物 board.md 出现**，不能只盯
 * `stage === 'done'` 这一帧 —— 后端写完 board 会立刻把进度文件删掉，很容易错过。
 * 失败 / 超时一律 throw，由上层 toast，不静默。
 */
export async function recognizeSessionImages(
  taskId: string,
  sessionId: string,
  onProgress?: (message: string) => void,
): Promise<void> {
  const ctx = getRepoContext()
  if (!ctx) throw new Error('未登录或工作区未就绪，无法识别照片')
  await dispatchSessionImages(taskId, sessionId, ctx.owner, ctx.repo, ctx.token)

  const POLL_MS = 5000
  const MAX_ROUNDS = 240 // 5s × 240 = 20 分钟上限
  let sawRunning = false
  for (let i = 0; i < MAX_ROUNDS; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const p = await pollSessionImagesProgress(taskId, sessionId, ctx.owner, ctx.repo, ctx.token)
    if (p) {
      if (p.message) onProgress?.(p.message)
      if (p.stage === 'failed') throw new Error(p.error || p.message || '照片识别失败')
      if (p.stage === 'done') {
        if (await readSessionBoard(taskId, sessionId)) return
      } else {
        sawRunning = true
      }
    } else if (sawRunning) {
      // 进度文件被后端清掉 = 这一轮跑完了；读产物，读到即成功
      if (await readSessionBoard(taskId, sessionId)) return
    }
  }
  throw new Error('照片识别超时，请稍后在「管理」页查看进度')
}

/** Unix ms → 本地 HH:MM:SS */
function formatClock(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 秒级时刻（同一天内单调）：把新片段按时间插回已有转写的依据 */
function clockOf(at: number): number {
  const d = new Date(at)
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()
}

/** 单行化：md 列表项里不能带换行，否则一条记录会被劈成多条 */
function oneLine(s: string): string {
  return s.replace(/\s*\n+\s*/g, ' ').trim()
}

/** 单条片段 → md 块（列表项 + 可选的独立译文块）及其秒级时刻 */
function segmentBlock(seg: TranscriptSegment): { clock: number; lines: string[] } {
  // 原文自成一个块（列表项）；译文另起一个块（引用块），不做原文的子项。
  const lines = [`- [${formatClock(seg.at)}]（${seg.language || 'unknown'}）${oneLine(seg.text)}`]
  if (seg.translation.trim()) {
    // 空行 + 两空格缩进：译文块仍属于该条记录，但渲染上是独立的一段（左侧竖线），
    // 与文献页「一块原文一块译文」一致。
    lines.push('')
    lines.push(`  > 译文：${oneLine(seg.translation)}`)
  }
  return { clock: clockOf(seg.at), lines }
}

export function formatTranscript(segments: TranscriptSegment[]): string {
  const lines: string[] = ['# 会议/课程转写', '']
  for (const seg of segments) lines.push(...segmentBlock(seg).lines)
  lines.push('')
  return lines.join('\n')
}

/** 去掉数组末尾的空行（用于块/头部的规范化） */
function trimTrailingBlank(lines: string[]): void {
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
}

const BLOCK_START = /^- \[(\d{2}):(\d{2}):(\d{2})\]/

/** 把已有 transcript.md 拆成「头部 + 每条记录块（含秒级时刻）」，供按时间归并 */
function parseTranscript(content: string): {
  header: string[]
  blocks: { clock: number; lines: string[] }[]
} {
  const header: string[] = []
  const blocks: { clock: number; lines: string[] }[] = []
  let cur: { clock: number; lines: string[] } | null = null
  for (const line of content.split('\n')) {
    const m = BLOCK_START.exec(line)
    if (m) {
      if (cur) {
        trimTrailingBlank(cur.lines)
        blocks.push(cur)
      }
      cur = { clock: +m[1] * 3600 + +m[2] * 60 + +m[3], lines: [line] }
    } else if (cur) {
      cur.lines.push(line)
    } else {
      header.push(line)
    }
  }
  if (cur) {
    trimTrailingBlank(cur.lines)
    blocks.push(cur)
  }
  trimTrailingBlank(header)
  return { header, blocks }
}

/**
 * 把新片段**按时刻归并**进已有转写 —— 这是「严格顺序」的保证：
 * 补回来的早片会插到正确位置，绝不追加到末尾。
 * 已存在的同一条（同一秒 + 同一行正文）会被跳过，避免重试补写时重复。
 *
 * ⚠️ 归并依据是「当天的秒级时刻」；同一节课跨午夜录制（极罕见）会顺序错乱。
 */
function mergeTranscript(existing: string, incoming: TranscriptSegment[]): string {
  const { header, blocks } = parseTranscript(existing)
  const seen = new Set(blocks.map((b) => `${b.clock}|${b.lines[0]}`))
  const merged = blocks.slice()
  for (const seg of incoming) {
    const b = segmentBlock(seg)
    const key = `${b.clock}|${b.lines[0]}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(b)
  }
  merged.sort((a, b) => a.clock - b.clock)

  const out = header.length > 0 ? header.slice() : ['# 会议/课程转写']
  out.push('')
  for (const b of merged) out.push(...b.lines)
  out.push('')
  return out.join('\n')
}

/**
 * 把本轮转写落私库，返回写入的仓库路径。
 * 同一课时可能录了不止一段、也可能有失败重试补回来的片段 —— 一律**按时刻归并**，
 * 保证 transcript.md 严格时序（不是简单追加）。
 * 写失败会 throw（由调用方 toast，不静默）。
 */
export async function saveTranscript(
  taskId: string,
  sessionId: string,
  segments: TranscriptSegment[],
): Promise<string> {
  const path = `${sessionDir(taskId, sessionId)}/transcript.md`
  let existing: string | null = null
  try {
    const doc = await readMdFile(path)
    if (doc?.content?.trim()) existing = doc.content
  } catch {
    /* 读不到（首次）→ 直接写 */
  }
  const content = existing ? mergeTranscript(existing, segments) : formatTranscript(segments)
  await writeMdFile(path, content, 'Add session transcript')
  return path
}

/** 转写稿（AI 修饰后）路径：projects/{taskId}/sessions/{sessionId}/polished.md */
export function sessionPolishedPath(taskId: string, sessionId: string): string {
  return `${sessionDir(taskId, sessionId)}/polished.md`
}

/**
 * 用户手动编辑原始转写（transcript.md）后整体覆盖写回。
 * 与 saveTranscript 不同：不按时刻归并，直接以编辑后的 md 为准。
 * 写失败 throw，由调用方 toast。
 */
export async function saveTranscriptRaw(
  taskId: string,
  sessionId: string,
  md: string,
): Promise<void> {
  await writeMdFile(`${sessionDir(taskId, sessionId)}/transcript.md`, md, 'Save session transcript')
}

/**
 * 从原始 transcript.md 里抽出「讲者原话」纯文本，作为 AI 修饰的输入。
 * 只取 `- [HH:MM:SS]（语种）正文` 这类行；译文行（`  > 译文：…`）与标题不参与。
 */
export function extractTranscriptText(md: string): string {
  const out: string[] = []
  for (const line of md.split('\n')) {
    const m = /^- \[\d{2}:\d{2}:\d{2}\]（[^）]*）(.*)$/.exec(line)
    if (m && m[1].trim()) out.push(m[1].trim())
  }
  return out.join('\n')
}

/** 段落块 → 块文档 md（正文用「正文」块，存疑段用「存疑」块，英文段附 `译文@N` 块） */
function blocksToMd(blocks: TranscriptBlock[]): string {
  const items: Item[] = []
  blocks.forEach((b, i) => {
    const n = i + 1
    const node: BlockNode = b.unclear
      ? { kind: 'flow', type: '存疑', level: 0, n }
      : { kind: 'flow', type: '正文', level: 0, n }
    items.push({ t: 'block', node, content: b.text })
    if (b.translation.trim()) {
      items.push({
        t: 'block',
        node: { kind: 'translation', ref: String(n) },
        content: b.translation,
      })
    }
  })
  return serializeBlocks(items) + '\n'
}

/** 块文档 md → 段落块（读回时译文已合并进对应源块的 cn） */
function mdToBlocks(md: string): TranscriptBlock[] {
  const { items } = readDocument(md)
  const out: TranscriptBlock[] = []
  for (const it of items) {
    if (it.t !== 'block' || it.node.kind !== 'flow') continue
    out.push({
      text: it.content,
      translation: it.cn ?? '',
      unclear: it.node.type === '存疑',
    })
  }
  return out
}

/** 读取某课时的 AI 修饰转写稿；没有 / 读不到返回 null（空状态），不抛 */
export async function readPolishedTranscript(
  taskId: string,
  sessionId: string,
): Promise<TranscriptBlock[] | null> {
  try {
    const doc = await readMdFile(sessionPolishedPath(taskId, sessionId))
    if (!doc?.content?.trim()) return null
    const blocks = mdToBlocks(doc.content)
    return blocks.length > 0 ? blocks : null
  } catch {
    return null
  }
}

/** 写入某课时的 AI 修饰转写稿（覆盖）；写失败会 throw，由调用方 toast */
export async function savePolishedTranscript(
  taskId: string,
  sessionId: string,
  blocks: TranscriptBlock[],
): Promise<void> {
  await writeMdFile(
    sessionPolishedPath(taskId, sessionId),
    blocksToMd(blocks),
    'Save polished session transcript',
  )
}

/** 删除某课时的修饰转写稿（重新修饰前先清掉旧稿）；文件不存在不算失败 */
export async function deletePolishedTranscript(taskId: string, sessionId: string): Promise<void> {
  const ctx = getRepoContext()
  if (!ctx) return
  try {
    await deleteRepoFiles(
      [sessionPolishedPath(taskId, sessionId)],
      'Drop stale polished transcript',
      ctx.owner,
      ctx.repo,
      ctx.token,
    )
  } catch {
    // 文件本就不存在等：忽略
  }
}

/**
 * 读取某任务「最近一次会话」的原始转写 + 已修饰转写稿。
 * 会话目录不存在 / 读不到一律返回 null（空状态），不抛错、不弹窗。
 * 会话目录名是毫秒时间戳，取数值最大的那个即最近一次。
 */
export async function loadLatestTranscript(
  taskId: string,
): Promise<{ sessionId: string; content: string; blocks: TranscriptBlock[] | null } | null> {
  const ctx = getRepoContext()
  if (!ctx) return null
  try {
    const sessionsDir = `projects/${taskId}/sessions`
    const res = await githubFetch(
      `/repos/${ctx.owner}/${ctx.repo}/contents/${encodeURI(sessionsDir)}`,
      ctx.token,
    )
    if (!res.ok) return null
    const data = await res.json()
    if (!Array.isArray(data)) return null
    const latest = (data as Array<{ type: string; name: string }>)
      .filter((e) => e.type === 'dir' && /^\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => Number(b) - Number(a))[0]
    if (!latest) return null
    const doc = await readMdFile(`${sessionDir(taskId, latest)}/transcript.md`)
    if (!doc?.content) return null
    const blocks = await readPolishedTranscript(taskId, latest)
    return { sessionId: latest, content: doc.content, blocks }
  } catch (err) {
    console.warn('[sessionData] 读取最近一次会话失败:', err)
    return null
  }
}
