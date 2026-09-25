/**
 * 编辑器图片
 * ------------------------------------------------------------
 * md 里只存「仓库内路径」，不再内嵌 base64：
 *   - 链接短：一张 2MB 的图从 ~2.7MB 的 data URL 缩到几十个字符
 *   - 复制即用：路径自带仓库根，粘到任何文件都能显示，不需要搬运文件
 *   - Git 友好；LaTeX 编译时按仓库路径挂进虚拟文件系统
 * 显示时才换成 blob URL（走 api.github.com，raw.githubusercontent 墙内不稳）。
 */
import { downloadRepoBinaryFile, uploadRepoBinaryFile } from './github'
import { getRepoContext } from './userData'

/** 图片尺寸写法借 markdown 图片的 title 位：![alt](path "width=60% height=40%") */
export interface ImageSize {
  width?: string
  height?: string
}

/** 由文档路径推出图片目录：projects/p1/manuscript.md → projects/p1/images */
export function imageDirForDoc(docPath: string, sub = 'images'): string {
  const slash = docPath.lastIndexOf('/')
  const dir = slash === -1 ? '' : docPath.slice(0, slash)
  return dir ? `${dir}/${sub}` : sub
}

/** 文档所在目录：projects/p1/manuscript.md → projects/p1 */
export function docDirOf(docPath: string): string {
  const slash = docPath.lastIndexOf('/')
  return slash === -1 ? '' : docPath.slice(0, slash)
}

/** 仓库内路径（既不是 http(s) 也不是 data:）—— 这种才需要我们接管加载 */
export function isRepoImagePath(src: string): boolean {
  return !!src && !/^(https?:|data:|blob:|file:)/i.test(src)
}

/**
 * 从图片的 title 里解析尺寸。
 * 用 title 位而不是 pandoc 的 {width=…}：花括号是编辑器不认的扩展语法，
 * 会原样显示成正文文字；title 是标准 markdown 参数，渲染器天然带在 <img> 上。
 */
export function parseImageSize(title: string | undefined | null): ImageSize | null {
  if (!title) return null
  const width = /\bwidth\s*=\s*([^\s,;]+)/i.exec(title)?.[1]
  const height = /\bheight\s*=\s*([^\s,;]+)/i.exec(title)?.[1]
  if (!width && !height) return null
  return { width, height }
}

/** 生成 title 内容（无尺寸返回空串，图片保持 markdown 原样） */
export function formatImageSize(size: ImageSize): string {
  const parts: string[] = []
  if (size.width) parts.push(`width=${size.width}`)
  if (size.height) parts.push(`height=${size.height}`)
  return parts.join(' ')
}

/** 清理文件名：去掉路径分隔符与危险字符，保留可读性 */
function safeBaseName(name: string): string {
  const noExt = name.replace(/\.[^.]+$/, '')
  const cleaned = noExt.replace(/[^\w\u4e00-\u9fa5.-]+/g, '-').replace(/^-+|-+$/g, '')
  return (cleaned || 'image').slice(0, 40)
}

function extOf(name: string, mime: string): string {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]
  if (fromName) return fromName.toLowerCase()
  const fromMime = /^image\/([a-z0-9.+-]+)$/i.exec(mime)?.[1]
  return (fromMime || 'png').toLowerCase().replace('jpeg', 'jpg')
}

/** 唯一文件名：原名 + 时间戳36 + 随机后缀，避免同目录同名互相覆盖 */
function uniqueImageName(name: string, mime: string): string {
  const stamp = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${safeBaseName(name)}-${stamp}${rand}.${extOf(name, mime)}`
}

/** 上传一张图，返回它写进 md 的仓库路径 */
export async function uploadEditorImage(opts: {
  docPath: string
  file: File | Blob
  fileName: string
  /** 图片子目录，默认为 images */
  sub?: string
  onProgress?: (msg: string) => void
}): Promise<string> {
  const ctx = getRepoContext()
  if (!ctx) throw new Error('未登录或工作区未就绪，图片无法上传')

  const dir = imageDirForDoc(opts.docPath, opts.sub)
  const name = uniqueImageName(opts.fileName, opts.file.type || 'image/png')
  const repoPath = `${dir}/${name}`

  opts.onProgress?.('正在上传图片…')
  await uploadRepoBinaryFile(ctx.owner, ctx.repo, repoPath, opts.file, ctx.token, `Add image ${name}`)
  return repoPath
}

/** 已取回的图片 blob URL 缓存：同一张图在编辑器里反复重渲染时不再重复下载 */
const blobUrlCache = new Map<string, string>()
/** 反查：blob URL → 仓库路径。用于兜住「blob 被序列化回 md」的情况 */
const blobToPath = new Map<string, string>()
const blobInflight = new Map<string, Promise<string | null>>()

/** blob URL 还原回仓库路径；认不出就原样返回 */
export function blobUrlToRepoPath(url: string): string {
  return blobToPath.get(url) ?? url
}

/**
 * 仓库路径 → 可显示的 blob URL。
 * 走 downloadRepoBinaryFile（内部处理了 >1MB 文件 Contents API 不给内联内容的情况）。
 */
export async function repoImageBlobUrl(repoPath: string): Promise<string | null> {
  const hit = blobUrlCache.get(repoPath)
  if (hit) return hit
  const running = blobInflight.get(repoPath)
  if (running) return running

  const task = (async () => {
    const ctx = getRepoContext()
    if (!ctx) return null
    try {
      const res = await downloadRepoBinaryFile(ctx.owner, ctx.repo, repoPath, ctx.token)
      if (!res) return null
      const url = URL.createObjectURL(res.blob)
      blobUrlCache.set(repoPath, url)
      blobToPath.set(url, repoPath)
      return url
    } catch {
      // 拉不到就先不显示，不打断编辑
      return null
    } finally {
      blobInflight.delete(repoPath)
    }
  })()

  blobInflight.set(repoPath, task)
  return task
}

/** 图片被替换 / 删除后清掉缓存，避免继续显示旧图 */
export function forgetRepoImage(repoPath: string) {
  const url = blobUrlCache.get(repoPath)
  if (url) {
    URL.revokeObjectURL(url)
    blobToPath.delete(url)
  }
  blobUrlCache.delete(repoPath)
  blobInflight.delete(repoPath)
}

/** 把 md 里的图片 src 补成完整仓库路径（老数据可能是相对路径） */
export function toRepoPath(src: string, docPath: string): string {
  if (!isRepoImagePath(src)) return src
  if (src.startsWith('/')) return src.slice(1)
  const dir = docDirOf(docPath)
  if (!dir) return src
  // 已经是仓库绝对路径（含目录前缀）就原样返回
  if (src.startsWith(`${dir}/`)) return src
  return `${dir}/${src}`
}

/**
 * 把正文里遗留的 base64 内嵌图搬到仓库，换成语义路径。
 *
 * 逐张上传、成功一张换一张：任何一张失败就原样留着 ——
 * 迁移绝不能因为一次网络抖动把图弄丢。
 */
export async function migrateBase64Images(
  md: string,
  docPath: string,
  sub?: string,
): Promise<{ md: string; migrated: number }> {
  const re = /!\[([^\]]*)\]\((data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)\)/gi
  const matches = Array.from(md.matchAll(re))
  if (matches.length === 0) return { md, migrated: 0 }

  let out = md
  let migrated = 0

  for (const m of matches) {
    const [full, alt, dataUrl] = m
    try {
      const blob = await (await fetch(dataUrl)).blob()
      const ext = (/^data:image\/([a-z0-9.+-]+)/i.exec(dataUrl)?.[1] ?? 'png').replace(
        'jpeg',
        'jpg',
      )
      const repoPath = await uploadEditorImage({
        docPath,
        file: blob,
        fileName: `${alt || 'image'}.${ext}`,
        sub,
      })
      out = out.replace(full, `![${alt}](${repoPath})`)
      migrated++
    } catch {
      // 单张失败就跳过，base64 原样保留
    }
  }

  return { md: out, migrated }
}
