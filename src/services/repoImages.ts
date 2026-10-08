/**
 * 私库正文图片的加载工具
 * -------------------------------------------------
 * 阅读页 / 写作页「查看文档」面板共用同一套：
 * - 算图片基准 URL（文献 / 图书 / 其他文档 / 笔记，各自的目录口径不同）；
 * - 把 GitHub Contents API 的图片 URL fetch 成 blob URL（绕过 GFW）。
 *
 * 为什么单独抽出来：以前这几个函数是 Reading.tsx 的局部实现，
 * 写作页要「边读边写」的只读查看窗口时，若各写一份，两份口径迟早会走岔。
 * 全站只有这一份实现。
 */

import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'
import { doiToSlug } from './literatureData'

/** 文献正文的图片基准 URL：literatures/{slug}/ */
export function getImageBaseUrl(doi: string): string {
  const auth = useAuthStore.getState()
  const ws = useWorkspaceStore.getState()
  if (!auth.user || !ws.repo) return ''
  const slug = doiToSlug(doi)
  // 纯目录路径，不带 query —— query 参数由 preloadImage 在 fetch 时附加
  // 这样 markdown-renderer.ts 的 resolveImageUrl 拼接不会出错
  const owner = encodeURIComponent(auth.user.login)
  const repo = encodeURIComponent(ws.repo.name)
  const slugEnc = encodeURIComponent(slug)
  return `https://api.github.com/repos/${owner}/${repo}/contents/literatures/${slugEnc}/`
}

/** 单语言正文的图片基准 URL：图书在 textbooks/{书名}/，其他文档在 documents/{目录名}/ */
export function getPlainImageBaseUrl(ownerDir: string, root: 'textbooks' | 'documents'): string {
  const auth = useAuthStore.getState()
  const ws = useWorkspaceStore.getState()
  if (!auth.user || !ws.repo) return ''
  const owner = encodeURIComponent(auth.user.login)
  const repo = encodeURIComponent(ws.repo.name)
  const dir = ownerDir.split('/').map(encodeURIComponent).join('/')
  return `https://api.github.com/repos/${owner}/${repo}/contents/${root}/${dir}/`
}

/**
 * 笔记的图片基准 URL：直接指到**仓库根**。
 * 笔记里的图片引用是仓库绝对路径（编辑器与导入都写 `literatures/{slug}/notes/images/x.png`），
 * 拼在仓库根之后正好是完整路径；也让它落进 hydrateImages 的 `api.github.com/repos` 匹配。
 */
export function getRepoImageBaseUrl(): string {
  const auth = useAuthStore.getState()
  const ws = useWorkspaceStore.getState()
  if (!auth.user || !ws.repo) return ''
  const owner = encodeURIComponent(auth.user.login)
  const repo = encodeURIComponent(ws.repo.name)
  return `https://api.github.com/repos/${owner}/${repo}/contents/`
}

/**
 * 预加载图片：把 GitHub Contents API 的图片 URL fetch 成 Blob，再转成 blob: URL
 * 这样可以带 Accept: application/vnd.github.v3.raw + token header
 * 不走 raw.githubusercontent.com（GFW 会挡）
 */
export async function preloadImage(
  url: string,
  token: string,
  authMode: 'header' | 'query',
): Promise<string> {
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3.raw',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    // Contents API 必须指定 ref，否则默认 HEAD（如果分支名改过就拿不到）
    let fetchUrl = url.includes('?') ? `${url}&ref=main` : `${url}?ref=main`
    if (authMode === 'header') {
      headers['Authorization'] = `Bearer ${token}`
    } else {
      // query 参数模式（零 CORS 预检，但 token 暴露在 URL 里——对公开 repo 可以）
      fetchUrl = fetchUrl.includes('?') ? `${fetchUrl}&access_token=${encodeURIComponent(token)}` : `${fetchUrl}?access_token=${encodeURIComponent(token)}`
    }
    const res = await fetch(fetchUrl, { headers })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  } catch (err) {
    console.warn('[preloadImage] 加载失败:', url, err)
    return url // 失败就返回原 URL，让浏览器自己处理（大概率也拿不到，但至少不崩）
  }
}

/**
 * 扫描容器内所有 <img>，把 api.github.com/contents 开头的 src 预加载成 blob URL
 */
export async function hydrateImages(container: HTMLElement, token: string, authMode: 'header' | 'query') {
  const imgs = container.querySelectorAll<HTMLImageElement>('img[src*="api.github.com/repos"]')
  const tasks: Promise<void>[] = []
  imgs.forEach((img) => {
    const original = img.src
    // 跳过已经是 blob: 或 data: 的
    if (original.startsWith('blob:') || original.startsWith('data:')) return
    tasks.push(
      preloadImage(original, token, authMode).then((blobUrl) => {
        if (blobUrl !== original) {
          img.src = blobUrl
        }
      }),
    )
  })
  if (tasks.length > 0) {
    console.log(`[hydrateImages] 预加载 ${tasks.length} 张图片`)
    await Promise.all(tasks)
  }
}
