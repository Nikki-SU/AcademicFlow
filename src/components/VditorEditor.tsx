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

/** 短暂描边高亮，帮用户在一屏里立刻看到「跳过来的这一条」是哪个 */
function flashElement(node: HTMLElement) {
  const prevOutline = node.style.outline
  const prevOffset = node.style.outlineOffset
  node.style.outline = '2px solid #6366f1'
  node.style.outlineOffset = '3px'
  node.style.borderRadius = '2px'
  window.setTimeout(() => {
    node.style.outline = prevOutline
    node.style.outlineOffset = prevOffset
  }, 1500)
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
 * 空壳阶段：点一下弹「行内 / 行间」两个选项，插入公式模板。
 * TODO(下一阶段)：接真正的公式编辑面板（所见即所得编辑 + 预览 + 常用符号面板），
 *                  见任务清单 i15。
 */
const FORMULA_ICON =
  '<svg viewBox="0 0 32 32" width="14" height="14"><path fill="currentColor" d="M6 4h20v3H9.6l6.1 9-6.1 9H26v3H6l7.4-10.9L6 4z"/><path fill="currentColor" d="M19 13h9v2h-9zm3-3h2v8h-2z"/></svg>'

/** 公式模板（空壳）：行内 $…$ / 行间 $$…$$ */
const FORMULA_TEMPLATE = {
  inline: ' $公式$ ',
  block: '\n$$\n公式\n$$\n',
} as const

/** 在工具栏按钮下方弹出「行内 / 行间」小菜单（点击外部即关闭，不用 window.prompt） */
function openFormulaMenu(anchor: HTMLElement, onPick: (kind: 'inline' | 'block') => void) {
  document.getElementById('af-formula-menu')?.remove()

  const menu = document.createElement('div')
  menu.id = 'af-formula-menu'
  menu.className =
    'fixed z-[9999] bg-white border border-slate-200 rounded-lg shadow-xl py-1 text-sm min-w-[140px]'
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
    btn.className = 'w-full flex items-center justify-between gap-3 px-3 py-1.5 hover:bg-indigo-50 text-slate-700'
    btn.innerHTML = `<span>${it.label}</span><span class="text-xs text-slate-400 font-mono">${it.hint}</span>`
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

const VditorEditor = forwardRef<VditorEditorHandle, VditorEditorProps>(function VditorEditor(
  { value, onChange, onBlur, onReady, height = 420, placeholder = '开始写作…', mode = 'ir', toolbar, onFormulaClick, disabled = false, className = '' },
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
  const onChangeRef = useRef(onChange)
  const onBlurRef = useRef(onBlur)
  const onReadyRef = useRef(onReady)
  const onFormulaClickRef = useRef(onFormulaClick)

  onChangeRef.current = onChange
  onBlurRef.current = onBlur
  onReadyRef.current = onReady
  onFormulaClickRef.current = onFormulaClick

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
      insertAtCursor: (md: string) => {
        const inst = vditorRef.current
        if (!inst) return
        const el = editorElement(inst)
        const range = savedRangeRef.current

        // 先聚焦回编辑器（焦点此时多半在侧栏/模态框上），再把我们记的 Range 还回去；
        // Vditor 的 insertValue 内部走 getEditorRange()，此时拿到的就是这份位置。
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
      },
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

    const defaultToolbar: VditorToolbarItem[] = [
      'headings', 'bold', 'italic', 'strike', 'link', '|',
      'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
      'quote', 'line', 'code', 'inline-code', '|',
      'table', 'upload',
      formulaItem,
      '|',
      'undo', 'redo', '|',
      'edit-mode', 'fullscreen',
    ]

    // 外部传了 toolbar 就在其末尾补上「插入公式」，保证全站都有这个按钮
    const finalToolbar = toolbar ? [...toolbar, formulaItem] : defaultToolbar

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
      preview: {
        math: { engine: 'KaTeX', inlineDigit: true },
        // 不引 highlight.js / mark.js：这两样要额外从 CDN 拉，代码块不高亮不影响阅读
        hljs: { enable: false, lineNumber: false },
        markdown: { toc: false, mark: false, footnotes: true },
        theme: { current: 'light', path: `${VDITOR_CDN}/dist/css/content-theme` },
      },
      toolbar: finalToolbar,
      toolbarConfig: { pin: true },
      upload: {
        // 图片一律转 base64 内嵌进 md（沿用项目既定策略：图片跟着 md 走，无外部依赖）
        // handler 返回 null = 不走 Vditor 的 URL 回填流程，插入动作由我们自己 insertValue 完成
        handler: (files: File[]): null => {
          for (const file of files) {
            if (!file.type.startsWith('image/')) continue
            const reader = new FileReader()
            reader.onload = () => {
              const dataUrl = String(reader.result || '')
              if (dataUrl) vditorRef.current?.insertValue(`![${file.name}](${dataUrl})`)
            }
            reader.readAsDataURL(file)
          }
          return null
        },
      },
      input: (md: string) => {
        lastValueRef.current = md
        onChangeRef.current?.(md)
      },
      blur: () => {
        onBlurRef.current?.(vditorRef.current?.getValue() ?? lastValueRef.current)
      },
      after: () => {
        onReadyRef.current?.()
      },
    })

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

  return <div ref={containerRef} className={className} />
})

export default VditorEditor
