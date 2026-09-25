import { useState, useEffect, useRef, useCallback, useMemo, memo, type DragEvent } from 'react'
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom'
import {
  BookOpen,
  BookCopy,
  Highlighter,
  MessageSquare,
  StickyNote,
  Search,
  ArrowLeft,
  ZoomIn,
  ZoomOut,
  Download,
  FileText,
  Filter,
  Save,
  X,
  ChevronRight,
  ChevronDown,
  Edit3,
  Plus,
  Languages,
  ListTree,
  Sparkles,
  AlertTriangle,
  Upload,
  Folder,
  Loader2,
} from 'lucide-react'
import { loadLiteratures, loadFulltext, loadTranslation, loadAlignedMd, saveFulltext, saveAlignedMd, blocksToAiText, doiToSlug, type Literature } from '../services/literatureData'
import { listBooks, loadBookContent, type BookSummary } from '../services/textbookData'
import { listDocuments, loadDocumentContent, importMarkdownDocs, readMarkdownZip, titleFromFileName, type DocumentSummary, type ImportItem } from '../services/documentData'
import { loadBookCategories, loadDocumentCategories, categoriesOfMember, type Category } from '../services/categoryData'
import { loadCategories as loadPaperCategories, type LiteratureCategory } from '../services/literatureCategoryData'
import { loadAnnotations, saveAnnotations, type Annotation as AnnotationData } from '../services/annotationData'
import { loadNotes, saveNotes, loadProgress, saveProgress, notesPath, type DocRef, type ReadingProgress } from '../services/readingDocData'
import { useWorkspaceStore } from '../stores/workspace'
import { useAuthStore } from '../stores/auth'
import { getResolvedAuthMode } from '../services/github'
import { DoiLink } from '../components/DoiLink'
import { renderMarkdownToHtml, copySelectionWithFormulaSource } from '../services/markdown-renderer'
import { splitMarkdownIntoParagraphs, alignParagraphs, renderAlignedHtml, renderAlignedMdHtml, type TranslationMode } from '../services/translation'
import { readAnyDocument, parseBlocks, serializeBlocks, renumber, isTranslatable, labelOf, blockId, type ReadBlockItem, type BlockNode } from '../services/blocks.mjs'
import { clearHighlights, highlightAnnotation, clearSearchHits, highlightSearchHits } from '../services/text-highlight'
import {
  searchLibrary,
  getSearchIndex,
  buildHighlightRegex,
  KIND_LABEL,
  type SearchHit,
} from '../services/librarySearch'
import VditorEditor, { type VditorEditorHandle } from '../components/VditorEditor'
import ReadingAskPanel from '../components/ReadingAskPanel'
import { toast } from 'sonner'

type HighlightColor = 'yellow' | 'green' | 'blue' | 'purple' | 'red'
/** 右栏页签：问 AI / 笔记 / 批注（文献与图书同一套） */
type SideTab = 'ask' | 'notes' | 'annotations'
type FilterType = 'all' | 'has-md' | 'no-md'
/** 一级/二级文献筛选（1 = 原创研究，2 = 综述等二手文献） */
type TierFilter = 'all' | 1 | 2
/** 阅读对象：文献（按 doi）/ 图书（按书名）/ 其他文档（按 documents 下的目录名） */
type DocType = 'paper' | 'book' | 'document'

/** 文献的显示模式全集 —— 只用来校验从进度文件里读回来的 mode 是不是合法值 */
const TRANSLATION_MODES: TranslationMode[] = ['original', 'bilingual', 'chinese', 'english']

/**
 * 编辑态的一个"单元" = 一个源块 + 它配对的那条译文块。
 *
 * 为什么按"块"编辑而不是整篇富文本：用户改的只是文字，整篇编辑器里
 * `⟨⟨⟨文字·正文·0·12⟩⟩⟩` 这些标记会直接糊在眼前（而且很容易被误删，
 * 一删整份文档的编号就全乱）。按块切开后，标记由代码持有，人只碰正文；
 * 中英两块各自一个框，谁也不会串行。
 */
interface EditUnit {
  /** 稳定 key，给 React 用 */
  key: string
  /** 源块在 `editItems` 里的下标 */
  srcIdx: number
  /** 配对的译文块下标（原文里没有译文则为 null） */
  transIdx: number | null
  /**
   * 源块的元信息节点。**编辑态里"改类型"就是改这里** ——
   * 展示名（labelOf）与是否该有译文（isTranslatable）都从它推出来，不会各说各话。
   */
  node: BlockNode
  /** 按块语法，这一块是否"该有译文"（图 / 公式 / 文献 不翻） */
  translatable: boolean
  /** 英文（源语言）内容 */
  en: string
  /** 中文（译文）内容 */
  cn: string
}

/**
 * 编辑页能改成的类型 —— 只放「文字」家族：正文 / 标题 1-6 / 列表 1-3。
 *
 * 为什么不做图/表/公式那一大堆：那些是浮动块，编号是「锚到前面第几个流块 · 同锚点内第几个」，
 * 而且 图/公式 不翻译、表/图注 才翻译 —— 改过去会同时动到编号体系、图片路径和译文语义。
 * 实际会看错的多半就是「标题 ↔ 正文 ↔ 列表」，这三类互改零副作用。
 */
const EDIT_TYPE_OPTIONS: Array<{ value: string; label: string; type: '正文' | '标题' | '列表'; level: number }> = [
  { value: '正文', label: '正文', type: '正文', level: 0 },
  ...[1, 2, 3, 4, 5, 6].map((lv) => ({ value: `标题${lv}`, label: `标题 ${lv} 级`, type: '标题' as const, level: lv })),
  ...[1, 2, 3].map((lv) => ({ value: `列表${lv}`, label: `列表 ${lv} 级`, type: '列表' as const, level: lv })),
]

/** 这一块对上下拉里的哪个值（非流块返回 ''，调用方据此不渲染下拉） */
function editTypeValueOf(node: BlockNode): string {
  if (!node || node.kind !== 'flow') return ''
  return node.type === '正文' ? '正文' : `${node.type}${node.level}`
}

/** 改类型：只换 kind/type/level，其余字段（编号 n 等）原样留给 renumber 去排 */
function withEditType(node: BlockNode, value: string): BlockNode {
  const opt = EDIT_TYPE_OPTIONS.find((o) => o.value === value)
  if (!opt) return node
  return { ...node, kind: 'flow', type: opt.type, level: opt.level } as BlockNode
}

/**
 * 拖拽换位时「挪一格」对应的像素数。
 * 拖拽用**位移量**决定挪几位，而不是"指针落在哪个块的上半区"——
 * 块的高度能差十几倍，一个超长正文块占满整屏时，要求指针挪到它上半区等于挪不动。
 */
const EDIT_DRAG_STEP_PX = 30

/**
 * 把块文档拆成"单元"。译文块不单独出现 —— 它按 `ref`（无编号的按紧邻上一个块）
 * 归到对应源块的 `cn` 里；块外文本不渲染，但原样留在 `items` 里，保存时一并写回。
 *
 * 与 rebuildDocFromUnits 一样是模块级纯函数（可单测）。
 */
function buildEditUnits(items: Array<Record<string, any>>): EditUnit[] {
  const srcIdxById = new Map<string, number>()
  items.forEach((it, i) => {
    if (it.t !== 'block' || it.node.kind === 'translation') return
    const id = blockId(it.node)
    if (id) srcIdxById.set(id, i)
  })

  const transBySrc = new Map<number, number>()
  items.forEach((it, i) => {
    if (it.t !== 'block' || it.node.kind !== 'translation') return
    let target: number | null = null
    if (it.node.ref && srcIdxById.has(it.node.ref)) {
      target = srcIdxById.get(it.node.ref) ?? null
    } else if (!it.node.ref) {
      // 无编号译文（引文的译文）：挂到紧邻的上一个源块，与 blocks.mjs 的读法一致
      for (let j = i - 1; j >= 0; j--) {
        if (items[j].t !== 'block') continue
        if (items[j].node.kind !== 'translation') target = j
        break
      }
    }
    if (target != null && !transBySrc.has(target)) transBySrc.set(target, i)
  })

  const units: EditUnit[] = []
  items.forEach((it, i) => {
    if (it.t !== 'block' || it.node.kind === 'translation') return
    const transIdx = transBySrc.get(i) ?? null
    units.push({
      key: `blk${i}_${blockId(it.node) ?? it.node.type}`,
      srcIdx: i,
      transIdx,
      node: { ...it.node } as BlockNode,
      translatable: isTranslatable(it.node),
      en: it.content ?? '',
      cn: transIdx != null ? (items[transIdx].content ?? '') : '',
    })
  })
  return units
}

/**
 * 把「原始块文档条目 + 编辑单元」重建成整份文档。
 *
 * 特意提在组件外面、写成纯函数（不碰任何 React 状态）：这条路径一旦有错就是**写坏用户的文献**，
 * 所以它必须能被直接拿去跑真文档做往返验证（见 rebuild-from-units 测试）。
 *
 * 重建规则：
 *   - 顺序取「用户拖出来的 `units` 顺序」（拖图注、拖段落都靠它）
 *   - 源块取 `en`；该有译文的块且 `cn` 非空 → 紧跟一条译文块（保留它原来的 ref）
 *   - 用户清空译文 → 连译文块一起不要（不是留一条空译文）
 *   - 单元被删 → 中文一起走（用户说的：没人会只删一种语言）
 *   - 块外文本按原槽位塞回，一个字不动（见下面 textSlots）
 * 最后过 `renumber`：编号连续、浮动块重新锚定、译文引用同步重定向。
 * 它只改元信息不碰内容，所以"重排"不会吃掉任何一个字。
 */
function rebuildDocFromUnits(
  items: Array<Record<string, any>>,
  units: EditUnit[],
): { md: string; droppedLabels: string[] } {
  // 原文里所有「块」的位置（译文块不算 —— 它跟着自己的源块走）
  const originalUnitIdxs = items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it.t === 'block' && it.node.kind !== 'translation')
  const aliveIdxs = new Set(units.map((u) => u.srcIdx))

  /**
   * 块外文本按「第几个块之后」分槽（槽 0 = 第一个块之前）。
   *
   * 重排后依然按槽位落回，而不是跟着被拖的块跑 —— 这样两个好处：
   *   1. 不重排时重建结果与原文**逐字节相同**（槽位与原文一一对应）；
   *   2. 重排时文件骨架（尤其是那几串换行）不会被搅乱，也不会把文本挤成一坨。
   * 槽位按**原文**的块数开，所以删块不会把后面的文本挤到文件末尾。
   */
  const textSlots: string[][] = Array.from({ length: originalUnitIdxs.length + 1 }, () => [])
  {
    let seen = 0
    for (const it of items) {
      if (it.t === 'text') { textSlots[seen].push(it.content); continue }
      if (it.node.kind !== 'translation') seen++
    }
  }

  const droppedLabels = originalUnitIdxs
    .filter(({ i }) => !aliveIdxs.has(i))
    .map(({ it }) => labelOf(it.node))

  const out: Array<Record<string, any>> = []
  const pushSlot = (k: number) => {
    for (const content of textSlots[k] ?? []) out.push({ t: 'text', content })
  }

  pushSlot(0)
  units.forEach((u, k) => {
    const src = items[u.srcIdx]
    if (!src || src.t !== 'block') return
    // 元信息取 unit 上的那份（用户可能在编辑态里改过类型），不是原文件的
    out.push({ t: 'block', node: u.node, content: u.en })
    if (u.translatable && u.cn.trim()) {
      const trans = u.transIdx != null ? items[u.transIdx] : null
      const node = trans && trans.t === 'block' ? trans.node : { kind: 'translation', ref: blockId(u.node) }
      out.push({ t: 'block', node, content: u.cn })
    }
    pushSlot(k + 1)
  })
  // 删过块 → 末尾还剩下几个槽的文本，一律兜到最后，绝不丢字
  for (let g = units.length + 1; g < textSlots.length; g++) pushSlot(g)

  return { md: serializeBlocks(renumber(out as any)) as string, droppedLabels }
}

/**
 * 编辑态的一块。单独抽出来 + memo，是为了改一个字只重渲染这一块 ——
 * 一篇文献动辄一两百个块，整列表跟着每次按键重渲染会明显发顿。
 */
const EditBlockCard = memo(function EditBlockCard({
  unit,
  dragging,
  dropEdge,
  isFirst,
  isLast,
  onChange,
  onRemove,
  onMoveUnit,
  onChangeType,
  onDragStartUnit,
  onDragEndUnit,
}: {
  unit: EditUnit
  /** 正在被拖走的就是这一块 */
  dragging: boolean
  /** 拖着的块会插到这一块的上面 / 下面（null = 这一块不是当前落点） */
  dropEdge: 'before' | 'after' | null
  /** 已经在最前 / 最后，对应的箭头置灰 */
  isFirst: boolean
  isLast: boolean
  onChange: (srcIdx: number, field: 'en' | 'cn', value: string) => void
  onRemove: (srcIdx: number) => void
  /** 上移 / 下移一位（dir = -1 / +1）—— 不想拖的时候用这个 */
  onMoveUnit: (srcIdx: number, dir: -1 | 1) => void
  /** 改块类型（只支持文字家族，见 EDIT_TYPE_OPTIONS） */
  onChangeType: (srcIdx: number, value: string) => void
  onDragStartUnit: (srcIdx: number, clientY: number) => void
  onDragEndUnit: () => void
}) {
  const rowsFor = (s: string) => Math.min(24, Math.max(2, Math.ceil(s.length / 56)))
  const typeValue = editTypeValueOf(unit.node)
  return (
    <div
      data-unit-card
      className={`relative bg-paper-50 rounded-xl shadow-sm border p-3 transition ${
        dragging ? 'opacity-40 border-seal-300' : 'border-ink-200'
      }`}
    >
      {/* 落点提示：一条 3px 的横杠，插在上面还是下面看得清清楚楚 */}
      {dropEdge === 'before' && (
        <span className="absolute -top-[3px] left-2 right-2 h-[3px] rounded-full bg-seal-500 pointer-events-none" />
      )}
      {dropEdge === 'after' && (
        <span className="absolute -bottom-[3px] left-2 right-2 h-[3px] rounded-full bg-seal-500 pointer-events-none" />
      )}

      <div className="flex items-center justify-between mb-2 gap-2">
        {/* 拖拽把手 = 撑满整行的一条横条（图标 + 块名 + 悬停提示）。
            以前只有那个 10px 的小点能按，很难点中；现在整行高度、从图标到右侧按钮前面
            全是可拖区，横向也基本吃满。 */}
        <div
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            // Firefox 不 setData 就当成拖拽没发生
            e.dataTransfer.setData('text/plain', String(unit.srcIdx))
            // 整个卡片当拖影（默认只有那个小手柄，太小看不清在拖什么）
            const card = (e.currentTarget as HTMLElement).closest('[data-unit-card]')
            if (card) e.dataTransfer.setDragImage(card as HTMLElement, 24, 14)
            onDragStartUnit(unit.srcIdx, e.clientY)
          }}
          onDragEnd={onDragEndUnit}
          className="group flex flex-1 items-center gap-2 min-w-0 min-h-[2.25rem] px-2 py-1.5
                     rounded-md border border-dashed border-ink-200/80 cursor-grab active:cursor-grabbing
                     select-none hover:bg-paper-100 hover:border-ink-300 transition"
          title="按住这条横条上下拖：拖多远就挪几位（不用拖到目标块的一半）"
        >
          <span className="text-ink-300 group-hover:text-ink-500 text-base leading-none transition">⠿</span>
          <span className="text-xs font-medium text-ink-400 tabular-nums truncate">{labelOf(unit.node)}</span>
          <span className="ml-auto pr-1 text-[11px] text-ink-300 opacity-0 group-hover:opacity-100 transition whitespace-nowrap">
            按住拖动换位
          </span>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {/* 改类型：只给文字家族（图/表/公式/引文那些牵动编号与译文语义，不给改） */}
          {typeValue && (
            <select
              value={typeValue}
              onChange={(e) => onChangeType(unit.srcIdx, e.target.value)}
              className="h-6 text-[11px] border border-ink-200 rounded-md px-1 bg-paper-50 text-ink-600
                         hover:border-ink-300 focus:outline-none focus:ring-2 focus:ring-seal-200 cursor-pointer"
              title="这一块实际是什么类型（标题认成正文了就在这里改）"
            >
              {EDIT_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => onMoveUnit(unit.srcIdx, -1)}
            disabled={isFirst}
            className="w-6 h-6 flex items-center justify-center rounded-md border border-ink-200 text-ink-500
                       hover:bg-paper-100 hover:text-seal-600 disabled:opacity-25 disabled:cursor-not-allowed transition"
            title="上移一位"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => onMoveUnit(unit.srcIdx, 1)}
            disabled={isLast}
            className="w-6 h-6 flex items-center justify-center rounded-md border border-ink-200 text-ink-500
                       hover:bg-paper-100 hover:text-seal-600 disabled:opacity-25 disabled:cursor-not-allowed transition"
            title="下移一位"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={() => onRemove(unit.srcIdx)}
            className="ml-1 text-xs text-ink-400 hover:text-red-600 transition"
            title="删掉这一块（中英一起删，保存后生效）"
          >
            删除该块
          </button>
        </div>
      </div>

      <textarea
        value={unit.en}
        onChange={(e) => onChange(unit.srcIdx, 'en', e.target.value)}
        rows={rowsFor(unit.en)}
        spellCheck={false}
        className="w-full px-3 py-2 text-sm leading-relaxed border border-ink-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-seal-200 resize-y"
      />

      {unit.translatable ? (
        <textarea
          value={unit.cn}
          onChange={(e) => onChange(unit.srcIdx, 'cn', e.target.value)}
          rows={rowsFor(unit.cn)}
          spellCheck={false}
          placeholder="（这块还没有译文，留空即视为没有译文）"
          className="mt-2 w-full px-3 py-2 text-sm leading-relaxed border border-ink-200 rounded-lg bg-paper-100/60 focus:outline-none focus:ring-2 focus:ring-seal-200 resize-y"
        />
      ) : (
        <p className="mt-2 text-xs text-ink-400">这一块按语法不翻译（图 / 公式 / 文献）。</p>
      )}
    </div>
  )
})

interface Annotation {
  id: string
  text: string
  color: HighlightColor
  note: string
  createdAt: number
  /**
   * 块锚点：语言-段号（en-12 / cn-12）。
   * 中文和英文是两个独立的块（只是段号相同），所以批注必须分别锚在具体语言上。
   * 历史数据为空 → 退化成"全篇按文本匹配"，但仍能正常显示。
   */
  anchor: string
}

interface Paper {
  id: string
  title: string
  authors: string
  journal: string
  year: string
  keywords: string[]
  doi: string
  /** 有成品 {slug}.md = 可以读（以前这个字段是"点开过才回填"，导致筛选形同虚设） */
  hasMarkdown: boolean
  /** 一级 / 二级文献 */
  tier: 1 | 2
  /** 所属分类 id（literatures/categories.csv 反查得到） */
  categoryIds: string[]
  markdownContent?: string
}

interface SaveState {
  status: 'saved' | 'saving' | 'idle' | 'error'
  lastSaved: number | null
}

function literatureToPaper(lit: Literature, categoryIds: string[] = []): Paper {
  return {
    id: lit.doi,
    title: lit.title,
    authors: lit.authors,
    journal: lit.journal,
    year: String(lit.year),
    keywords: lit.keywords ? lit.keywords.split(',').map(k => k.trim()).filter(Boolean) : [],
    doi: lit.doi,
    hasMarkdown: lit.mdStatus === 'done',
    tier: lit.tier === 2 ? 2 : 1,
    categoryIds,
    markdownContent: undefined,
  }
}

/**
 * 图书正文：给**顶层块**编号（b-1 / b-2 …），让批注能锚到具体段落。
 *
 * 图书是单一语言，不需要 en/cn 前缀，但同样要"一处一条、不跨书串"——
 * 只靠文本匹配的话，短句子在别的书里也会命中。
 * 只编顶层元素：那是 markdown 渲染出的段落 / 标题 / 图表，正好是阅读时的自然单位。
 */
function withBookBlockIds(html: string): string {
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

/** 图书大纲项：level 决定缩进，anchor 指向正文里对应标题的 id */
interface OutlineItem {
  level: number
  text: string
  anchor: string
}

/**
 * 给渲染后的 HTML 里的 h1~h6 注入 id，并顺带抽出一份大纲。
 * 用递增序号做 id（book-h-N）—— 标题文本可能重复或含特殊字符，用文本当锚点会撞。
 */
function buildOutlineAndAnchors(html: string): { html: string; outline: OutlineItem[] } {
  const outline: OutlineItem[] = []
  let seq = 0
  const withIds = html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi, (_m, lv: string, attrs: string, inner: string) => {
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
  })
  return { html: withIds, outline }
}

const HIGHLIGHT_COLORS: { value: HighlightColor; label: string; bg: string; border: string; text: string; dot: string; ring: string }[] = [
  { value: 'yellow', label: '黄色', bg: 'bg-yellow-200/70', border: 'border-l-yellow-400 bg-yellow-50', text: 'text-yellow-700', dot: 'bg-yellow-400', ring: 'ring-yellow-400' },
  { value: 'green', label: '绿色', bg: 'bg-green-200/70', border: 'border-l-green-400 bg-green-50', text: 'text-green-700', dot: 'bg-green-400', ring: 'ring-green-400' },
  { value: 'blue', label: '蓝色', bg: 'bg-blue-200/70', border: 'border-l-blue-400 bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-400', ring: 'ring-blue-400' },
  { value: 'purple', label: '紫色', bg: 'bg-purple-200/70', border: 'border-l-purple-400 bg-purple-50', text: 'text-purple-700', dot: 'bg-purple-400', ring: 'ring-purple-400' },
  { value: 'red', label: '红色', bg: 'bg-red-200/70', border: 'border-l-red-400 bg-red-50', text: 'text-red-700', dot: 'bg-red-400', ring: 'ring-red-400' },
]



function formatDate(timestamp: number): string {
  const d = new Date(timestamp)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function exportMarkdown(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function getImageBaseUrl(doi: string): string {
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
function getPlainImageBaseUrl(ownerDir: string, root: 'textbooks' | 'documents'): string {
  const auth = useAuthStore.getState()
  const ws = useWorkspaceStore.getState()
  if (!auth.user || !ws.repo) return ''
  const owner = encodeURIComponent(auth.user.login)
  const repo = encodeURIComponent(ws.repo.name)
  const dir = ownerDir.split('/').map(encodeURIComponent).join('/')
  return `https://api.github.com/repos/${owner}/${repo}/contents/${root}/${dir}/`
}

/**
 * 预加载图片：把 GitHub Contents API 的图片 URL fetch 成 Blob，再转成 blob: URL
 * 这样可以带 Accept: application/vnd.github.v3.raw + token header
 * 不走 raw.githubusercontent.com（GFW 会挡）
 */
async function preloadImage(
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
async function hydrateImages(container: HTMLElement, token: string, authMode: 'header' | 'query') {
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

function getColorInfo(color: HighlightColor) {
  return HIGHLIGHT_COLORS.find((c) => c.value === color) || HIGHLIGHT_COLORS[0]
}

/** 简易弹窗：阅读页只用它承载「导入文档」（和管理页那个是同一套视觉） */
function Modal({ title, onClose, children, width = 'max-w-2xl' }: { title: string; onClose: () => void; children: React.ReactNode; width?: string }) {
  return (
    <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center z-50 p-4">
      <div className={`bg-paper-50 rounded-2xl shadow-xl w-full ${width} max-h-[90vh] overflow-hidden flex flex-col`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-ink-200">
          <h3 className="font-semibold text-ink-800">{title}</h3>
          <button onClick={onClose} className="p-1 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded-lg transition">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 py-5 overflow-y-auto flex-1">{children}</div>
      </div>
    </div>
  )
}

export default function ReadingPage() {
  const { repo } = useWorkspaceStore()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const location = useLocation()
  /** 管理页的"眼睛"按钮带过来的目标对象：paper:<doi> / book:<书名> / document:<目录名> */
  const docParam = searchParams.get('doc')
  /** ?q= 检索词：从别处（管理页检索结果）跳进来时，正文要滚到命中处并高亮 */
  const qParam = searchParams.get('q')
  const [papers, setPapers] = useState<Paper[]>([])
  const [papersLoading, setPapersLoading] = useState(true)
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null)
  const [activeSideTab, setActiveSideTab] = useState<SideTab>('notes')
  const [searchQuery, setSearchQuery] = useState('')
  // ── 全文检索（库内所有正文，不只是元数据） ──
  /** 检索结果；null = 没在检索模式（左栏显示普通列表） */
  const [ftResults, setFtResults] = useState<SearchHit[] | null>(null)
  /** 已提交的检索词（输入框里改了但没按 Enter 时，结果面板仍显示上一次的） */
  const [ftQuery, setFtQuery] = useState('')
  const [ftLoading, setFtLoading] = useState(false)
  const [ftProgress, setFtProgress] = useState({ done: 0, total: 0 })
  /**
   * 待定位到正文的检索请求。
   * 带 key 是为了只在"结果对应的那篇文档"里高亮 —— 用户随后点别的文档时，
   * key 对不上就自然不高亮，不用额外去清理。
   */
  const [findTarget, setFindTarget] = useState<{ key: string; q: string; n: number } | null>(null)
  /** 同一个请求只自动滚一次，滚完用户自己翻页不会被拽回去 */
  const findScrolledRef = useRef('')
  const [filterType, setFilterType] = useState<FilterType>('all')
  const [fontSize, setFontSize] = useState(16)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [currentNoteMd, setCurrentNoteMd] = useState('')
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | null>(null)
  const [showToolbar, setShowToolbar] = useState(false)
  const [toolbarPosition, setToolbarPosition] = useState({ top: 0, left: 0 })
  const [selectedText, setSelectedText] = useState('')
  const [noteSaveState, setNoteSaveState] = useState<SaveState>({ status: 'idle', lastSaved: null })
  const [annotationSaveState, setAnnotationSaveState] = useState<SaveState>({ status: 'idle', lastSaved: null })
  const [translation_mode, set_translation_mode] = useState<TranslationMode>('original')
  const [translation_content, set_translation_content] = useState('')
const [aligned_content, set_aligned_content] = useState('')
  /** 编辑模式开关：开启后才允许改文献正文 */
  const [editMode, setEditMode] = useState(false)
  /** 编辑态：原始条目（含译文块与块外文本），保存时按它还原结构 */
  const [editItems, setEditItems] = useState<Array<Record<string, any>>>([])
  /** 编辑态：按块切好的单元列表（界面就渲染这个） */
  const [editUnits, setEditUnits] = useState<EditUnit[]>([])
  /** 编辑态兜底：这份文件一个块都没有（还没转出 {slug}.md，只有 MinerU 的 full.md）时，按整篇改 */
  const [editPlainDraft, setEditPlainDraft] = useState('')
  /** 保存不同阶段的文案（写盘 / 清理旧文件），省得用户以为卡死了 */
  const [articleSavingMsg, setArticleSavingMsg] = useState('')
  const [articleSaving, setArticleSaving] = useState(false)
  /** 保存后的核对结论（块数变化 / 编号重排 / 哪些块丢了译文），可手动关掉 */
  const [editReport, setEditReport] = useState<string | null>(null)
  /**
   * 编辑态拖拽换位。正在拖哪一块用 ref 记 —— 事件回调要读到最新值，
   * 又不能让回调跟着重新生成（一生成，一两百张卡片就全体重渲染）；
   * state 只管画：哪块变淡、插入横杠画在谁身上。
   */
  const editDragSrcRef = useRef<number | null>(null)
  /** 拖起来那一刻的快照：数组下标 / 起始指针 Y / 当时的顺序（拖拽期间列表不会变） */
  const editDragFromRef = useRef<number | null>(null)
  const editDragStartYRef = useRef(0)
  const editDragOrderRef = useRef<number[]>([])
  /** 当前预览的位移（±N 位），松手时照它落位 */
  const editDropStepsRef = useRef(0)
  const [editDragSrcIdx, setEditDragSrcIdx] = useState<number | null>(null)
  const [editDropHint, setEditDropHint] = useState<{ srcIdx: number; edge: 'before' | 'after' } | null>(null)
  /** 给「身份必须稳定」的回调读当前单元列表用（直接闭包 editUnits 会让回调每次重建） */
  const editUnitsRef = useRef<EditUnit[]>([])
  useEffect(() => { editUnitsRef.current = editUnits }, [editUnits])

  // 图书阅读（按书名；正文取自 textbooks/{书名}/content.md）
  const [docType, setDocType] = useState<DocType>('paper')
  const [books, setBooks] = useState<BookSummary[]>([])
  const [booksLoading, setBooksLoading] = useState(true)
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null)
  const [bookMarkdown, setBookMarkdown] = useState('')
  const [bookLoading, setBookLoading] = useState(false)

  // 其他文档阅读（用户自己导入的 markdown，正文取自 documents/{目录名}/content.md）
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [documentsLoading, setDocumentsLoading] = useState(true)
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null)
  const [docMarkdown, setDocMarkdown] = useState('')
  const [docLoading, setDocLoading] = useState(false)

  // ── 统一筛选：分类（三类各自的表）+ 有无 md + 文献一级/二级 ──
  const [paperCategories, setPaperCategories] = useState<LiteratureCategory[]>([])
  const [bookCategories, setBookCategories] = useState<Category[]>([])
  const [documentCategories, setDocumentCategories] = useState<Category[]>([])
  /** 'all' 或分类 id；切换阅读对象时重置，否则会拿上一类的分类去筛这一类 */
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [tierFilter, setTierFilter] = useState<TierFilter>('all')
  /**
   * 筛选菜单：菜单里先选"草稿"，点「确定」才作用到列表上并折叠。
   * 草稿每次打开时从已生效的值重新播种，所以关掉菜单 = 放弃这次的选择。
   */
  const [filterOpen, setFilterOpen] = useState(false)
  const [draftCategory, setDraftCategory] = useState('all')
  const [draftMd, setDraftMd] = useState<FilterType>('all')
  const [draftTier, setDraftTier] = useState<TierFilter>('all')
  const filterMenuRef = useRef<HTMLDivElement>(null)
  /** 左栏大纲面板展开态（文献 / 图书共用） */
  const [outlineOpen, setOutlineOpen] = useState(true)
  const [listExpanded, setListExpanded] = useState(true)

  /**
   * 窄屏（<1100px）抽屉开合。
   * 宽屏下三栏是并排的，这两个状态只是 `max-[1100px]:` 的类名开关，不参与宽屏布局；
   * 宽屏时遮罩本身是 hidden，所以即使状态残留也不会挡住画面。
   */
  const [leftDrawer, setLeftDrawer] = useState(false)
  const [rightDrawer, setRightDrawer] = useState(false)

  // ── 阅读页直接导入其他文档（不绕去管理页；写的是同一份 documents/ 数据） ──
  const [showImportDocModal, setShowImportDocModal] = useState(false)
  const [importMode, setImportMode] = useState<'file' | 'paste' | 'zip'>('file')
  const [pasteDoc, setPasteDoc] = useState({ title: '', content: '' })
  const [importing, setImporting] = useState(false)

  const readerRef = useRef<HTMLDivElement>(null)
  const noteVditorRef = useRef<VditorEditorHandle>(null)
  const noteSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const annotationSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const annotationEditRefs = useRef<{ [key: string]: HTMLTextAreaElement | null }>({})
  /** 当前选区落在哪个块上（en-12 / cn-12）—— 划词时记下，加批注时用 */
  const pendingAnchorRef = useRef('')
  /** 批注面板的批量选择态 */
  const [checkedAnnotationIds, setCheckedAnnotationIds] = useState<string[]>([])
  /** 长文本隔块底色（荧光笔式交替底色，防串行） */
  const [zebraBands, setZebraBands] = useState(true)

  // ── 阅读进度：读到哪个标题，下次打开跳回去 ──
  /** 正文的滚动容器（文献 / 图书各一处，共用同一个 ref） */
  const scrollRef = useRef<HTMLDivElement>(null)
  const progressSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 回填进度时是我们自己在滚，不能被当成用户滚动 */
  const restoringRef = useRef(false)
  /** 用户一旦手动滚过，就不再自动回填（否则图片加载完会被拽回去） */
  const userScrolledRef = useRef(false)
  const scrollRafRef = useRef(0)
  /**
   * 当前读到的标题（锚点 + 文本 + 层级）。
   * 文本必须在"当时那个模式"的 DOM 上取：切模式会重渲染，之后再回头取会取到另一段的文本。
   */
  const activeHeadingRef = useRef<{ anchor: string; heading: string; level: number } | null>(null)
  /** 进度是否已加载完 —— 没加载完就落盘，会拿默认值把上次的记录覆盖掉 */
  const progressLoadedRef = useRef(false)
  /** 我们自己恢复出来的模式不算"用户改了模式"，不能因此把进度写回去 */
  const restoringModeRef = useRef(false)
  const [savedProgress, setSavedProgress] = useState<ReadingProgress | null>(null)
  /** 当前视口顶部所在的标题锚点 —— 用来在大纲里标出读到哪了 */
  const [activeAnchor, setActiveAnchor] = useState('')

  const isBook = docType === 'book'
  const isDoc = docType === 'document'
  /**
   * 「单语言纯 markdown」阅读路径：图书和其他文档都走这条（正文直接渲染，没有 en/cn 双块）。
   * 文献走的是另一条（aligned 块文档 + 原文/译文/对照三种模式），两条路的渲染、大纲、
   * 进度回填、图片 hydrate 都不同，所以这里必须分清楚。
   */
  const isPlain = isBook || isDoc
  /** 当前单语言对象的主键（图书 = 书名，文档 = 目录名） */
  const plainId = isBook ? selectedBookId : isDoc ? selectedDocumentId : null
  /** 当前单语言对象的正文 */
  const plainMarkdown = isBook ? bookMarkdown : isDoc ? docMarkdown : ''
  const plainLoading = isBook ? bookLoading : isDoc ? docLoading : false

  /** 切换阅读对象时把分类筛选清掉（三类的分类表不是同一套） */
  useEffect(() => {
    setCategoryFilter('all')
    setTierFilter('all')
  }, [docType])

  /**
   * 当前阅读对象的统一标识：文献按 DOI、图书按书名、其他文档按目录名。
   * 三者除了 pipeline 之外完全对称，笔记 / 批注 / 问 AI 的存储路径都由它决定。
   */
  const docRef: DocRef | null = useMemo(() => {
    if (isBook) return selectedBookId ? { kind: 'book', id: selectedBookId } : null
    if (isDoc) return selectedDocumentId ? { kind: 'document', id: selectedDocumentId } : null
    return selectedPaperId ? { kind: 'paper', id: selectedPaperId } : null
  }, [isBook, isDoc, selectedBookId, selectedDocumentId, selectedPaperId])
  const docKey = docRef ? `${docRef.kind}:${docRef.id}` : ''

  useEffect(() => {
    if (!repo) return
    let cancelled = false
    async function loadPapers() {
      try {
        // 文献分类与列表一起取：列表项要按分类筛，也要显示归属
        const [lits, cats] = await Promise.all([
          loadLiteratures(),
          loadPaperCategories().catch(() => [] as LiteratureCategory[]),
        ])
        if (!cancelled) {
          setPaperCategories(cats)
          const catIdsOf = (doi: string) =>
            cats.filter((c) => c.dois.includes(doi)).map((c) => c.id)
          const paperList = lits.map((l) => literatureToPaper(l, catIdsOf(l.doi)))
          setPapers(paperList)
          // 默认打开第一篇；但如果 URL 指名了要读哪篇，就别抢，等参数生效
          if (paperList.length > 0 && !docParam?.startsWith('paper:')) {
            setSelectedPaperId(paperList[0].id)
          }
        }
      } catch (err) {
        console.error('[Reading] 加载文献列表失败:', err)
      } finally {
        if (!cancelled) setPapersLoading(false)
      }
    }
    loadPapers()
      return () => { cancelled = true }
    }, [repo])

  // 图书列表：textbooks/ 下的一级目录即书名
  useEffect(() => {
    if (!repo) return
    let cancelled = false
    setBooksLoading(true)
    listBooks()
      .then((list) => { if (!cancelled) setBooks(list) })
      .catch((err) => console.error('[Reading] 加载图书列表失败:', err))
      .finally(() => { if (!cancelled) setBooksLoading(false) })
    return () => { cancelled = true }
  }, [repo])

  // 其他文档列表：documents/documents.csv 索引 + documents/ 下的目录（两边取并集）
  useEffect(() => {
    if (!repo) return
    let cancelled = false
    setDocumentsLoading(true)
    listDocuments()
      .then((list) => { if (!cancelled) setDocuments(list) })
      .catch((err) => console.error('[Reading] 加载其他文档失败:', err))
      .finally(() => { if (!cancelled) setDocumentsLoading(false) })
    return () => { cancelled = true }
  }, [repo])

  /**
   * 应用 URL 里的 ?doc= 参数（管理页"眼睛"按钮的落地）。
   * 三个列表都是异步来的，所以要等对应那份列表到位再选中。
   * 用 location.key 而不是布尔量：同一次导航只应用一次（用户在列表里换对象不被拽回去），
   * 但下一次从管理页点进来（新 key）必须重新生效 —— 哪怕 ?doc= 和上次一模一样。
   */
  const docParamAppliedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!docParam || docParamAppliedRef.current === location.key) return
    const sep = docParam.indexOf(':')
    if (sep <= 0) { docParamAppliedRef.current = location.key; return }
    const kind = docParam.slice(0, sep)
    const id = docParam.slice(sep + 1)
    if (!id) { docParamAppliedRef.current = location.key; return }
    let resolvedId: string | null = null
    if (kind === 'paper') {
      if (papersLoading) return
      setDocType('paper')
      // 找不到就退回第一篇（可能是被删了 / DOI 变了），别留一个空壳在页面上
      resolvedId = papers.some((p) => p.id === id) ? id : (papers[0]?.id ?? null)
      setSelectedPaperId(resolvedId)
    } else if (kind === 'book') {
      if (booksLoading) return
      setDocType('book')
      resolvedId = books.some((b) => b.id === id) ? id : (books[0]?.id ?? null)
      setSelectedBookId(resolvedId)
    } else if (kind === 'document') {
      if (documentsLoading) return
      setDocType('document')
      resolvedId = documents.some((d) => d.id === id) ? id : (documents[0]?.id ?? null)
      setSelectedDocumentId(resolvedId)
    } else {
      docParamAppliedRef.current = location.key
      return
    }
    docParamAppliedRef.current = location.key
    // 带 ?q= 进来（管理页全文检索结果跳转）→ 交给正文高亮并滚动定位
    if (qParam && resolvedId) {
      setFindTarget((prev) => ({ key: `${kind}:${resolvedId}`, q: qParam, n: (prev?.n ?? 0) + 1 }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docParam, qParam, location.key, papers, papersLoading, books, booksLoading, documents, documentsLoading])

  /** 点漏斗开合筛选菜单；打开时把"已生效的筛选"播种成草稿，关掉就等于放弃这次选择 */
  const toggleFilterMenu = () => {
    if (filterOpen) {
      setFilterOpen(false)
      return
    }
    setDraftCategory(categoryFilter)
    setDraftMd(filterType)
    setDraftTier(tierFilter)
    setFilterOpen(true)
  }

  /** 点菜单外面 / 按 Esc 收起（不应用） */
  useEffect(() => {
    if (!filterOpen) return
    const onDown = (e: MouseEvent) => {
      if (filterMenuRef.current && !filterMenuRef.current.contains(e.target as Node)) setFilterOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFilterOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [filterOpen])

  /** 确定：草稿转正 + 折叠 */
  const applyFilterDraft = () => {
    setCategoryFilter(draftCategory)
    setFilterType(draftMd)
    setTierFilter(draftTier)
    setFilterOpen(false)
  }

  /** 重置（只清草稿，点确定才生效） */
  const resetFilterDraft = () => {
    setDraftCategory('all')
    setDraftMd('all')
    setDraftTier('all')
  }

  /** 漏斗上的角标：已生效的维度个数（文档没有"有无 md"这一维） */
  const activeFilterCount =
    (categoryFilter !== 'all' ? 1 : 0) +
    (!isDoc && filterType !== 'all' ? 1 : 0) +
    (!isPlain && tierFilter !== 'all' ? 1 : 0)

  const chipCls = (active: boolean) =>
    `px-2 py-1 text-xs rounded-md border transition ${
      active
        ? 'bg-seal-50 border-seal-300 text-seal-700 font-medium'
        : 'bg-paper-50 border-ink-200 text-ink-600 hover:border-seal-300'
    }`

  // ── 阅读页内直接导入其他文档：走的是和管理页同一套服务，数据落在同一处 ──
  /** 导入后重新拉列表（写 CSV 时已刷缓存，不必 force） */
  const refreshDocuments = useCallback(async () => {
    try {
      setDocuments(await listDocuments())
    } catch (err) {
      console.error('[Reading] 刷新其他文档失败:', err)
    }
  }, [])

  /** 三种导入方式的公共出口：写仓库 → 刷新列表 → 直接打开刚导入的那份 */
  const runImport = async (items: ImportItem[]) => {
    if (importing) return
    const usable = items.filter((it) => it.content.trim())
    if (usable.length === 0) {
      toast.error('没有可导入的内容')
      return
    }
    setImporting(true)
    try {
      const added = await importMarkdownDocs(usable)
      toast.success(`已导入 ${added.length} 个文档`)
      await refreshDocuments()
      setShowImportDocModal(false)
      setPasteDoc({ title: '', content: '' })
      if (added[0]) setSelectedDocumentId(added[0].id)
    } catch (err) {
      toast.error(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setImporting(false)
    }
  }

  /** 上传本地 .md / .markdown / .txt（可多选，标题取文件名） */
  const handleImportFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const items: ImportItem[] = []
    for (const file of Array.from(files)) {
      items.push({ title: titleFromFileName(file.name), source: file.name, content: await file.text() })
    }
    await runImport(items)
  }

  /** 上传 zip 批量导入 */
  const handleImportZip = async (file: File | undefined) => {
    if (!file) return
    try {
      const entries = await readMarkdownZip(file)
      await runImport(
        entries.map((e) => ({ title: titleFromFileName(e.name), source: file.name, content: e.content })),
      )
    } catch (err) {
      toast.error(`解析 zip 失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 粘贴 markdown 文本 */
  const handlePasteImport = async () => {
    if (!pasteDoc.title.trim() || !pasteDoc.content.trim()) {
      toast.error('请填写标题和 markdown 内容')
      return
    }
    await runImport([{ title: pasteDoc.title, source: '粘贴', content: pasteDoc.content }])
  }

  // 图书分类 / 其他文档分类（各自一份表）
  useEffect(() => {
    if (!repo) return
    let cancelled = false
    loadBookCategories()
      .then((cats) => { if (!cancelled) setBookCategories(cats) })
      .catch((err) => console.error('[Reading] 加载图书分类失败:', err))
    loadDocumentCategories()
      .then((cats) => { if (!cancelled) setDocumentCategories(cats) })
      .catch((err) => console.error('[Reading] 加载文档分类失败:', err))
    return () => { cancelled = true }
  }, [repo])

  // 选中图书后加载整本正文
  useEffect(() => {
    if (!selectedBookId) {
      setBookMarkdown('')
      return
    }
    let cancelled = false
    setBookLoading(true)
    loadBookContent(selectedBookId)
      .then((md) => { if (!cancelled) setBookMarkdown(md) })
      .catch((err) => {
        console.error('[Reading] 加载图书正文失败:', err)
        if (!cancelled) setBookMarkdown('')
      })
      .finally(() => { if (!cancelled) setBookLoading(false) })
    return () => { cancelled = true }
  }, [selectedBookId])

  // 选中其他文档后加载正文
  useEffect(() => {
    if (!selectedDocumentId) {
      setDocMarkdown('')
      return
    }
    let cancelled = false
    setDocLoading(true)
    loadDocumentContent(selectedDocumentId)
      .then((md) => { if (!cancelled) setDocMarkdown(md) })
      .catch((err) => {
        console.error('[Reading] 加载文档正文失败:', err)
        if (!cancelled) setDocMarkdown('')
      })
      .finally(() => { if (!cancelled) setDocLoading(false) })
    return () => { cancelled = true }
  }, [selectedDocumentId])

  useEffect(() => {
    if (!selectedPaperId) {
      setSelectedAnnotationId(null)
      setEditingAnnotationId(null)
      set_translation_content('')
      set_aligned_content('')
      return
    }

    let cancelled = false
    const doi = selectedPaperId

    // 换文献 = 退出编辑模式，避免把上一篇的草稿写到这一篇
    setEditMode(false)
    setEditItems([])
    setEditUnits([])
    setEditPlainDraft('')

    async function loadPaperData() {
      try {
        const fulltext = await loadFulltext(doi)
        if (!cancelled) {
          setPapers(prev => prev.map(p =>
            p.id === doi
              ? { ...p, hasMarkdown: fulltext.length > 0, markdownContent: fulltext }
              : p
          ))
        }
      } catch (err) {
        console.error('[Reading] 加载全文失败:', err)
      }

      try {
        const aligned = await loadAlignedMd(doi)
        if (!cancelled) set_aligned_content(aligned || '')
      } catch (err) {
        console.error('[Reading] 加载 aligned.md 失败:', err)
        if (!cancelled) set_aligned_content('')
      }

      try {
        const trans = await loadTranslation(doi)
        if (!cancelled) set_translation_content(trans || '')
      } catch (err) {
        console.error('[Reading] 加载翻译失败:', err)
        if (!cancelled) set_translation_content('')
      }
    }

    loadPaperData()
    return () => { cancelled = true }
  }, [selectedPaperId])

  /**
   * 笔记 / 批注：按阅读对象（文献 or 图书）加载。
   * 两者的存储结构完全对称，只是根目录不同 —— 路径交给 docRef 决定。
   */
  useEffect(() => {
    // 换阅读对象 = 清掉上一份的选中态，批注绝不能跨对象带过去
    setCheckedAnnotationIds([])
    setSelectedAnnotationId(null)
    setEditingAnnotationId(null)

    if (!docRef) {
      setAnnotations([])
      setCurrentNoteMd('')
      return
    }
    let cancelled = false

    loadAnnotations(docRef)
      .then((annData) => {
        if (cancelled) return
        setAnnotations(annData.map((a) => ({
          id: a.id,
          text: a.text,
          color: a.color as HighlightColor,
          note: a.note,
          createdAt: a.createdAt,
          anchor: a.anchor,
        })))
      })
      .catch((err) => {
        console.error('[Reading] 加载批注失败:', err)
        if (!cancelled) setAnnotations([])
      })

    loadNotes(docRef)
      .then((noteContent) => { if (!cancelled) setCurrentNoteMd(noteContent || '') })
      .catch((err) => {
        console.error('[Reading] 加载笔记失败:', err)
        if (!cancelled) setCurrentNoteMd('')
      })

    return () => { cancelled = true }
    // docKey 唯一标识对象；docRef 每次渲染都是新对象，不能进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey])

  const saveAnnotationsToStorage = useCallback((newAnnotations: Annotation[]) => {
    if (!docRef) return
    if (annotationSaveTimerRef.current) {
      clearTimeout(annotationSaveTimerRef.current)
    }
    setAnnotationSaveState({ status: 'saving', lastSaved: null })
    annotationSaveTimerRef.current = setTimeout(() => {
      const data: AnnotationData[] = newAnnotations.map(a => ({
        id: a.id,
        type: 'highlight',
        color: a.color as AnnotationData['color'],
        text: a.text,
        note: a.note,
        createdAt: a.createdAt,
        updatedAt: Date.now(),
        anchor: a.anchor,
      }))
      // 必须等写入真的成功了才显示"已自动保存"。
      // 以前是先写状态、再发请求，失败只 console.error —— 界面说存好了，
      // 远端其实一个字没动，切走再回来批注就"冒出来"了。
      saveAnnotations(docRef, data)
        .then(() => {
          setAnnotationSaveState({ status: 'saved', lastSaved: Date.now() })
          setTimeout(() => {
            setAnnotationSaveState((prev) => (prev.status === 'saved' ? { ...prev, status: 'idle' } : prev))
          }, 2000)
        })
        .catch((err) => {
          console.error('[Reading] 保存批注到 GitHub 失败:', err)
          setAnnotationSaveState({ status: 'error', lastSaved: null })
          toast.error(`批注保存失败：${err?.message || err}`)
        })
    }, 500)
  }, [docRef])

  const saveNoteToStorage = useCallback((md: string) => {
    if (!docRef) return
    if (noteSaveTimerRef.current) {
      clearTimeout(noteSaveTimerRef.current)
    }
    setNoteSaveState({ status: 'saving', lastSaved: null })
    noteSaveTimerRef.current = setTimeout(() => {
      // 笔记本来就以 md 落盘：md 进 md 出，不再走 html↔md 的有损往返
      saveNotes(docRef, md).catch(err => console.error('[Reading] 保存笔记到 GitHub 失败:', err))
      setNoteSaveState({ status: 'saved', lastSaved: Date.now() })
      setTimeout(() => {
        setNoteSaveState((prev) => ({ ...prev, status: 'idle' }))
      }, 2000)
    }, 800)
  }, [docRef])

  const handleTextSelection = useCallback(() => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !readerRef.current) {
      setShowToolbar(false)
      return
    }

    const range = selection.getRangeAt(0)
    const text = selection.toString().trim()
    if (!text) {
      setShowToolbar(false)
      return
    }

    const readerRect = readerRef.current.getBoundingClientRect()
    const rect = range.getBoundingClientRect()

    // 记下选区落在哪个块上 —— 批注锚点是「语言-段号」，不是那串选中的字。
    // 锚到块上以后，同一处批注在原文/中英对照/全中文之间切换都还是同一条。
    const startEl =
      range.startContainer.nodeType === 1
        ? (range.startContainer as HTMLElement)
        : (range.startContainer.parentElement as HTMLElement | null)
    pendingAnchorRef.current =
      startEl?.closest('[data-block-id]')?.getAttribute('data-block-id') || ''

    setSelectedText(text)
    
    const toolbarWidth = 200
    let left = rect.left - readerRect.left + rect.width / 2 - toolbarWidth / 2
    left = Math.max(10, Math.min(left, readerRect.width - toolbarWidth - 10))
    
    let top = rect.top - readerRect.top - 48
    if (top < 10) {
      top = rect.bottom - readerRect.top + 8
    }

    setToolbarPosition({ top, left })
    setShowToolbar(true)
  }, [])

  const handleHighlight = (color: HighlightColor) => {
    if (!docRef || !selectedText) return

    const anchor = pendingAnchorRef.current
    setShowToolbar(false)
    setSelectedText('')
    window.getSelection()?.removeAllRanges()

    // 同一处再批一次 = 改那一条，不新增。
    // 判定口径（用户定）：锚点相同 **且选中文字一字不差相同** 才算同一条。
    // 同段里选另一句 —— 哪怕文字互相包含 —— 都是独立的一条，段内可随处批注。
    const dup = anchor
      ? annotations.find((a) => a.anchor === anchor && a.text === selectedText)
      : undefined

    if (dup) {
      const updated = annotations.map((a) => (a.id === dup.id ? { ...a, text: selectedText, color } : a))
      setAnnotations(updated)
      saveAnnotationsToStorage(updated)
      setActiveSideTab('annotations')
      setSelectedAnnotationId(dup.id)
      setEditingAnnotationId(dup.id)
      return
    }

    const newAnnotation: Annotation = {
      id: `anno-${Date.now()}`,
      text: selectedText,
      color,
      note: '',
      createdAt: Date.now(),
      anchor,
    }

    const newAnnotations = [...annotations, newAnnotation]
    setAnnotations(newAnnotations)
    saveAnnotationsToStorage(newAnnotations)
    setActiveSideTab('annotations')
    setSelectedAnnotationId(newAnnotation.id)
    setEditingAnnotationId(newAnnotation.id)
  }

  const deleteAnnotation = (id: string) => {
    const newAnnotations = annotations.filter((a) => a.id !== id)
    setAnnotations(newAnnotations)
    saveAnnotationsToStorage(newAnnotations)
    setCheckedAnnotationIds((prev) => prev.filter((x) => x !== id))
    if (selectedAnnotationId === id) {
      setSelectedAnnotationId(null)
    }
    if (editingAnnotationId === id) {
      setEditingAnnotationId(null)
    }
  }

  /** 批量删除（含"清空"）：一次写盘，避免逐条写互相覆盖 */
  const deleteAnnotations = (ids: string[]) => {
    if (ids.length === 0) return
    const idSet = new Set(ids)
    const newAnnotations = annotations.filter((a) => !idSet.has(a.id))
    setAnnotations(newAnnotations)
    saveAnnotationsToStorage(newAnnotations)
    setCheckedAnnotationIds((prev) => prev.filter((x) => !idSet.has(x)))
    if (selectedAnnotationId && idSet.has(selectedAnnotationId)) setSelectedAnnotationId(null)
    if (editingAnnotationId && idSet.has(editingAnnotationId)) setEditingAnnotationId(null)
    toast.success(`已删除 ${ids.length} 条批注`)
  }

  const updateAnnotationNote = (id: string, note: string) => {
    const newAnnotations = annotations.map((a) =>
      a.id === id ? { ...a, note } : a
    )
    setAnnotations(newAnnotations)
    saveAnnotationsToStorage(newAnnotations)
  }

  /** 分类筛选三类共用一个 state，但各自去自己的分类表里查归属 */
  const matchesCategory = (categoryIds: string[]) =>
    categoryFilter === 'all' || categoryIds.includes(categoryFilter)

  /**
   * 「有无 md」三类语义不同，同一个 state 各自解释：
   *   文献 = 有没有成品 {slug}.md；图书 = 有没有正文 content.md；其他文档导入的必然有，不参与。
   */
  const matchesMdFilter = (hasMd: boolean) =>
    filterType === 'all' ||
    (filterType === 'has-md' && hasMd) ||
    (filterType === 'no-md' && !hasMd)

  const filteredPapers = papers.filter((paper) => {
    if (!matchesMdFilter(paper.hasMarkdown)) return false
    if (tierFilter !== 'all' && paper.tier !== tierFilter) return false
    if (!matchesCategory(paper.categoryIds)) return false

    if (!searchQuery.trim()) return true

    const q = searchQuery.toLowerCase()
    return (
      paper.title.toLowerCase().includes(q) ||
      paper.authors.toLowerCase().includes(q) ||
      paper.journal.toLowerCase().includes(q) ||
      paper.year.toLowerCase().includes(q) ||
      paper.keywords.some((k) => k.toLowerCase().includes(q)) ||
      paper.doi.toLowerCase().includes(q)
    )
  })

  const selectedPaper = papers.find((p) => p.id === selectedPaperId)
  const paperAnnotations = annotations

  const selectedBook = books.find((b) => b.id === selectedBookId) || null
  const selectedDocument = documents.find((d) => d.id === selectedDocumentId) || null

  const matchSearch = (text: string) =>
    !searchQuery.trim() || text.toLowerCase().includes(searchQuery.trim().toLowerCase())

  const filteredBooks = books.filter(
    (b) =>
      matchSearch(b.title) &&
      matchesMdFilter(b.hasContent) &&
      matchesCategory(categoriesOfMember(bookCategories, b.id)),
  )

  const filteredDocuments = documents.filter(
    (d) => matchSearch(d.title) && matchesCategory(categoriesOfMember(documentCategories, d.id)),
  )

  /** 当前阅读对象的标题（导出文件名、问 AI 面板都用它） */
  const docTitle = isPlain
    ? ((isBook ? selectedBook?.title : selectedDocument?.title) ?? '')
    : (selectedPaper?.title ?? '')

  /**
   * 提交全文检索：把左栏切成结果面板。
   * 库内容没变时走内存索引，只检索、不重新下载；首次会先建索引（有进度提示）。
   */
  const runFullTextSearch = async () => {
    const q = searchQuery.trim()
    if (!q) { setFtResults(null); return }
    if (ftLoading) return
    setFtQuery(q)
    setFtLoading(true)
    setFtResults([])
    try {
      const hits = await searchLibrary(q, (done, total) => setFtProgress({ done, total }))
      setFtResults(hits)
    } catch (err) {
      toast.error(`全文检索失败：${err instanceof Error ? err.message : String(err)}`)
      setFtResults(null)
    } finally {
      setFtLoading(false)
    }
  }

  /** 点结果：切到对应阅读对象，并把检索词交给正文做高亮定位 */
  const openSearchHit = (hit: SearchHit) => {
    setDocType(hit.kind)
    if (hit.kind === 'paper') {
      setSelectedPaperId(hit.id)
      setSelectedAnnotationId(null)
      setEditingAnnotationId(null)
    } else if (hit.kind === 'book') {
      setSelectedBookId(hit.id)
    } else {
      setSelectedDocumentId(hit.id)
    }
    setFindTarget((prev) => ({ key: `${hit.kind}:${hit.id}`, q: ftQuery, n: (prev?.n ?? 0) + 1 }))
    setLeftDrawer(false)
  }

  /** 片段里的检索词包成 <mark>：split 带捕获组时，奇数位就是命中的词 */
  const renderSnippet = (text: string) => {
    const re = buildHighlightRegex(ftQuery)
    if (!re) return text
    return text.split(re).map((part, i) =>
      i % 2 === 1 ? (
        <mark key={i} className="bg-amber-200/70 text-ink-800 rounded-sm px-0.5">{part}</mark>
      ) : (
        <span key={i}>{part}</span>
      ),
    )
  }

  /** 单语言正文渲染 + 大纲（图书与其他文档同一条路）：标题注入 id 后按标题层级生成大纲 */
  const { html: bookRenderedHtml, outline: bookOutline } = useMemo(() => {
    if (!isPlain || !plainMarkdown.trim()) return { html: '', outline: [] as OutlineItem[] }
    const raw = renderMarkdownToHtml(plainMarkdown, {
      imageBaseUrl: getPlainImageBaseUrl(plainId ?? '', isDoc ? 'documents' : 'textbooks'),
    })
    return buildOutlineAndAnchors(withBookBlockIds(raw))
  }, [isPlain, isDoc, plainMarkdown, plainId])

  /** 点大纲跳到正文对应标题 */
  const jumpToAnchor = useCallback((anchor: string) => {
    const el = readerRef.current?.querySelector<HTMLElement>(`[id="${anchor}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActiveAnchor(anchor)
  }, [])

  /**
   * 批注排序用的"正文扁平纯文本"：按块顺序把原文与译文拼起来，去掉 markdown 标记、**去掉所有空白**。
   *
   * 用它而不是渲染后的 HTML —— 不受显示模式影响，选中英文原文或中文译文都能定到同一个位置，
   * 而且不用为了排序多渲染一遍全文。去空白是为了容错：批注文本里带着换行/连续空格，
   * 正文块里的空白排法又不一样，直接 indexOf 匹配不上会把已定位的批注误排到最后。
   */
  const articleFlatText = useMemo(() => {
    const flat = (s: string) =>
      s
        .replace(/<[^>]*>/g, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/[#*_`>|]/g, '')
        .replace(/\s+/g, '')
    if (isPlain) return flat(plainMarkdown)
    if (aligned_content.trim()) {
      const { items } = readAnyDocument(aligned_content)
      return flat(items.map((it) => (it.t === 'block' ? `${it.content} ${it.cn ?? ''}` : it.content)).join(' '))
    }
    return flat(selectedPaper?.markdownContent ?? '')
  }, [isPlain, plainMarkdown, aligned_content, selectedPaper])

  /**
   * 喂给右栏「问 AI」的正文。
   *
   * 原来直接把 aligned_content 原样丢过去 —— 那是**带块标记的**块文档，
   * 模型读到的是一堆 `⟨⟨⟨文字·正文·0·12⟩⟩⟩` 噪声，而且译文块也混在里面，
   * 同一段内容等于喂了两遍。走 blocksToAiText：只留原文、去标记、丢图块路径。
   * （图书/其他文档本来就没有块语法，原样传。）
   */
  const askSourceText = useMemo(() => {
    if (isPlain) return plainMarkdown
    const md = aligned_content.trim() || selectedPaper?.markdownContent || ''
    return md.trim() ? blocksToAiText(md) : ''
  }, [isPlain, plainMarkdown, aligned_content, selectedPaper])

  /**
   * 批注按**在正文中出现的先后**排序，而不是按录入先后 ——
   * 这样侧栏从上往下读的顺序，和正文从上往下读的顺序是同一套位置。
   * 定位不到的（正文里已找不到原句，比如重新转换过）排在最后，内部按时间排。
   */
  const orderedAnnotations = useMemo(() => {
    const flat = (s: string) => s.replace(/[#*_`>|]/g, '').replace(/\s+/g, '')
    /** 排序键：段号 → 语言（英文在前）→ 段内偏移。没锚点的老批注按全文位置排。 */
    const key = (a: Annotation): [number, number, number] => {
      const off = flat(a.text || '').length ? articleFlatText.indexOf(flat(a.text || '')) : -1
      const m = /^(en|cn)-(.+)$/.exec(a.anchor || '')
      if (!m) return [off < 0 ? 1e9 : 5e8 + off, 0, 0]
      const n = parseInt(m[2].replace(/\D/g, ''), 10)
      return [isNaN(n) ? 1e9 : n, m[1] === 'en' ? 0 : 1, off < 0 ? 1e9 : off]
    }
    return paperAnnotations.slice().sort((a, b) => {
      const ka = key(a)
      const kb = key(b)
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2] || a.createdAt - b.createdAt
    })
  }, [paperAnnotations, articleFlatText])

  /**
   * 批注 → 它所属的块锚点（en-12 / cn-12）。
   * 优先用批注自己记下的锚点（准确）；老数据没有锚点 → 退回按文本在块里找一次，
   * 只为了"点批注能跳到对应段落"。
   */
  const annotationBlockIds = useMemo(() => {
    const map = new Map<string, string>()
    const needFallback = paperAnnotations.filter((a) => !a.anchor)
    if (needFallback.length > 0 && aligned_content.trim()) {
      const norm = (s: string) => String(s ?? '').replace(/[#*_`>|]/g, '').replace(/\s+/g, '')
      const { items } = readAnyDocument(aligned_content)
      const blocks = items.filter((it): it is ReadBlockItem => it.t === 'block')
      for (const a of needFallback) {
        const needle = norm(a.text || '')
        if (!needle) continue
        const hit = blocks.find((b) => norm(b.content).includes(needle) || norm(b.cn ?? '').includes(needle))
        if (!hit) continue
        const id = blockId(hit.node)
        if (!id) continue
        const lang = norm(hit.content).includes(needle) ? 'en' : 'cn'
        map.set(a.id, `${lang}-${id}`)
      }
    }
    for (const a of paperAnnotations) {
      if (a.anchor) map.set(a.id, a.anchor)
    }
    return map
  }, [aligned_content, paperAnnotations])

  /**
   * 已带批注的块锚点集合。
   * 传给渲染器：当前显示模式不展示的那种语言，只要有批注就把那块一起显示出来，
   * 这样切模式不会让批注失去落点（用户也就不会以为丢了、又批一次）。
   */
  const annotatedAnchorKey = useMemo(
    () => Array.from(new Set(annotations.map((a) => a.anchor).filter(Boolean))).sort().join(','),
    [annotations],
  )
  const annotatedAnchorSet = useMemo<ReadonlySet<string>>(
    () => new Set(annotatedAnchorKey ? annotatedAnchorKey.split(',') : []),
    [annotatedAnchorKey],
  )

  /**
   * 译文到底有没有 —— 以结构化块文档里"带译文的可翻译块数 > 0"为准。
   * 旧的 translation.md 只作兜底（老文献走的还是旧路径）。
   * 这条决定了工具栏那个"原文/中英对照/全中文"按钮显不显示「（未生成）」。
   */
  const hasTranslationContent = useMemo(() => {
    if (aligned_content.trim()) {
      const { items } = readAnyDocument(aligned_content)
      return items.some((it) => it.t === 'block' && !!it.cn && !!it.cn.trim())
    }
    return !!translation_content.trim()
  }, [aligned_content, translation_content])

  const rendered_html = useMemo(() => {
    const opts = { imageBaseUrl: getImageBaseUrl(selectedPaperId ?? '') }

    // 新路径：有 aligned.md → 确定性 idx 对齐渲染
    if (aligned_content.trim()) {
      const result = renderAlignedMdHtml(aligned_content, translation_mode, opts, annotatedAnchorSet)
      if (result.html.trim()) return result.html
    }

    // 旧路径 fallback：fulltext.md + translation.md + 启发式对齐
    if (!selectedPaper?.markdownContent) return ''

    if (
      translation_mode === 'original' ||
      translation_mode === 'english' ||
      !translation_content.trim()
    ) {
      return renderMarkdownToHtml(selectedPaper.markdownContent, opts)
    }
    const orig_paras = splitMarkdownIntoParagraphs(selectedPaper.markdownContent)
    const trans_paras = splitMarkdownIntoParagraphs(translation_content)
    const aligned = alignParagraphs(orig_paras, trans_paras)
    return renderAlignedHtml(aligned, translation_mode, opts)
  }, [selectedPaper, selectedPaperId, aligned_content, translation_content, translation_mode, annotatedAnchorSet])

  /**
   * 文献正文注入锚点 + 大纲。
   * 基于 rendered_html（= 当前显示模式渲染出来的内容）：切到「全中文」时大纲也是中文标题，
   * 保证点大纲一定跳得到当前看到的那个位置。
   */
  const { html: paperRenderedHtml, outline: paperOutline } = useMemo(() => {
    if (isPlain || !rendered_html.trim()) {
      return { html: rendered_html, outline: [] as OutlineItem[] }
    }
    return buildOutlineAndAnchors(rendered_html)
  }, [isPlain, rendered_html])

  /** 左栏大纲：文献 / 图书 / 其他文档共用同一个面板，内容按当前阅读对象取 */
  const outline = isPlain ? bookOutline : paperOutline

  // ── 阅读进度 ──
  // 换对象 → 取出上次读到哪个标题（清掉上一本的定时器，别把进度写到新对象上）
  useEffect(() => {
    if (progressSaveTimerRef.current) clearTimeout(progressSaveTimerRef.current)
    restoringRef.current = false
    userScrolledRef.current = false
    progressLoadedRef.current = false
    activeHeadingRef.current = null
    setSavedProgress(null)
    setActiveAnchor('')
    if (!docRef) return
    let cancelled = false
    loadProgress(docRef)
      .then((p) => {
        if (cancelled) return
        setSavedProgress(p)
        // 到位之后才允许落盘：否则文档还没读出来就写，会拿默认值把上次的记录顶掉
        progressLoadedRef.current = true
        // 上次用的是哪种语言模式，一并恢复 —— 模式也是"读到哪儿"的一部分。
        // 这是恢复、不是用户改设置，打个标记免得立刻触发回写。
        if (p?.mode && TRANSLATION_MODES.includes(p.mode as TranslationMode)) {
          restoringModeRef.current = true
          set_translation_mode(p.mode as TranslationMode)
        }
      })
      .catch((err) => {
        console.error('[Reading] 加载阅读进度失败:', err)
        if (!cancelled) progressLoadedRef.current = true
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey])

  const outlineByAnchor = useMemo(() => {
    const m = new Map<string, OutlineItem>()
    outline.forEach((it) => m.set(it.anchor, it))
    return m
  }, [outline])

  /**
   * 当前读到的标题 = 视口顶部往上最近的那个标题。
   * 这天然就是「最低一级标题」：读到某个 H3 段落时，取到的是 H3 而不是它的 H2 父标题。
   */
  const pickCurrentHeading = useCallback((): HTMLElement | null => {
    const box = scrollRef.current
    const root = readerRef.current
    if (!box || !root) return null
    const boxTop = box.getBoundingClientRect().top
    let current: HTMLElement | null = null
    for (const h of Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'))) {
      if (h.getBoundingClientRect().top - boxTop <= 12) current = h
      else break
    }
    return current
  }, [])

  /** 把上次的进度滚回视野 */
  const restoreProgress = useCallback(() => {
    const box = scrollRef.current
    const root = readerRef.current
    if (!box || !root || !savedProgress) return
    // 用户已经自己滚了 → 让位，不再抢滚动条
    if (userScrolledRef.current) return
    // 这次进来是为了看**检索命中处**（不是接着上次读）→ 进度回填必须让位，
    // 否则 0/400/1200ms 那几次补滚会把检索定位顶掉
    if (findTarget && findTarget.key === docKey) return

    const norm = (s: string) => s.replace(/\s+/g, '').trim()
    const want = norm(savedProgress.heading || '')
    const headings = Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'))
    // 优先按标题文本找：锚点 id 是渲染时按顺序编的（book-h-N），切显示模式就会变
    let target = want ? headings.find((h) => norm(h.textContent ?? '') === want) : undefined
    if (!target && savedProgress.anchor) {
      target = root.querySelector<HTMLElement>(`[id="${savedProgress.anchor}"]`) ?? undefined
    }
    if (!target) return

    restoringRef.current = true
    box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top - 8
    setActiveAnchor(target.id)
    // 记下回填到的位置：用户接着换个显示模式时，要落盘的就是这个标题
    const item = outlineByAnchor.get(target.id)
    activeHeadingRef.current = {
      anchor: target.id,
      heading: item?.text ?? (target.textContent ?? '').trim(),
      level: item?.level ?? Number(target.tagName.slice(1)),
    }
    window.setTimeout(() => { restoringRef.current = false }, 120)
  }, [savedProgress, outlineByAnchor, findTarget, docKey])

  // 正文是异步来的、图片加载还会把版面撑高，所以头两秒补几次；用户一动滚动条就永久让位
  useEffect(() => {
    if (!savedProgress) return
    if (!(isPlain ? bookRenderedHtml : paperRenderedHtml)) return
    const timers = [0, 400, 1200].map((ms) => window.setTimeout(restoreProgress, ms))
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [savedProgress, restoreProgress, isPlain, bookRenderedHtml, paperRenderedHtml])

  /** 滚动：rAF 节流更新大纲高亮，停稳 1.2s 后落盘 */
  const handleReaderScroll = useCallback(() => {
    if (restoringRef.current) return
    userScrolledRef.current = true
    if (scrollRafRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0
      const el = pickCurrentHeading()
      if (!el) return
      setActiveAnchor(el.id)
      // 标题文本要在「当前这个模式」的 DOM 上取：切模式会整篇重渲染，回头再取就是另一段的文字了
      const item = outlineByAnchor.get(el.id)
      const headingInfo = {
        anchor: el.id,
        heading: item?.text ?? (el.textContent ?? '').trim(),
        level: item?.level ?? Number(el.tagName.slice(1)),
      }
      activeHeadingRef.current = headingInfo
      if (!docRef) return
      // 进度还没读出来就落盘，会拿"当前视口第一个标题"把上次的记录顶掉
      if (!progressLoadedRef.current) return
      if (progressSaveTimerRef.current) clearTimeout(progressSaveTimerRef.current)
      progressSaveTimerRef.current = setTimeout(() => {
        saveProgress(docRef, {
          ...headingInfo,
          // 文献连显示模式一起记住；图书 / 其他文档没有模式，留空
          mode: isPlain ? undefined : translation_mode,
          updated_at: new Date().toISOString(),
        }).catch((err) => console.error('[Reading] 保存阅读进度失败:', err))
      }, 1200)
    })
    // docRef 每次渲染都是新对象，但它只有 kind/id 有意义 —— 这里用 docKey 兜住
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickCurrentHeading, outlineByAnchor, docKey, isPlain, translation_mode])

  /**
   * 换了显示模式 → 进度里的模式要跟着更新。
   * 位置用**新 DOM**里视口顶部那个标题：模式变了锚点和标题文字都会变，
   * 沿用切换前的标题会把「英文模式的进度」写成一句中文，下次就找不回来了。
   */
  useEffect(() => {
    if (restoringModeRef.current) {
      // 是系统在恢复上次的模式，不是用户改的，别写盘
      restoringModeRef.current = false
      return
    }
    if (isPlain || !docRef || !progressLoadedRef.current) return
    // 同一刻可能有个"滚动落盘"在排队，里面存的是旧模式 —— 先撤掉，最后由这里统一写
    if (progressSaveTimerRef.current) clearTimeout(progressSaveTimerRef.current)
    const el = pickCurrentHeading()
    if (!el) return
    const item = outlineByAnchor.get(el.id)
    const info = {
      anchor: el.id,
      heading: item?.text ?? (el.textContent ?? '').trim(),
      level: item?.level ?? Number(el.tagName.slice(1)),
    }
    activeHeadingRef.current = info
    saveProgress(docRef, {
      ...info,
      mode: translation_mode,
      updated_at: new Date().toISOString(),
    }).catch((err) => console.error('[Reading] 保存阅读进度失败:', err))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translation_mode])

  // 图片预加载：渲染后把 api.github.com/contents URL 换成 blob URL（绕过 GFW 对 raw.githubusercontent.com 的封锁）
  useEffect(() => {
    if (!paperRenderedHtml || !readerRef.current) return
    const auth = useAuthStore.getState()
    const token = auth.token
    if (!token) return
    const mode = getResolvedAuthMode()
    // 微任务里跑，让 DOM 先渲染
    const t = setTimeout(() => {
      if (readerRef.current) {
        void hydrateImages(readerRef.current, token, mode)
      }
    }, 50)
    return () => clearTimeout(t)
  }, [paperRenderedHtml])

  // 图书正文的图片预加载（与文献同一套 blob URL 方案）
  useEffect(() => {
    if (!bookRenderedHtml || !readerRef.current) return
    const token = useAuthStore.getState().token
    if (!token) return
    const mode = getResolvedAuthMode()
    const t = setTimeout(() => {
      if (readerRef.current) {
        void hydrateImages(readerRef.current, token, mode)
      }
    }, 50)
    return () => clearTimeout(t)
  }, [bookRenderedHtml])

  // 笔记：Vditor 所见即所得编辑器（工具栏/图片上传由编辑器自带）
  const handleNoteChange = (md: string) => {
    setCurrentNoteMd(md)
    saveNoteToStorage(md)
  }

  const exportNote = () => {
    if (!docTitle || !currentNoteMd.trim()) return
    exportMarkdown(currentNoteMd, `${docTitle}-笔记.md`)
  }

  /**
   * 文献正文的编辑目标：显示哪一份就改哪一份 ——
   * 有知识库 md（{slug}.md）时改它，否则退回 full.md。
   */
  const articleSourceLabel = aligned_content.trim()
    ? `${doiToSlug(selectedPaperId ?? '')}.md`
    : 'full.md'
  const articleSourceMd = aligned_content.trim()
    ? aligned_content
    : (selectedPaper?.markdownContent ?? '')

  /** 编辑态里被删掉的块数 —— 显示在工具栏上，免得手一滑删多了自己不知道 */
  const editModeRemoved =
    editItems.filter((it) => it.t === 'block' && it.node.kind !== 'translation').length - editUnits.length
  /** 块外文本有几处（不渲染，保存时按原位置原样写回） */
  const editModeTextCount = editItems.filter((it) => it.t === 'text' && String(it.content).trim()).length

  const enterEditMode = () => {
    if (!selectedPaper?.hasMarkdown) return
    const { items } = parseBlocks(articleSourceMd) as any as { items: Array<Record<string, any>> }
    setEditItems(items)
    setEditUnits(buildEditUnits(items))
    setEditPlainDraft(articleSourceMd)
    setEditReport(null)
    setArticleSavingMsg('')
    setEditMode(true)
    setShowToolbar(false)
  }

  /** 退出编辑态（取消或保存完）—— 草稿一律丢掉，避免下次进来还挂着上次的中间态 */
  const exitEditMode = () => {
    setEditMode(false)
    setEditItems([])
    setEditUnits([])
    setEditPlainDraft('')
  }

  /** 编辑态里改某一块的正文（en）或译文（cn） */
  const updateEditUnit = useCallback((srcIdx: number, field: 'en' | 'cn', value: string) => {
    setEditUnits((prev) => prev.map((u) => (u.srcIdx === srcIdx ? { ...u, [field]: value } : u)))
  }, [])

  /**
   * 删掉一整块（中英一起走）。只从单元列表里移除，不动物件本身 ——
   * 重建文档时按"单元还在不在"决定要不要写回去，所以顺序、块外文本都不会乱。
   * 后悔了直接"取消"，不会写仓库。
   */
  const removeEditUnit = useCallback((srcIdx: number) => {
    setEditUnits((prev) => prev.filter((u) => u.srcIdx !== srcIdx))
  }, [])

  /**
   * 拖拽换位：拖多远就挪几位（每 EDIT_DRAG_STEP_PX 一格），松手时一次性落位。
   * 只动 `editUnits` 的顺序，`editItems` 一个字不动 —— 保存时 buildEditedMd 按新顺序重建，
   * 编号交给 renumber 重算，块外文本按它原来的槽位落回。
   */
  const editStepsFor = useCallback((clientY: number) => {
    const from = editDragFromRef.current
    if (from == null) return 0
    const raw = Math.round((clientY - editDragStartYRef.current) / EDIT_DRAG_STEP_PX)
    const last = editDragOrderRef.current.length - 1
    return Math.max(-from, Math.min(last - from, raw)) // 夹在列表范围内，拖过头也不会飞出去
  }, [])

  const beginEditDrag = useCallback((srcIdx: number, clientY: number) => {
    const units = editUnitsRef.current
    const arrIdx = units.findIndex((u) => u.srcIdx === srcIdx)
    if (arrIdx < 0) return
    editDragSrcRef.current = srcIdx
    editDragFromRef.current = arrIdx
    editDragStartYRef.current = clientY
    editDragOrderRef.current = units.map((u) => u.srcIdx)
    editDropStepsRef.current = 0
    setEditDragSrcIdx(srcIdx)
  }, [])

  const clearEditDrag = useCallback(() => {
    editDragSrcRef.current = null
    editDragFromRef.current = null
    editDragOrderRef.current = []
    editDropStepsRef.current = 0
    setEditDragSrcIdx(null)
    setEditDropHint(null)
  }, [])

  /** 拖动中：算出当前位移，把横杠画在落点那个块的上下 */
  const dragOverEditUnits = useCallback((e: DragEvent<HTMLDivElement>) => {
    // 不是从编辑区里拖起来的（比如从外面拖进一个文件）就别接管
    if (editDragSrcRef.current == null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const steps = editStepsFor(e.clientY)
    editDropStepsRef.current = steps
    // dragover 每帧都来一发；值没变就回同一个对象，React 会直接跳过这次重渲染
    setEditDropHint((prev) => {
      const from = editDragFromRef.current
      if (from == null || steps === 0) return prev === null ? prev : null
      const target = editDragOrderRef.current[from + steps]
      if (target === undefined) return prev
      const edge: 'before' | 'after' = steps < 0 ? 'before' : 'after'
      return prev && prev.srcIdx === target && prev.edge === edge ? prev : { srcIdx: target, edge }
    })
  }, [editStepsFor])

  const dropEditUnits = useCallback((e: DragEvent<HTMLDivElement>) => {
    const from = editDragFromRef.current
    if (from == null) return
    e.preventDefault()
    const steps = editStepsFor(e.clientY) // 以松手时的位置为准，不依赖最后一帧 dragover
    if (steps !== 0) {
      setEditUnits((prev) => {
        const to = from + steps
        if (to < 0 || to >= prev.length || to === from) return prev
        const next = prev.slice()
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        return next
      })
    }
    clearEditDrag()
  }, [clearEditDrag, editStepsFor])

  /** ↑ / ↓ 按钮：与拖拽同一套"换位"语义，只是固定挪一位 */
  const moveEditUnit = useCallback((srcIdx: number, dir: -1 | 1) => {
    setEditUnits((prev) => {
      const i = prev.findIndex((u) => u.srcIdx === srcIdx)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = prev.slice()
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }, [])

  /**
   * 改块类型（正文 / 标题 1-6 / 列表 1-3）。
   * 只动元信息，正文一个字不碰；编号与译文引用照旧由保存时的 renumber 统一重排。
   */
  const changeEditUnitType = useCallback((srcIdx: number, value: string) => {
    setEditUnits((prev) => prev.map((u) => {
      if (u.srcIdx !== srcIdx) return u
      const node = withEditType(u.node, value)
      // 文字家族之间互改不会改变"要不要翻译"，但顺手重算一次，免得日后扩类型时漏掉
      return { ...u, node, translatable: isTranslatable(node) }
    }))
  }, [])

  const saveArticle = async () => {
    if (!selectedPaperId) return
    const built = editUnits.length > 0 ? buildEditedMd() : null
    const nextMd = built ? built.md : editPlainDraft

    // 一个字没改就不要写盘 —— GitHub 一次写入是 GET sha + PUT 两个来回，
    // 大文献上足够让人怀疑"卡死了"
    if (nextMd === articleSourceMd) {
      exitEditMode()
      setEditReport('没有检测到改动，未写入仓库。')
      return
    }

    setArticleSaving(true)
    try {
      setArticleSavingMsg('正在写入仓库…')
      if (aligned_content.trim()) {
        await saveAlignedMd(selectedPaperId, nextMd)
        set_aligned_content(nextMd)
      } else {
        await saveFulltext(selectedPaperId, nextMd)
        setPapers(prev => prev.map(p =>
          p.id === selectedPaperId ? { ...p, markdownContent: nextMd } : p
        ))
      }
      exitEditMode()
      setEditReport(built ? built.report : '已保存（这份文件没有块结构，按整篇写入）。')
      toast.success('已保存到仓库')
    } catch (err) {
      console.error('[Reading] 保存文献失败:', err)
      alert(`保存失败：${(err as any)?.message || err}\n\n可以先别关编辑态，重试一次。`)
    } finally {
      setArticleSaving(false)
      setArticleSavingMsg('')
    }
  }

  /**
   * 用编辑态的内容重建整份文档，并回一份"改了什么"的核对结论。
   * 重建规则与顺序都在 `rebuildDocFromUnits` 里（模块级纯函数，可单测）。
   */
  function buildEditedMd(): { md: string; report: string } {
    const beforeUnits = editUnits.length
    const beforeWithCn = editUnits.filter((u) => u.translatable && u.cn.trim()).length
    const { md, droppedLabels } = rebuildDocFromUnits(editItems, editUnits)

    // 核对：块数有没有少、编号是不是被重排、哪些该有译文的块现在没有
    const after = readAnyDocument(md).items
    const afterBlocks = after.filter((it) => it.t === 'block') as ReadBlockItem[]
    const needTrans = afterBlocks.filter((it) => isTranslatable(it.node))
    const missing = needTrans.filter((it) => !(it.cn || '').trim())
    const afterWithCn = needTrans.length - missing.length

    const bits: string[] = [`块数 ${beforeUnits} → ${afterBlocks.length}`]
    if (droppedLabels.length > 0) {
      const shown = droppedLabels.slice(0, 8).join('、')
      bits.push(`删掉了 ${droppedLabels.length} 个块（${shown}${droppedLabels.length > 8 ? ' 等' : ''}）`)
    } else if (afterBlocks.length < beforeUnits) {
      bits.push(`少了 ${beforeUnits - afterBlocks.length} 个块`)
    } else if (afterBlocks.length > beforeUnits) {
      bits.push(`多了 ${afterBlocks.length - beforeUnits} 个块`)
    }
    if (afterWithCn !== beforeWithCn) {
      bits.push(`带译文的块 ${beforeWithCn} → ${afterWithCn}`)
    }
    if (missing.length > 0) {
      const shown = missing.slice(0, 8).map((it) => labelOf(it.node)).join('、')
      bits.push(`有 ${missing.length} 个块没有译文（${shown}${missing.length > 8 ? ' 等' : ''}）`)
    }
    bits.push('编号已按顺序重排')

    return { md, report: bits.join('；') + '。' }
  }

  const exportAllAnnotations = () => {
    if (!docTitle || paperAnnotations.length === 0) return

    let content = `# ${docTitle} - 批注导出\n\n`
    content += `导出时间：${formatDate(Date.now())}\n\n`
    content += `批注总数：${paperAnnotations.length}\n\n---\n\n`

    orderedAnnotations.forEach((anno, idx) => {
      content += `## 批注 ${idx + 1}\n\n`
        content += `> ${anno.text}\n\n`
        content += `**颜色**：${getColorInfo(anno.color).label}\n\n`
        content += `**时间**：${formatDate(anno.createdAt)}\n\n`
        content += `**批注内容**：\n\n${anno.note || '（无）'}\n\n---\n\n`
      })

    exportMarkdown(content, `${docTitle}-全部批注.md`)
  }

  /**
   * 点批注 → 回到正文位置。
   * 优先滚到高亮本身；当前显示模式下没有这段文字（英文批注 + 全中文模式等）时，
   * 退化成"滚到它所属的块"——靠 data-block-id 定位，保证任何模式下都能跳得到。
   */
  const scrollToAnnotation = (anno: Annotation) => {
    setSelectedAnnotationId(anno.id)
    setEditingAnnotationId(null)
    const root = readerRef.current
    if (!root) return

    const mark = root.querySelector(`[data-annotation-id="${anno.id}"]`)
    if (mark) {
      mark.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    const bid = annotationBlockIds.get(anno.id)
    const block = bid ? root.querySelector(`[data-block-id="${bid}"]`) : null
    if (block) block.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  useEffect(() => {
    const root = readerRef.current
    if (!root) return

    // 每次重新渲染（切模式 / 换文献 / 图片 hydrate）React 都会重设 innerHTML，
    // 之前挂上的高亮会被一起冲掉 —— 所以渲染结果一变就必须重挂一遍。
    clearHighlights(root)

    paperAnnotations.forEach((annotation) => {
      highlightAnnotation(
        root,
        annotation.id,
        annotation.text,
        selectedAnnotationId === annotation.id,
        getColorInfo(annotation.color),
        annotation.anchor,
      )
    })

    const handleClick = (e: Event) => {
      const target = e.target as HTMLElement
      const annotationSpan = target.closest('.annotation-highlight')
      if (annotationSpan) {
        const id = annotationSpan.getAttribute('data-annotation-id')
        if (id) {
          setSelectedAnnotationId(id)
          setActiveSideTab('annotations')
          setEditingAnnotationId(null)
        }
        return
      }
      // 整段标记（切到另一种语言、原文文字不在当前模式里时画的）也点得动
      const blockMark = target.closest('[data-annotation-block]')
      const blockId = blockMark?.getAttribute('data-annotation-block')
      if (blockId) {
        setSelectedAnnotationId(blockId)
        setActiveSideTab('annotations')
        setEditingAnnotationId(null)
      }
    }

    root.addEventListener('click', handleClick)
    return () => root.removeEventListener('click', handleClick)
  }, [paperAnnotations, selectedAnnotationId, paperRenderedHtml, bookRenderedHtml])

  /**
   * 检索命中定位：正文渲染完之后，把检索词在正文里全部高亮，并滚到第一处。
   *
   * 只对"结果对应的那篇文档"生效（比对 docKey），所以用户随后点别的文档时
   * 不需要额外清理。同一个请求只自动滚一次 —— 之后的重渲染（切模式、图片 hydrate）
   * 只重挂高亮，不会把用户已经翻走的画面又拽回去。
   */
  useEffect(() => {
    const root = readerRef.current
    if (!root) return
    clearSearchHits(root)
    if (!findTarget || findTarget.key !== docKey) return

    const first = highlightSearchHits(root, findTarget.q)
    if (!first) return

    const token = `${findTarget.key}|${findTarget.q}|${findTarget.n}`
    const fresh = findScrolledRef.current !== token
    if (fresh) findScrolledRef.current = token

    /** 每次都重新查一遍：正文重渲染会把上一轮的 span 换掉，旧引用会失效 */
    const scrollToHit = (behavior: ScrollBehavior) => {
      readerRef.current?.querySelector<HTMLElement>('.search-hit')?.scrollIntoView({ behavior, block: 'center' })
    }

    scrollToHit(fresh ? 'smooth' : 'auto')

    // 正文里的图是渲染完再 hydrate 的，版面还会被撑高 —— 只滚一次必然落偏。
    // 所以盯着正文尺寸：只要它还在变就重新对齐；用户一动手（滚轮/触摸/按键）立刻撒手，
    // 免得把人已经翻走的画面又拽回来。
    const box = scrollRef.current
    let alive = true
    let firstRo = true
    const giveUp = () => {
      alive = false
      ro.disconnect()
      box?.removeEventListener('wheel', giveUp)
      box?.removeEventListener('touchstart', giveUp)
      window.removeEventListener('keydown', giveUp)
    }
    const ro = new ResizeObserver(() => {
      // 首次回调是 observe 本身触发的，别拿它打断上面那次平滑滚动
      if (firstRo) { firstRo = false; return }
      if (alive) scrollToHit('auto')
    })
    ro.observe(root)
    box?.addEventListener('wheel', giveUp, { passive: true })
    box?.addEventListener('touchstart', giveUp, { passive: true })
    window.addEventListener('keydown', giveUp)
    const timeout = window.setTimeout(giveUp, 5000)
    return () => { alive = false; ro.disconnect(); window.clearTimeout(timeout) }
  }, [findTarget, docKey, paperRenderedHtml, bookRenderedHtml])

  /**
   * 逐行交替底色（防看漏）。
   *
   * 粒度取「1 行有色 / 1 行无色」：这是唯一能保证**任意相邻两行都不同色**的粒度。
   * 周期一放大（2/2、3/3），同一色带内部的行又变回同一个底色，带内漏行照旧发生。
   * 与实体阅读尺（reading strip）框住单行的粒度一致。
   *
   * 相位是**整篇连续**的，不是每块从头开始：每块先数出自己占几行，累加到全文行号上；
   * 若上一块结束时停在"有色行"，这一块首行就必须从无色开始。否则每个段落都从有色
   * 开头 —— 段落短的时候会连出一片同色，接缝处断掉，等于白涂。
   *
   * 不上色但**照常计行数**的：表格、纯图片块（Scheme / Figure 这种）。它们占着版面
   * 高度，跳过不计数会把后面所有文字的相位推歪；计进去才连得上。
   * 公式不在此列 —— 行内公式本来就是正文的一行，正常上色、正常计数。
   *
   * 实现：读每个文本块自己的 computed line-height，用 repeating-linear-gradient 按
   * 2×行高铺条纹；background-origin/clip 设成 content-box，让条纹从内容盒顶端
   * （= 第一个行盒顶端）起算 —— 这样条纹与行盒严格对齐，且对带 padding、border 的
   * 元素同样成立。对比刻意压到 10% 左右：条纹密度高，对比一大就成了视觉噪点。
   */
  useEffect(() => {
    const root = readerRef.current
    if (!root) return

    // 先彻底清掉上一轮的条纹与残留的段级底色
    root.querySelectorAll<HTMLElement>('*').forEach((el) => {
      el.classList.remove('bg-lime-50')
      el.style.backgroundImage = ''
      el.style.backgroundOrigin = ''
      el.style.backgroundClip = ''
    })
    if (!zebraBands) return

    const INK = 'rgba(132, 204, 22, 0.10)'
    /** 全文已累计的行数：决定下一块首行是有色还是无色 */
    let lineIndex = 0
    /** 块级标签：用来判断"叶子块"（里面没有别的块，高度不会被重复计） */
    const NESTED = 'p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,table,blockquote,pre,figure,figcaption,dl,dd,dt'
    /** 已经计过行数的元素：祖先计过就不许再计，否则高度被算两遍、相位推歪 */
    const counted = new Set<Element>()

    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      // 表格整体在这里算一次，表内元素不单独处理
      const isTable = el.tagName === 'TABLE'
      if (!isTable && el.closest('table')) continue

      const cs = getComputedStyle(el)
      if (!/^(block|list-item|table|table-row|table-cell|table-caption)$/.test(cs.display)) continue
      // 只处理叶子块：父容器会把子块的高度重复算一遍
      if (el.querySelector(NESTED)) continue

      // NESTED 只认标签，抓不住"行内元素但 display:block"的东西（KaTeX 的 .katex-display
      // 就是这种）。所以再兜一层：祖先已经计过行，这个元素一律跳过。
      let anc = el.parentElement
      let alreadyCounted = false
      while (anc && anc !== root) {
        if (counted.has(anc)) {
          alreadyCounted = true
          break
        }
        anc = anc.parentElement
      }
      if (alreadyCounted) continue

      const lh = parseFloat(cs.lineHeight)
      if (!Number.isFinite(lh) || lh <= 0) continue

      const hasText = (el.textContent ?? '').trim().length > 0
      const isFigure = !hasText && !!el.querySelector('img, svg, canvas')
      // hr / 空容器：既没字也没图，不占文字行，直接跳过（否则会平白推进相位）
      if (!hasText && !isFigure && !isTable) continue

      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
      const lines = Math.max(1, Math.round((el.clientHeight - padY) / lh))

      if (hasText && !isTable) {
        // 首行该不该有色，由"全文行号"的奇偶决定 —— 块与块之间的条纹才是连着的
        el.style.backgroundImage =
          lineIndex % 2 === 0
            ? `repeating-linear-gradient(to bottom, ${INK} 0 ${lh}px, transparent ${lh}px ${lh * 2}px)`
            : `repeating-linear-gradient(to bottom, transparent 0 ${lh}px, ${INK} ${lh}px ${lh * 2}px)`
        el.style.backgroundOrigin = 'content-box'
        el.style.backgroundClip = 'content-box'
      }

      counted.add(el)
      lineIndex += lines
    }
  }, [zebraBands, paperRenderedHtml, bookRenderedHtml])

  useEffect(() => {
    if (selectedAnnotationId && activeSideTab === 'annotations') {
      const element = document.getElementById(`annotation-item-${selectedAnnotationId}`)
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }
  }, [selectedAnnotationId, activeSideTab])

  // 笔记字数：直接数 md 正文（去掉代码块、图片、markdown 标记与空白）
  const wordCount = currentNoteMd
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/[#>*`_~\-|[\]()]/g, '')
    .replace(/\s+/g, '').length

  /** 划词浮层：文献和图书的正文容器共用同一份 */
  const selectionToolbar = showToolbar ? (
    <div
      className="absolute z-50 bg-paper-50 rounded-lg shadow-xl border border-ink-200 px-2 py-1.5 flex items-center gap-1"
      style={{
        top: toolbarPosition.top,
        left: toolbarPosition.left,
      }}
    >
      <span className="text-xs text-ink-400 px-1.5 font-medium">高亮颜色</span>
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c.value}
          onClick={() => handleHighlight(c.value)}
          className={`w-6 h-6 rounded-full ${c.dot} hover:scale-110 transition-transform border-2 border-paper-50 shadow-sm hover:shadow-md`}
          title={`${c.label}高亮并添加批注`}
        />
      ))}
    </div>
  ) : null

  return (
    /*
     * 三栏用 Grid 而不是 flex + 固定宽度：
     *  - 中栏宽度**由正文决定**（--reader-column = 正文 + 卡片内边距 + 中栏内边距）：
     *    正文正好铺满卡片内容区，不再"白卡铺满一栏、文字居中、两侧挂白带"
     *  - 两侧栏吃掉剩下的全部宽度（minmax(x, N fr)）：三栏合起来仍然填满视口，
     *    而且屏幕越宽侧栏越宽，不会把富余宽度变成中栏里的留白
     *  - 高度 h-full：由 Layout 的 main（h-screen 外壳下的确定高度）撑，不自己算 calc(100vh-3rem)
     *  - <1100px：栅格塌成单列，两侧栏变覆盖式抽屉，正文独占全宽
     *
     * 字号挂在**栅格容器**上：--reader-column 里的 ch 必须和 .measure-reader 用同一个
     * ch，中栏宽度才会随字号一起变（否则调小字号时中栏不变、正文缩了，两侧又露出白带）。
     * 代价是三个子块的字号会被继承下来，所以下面逐个把两侧栏和中栏工具条重置回 1rem
     * （正文卡片本来就有自己的字号，不受影响）。
     */
    <div
      className="h-full overflow-hidden bg-paper-100 grid grid-cols-[minmax(15rem,16fr)_minmax(0,var(--reader-column))_minmax(17rem,18fr)] grid-rows-[minmax(0,1fr)] max-[1100px]:grid-cols-1 max-[1100px]:grid-rows-[auto_minmax(0,1fr)]"
      style={{ fontSize: `${fontSize / 16}rem` }}
    >
      {/* 窄屏专用：两个抽屉开关 */}
      <div
        className="hidden max-[1100px]:flex items-center gap-2 px-2 py-1.5 bg-paper-50 border-b border-ink-200"
        style={{ fontSize: '1rem' }}
      >
        <button
          onClick={() => setLeftDrawer(true)}
          className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-ink-600 hover:bg-ink-100 rounded transition"
          title="打开列表与大纲"
        >
          <ListTree className="w-4 h-4" />
          列表 / 大纲
        </button>
        <button
          onClick={() => setRightDrawer(true)}
          className="ml-auto flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-ink-600 hover:bg-ink-100 rounded transition"
          title="打开问 AI / 笔记 / 批注"
        >
          <StickyNote className="w-4 h-4" />
          问 AI / 笔记 / 批注
        </button>
      </div>

      {/* 窄屏抽屉的遮罩（宽屏恒 hidden） */}
      {(leftDrawer || rightDrawer) && (
        <div
          className="hidden max-[1100px]:block fixed inset-0 z-30 bg-ink-900/30"
          onClick={() => { setLeftDrawer(false); setRightDrawer(false) }}
        />
      )}

      <aside className={`bg-paper-50 border-r border-ink-200 flex flex-col overflow-hidden max-[1100px]:fixed max-[1100px]:inset-y-0 max-[1100px]:left-0 max-[1100px]:z-40 max-[1100px]:w-[min(20rem,85vw)] max-[1100px]:shadow-2xl max-[1100px]:transition-transform max-[1100px]:duration-200 ${
        leftDrawer ? 'max-[1100px]:translate-x-0' : 'max-[1100px]:-translate-x-full'
      }`}
        style={{ fontSize: '1rem' }}
      >
        {/* 固定：阅读对象切换（文献 / 图书 / 其他文档） */}
        <div className="p-2 border-b border-ink-200 flex-shrink-0">
          <div className="flex gap-1 p-0.5 bg-ink-100 rounded-md">
            {([
              { type: 'paper' as DocType, label: '文献', Icon: BookOpen },
              { type: 'book' as DocType, label: '图书', Icon: BookCopy },
              { type: 'document' as DocType, label: '其他文档', Icon: FileText },
            ]).map(({ type, label, Icon }) => (
              <button
                key={type}
                onClick={() => setDocType(type)}
                title={label}
                className={`flex-1 flex items-center justify-center gap-1 px-1 py-1 text-xs rounded transition ${
                  docType === type
                    ? 'bg-paper-50 text-seal-600 font-medium shadow-sm'
                    : 'text-ink-500 hover:text-ink-700'
                }`}
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 堆叠面板 1/2：列表（收起只剩标题行；展开到实际高度，不超出左栏） */}
        <div className={`flex flex-col ${listExpanded ? 'min-h-0' : 'flex-none'}`}>
          <button
            onClick={() => setListExpanded(!listExpanded)}
            className="w-full flex-shrink-0 flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-ink-600 hover:bg-paper-100 transition"
            title={listExpanded ? '收起列表' : '展开列表'}
          >
            {listExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-ink-400" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-ink-400" />
            )}
            {isBook ? (
              <BookCopy className="w-3.5 h-3.5 text-seal-600" />
            ) : isDoc ? (
              <FileText className="w-3.5 h-3.5 text-seal-600" />
            ) : (
              <BookOpen className="w-3.5 h-3.5 text-seal-600" />
            )}
            {isBook ? '图书列表' : isDoc ? '文档列表' : '文献列表'}
            <span className="ml-auto text-ink-400 font-normal">
              {isBook
                ? filteredBooks.length
                : isDoc
                  ? filteredDocuments.length
                  : filteredPapers.length}
            </span>
          </button>
          {listExpanded && (
          <div className="flex-auto min-h-0 flex flex-col">
          <div className="flex-shrink-0 px-2 pb-2">
          <div className="flex items-center gap-1">
          <div className="relative flex-1 min-w-0">
            <Search className="w-3.5 h-3.5 text-ink-400 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                // 输入法组词中的回车是"选词"，不是"提交"，不能吞
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  runFullTextSearch()
                }
                if (e.key === 'Escape' && ftResults !== null) setFtResults(null)
              }}
              placeholder={
                isBook
                  ? '书名…（Enter 全文检索）'
                  : isDoc
                    ? '标题…（Enter 全文检索）'
                    : '标题、作者、期刊、DOI…（Enter 全文检索）'
              }
              className="w-full pl-7 pr-6 py-1.5 text-xs border border-ink-200 rounded-md focus:outline-none focus:border-seal-400"
            />
            {/* 点这里 = 按 Enter：检索库内所有正文（不只是当前列表的元数据） */}
            <button
              onClick={runFullTextSearch}
              title="全文检索库内所有正文（Enter）"
              className="absolute right-0.5 top-1/2 -translate-y-1/2 p-1 text-ink-400 hover:text-seal-600 rounded transition"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
          {/* 其他文档：就地导入，不用绕到管理页（写的是同一份 documents/ 数据） */}
          {isDoc && (
            <button
              onClick={() => setShowImportDocModal(true)}
              title="导入 .md 文件 / 粘贴 markdown / 上传 zip"
              className="flex-shrink-0 p-1.5 text-ink-400 hover:text-seal-600 hover:bg-seal-50 border border-ink-200 rounded-md transition"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
          {/* 漏斗：点开是一块一个维度的筛选菜单，选完点「确定」折叠回去 */}
          <div className="relative flex-shrink-0" ref={filterMenuRef}>
            <button
              onClick={toggleFilterMenu}
              title="筛选"
              className={`p-1.5 border rounded-md transition relative ${
                filterOpen || activeFilterCount > 0
                  ? 'border-seal-300 text-seal-600 bg-seal-50'
                  : 'border-ink-200 text-ink-400 hover:text-seal-600 hover:bg-seal-50'
              }`}
            >
              <Filter className="w-3.5 h-3.5" />
              {activeFilterCount > 0 && (
                // 角标尺寸全部用 em：跟着按钮字号走，不写死尺寸
                <span className="absolute -top-1.5 -right-1.5 min-w-[1.6em] h-[1.6em] px-[0.25em] rounded-full bg-seal-600 text-paper-50 text-[0.75em] leading-[1.6em] text-center">
                  {activeFilterCount}
                </span>
              )}
            </button>
            {filterOpen && (
              <div className="absolute right-0 top-full mt-1 w-60 bg-paper-50 border border-ink-200 rounded-lg shadow-xl z-40 p-3">
                {/* 维度 1：分类 */}
                <div className="text-[0.6875rem] font-semibold text-ink-500 mb-1.5">分类</div>
                <div className="flex flex-wrap gap-1">
                  <button onClick={() => setDraftCategory('all')} className={chipCls(draftCategory === 'all')}>
                    全部
                  </button>
                  {(isBook ? bookCategories : isDoc ? documentCategories : paperCategories).map((c) => (
                    <button key={c.id} onClick={() => setDraftCategory(c.id)} className={chipCls(draftCategory === c.id)}>
                      {c.name}
                    </button>
                  ))}
                </div>

                {/* 维度 2：有无 md（其他文档导入的必然有 md，不给这一维） */}
                {!isDoc && (
                  <>
                    <div className="text-[0.6875rem] font-semibold text-ink-500 mt-3 mb-1.5">
                      {isBook ? '有无正文' : '有无 Markdown'}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <button onClick={() => setDraftMd('all')} className={chipCls(draftMd === 'all')}>
                        全部
                      </button>
                      <button onClick={() => setDraftMd('has-md')} className={chipCls(draftMd === 'has-md')}>
                        {isBook ? '有正文' : '有 Markdown'}
                      </button>
                      <button onClick={() => setDraftMd('no-md')} className={chipCls(draftMd === 'no-md')}>
                        {isBook ? '无正文' : '无 Markdown'}
                      </button>
                    </div>
                  </>
                )}

                {/* 维度 3：文献级别（只有文献有） */}
                {!isPlain && (
                  <>
                    <div className="text-[0.6875rem] font-semibold text-ink-500 mt-3 mb-1.5">文献级别</div>
                    <div className="flex flex-wrap gap-1">
                      <button onClick={() => setDraftTier('all')} className={chipCls(draftTier === 'all')}>
                        全部
                      </button>
                      <button
                        onClick={() => setDraftTier(1)}
                        className={chipCls(draftTier === 1)}
                        title="一级文献（原创研究论文）"
                      >
                        一级
                      </button>
                      <button
                        onClick={() => setDraftTier(2)}
                        className={chipCls(draftTier === 2)}
                        title="二级文献（综述 / meta 分析等二手文献）"
                      >
                        二级
                      </button>
                    </div>
                  </>
                )}

                <div className="flex items-center justify-between gap-2 mt-3 pt-2 border-t border-ink-100">
                  <button
                    onClick={resetFilterDraft}
                    className="px-2 py-1 text-xs text-ink-500 hover:text-ink-700 hover:bg-ink-100 rounded transition"
                  >
                    重置
                  </button>
                  <button
                    onClick={applyFilterDraft}
                    className="px-3 py-1 text-xs bg-seal-600 text-paper-50 rounded-md hover:bg-seal-700 transition"
                  >
                    确定
                  </button>
                </div>
              </div>
            )}
          </div>
          </div>
          </div>
          <div className="flex-auto min-h-0 overflow-y-auto">
          {ftResults !== null ? (
            /* ── 全文检索结果：命中片段 + 点一下直达正文命中处 ── */
            <div className="p-2 space-y-1.5">
              <div className="flex items-center gap-1 px-1 pb-1">
                <span className="text-xs font-semibold text-ink-600">全文检索</span>
                <span className="text-xs text-ink-400 truncate" title={ftQuery}>「{ftQuery}」</span>
                <button
                  onClick={() => setFtResults(null)}
                  className="ml-auto flex-shrink-0 p-0.5 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded transition"
                  title="返回列表（Esc）"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {ftLoading ? (
                <div className="text-center py-8 text-ink-400 text-xs">
                  <div className="w-8 h-8 border-2 border-ink-200 border-t-seal-500 rounded-full animate-spin mx-auto mb-2" />
                  {getSearchIndex()
                    ? '正在检索…'
                    : `首次检索，正在建立全文索引 ${ftProgress.done}/${ftProgress.total}`}
                </div>
              ) : ftResults.length === 0 ? (
                <div className="text-center py-8 text-ink-400 text-sm">
                  <Search className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p>全库正文里没有匹配的词</p>
                  <p className="text-xs mt-1">检索范围：文献 / 图书 / 其他文档的正文</p>
                </div>
              ) : (
                <>
                  <div className="px-1 pb-1 text-[0.6875rem] text-ink-400">
                    {ftResults.length} 篇命中，点结果直达正文命中处
                  </div>
                  {ftResults.map((hit) => (
                    <button
                      key={`${hit.kind}:${hit.id}`}
                      onClick={() => openSearchHit(hit)}
                      title="跳到正文命中处"
                      className={`w-full text-left p-2 rounded-md border transition ${
                        docKey === `${hit.kind}:${hit.id}`
                          ? 'bg-seal-50 border-seal-200'
                          : 'bg-paper-50 border-ink-200 hover:border-seal-300'
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="flex-shrink-0 px-1 py-0.5 rounded bg-ink-100 text-ink-500 text-[0.625rem]">
                          {KIND_LABEL[hit.kind]}
                        </span>
                        <span className="text-xs font-medium text-ink-700 truncate">{hit.title}</span>
                        <span className="ml-auto flex-shrink-0 text-[0.625rem] text-ink-400">{hit.total} 处</span>
                      </div>
                      {hit.snippets.map((sn, i) => (
                        <div key={i} className="mt-1.5 text-[0.6875rem] leading-relaxed text-ink-500 line-clamp-3">
                          {renderSnippet(sn.text)}
                        </div>
                      ))}
                    </button>
                  ))}
                </>
              )}
            </div>
          ) : isBook ? (
            booksLoading ? (
              <div className="text-center py-8 text-ink-400 text-sm">
                <div className="w-8 h-8 border-2 border-ink-200 border-t-seal-500 rounded-full animate-spin mx-auto mb-2" />
                <p>加载中...</p>
              </div>
            ) : books.length === 0 ? (
              <div className="text-center py-8 text-ink-400 text-sm px-4">
                <BookCopy className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-ink-500 font-medium mb-1">还没有图书</p>
                <p className="text-xs text-ink-400 mb-3">
                  上传图书 PDF 转换后，正文会落到 textbooks/&lt;书名&gt;/content.md
                </p>
                <button
                  onClick={() => navigate('/management')}
                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-seal-600 text-paper-50 text-xs rounded-md hover:bg-seal-700 transition"
                >
                  <Plus className="w-3.5 h-3.5" />
                  去上传图书
                </button>
              </div>
            ) : filteredBooks.length === 0 ? (
              <div className="text-center py-8 text-ink-400 text-sm">
                <Search className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p>没有找到匹配的图书</p>
              </div>
            ) : (
              filteredBooks.map((b) => (
                <button
                  key={b.id}
                  onClick={() => { setSelectedBookId(b.id); setLeftDrawer(false) }}
                  className={`w-full text-left p-3 border-b border-ink-100 hover:bg-paper-100 transition ${
                    selectedBookId === b.id ? 'bg-seal-50 border-l-2 border-l-seal-600' : ''
                  }`}
                >
                  <div className="text-sm font-medium text-ink-700 line-clamp-2 leading-snug">
                    {b.title}
                  </div>
                  <div className="flex items-center gap-2 mt-1.5">
                    {b.hasContent ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-green-100 text-green-700 rounded text-[0.625rem] font-medium">
                        <FileText className="w-3 h-3" />
                        已转换
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-ink-100 text-ink-500 rounded text-[0.625rem]">
                        待转换
                      </span>
                    )}
                  </div>
                </button>
              ))
            )
          ) : isDoc ? (
            documentsLoading ? (
              <div className="text-center py-8 text-ink-400 text-sm">
                <div className="w-8 h-8 border-2 border-ink-200 border-t-seal-500 rounded-full animate-spin mx-auto mb-2" />
                <p>加载中...</p>
              </div>
            ) : documents.length === 0 ? (
              <div className="text-center py-8 text-ink-400 text-sm px-4">
                <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-ink-500 font-medium mb-1">还没有其他文档</p>
                <p className="text-xs text-ink-400 mb-3">
                  导入 .md 文件、粘贴 markdown 或上传 zip，
                  正文会落到 documents/&lt;目录名&gt;/content.md
                </p>
                <button
                  onClick={() => setShowImportDocModal(true)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-seal-600 text-paper-50 text-xs rounded-md hover:bg-seal-700 transition"
                >
                  <Plus className="w-3.5 h-3.5" />
                  导入文档
                </button>
              </div>
            ) : filteredDocuments.length === 0 ? (
              <div className="text-center py-8 text-ink-400 text-sm">
                <Search className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p>没有找到匹配的文档</p>
              </div>
            ) : (
              filteredDocuments.map((d) => (
                <button
                  key={d.id}
                  onClick={() => {
                    setSelectedDocumentId(d.id)
                    setSelectedAnnotationId(null)
                    setEditingAnnotationId(null)
                    setLeftDrawer(false)
                  }}
                  className={`w-full text-left p-3 border-b border-ink-100 hover:bg-paper-100 transition ${
                    selectedDocumentId === d.id ? 'bg-seal-50 border-l-2 border-l-seal-600' : ''
                  }`}
                >
                  <div className="text-sm font-medium text-ink-700 line-clamp-2 leading-snug">
                    {d.title}
                  </div>
                  <div className="flex items-center gap-2 mt-1.5 text-xs text-ink-400">
                    {d.author ? <span className="truncate">{d.author}</span> : null}
                    {d.hasContent ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-green-100 text-green-700 rounded text-[0.625rem] font-medium">
                        <FileText className="w-3 h-3" />
                        已导入
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-ink-100 text-ink-500 rounded text-[0.625rem]">
                        无正文
                      </span>
                    )}
                  </div>
                </button>
              ))
            )
          ) : papersLoading ? (
            <div className="text-center py-8 text-ink-400 text-sm">
              <div className="w-8 h-8 border-2 border-ink-200 border-t-seal-500 rounded-full animate-spin mx-auto mb-2" />
              <p>加载中...</p>
            </div>
          ) : papers.length === 0 ? (
            <div className="text-center py-8 text-ink-400 text-sm px-4">
              <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-ink-500 font-medium mb-1">还没有添加文献</p>
              <p className="text-xs text-ink-400 mb-3">请到文献管理页添加文献后开始阅读</p>
              <button
                onClick={() => navigate('/management')}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-seal-600 text-paper-50 text-xs rounded-md hover:bg-seal-700 transition"
              >
                <Plus className="w-3.5 h-3.5" />
                去添加文献
              </button>
            </div>
          ) : filteredPapers.length === 0 ? (
            <div className="text-center py-8 text-ink-400 text-sm">
              <Search className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>没有找到匹配的文献</p>
            </div>
          ) : (
            filteredPapers.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setSelectedPaperId(p.id)
                  setSelectedAnnotationId(null)
                  setEditingAnnotationId(null)
                  setLeftDrawer(false)
                }}
                className={`w-full text-left p-3 border-b border-ink-100 hover:bg-paper-100 transition ${
                  selectedPaperId === p.id ? 'bg-seal-50 border-l-2 border-l-seal-600' : ''
                }`}
              >
                <div className="text-sm font-medium text-ink-700 line-clamp-2 leading-snug">
                  {p.title}
                </div>
                <div className="text-xs text-ink-500 mt-1.5 space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate">{p.authors}</span>
                    <span>·</span>
                    <span className="flex-shrink-0">{p.year}</span>
                  </div>
                  <div className="text-ink-400 truncate">{p.journal}</div>
                  <div className="flex items-center gap-2 mt-1">
                    {p.hasMarkdown ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-green-100 text-green-700 rounded text-[0.625rem] font-medium">
                        <FileText className="w-3 h-3" />
                        Markdown
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-ink-100 text-ink-500 rounded text-[0.625rem]">
                        待转换
                      </span>
                    )}
                    <span className="text-ink-400 text-[0.625rem] truncate">
                      <DoiLink doi={p.doi} className="text-[0.625rem]" />
                    </span>
                  </div>
                </div>
              </button>
            ))
          )}
          </div>
          </div>
          )}
        </div>

        {/* 堆叠面板 2/2：大纲（文献按当前显示模式的内容生成，图书按 content.md） */}
        <div className={`flex flex-col border-t border-ink-200 ${outlineOpen ? 'min-h-0' : 'flex-none'}`}>
          <button
            onClick={() => setOutlineOpen(!outlineOpen)}
            className="w-full flex-shrink-0 flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-ink-600 hover:bg-paper-100 transition"
            title={outlineOpen ? '收起大纲' : '展开大纲'}
          >
            {outlineOpen ? (
              <ChevronDown className="w-3.5 h-3.5 text-ink-400" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-ink-400" />
            )}
            <ListTree className="w-3.5 h-3.5 text-seal-600" />
            大纲
            <span className="ml-auto text-ink-400 font-normal">{outline.length}</span>
          </button>
          {outlineOpen && (
            <div className="flex-auto min-h-0 overflow-y-auto px-2 py-1 space-y-0.5">
              {outline.length === 0 && (
                <div className="text-xs text-ink-400 text-center py-3">
                  {docRef ? '暂无大纲' : '选择阅读对象后显示大纲'}
                </div>
              )}
              {outline.map((item) => (
                <button
                  key={item.anchor}
                  onClick={() => { jumpToAnchor(item.anchor); setLeftDrawer(false) }}
                  className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-seal-50 hover:text-seal-700 transition truncate ${
                    item.anchor === activeAnchor
                      ? 'bg-seal-50 text-seal-700 font-medium'
                      : item.level === 1
                        ? 'font-semibold text-ink-700'
                        : item.level === 2
                          ? 'font-medium text-ink-600'
                          : 'text-ink-500'
                  }`}
                  style={{ paddingLeft: `${0.5 + (item.level - 1) * 0.75}rem` }}
                  title={item.text}
                >
                  {item.text}
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      <section
        className="bg-paper-100 flex flex-col min-w-0 min-h-0 overflow-hidden"
        style={{ fontSize: '1rem' }}
      >
        {isPlain ? (
          plainId ? (
            <>
              <div className="bg-paper-50 border-b border-ink-200 px-4 py-2 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    onClick={() => (isBook ? setSelectedBookId(null) : setSelectedDocumentId(null))}
                    className="p-1.5 text-ink-500 hover:bg-ink-100 rounded transition flex-shrink-0"
                    title="返回列表"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink-700 truncate">
                      {docTitle}
                    </div>
                    <div className="text-xs text-ink-400 truncate">
                      {isBook ? '图书' : '其他文档'} · {isBook ? 'textbooks' : 'documents'}/
                      {plainId}/content.md
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => setZebraBands((v) => !v)}
                    className={`px-2 py-1.5 text-xs rounded transition flex items-center gap-1 ${
                      zebraBands ? 'bg-lime-100 text-lime-800' : 'text-ink-600 hover:bg-ink-100'
                    }`}
                    title="逐行交替底色：正文每一行交替极浅淡绿（1 行有色 / 1 行无色），按行高精确对齐，帮你锚住当前行、防看漏"
                  >
                    <Highlighter className="w-3.5 h-3.5" />
                    隔行底色
                  </button>
                  <div className="w-px h-5 bg-ink-200 mx-1" />
                  <button
                    onClick={() => setFontSize((s) => Math.max(12, s - 1))}
                    className="p-1.5 text-ink-500 hover:bg-ink-100 rounded transition"
                    title="减小字号"
                  >
                    <ZoomOut className="w-4 h-4" />
                  </button>
                  <span className="text-xs text-ink-400 w-8 text-center">{fontSize / 16}rem</span>
                  <button
                    onClick={() => setFontSize((s) => Math.min(24, s + 1))}
                    className="p-1.5 text-ink-500 hover:bg-ink-100 rounded transition"
                    title="增大字号"
                  >
                    <ZoomIn className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto" ref={scrollRef} onScroll={handleReaderScroll}>
                {plainLoading ? (
                  <div className="flex items-center justify-center py-16 text-ink-400 text-sm">
                    <div className="text-center">
                      <div className="w-8 h-8 border-2 border-ink-200 border-t-seal-500 rounded-full animate-spin mx-auto mb-2" />
                      <p>加载正文...</p>
                    </div>
                  </div>
                ) : bookRenderedHtml ? (
                  <div
                    className="w-[min(100%,var(--reader-column))] mx-auto px-[var(--reader-gutter)] py-[clamp(0.75rem,2vw,2rem)]"
                    style={{ fontSize: `${fontSize / 16}rem` }}
                  >
                    <div className="bg-paper-50 rounded-xl shadow-sm border border-ink-200 p-[var(--reader-cardpad)] relative">
                      <div
                        ref={readerRef}
                        onMouseUp={handleTextSelection}
                        onMouseDown={() => {
                          setShowToolbar(false)
                        }}
                        onCopy={(e) => {
                          const sel = window.getSelection()
                          if (sel && e.clipboardData && copySelectionWithFormulaSource(e.clipboardData, sel)) {
                            e.preventDefault()
                          }
                        }}
                        className="relative prose-reader measure-reader"
                        dangerouslySetInnerHTML={{ __html: bookRenderedHtml }}
                      />
                      {selectionToolbar}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-center py-16 text-ink-400">
                    <div className="text-center px-6">
                      {isDoc ? (
                        <>
                          <FileText className="w-16 h-16 mx-auto mb-3 opacity-30" />
                          <p className="text-sm text-ink-500">这个文档还没有正文</p>
                          <p className="text-xs mt-1">
                            正文应位于 documents/{plainId}/content.md
                          </p>
                        </>
                      ) : (
                        <>
                          <BookCopy className="w-16 h-16 mx-auto mb-3 opacity-30" />
                          <p className="text-sm text-ink-500">这本书还没有正文</p>
                          <p className="text-xs mt-1">
                            转换完成后，正文会写入 textbooks/{plainId}/content.md
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-ink-400">
              <div className="text-center">
                <BookCopy className="w-16 h-16 mx-auto mb-3 opacity-30" />
                <p className="text-sm">从左侧选择一本书开始阅读</p>
              </div>
            </div>
          )
        ) : selectedPaper ? (
          <>
            <div className="bg-paper-50 border-b border-ink-200 px-4 py-2 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <button
                  onClick={() => setSelectedPaperId(null)}
                  className="p-1.5 text-ink-500 hover:bg-ink-100 rounded transition flex-shrink-0"
                  title="返回列表"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink-700 truncate">
                    {selectedPaper.title}
                  </div>
                  <div className="text-xs text-ink-400 truncate">
                    {selectedPaper.authors} · {selectedPaper.journal} · {selectedPaper.year}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => setFontSize((s) => Math.max(12, s - 1))}
                  className="p-1.5 text-ink-500 hover:bg-ink-100 rounded transition"
                  title="减小字号"
                >
                  <ZoomOut className="w-4 h-4" />
                </button>
                <span className="text-xs text-ink-400 w-8 text-center">{fontSize / 16}rem</span>
                <button
                  onClick={() => setFontSize((s) => Math.min(24, s + 1))}
                  className="p-1.5 text-ink-500 hover:bg-ink-100 rounded transition"
                  title="增大字号"
                >
                  <ZoomIn className="w-4 h-4" />
                </button>
                <div className="w-px h-5 bg-ink-200 mx-1" />
                <button
                  onClick={exportAllAnnotations}
                  disabled={paperAnnotations.length === 0}
                  className="px-2.5 py-1.5 text-xs text-ink-600 hover:bg-ink-100 rounded transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                  title="导出全部批注"
                >
                  <Download className="w-3.5 h-3.5" />
                  导出批注
                </button>
                <button
                  onClick={exportNote}
                  disabled={!currentNoteMd.trim()}
                  className="px-2.5 py-1.5 text-xs bg-seal-600 text-paper-50 rounded hover:bg-seal-700 transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                  title="导出笔记"
                >
                  <Download className="w-3.5 h-3.5" />
                  导出笔记
                </button>
                <div className="w-px h-5 bg-ink-200 mx-1" />
                <button
                  onClick={() => setZebraBands((v) => !v)}
                  className={`px-2.5 py-1.5 text-xs rounded transition flex items-center gap-1 ${
                    zebraBands ? 'bg-lime-100 text-lime-800' : 'text-ink-600 hover:bg-ink-100'
                  }`}
                  title="逐行交替底色：正文每一行交替极浅淡绿（1 行有色 / 1 行无色），按行高精确对齐，帮你锚住当前行、防段内串行（不改字号字色）"
                >
                  <Highlighter className="w-3.5 h-3.5" />
                  隔行底色
                </button>
                <div className="w-px h-5 bg-ink-200 mx-1" />
                {editMode ? (
                  <>
                    <span className="text-xs text-ink-400 px-1 tabular-nums">
                      {editModeRemoved > 0
                        ? `编辑中 · ${articleSourceLabel} · 已删 ${editModeRemoved} 块`
                        : `编辑中 · ${articleSourceLabel} · ${editUnits.length || 0} 块`}
                    </span>
                    <button
                      onClick={saveArticle}
                      disabled={articleSaving}
                      className="px-2.5 py-1.5 text-xs bg-seal-600 text-paper-50 rounded hover:bg-seal-700 transition disabled:opacity-50 flex items-center gap-1"
                      title="保存到仓库：会自动核对块数、重排编号后再写"
                    >
                      <Save className="w-3.5 h-3.5" />
                      {articleSaving ? (articleSavingMsg || '保存中…') : '保存'}
                    </button>
                    <button
                      onClick={exitEditMode}
                      disabled={articleSaving}
                      className="px-2.5 py-1.5 text-xs text-ink-600 hover:bg-ink-100 rounded transition disabled:opacity-50"
                      title="放弃修改"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        // 没有译文时只在「原文 / 全英文」之间切 —— 否则切过去只能看到一段"译文排队中"的提示
                        const modes: TranslationMode[] = hasTranslationContent
                          ? ['original', 'bilingual', 'chinese', 'english']
                          : ['original', 'english']
                        const idx = modes.indexOf(translation_mode)
                        set_translation_mode(modes[(idx + 1) % modes.length])
                      }}
                      className="px-2.5 py-1.5 text-xs text-ink-600 hover:bg-ink-100 rounded transition flex items-center gap-1"
                      title={hasTranslationContent ? '切换显示模式（原文 / 中英对照 / 全中文 / 全英文）' : '该文献还没有译文，仅可切换 原文 / 全英文'}
                    >
                      <Languages className="w-3.5 h-3.5" />
                      {translation_mode === 'original' && '原文'}
                      {translation_mode === 'bilingual' && '中英对照'}
                      {translation_mode === 'chinese' && '全中文'}
                      {translation_mode === 'english' && '全英文'}
                      {!hasTranslationContent && '（未生成）'}
                    </button>
                    <button
                      onClick={enterEditMode}
                      disabled={!selectedPaper?.hasMarkdown}
                      className="px-2.5 py-1.5 text-xs text-ink-600 hover:bg-ink-100 rounded transition flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                      title="编辑模式开关：开启后可修改文献正文"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      编辑
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* 保存后的核对结论：块数变了 / 编号重排了 / 哪些块丢了译文。看一眼就能确认没丢东西 */}
            {editReport && !editMode && (
              <div className="flex items-start gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-800 flex-shrink-0">
                <span className="flex-1 min-w-0 break-words">{editReport}</span>
                <button
                  onClick={() => setEditReport(null)}
                  className="text-amber-600 hover:text-amber-900 transition flex-shrink-0"
                  title="知道了"
                >
                  ✕
                </button>
              </div>
            )}

            <div
              className={editMode ? 'flex-1 min-h-0' : 'flex-1 overflow-y-auto'}
              ref={scrollRef}
              onScroll={handleReaderScroll}
            >
              {selectedPaper.hasMarkdown && selectedPaper.markdownContent ? (
                editMode ? (
                  /* 整段编辑区都是落点：拖拽按位移算，不挑指针落在哪一块上 */
                  <div
                    className="h-full overflow-y-auto"
                    style={{ fontSize: `${fontSize / 16}rem` }}
                    onDragOver={dragOverEditUnits}
                    onDrop={dropEditUnits}
                  >
                    <div className="w-[min(100%,var(--reader-column))] mx-auto px-[var(--reader-gutter)] py-[clamp(0.75rem,2vw,2rem)] space-y-3">
                      {editUnits.length === 0 ? (
                        <div className="bg-paper-50 rounded-xl shadow-sm border border-ink-200 p-[var(--reader-cardpad)]">
                          <p className="text-sm text-ink-500 mb-3">
                            这份文件还没有块结构（多半是 MinerU 的 <code className="px-1 bg-ink-100 rounded">full.md</code>），
                            只能按整篇改。转成 <code className="px-1 bg-ink-100 rounded">{articleSourceLabel}</code> 之后
                            就会按「块」分开编辑，中英各一个框。
                          </p>
                          <textarea
                            value={editPlainDraft}
                            onChange={(e) => setEditPlainDraft(e.target.value)}
                            spellCheck={false}
                            className="w-full h-[60vh] p-3 font-mono text-xs leading-relaxed border border-ink-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-seal-200"
                          />
                        </div>
                      ) : (
                        <>
                          <p className="text-xs text-ink-400 px-1">
                            共 {editUnits.length} 个块，英文一个框、中文一个框，块标记由系统持有（不显示，也就删不掉）。
                            删掉某一整块 = 中英一起删。换位两种办法：按住块名那条横条
                            <span className="text-ink-500">上下拖</span>
                            （拖多远就挪几位，不用拖到目标块的一半），或者直接点右侧的 ↑ ↓ 一位一位挪。
                            类型认错了（比如标题被当成正文）就点块名右边的下拉直接改，编号与译文都会跟着走。
                            保存时会自动核对块数并重排编号。
                            {editModeTextCount > 0 && `另有 ${editModeTextCount} 处块外文本会原样保留。`}
                          </p>
                          {editUnits.map((u, i) => (
                            <EditBlockCard
                              key={u.key}
                              unit={u}
                              dragging={editDragSrcIdx === u.srcIdx}
                              dropEdge={editDropHint?.srcIdx === u.srcIdx ? editDropHint.edge : null}
                              isFirst={i === 0}
                              isLast={i === editUnits.length - 1}
                              onChange={updateEditUnit}
                              onRemove={removeEditUnit}
                              onMoveUnit={moveEditUnit}
                              onChangeType={changeEditUnitType}
                              onDragStartUnit={beginEditDrag}
                              onDragEndUnit={clearEditDrag}
                            />
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                <div
                  className="w-[min(100%,var(--reader-column))] mx-auto px-[var(--reader-gutter)] py-[clamp(0.75rem,2vw,2rem)]"
                  style={{ fontSize: `${fontSize / 16}rem` }}
                >
                  <div className="bg-paper-50 rounded-xl shadow-sm border border-ink-200 p-[var(--reader-cardpad)] relative">
                    <div
                      ref={readerRef}
                      onMouseUp={handleTextSelection}
                      onMouseDown={() => {
                        setShowToolbar(false)
                      }}
                      onCopy={(e) => {
                        const sel = window.getSelection()
                        if (sel && e.clipboardData && copySelectionWithFormulaSource(e.clipboardData, sel)) {
                          e.preventDefault()
                        }
                      }}
                      className="relative prose-reader measure-reader"
                      dangerouslySetInnerHTML={{ __html: paperRenderedHtml }}
                    />
                    {selectionToolbar}
                  </div>
                </div>
                )
              ) : (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center text-ink-400">
                    <FileText className="w-16 h-16 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">暂无 Markdown 内容</p>
                    <p className="text-xs mt-1">请先使用 MinerU 将 PDF 转换为 Markdown</p>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-ink-400">
            <div className="text-center">
              <BookOpen className="w-16 h-16 mx-auto mb-3 opacity-30" />
              <p className="text-sm">从左侧选择一篇文献开始阅读</p>
            </div>
          </div>
        )}
      </section>

      {/* 右栏：问 AI / 笔记 / 批注 —— 文献与图书同一套 */}
      <aside className={`bg-paper-50 border-l border-ink-200 flex flex-col overflow-hidden max-[1100px]:fixed max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-40 max-[1100px]:w-[min(24rem,90vw)] max-[1100px]:shadow-2xl max-[1100px]:transition-transform max-[1100px]:duration-200 ${
        rightDrawer ? 'max-[1100px]:translate-x-0' : 'max-[1100px]:translate-x-full'
      }`}
        style={{ fontSize: '1rem' }}
      >
        <div className="flex border-b border-ink-200 flex-shrink-0">
          <button
            onClick={() => setActiveSideTab('ask')}
            className={`flex-1 px-2 py-2.5 text-xs font-medium transition flex items-center justify-center gap-1 ${
              activeSideTab === 'ask'
                ? 'text-seal-600 border-b-2 border-seal-600 bg-seal-50/30'
                : 'text-ink-500 hover:text-ink-700 hover:bg-paper-100'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            问 AI
          </button>
          <button
            onClick={() => setActiveSideTab('notes')}
            className={`flex-1 px-2 py-2.5 text-xs font-medium transition flex items-center justify-center gap-1 ${
              activeSideTab === 'notes'
                ? 'text-seal-600 border-b-2 border-seal-600 bg-seal-50/30'
                : 'text-ink-500 hover:text-ink-700 hover:bg-paper-100'
            }`}
          >
            <StickyNote className="w-4 h-4" />
            笔记
          </button>
          <button
            onClick={() => setActiveSideTab('annotations')}
            className={`flex-1 px-2 py-2.5 text-xs font-medium transition flex items-center justify-center gap-1 ${
              activeSideTab === 'annotations'
                ? 'text-seal-600 border-b-2 border-seal-600 bg-seal-50/30'
                : 'text-ink-500 hover:text-ink-700 hover:bg-paper-100'
            }`}
          >
            <Highlighter className="w-4 h-4" />
            批注
            {paperAnnotations.length > 0 && (
              <span className="px-1.5 py-0.5 text-[0.625rem] bg-seal-100 text-seal-600 rounded-full font-medium">
                {paperAnnotations.length}
              </span>
            )}
          </button>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col">
          {activeSideTab === 'ask' ? (
            <ReadingAskPanel
              docRef={docRef}
              docTitle={docTitle}
              docMarkdown={isPlain ? plainMarkdown : askSourceText}
              selectedText={selectedText}
            />
          ) : activeSideTab === 'notes' ? (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="px-3 py-2 border-b border-ink-100 flex items-center justify-end flex-shrink-0 bg-paper-100/50">
                <button
                  onClick={exportNote}
                  disabled={!docRef || !currentNoteMd.trim()}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-seal-600 hover:bg-seal-50 rounded transition disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                >
                  <Download className="w-3.5 h-3.5" />
                  导出
                </button>
              </div>

              <div className="flex-1 min-h-0">
                {docRef ? (
                  <VditorEditor
                    ref={noteVditorRef}
                    value={currentNoteMd}
                    onChange={handleNoteChange}
                    height="100%"
                    placeholder={
                      isBook
                        ? '记录这本书的笔记…'
                        : isDoc
                          ? '记录这个文档的笔记…'
                          : '记录这篇文献的笔记…'
                    }
                    className="h-full"
                    docPath={notesPath(docRef)}
                    imageSubDir="notes-images"
                  />
                ) : (
                  <div className="text-center text-ink-400 py-8">
                    <StickyNote className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">选择文献或图书后开始记笔记</p>
                  </div>
                )}
              </div>

              <div className="px-3 py-2 border-t border-ink-100 flex items-center justify-between flex-shrink-0 bg-paper-100/50">
                <div className="flex items-center gap-1.5 text-xs text-ink-400">
                  {noteSaveState.status === 'saving' && (
                    <>
                      <span className="w-2.5 h-2.5 border border-ink-300 border-t-seal-500 rounded-full animate-spin" />
                      <span className="text-seal-600">保存中...</span>
                    </>
                  )}
                  {noteSaveState.status === 'saved' && (
                    <>
                      <Save className="w-3.5 h-3.5 text-green-500" />
                      <span className="text-green-600 font-medium">
                        已自动保存
                        {noteSaveState.lastSaved && ` ${formatTime(noteSaveState.lastSaved)}`}
                      </span>
                    </>
                  )}
                  {noteSaveState.status === 'idle' && (
                    <>
                      <Save className="w-3.5 h-3.5" />
                      <span>自动保存</span>
                    </>
                  )}
                </div>
                <span className="text-xs text-ink-400 font-mono">
                  {wordCount} 字
                </span>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col">
              <div className="px-3 py-2 border-b border-ink-100 flex-shrink-0 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-ink-500">
                    共 <span className="font-medium text-ink-700">{paperAnnotations.length}</span> 条批注
                  </span>
                  <button
                    onClick={exportAllAnnotations}
                    disabled={paperAnnotations.length === 0}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-seal-600 hover:bg-seal-50 rounded transition disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                  >
                    <Download className="w-3.5 h-3.5" />
                    导出全部
                  </button>
                </div>
                {/* 批量操作条 —— 批注一多，逐条点 × 删太折磨 */}
                {paperAnnotations.length > 0 && (
                  <div className="flex items-center gap-2 text-xs">
                    <label className="flex items-center gap-1.5 cursor-pointer text-ink-600 select-none">
                      <input
                        type="checkbox"
                        className="w-3.5 h-3.5 accent-seal-600"
                        checked={
                          checkedAnnotationIds.length > 0 &&
                          checkedAnnotationIds.length === paperAnnotations.length
                        }
                        onChange={(e) =>
                          setCheckedAnnotationIds(
                            e.target.checked ? paperAnnotations.map((a) => a.id) : [],
                          )
                        }
                      />
                      全选
                    </label>
                    {checkedAnnotationIds.length > 0 && (
                      <span className="text-ink-400">已选 {checkedAnnotationIds.length} 条</span>
                    )}
                    <div className="ml-auto flex items-center gap-1">
                      <button
                        onClick={() => {
                          if (checkedAnnotationIds.length === 0) return
                          if (confirm(`确定删除选中的 ${checkedAnnotationIds.length} 条批注吗？`)) {
                            deleteAnnotations(checkedAnnotationIds)
                          }
                        }}
                        disabled={checkedAnnotationIds.length === 0}
                        className="px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 transition disabled:opacity-40 disabled:cursor-not-allowed disabled:border-ink-200 disabled:text-ink-400"
                      >
                        删除选中
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`确定清空全部 ${paperAnnotations.length} 条批注吗？此操作不可撤销。`)) {
                            deleteAnnotations(paperAnnotations.map((a) => a.id))
                          }
                        }}
                        className="px-2 py-1 rounded border border-ink-200 text-ink-500 hover:bg-paper-100 transition"
                      >
                        清空
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto">
                {paperAnnotations.length === 0 ? (
                  <div className="text-center py-12 text-ink-400 text-sm">
                    <MessageSquare className="w-10 h-10 mx-auto mb-2 opacity-30" />
                    <p>暂无批注</p>
                    <p className="text-xs mt-1">选中文字后可添加高亮和批注</p>
                  </div>
                ) : (
                  <div className="p-2 space-y-2">
                    {orderedAnnotations
                      .map((anno) => {
                        const colorInfo = getColorInfo(anno.color)
                        const isSelected = selectedAnnotationId === anno.id
                        const isEditing = editingAnnotationId === anno.id
                        /** 点批注文字进编辑 —— 不给额外图标，符合直觉（见 UX_DETAILS） */
                        const startEdit = () => {
                          setEditingAnnotationId(anno.id)
                          setTimeout(() => {
                            annotationEditRefs.current[anno.id]?.focus()
                          }, 0)
                        }
                        return (
                          <div
                            key={anno.id}
                            id={`annotation-item-${anno.id}`}
                            className={`p-2.5 rounded-lg border-l-4 transition-all ${colorInfo.border} ${
                              isSelected ? 'ring-2 ring-seal-300 shadow-md' : 'hover:shadow-md'
                            }`}
                          >
                            <div className="flex items-start gap-2">
                              <input
                                type="checkbox"
                                className="mt-0.5 w-3.5 h-3.5 accent-seal-600 flex-shrink-0 cursor-pointer"
                                title="勾选后可批量删除"
                                checked={checkedAnnotationIds.includes(anno.id)}
                                onChange={(e) =>
                                  setCheckedAnnotationIds((prev) =>
                                    e.target.checked
                                      ? [...prev, anno.id]
                                      : prev.filter((x) => x !== anno.id),
                                  )
                                }
                              />
                              <div className="flex-1 min-w-0">
                                {/* 原文：点它跳到正文里的对应位置 */}
                                <p
                                  onClick={() => scrollToAnnotation(anno)}
                                  className="text-xs text-ink-500 italic leading-relaxed cursor-pointer hover:text-ink-800"
                                  title="跳到正文中的位置"
                                >
                                  {anno.text}
                                </p>
                                {/* 批注：点它就地编辑，不再另给编辑按钮 */}
                                {isEditing ? (
                                  <textarea
                                    ref={(el) => {
                                      annotationEditRefs.current[anno.id] = el
                                    }}
                                    value={anno.note}
                                    onChange={(e) => updateAnnotationNote(anno.id, e.target.value)}
                                    onBlur={() => setEditingAnnotationId(null)}
                                    placeholder="写批注…（支持 Markdown，自动保存）"
                                    className="mt-1.5 w-full h-24 p-2 text-xs border border-ink-200 rounded resize-none focus:outline-none focus:border-seal-400 bg-paper-50"
                                  />
                                ) : (
                                  <div
                                    onClick={startEdit}
                                    className="mt-1 text-sm text-ink-700 cursor-text rounded"
                                    title="点击编辑批注"
                                  >
                                    {anno.note ? (
                                      <div
                                        className="prose-sm max-w-none"
                                        dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(anno.note) }}
                                      />
                                    ) : (
                                      <span className="text-xs text-ink-400">点击写批注</span>
                                    )}
                                  </div>
                                )}
                              </div>
                              <button
                                onClick={() => {
                                  if (confirm('确定删除这条批注吗？')) {
                                    deleteAnnotation(anno.id)
                                  }
                                }}
                                className="p-0.5 text-ink-300 hover:text-red-600 rounded transition flex-shrink-0"
                                title="删除批注"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        )
                      })}
                  </div>
                )}
              </div>

              <div className="px-3 py-2 border-t border-ink-100 flex items-center justify-between flex-shrink-0 bg-paper-100/50">
                <div className="flex items-center gap-1.5 text-xs text-ink-400">
                  {annotationSaveState.status === 'saving' && (
                    <>
                      <span className="w-2.5 h-2.5 border border-ink-300 border-t-seal-500 rounded-full animate-spin" />
                      <span className="text-seal-600">保存中...</span>
                    </>
                  )}
                  {annotationSaveState.status === 'saved' && (
                    <>
                      <Save className="w-3.5 h-3.5 text-green-500" />
                      <span className="text-green-600 font-medium">
                        已自动保存
                        {annotationSaveState.lastSaved && ` ${formatTime(annotationSaveState.lastSaved)}`}
                      </span>
                    </>
                  )}
                  {annotationSaveState.status === 'error' && (
                    <>
                      <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
                      <span className="text-red-600 font-medium">保存失败，改动没写进仓库</span>
                    </>
                  )}
                  {annotationSaveState.status === 'idle' && (
                    <>
                      <Save className="w-3.5 h-3.5" />
                      <span>自动保存</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </aside>

      <style>{`
        .prose-reader h1 {
          font-size: 1.875rem;
          font-weight: 700;
          color: #0f172a;
          margin-top: 0.5rem;
          margin-bottom: 1rem;
          padding-bottom: 0.75rem;
          border-bottom: 0.125rem solid #c7d2fe;
        }
        .prose-reader h2 {
          font-size: 1.5rem;
          font-weight: 700;
          color: #1e293b;
          margin-top: 1.5rem;
          margin-bottom: 0.75rem;
          padding-bottom: 0.5rem;
          border-bottom: 1px solid #e2e8f0;
        }
        .prose-reader h3 {
          font-size: 1.25rem;
          font-weight: 600;
          color: #1e293b;
          margin-top: 1.25rem;
          margin-bottom: 0.5rem;
        }
        .prose-reader p {
          margin: 0.75rem 0;
          color: #334155;
          line-height: 1.75;
        }
        .prose-reader ul, .prose-reader ol {
          margin: 0.75rem 0;
          padding-left: 1.5rem;
          color: #334155;
        }
        .prose-reader li {
          margin: 0.375rem 0;
          line-height: 1.625;
        }
        .prose-reader blockquote {
          margin: 1rem 0;
        }
        .prose-reader code {
          font-size: 0.875em;
        }
        .prose-reader pre {
          margin: 1rem 0;
        }
      `}</style>

      {/* 导入其他文档：和管理页是同一套入口（.md 多选 / 粘贴 / zip），落到同一处 documents/ */}
      {showImportDocModal && (
        <Modal title="导入文档" onClose={() => { if (!importing) setShowImportDocModal(false) }}>
          <div className="flex items-center gap-1 p-1 bg-ink-100 rounded-lg mb-5 w-fit">
            {([
              { id: 'file', label: '上传 .md 文件' },
              { id: 'paste', label: '粘贴文本' },
              { id: 'zip', label: '上传 zip' },
            ] as const).map((m) => (
              <button
                key={m.id}
                onClick={() => setImportMode(m.id)}
                disabled={importing}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition disabled:opacity-60 ${
                  importMode === m.id ? 'bg-paper-50 text-seal-600 shadow-sm' : 'text-ink-500 hover:text-ink-700'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {importMode === 'file' && (
            <label
              className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl p-8 text-center transition ${
                importing
                  ? 'opacity-60 pointer-events-none'
                  : 'border-ink-200 bg-paper-100 hover:border-seal-200 hover:bg-seal-50/30 cursor-pointer'
              }`}
            >
              {importing ? <Loader2 className="w-10 h-10 text-seal-500 animate-spin" /> : <Upload className="w-10 h-10 text-ink-400" />}
              <p className="text-sm text-ink-600 font-medium">
                {importing ? '导入中...' : '点击选择 .md / .markdown / .txt 文件'}
              </p>
              <p className="text-xs text-ink-400">支持多选，标题取文件名</p>
              <input
                type="file"
                multiple
                accept=".md,.markdown,.txt"
                className="hidden"
                disabled={importing}
                onChange={(e) => { void handleImportFiles(e.target.files); e.target.value = '' }}
              />
            </label>
          )}

          {importMode === 'paste' && (
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1.5">标题 *</label>
                <input
                  type="text"
                  value={pasteDoc.title}
                  onChange={(e) => setPasteDoc({ ...pasteDoc, title: e.target.value })}
                  placeholder="文档标题"
                  disabled={importing}
                  className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1.5">Markdown 内容 *</label>
                <textarea
                  value={pasteDoc.content}
                  onChange={(e) => setPasteDoc({ ...pasteDoc, content: e.target.value })}
                  placeholder="在此粘贴 markdown 正文..."
                  rows={10}
                  disabled={importing}
                  className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm font-mono focus:outline-none focus:border-seal-400 resize-y"
                />
              </div>
            </div>
          )}

          {importMode === 'zip' && (
            <label
              className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl p-8 text-center transition ${
                importing
                  ? 'opacity-60 pointer-events-none'
                  : 'border-ink-200 bg-paper-100 hover:border-seal-200 hover:bg-seal-50/30 cursor-pointer'
              }`}
            >
              {importing ? <Loader2 className="w-10 h-10 text-seal-500 animate-spin" /> : <Folder className="w-10 h-10 text-ink-400" />}
              <p className="text-sm text-ink-600 font-medium">
                {importing ? '导入中...' : '点击选择 .zip 压缩包'}
              </p>
              <p className="text-xs text-ink-400">自动解出包内所有 .md / .markdown / .txt 条目</p>
              <input
                type="file"
                accept=".zip"
                className="hidden"
                disabled={importing}
                onChange={(e) => { void handleImportZip(e.target.files?.[0]); e.target.value = '' }}
              />
            </label>
          )}

          <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-ink-100">
            {importMode === 'paste' && (
              <button
                onClick={handlePasteImport}
                disabled={importing}
                className="flex items-center gap-2 px-4 py-2 text-sm text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-lg transition disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                {importing ? '导入中...' : '导入'}
              </button>
            )}
            <button
              onClick={() => { if (!importing) setShowImportDocModal(false) }}
              disabled={importing}
              className="px-4 py-2 text-sm text-ink-600 hover:bg-ink-100 rounded-lg transition disabled:opacity-60"
            >
              取消
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
