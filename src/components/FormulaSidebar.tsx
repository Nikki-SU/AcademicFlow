/**
 * 公式侧栏（编辑器内部临时侧栏）
 * ------------------------------------------------------------
 * 打开方式：正文工具栏点「插入公式」。两个 tab：
 *   生成公式 —— 识图 / 直接写 → 渲染看板（所见即所得，可直接编辑）→ 插入或替换。
 *   已有公式 —— 搜索 + 点选，插到光标处 / 跳到正文 / 改这一处 / 改全部 / 收藏 / 删除（可批量）。
 *
 * 这一版把「只能写 LaTeX」改成「所见即所得」：
 *   - 渲染看板本身就是编辑区：点进分数格、根号里，直接打字（见 services/formula-visual.ts）；
 *   - 字符与结构做成**底部固定工具条**，永远看得见 —— 不用再滚到下面去找结构；
 *   - LaTeX 源码收进「高级」，不熟 LaTeX 的人可以完全不看它。
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
  ChevronDown,
  ChevronRight,
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
  insertStructureAtCaret,
  insertTextAtCaret,
  readLatex,
  renderInto,
} from '../services/formula-visual'
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

/** 渲染看板：内容由 formula-visual 的视觉树生成，这里只负责把 LaTeX 灌进去 */
function VisualBoard({
  tex,
  display,
  boardRef,
  onTex,
}: {
  tex: string
  display: boolean
  boardRef: React.RefObject<HTMLDivElement>
  /** 看板里改了内容 → 把新的 LaTeX 交出去 */
  onTex: (tex: string) => void
}) {
  // 外部 tex 变化（识图结果 / 从校对清单进来 / 源码框改完）→ 重画看板。
  // 看板自己的输入不会回流到这里（那边记下新值就不再重画），所以光标不会被重置。
  const lastPushed = useRef<string | null>(null)
  useEffect(() => {
    const el = boardRef.current
    if (!el) return
    if (lastPushed.current === tex) return
    lastPushed.current = tex
    renderInto(el, tex)
  }, [tex, boardRef])

  return (
    <div
      ref={boardRef}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onInput={() => {
        const el = boardRef.current
        if (!el) return
        const next = readLatex(el)
        lastPushed.current = next
        onTex(next)
      }}
      // 回车在公式里没有意义，只会插进 <br> 把结构撑坏
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.preventDefault()
      }}
      className={`af-formula-board ${display ? 'af-formula-board--display' : ''}`}
    />
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
  const [ocrModel, setOcrModel] = useState<SimpleTexModel>('standard')
  const [findQuery, setFindQuery] = useState('')
  const [showSource, setShowSource] = useState(false)
  /** 底部工具条当前分类：默认「结构」—— 找结构是最费scroll的事，让它一进来就在眼前 */
  const [charGroup, setCharGroup] = useState<string>('结构')
  /** 已有公式 tab 里的批量勾选（值是 parseFormulas 的下标） */
  const [picked, setPicked] = useState<Set<number>>(new Set())

  const boardRef = useRef<HTMLDivElement>(null)
  const sourceRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const projectFormulas = useMemo(() => parseFormulas(md), [md])

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

  const handleOcr = async (file: File | Blob) => {
    setOcrLoading(true)
    try {
      const cred = await loadSimpleTexCredentials()
      const result = await recognizeFormulaImage(file, cred, ocrModel)
      setTex(result.latex.trim())
      toast.success('识别完成，请核对看板里的公式')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setOcrLoading(false)
    }
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

  /** 点工具条：源码框有焦点就往源码里插，否则插到看板的光标处 */
  const insertSymbol = (glyph: string) => {
    if (document.activeElement === sourceRef.current && sourceRef.current) {
      const ta = sourceRef.current
      const at = ta.selectionStart ?? tex.length
      setTex(tex.slice(0, at) + glyph + tex.slice(at))
      requestAnimationFrame(() => {
        ta.focus()
        ta.setSelectionRange(at + glyph.length, at + glyph.length)
      })
      return
    }
    const board = boardRef.current
    if (!board) return
    // 不先 focus：焦点一动光标会回到开头，要按「当前选区」插（见 formula-visual 的说明）
    insertTextAtCaret(board, glyph)
    setTex(readLatex(board))
  }

  const insertStructure = (s: (typeof FORMULA_STRUCTURES)[number]) => {
    const board = boardRef.current
    if (!board) return
    insertStructureAtCaret(board, s.make, s.caret)
    setTex(readLatex(board))
  }

  const filteredFind = projectFormulas
    .map((f, index) => ({ ...f, index }))
    .filter((f) => !findQuery.trim() || f.tex.toLowerCase().includes(findQuery.trim().toLowerCase()))

  const togglePicked = (index: number) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const deletePicked = () => {
    const list = [...picked]
    if (list.length === 0) return
    onDelete(list)
    setPicked(new Set())
    toast.success(`已删除 ${list.length} 个公式`)
  }

  const charGroupButtons = useMemo(() => {
    if (charGroup === '结构') return null
    return RARE_CHAR_GROUPS.find((g) => g.label === charGroup)?.chars ?? []
  }, [charGroup])

  return (
    <div className="w-80 flex-shrink-0 border-l border-ink-200 bg-paper-100/70 flex flex-col overflow-hidden">
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

            {/* 识图：一个按钮，模型选择跟在旁边 */}
            <div className="flex items-center gap-1.5">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) handleOcr(f)
                  e.target.value = ''
                }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={ocrLoading}
                className="flex-1 min-w-0 px-2 py-2 text-xs border border-dashed border-ink-300 rounded-lg text-ink-500 hover:border-seal-300 hover:text-seal-600 transition flex items-center justify-center gap-1.5 disabled:opacity-60"
                title="上传图片或截图，自动识别成公式"
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

            {/* 看板 = 编辑区 */}
            <section>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xs font-medium text-ink-600">公式</span>
                <div className="ml-auto flex rounded-lg border border-ink-200 overflow-hidden">
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
              <div
                className="af-formula-boardwrap rounded-lg border border-ink-200 bg-paper-50 focus-within:border-seal-400 px-2 py-3 cursor-text"
                onMouseDown={(e) => {
                  // 点空白处把光标送进看板，省得用户去点「很小的一条」
                  if (e.target === e.currentTarget) {
                    const b = boardRef.current
                    if (b) {
                      b.focus()
                      const sel = window.getSelection()
                      if (sel) {
                        const r = document.createRange()
                        r.selectNodeContents(b)
                        r.collapse(false)
                        sel.removeAllRanges()
                        sel.addRange(r)
                      }
                    }
                  }
                }}
              >
                <VisualBoard
                  tex={tex}
                  display={kind === 'block'}
                  boardRef={boardRef}
                  onTex={setTex}
                />
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

              <button
                onClick={() => setShowSource((v) => !v)}
                className="w-full flex items-center gap-1 px-1 py-0.5 text-[0.6875rem] text-ink-400 hover:text-ink-600 transition"
              >
                {showSource ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                LaTeX 源码（会写 LaTeX 才需要）
              </button>
              {showSource && (
                <textarea
                  ref={sourceRef}
                  value={tex}
                  onChange={(e) => setTex(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  placeholder="\frac{\partial u}{\partial t} = \alpha \nabla^2 u"
                  className="w-full px-2 py-1.5 text-xs font-mono border border-ink-200 rounded-lg focus:outline-none focus:border-seal-400 resize-y"
                />
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
            <div className="mt-1.5 text-[0.6875rem] text-ink-400">全文 {projectFormulas.length} 个公式</div>
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
                取消
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
