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
    return `<a href="${token.href}" target="_blank" rel="noopener noreferrer"${titleAttr} class="text-seal-600 hover:text-seal-800 underline underline-offset-2">${token.text}</a>`
  }

  marked.use({ renderer })
  let html = marked.parse(text, { async: false }) as string
  html = restoreMath(html, inlineMath, blockMath)
  return html
}

/**
 * 公式占位符。
 *
 * 必须用 marked **不会解释**的字符：旧实现用 `__MATH_INLINE_0__`，
 * 而 `__xxx__` 在 Markdown 里是加粗语法 —— 占位符会被吃成
 * `<strong>MATH_INLINE_0</strong>`，还原时匹配不到，页面上就直接显示
 * 光秃秃的 "MATH_INLINE_0"。`@@` 无任何 Markdown 语义，安全。
 */
const BLOCK_TOKEN = (i: number) => `@@MATH_BLOCK_${i}@@`
const INLINE_TOKEN = (i: number) => `@@MATH_INLINE_${i}@@`

/** 判定一整段是否只由块级公式占位符组成（段落类型识别用） */
export function isBlockMathOnly(text: string): boolean {
  return /^(?:@@MATH_BLOCK_\d+@@\s*)+$/.test(text.trim())
}

/** 提取 LaTeX 公式，避免 marked 破坏它们 */
export function extractMath(text: string): ExtractedMath {
  const inlineMath: string[] = []
  const blockMath: string[] = []
  let processed = text.replace(/\$\$([\s\S]*?)\$\$/g, (_m, math: string) => {
    blockMath.push(math.trim())
    return BLOCK_TOKEN(blockMath.length - 1)
  })
  processed = processed.replace(/\$([^\$\n]+?)\$/g, (_m, math: string) => {
    inlineMath.push(math.trim())
    return INLINE_TOKEN(inlineMath.length - 1)
  })
  return { inlineMath, blockMath, text: processed }
}

/** 把占位符还原为 KaTeX HTML */
function restoreMath(html: string, inlineMath: string[], blockMath: string[]): string {
  let result = html
  blockMath.forEach((math, i) => {
    result = result.replace(
      BLOCK_TOKEN(i),
      `<div class="my-4 overflow-x-auto text-center">${renderMath(math, true)}</div>`,
    )
  })
  inlineMath.forEach((math, i) => {
    result = result.replace(INLINE_TOKEN(i), renderMath(math, false))
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
    result = result.replace(BLOCK_TOKEN(i), `$$${math}$$`)
  })
  inlineMath.forEach((math, i) => {
    result = result.replace(INLINE_TOKEN(i), `$${math}$`)
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

/**
 * 复制含公式的文本时，把 KaTeX 渲染出来的字形换回 LaTeX 源码。
 * ------------------------------------------------------------
 * KaTeX 默认同时输出 MathML 与 HTML 两份（output 默认 htmlAndMathml），而 MathML 那份
 * 只是 clip 隐藏、仍在选中流里 —— 直接复制就会「公式丢失」（复制到的是拼字形的 span）
 * 且「公式位置的内容重复两份」。
 * 这里改用选区克隆重拼：每个公式节点换成它的源码。
 *
 * 返回 false 表示选区里没有公式，交给浏览器默认行为。
 */
export function copySelectionWithFormulaSource(
  clipboardData: DataTransfer,
  selection: Selection,
): boolean {
  if (selection.rangeCount === 0) return false
  const holder = document.createElement('div')
  holder.appendChild(selection.getRangeAt(0).cloneContents())
  if (!holder.querySelector('.katex')) return false

  // 块级先处理：整块换成 $$…$$，它内部的 .katex 也随之消失
  holder.querySelectorAll('.katex-display').forEach((el) => {
    el.replaceWith(document.createTextNode(wrapFormula(formulaSource(el), true)))
  })
  holder.querySelectorAll('.katex').forEach((el) => {
    el.replaceWith(document.createTextNode(wrapFormula(formulaSource(el), false)))
  })

  clipboardData.setData('text/plain', (holder.textContent || '').replace(/\n{3,}/g, '\n\n'))
  clipboardData.setData('text/html', holder.innerHTML)
  return true
}

/** KaTeX 把原始 TeX 写在 MathML 分支的 annotation 里，直接取回来即可 */
function formulaSource(el: Element): string {
  return el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ?? ''
}

/** 还原成 markdown 写法；取不到源码就留空 —— 宁可不留，也不留一堆字形 */
function wrapFormula(tex: string, display: boolean): string {
  if (!tex) return ''
  return display ? `\n$$\n${tex}\n$$\n` : `$${tex}$`
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
