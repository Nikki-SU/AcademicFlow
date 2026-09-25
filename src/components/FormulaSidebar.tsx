/**
 * 公式侧栏（编辑器内部临时侧栏）
 * ------------------------------------------------------------
 * 打开方式：正文工具栏点「插入公式」。两个 tab：
 *   生成公式 —— 识图 / 直接写 → 渲染看板（所见即所得）→ 插入或替换。
 *   已有公式 —— 搜索 + 点选，插到光标处 / 跳到正文 / 改这一处 / 改全部 / 收藏 / 删除（可批量）。
 *
 * 分工（改过一次，现在的才是对的）：
 *   - **看板就是 KaTeX 的渲染结果**，和正文/预览同一个引擎、同一个版本 ——
 *     所见即所得是「真渲染」，不是自己画一套去模仿。以前用 CSS 画分数线、用字符 √ 画根号，
 *     结果必然与预览不一致（见 services/formula-structures.ts 的说明）。
 *   - **输入框是唯一的编辑入口**：直接打字，或点底部工具条的符号/结构按钮往里插。
 *   - 字符与结构做成**底部固定工具条**，永远看得见 —— 不用再滚到下面去找结构。
 *
 * 动作都是显式的：插入 / 替换这一处 / 替换全部 三个按钮并列，不存在「点一下就复制」。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import katex from 'katex'
import {
  Camera,
  Star,
  StarOff,
  Loader2,
  Crosshair,
  Pencil,
  ClipboardPaste,
  Trash2,
  X,
  Search,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  parseFormulas,
  loadFormulaFavorites,
  addFormulaFavorite,
  removeFormulaFavorite,
  type FormulaFavorite,
} from '../services/formula'
import {
  FORMULA_STRUCTURES,
  SQRT_STRUCTURE,
  expandStructure,
  type FormulaStructure,
} from '../services/formula-structures'
import {
  recognizeFormulaImage,
  loadSimpleTexCredentials,
  type SimpleTexModel,
} from '../services/simpletex'

export interface FormulaEditTarget {
  /** 正文里第几个公式（parseFormulas 的顺序） */
  index: number
  tex: string
  kind: 'inline' | 'block'
}

interface FormulaSidebarProps {
  /** 当前正文（扫描「本项目公式」与「查找公式」用） */
  md: string
  /** 插入到光标处 */
  onInsert: (tex: string, kind: 'inline' | 'block') => void
  /**
   * 用新源码替换正文里的公式。
   * global=true → 把「源码等于 matchTex 的其它处」一并替换；false → 只改第 index 个。
   * 由界面上那两个明确的按钮决定，不再是隐式默认。
   */
  onReplaceAt: (
    index: number,
    tex: string,
    kind: 'inline' | 'block',
    global: boolean,
    matchTex: string,
  ) => void
  /** 删除正文里这几个公式（下标来自 parseFormulas） */
  onDelete: (indexes: number[]) => void
  /** 跳转到正文里第 index 个公式（tex 一并带上，编辑器按源码内容定位，不靠序号） */
  onJump: (index: number, tex: string) => void
  onClose: () => void
  /** 从校对清单点「改这条」进来时带的待编辑公式 */
  editTarget?: FormulaEditTarget | null
  /** 已消费掉 editTarget（父组件据此清空） */
  onConsumeEditTarget?: () => void
}

/** 键盘上没有、但写公式常要用的字符（点一下插到光标处） */
const RARE_CHAR_GROUPS: { label: string; chars: string[] }[] = [
  {
    label: '希腊',
    chars: ['α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'ι', 'κ', 'λ', 'μ', 'ν', 'ξ', 'π', 'ρ', 'σ', 'τ', 'υ', 'φ', 'χ', 'ψ', 'ω', 'Γ', 'Δ', 'Θ', 'Λ', 'Ξ', 'Π', 'Σ', 'Φ', 'Ψ', 'Ω'],
  },
  {
    label: '运算',
    chars: ['×', '÷', '±', '∓', '⋅', '∘', '∗', '⊗', '⊕', '≤', '≥', '≠', '≈', '≡', '∼', '∝', '∞', '∂', '∇', '∑', '∏', '∫', '∮', '√', '∠', '⊥', '∥'],
  },
  {
    label: '箭头',
    chars: ['→', '←', '↑', '↓', '↔', '⇒', '⇐', '⇔', '↦', '⟶', '⟵', '↗', '↘'],
  },
  {
    label: '集合/逻辑',
    chars: ['∈', '∉', '⊂', '⊃', '⊆', '⊇', '∪', '∩', '∅', '∀', '∃', '¬', '∧', '∨', 'ℝ', 'ℕ', 'ℤ', 'ℚ', 'ℂ'],
  },
  {
    label: '化学/物理',
    chars: ['⇌', '⟶', '→', 'Å', '°', '′', '″', '∆', 'ħ', 'ℓ', 'ℏ', '℃'],
  },
]

function renderKatex(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex || '\\;', {
      displayMode: display,
      throwOnError: false,
      strict: false,
    })
  } catch (err) {
    return `<span style="color:#dc2626">渲染失败：${err instanceof Error ? err.message : String(err)}</span>`
  }
}

/** data:image/...;base64,... → Blob（有些浏览器的剪贴板只给 HTML，不给文件项） */
function dataUrlToBlob(dataUrl: string): Blob | null {
  const m = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i)
  if (!m) return null
  const bin = atob(m[2])
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: m[1] })
}

/**
 * 从剪贴板里取一张图片。
 *
 * 三条路都要走一遍：截图工具（Win+Shift+S）通常给 `files`；
 * Chrome 里复制网页图片给的是 `items` 里的 file 项；
 * 还有一部分来源（「复制图片」的桌面应用、部分浏览器的复制图片）**只把图塞在 text/html 里**，
 * 这时只能从 `<img src="data:...">` 里挖。挖不到的返回 null —— 调用方据此放行走普通文本粘贴。
 */
function imageFromClipboard(dt: DataTransfer | null): File | Blob | null {
  if (!dt) return null
  for (const f of Array.from(dt.files ?? [])) {
    if (f.type.startsWith('image/')) return f
  }
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile()
      if (f) return f
    }
  }
  const m = dt.getData('text/html')?.match(/<img[^>]+src="(data:image\/[^"]+)"/i)
  return m ? dataUrlToBlob(m[1]) : null
}

/** 公式看板：**就是 KaTeX 的渲染结果**（与正文/预览同一个引擎、同一个版本）—— 不自己画一遍 */
function FormulaBoard({
  tex,
  display,
  onActivate,
}: {
  tex: string
  display: boolean
  /** 点看板 → 把焦点送回输入框（编辑在那边做），光标落在末尾接着写 */
  onActivate: () => void
}) {
  const empty = !tex.trim()
  return (
    <div
      className={`af-formula-board ${display ? 'af-formula-board--display' : ''}`}
      onMouseDown={onActivate}
    >
      {empty ? (
        <span className="text-xs text-ink-400">
          在下面的输入框里写公式：直接打字，或点底部的符号 / 结构
        </span>
      ) : (
        <span dangerouslySetInnerHTML={{ __html: renderKatex(tex, display) }} />
      )}
    </div>
  )
}

export default function FormulaSidebar({
  md,
  onInsert,
  onReplaceAt,
  onDelete,
  onJump,
  onClose,
  editTarget,
  onConsumeEditTarget,
}: FormulaSidebarProps) {
  const [tab, setTab] = useState<'create' | 'find'>('create')
  const [tex, setTex] = useState('')
  const [kind, setKind] = useState<'inline' | 'block'>('inline')
  /** 非 null 时表示「在改正文里第 N 个公式」 */
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  /** 进入编辑时，被改公式的**原始源码** —— 用来数全文有多少处相同（替换全部的范围） */
  const [editOriginalTex, setEditOriginalTex] = useState('')
  /** 本次编辑是否针对「全文相同公式」——只影响横幅上的提示文案 */
  const [replaceAll, setReplaceAll] = useState(false)
  const [favorites, setFavorites] = useState<FormulaFavorite[]>([])
  const [ocrLoading, setOcrLoading] = useState(false)
  /** 拖拽状态（高亮整块投放区） */
  const [dragOver, setDragOver] = useState(false)
  /** 给粘贴监听用的「是否正在识别」—— 用 ref 是为了不让监听因为 loading 变化反复重挂 */
  const ocrLoadingRef = useRef(false)
  /** dragenter/dragleave 的进出台阶（见 handleDragLeave） */
  const dragDepthRef = useRef(0)
  const [ocrModel, setOcrModel] = useState<SimpleTexModel>('standard')
  const [findQuery, setFindQuery] = useState('')
  /** 底部工具条当前分类：默认「结构」—— 找结构是最费scroll的事，让它一进来就在眼前 */
  const [charGroup, setCharGroup] = useState<string>('结构')
  /** 已有公式 tab 里的批量勾选（值是 parseFormulas 的下标） */
  const [picked, setPicked] = useState<Set<number>>(new Set())

  const sourceRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const projectFormulas = useMemo(() => parseFormulas(md), [md])

  /**
   * 正文一变，公式下标就整体错位了（删掉第 1 个，原来第 2 个就变成了第 1 个）。
   * 勾选留着就会指向**另一条**公式 —— 批量删除删错东西比删不掉糟得多，所以直接清空。
   */
  useEffect(() => {
    setPicked(new Set())
  }, [md])

  /** 被改公式在全文里出现了几处（复用它才谈得上「替换全部」） */
  const duplicateCount = useMemo(() => {
    if (!editOriginalTex.trim()) return 0
    return projectFormulas.filter((f) => f.tex.trim() === editOriginalTex.trim()).length
  }, [projectFormulas, editOriginalTex])

  // 收藏列表（跨项目）
  useEffect(() => {
    loadFormulaFavorites()
      .then(setFavorites)
      .catch(() => {
        /* 没登录/私库没就绪时静默；收藏功能不阻塞写公式 */
      })
  }, [])

  // 从校对清单点「改这条」进来
  useEffect(() => {
    if (!editTarget) return
    setTab('create')
    setTex(editTarget.tex)
    setKind(editTarget.kind)
    setEditingIndex(editTarget.index)
    setEditOriginalTex(editTarget.tex)
    // 从校对清单进来：默认「只改这一处」，要全改就按下面那个「替换全部」
    setReplaceAll(false)
    onConsumeEditTarget?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editTarget])

  const isFavorited = (latex: string) =>
    favorites.some((f) => f.latex.trim() === latex.trim())

  /** 识图：文件选择框 / 截图 Ctrl+V / 拖拽 三条路都走这里 */
  const runOcr = async (file: File | Blob) => {
    if (ocrLoadingRef.current) {
      toast.message('上一张还在识别…')
      return
    }
    ocrLoadingRef.current = true
    setOcrLoading(true)
    try {
      const cred = await loadSimpleTexCredentials()
      const result = await recognizeFormulaImage(file, cred, ocrModel)
      setTex(result.latex.trim())
      toast.success('识别完成，看板里就是插入后的效果；不对可在输入框里改')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      ocrLoadingRef.current = false
      setOcrLoading(false)
    }
  }

  /**
   * 截图 → Ctrl+V 直接识别。
   *
   * 监听挂在整个文档上而不是侧栏上：用户截完图，焦点八成还停在正文工具栏那个「插入公式」
   * 按钮上，只挂侧栏的话这一下就白按了。侧栏关掉监听随之注销，所以劫持范围就是
   * **「侧栏打开且停在生成公式 tab 的这段时间」**。
   *
   * 只有剪贴板里**确实是图片**才拦截 —— 往输入框粘 LaTeX 文本、粘别的文字一律照常。
   */
  useEffect(() => {
    if (tab !== 'create') return
    const onPaste = (e: ClipboardEvent) => {
      const img = imageFromClipboard(e.clipboardData)
      if (!img) return
      e.preventDefault()
      void runOcr(img)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
    // 依赖只放 tab 与 ocrModel：runOcr 里除这两个之外全是 ref / setState / 模块函数，
    // 所以这个闭包不会读到过期值（用 ocrLoading 当依赖反而会让监听反复重挂）。
  }, [tab, ocrModel])

  /** 拖拽上传：只在侧栏这块区域接手（正文编辑器自己的图片拖放不抢） */
  const dragHasImage = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.items ?? []).some((i) => i.type.startsWith('image/'))

  const handleDragEnter = (e: React.DragEvent) => {
    if (!dragHasImage(e)) return
    e.preventDefault()
    dragDepthRef.current++
    setDragOver(true)
  }

  const handleDragLeave = () => {
    // dragleave 在「从根进入子元素」时也会冒上来，不计数的话高亮会闪
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragOver(false)
  }

  const handleDragOver = (e: React.DragEvent) => {
    // 必须 preventDefault，否则浏览器不认为这里可投放，drop 根本不会触发
    if (dragHasImage(e)) e.preventDefault()
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragOver(false)
    const img = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'))
    if (!img) {
      toast.error('拖进来的是图片才能识别公式')
      return
    }
    void runOcr(img)
  }

  const handleFavoriteToggle = async (latex: string, display: 'inline' | 'block') => {
    const existing = favorites.find((f) => f.latex.trim() === latex.trim())
    try {
      if (existing) {
        await removeFormulaFavorite(existing.id)
        setFavorites((prev) => prev.filter((f) => f.id !== existing.id))
        toast.success('已取消收藏')
      } else {
        const ok = await addFormulaFavorite(latex, display)
        setFavorites(await loadFormulaFavorites(true))
        toast[ok ? 'success' : 'info'](ok ? '已收藏（跨项目可用）' : '这条公式已经在收藏里了')
      }
    } catch (err) {
      toast.error(`收藏失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 开始改已有公式：one = 只改这一处，all = 全文相同公式一起改 */
  const beginEdit = (index: number, originTex: string, oneOrAll: 'one' | 'all', fKind: 'inline' | 'block') => {
    setTab('create')
    setTex(originTex)
    setKind(fKind)
    setEditingIndex(index)
    setEditOriginalTex(originTex)
    setReplaceAll(oneOrAll === 'all')
  }

  const resetToCreate = () => {
    setEditingIndex(null)
    setEditOriginalTex('')
    setTex('')
    setReplaceAll(false)
  }

  const handleInsert = () => {
    if (!tex.trim()) {
      toast.error('公式还没内容')
      return
    }
    onInsert(tex, kind)
  }

  const handleReplace = (global: boolean) => {
    if (editingIndex === null) return
    if (!tex.trim()) {
      toast.error('公式还没内容')
      return
    }
    onReplaceAt(editingIndex, tex, kind, global, editOriginalTex)
    toast.success(
      global
        ? `已把全文 ${Math.max(duplicateCount, 1)} 处相同公式一起改掉`
        : `已更新正文里第 ${editingIndex + 1} 个公式`,
    )
    resetToCreate()
  }

  /**
   * 输入框当前的插入区间。
   * 输入框有焦点 → 用它的光标/选区；没焦点过（用户直接点的工具条按钮）→ 追加到末尾。
   * 「没焦点就追加」这条很关键：否则第一次点符号会插到开头去。
   */
  const sourceRange = (): [number, number] => {
    const ta = sourceRef.current
    if (!ta || document.activeElement !== ta) return [tex.length, tex.length]
    const from = ta.selectionStart ?? tex.length
    return [from, ta.selectionEnd ?? from]
  }

  /**
   * 往输入框里插内容。`select` 是插完之后要选中的**相对**区间 ——
   * 结构会把占位符选中，用户直接打字就把它替换掉（Word 行为）。
   */
  const insertIntoSource = (text: string, select?: [number, number]) => {
    const [from, to] = sourceRange()
    setTex(tex.slice(0, from) + text + tex.slice(to))
    const [selFrom, selTo] = select ?? [text.length, text.length]
    requestAnimationFrame(() => {
      const ta = sourceRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(from + selFrom, from + selTo)
    })
  }

  /** 点工具条里的符号：插到输入框的光标处（选中了东西就替换掉） */
  const insertSymbol = (glyph: string) => {
    // 「运算」组里的 √ 不是普通字符 —— 裸字符 √ 在 KaTeX 里只是根号的一个符号，
    // 没有上划线、也不管被开方的内容，永远长不成真根号。让它走结构。
    if (glyph === '√') {
      insertStructure(SQRT_STRUCTURE)
      return
    }
    insertIntoSource(glyph)
  }

  /** 点工具条里的结构：把选中的源码包进结构（没选中就插一个带占位符的空结构） */
  const insertStructure = (s: FormulaStructure) => {
    const [from, to] = sourceRange()
    const { tex: built, selStart, selEnd } = expandStructure(s.build(tex.slice(from, to)))
    insertIntoSource(built, [selStart, selEnd])
  }

  /** 点看板 → 回输入框接着写（编辑只有这一个入口） */
  const focusSource = () => {
    const ta = sourceRef.current
    if (!ta) return
    ta.focus()
    // 光标放末尾，不是全选：全选之后一打字就把整条公式替换掉了
    const at = ta.value.length
    ta.setSelectionRange(at, at)
  }

  const filteredFind = projectFormulas
    .map((f, index) => ({ ...f, index }))
    .filter((f) => !findQuery.trim() || f.tex.toLowerCase().includes(findQuery.trim().toLowerCase()))

  /** 当前可见（筛选后）的公式下标 —— 全选的语义就是「全选我看得见这些」 */
  const visibleIndexes = useMemo(() => filteredFind.map((f) => f.index), [filteredFind])
  const allVisiblePicked =
    visibleIndexes.length > 0 && visibleIndexes.every((i) => picked.has(i))

  /** 全选 / 全不选（只作用于当前筛选结果；没筛选就是全文） */
  const toggleSelectAllVisible = () => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (allVisiblePicked) visibleIndexes.forEach((i) => next.delete(i))
      else visibleIndexes.forEach((i) => next.add(i))
      return next
    })
  }

  const togglePicked = (index: number) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  /** 真正执行删除（确认之后走这里） */
  const doDeletePicked = (list: number[]) => {
    onDelete(list)
    setPicked(new Set())
    toast.success(`已删除 ${list.length} 个公式`)
  }

  /**
   * 批量删除。条数多的时候先确认一次 —— 正文里删公式没有撤销，
   * 而「全选」让一次删几十个变得很容易，误点的代价太高。少的时候别啰嗦。
   */
  const deletePicked = () => {
    const list = [...picked]
    if (list.length === 0) return
    if (list.length >= 5) {
      toast.warning(`确定删掉这 ${list.length} 个公式？`, {
        description: '会从正文里直接移除，删完不易恢复',
        action: { label: '确认删除', onClick: () => doDeletePicked(list) },
      })
      return
    }
    doDeletePicked(list)
  }

  const charGroupButtons = useMemo(() => {
    if (charGroup === '结构') return null
    return RARE_CHAR_GROUPS.find((g) => g.label === charGroup)?.chars ?? []
  }, [charGroup])

  return (
    <div
      className={`w-80 flex-shrink-0 border-l flex flex-col overflow-hidden relative transition-colors ${
        dragOver ? 'border-seal-400 bg-seal-50/70' : 'border-ink-200 bg-paper-100/70'
      }`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* 拖拽时的投放提示：pointer-events-none，别把 drop 事件挡掉 */}
      {dragOver && (
        <div className="absolute inset-0 z-20 pointer-events-none flex items-center justify-center m-1 rounded-lg border-2 border-dashed border-seal-400 bg-seal-50/85">
          <span className="text-xs font-medium text-seal-700">松手，把这张图识别成公式</span>
        </div>
      )}
      {/* 头部 */}
      <div className="px-3 py-2 border-b border-ink-200 flex items-center justify-between bg-paper-50">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTab('create')}
            className={`px-2.5 py-1 text-xs rounded-lg transition ${
              tab === 'create' ? 'bg-seal-100 text-seal-700 font-medium' : 'text-ink-500 hover:bg-ink-100'
            }`}
          >
            生成公式
          </button>
          <button
            onClick={() => setTab('find')}
            className={`px-2.5 py-1 text-xs rounded-lg transition ${
              tab === 'find' ? 'bg-seal-100 text-seal-700 font-medium' : 'text-ink-500 hover:bg-ink-100'
            }`}
          >
            已有公式
          </button>
        </div>
        <button
          onClick={onClose}
          className="p-1 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded transition"
          title="关闭公式栏"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {tab === 'create' ? (
        <>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {editingIndex !== null && (
              <div className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-amber-50 border border-amber-200 text-[0.6875rem] text-amber-700">
                <Pencil className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="min-w-0">
                  正在改正文第 {editingIndex + 1} 个公式
                  {replaceAll && duplicateCount > 1 ? `（全文共 ${duplicateCount} 处相同）` : ''}
                </span>
                <button onClick={resetToCreate} className="ml-auto text-amber-600 hover:underline flex-shrink-0">
                  改为新建
                </button>
              </div>
            )}

            {/* 识图：按钮 / 截图直接 Ctrl+V / 拖进来，三条路都进 runOcr */}
            <div>
              <div className="flex items-center gap-1.5">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void runOcr(f)
                    e.target.value = ''
                  }}
                />
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={ocrLoading}
                  className="flex-1 min-w-0 px-2 py-2 text-xs border border-dashed border-ink-300 rounded-lg text-ink-500 hover:border-seal-300 hover:text-seal-600 transition flex items-center justify-center gap-1.5 disabled:opacity-60"
                  title="选图片文件识别成公式（也可以直接截图后 Ctrl+V，或把图片拖进来）"
                >
                  {ocrLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
                  {ocrLoading ? '识别中…' : '识图'}
                </button>
                <select
                  value={ocrModel}
                  onChange={(e) => setOcrModel(e.target.value as SimpleTexModel)}
                  className="text-[0.6875rem] border border-ink-200 rounded px-1 py-1.5 bg-paper-50 text-ink-500"
                  title="识别精度 / 速度"
                >
                  <option value="standard">标准</option>
                  <option value="turbo">轻量</option>
                </select>
              </div>
              {/* 把「截图 → Ctrl+V」写在脸上：藏起来的快捷键等于没有 */}
              <p className="mt-1 text-[0.6875rem] text-ink-400">
                截图后直接 <kbd className="px-1 rounded border border-ink-200 bg-paper-50 text-ink-500">Ctrl</kbd>
                +<kbd className="px-1 rounded border border-ink-200 bg-paper-50 text-ink-500">V</kbd>{' '}
                贴进来就能识别，也可以把图片拖到这块栏里
              </p>
            </div>

            {/* 输入框 —— 唯一的编辑入口。看板只是它的渲染结果，别把编辑藏进「高级」里 */}
            <section>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xs font-medium text-ink-600">输入框</span>
                <span className="text-[0.6875rem] text-ink-400 truncate">直接打字，或点底部的符号 / 结构</span>
                <div className="ml-auto flex rounded-lg border border-ink-200 overflow-hidden flex-shrink-0">
                  {(['inline', 'block'] as const).map((k) => (
                    <button
                      key={k}
                      onClick={() => setKind(k)}
                      className={`px-2.5 py-0.5 text-[0.6875rem] transition ${
                        kind === k ? 'bg-seal-600 text-paper-50' : 'bg-paper-50 text-ink-600 hover:bg-paper-100'
                      }`}
                    >
                      {k === 'inline' ? '行内' : '行间'}
                    </button>
                  ))}
                </div>
              </div>
              <textarea
                ref={sourceRef}
                value={tex}
                onChange={(e) => setTex(e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder="\frac{\partial u}{\partial t} = \alpha \nabla^2 u"
                className="w-full px-2 py-1.5 text-xs font-mono border border-ink-200 rounded-lg focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 resize-y"
              />
            </section>

            {/* 看板 = 真 KaTeX 渲染：与正文同一个引擎、同一个版本，所以「输入什么、看到什么」天生一致 */}
            <section>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xs font-medium text-ink-600">公式</span>
                <span className="text-[0.6875rem] text-ink-400 truncate">与插入正文后完全一致</span>
              </div>
              <div className="af-formula-boardwrap rounded-lg border border-ink-200 bg-paper-50 px-2 py-3 cursor-text">
                <FormulaBoard tex={tex} display={kind === 'block'} onActivate={focusSource} />
              </div>
            </section>

            {/* 显式动作：插入 / 替换这一处 / 替换全部 */}
            <div className="space-y-1.5">
              {editingIndex === null ? (
                <button
                  onClick={handleInsert}
                  className="w-full px-3 py-2 bg-seal-600 text-paper-50 rounded-lg text-sm font-medium hover:bg-seal-700 transition flex items-center justify-center gap-1.5"
                >
                  <ClipboardPaste className="w-4 h-4" />
                  插入到正文光标处
                </button>
              ) : (
                <div className="flex gap-1.5">
                  <button
                    onClick={() => handleReplace(false)}
                    className="flex-1 px-2 py-2 bg-seal-600 text-paper-50 rounded-lg text-xs font-medium hover:bg-seal-700 transition flex items-center justify-center gap-1"
                    title="只替换正文里这一处"
                  >
                    <span className="relative inline-flex">
                      <Pencil className="w-3.5 h-3.5" />
                      <span className="absolute -bottom-1 -right-1 text-[0.5rem] font-bold leading-none">1</span>
                    </span>
                    替换这一处
                  </button>
                  <button
                    onClick={() => handleReplace(true)}
                    disabled={duplicateCount <= 1}
                    className="flex-1 px-2 py-2 bg-paper-50 border border-seal-300 text-seal-700 rounded-lg text-xs font-medium hover:bg-seal-50 transition flex items-center justify-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                    title={duplicateCount > 1 ? `全文 ${duplicateCount} 处相同公式一起改` : '全文只有这一处'}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    替换全部{duplicateCount > 1 ? `（${duplicateCount}）` : ''}
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        /* ── 已有公式：搜索 + 点选；动作都是显式按钮 ── */
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="p-2.5 border-b border-ink-200 bg-paper-50">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-400" />
              <input
                value={findQuery}
                onChange={(e) => setFindQuery(e.target.value)}
                placeholder="按公式源码筛选…"
                className="w-full pl-8 pr-2 py-1.5 text-xs border border-ink-200 rounded-lg focus:outline-none focus:border-seal-400"
              />
            </div>
            <div className="mt-1.5 flex items-center gap-2 text-[0.6875rem] text-ink-400">
              <label className="flex items-center gap-1 cursor-pointer select-none text-ink-500 hover:text-ink-700">
                <input
                  type="checkbox"
                  checked={allVisiblePicked}
                  disabled={visibleIndexes.length === 0}
                  onChange={toggleSelectAllVisible}
                  className="w-3.5 h-3.5 rounded border-ink-300 accent-seal-600 focus:ring-seal-500 disabled:opacity-40"
                  title="全选当前列表（筛选后就是筛选结果），然后可以一次删掉"
                />
                全选{findQuery.trim() ? '筛选结果' : ''}（{visibleIndexes.length}）
              </label>
              <span className="ml-auto">
                全文 {projectFormulas.length} 个公式
                {picked.size > 0 ? ` · 已选 ${picked.size}` : ''}
              </span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
            {favorites.length > 0 && (
              <>
                <div className="text-[0.625rem] text-amber-600 flex items-center gap-1">
                  <Star className="w-3 h-3" />
                  我的收藏（跨项目 · {favorites.length}）
                </div>
                {favorites.map((f) => (
                  <FormulaRow
                    key={f.id}
                    tex={f.latex}
                    kind={f.display}
                    badge="收藏"
                    onInsert={() => onInsert(f.latex, f.display)}
                    starred
                    onToggleStar={() => handleFavoriteToggle(f.latex, f.display)}
                  />
                ))}
                <div className="text-[0.625rem] text-ink-500 pt-1.5">
                  正文里的公式（{projectFormulas.length}）
                </div>
              </>
            )}
            {filteredFind.length === 0 ? (
              <p className="text-center text-xs text-ink-400 py-8">
                {projectFormulas.length === 0 ? '正文里还没有公式' : '没有匹配的公式'}
              </p>
            ) : (
              filteredFind.map((f) => (
                <FormulaRow
                  key={`${f.start}-${f.index}`}
                  tex={f.tex}
                  kind={f.kind}
                  badge={`#${f.index + 1} · ${f.kind === 'block' ? '行间' : '行内'}`}
                  checked={picked.has(f.index)}
                  onToggleCheck={() => togglePicked(f.index)}
                  onInsert={() => onInsert(f.tex, f.kind)}
                  onJump={() => onJump(f.index, f.tex)}
                  onEditOne={() => beginEdit(f.index, f.tex, 'one', f.kind)}
                  onEditAll={() => beginEdit(f.index, f.tex, 'all', f.kind)}
                  onDelete={() => onDelete([f.index])}
                  starred={isFavorited(f.tex)}
                  onToggleStar={() => handleFavoriteToggle(f.tex, f.kind)}
                />
              ))
            )}
          </div>

          {picked.size > 0 && (
            <div className="px-2.5 py-2 border-t border-ink-200 bg-amber-50 flex items-center gap-2">
              <span className="text-[0.6875rem] text-amber-700">已选 {picked.size} 个</span>
              <button
                onClick={() => setPicked(new Set())}
                className="ml-auto px-2 py-1 text-[0.6875rem] text-ink-500 hover:text-ink-700"
              >
                取消选择
              </button>
              <button
                onClick={deletePicked}
                className="px-2 py-1 text-[0.6875rem] rounded bg-rose-600 text-paper-50 hover:bg-rose-700 flex items-center gap-1"
              >
                <Trash2 className="w-3 h-3" />
                删除选中
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── 底部固定工具条：字符 / 结构永远在眼前，不用滚 ── */}
      <div className="border-t border-ink-200 bg-paper-50 flex-shrink-0">
        <div className="max-h-28 overflow-y-auto px-2 pt-2">
          {charGroup === '结构' ? (
            <div className="flex flex-wrap gap-1">
              {FORMULA_STRUCTURES.map((s) => (
                <button
                  key={s.label}
                  onClick={() => insertStructure(s)}
                  className="px-1.5 py-1 text-[0.6875rem] rounded border border-ink-200 hover:bg-seal-50 hover:text-seal-700 hover:border-seal-300 text-ink-600 transition"
                >
                  {s.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-0.5">
              {(charGroupButtons ?? []).map((c) => (
                <button
                  key={c}
                  onClick={() => insertSymbol(c)}
                  className="w-6 h-6 text-sm rounded hover:bg-seal-50 hover:text-seal-700 text-ink-600 transition"
                >
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 px-2 py-1.5 border-t border-ink-100">
          {['结构', ...RARE_CHAR_GROUPS.map((g) => g.label)].map((label) => (
            <button
              key={label}
              onClick={() => setCharGroup(label)}
              className={`flex-1 min-w-0 px-1 py-1 text-[0.625rem] rounded transition truncate ${
                charGroup === label
                  ? 'bg-seal-100 text-seal-700 font-medium'
                  : 'text-ink-500 hover:bg-ink-100'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * 已有公式里的一行。
 *
 * 注意：**点预览不再直接插入**（那太容易误触发）。要插入得按上面那个
 * 「粘贴」按钮 —— 动作一律显式。
 */
function FormulaRow({
  tex,
  kind,
  badge,
  checked,
  onToggleCheck,
  onInsert,
  onJump,
  onEditOne,
  onEditAll,
  onDelete,
  starred,
  onToggleStar,
}: {
  tex: string
  kind: 'inline' | 'block'
  badge: string
  checked?: boolean
  onToggleCheck?: () => void
  onInsert: () => void
  onJump?: () => void
  onEditOne?: () => void
  onEditAll?: () => void
  onDelete?: () => void
  starred: boolean
  onToggleStar: () => void
}) {
  const iconBtn = 'p-1 rounded transition hover:bg-seal-50 text-ink-400 hover:text-seal-600'
  return (
    <div className={`rounded-lg border p-2 transition ${checked ? 'border-seal-400 bg-seal-50/50' : 'border-ink-200 bg-paper-50'}`}>
      <div className="flex items-center gap-1 mb-1">
        {onToggleCheck && (
          <input
            type="checkbox"
            checked={!!checked}
            onChange={onToggleCheck}
            className="rounded accent-seal-600 flex-shrink-0"
            title="勾选后可批量删除"
          />
        )}
        <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-ink-100 text-ink-500 truncate">
          {badge}
        </span>
        <div className="ml-auto flex items-center gap-0.5 flex-shrink-0">
          <button onClick={onInsert} className={iconBtn} title="插入到正文光标处">
            <ClipboardPaste className="w-3.5 h-3.5" />
          </button>
          {onJump && (
            <button onClick={onJump} className={iconBtn} title="跳到正文这一处">
              <Crosshair className="w-3.5 h-3.5" />
            </button>
          )}
          {onEditOne && (
            <button onClick={onEditOne} className={iconBtn} title="只替换正文里这一处">
              <span className="relative inline-flex">
                <Pencil className="w-3.5 h-3.5" />
                <span className="absolute -bottom-1 -right-1 text-[0.5rem] font-bold leading-none">1</span>
              </span>
            </button>
          )}
          {onEditAll && (
            <button onClick={onEditAll} className={iconBtn} title="全文相同公式一起替换">
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
          {onDelete && (
            <button onClick={onDelete} className={iconBtn} title="从正文里删掉这个公式">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={onToggleStar}
            className={`p-1 rounded transition hover:bg-amber-50 ${starred ? 'text-amber-500' : 'text-ink-400'}`}
            title={starred ? '取消收藏' : '收藏（跨项目可用）'}
          >
            {starred ? <Star className="w-3.5 h-3.5 fill-amber-400" /> : <StarOff className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
      <div
        className="overflow-x-auto py-1 text-center"
        dangerouslySetInnerHTML={{ __html: renderKatex(tex, kind === 'block') }}
      />
      <div className="font-mono text-[0.625rem] text-ink-400 truncate" title={tex}>
        {tex}
      </div>
    </div>
  )
}
