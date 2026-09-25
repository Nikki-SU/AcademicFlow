/**
 * 公式侧栏（编辑器内部临时侧栏）
 * ------------------------------------------------------------
 * 打开方式：正文工具栏点「插入公式」。
 * 两个 tab：
 *   生成公式 —— 识图 → 字符/结构 → 行内/行间 → 渲染看板 → 源码 → 确认。
 *               只管写新公式，内容短到不需要滚动（小侧栏最忌上下翻）。
 *   已有公式 —— 搜索 + 滑动点选，**点一下就直接复用**（插到光标处），
 *               收藏（跨项目）置顶。
 *
 * 复用规则（按需求）：
 *   - 「本项目」= 当前正文里已经写过的公式（实时扫描 md，不额外存）
 *   - 「我的收藏」= 跨项目可用的公式，存私库 formulas/favorites.csv
 *     （点星标收藏；收藏是显式动作，不会自动把正文公式塞进收藏）
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import katex from 'katex'
import {
  Camera,
  Star,
  StarOff,
  Loader2,
  CornerDownLeft,
  Crosshair,
  Pencil,
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
   * 用新源码替换正文里第 index 个公式。
   * global=true 时把「源码等于 matchTex 的其它处」一并替换（校对里的全局变换）；
   * 那是「复用公式」的默认行为，用户可以在侧栏里就地关掉只改一处。
   */
  onReplaceAt: (
    index: number,
    tex: string,
    kind: 'inline' | 'block',
    global: boolean,
    matchTex: string,
  ) => void
  /** 跳转到正文里第 index 个公式（tex 一并带上，编辑器按源码内容定位，不靠序号） */
  onJump: (index: number, tex: string) => void
  onClose: () => void
  /** 从校对清单点「改这条」进来时带的待编辑公式 */
  editTarget?: FormulaEditTarget | null
  /** 已消费掉 editTarget（父组件据此清空） */
  onConsumeEditTarget?: () => void
}

/** 键盘上没有、但写公式常要用的字符（点一下追加到源码末尾） */
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

/** 常用 LaTeX 结构（点一下包住当前内容 / 追加） */
const LATEX_SNIPPETS: { label: string; tex: string }[] = [
  { label: '分数', tex: '\\frac{a}{b}' },
  { label: '上下标', tex: 'x^{a}_{b}' },
  { label: '根号', tex: '\\sqrt{x}' },
  { label: '求和', tex: '\\sum_{i=1}^{n}' },
  { label: '积分', tex: '\\int_{a}^{b}' },
  { label: '极限', tex: '\\lim_{x \\to 0}' },
  { label: '矩阵', tex: '\\begin{matrix} a & b \\\\ c & d \\end{matrix}' },
  { label: '正体', tex: '\\mathrm{d}' },
  { label: '斜体希腊', tex: '\\alpha' },
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

export default function FormulaSidebar({
  md,
  onInsert,
  onReplaceAt,
  onJump,
  onClose,
  editTarget,
  onConsumeEditTarget,
}: FormulaSidebarProps) {
  const [tab, setTab] = useState<'create' | 'find'>('create')
  const [tex, setTex] = useState('')
  const [kind, setKind] = useState<'inline' | 'block'>('inline')
  /** 非 null 时，确认按钮 = 替换正文里第 N 个公式（而不是插入新公式） */
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  /** 进入编辑时，被改公式的**原始源码** —— 用来数全文有多少处相同（全局变换的默认范围） */
  const [editOriginalTex, setEditOriginalTex] = useState('')
  /**
   * 全局变换。默认 true：复用公式在正文里出现 N 处时，改一次全改。
   * 用户可以在侧栏里就地关掉 → 只改当前这一处。
   */
  const [globalReplace, setGlobalReplace] = useState(true)
  const [favorites, setFavorites] = useState<FormulaFavorite[]>([])
  const [ocrLoading, setOcrLoading] = useState(false)
  const [ocrModel, setOcrModel] = useState<SimpleTexModel>('standard')
  const [findQuery, setFindQuery] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const projectFormulas = useMemo(() => parseFormulas(md), [md])

  /** 被改公式在全文里出现了几处（复用它才谈得上"全局变换"） */
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
    setGlobalReplace(true)
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
      toast.success('识别完成，请在「渲染看板」核对后再确认')
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

  const handleConfirm = () => {
    if (!tex.trim()) {
      toast.error('公式还没内容')
      return
    }
    if (editingIndex !== null) {
      const doGlobal = globalReplace && duplicateCount > 1
      onReplaceAt(editingIndex, tex, kind, doGlobal, editOriginalTex)
      toast.success(
        doGlobal
          ? `已把全文 ${duplicateCount} 处相同公式一起改掉`
          : `已更新正文里第 ${editingIndex + 1} 个公式`,
      )
      setEditingIndex(null)
      setEditOriginalTex('')
    } else {
      onInsert(tex, kind)
    }
  }

  const append = (snippet: string) => {
    setTex((prev) => (prev ? `${prev}${snippet}` : snippet))
  }

  const filteredFind = projectFormulas
    .map((f, index) => ({ ...f, index }))
    .filter((f) => !findQuery.trim() || f.tex.toLowerCase().includes(findQuery.trim().toLowerCase()))

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
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {editingIndex !== null && (
            <div className="px-2.5 py-2 rounded-lg bg-amber-50 border border-amber-200 text-[0.6875rem] text-amber-700 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Pencil className="w-3.5 h-3.5 flex-shrink-0" />
                正在改正文第 {editingIndex + 1} 个公式
                <button
                  onClick={() => {
                    setEditingIndex(null)
                    setEditOriginalTex('')
                    setTex('')
                  }}
                  className="ml-auto text-amber-600 hover:underline"
                >
                  改为新建
                </button>
              </div>
              {duplicateCount > 1 ? (
                <label className="flex items-center gap-1.5 cursor-pointer text-amber-800">
                  <input
                    type="checkbox"
                    checked={globalReplace}
                    onChange={(e) => setGlobalReplace(e.target.checked)}
                    className="accent-seal-600"
                  />
                  全局变换：全文 {duplicateCount} 处相同公式一起改（取消勾选 = 只改这一处）
                </label>
              ) : (
                <div className="text-amber-600/80">全文只有这一处，只替换它。</div>
              )}
            </div>
          )}

          {/* 1. 识图输入 */}
          <section className="bg-paper-50 rounded-lg border border-ink-200 p-2.5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-ink-600 flex items-center gap-1">
                <Camera className="w-3.5 h-3.5 text-seal-500" />
                识图输入公式
              </span>
              <select
                value={ocrModel}
                onChange={(e) => setOcrModel(e.target.value as SimpleTexModel)}
                className="text-[0.6875rem] border border-ink-200 rounded px-1 py-0.5 bg-paper-50 text-ink-500"
              >
                <option value="standard">标准（准）</option>
                <option value="turbo">轻量（快）</option>
              </select>
            </div>
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
              className="w-full px-2 py-2 text-xs border border-dashed border-ink-300 rounded-lg text-ink-500 hover:border-seal-300 hover:text-seal-600 transition flex items-center justify-center gap-1.5 disabled:opacity-60"
            >
              {ocrLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
              {ocrLoading ? '识别中…（走后端，稍等十几秒）' : '上传/截图插入（SimpleTex）'}
            </button>
            <p className="mt-1.5 text-[0.625rem] text-ink-400 leading-snug">
              需先在「设置 → 公式识图」填 SimpleTex 令牌；图片经私库转 GitHub Actions 调用 SimpleTex
              （浏览器直连被对方 CORS 拦），识别结果务必在下面渲染看板里核对一遍。
            </p>
          </section>

          {/* 2. 稀有字符 */}
          <section className="bg-paper-50 rounded-lg border border-ink-200 p-2.5">
            <div className="text-xs font-medium text-ink-600 mb-2">字符 / 结构（键盘上没有的）</div>
            <div className="space-y-1.5 max-h-44 overflow-y-auto">
              {RARE_CHAR_GROUPS.map((g) => (
                <div key={g.label}>
                  <div className="text-[0.625rem] text-ink-400 mb-0.5">{g.label}</div>
                  <div className="flex flex-wrap gap-0.5">
                    {g.chars.map((c) => (
                      <button
                        key={c}
                        onClick={() => append(c)}
                        className="w-6 h-6 text-sm rounded hover:bg-seal-50 hover:text-seal-700 text-ink-600 transition"
                        title={c}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <div>
                <div className="text-[0.625rem] text-ink-400 mb-0.5 mt-1">结构</div>
                <div className="flex flex-wrap gap-1">
                  {LATEX_SNIPPETS.map((s) => (
                    <button
                      key={s.label}
                      onClick={() => append(s.tex)}
                      className="px-1.5 py-0.5 text-[0.6875rem] rounded border border-ink-200 hover:bg-seal-50 hover:text-seal-700 text-ink-600 transition"
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* 4. 行内 / 行间 */}
          <section className="flex items-center gap-2 bg-paper-50 rounded-lg border border-ink-200 p-2">
            <span className="text-xs text-ink-600">位置</span>
            <div className="flex rounded-lg border border-ink-200 overflow-hidden">
              {(['inline', 'block'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className={`px-3 py-1 text-xs transition ${
                    kind === k ? 'bg-seal-600 text-paper-50' : 'bg-paper-50 text-ink-600 hover:bg-paper-100'
                  }`}
                >
                  {k === 'inline' ? '行内 $…$' : '行间 $$…$$'}
                </button>
              ))}
            </div>
          </section>

          {/* 5. 渲染看板 */}
          <section className="bg-paper-50 rounded-lg border border-ink-200 p-2.5">
            <div className="text-xs font-medium text-ink-600 mb-2">渲染看板</div>
            <div
              className="min-h-14 px-2 py-3 rounded bg-paper-100 overflow-x-auto text-center"
              dangerouslySetInnerHTML={{ __html: renderKatex(tex, kind === 'block') }}
            />
          </section>

          {/* 6. LaTeX 源码 */}
          <section className="bg-paper-50 rounded-lg border border-ink-200 p-2.5">
            <div className="text-xs font-medium text-ink-600 mb-1.5">LaTeX 源码</div>
            <textarea
              value={tex}
              onChange={(e) => setTex(e.target.value)}
              rows={4}
              spellCheck={false}
              placeholder="例如：\frac{\partial u}{\partial t} = \alpha \nabla^2 u"
              className="w-full px-2 py-1.5 text-xs font-mono border border-ink-200 rounded-lg focus:outline-none focus:border-seal-400 resize-y"
            />
          </section>

          {/* 7. 确认 */}
          <button
            onClick={handleConfirm}
            className="w-full px-3 py-2 bg-seal-600 text-paper-50 rounded-lg text-sm font-medium hover:bg-seal-700 transition flex items-center justify-center gap-1.5"
          >
            <CornerDownLeft className="w-4 h-4" />
            {editingIndex !== null ? '确认替换这一处' : '确认插入到光标处'}
          </button>
        </div>
      ) : (
        /* ── 已有公式：搜索 + 滑动点选，点一下就复用 ── */
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
            <div className="mt-1.5 text-[0.6875rem] text-ink-400">
              点任意一条直接插入到光标处 · 全文 {projectFormulas.length} 个公式
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
                    onReuse={() => onInsert(f.latex, f.display)}
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
                  onReuse={() => onInsert(f.tex, f.kind)}
                  onJump={() => onJump(f.index, f.tex)}
                  onEdit={() => {
                    setTab('create')
                    setTex(f.tex)
                    setKind(f.kind)
                    setEditingIndex(f.index)
                    setEditOriginalTex(f.tex)
                    setGlobalReplace(true)
                  }}
                  starred={isFavorited(f.tex)}
                  onToggleStar={() => handleFavoriteToggle(f.tex, f.kind)}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 已有公式里的一行：**点预览即复用**（插到光标处）。
 * 右侧是次要动作：跳转 / 改这一条 / 收藏。
 */
function FormulaRow({
  tex,
  kind,
  badge,
  onReuse,
  onJump,
  onEdit,
  starred,
  onToggleStar,
}: {
  tex: string
  kind: 'inline' | 'block'
  badge: string
  onReuse: () => void
  onJump?: () => void
  onEdit?: () => void
  starred: boolean
  onToggleStar: () => void
}) {
  return (
    <div className="bg-paper-50 rounded-lg border border-ink-200 p-2">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-ink-100 text-ink-500">
          {badge}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {onJump && (
            <button
              onClick={onJump}
              className="p-1 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded transition"
              title="跳到正文这一处"
            >
              <Crosshair className="w-3.5 h-3.5" />
            </button>
          )}
          {onEdit && (
            <button
              onClick={onEdit}
              className="p-1 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded transition"
              title="改这一条（只替换这一处）"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={onToggleStar}
            className="p-1 rounded transition hover:bg-amber-50"
            title={starred ? '取消收藏' : '收藏（跨项目可用）'}
          >
            {starred ? (
              <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-400" />
            ) : (
              <StarOff className="w-3.5 h-3.5 text-ink-400" />
            )}
          </button>
        </div>
      </div>
      <button
        onClick={onReuse}
        className="w-full overflow-x-auto py-1 text-center rounded hover:bg-seal-50/60 transition"
        title="点击复用：插入到正文光标处"
        dangerouslySetInnerHTML={{ __html: renderKatex(tex, kind === 'block') }}
      />
      <div className="font-mono text-[0.625rem] text-ink-400 truncate" title={tex}>
        {tex}
      </div>
    </div>
  )
}
