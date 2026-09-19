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
  /** 聚焦编辑器 */
  focus: () => void
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
  /** 高度：数字=px，字符串原样传给 Vditor */
  height?: number | string
  placeholder?: string
  /** ir（默认，即时渲染）/ wysiwyg（隐藏语法，最接近飞书）/ sv（分屏） */
  mode?: VditorMode
  /** 传给 Vditor 的工具栏；不传用内置精简工具栏（含"插入公式"） */
  toolbar?: VditorToolbarItem[]
  /** 只读（用于预览态） */
  disabled?: boolean
  className?: string
}

/** 运行时资源目录：public/vditor/dist/...（构建后位于 BASE_URL 下） */
const VDITOR_CDN = `${import.meta.env.BASE_URL}vditor`

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
  { value, onChange, onBlur, onReady, height = 420, placeholder = '开始写作…', mode = 'ir', toolbar, disabled = false, className = '' },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const vditorRef = useRef<Vditor | null>(null)
  /** 最近一次"双方达成一致"的值：用来判断外部 value 变化是不是我们自己 emit 出去的 */
  const lastValueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const onBlurRef = useRef(onBlur)
  const onReadyRef = useRef(onReady)

  onChangeRef.current = onChange
  onBlurRef.current = onBlur
  onReadyRef.current = onReady

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
      focus: () => vditorRef.current?.focus(),
    }),
    [],
  )

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const formulaItem: VditorToolbarItem = {
      name: 'insert-formula',
      tip: '插入公式（行内 / 行间）',
      icon: FORMULA_ICON,
      click: (event: Event) => {
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
      mode,
      height,
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
