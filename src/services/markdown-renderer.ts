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

/** CSS px → 印刷 pt（CSS 96dpi → 印刷 72dpi），保留两位小数 */
function pxToPt(px: number): string {
  return `${Math.round(((px * 72) / 96) * 100) / 100}pt`
}

/** 选区在文档里覆盖到的元素。与 range.cloneContents() 的元素一一对应：
 *  只遍历共同祖先的**后代**（不含它本身），顺序都是前序 —— 于是能和克隆体逐一对齐。 */
function rangeElements(range: Range): Element[] {
  const lca = range.commonAncestorContainer
  const root = lca.nodeType === Node.ELEMENT_NODE ? (lca as Element) : lca.parentElement
  if (!root) return []
  const out: Element[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  let n = walker.nextNode()
  while (n) {
    if (range.intersectsNode(n)) out.push(n as Element)
    n = walker.nextNode()
  }
  return out
}

/** 块级元素：克隆出来后不再继承页面上下文，必须自带字号 */
const COPY_BLOCK_TAGS = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'SECTION', 'ARTICLE', 'FIGURE', 'FIGCAPTION',
])

/**
 * 复制选中的正文，产出一份适合粘进 Word / WPS 的 HTML。
 * ------------------------------------------------------------
 * 做两件事：
 * 1. **公式换回 LaTeX 源码**：KaTeX 默认同时输出 MathML 与 HTML 两份字形，直接复制
 *    会「公式丢失 + 内容重复两份」。这里把每个公式节点换成它的 $…$ 源码。
 * 2. **字号定格成绝对 pt**：网页界面字号是相对的（随视口流体的根字号缩放），
 *    Word/WPS 不认这套，粘过去会套用它们自己的默认字号、和网页看到的不一致。
 *    这里读取每个元素**计算后**的字号，转成 `pt` 内联写进克隆体 —— 粘过去就是
 *    网页上看到的那个大小（基准字号写在外层容器上，承接没被单独标注的文本）。
 *
 * 返回 false 表示选区为空（交给浏览器默认行为）。
 */
export function copySelectionForWord(
  clipboardData: DataTransfer,
  selection: Selection,
): boolean {
  if (selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  const src = rangeElements(range)
  // 给范围内元素打临时标记：克隆体会带着标记过来，于是「原元素 ↔ 克隆体」可直接配对，
  // 不必依赖遍历顺序去猜（顺序一旦错位，公式后面的字号就全乱了）。
  src.forEach((el, i) => el.setAttribute('data-af-copy', String(i)))
  const holder = document.createElement('div')
  holder.appendChild(range.cloneContents())
  src.forEach((el) => el.removeAttribute('data-af-copy'))

  if (!holder.textContent?.trim() && !holder.querySelector('img')) return false

  // ① 字号：外层容器承接基准字号（未被单独标注的文本就继承它）
  //    必须在「替换公式」之前做 —— 公式节点被换成文本后，.katex 内部元素会从
  //    克隆体里消失，配对就对不上了。
  const startEl =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement
  if (startEl) holder.style.fontSize = pxToPt(parseFloat(getComputedStyle(startEl).fontSize))

  // 块级元素、以及字号与父级不同的元素（上标 / 代码等），各写各的字号
  holder.querySelectorAll<HTMLElement>('[data-af-copy]').forEach((d) => {
    const s = src[Number(d.getAttribute('data-af-copy'))]
    d.removeAttribute('data-af-copy')
    if (!s) return
    const size = parseFloat(getComputedStyle(s).fontSize)
    const parentSize = s.parentElement ? parseFloat(getComputedStyle(s.parentElement).fontSize) : size
    if (COPY_BLOCK_TAGS.has(d.tagName) || size !== parentSize) {
      d.style.fontSize = pxToPt(size)
    }
  })

  // ② 公式：KaTeX 字形 → LaTeX 源码（放在字号之后，避免上面的配对被打乱）
  holder.querySelectorAll('.katex-display').forEach((el) => {
    el.replaceWith(document.createTextNode(wrapFormula(formulaSource(el), true)))
  })
  holder.querySelectorAll('.katex').forEach((el) => {
    el.replaceWith(document.createTextNode(wrapFormula(formulaSource(el), false)))
  })

  clipboardData.setData('text/plain', (holder.textContent || '').replace(/\n{3,}/g, '\n\n'))
  // 用 outerHTML：外层的基准字号写在 holder 自身，只取 innerHTML 会把它丢掉
  clipboardData.setData('text/html', holder.outerHTML)
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
