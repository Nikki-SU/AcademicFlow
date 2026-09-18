/**
 * 段落对齐翻译渲染
 * 现在有两条渲染路径：
 *   新路径：renderAlignedMdHtml() —— 输入 aligned.md（带 HTML 注释标记），确定性 idx 对齐
 *   旧路径：renderAlignedHtml()  —— 输入原始 fulltext.md + translation.md，启发式比例匹配
 */
import type { RenderMarkdownOptions } from './markdown-renderer'
import { renderMarkdownToHtml, extractMath, restoreMathInMarkdown } from './markdown-renderer'
import { parseAlignedMd, type ParsedAlignedMd } from './aligned-md'

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
    if (/^__MATH_BLOCK_\d+__(?:\s*__MATH_BLOCK_\d+__)*$/s.test(trimmed)) type = 'formula'
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
 * 新路径：从 aligned.md 解析 + 渲染
 *
 * 输入：aligned.md 原文（带 <!-- PARA en idx/total --> 等标记）
 * 输出：按 mode 渲染好的 HTML
 *
 * 核心优势：idx 精确匹配，不会出现"译文重复 N 次"或"段落错位"
 */
export function renderAlignedMdHtml(
  alignedMdContent: string,
  mode: TranslationMode,
  options: RenderMarkdownOptions = {},
): { html: string; hasTranslation: boolean; cnCoverage: number } {
  const parsed: ParsedAlignedMd = parseAlignedMd(alignedMdContent)
  const chunks: string[] = []

  // 构建 cn 段索引：idx → content
  const cnByIdx = new Map<number, string>()
  for (const n of parsed.nodes) {
    if (n.type === 'cn' && n.idx != null && n.content) {
      cnByIdx.set(n.idx, n.content)
    }
  }

  // 统计：有多少 en 段有对应的 cn
  const enCount = parsed.nodes.filter((n) => n.type === 'en').length
  const cnCount = cnByIdx.size
  const hasTranslation = cnCount > 0
  const cnCoverage = enCount > 0 ? cnCount / enCount : 0

  // 无译文时给明确提示
  if (!hasTranslation || (mode === 'chinese' && cnCoverage < 0.05)) {
    if (mode !== 'original' && mode !== 'english') {
      chunks.push(
        '<div class="bg-amber-50 border border-amber-300 text-amber-800 p-4 rounded-lg mb-4 text-sm">' +
        '⚠️ 该文献的 AI 翻译尚未生成完成（译文队列排队中）。当前显示的是原文，等后台翻译完成后刷新即可看到中文译文。</div>',
      )
    }
  }

  const render = (raw: string) => renderMarkdownToHtml(raw, options)

  // 遍历节点，按顺序渲染
  // 策略：en 段作为锚点，找到对应的 cn 段（按 idx），按 mode 显示
  const enNodes = parsed.nodes.filter((n) => n.type === 'en')
  const imgNodes = parsed.nodes.filter((n) => n.type === 'img')
  const tableNodes = parsed.nodes.filter((n) => n.type === 'table')
  const refNode = parsed.nodes.find((n) => n.type === 'ref')

  for (const en of enNodes) {
    const idx = en.idx!
    const enContent = en.content ?? ''
    const cnContent = cnByIdx.get(idx)

    if (mode === 'original' || mode === 'english') {
      chunks.push(render(enContent))
    } else if (mode === 'chinese') {
      if (cnContent) {
        chunks.push(render(cnContent))
      } else {
        // 无译文 → 灰色原文 + 提示
        chunks.push(
          `<div class="original-fallback text-slate-400 italic border-l-2 border-slate-300 pl-3 opacity-75">` +
          `<div class="text-xs text-slate-400 mb-1">— 此段译文排队中 —</div>` +
          `${render(enContent)}</div>`,
        )
      }
    } else if (mode === 'bilingual') {
      chunks.push(render(enContent))
      if (cnContent) {
        chunks.push(
          `<div class="translation-paragraph bg-indigo-50/30 border-l-2 border-indigo-300 pl-3 my-2">` +
          render(cnContent) +
          `</div>`,
        )
      } else {
        chunks.push(
          `<div class="text-xs text-slate-400 italic mb-2">（此段译文排队中）</div>`,
        )
      }
    }

    // 插在这段后面的图片（beforeIdx=idx 表示"在段 idx 之后"）
    for (const img of imgNodes) {
      if (img.beforeIdx === idx && img.content) {
        // 优先用完整 markdown（带 caption），fallback 用 path
        const imgMd = img.content.includes('![') ? img.content : (img.path?.startsWith('![') ? img.path : `![image](${img.path})`)
        chunks.push(render(imgMd))
      }
    }

    // 插在这段后面的表格（beforeIdx=idx）；中文模式优先显示译表
    for (const tbl of tableNodes) {
      if (tbl.beforeIdx !== idx) continue
      const useCn = (mode === 'chinese' || mode === 'bilingual') && !!tbl.cn?.trim()
      const body = useCn ? tbl.cn! : tbl.content
      if (body?.trim()) chunks.push(render(body))
    }
  }

  // 参考文献
  if (refNode?.content) {
    if (mode === 'original' || mode === 'bilingual' || mode === 'english') {
      chunks.push(`<hr class="my-6 border-slate-200"/>`)
      chunks.push(`<h2 class="text-lg font-semibold text-slate-700 mb-3">参考文献</h2>`)
      chunks.push(render(refNode.content))
    } else if (mode === 'chinese') {
      // 参考文献不翻译，显示原文 + 标注
      chunks.push(`<hr class="my-6 border-slate-200"/>`)
      chunks.push(`<h2 class="text-lg font-semibold text-slate-700 mb-3">参考文献</h2>`)
      chunks.push(
        `<div class="text-xs text-slate-400 italic mb-2">（参考文献不参与翻译）</div>` +
        render(refNode.content),
      )
    }
  }

  return { html: chunks.join('\n'), hasTranslation, cnCoverage }
}
