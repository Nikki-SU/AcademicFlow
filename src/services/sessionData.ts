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
import { githubFetch, listRepoFilesInDir, deleteRepoFiles } from './github'
import { uploadEditorImage } from './editorImages'
import { dispatchSessionImages, pollSessionImagesProgress } from './workflowClient'

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

/** 单行化：md 列表项里不能带换行，否则一条记录会被劈成多条 */
function oneLine(s: string): string {
  return s.replace(/\s*\n+\s*/g, ' ').trim()
}

export function formatTranscript(segments: TranscriptSegment[]): string {
  const lines: string[] = ['# 会议/课程转写', '']
  for (const seg of segments) {
    // 原文自成一个块（列表项）；译文另起一个块（引用块），不做原文的子项。
    lines.push(`- [${formatClock(seg.at)}]（${seg.language || 'unknown'}）${oneLine(seg.text)}`)
    if (seg.translation.trim()) {
      // 空行 + 两空格缩进：译文块仍属于该条记录，但渲染上是独立的一段（左侧竖线），
      // 与文献页「一块原文一块译文」一致。
      lines.push('')
      lines.push(`  > 译文：${oneLine(seg.translation)}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * 把本轮转写落私库，返回写入的仓库路径。
 * 写失败会 throw（由调用方 toast，不静默）。
 */
export async function saveTranscript(
  taskId: string,
  sessionId: string,
  segments: TranscriptSegment[],
): Promise<string> {
  const path = `${sessionDir(taskId, sessionId)}/transcript.md`
  let content = formatTranscript(segments)
  // 同一课时可能录了不止一段（中途停了又开录）：追加，别把上一段覆盖掉。
  // 追加时去掉新内容自带的标题行，避免标题重复。
  try {
    const existing = await readMdFile(path)
    if (existing?.content?.trim()) {
      const body = content.replace(/^# .*\n+/, '')
      content = `${existing.content.trimEnd()}\n\n${body}`
    }
  } catch {
    /* 读不到（首次）→ 直接写 */
  }
  await writeMdFile(path, content, 'Add session transcript')
  return path
}

/**
 * 读取某任务「最近一次会话」的 transcript.md。
 * 会话目录不存在 / 读不到一律返回 null（空状态），不抛错、不弹窗。
 * 会话目录名是毫秒时间戳，取数值最大的那个即最近一次。
 */
export async function loadLatestTranscript(
  taskId: string,
): Promise<{ sessionId: string; content: string } | null> {
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
    return { sessionId: latest, content: doc.content }
  } catch (err) {
    console.warn('[sessionData] 读取最近一次会话失败:', err)
    return null
  }
}
