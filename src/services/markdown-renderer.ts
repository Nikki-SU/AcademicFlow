/**
 * Markdown 渲染服务
 * 基于 marked + KaTeX，支持标准 Markdown、LaTeX 行内/块级公式、相对图片路径转 GitHub raw URL
 */
import { marked, type Tokens } from 'marked'
import katex from 'katex'
import 'katex/dist/katex.min.css'

export interface RenderMarkdownOptions {
  /** 图片基础 URL，用于把相对路径转成可访问地址 */
  imageBaseUrl?: string
}

interface ExtractedMath {
  text: string
  inlineMath: string[]
  blockMath: string[]
}

/** 把 Markdown 渲染为 HTML（同步） */
export function renderMarkdownToHtml(
  markdown: string,
  options: RenderMarkdownOptions = {},
): string {
  const { inlineMath, blockMath, text } = extractMath(markdown)
  const renderer = new marked.Renderer()

  renderer.image = (token: Tokens.Image) => {
    const src = resolveImageUrl(token.href, options.imageBaseUrl)
    const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : ''
    return `<img src="${src}" alt="${escapeHtml(token.text)}"${titleAttr} class="max-w-full rounded-lg my-4 block" />`
  }
  renderer.link = (token: Tokens.Link) => {
    const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : ''
    return `<a href="${token.href}" target="_blank" rel="noopener noreferrer"${titleAttr} class="text-indigo-600 hover:text-indigo-800 underline underline-offset-2">${token.text}</a>`
  }

  marked.use({ renderer })
  let html = marked.parse(text, { async: false }) as string
  html = restoreMath(html, inlineMath, blockMath)
  return html
}

/** 提取 LaTeX 公式，避免 marked 破坏它们 */
export function extractMath(text: string): ExtractedMath {
  const inlineMath: string[] = []
  const blockMath: string[] = []
  let processed = text.replace(/\$\$([\s\S]*?)\$\$/g, (_m, math: string) => {
    blockMath.push(math.trim())
    return `__MATH_BLOCK_${blockMath.length - 1}__`
  })
  processed = processed.replace(/\$([^\$\n]+?)\$/g, (_m, math: string) => {
    inlineMath.push(math.trim())
    return `__MATH_INLINE_${inlineMath.length - 1}__`
  })
  return { inlineMath, blockMath, text: processed }
}

/** 把占位符还原为 KaTeX HTML */
function restoreMath(html: string, inlineMath: string[], blockMath: string[]): string {
  let result = html
  blockMath.forEach((math, i) => {
    result = result.replace(
      `__MATH_BLOCK_${i}__`,
      `<div class="my-4 overflow-x-auto text-center">${renderMath(math, true)}</div>`,
    )
  })
  inlineMath.forEach((math, i) => {
    result = result.replace(`__MATH_INLINE_${i}__`, renderMath(math, false))
  })
  return result
}

/** 把占位符还原为原始 Markdown 公式标记（用于段落拆分/再渲染） */
export function restoreMathInMarkdown(
  text: string,
  inlineMath: string[],
  blockMath: string[],
): string {
  let result = text
  blockMath.forEach((math, i) => {
    result = result.replace(`__MATH_BLOCK_${i}__`, `$$${math}$$`)
  })
  inlineMath.forEach((math, i) => {
    result = result.replace(`__MATH_INLINE_${i}__`, `$${math}$`)
  })
  return result
}

function renderMath(math: string, displayMode: boolean): string {
  try {
    return katex.renderToString(math, { displayMode, throwOnError: false, strict: false })
  } catch (err) {
    return `<span class="text-red-500 font-mono" title="${escapeHtml(String(err))}">${escapeHtml(math)}</span>`
  }
}

function resolveImageUrl(href: string, baseUrl?: string): string {
  if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('data:')) return href
  if (!baseUrl) return href
  const prefix = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'
  return prefix + href.replace(/^\.\//, '')
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
