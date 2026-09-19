/**
 * 段落对齐翻译渲染
 * 现在有两条渲染路径：
 *   新路径：renderAlignedMdHtml() —— 输入结构化块文档（⟨⟨⟨元信息⟩⟩⟩内容⟨⟨⟨/⟩⟩⟩），确定性编号对齐
 *   旧路径：renderAlignedHtml()  —— 输入原始 full.md + translation.md，启发式比例匹配
 */
import type { RenderMarkdownOptions } from './markdown-renderer'
import { renderMarkdownToHtml, extractMath, restoreMathInMarkdown, isBlockMathOnly } from './markdown-renderer'
import { readAnyDocument, isTranslatable, blockId, type ReadBlockItem } from './blocks.mjs'

export type TranslationMode = 'original' | 'bilingual' | 'chinese' | 'english'
export type ParagraphType = 'text' | 'image' | 'formula' | 'code' | 'heading' | 'table' | 'other'

export interface Paragraph {
  type: ParagraphType
  raw: string
}

export interface AlignedParagraph {
  type: ParagraphType
  original_raw: string
  translation_raw: string | null
}

/** 把 Markdown 拆成自然段 */
export function splitMarkdownIntoParagraphs(markdown: string): Paragraph[] {
  const { inlineMath, blockMath, text } = extractMath(markdown)
  const parts = text.split(/\n\s*\n/).filter((s) => s.trim().length > 0)
  return parts.map((part) => {
    const trimmed = part.trim()
    let type: ParagraphType = 'text'
    if (isBlockMathOnly(trimmed)) type = 'formula'
    else if (/^!\[.*?\]\(.*?\)/ms.test(trimmed)) type = 'image'
    else if (/^```/m.test(trimmed)) type = 'code'
    else if (/^#{1,6}\s+/m.test(trimmed)) type = 'heading'
    else if (/^\|.*\|/ms.test(trimmed)) type = 'table'
    return { type, raw: restoreMathInMarkdown(part, inlineMath, blockMath) }
  })
}

/** 把原文和译文按段落索引对齐
 *
 * 策略：**顺序 1:1 匹配**（前 N 个段落顺序对应，不做比例映射）。
 * - orig[i] ↔ trans[i]，当 i >= trans.length 时 transRaw = null
 * - 避免了比例映射把同一个 transPara 重复映射到多个 origPara（导致用户看到译文"每段重复 N 次"）
 */
export function alignParagraphs(
  original: Paragraph[],
  translation: Paragraph[],
): AlignedParagraph[] {
  if (translation.length === 0) {
    return original.map((p) => ({ type: p.type, original_raw: p.raw, translation_raw: null }))
  }

  const textIndicesOrig = original
    .map((p, i) => (p.type === 'text' || p.type === 'heading' ? i : -1))
    .filter((i) => i >= 0)
  const textIndicesTrans = translation
    .map((p, i) => (p.type === 'text' || p.type === 'heading' ? i : -1))
    .filter((i) => i >= 0)

  return original.map((p, origIdx) => {
    if (p.type !== 'text' && p.type !== 'heading') {
      return { type: p.type, original_raw: p.raw, translation_raw: null }
    }
    const textPos = textIndicesOrig.indexOf(origIdx)
    let transRaw: string | null = null
    if (textPos >= 0 && textPos < textIndicesTrans.length) {
      // 顺序 1:1 匹配
      const transParaIdx = textIndicesTrans[textPos]
      transRaw = translation[transParaIdx]?.raw ?? null
    }
    return { type: p.type, original_raw: p.raw, translation_raw: transRaw }
  })
}

/** 按指定模式把对齐后的段落渲染为 HTML */
export function renderAlignedHtml(
  aligned: AlignedParagraph[],
  mode: TranslationMode,
  options: RenderMarkdownOptions = {},
): string {
  const chunks: string[] = []
  const render = (raw: string) => renderMarkdownToHtml(raw, options)

  // 判断是否译文整体是英文（AI 返回了原文而非译文）
  const allTransAreEnglish = mode !== 'original' && mode !== 'english' && aligned.length > 0 &&
    aligned.every((p) => {
      if (!p.translation_raw) return true // null 不算"有译文"
      // 粗略判断：译文中文比例 < 5% → 当作没翻译
      const chineseChars = (p.translation_raw.match(/[\u4e00-\u9fff]/g) ?? []).length
      const total = p.translation_raw.replace(/\s/g, '').length
      return total > 0 && chineseChars / total < 0.05
    }) && aligned.some((p) => p.translation_raw)

  if (allTransAreEnglish) {
    // 给用户明确提示，不要悄悄 fallback
    chunks.push(
      '<div class="bg-amber-50 border border-amber-300 text-amber-800 p-4 rounded-lg mb-4 text-sm">' +
      '⚠️ 该文献的 AI 翻译尚未生成完成（译文队列排队中）。当前显示的是原文，等后台翻译完成后刷新即可看到中文译文。</div>',
    )
  }

  for (const p of aligned) {
    if (mode === 'original' || mode === 'english') {
      chunks.push(render(p.original_raw))
    } else if (mode === 'chinese') {
      if (p.translation_raw && !allTransAreEnglish) {
        chunks.push(render(p.translation_raw))
      } else {
        // 没有译文 → 渲染原文 + 灰色提示
        chunks.push(
          `<div class="original-fallback text-slate-400 italic">${render(p.original_raw)}</div>`,
        )
      }
    } else if (mode === 'bilingual') {
      chunks.push(render(p.original_raw))
      if ((p.type === 'text' || p.type === 'heading') && p.translation_raw && !allTransAreEnglish) {
        chunks.push(
          `<div class="translation-paragraph bg-indigo-50/30 border-l-2 border-indigo-300 pl-3">${render(p.translation_raw)}</div>`,
        )
      }
    }
  }
  return chunks.join('\n')
}

/**
 * 新路径：从结构化块文档解析 + 渲染
 *
 * 输入：literatures/{slug}/{slug}.md（⟨⟨⟨元信息⟩⟩⟩内容⟨⟨⟨/⟩⟩⟩）
 * 输出：按 mode 渲染好的 HTML
 *
 * 标记只存在于文件里，渲染时全部隐藏。解析器与 runner 共用 blocks.mjs 同一份实现，
 * 结构上保证前后端一致、且块外任何文本都会被原样渲染出来（不丢东西）。
 */
export function renderAlignedMdHtml(
  alignedMdContent: string,
  mode: TranslationMode,
  options: RenderMarkdownOptions = {},
): { html: string; hasTranslation: boolean; cnCoverage: number } {
  const { items, warnings } = readAnyDocument(alignedMdContent)
  if (warnings.length) console.warn('[blocks] 解析告警：', warnings.join(' | '))

  const render = (raw: string) => renderMarkdownToHtml(raw, options)
  const blank = (s?: string) => !s || !s.trim()

  const blocks = items.filter((it): it is ReadBlockItem => it.t === 'block')
  const translatable = blocks.filter((b) => isTranslatable(b.node))
  const done = translatable.filter((b) => !blank(b.cn))
  const hasTranslation = done.length > 0
  const cnCoverage = translatable.length > 0 ? done.length / translatable.length : 0

  const chunks: string[] = []
  const showCn = mode === 'chinese' || mode === 'bilingual'

  if ((!hasTranslation || (mode === 'chinese' && cnCoverage < 0.05)) && mode !== 'original' && mode !== 'english') {
    chunks.push(
      '<div class="bg-amber-50 border border-amber-300 text-amber-800 p-4 rounded-lg mb-4 text-sm">' +
      '⚠️ 该文献的 AI 翻译尚未生成完成（译文队列排队中）。当前显示的是原文，等后台翻译完成后刷新即可看到中文译文。</div>',
    )
  }

  const pendingNote = '<div class="text-xs text-slate-400 italic mb-2">（此段译文排队中）</div>'
  const fallback = (raw: string) =>
    '<div class="original-fallback text-slate-400 italic border-l-2 border-slate-300 pl-3 opacity-75">' +
    '<div class="text-xs text-slate-400 mb-1">— 此段译文排队中 —</div>' +
    render(raw) + '</div>'
  const cnBox = (cn: string) =>
    '<div class="translation-paragraph bg-indigo-50/30 border-l-2 border-indigo-300 pl-3 my-2">' +
    render(cn) + '</div>'

  /**
   * 给该块的 HTML 打上 data-block-id（只往第一个元素标签里加属性，不改 DOM 结构）。
   * 用途：阅读页"点批注跳回位置"——当前显示模式下找不到批注原文时，
   * 仍能靠块号定位到对应段落（中英锚点互通）。
   */
  const withBlockId = (html: string, id: string | null): string =>
    id ? html.replace(/^\s*<([a-zA-Z][\w-]*)/, `<$1 data-block-id="${id}"`) : html

  for (const it of items) {
    // 块外裸文本：原样渲染，绝不吞掉
    if (it.t === 'text') {
      if (it.content.trim()) chunks.push(render(it.content))
      continue
    }

    const { node, content, cn } = it
    const body = content.trim()
    const bid = blockId(node)
    const wrap = (html: string) => withBlockId(html, bid)

    // 图 / 公式：不翻译，原样显示
    if (node.kind === 'float' && (node.type === '图' || node.type === '公式')) {
      if (body) chunks.push(wrap(render(body)))
      continue
    }

    // 表：中文/对照模式优先显示译表
    if (node.kind === 'float' && node.type === '表') {
      if (showCn && !blank(cn)) chunks.push(wrap(render(cn!.trim())))
      else if (body) chunks.push(wrap(render(body)))
      if (showCn && blank(cn)) chunks.push(pendingNote)
      continue
    }

    // 参考文献：不翻译
    if (node.kind === 'note' && node.type === '文献') {
      chunks.push('<hr class="my-6 border-slate-200"/>')
      chunks.push('<h2 class="text-lg font-semibold text-slate-700 mb-3">参考文献</h2>')
      if (mode === 'chinese') {
        chunks.push('<div class="text-xs text-slate-400 italic mb-2">（参考文献不参与翻译）</div>')
      }
      if (body) chunks.push(wrap(render(body)))
      continue
    }

    // 标题 / 正文 / 列表 / 图注 / 引文：需要翻译
    if (mode === 'original' || mode === 'english') {
      if (body) chunks.push(wrap(render(body)))
    } else if (mode === 'chinese') {
      chunks.push(wrap(!blank(cn) ? render(cn!.trim()) : fallback(body)))
    } else {
      if (body) chunks.push(wrap(render(body)))
      chunks.push(!blank(cn) ? cnBox(cn!.trim()) : pendingNote)
    }
  }

  return { html: chunks.join('\n'), hasTranslation, cnCoverage }
}
