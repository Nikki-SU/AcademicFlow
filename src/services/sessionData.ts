/**
 * 会议/课程会话数据（转写 + 采集图片落私库）
 * -------------------------------------------------
 * 目录约定（挂在**当前任务分支**下，见 架构.md ADJ-45 / ADJ-48）：
 *   projects/{taskId}/sessions/{sessionId}/transcript.md
 *       转写文本（md：标题 + 每条 `- [HH:MM:SS]（语种）原文`，有译文则下一行 `  - 译文：…`）
 *   projects/{taskId}/session-images/
 *       本任务「传图片」采集的图片（二进制，走 github 二进制上传）。
 *       与手稿图片（projects/{taskId}/images/）分开放，免得写论文的插图跟会议材料混在一起。
 *
 * 音频**不进私库**：音频只在内存里转写，用完即弃；这里只落文本与图片。
 */
import { readMdFile, writeMdFile, getRepoContext } from './userData'
import { githubFetch, listRepoFilesInDir, deleteRepoFiles } from './github'
import { uploadEditorImage } from './editorImages'

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
 */
export const SESSION_IMAGES_CHANGED = 'af:session-images-changed'

/** 会话目录：projects/{taskId}/sessions/{sessionId} */
export function sessionDir(taskId: string, sessionId: string): string {
  return `projects/${taskId}/sessions/${sessionId}`
}

/** 任务采集图片目录：projects/{taskId}/session-images */
export function taskImageDir(taskId: string): string {
  return `projects/${taskId}/session-images`
}

/** 一张采集图片（listRepoFilesInDir 的最小信息） */
export interface SessionImageFile {
  name: string
  path: string
  size: number
}

/**
 * 列出当前任务采集的图片。目录不存在 / 未登录时返回空数组（空状态），不报错。
 * 只认图片扩展名 —— 目录里若混入了别的文件（异常数据）不展示。
 */
export async function listTaskImages(taskId: string): Promise<SessionImageFile[]> {
  const ctx = getRepoContext()
  if (!ctx) return []
  const files = await listRepoFilesInDir(ctx.owner, ctx.repo, taskImageDir(taskId), ctx.token)
  return files
    .filter((f) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 上传一张采集图片，返回它写进仓库的路径。
 * 走 uploadEditorImage（同一套命名 / 去重 / 二进制上传），落到 session-images 子目录。
 */
export async function uploadTaskImage(taskId: string, file: File): Promise<string> {
  return uploadEditorImage({
    // docPath 只用来推导图片目录：projects/{taskId}/session.md → projects/{taskId}/session-images
    docPath: `projects/${taskId}/session.md`,
    file,
    fileName: file.name,
    sub: 'session-images',
  })
}

/** 逐张删除采集图片（走 Tree API 批量删除）。失败会 throw，由调用方 toast，不静默。 */
export async function deleteTaskImages(paths: string[]): Promise<void> {
  const ctx = getRepoContext()
  if (!ctx) throw new Error('未登录或工作区未就绪，图片无法删除')
  await deleteRepoFiles(paths, 'Delete session images', ctx.owner, ctx.repo, ctx.token)
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
    lines.push(`- [${formatClock(seg.at)}]（${seg.language || 'unknown'}）${oneLine(seg.text)}`)
    if (seg.translation.trim()) {
      lines.push(`  - 译文：${oneLine(seg.translation)}`)
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
  await writeMdFile(path, formatTranscript(segments), 'Add session transcript')
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
