/**
 * 正文批注高亮
 * ------------------------------------------------------------
 * 为什么不用 range.surroundContents 直接套选区：
 *   1) 批注文本常常横跨多个文本节点（正文里有 <sup>、<em>、<strong>、行内公式），
 *      surroundContents 遇到跨节点区间会直接抛异常 —— 表现出来就是"颜色根本不显示"；
 *   2) 用户选中的文本里带着换行和连续空格，而 DOM 里的文本节点是另一种空白排法，
 *      直接 indexOf 匹配不到。
 * 所以这里先把整篇正文的文本节点拼成一条扁平串，按"折叠空白 / 去掉空白"两种口径
 * 容错匹配，再把命中的扁平区间切回各文本节点，逐节点（单节点区间，绝不抛）包 span。
 *
 * 纯 DOM 操作，不依赖 React —— 单独成模块是为了能在浏览器里直接跑验证。
 */

export interface HighlightStyle {
  /** 底色 class，如 bg-yellow-200/70 */
  bg: string
  /** 选中态描边 class，如 ring-yellow-400 */
  ring: string
}

export interface TextSegment {
  node: Text
  /** 该节点在扁平串里的起止（左闭右开） */
  start: number
  end: number
}

/** 收集 root 下可搜索的文本节点（跳过脚本/样式，跳过已经高亮的） */
export function collectTextSegments(root: HTMLElement): { text: string; segs: TextSegment[] } {
  const segs: TextSegment[] = []
  let text = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT
      if (parent.closest('.annotation-highlight')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let node: Node | null
  while ((node = walker.nextNode())) {
    const t = node as Text
    const data = t.data
    if (!data) continue
    segs.push({ node: t, start: text.length, end: text.length + data.length })
    text += data
  }
  return { text, segs }
}

/** 折叠空白：连续空白压成一个空格；返回折叠串 + 每个字符在原文里的下标 */
export function foldSpaces(s: string): { folded: string; idx: number[] } {
  let folded = ''
  const idx: number[] = []
  let inSpace = false
  for (let i = 0; i < s.length; i++) {
    if (/\s/.test(s[i])) {
      if (inSpace) continue
      inSpace = true
      folded += ' '
      idx.push(i)
    } else {
      inSpace = false
      folded += s[i]
      idx.push(i)
    }
  }
  return { folded, idx }
}

/** 去掉所有空白：处理"跨行断词/断句"这种更极端的排法差异 */
export function stripSpaces(s: string): { stripped: string; idx: number[] } {
  let stripped = ''
  const idx: number[] = []
  for (let i = 0; i < s.length; i++) {
    if (/\s/.test(s[i])) continue
    stripped += s[i]
    idx.push(i)
  }
  return { stripped, idx }
}

/**
 * 在扁平串里定位 needle，返回原文下标区间 [start, end)；找不到返回 null。
 *
 * 两档匹配各有**最低长度**门槛，这不是洁癖：匹配口径越宽，短 needle 越容易在
 * 无关正文里命中。历史那份损坏的 CSV 里有一批 text 只剩 "3" / "Cs " 的碎片，
 * 配上"去掉所有空白"的兜底，能在任何一篇文章里匹配到第一个 "3" —— 表现就是
 * 批注跨文章乱串。宁可少匹配（退化成整块标记），也不能乱匹配。
 */
export function findSpan(text: string, needle: string): { start: number; end: number } | null {
  // 折叠空白口径：容忍换行/连续空格差异，门槛低一些
  if (needle.trim().length >= 2) {
    const foldedHay = foldSpaces(text)
    const foldedNeedle = foldSpaces(needle).folded.trim()
    if (foldedNeedle) {
      const at = foldedHay.folded.indexOf(foldedNeedle)
      if (at >= 0) {
        return { start: foldedHay.idx[at], end: foldedHay.idx[at + foldedNeedle.length - 1] + 1 }
      }
    }
  }
  // 去空白口径：只用于"跨行断词"这类极端排法差异，必须够长才允许
  if (needle.trim().length >= 8) {
    const strippedHay = stripSpaces(text)
    const strippedNeedle = stripSpaces(needle).stripped
    if (strippedNeedle) {
      const at = strippedHay.stripped.indexOf(strippedNeedle)
      if (at >= 0) {
        return { start: strippedHay.idx[at], end: strippedHay.idx[at + strippedNeedle.length - 1] + 1 }
      }
    }
  }
  return null
}

/** 清掉 root 里上一轮挂的所有高亮（含整块标记），并把文本节点重新连成一片 */
export function clearHighlights(root: HTMLElement): void {
  root.querySelectorAll('.annotation-highlight').forEach((span) => {
    const parent = span.parentNode
    if (!parent) return
    parent.replaceChild(document.createTextNode(span.textContent || ''), span)
    parent.normalize()
  })
  root.querySelectorAll('[data-annotation-block]').forEach((el) => {
    el.classList.remove('outline', 'outline-2', 'outline-amber-400', 'outline-amber-500', 'outline-offset-[-2px]')
    el.removeAttribute('data-annotation-block')
  })
}

/** 一条批注的高亮结果 */
export type HighlightOutcome =
  /** 在正文里按文本精确高亮了 */
  | 'exact'
  /** 文字没找到（例如切到了另一种语言），但锚点段落还在 → 整段做了标记 */
  | 'block'
  /** 连锚点段落都找不到（换文章了 / 重新转换过）→ 什么都没画 */
  | 'none'

/** 在某个容器里按文本找并包高亮；找到返回 true */
function wrapInside(
  scope: HTMLElement,
  annotationId: string,
  needle: string,
  selected: boolean,
  color: HighlightStyle,
): boolean {
  const { text, segs } = collectTextSegments(scope)
  if (!text) return false

  const span = findSpan(text, needle)
  if (!span) return false

  // 扁平区间 → 每个文本节点内的子区间（一条批注可能横跨多个节点）
  const pieces: { node: Text; from: number; to: number }[] = []
  for (const seg of segs) {
    const from = Math.max(span.start, seg.start)
    const to = Math.min(span.end, seg.end)
    if (to <= from) continue
    pieces.push({ node: seg.node, from: from - seg.start, to: to - seg.start })
  }
  if (pieces.length === 0) return false

  // 从后往前包：单节点区间不会抛；倒序保证前面的 piece 偏移不被 splitText 影响
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i]
    const range = document.createRange()
    range.setStart(p.node, p.from)
    range.setEnd(p.node, p.to)
    const mark = document.createElement('span')
    mark.setAttribute('data-annotation-id', annotationId)
    mark.className = `annotation-highlight ${color.bg} cursor-pointer rounded-sm transition-all hover:opacity-80`
    if (selected) mark.classList.add('ring-2', color.ring, 'ring-offset-1')
    range.surroundContents(mark)
  }
  return true
}

/**
 * 给一条批注挂高亮。
 *
 * 定位顺序：
 *   1. 先在这条批注**自己的块**里找（anchor = en-12 / cn-12）。这是准确的那一步 ——
 *      锚点已经限定到具体语言的某一段，不会跑到别的段落或别的文章上去。
 *   2. 块里没有（或没有 anchor 的老数据）→ 退回全文找一次。
 *   3. 文字全篇都找不到 → **给锚点段落整段做个淡色标记**。
 *      这一步是必须的：切到另一种语言时，英文批注的原文文字在中文模式下本来就不存在，
 *      如果没有块级标记，用户会以为批注丢了，然后重复批注同一处。
 */
export function highlightAnnotation(
  root: HTMLElement,
  annotationId: string,
  annotationText: string,
  selected: boolean,
  color: HighlightStyle,
  /** 块锚点（en-12 / cn-12）。老数据为空 → 退化成以前的全篇文本匹配 */
  anchor?: string,
): HighlightOutcome {
  const needle = (annotationText || '').trim()
  const scope = anchor
    ? root.querySelector<HTMLElement>(`[data-block-id="${anchor}"]`)
    : null

  // 单字符 needle 不能当定位依据（历史脏数据里有 "3"、"Cs "），一律只做块级标记
  if (needle.length >= 2) {
    if (scope && wrapInside(scope, annotationId, needle, selected, color)) return 'exact'
    if (wrapInside(root, annotationId, needle, selected, color)) return 'exact'
  }

  if (scope) {
    // 用 outline 而不是背景色：斑马纹（隔块底色）也用背景，两者叠在一起会互相盖住。
    // outline 不占布局、不跟背景打架，用户同时开斑马纹也能看见"这段有批注"。
    scope.setAttribute('data-annotation-block', annotationId)
    scope.classList.add('outline', 'outline-2', 'outline-offset-[-2px]', selected ? 'outline-amber-500' : 'outline-amber-400')
    return 'block'
  }
  return 'none'
}
