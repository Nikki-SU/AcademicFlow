/**
 * Vditor 封装 —— 全站唯一 Markdown 编辑器
 * ------------------------------------------------------------
 * 为什么是 Vditor（而不是自己拿 contentEditable 拼）：
 *   所见即所得 + 源码与渲染同框（ir 模式，光标所在块才露语法，等价 Obsidian Live Preview），
 *   无「编辑/预览」切换、无弹窗；公式走 KaTeX；md 进 md 出，不改变落盘格式。
 *
 * 三条硬要求在这里的落点：
 *   1) 不丢渲染 —— 编辑器实例只创建一次，外部 value 变化走 setValue；
 *      回调全部走 ref，React 重渲染不会重置实例。
 *   2) 离线可用 —— 运行时资源（lute/katex/icons/i18n/css）随仓库发在 public/vditor/dist，
 *      通过 cdn 选项指向本地，不依赖 unpkg（墙内/离线都要能跑）。
 *   3) 不丢东西 —— destroy 只在卸载时调用；insertValue 用官方 API，不直接改 DOM。
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import Vditor from 'vditor'
import 'vditor/dist/index.css'
import { toast } from 'sonner'
import {
  blobUrlToRepoPath,
  isRepoImagePath,
  migrateBase64Images,
  parseImageSize,
  repoImageBlobUrl,
  toRepoPath,
  uploadEditorImage,
} from '../services/editorImages'
import { useSettingsStore } from '../stores/settings'
import { CODE_LANGS } from '../constants/codeLangs'
import { editTable, type TableOp } from '../services/formula'
import { extractCitationsFromMarkdown, normalizeDoi } from '../services/citation'

export type VditorMode = 'ir' | 'wysiwyg' | 'sv'

/** 工具栏项：内置项用名字字符串，自定义项用对象 */
export type VditorToolbarItem =
  | string
  | {
      name: string
      tip?: string
      icon?: string
      click?: (event: Event, vditor: IVditor) => void
    }

export interface VditorEditorHandle {
  /** 取当前 md 源码 */
  getValue: () => string
  /** 用外部 md 覆盖编辑器内容 */
  setValue: (md: string) => void
  /** 在光标处插入 md 片段（图片 base64、公式模板等） */
  insertValue: (md: string) => void
  /**
   * 在「用户最后停留的正文位置」插入 md 片段。
   * 与 insertValue 的区别：焦点被侧栏/模态框抢走之后（点按钮必然发生），
   * insertValue 会把内容插到文档开头；这个不会。
   */
  insertAtCursor: (md: string) => void
  /** 滚动到第 index 个标题（序号与 extractOutline 解析出的顺序一致） */
  scrollToHeading: (index: number) => void
  /**
   * 滚动到某个「图 / 表 / 公式」，并短暂高亮。
   *
   * 优先按**内容**定位（match 传该条目的源码/原文）；传了 match 又对不上时，
   * 才退回按 index 顺数。详见 collectAnchors 上的说明：序号法在 IR 模式下不可靠。
   */
  scrollToBlock: (kind: 'image' | 'table' | 'formula', index: number, match?: string) => void
  /** 滚动到第 occurrence 处含该文本的位置并高亮（引用标记跳转用，从 0 开始数） */
  scrollToText: (text: string, occurrence?: number) => void
  /** 取消当前的高亮（点同一个点点的第二次） */
  clearHighlight: () => void
  /** 聚焦编辑器 */
  focus: () => void
}

/**
 * 取当前模式下可编辑的 DOM 根节点。
 *
 * 注意层级：Vditor 实例本身没有 ir/wysiwyg/sv，它们挂在 `vditor.vditor`（IVditor）上
 * —— 之前写成 `vditor[mode]` 一直取到 undefined，函数**静默返回 null**，
 * 跳转就没反应（不报错、不提示）。实测踩过。
 * mode='ir' 时拿到的是 `<pre class="vditor-reset">`，块都在它里面。
 */
function editorElement(vditor: Vditor | null): HTMLElement | null {
  if (!vditor) return null
  const inner = vditor.vditor as unknown as
    | Record<string, { element?: HTMLElement } | undefined>
    | undefined
  return inner?.[vditor.getCurrentMode()]?.element ?? null
}

/** 规范化：压平空白 —— md 解析出的源码与 DOM 里的源码在缩进/换行上可能不同 */
function normalizeSource(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 去掉 Markdown 标记，只留「文字骨架」。
 *
 * 用途只有一个：**表格**的兜底比对。实测 IR 模式下表格没有源码视图
 * （只有 `<table data-type="table">` 渲染结果），单元格里的 `**加粗**` / `[链接](url)`
 * 渲染后 textContent 是不带标记的，跟 md 原文对不上。此时比骨架还能对上。
 */
function markdownSkeleton(s: string): string {
  return s.replace(/[\s*_`~$\\{}[\]()!|#>+\-]/g, '')
}

interface ContentAnchor {
  /** 规范化后的内容：公式 = 源码；图片 = ![alt](src)；表格 = 表头文字 */
  text: string
  /** 滚动 / 高亮的目标节点 */
  target: HTMLElement
}

/**
 * 按**内容**在渲染后的 DOM 里认「图 / 表 / 公式」。
 *
 * 为什么不能用序号：IR 模式下每个块在 DOM 里都是「源码视图 + 渲染视图」两份，
 * 实测一篇含 4 个公式的文档，`.katex` 有 4 个、带 data-type 的公式节点却有 8 个；
 * 图/表同样各有源码与渲染两份。于是只要任何一处数量与 md 解析结果对不上
 * （公式渲染失败、图片没加载出来、光标停在公式里触发的浮动面板……），
 * 序号就整体偏移 —— 用户点第 3 条跳到第 2 条，而且**错得毫无提示**。
 *
 * 实测（Vditor 3.11.2 / ir 模式）拿到的稳定锚点，就是源码视图本身：
 *   行内公式：<code class="vditor-ir__marker--pre" data-type="math-inline"> 的 textContent
 *   行间公式：<div class="vditor-ir__node" data-type="math-block"> 内
 *             <code data-type="math-block"> 的 textContent
 *   图片    ：<span class="vditor-ir__node" data-type="img"> 的 textContent（即 ![alt](src)）
 *   表格    ：<table data-type="table"> 无源码视图，按表头/首行文字比对
 */
function collectAnchors(
  root: HTMLElement,
  kind: 'image' | 'table' | 'formula',
): ContentAnchor[] {
  // 浮动面板（光标停在公式里时 Vditor 弹的预览）里的节点一律不算
  const isInEditorContent = (n: HTMLElement) =>
    !n.closest('[class*="vditor-panel"],[class*="vditor-tip"],[class*="vditor-resize"]')

  if (kind === 'formula') {
    return Array.from(
      root.querySelectorAll<HTMLElement>(
        'code.vditor-ir__marker--pre[data-type="math-inline"], .vditor-ir__node[data-type="math-block"]',
      ),
    )
      .filter(isInEditorContent)
      .map((n) => {
        const isInlineSource = n.tagName === 'CODE'
        const srcNode = isInlineSource
          ? n
          : n.querySelector<HTMLElement>('code[data-type="math-block"]')
        const target = isInlineSource
          ? (n.closest<HTMLElement>('.vditor-ir__node') ?? n)
          : n
        return { text: normalizeSource((srcNode ?? n).textContent ?? ''), target }
      })
  }

  if (kind === 'image') {
    return Array.from(root.querySelectorAll<HTMLElement>('.vditor-ir__node[data-type="img"]'))
      .filter(isInEditorContent)
      .map((n) => ({ text: normalizeSource(n.textContent ?? ''), target: n }))
  }

  return Array.from(root.querySelectorAll<HTMLElement>('table[data-type="table"]'))
    .filter(isInEditorContent)
    .map((n) => {
      const cells = Array.from(n.querySelectorAll<HTMLElement>('th, td')).slice(0, 4)
      return {
        text: normalizeSource(cells.map((c) => c.textContent ?? '').join(' ')),
        target: n,
      }
    })
}

/**
 * 短暂描边高亮，帮用户在一屏里立刻看到「跳过来的这一条」是哪个。
 *
 * 同一时刻只允许一个高亮：再 flash 一次会先把上一个还原。
 * （原来每个 flash 各自 setTimeout 还原各自的 prev，连着点两次时
 *  第二次的 prev 已经是第一次设上的描边 —— 结果描边永远留在那里，
 *  用户看到的就是「跳过去之后那块内容一直被框中」。）
 */
let flashedNode: HTMLElement | null = null
let flashedRestore: { outline: string; offset: string } | null = null
let flashTimer: number | null = null

export function clearFlash() {
  if (flashTimer !== null) {
    window.clearTimeout(flashTimer)
    flashTimer = null
  }
  if (flashedNode && flashedRestore) {
    flashedNode.style.outline = flashedRestore.outline
    flashedNode.style.outlineOffset = flashedRestore.offset
  }
  flashedNode = null
  flashedRestore = null
}

function flashElement(node: HTMLElement) {
  // 先把上一次的收干净，保证「再点一次 = 取消高亮」这个语义成立
  clearFlash()
  flashedNode = node
  flashedRestore = { outline: node.style.outline, offset: node.style.outlineOffset }
  node.style.outline = '2px solid #6366f1'
  node.style.outlineOffset = '3px'
  flashTimer = window.setTimeout(clearFlash, 4000)
}

interface VditorEditorProps {
  /** 初始 / 外部 md 内容 */
  value: string
  /** 内容变化（已做"同值不触发"过滤） */
  onChange?: (md: string) => void
  /** 失焦（用于"编辑完立刻存一次"） */
  onBlur?: (md: string) => void
  /** 准备就绪（实例创建完） */
  onReady?: () => void
  /** 高度：数字=px；传 '100%' 或省略 = 跟随容器（内部会测出像素值再给 Vditor） */
  height?: number | string
  placeholder?: string
  /** ir（默认，即时渲染）/ wysiwyg（隐藏语法，最接近飞书）/ sv（分屏） */
  mode?: VditorMode
  /** 传给 Vditor 的工具栏；不传用内置精简工具栏（含"插入公式"） */
  toolbar?: VditorToolbarItem[]
  /**
   * 点「插入公式」按钮时的回调。
   * 传了就把公式按钮交给外部（写作页的公式侧栏）；不传则用内置的
   * 「行内 / 行间」小菜单 + 模板插入（兼容其它页面）。
   */
  onFormulaClick?: () => void
  /** 只读（用于预览态） */
  disabled?: boolean
  className?: string
  /**
   * 本文档在仓库里的路径（如 projects/p1/manuscript.md）。
   * 传了才接管图片：上传落到同目录下的 images/，md 里写仓库路径，渲染时取回原图。
   * 不传 = 维持「图片转 base64 内嵌」的老行为。
   */
  docPath?: string
  /** 图片子目录名。阅读笔记用 notes-images，免得和正文抽取出的图混在一起 */
  imageSubDir?: string
}

/** 运行时资源目录：public/vditor/dist/...（构建后位于 BASE_URL 下） */
const VDITOR_CDN = `${import.meta.env.BASE_URL}vditor`

/**
 * 图标 sprite 必须由我们自己用「外部脚本」加载，不能让 Vditor 自己加载。
 * ------------------------------------------------------------
 * 为什么：Vditor 的工具栏图标全是 <svg><use xlink:href="#vditor-icon-bold"></use></svg>，
 * 依赖一份注入到 <body> 的 SVG symbol 表。而 Vditor 注入它的方式是 addScriptSync ——
 * 把 ant.js（43 KB）读出来塞进一个「内联」<script>.text 再执行。
 * 本站 CSP 是 script-src 'self' 'unsafe-eval'（没有 'unsafe-inline'），内联脚本一律被拦，
 * 结果就是 symbol 表从来没进过 DOM → 工具栏所有内置图标（加粗/斜体/列表/撤销…）全部空白，
 * 只有自带内联 <path> 的自定义图标（插入引用/公式）还能显示。
 *
 * 做法：自己插入一个「外部」<script>（CSP 放行），URL 用 import.meta.env.BASE_URL 拼，
 * dev 与构建后都指向同一份 public/vditor 资源；同时给 Vditor 传 icon: '' 关掉它那条被拦的路径。
 * id 沿用 Vditor 内部的 'vditorIconScript'：它靠这个 id 判重，看到就直接跳过。
 */
function ensureVditorIconSprite() {
  if (typeof document === 'undefined') return
  if (document.getElementById('vditorIconScript')) return
  const el = document.createElement('script')
  el.id = 'vditorIconScript'
  el.src = `${VDITOR_CDN}/dist/js/icons/ant.js`
  document.head.appendChild(el)
}

ensureVditorIconSprite()

/**
 * 「插入公式」的图标（Vditor 内置图标集里没有合适的，自带一个 SVG 字符串）。
 * 传了 `onFormulaClick` 的页面（写作页）会打开公式侧栏；
 * 没传的页面才退回这个「行内 / 行间」小菜单 + 模板。
 */
const FORMULA_ICON =
  '<svg viewBox="0 0 32 32" width="14" height="14"><path fill="currentColor" d="M6 4h20v3H9.6l6.1 9-6.1 9H26v3H6l7.4-10.9L6 4z"/><path fill="currentColor" d="M19 13h9v2h-9zm3-3h2v8h-2z"/></svg>'

/**
 * 公式模板（侧栏不可用时的兜底）：行内 $…$ / 行间 $$…$$
 * 占位符用 `\square` 而不是「公式」两个字 —— 后者在数学模式里会渲染成红色的 KaTeX 报错，
 * 而 `\square` 是个看得见的空框（和侧栏结构按钮的占位符同一套约定）。
 */
const FORMULA_TEMPLATE = {
  inline: ' $\\square$ ',
  block: '\n$$\n\\square\n$$\n',
} as const

/** 在工具栏按钮下方弹出「行内 / 行间」小菜单（点击外部即关闭，不用 window.prompt） */
function openFormulaMenu(anchor: HTMLElement, onPick: (kind: 'inline' | 'block') => void) {
  document.getElementById('af-formula-menu')?.remove()

  const menu = document.createElement('div')
  menu.id = 'af-formula-menu'
  menu.className =
    'fixed z-[9999] bg-paper-50 border border-ink-200 rounded-lg shadow-xl py-1 text-sm min-w-[8.75rem]'
  const rect = anchor.getBoundingClientRect()
  menu.style.top = `${Math.round(rect.bottom + 6)}px`
  menu.style.left = `${Math.round(rect.left)}px`

  const items: { kind: 'inline' | 'block'; label: string; hint: string }[] = [
    { kind: 'inline', label: '行内公式', hint: '$\u2026$' },
    { kind: 'block', label: '行间公式', hint: '$$\u2026$$' },
  ]
  for (const it of items) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'w-full flex items-center justify-between gap-3 px-3 py-1.5 hover:bg-seal-50 text-ink-700'
    btn.innerHTML = `<span>${it.label}</span><span class="text-xs text-ink-400 font-mono">${it.hint}</span>`
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      close()
      onPick(it.kind)
    })
    menu.appendChild(btn)
  }

  const close = () => {
    menu.remove()
    document.removeEventListener('mousedown', onDocDown, true)
  }
  const onDocDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close()
  }

  document.body.appendChild(menu)
  // 延后一帧再挂全局监听，避免这次点击立刻把菜单关掉
  setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0)
}

/** 文件名里会破坏图片语法的字符去掉 */
function imageAlt(name: string): string {
  return name.replace(/[[\]()]/g, '').trim() || 'image'
}

/** 代码块图标直接复用 Vditor 图标表里的 code，不另做一套 */
const CODE_ICON = '<svg><use xlink:href="#vditor-icon-code"></use></svg>'

/** 网格选择器的上限；再多也没人靠点选，直接手写更快 */
const TABLE_GRID_MAX = 10

/**
 * 生成一张纯空表格。
 * Vditor 内置的表格按钮会往单元格里塞 foo / bar 之类的占位文字，
 * 每次插完都要先把它们删干净 —— 这里只留空格，光标点进去就能写。
 */
function buildEmptyTable(rows: number, cols: number): string {
  const cell = `|${'  |'.repeat(cols)}`
  const sep = `|${' --- |'.repeat(cols)}`
  const body = Array.from({ length: rows }, () => cell).join('\n')
  return `\n${cell}\n${sep}\n${body}\n`
}

/**
 * WPS 那种网格选行列：在格子上滑过就高亮出「几行几列」，点一下插入。
 * 动态元素一律用内联样式 —— Tailwind 只生成源码里写死的类名，拼出来的类不会生效。
 */
function openTableGridMenu(anchor: HTMLElement, onPick: (rows: number, cols: number) => void) {
  document.getElementById('af-table-grid')?.remove()

  const wrap = document.createElement('div')
  wrap.id = 'af-table-grid'
  wrap.className = 'fixed z-[9999] bg-paper-50 border border-ink-200 rounded-lg shadow-xl p-2'
  const rect = anchor.getBoundingClientRect()
  wrap.style.top = `${Math.round(rect.bottom + 6)}px`
  wrap.style.left = `${Math.round(rect.left)}px`

  const tip = document.createElement('div')
  tip.className = 'text-[0.6875rem] text-ink-500 mb-1.5 text-center'
  tip.textContent = '滑过选择行列'
  wrap.appendChild(tip)

  const grid = document.createElement('div')
  grid.style.display = 'grid'
  grid.style.gridTemplateColumns = `repeat(${TABLE_GRID_MAX}, 1.125rem)`
  grid.style.gap = '2px'

  let rows = 0
  let cols = 0
  const cells: HTMLDivElement[] = []

  const paint = () => {
    cells.forEach((c, i) => {
      const r = Math.floor(i / TABLE_GRID_MAX)
      const col = i % TABLE_GRID_MAX
      const on = r < rows && col < cols
      c.style.background = on ? '#4338ca' : '#eef0f2'
    })
    tip.textContent = rows && cols ? `${rows} 行 × ${cols} 列` : '滑过选择行列'
  }

  for (let r = 0; r < TABLE_GRID_MAX; r++) {
    for (let c = 0; c < TABLE_GRID_MAX; c++) {
      const cell = document.createElement('div')
      cell.style.width = '1.125rem'
      cell.style.height = '1.125rem'
      cell.style.borderRadius = '2px'
      cell.style.cursor = 'pointer'
      cell.style.background = '#eef0f2'
      cell.addEventListener('mouseenter', () => {
        rows = r + 1
        cols = c + 1
        paint()
      })
      cell.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        close()
        if (rows && cols) onPick(rows, cols)
      })
      cells.push(cell)
      grid.appendChild(cell)
    }
  }

  wrap.appendChild(grid)

  const close = () => {
    wrap.remove()
    document.removeEventListener('mousedown', onDocDown, true)
  }
  const onDocDown = (e: MouseEvent) => {
    if (!wrap.contains(e.target as Node)) close()
  }

  document.body.appendChild(wrap)
  setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0)
}

/**
 * 选代码语言的小弹层。
 * 内置的代码块按钮不会带语言，而「先插入再手打语言」在 IR 模式下很别扭，
 * 所以插入前就把语言选掉。
 */
function openCodeLangMenu(anchor: HTMLElement, current: string, onPick: (lang: string) => void) {
  document.getElementById('af-code-lang-menu')?.remove()

  const menu = document.createElement('div')
  menu.id = 'af-code-lang-menu'
  menu.className =
    'fixed z-[9999] bg-paper-50 border border-ink-200 rounded-lg shadow-xl py-1 text-sm ' +
    'max-h-[18rem] overflow-y-auto min-w-[9.5rem]'
  const rect = anchor.getBoundingClientRect()
  menu.style.top = `${Math.round(rect.bottom + 6)}px`
  menu.style.left = `${Math.round(rect.left)}px`

  for (const it of CODE_LANGS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className =
      'w-full flex items-center justify-between gap-3 px-3 py-1.5 hover:bg-seal-50 text-ink-700'
    btn.innerHTML =
      `<span>${it.label}</span>` +
      (it.value === current ? '<span class="text-[0.625rem] text-seal-500">默认</span>' : '')
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      close()
      onPick(it.value)
    })
    menu.appendChild(btn)
  }

  const close = () => {
    menu.remove()
    document.removeEventListener('mousedown', onDocDown, true)
  }
  const onDocDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close()
  }

  document.body.appendChild(menu)
  // 延后一帧再挂全局监听，避免这次点击立刻把菜单关掉
  setTimeout(() => document.addEventListener('mousedown', onDocDown, true), 0)
}

const VditorEditor = forwardRef<VditorEditorHandle, VditorEditorProps>(function VditorEditor(
  { value, onChange, onBlur, onReady, height = 420, placeholder = '开始写作…', mode = 'ir', toolbar, onFormulaClick, disabled = false, className = '', docPath, imageSubDir },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const vditorRef = useRef<Vditor | null>(null)
  /**
   * 自己记住「用户最后停在编辑器里的选区」。
   * ------------------------------------------------------------
   * Vditor 只在 blur 的那一刻把 Range 缓存进 vditor[mode].range
   * （node_modules/vditor/src/ts/util/editorCommonEvent.ts）。一旦那份缓存缺失或失效，
   * getEditorRange() 会 focus() 编辑器、并把 Range 设成容器第 0 个子节点
   * （src/ts/util/selection.ts）—— 于是插入跑到文档最开头，还可能触发整篇 IR 重排，
   * 用户看到的就是「点插入没反应 / 插到别处」。
   * 而点工具栏按钮、开引用模态框都会让编辑器 blur，这条路径必然踩到。
   *
   * 对策：在 selectionchange 时自己存一份克隆 Range，且只在「选区确实落在编辑器内部」时更新。
   * 这样即使后来焦点被侧栏或模态框抢走，手里那份仍是用户最后在正文里的位置。
   */
  const savedRangeRef = useRef<Range | null>(null)
  /** 最近一次"双方达成一致"的值：用来判断外部 value 变化是不是我们自己 emit 出去的 */
  const lastValueRef = useRef(value)
  /** 图片上下文的实时镜像：Vditor 实例与 MutationObserver 只建一次，读 prop 会拿到旧值 */
  const docPathRef = useRef(docPath)
  docPathRef.current = docPath
  const imageSubDirRef = useRef(imageSubDir)
  imageSubDirRef.current = imageSubDir
  /** 已经自动迁移过 base64 图的文档，避免边写边反复触发 */
  const migratedDocRef = useRef<string | null>(null)
  /** 插入代码块用的默认语言（设置页可改） */
  const defaultCodeLang = useSettingsStore((s) => s.defaultCodeLang ?? 'python')
  const defaultCodeLangRef = useRef(defaultCodeLang)
  defaultCodeLangRef.current = defaultCodeLang
  /** 间隔上色（斑马纹）：块级背景交替，长文里不容易看串行。设置页可关 */
  const zebra = useSettingsStore((s) => s.editorZebra ?? true)
  const onChangeRef = useRef(onChange)
  const onBlurRef = useRef(onBlur)
  const onReadyRef = useRef(onReady)
  const onFormulaClickRef = useRef(onFormulaClick)

  onChangeRef.current = onChange
  onBlurRef.current = onBlur
  onReadyRef.current = onReady
  onFormulaClickRef.current = onFormulaClick

  /**
   * 插到「用户最后停留的位置」。
   * 点工具栏、选完图片文件时焦点都已经不在编辑器上，此时直接用 Vditor 的 insertValue
   * 会插到文档开头 —— 所以先把记下的 Range 还回去（见 savedRangeRef 的说明）。
   */
  const insertAtCursorImpl = (md: string) => {
    const inst = vditorRef.current
    if (!inst) return
    const el = editorElement(inst)
    const range = savedRangeRef.current

    inst.focus()
    if (el && range && el.contains(range.startContainer)) {
      const sel = window.getSelection()
      if (sel) {
        sel.removeAllRanges()
        sel.addRange(range)
      }
    }
    inst.insertValue(md)

    // 插入后 DOM 已变，旧 Range 立刻失效；等一轮让 Vditor 落好光标再重新记一份，
    // 这样连续插两条引用时第二条仍然落在正确位置。
    setTimeout(() => {
      const sel = window.getSelection()
      if (el && sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).startContainer)) {
        savedRangeRef.current = sel.getRangeAt(0).cloneRange()
      }
    }, 0)
  }

  /**
   * 上传一张图并把 `![alt](仓库路径)` 插到光标处。
   * 上传要几秒，期间给一个 loading toast —— 静默会让人以为点了没反应。
   */
  const uploadOne = async (doc: string, file: File) => {
    const id = toast.loading('正在上传图片…')
    try {
      const repoPath = await uploadEditorImage({
        docPath: doc,
        file,
        fileName: file.name,
        sub: imageSubDirRef.current,
      })
      insertAtCursorImpl(`![${imageAlt(file.name)}](${repoPath})`)
      toast.success('图片已上传', { id })
    } catch (e) {
      toast.error(`图片上传失败：${e instanceof Error ? e.message : String(e)}`, {
        id,
        duration: 8000,
      })
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      getValue: () => vditorRef.current?.getValue() ?? lastValueRef.current,
      setValue: (md: string) => {
        lastValueRef.current = md
        vditorRef.current?.setValue(md)
      },
      insertValue: (md: string) => {
        vditorRef.current?.insertValue(md)
      },
      insertAtCursor: insertAtCursorImpl,
      scrollToHeading: (index: number) => {
        // 直接查渲染后的标题 DOM：与 extractOutline(md) 的标题顺序一致（都按文档从上到下）
        const headings = containerRef.current?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')
        headings?.[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      },
      scrollToBlock: (kind, index, match) => {
        const el = editorElement(vditorRef.current)
        if (!el) return
        const anchors = collectAnchors(el, kind)

        let node: HTMLElement | undefined
        const want = match ? normalizeSource(match) : ''
        if (want) {
          // 同一内容可能出现多次（同一个公式用了两遍），此时用 index 在**内容相同的候选里**
          // 挑第几个 —— 选错也只是同一段文字里的另一处，不会整体错位。
          const exact = anchors.filter((a) => a.text === want)
          const wantSkel = markdownSkeleton(want)
          const loose = exact.length
            ? exact
            : anchors.filter(
                (a) =>
                  a.text.includes(want) ||
                  want.includes(a.text) ||
                  (wantSkel.length > 0 && markdownSkeleton(a.text) === wantSkel),
              )
          node = loose[index]?.target ?? loose[0]?.target
        }
        // 内容对不上（md 刚改过、Vditor 还没重渲染等）才退回序号，尽量别让点击没反应
        if (!node) node = anchors[index]?.target
        if (!node) return
        node.scrollIntoView({ behavior: 'smooth', block: 'center' })
        flashElement(node)
      },
      scrollToText: (text, occurrence = 0) => {
        const el = editorElement(vditorRef.current)
        if (!el || !text) return

        // 同一篇文献在正文里可能被引很多次，每个「点」对应其中一处 ——
        // 所以按文档顺序数：第 occurrence 个匹配才是我要跳的那个。
        const jumpTo = (want: number): boolean => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          let seen = 0
          let node = walker.nextNode()
          while (node) {
            const data = (node as Text).data
            let from = 0
            for (;;) {
              const at = data.indexOf(text, from)
              if (at === -1) break
              if (seen === want) {
                const target = (node.parentElement ?? el) as HTMLElement
                target.scrollIntoView({ behavior: 'smooth', block: 'center' })
                flashElement(target)
                return true
              }
              seen++
              from = at + text.length
            }
            node = walker.nextNode()
          }
          return false
        }

        // 数不到想要的那一处（正文刚改过、渲染还没跟上）就退回第一处，
        // 总比点了完全没反应好。
        if (!jumpTo(occurrence) && occurrence !== 0) jumpTo(0)
      },
      clearHighlight: clearFlash,
      focus: () => vditorRef.current?.focus(),
    }),
    [],
  )

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    /**
     * 高度必须是数字。
     * 传 '100%' 时 Vditor 只会把 .vditor 设成 height:100%，它的内容区没有高度约束，
     * 于是整篇文档把容器撑破 —— 编辑区失去内部滚动、内容溢出被外层裁掉。
     * 这里先量一次容器高度当初始值，之后由下面的 ResizeObserver 跟随容器变化。
     */
    const containerHeight = () =>
      Math.max(120, Math.round(el.getBoundingClientRect().height) || el.clientHeight || 320)
    const initialHeight = typeof height === 'number' ? height : containerHeight()

    const formulaItem: VditorToolbarItem = {
      name: 'insert-formula',
      tip: '插入公式（行内 / 行间）',
      icon: FORMULA_ICON,
      click: (event: Event) => {
        // 外部接管（写作页的公式侧栏）：直接回调，不再弹小菜单
        if (onFormulaClickRef.current) {
          onFormulaClickRef.current()
          return
        }
        // Vditor 触发 click 时 currentTarget 可能已为空，用它的 data-type 兜底定位按钮
        const anchor =
          (event.currentTarget as HTMLElement | null) ??
          (event.target as HTMLElement | null) ??
          (document.querySelector('[data-type="insert-formula"]') as HTMLElement | null)
        openFormulaMenu(anchor ?? document.body, (kind) => {
          vditorRef.current?.insertValue(FORMULA_TEMPLATE[kind])
        })
      },
    }

    // 代码块：内置那个按钮只会插一对空围栏、不带语言，这里换成「先选语言再插入」
    const codeItem: VditorToolbarItem = {
      name: 'insert-code',
      tip: '插入代码块（可选语言）',
      icon: CODE_ICON,
      click: (event: Event) => {
        const anchor =
          (event.currentTarget as HTMLElement | null) ??
          (event.target as HTMLElement | null) ??
          (document.querySelector('[data-type="insert-code"]') as HTMLElement | null)
        openCodeLangMenu(anchor ?? document.body, defaultCodeLangRef.current, (lang) => {
          vditorRef.current?.insertValue(`\n\`\`\`${lang}\n\n\`\`\`\n`)
        })
      },
    }

    // 表格：内置那个既不能选行列、又会塞占位文字，换成网格选行列 + 空单元格
    const tableItem: VditorToolbarItem = {
      name: 'insert-table',
      tip: '插入表格（选行列）',
      icon: '<svg><use xlink:href="#vditor-icon-table"></use></svg>',
      click: (event: Event) => {
        const anchor =
          (event.currentTarget as HTMLElement | null) ??
          (event.target as HTMLElement | null) ??
          (document.querySelector('[data-type="insert-table"]') as HTMLElement | null)
        openTableGridMenu(anchor ?? document.body, (rows, cols) => {
          vditorRef.current?.insertValue(buildEmptyTable(rows, cols))
        })
      },
    }

    // 『quote』(引用块) 已去掉：与正文的文献引用（[@doi:…] 标记）容易混淆
    const defaultToolbar: VditorToolbarItem[] = [
      'headings', 'bold', 'italic', 'strike', 'link', '|',
      'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
      'line', 'code', 'inline-code', '|',
      'table', 'upload',
      formulaItem,
      '|',
      'undo', 'redo', '|',
      'edit-mode', 'fullscreen',
    ]

    // 外部传了 toolbar 就在其末尾补上「插入公式」，保证全站都有这个按钮；
    // 顺便把内置 'code' / 'table' 换成本地那两个（可选语言 / 可选行列）
    const baseToolbar = toolbar ? [...toolbar, formulaItem] : defaultToolbar
    const finalToolbar = baseToolbar.map((it) =>
      it === 'code' ? codeItem : it === 'table' ? tableItem : it,
    )

    const instance = new Vditor(el, {
      // ── 离线资源：不写这一项就会去 unpkg 拉 lute/katex，墙内必挂 ──
      cdn: VDITOR_CDN,
      // 图标 sprite 由模块顶部 ensureVditorIconSprite() 用外部脚本注入（见那里的说明）；
      // 传空字符串关掉 Vditor 自己那条「内联脚本」加载路径 —— 它会被本站 CSP 拦掉。
      // （Vditor 的 icon 类型只声明了 'ant' | 'material'，运行时用空串表示「我自己加载」）
      icon: '' as 'ant',
      mode,
      height: initialHeight,
      minHeight: 120,
      placeholder,
      value: lastValueRef.current,
      cache: { enable: false },
      counter: { enable: true, type: 'text' },
      outline: { enable: false, position: 'left' },
      resize: { enable: false },
      // KaTeX 的 `inlineDigit`：`$1$`（$ 后紧跟数字）算不算公式。
      // ⚠️ 必须**顶层与 preview 两处都设** —— Vditor 编辑器内联渲染读的是顶层的
      // math.inlineDigit（默认 false），而预览读的是 preview.math.inlineDigit。
      // 只设 preview 的话，`$1$` 在预览里是公式、在编辑区里是纯文本，
      // 又一次「输入一个样、预览一个样」。（版本也要与 npm katex 一致，见 package.json）
      math: { inlineDigit: true },
      preview: {
        math: { engine: 'KaTeX', inlineDigit: true },
        // 代码高亮用 Vditor 自带的那份 highlight.js（已随仓库放在 public/vditor/dist 下），
        // 配色选 vs2015 —— 就是 VSCode 深色那套色系。mark.js 仍然不开（用不上）。
        hljs: { enable: true, style: 'vs2015', lineNumber: false },
        markdown: { toc: false, mark: false, footnotes: true },
        theme: { current: 'light', path: `${VDITOR_CDN}/dist/css/content-theme` },
      },
      toolbar: finalToolbar,
      toolbarConfig: { pin: true },
      upload: {
        // 有文档上下文 → 传到仓库，md 里只写仓库路径（链接短、可跨文件复制、能进 LaTeX）；
        // 没有上下文的老页面才退回 base64 内嵌。
        // handler 返回 null = 不走 Vditor 的 URL 回填流程，插入由我们自己完成。
        handler: (files: File[]): null => {
          for (const file of files) {
            if (!file.type.startsWith('image/')) continue
            const doc = docPathRef.current
            if (!doc) {
              const reader = new FileReader()
              reader.onload = () => {
                const dataUrl = String(reader.result || '')
                if (dataUrl) insertAtCursorImpl(`![${imageAlt(file.name)}](${dataUrl})`)
              }
              reader.readAsDataURL(file)
              continue
            }
            void uploadOne(doc, file)
          }
          return null
        },
      },
      input: (md: string) => {
        // 保险：万一 blob URL 被 Vditor 序列化回了 md，按反查表还原成仓库路径
        const clean = md.includes('blob:')
          ? md.replace(/blob:[^)"'\s]+/g, (u) => blobUrlToRepoPath(u))
          : md
        lastValueRef.current = clean
        onChangeRef.current?.(clean)
      },
      blur: () => {
        onBlurRef.current?.(vditorRef.current?.getValue() ?? lastValueRef.current)
      },
      after: () => {
        onReadyRef.current?.()
      },
      // Vditor 运行时的默认配置里**确实有**顶层 `math: {engine, inlineDigit}`
      // （dist/index.js 里编辑器内联渲染读的就是它），但它的 .d.ts 没声明这个字段。
      // 只为这一个多余的键加断言，不把整个 options 变成 any。
    } as ConstructorParameters<typeof Vditor>[1])

    vditorRef.current = instance

    return () => {
      try {
        instance.destroy()
      } catch {
        /* 卸载期销毁失败无所谓 */
      }
      vditorRef.current = null
    }
    // 只创建一次：value / 回调都走 ref 与下面的同步 effect —— 重渲染绝不重建实例
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 编辑器里的图片，Vditor 自己做不了两件事，得在 DOM 层补：
   *   1) 仓库路径 → blob URL —— 浏览器拿它当相对地址去请求必然 404
   *   2) title 里的 width/height → <img> 的实际尺寸
   * 只改显示、不改 md（落盘始终是仓库路径 + title），所以跟着 Vditor 的重渲染走，
   * 而不是去动 value。
   */
  useEffect(() => {
    if (!docPath) return
    const root = containerRef.current
    if (!root) return

    let timer: ReturnType<typeof setTimeout> | null = null

    const sync = () => {
      const el = editorElement(vditorRef.current)
      if (!el) return
      el.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
        const current = img.getAttribute('src') || ''
        const size = parseImageSize(img.getAttribute('title'))
        if (size) {
          if (size.width) img.style.width = size.width
          img.style.height = size.height || 'auto'
          // title 被借来存尺寸了，别让它变成鼠标悬停提示
          img.removeAttribute('title')
        }
        if (!isRepoImagePath(current)) return
        const repoPath = toRepoPath(current, docPathRef.current ?? docPath)
        img.dataset.afRepoPath = repoPath
        void repoImageBlobUrl(repoPath).then((url) => {
          // 期间可能已重渲染成别的图，认一下再写
          if (url && img.dataset.afRepoPath === repoPath) img.setAttribute('src', url)
        })
      })
    }

    // Vditor 输入时 DOM 变更密集，合并成一次
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(sync, 80)
    }

    const mo = new MutationObserver(schedule)
    mo.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'title'],
    })
    sync()

    return () => {
      mo.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [docPath])

  /**
   * 正文里的引用标记 `[@doi:…]` 渲染成**普通编号** `[12]`。
   *
   * 为什么这么做：源码里必须留 `[@doi:…]`（LaTeX 转换靠它认 DOI，见 Writing.tsx 的
   * citationMarker），但让人读一屏 `[@doi:10.1021/jacs.3c07992]` 是没法看的 ——
   * 用户要的是「像个编号一样」。
   *
   * 关键约束：**不能改 DOM 里的文字**。IR 模式下 Vditor 是把 DOM 反序列化回 markdown 的，
   * 往里塞可见文字会直接把稿子里的标记改掉。所以：
   *   - 原文用 <span class="af-cite-src"> 包住，CSS 里 font-size:0 藏起来（仍在 DOM 里，md 不变）；
   *   - 编号用 **CSS ::after 的 content: attr(data-num)** 显示 —— 伪元素不在 DOM 里，
   *     永远不会被序列化进 markdown。
   * 编号按首次出现顺序，与「引用表」侧栏的 #N 完全一致。
   */
  useEffect(() => {
    const markerRe = /\[@(?:doi:)?([^\]]+)\]/gi

    const decorate = () => {
      const el = editorElement(vditorRef.current)
      if (!el) return

      const md = lastValueRef.current
      const dois = extractCitationsFromMarkdown(md)
      if (dois.length === 0) return
      const numOf = new Map(dois.map((d, i) => [d, i + 1]))

      // 统计源码里**我们能包**的标记数（认不出 DOI 的不算 —— 否则
      // 「包不上 → 数量对不上 → 再包一次」会一直触发 MutationObserver）
      let expected = 0
      {
        const re = new RegExp(markerRe.source, 'gi')
        let m: RegExpExecArray | null
        while ((m = re.exec(md)) !== null) {
          const doi = normalizeDoi(m[1]).doi
          if (doi && numOf.has(doi)) expected++
        }
      }
      if (expected === 0) return

      /**
       * 幂等检查：DOM 里已经包好的数量与源码里的标记数一致就什么都不做。
       * 否则「包裹 → 触发 MutationObserver → 又包裹」会无限循环。
       */
      const wrapped = el.querySelectorAll('.af-cite').length
      if (wrapped === expected) return

      // 先拆掉上一轮的包裹（Vditor 局部重渲染后可能只留下几个）
      el.querySelectorAll<HTMLElement>('.af-cite').forEach((w) => {
        const parent = w.parentNode
        if (!parent) return
        parent.replaceChild(document.createTextNode(w.textContent || ''), w)
        parent.normalize()
      })

      // 收集每个文本节点里的标记（公式/代码里的不算）
      const perNode = new Map<Text, { index: number; text: string; doi: string }[]>()
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node) {
        const t = node as Text
        const host = t.parentElement
        if (host && !host.closest('.af-cite, code, pre, .katex, .vditor-ir__marker')) {
          const re = new RegExp(markerRe.source, 'gi')
          let m: RegExpExecArray | null
          const hits: { index: number; text: string; doi: string }[] = []
          while ((m = re.exec(t.data)) !== null) {
            const doi = normalizeDoi(m[1]).doi
            if (doi) hits.push({ index: m.index, text: m[0], doi })
          }
          if (hits.length) perNode.set(t, hits)
        }
        node = walker.nextNode()
      }

      // 从后往前切：前面的下标不会因为节点被拆开而失效
      for (const [textNode, hits] of perNode) {
        let data = textNode.data
        for (let i = hits.length - 1; i >= 0; i--) {
          const hit = hits[i]
          const n = numOf.get(hit.doi)
          if (!n) continue
          const parent = textNode.parentNode
          if (!parent) break

          const wrap = document.createElement('span')
          wrap.className = 'af-cite'
          wrap.setAttribute('data-num', `[${n}]`)
          wrap.setAttribute('title', hit.text)
          const src = document.createElement('span')
          src.className = 'af-cite-src'
          src.textContent = hit.text
          wrap.appendChild(src)

          const tail = document.createTextNode(data.slice(hit.index + hit.text.length))
          parent.insertBefore(tail, textNode.nextSibling)
          parent.insertBefore(wrap, tail)
          data = data.slice(0, hit.index)
        }
        textNode.data = data
      }
    }

    const root = containerRef.current
    if (!root) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(decorate, 90)
    }
    const mo = new MutationObserver(schedule)
    mo.observe(root, { childList: true, subtree: true, characterData: true })
    schedule()
    return () => {
      mo.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [])

  /**
   * 老数据兜底：正文里还留着 base64 内嵌图的，静默搬到仓库换成语义路径。
   * 每篇文档只自动跑一次；上传失败的图原样保留，不会因为迁移丢图。
   */
  useEffect(() => {
    if (!docPath) return
    if (!value.includes('data:image/')) return
    if (migratedDocRef.current === docPath) return
    const timer = setTimeout(() => {
      void (async () => {
        if (migratedDocRef.current === docPath) return
        migratedDocRef.current = docPath
        const { md, migrated } = await migrateBase64Images(value, docPath, imageSubDirRef.current)
        if (migrated > 0 && md !== value) onChangeRef.current?.(md)
      })()
    }, 1200)
    return () => clearTimeout(timer)
  }, [docPath, value])

  /**
   * 表格行列增删：鼠标移到表格上，右上角浮出一个小工具条。
   *
   * markdown 表格在 IR 模式下没有源码视图（只有渲染出来的 <table>），
   * 不给个入口就只能靠手写 md 去加行列 —— 那正是「表格不好用」的来源。
   */
  useEffect(() => {
    const root = containerRef.current
    if (!root) return

    let bar: HTMLDivElement | null = null
    let currentTable: HTMLTableElement | null = null

    const removeBar = () => {
      bar?.remove()
      bar = null
      currentTable = null
    }

    const positionBar = () => {
      if (!bar || !currentTable) return
      const r = currentTable.getBoundingClientRect()
      bar.style.top = `${Math.round(r.top - 30)}px`
      bar.style.left = `${Math.round(r.left)}px`
    }

    const showBar = (table: HTMLTableElement) => {
      if (currentTable === table && bar) return
      removeBar()
      currentTable = table

      const el = document.createElement('div')
      el.className =
        'fixed z-[9998] flex items-center gap-0.5 bg-paper-50 border border-ink-200 rounded-lg shadow-lg px-1 py-0.5'
      const ops: { label: string; tip: string; op: TableOp }[] = [
        { label: '+行', tip: '在表格末尾加一行', op: 'addRow' },
        { label: '+列', tip: '在表格末尾加一列', op: 'addCol' },
        { label: '−行', tip: '删掉最后一行', op: 'delRow' },
        { label: '−列', tip: '删掉最后一列', op: 'delCol' },
      ]
      for (const item of ops) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.textContent = item.label
        btn.title = item.tip
        btn.className =
          'px-1.5 py-0.5 text-[0.6875rem] rounded text-ink-600 hover:bg-seal-50 hover:text-seal-700 transition'
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault()
          e.stopPropagation()
          const tables = Array.from(
            editorElement(vditorRef.current)?.querySelectorAll('table[data-type="table"]') ?? [],
          )
          // DOM 里的表格顺序与 parseTables 解析出来的顺序一致
          const idx = tables.indexOf(table)
          if (idx >= 0) {
            const next = editTable(lastValueRef.current, idx, item.op)
            if (next !== lastValueRef.current) onChangeRef.current?.(next)
          }
          removeBar()
        })
        el.appendChild(btn)
      }
      document.body.appendChild(el)
      bar = el
      positionBar()
    }

    const onOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      const table = target?.closest('table[data-type="table"]') as HTMLTableElement | null
      if (table) showBar(table)
      else if (bar && !bar.contains(e.target as Node)) removeBar()
    }

    root.addEventListener('mouseover', onOver)
    window.addEventListener('scroll', positionBar, true)
    return () => {
      root.removeEventListener('mouseover', onOver)
      window.removeEventListener('scroll', positionBar, true)
      removeBar()
    }
  }, [])

  /**
   * 工具栏按钮在 mousedown 阶段挡掉默认行为。
   *
   * 默认行为会把焦点从编辑器抢走，于是「选中一段文字 → 点加粗」之后这段文字就不再被选中，
   * 想接着点斜体得重新选一遍，取消加粗同理。挡掉之后选区一直留着，
   * 可以连着加粗 / 斜体 / 取消，直到把光标点到别处为止。
   */
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('.vditor-toolbar')) e.preventDefault()
    }
    el.addEventListener('mousedown', onMouseDown, true)
    return () => el.removeEventListener('mousedown', onMouseDown, true)
  }, [])

  // 容器尺寸变化（拖分界线 / 改窗口）→ 同步 Vditor 高度，内容区始终内部滚动
  useEffect(() => {
    if (typeof height === 'number') return
    const el = containerRef.current
    if (!el) return

    const apply = () => {
      const h = Math.round(el.getBoundingClientRect().height)
      if (h < 60) return
      // Vditor 没暴露 setHeight；改它根节点的行内高度即可（内部是 flex 链，会自己重排）
      const root = el.querySelector<HTMLElement>('.vditor')
      if (!root) return
      // 和当前值比较，避免反复设置触发回路
      if (Math.abs(parseFloat(root.style.height || '0') - h) < 2) return
      root.style.height = `${h}px`
    }

    apply() // 挂载时先纠正一次（首帧容器高度可能还没算出来）
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [height])

  /**
   * 持续记录「用户最后停在正文里的那个选区」（见 savedRangeRef 的说明）。
   * 关键点：只在选区落在编辑器内部时才更新 —— 焦点被模态框/侧栏拿走时触发的
   * selectionchange 一律忽略，否则那份宝贵的位置会被一指戳没。
   */
  useEffect(() => {
    const onSelectionChange = () => {
      const el = editorElement(vditorRef.current)
      const sel = window.getSelection()
      if (!el || !sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      if (!el.contains(range.startContainer)) return
      savedRangeRef.current = range.cloneRange()
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  // 外部 value 变化（切换文献 / 重新加载）→ 灌进编辑器；同值不动，避免打断输入
  useEffect(() => {
    if (!vditorRef.current) return
    if (value === lastValueRef.current) return
    lastValueRef.current = value
    vditorRef.current.setValue(value)
  }, [value])

  // 只读态：Vditor 没有官方 disabled，用 CSS 兜住输入（编辑模式开关用）
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.style.pointerEvents = disabled ? 'none' : ''
    el.style.opacity = disabled ? '0.85' : ''
  }, [disabled])

  // zebra 只加一个类名在容器上（样式见 index.css）：块级背景交替由 CSS 的
  // nth-child 完成，DOM 一变颜色自己就跟着重排，不需要再挂 MutationObserver。
  return <div ref={containerRef} className={`${className}${zebra ? ' af-editor-zebra' : ''}`} />
})

export default VditorEditor
