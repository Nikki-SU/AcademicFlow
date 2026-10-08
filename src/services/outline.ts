/**
 * 大纲与锚点工具
 * -------------------------------------------------
 * 阅读页 / 写作页「查看文档」面板共用同一套：
 * - 渲染后的 HTML → 给标题注入 id（锚点）并抽出大纲；
 * - 图书正文渲染前给顶层块编号（批注用）。
 *
 * 为什么单独抽出来：以前这几个函数是 Reading.tsx 的局部实现，
 * 写作页要「边读边写」的只读查看窗口时，若各写一份，两处口径迟早会走岔。
 * 全站只有这一份实现。
 *
 * 关于「层级」：MinerU 提取的标题**是不是标题**基本可信（很少把标题并进正文），
 * 但**是几级标题**经常抽风。因此这里只负责如实读出 level，
 * 真正的层级修正交给「大纲层级」编辑器（改的是 content.md 里标题行的 `#` 数量）。
 */

/**
 * 图书正文：给**顶层块**编号（b-1 / b-2 …），让批注能锚到具体段落。
 *
 * 图书是单一语言，不需要 en/cn 前缀，但同样要"一处一条、不跨书串"——
 * 只靠文本匹配的话，短句子在别的书里也会命中。
 * 只编顶层元素：那是 markdown 渲染出的段落 / 标题 / 图表，正好是阅读时的自然单位。
 */
export function withBookBlockIds(html: string): string {
  // 用 DOMParser 而不是临时 div：DOMParser 不会顺手去加载里面的图片
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const box = parsed.body
  let seq = 0
  for (const el of Array.from(box.children)) {
    if (el.tagName === 'HR') continue
    el.setAttribute('data-block-id', `b-${++seq}`)
  }
  return box.innerHTML
}

/** 大纲项：level 决定缩进，anchor 指向正文里对应标题的 id */
export interface OutlineItem {
  level: number
  text: string
  anchor: string
}

/**
 * 给渲染后的 HTML 里的 h1~h6 注入 id，并顺带抽出一份大纲。
 * 用递增序号做 id（book-h-N）—— 标题文本可能重复或含特殊字符，用文本当锚点会撞。
 */
export function buildOutlineAndAnchors(html: string): { html: string; outline: OutlineItem[] } {
  const outline: OutlineItem[] = []
  let seq = 0
  const withIds = html.replace(
    /<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi,
    (_m, lv: string, attrs: string, inner: string) => {
      const level = parseInt(lv, 10)
      const anchor = `book-h-${seq++}`
      const text = inner
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .trim()
      if (text) outline.push({ level, text, anchor })
      const cleanAttrs = attrs.replace(/\sid="[^"]*"/i, '')
      return `<h${lv}${cleanAttrs} id="${anchor}">${inner}</h${lv}>`
    },
  )
  return { html: withIds, outline }
}

// ============================================================
// 大纲层级编辑：直接改 content.md 里标题行的 `#` 数量
// ============================================================

export interface MarkdownHeading {
  /** 当前层级（`#` 数量，1~6） */
  level: number
  /** 标题文字（去掉开头 `#` 与行尾空白） */
  text: string
}

/** 逐行扫描时判断是否处在 ``` / ~~~ 代码围栏内（围栏里的 `#` 不是标题） */
function scanHeadings(
  md: string,
  onHeading: (level: number, text: string, lineIndex: number) => void,
): void {
  const lines = md.split('\n')
  let inFence = false
  let fenceMarker = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^\s*(```|~~~)/)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1]
      } else if (line.trim().startsWith(fenceMarker)) {
        inFence = false
      }
      continue
    }
    if (inFence) continue
    const m = line.match(/^(#{1,6})[ \t]+(.*)$/)
    if (m) onHeading(m[1].length, m[2].trim(), i)
  }
}

/** 按出现顺序解析 Markdown ATX 标题（忽略代码围栏内的 `#`） */
export function parseMarkdownHeadings(md: string): MarkdownHeading[] {
  const out: MarkdownHeading[] = []
  scanHeadings(md, (level, text) => {
    out.push({ level, text })
  })
  return out
}

/**
 * 按出现顺序把第 i 个标题改写为 `levels[i]`（1~6，越界自动夹取），
 * 其余行原样保留。标题之外的正文、代码块一律不动。
 */
export function rewriteHeadingLevels(md: string, levels: number[]): string {
  const lines = md.split('\n')
  let idx = 0
  let inFence = false
  let fenceMarker = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^\s*(```|~~~)/)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1]
      } else if (line.trim().startsWith(fenceMarker)) {
        inFence = false
      }
      continue
    }
    if (inFence) continue
    const m = line.match(/^(#{1,6})[ \t]+(.*)$/)
    if (!m) continue
    const want = levels[idx]
    idx++
    if (want === undefined) continue
    const clamped = Math.min(6, Math.max(1, Math.round(want)))
    lines[i] = `${'#'.repeat(clamped)} ${m[2]}`
  }
  return lines.join('\n')
}
