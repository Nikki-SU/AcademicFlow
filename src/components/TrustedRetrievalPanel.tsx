import { useState, useMemo, useRef, useEffect } from 'react'
import {
  Bot,
  ShieldCheck,
  Search,
  BookOpen,
  BookMarked,
  Library,
  ChevronDown,
  Check,
  X,
  Sparkles,
  FileText,
  BookText,
  ListTree,
  ToggleLeft,
  ToggleRight,
  ChevronRight,
  Filter,
} from 'lucide-react'

type CitationScope = 'all' | 'project' | 'literature' | 'books' | 'chapters'

interface LiteratureItem {
  id: string
  title: string
  authors: string
  year: number
  journal: string
  doi: string
}

interface BookItem {
  id: string
  title: string
  authors: string
  year: number
  publisher: string
  isbn: string
  chapters: ChapterItem[]
}

interface ChapterItem {
  id: string
  bookId: string
  title: string
  number: string
  pageRange: string
}

interface AIModelOption {
  value: string
  label: string
  desc: string
  category: 'generation' | 'review'
}

const AI_MODELS: AIModelOption[] = [
  {
    value: 'qwen-3-6-27b',
    label: 'Qwen3.6-27B',
    desc: '通义千问 · 擅长学术写作生成',
    category: 'generation',
  },
  {
    value: 'deepseek-v3-2',
    label: 'DeepSeek-V3.2',
    desc: '深度求索 · 擅长事实核查与推理',
    category: 'review',
  },
  {
    value: 'glm-4-9b',
    label: 'GLM-4-9B',
    desc: '智谱AI · 均衡型通用模型',
    category: 'generation',
  },
  {
    value: 'kimi-k2',
    label: 'Kimi-K2',
    desc: '月之暗面 · 长上下文审阅',
    category: 'review',
  },
  {
    value: 'minimax-01',
    label: 'MiniMax-01',
    desc: '稀宇科技 · 创意写作生成',
    category: 'generation',
  },
  {
    value: 'llama-3-70b',
    label: 'Llama-3.1-70B',
    desc: 'Meta · 开源旗舰审阅模型',
    category: 'review',
  },
]

const DEMO_LITERATURE: LiteratureItem[] = [
  {
    id: 'lit-1',
    title: '钙钛矿太阳能电池的最新进展与挑战',
    authors: 'Zhang Y, Wang L, Chen H',
    year: 2024,
    journal: 'Sample Journal',
    doi: '10.1000/sample.00000001',
  },
  {
    id: 'lit-2',
    title: 'Pd/IPr^BIDEA 催化 gem-二氟环丙烷区域选择性氢化脱氟合成末端氟代烯烃',
    authors: 'Qian H, Cheng ZP, Luo Y, Lv L, Chen S, Li Z',
    year: 2024,
    journal: 'Sample Journal',
    doi: '10.1000/sample.00000002',
  },
  {
    id: 'lit-3',
    title: 'Metal-organic framework derived nanomaterials for electrocatalytic CO2 reduction',
    authors: 'Liu X, Zhao Y, Sun M',
    year: 2023,
    journal: 'Sample Journal',
    doi: '10.1000/sample.00000003',
  },
  {
    id: 'lit-4',
    title: '二维过渡金属硫化物的光电性质研究进展',
    authors: 'Wang F, Li J, Zhang Q',
    year: 2023,
    journal: 'Sample Journal',
    doi: '10.1000/sample.00000004',
  },
  {
    id: 'lit-5',
    title: '石墨烯基复合材料在储能器件中的应用',
    authors: 'Chen M, Liu Y, Zhou S',
    year: 2022,
    journal: 'Sample Journal',
    doi: '10.1000/sample.00000005',
  },
  {
    id: 'lit-6',
    title: '单原子催化剂的设计合成与电催化应用',
    authors: 'Yang H, Wu T, Guo R',
    year: 2024,
    journal: 'Sample Journal',
    doi: '10.1000/sample.00000006',
  },
  {
    id: 'lit-7',
    title: '柔性可穿戴电子器件的材料与结构设计',
    authors: 'Zhao K, Huang L, Tan J',
    year: 2023,
    journal: 'Sample Journal',
    doi: '10.1000/sample.00000007',
  },
  {
    id: 'lit-8',
    title: '量子点发光二极管的效率提升策略',
    authors: 'Sun W, Dong X, Mei H',
    year: 2022,
    journal: 'Sample Journal',
    doi: '10.1000/sample.00000008',
  },
]

const DEMO_BOOKS: BookItem[] = [
  {
    id: 'book-1',
    title: '材料科学基础',
    authors: '胡赓祥, 蔡珣, 戎咏华',
    year: 2021,
    publisher: '上海交通大学出版社',
    isbn: '978-7-313-24345-6',
    chapters: [
      { id: 'ch-1-1', bookId: 'book-1', title: '晶体结构', number: '第1章', pageRange: 'P1-P45' },
      { id: 'ch-1-2', bookId: 'book-1', title: '晶体缺陷', number: '第2章', pageRange: 'P46-P89' },
      { id: 'ch-1-3', bookId: 'book-1', title: '固体中的扩散', number: '第3章', pageRange: 'P90-P134' },
      { id: 'ch-1-4', bookId: 'book-1', title: '合金相图', number: '第4章', pageRange: 'P135-P198' },
      { id: 'ch-1-5', bookId: 'book-1', title: '材料的形变与再结晶', number: '第5章', pageRange: 'P199-P256' },
      { id: 'ch-1-6', bookId: 'book-1', title: '金属热处理原理', number: '第6章', pageRange: 'P257-P312' },
    ],
  },
  {
    id: 'book-2',
    title: '物理化学（上册）',
    authors: '傅献彩, 沈文霞, 姚天扬, 侯文华',
    year: 2022,
    publisher: '高等教育出版社',
    isbn: '978-7-04-056345-3',
    chapters: [
      { id: 'ch-2-1', bookId: 'book-2', title: '气体', number: '第1章', pageRange: 'P1-P38' },
      { id: 'ch-2-2', bookId: 'book-2', title: '热力学第一定律', number: '第2章', pageRange: 'P39-P98' },
      { id: 'ch-2-3', bookId: 'book-2', title: '热力学第二定律', number: '第3章', pageRange: 'P99-P168' },
      { id: 'ch-2-4', bookId: 'book-2', title: '多组分系统热力学', number: '第4章', pageRange: 'P169-P225' },
      { id: 'ch-2-5', bookId: 'book-2', title: '相平衡', number: '第5章', pageRange: 'P226-P278' },
      { id: 'ch-2-6', bookId: 'book-2', title: '化学平衡', number: '第6章', pageRange: 'P279-P320' },
    ],
  },
  {
    id: 'book-3',
    title: '有机化学',
    authors: '邢其毅, 裴伟伟, 徐瑞秋, 裴坚',
    year: 2020,
    publisher: '北京大学出版社',
    isbn: '978-7-301-31234-5',
    chapters: [
      { id: 'ch-3-1', bookId: 'book-3', title: '绪论', number: '第1章', pageRange: 'P1-P28' },
      { id: 'ch-3-2', bookId: 'book-3', title: '烷烃和环烷烃', number: '第2章', pageRange: 'P29-P76' },
      { id: 'ch-3-3', bookId: 'book-3', title: '烯烃', number: '第3章', pageRange: 'P77-P124' },
      { id: 'ch-3-4', bookId: 'book-3', title: '炔烃', number: '第4章', pageRange: 'P125-P158' },
      { id: 'ch-3-5', bookId: 'book-3', title: '芳香烃', number: '第5章', pageRange: 'P159-P210' },
      { id: 'ch-3-6', bookId: 'book-3', title: '立体化学', number: '第6章', pageRange: 'P211-P256' },
      { id: 'ch-3-7', bookId: 'book-3', title: '卤代烃', number: '第7章', pageRange: 'P257-P302' },
      { id: 'ch-3-8', bookId: 'book-3', title: '醇、酚、醚', number: '第8章', pageRange: 'P303-P356' },
    ],
  },
  {
    id: 'book-4',
    title: '量子化学原理',
    authors: 'Levine I.N.',
    year: 2019,
    publisher: '人民邮电出版社',
    isbn: '978-7-115-51234-8',
    chapters: [
      { id: 'ch-4-1', bookId: 'book-4', title: '量子力学基础', number: '第1章', pageRange: 'P1-P52' },
      { id: 'ch-4-2', bookId: 'book-4', title: '原子结构', number: '第2章', pageRange: 'P53-P110' },
      { id: 'ch-4-3', bookId: 'book-4', title: '分子结构与化学键', number: '第3章', pageRange: 'P111-P178' },
      { id: 'ch-4-4', bookId: 'book-4', title: '分子光谱', number: '第4章', pageRange: 'P179-P234' },
    ],
  },
]

const SCOPE_OPTIONS = [
  { value: 'all', label: '全部文献', icon: Library },
  { value: 'project', label: '当前项目文献', icon: FileText },
  { value: 'literature', label: '指定文献', icon: BookMarked },
  { value: 'books', label: '指定图书', icon: BookOpen },
  { value: 'chapters', label: '指定章节', icon: BookText },
] as const

interface ModelSelectorProps {
  label: string
  role: 'ai1' | 'ai2'
  value: string
  onChange: (value: string) => void
  icon: React.ReactNode
  accentColor: 'indigo' | 'emerald'
}

function ModelSelector({ label, role, value, onChange, icon, accentColor }: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const filteredModels = AI_MODELS.filter(
    (m) => m.category === (role === 'ai1' ? 'generation' : 'review')
  )
  const currentModel = filteredModels.find((m) => m.value === value) || filteredModels[0]

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const accentClasses = accentColor === 'indigo'
    ? { bg: 'bg-indigo-100', text: 'text-indigo-600', hover: 'hover:border-indigo-300', badge: 'bg-indigo-600' }
    : { bg: 'bg-emerald-100', text: 'text-emerald-600', hover: 'hover:border-emerald-300', badge: 'bg-emerald-600' }

  return (
    <div className="relative" ref={dropdownRef}>
      <div className="text-xs font-medium text-slate-600 mb-1.5 flex items-center gap-1.5">
        <span className={`w-5 h-5 rounded ${accentClasses.bg} flex items-center justify-center text-[0.625rem] font-bold ${accentClasses.text}`}>
          {role === 'ai1' ? '1' : '2'}
        </span>
        {label}
      </div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-left transition flex items-center justify-between ${accentClasses.hover}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-6 h-6 ${accentClasses.bg} rounded-md flex items-center justify-center flex-shrink-0`}>
            {icon}
          </div>
          <div className="min-w-0">
            <div className="text-xs font-medium text-slate-700 truncate">{currentModel?.label}</div>
            <div className="text-[0.625rem] text-slate-400 truncate">{currentModel?.desc}</div>
          </div>
        </div>
        <ChevronDown className={`w-4 h-4 text-slate-400 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-30 overflow-hidden">
          {filteredModels.map((model) => (
            <button
              key={model.value}
              type="button"
              onClick={() => {
                onChange(model.value)
                setOpen(false)
              }}
              className={`w-full px-3 py-2 text-left hover:bg-slate-50 transition flex items-center gap-2 ${
                value === model.value ? 'bg-indigo-50/50' : ''
              }`}
            >
              <div className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 ${
                value === model.value ? accentClasses.badge : 'bg-slate-100'
              }`}>
                <Bot className={`w-3.5 h-3.5 ${value === model.value ? 'text-white' : 'text-slate-500'}`} />
              </div>
              <div className="min-w-0 flex-1">
                <div className={`text-xs font-medium truncate ${
                  value === model.value ? 'text-indigo-700' : 'text-slate-700'
                }`}>
                  {model.label}
                </div>
                <div className="text-[0.625rem] text-slate-400 truncate">{model.desc}</div>
              </div>
              {value === model.value && <Check className="w-4 h-4 text-indigo-600 flex-shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface SearchableMultiSelectProps {
  title: string
  items: LiteratureItem[] | BookItem[]
  selectedIds: string[]
  onToggle: (id: string) => void
  onSelectAll: () => void
  onClear: () => void
  searchPlaceholder: string
  emptyText: string
  type: 'literature' | 'books'
}

function SearchableMultiSelect({
  title,
  items,
  selectedIds,
  onToggle,
  onSelectAll,
  onClear,
  searchPlaceholder,
  emptyText,
  type,
}: SearchableMultiSelectProps) {
  const [search, setSearch] = useState('')

  const filteredItems = useMemo(() => {
    if (!search.trim()) return items
    const q = search.toLowerCase()
    return items.filter((item) => {
      if (type === 'literature') {
        const lit = item as LiteratureItem
        return (
          lit.title.toLowerCase().includes(q) ||
          lit.authors.toLowerCase().includes(q) ||
          lit.journal.toLowerCase().includes(q) ||
          lit.doi.toLowerCase().includes(q)
        )
      } else {
        const book = item as BookItem
        return (
          book.title.toLowerCase().includes(q) ||
          book.authors.toLowerCase().includes(q) ||
          book.publisher.toLowerCase().includes(q) ||
          book.isbn.toLowerCase().includes(q)
        )
      }
    })
  }, [items, search, type])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
          {type === 'literature' ? <BookMarked className="w-3.5 h-3.5 text-indigo-600" /> : <BookOpen className="w-3.5 h-3.5 text-indigo-600" />}
          {title}
          <span className="text-slate-400 font-normal">
            ({selectedIds.length} / {items.length} 已选)
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onSelectAll}
            className="text-[0.625rem] text-indigo-600 hover:text-indigo-800 font-medium"
          >
            全选
          </button>
          <span className="text-slate-300">|</span>
          <button
            type="button"
            onClick={onClear}
            className="text-[0.625rem] text-slate-500 hover:text-slate-700 font-medium"
          >
            清空
          </button>
        </div>
      </div>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={searchPlaceholder}
          className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
      </div>
      <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
        {filteredItems.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-400">{emptyText}</div>
        ) : (
          filteredItems.map((item) => {
            const isSelected = selectedIds.includes(item.id)
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onToggle(item.id)}
                className={`w-full px-3 py-2 text-left transition flex items-start gap-2.5 ${
                  isSelected ? 'bg-indigo-50/60' : 'hover:bg-slate-50'
                }`}
              >
                <div className={`w-4 h-4 mt-0.5 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                  isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'
                }`}>
                  {isSelected && <Check className="w-3 h-3 text-white" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className={`text-xs font-medium line-clamp-2 leading-snug ${
                    isSelected ? 'text-indigo-800' : 'text-slate-700'
                  }`}>
                    {type === 'literature' ? (item as LiteratureItem).title : (item as BookItem).title}
                  </div>
                  <div className="text-[0.625rem] text-slate-500 mt-0.5 truncate">
                    {type === 'literature'
                      ? `${(item as LiteratureItem).authors} (${(item as LiteratureItem).year})`
                      : `${(item as BookItem).authors} · ${(item as BookItem).publisher}`}
                  </div>
                  <div className="text-[0.625rem] text-slate-400 truncate">
                    {type === 'literature' ? (item as LiteratureItem).journal : (item as BookItem).isbn}
                  </div>
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

interface ChapterSelectorProps {
  books: BookItem[]
  selectedBookIds: string[]
  selectedChapterIds: string[]
  onToggleChapter: (chapterId: string) => void
  onSelectAllChapters: (bookId: string) => void
  onClearChapters: (bookId: string) => void
}

function ChapterSelector({
  books,
  selectedBookIds,
  selectedChapterIds,
  onToggleChapter,
  onSelectAllChapters,
  onClearChapters,
}: ChapterSelectorProps) {
  const selectedBooks = books.filter((b) => selectedBookIds.includes(b.id))

  if (selectedBooks.length === 0) {
    return (
      <div className="py-6 text-center text-xs text-slate-400 bg-slate-50 rounded-lg border border-dashed border-slate-200">
        <ListTree className="w-6 h-6 mx-auto mb-1.5 text-slate-300" />
        请先从"指定图书"中选择至少一本图书
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
        <ListTree className="w-3.5 h-3.5 text-indigo-600" />
        章节选择
        <span className="text-slate-400 font-normal">
          ({selectedChapterIds.length} 章已选)
        </span>
      </div>
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {selectedBooks.map((book) => {
          const bookChapters = book.chapters

          return (
            <div key={book.id} className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                <div className="text-xs font-medium text-slate-700 truncate flex-1">
                  {book.title}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                  <button
                    type="button"
                    onClick={() => onSelectAllChapters(book.id)}
                    className="text-[0.625rem] text-indigo-600 hover:text-indigo-800 font-medium"
                  >
                    全选
                  </button>
                  <span className="text-slate-300">|</span>
                  <button
                    type="button"
                    onClick={() => onClearChapters(book.id)}
                    className="text-[0.625rem] text-slate-500 hover:text-slate-700 font-medium"
                  >
                    清空
                  </button>
                </div>
              </div>
              <div className="divide-y divide-slate-100">
                {bookChapters.map((chapter) => {
                  const isSelected = selectedChapterIds.includes(chapter.id)
                  return (
                    <button
                      key={chapter.id}
                      type="button"
                      onClick={() => onToggleChapter(chapter.id)}
                      className={`w-full px-3 py-1.5 text-left transition flex items-center gap-2 ${
                        isSelected ? 'bg-indigo-50/60' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                        isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'
                      }`}>
                        {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                      </div>
                      <span className={`text-[0.6875rem] flex-1 truncate ${
                        isSelected ? 'text-indigo-800 font-medium' : 'text-slate-600'
                      }`}>
                        {chapter.number} {chapter.title}
                      </span>
                      <span className="text-[0.625rem] text-slate-400 flex-shrink-0">{chapter.pageRange}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface CitationScopeModalProps {
  open: boolean
  onClose: () => void
  scope: CitationScope
  onScopeChange: (scope: CitationScope) => void
  selectedLiteratureIds: string[]
  onToggleLiterature: (id: string) => void
  onSelectAllLiterature: () => void
  onClearLiterature: () => void
  selectedBookIds: string[]
  onToggleBook: (id: string) => void
  onSelectAllBooks: () => void
  onClearBooks: () => void
  selectedChapterIds: string[]
  onToggleChapter: (id: string) => void
  onSelectAllChapters: (bookId: string) => void
  onClearChapters: (bookId: string) => void
  onConfirm: () => void
}

function CitationScopeModal({
  open,
  onClose,
  scope,
  onScopeChange,
  selectedLiteratureIds,
  onToggleLiterature,
  onSelectAllLiterature,
  onClearLiterature,
  selectedBookIds,
  onToggleBook,
  onSelectAllBooks,
  onClearBooks,
  selectedChapterIds,
  onToggleChapter,
  onSelectAllChapters,
  onClearChapters,
  onConfirm,
}: CitationScopeModalProps) {
  if (!open) return null

  const getSelectedCount = () => {
    if (scope === 'all') return '全部'
    if (scope === 'project') return '项目内'
    if (scope === 'literature') return `${selectedLiteratureIds.length} 篇`
    if (scope === 'books') return `${selectedBookIds.length} 本`
    if (scope === 'chapters') return `${selectedChapterIds.length} 章`
    return '0'
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between flex-shrink-0">
          <div>
            <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
              <Filter className="w-4 h-4 text-indigo-600" />
              引用范围设置
            </h3>
            <p className="text-[0.6875rem] text-slate-500 mt-0.5">
              选择 AI 可信检索时可参考的文献来源范围
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-slate-600">范围类型</div>
            <div className="grid grid-cols-1 gap-1.5">
              {SCOPE_OPTIONS.map((option) => {
                const Icon = option.icon
                const isSelected = scope === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => onScopeChange(option.value as CitationScope)}
                    className={`w-full px-3 py-2.5 rounded-lg text-left transition flex items-center gap-2.5 border ${
                      isSelected
                        ? 'bg-indigo-50 border-indigo-400 text-indigo-800'
                        : 'bg-white border-slate-200 hover:border-slate-300 text-slate-700'
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 ${
                      isSelected ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'
                    }`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{option.label}</div>
                    </div>
                    {isSelected && <Check className="w-4 h-4 text-indigo-600 flex-shrink-0" />}
                  </button>
                )
              })}
            </div>
          </div>

          {scope === 'literature' && (
            <SearchableMultiSelect
              title="选择文献"
              items={DEMO_LITERATURE}
              selectedIds={selectedLiteratureIds}
              onToggle={onToggleLiterature}
              onSelectAll={onSelectAllLiterature}
              onClear={onClearLiterature}
              searchPlaceholder="搜索文献标题、作者、期刊..."
              emptyText="未找到匹配的文献"
              type="literature"
            />
          )}

          {(scope === 'books' || scope === 'chapters') && (
            <SearchableMultiSelect
              title="选择图书"
              items={DEMO_BOOKS}
              selectedIds={selectedBookIds}
              onToggle={onToggleBook}
              onSelectAll={onSelectAllBooks}
              onClear={onClearBooks}
              searchPlaceholder="搜索图书标题、作者、出版社..."
              emptyText="未找到匹配的图书"
              type="books"
            />
          )}

          {scope === 'chapters' && (
            <ChapterSelector
              books={DEMO_BOOKS}
              selectedBookIds={selectedBookIds}
              selectedChapterIds={selectedChapterIds}
              onToggleChapter={onToggleChapter}
              onSelectAllChapters={onSelectAllChapters}
              onClearChapters={onClearChapters}
            />
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between flex-shrink-0">
          <div className="text-xs text-slate-500">
            已选范围：<span className="font-semibold text-indigo-600">{getSelectedCount()}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition"
            >
              取消
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 transition shadow-sm"
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

interface TrustedRetrievalPanelProps {
  ai1Model?: string
  ai2Model?: string
  onAi1ModelChange?: (model: string) => void
  onAi2ModelChange?: (model: string) => void
  trustedSearch?: boolean
  onTrustedSearchChange?: (enabled: boolean) => void
  citationScope?: CitationScope
  onCitationScopeChange?: (scope: CitationScope) => void
  selectedLiteratureIds?: string[]
  onSelectedLiteratureChange?: (ids: string[]) => void
  selectedBookIds?: string[]
  onSelectedBooksChange?: (ids: string[]) => void
  selectedChapterIds?: string[]
  onSelectedChaptersChange?: (ids: string[]) => void
}

export default function TrustedRetrievalPanel({
  ai1Model = 'qwen-3-6-27b',
  ai2Model = 'deepseek-v3-2',
  onAi1ModelChange,
  onAi2ModelChange,
  trustedSearch = true,
  onTrustedSearchChange,
  citationScope = 'all',
  onCitationScopeChange,
  selectedLiteratureIds = [],
  onSelectedLiteratureChange,
  selectedBookIds = [],
  onSelectedBooksChange,
  selectedChapterIds = [],
  onSelectedChaptersChange,
}: TrustedRetrievalPanelProps) {
  const [showScopeModal, setShowScopeModal] = useState(false)
  const [tempScope, setTempScope] = useState<CitationScope>(citationScope)
  const [tempLiteratureIds, setTempLiteratureIds] = useState<string[]>(selectedLiteratureIds)
  const [tempBookIds, setTempBookIds] = useState<string[]>(selectedBookIds)
  const [tempChapterIds, setTempChapterIds] = useState<string[]>(selectedChapterIds)

  useEffect(() => {
    setTempScope(citationScope)
  }, [citationScope])

  useEffect(() => {
    setTempLiteratureIds(selectedLiteratureIds)
  }, [selectedLiteratureIds])

  useEffect(() => {
    setTempBookIds(selectedBookIds)
  }, [selectedBookIds])

  useEffect(() => {
    setTempChapterIds(selectedChapterIds)
  }, [selectedChapterIds])

  const handleOpenModal = () => {
    setTempScope(citationScope)
    setTempLiteratureIds(selectedLiteratureIds)
    setTempBookIds(selectedBookIds)
    setTempChapterIds(selectedChapterIds)
    setShowScopeModal(true)
  }

  const handleConfirmScope = () => {
    onCitationScopeChange?.(tempScope)
    onSelectedLiteratureChange?.(tempLiteratureIds)
    onSelectedBooksChange?.(tempBookIds)
    onSelectedChaptersChange?.(tempChapterIds)
    setShowScopeModal(false)
  }

  const handleToggleTempLiterature = (id: string) => {
    setTempLiteratureIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    )
  }

  const handleSelectAllTempLiterature = () => {
    setTempLiteratureIds(DEMO_LITERATURE.map((l) => l.id))
  }

  const handleClearTempLiterature = () => {
    setTempLiteratureIds([])
  }

  const handleToggleTempBook = (id: string) => {
    setTempBookIds((prev) => {
      const newIds = prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
      const book = DEMO_BOOKS.find((b) => b.id === id)
      if (book && !prev.includes(id)) {
        const newChapterIds = [...tempChapterIds]
        book.chapters.forEach((ch) => {
          if (!newChapterIds.includes(ch.id)) newChapterIds.push(ch.id)
        })
        setTempChapterIds(newChapterIds)
      } else if (book && prev.includes(id)) {
        setTempChapterIds((prevCh) => prevCh.filter((chId) => !book.chapters.some((c) => c.id === chId)))
      }
      return newIds
    })
  }

  const handleSelectAllTempBooks = () => {
    setTempBookIds(DEMO_BOOKS.map((b) => b.id))
    const allChapterIds: string[] = []
    DEMO_BOOKS.forEach((b) => b.chapters.forEach((c) => allChapterIds.push(c.id)))
    setTempChapterIds(allChapterIds)
  }

  const handleClearTempBooks = () => {
    setTempBookIds([])
    setTempChapterIds([])
  }

  const handleToggleTempChapter = (id: string) => {
    setTempChapterIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    )
  }

  const handleSelectAllTempChapters = (bookId: string) => {
    const book = DEMO_BOOKS.find((b) => b.id === bookId)
    if (!book) return
    setTempChapterIds((prev) => {
      const newIds = [...prev]
      book.chapters.forEach((ch) => {
        if (!newIds.includes(ch.id)) newIds.push(ch.id)
      })
      return newIds
    })
  }

  const handleClearTempChapters = (bookId: string) => {
    const book = DEMO_BOOKS.find((b) => b.id === bookId)
    if (!book) return
    const chapterIdsToRemove = new Set(book.chapters.map((c) => c.id))
    setTempChapterIds((prev) => prev.filter((id) => !chapterIdsToRemove.has(id)))
  }

  const getScopeLabel = () => {
    const option = SCOPE_OPTIONS.find((o) => o.value === citationScope)
    if (!option) return '全部文献'
    if (citationScope === 'literature') {
      return `${option.label} (${selectedLiteratureIds.length})`
    }
    if (citationScope === 'books') {
      return `${option.label} (${selectedBookIds.length})`
    }
    if (citationScope === 'chapters') {
      return `${option.label} (${selectedChapterIds.length})`
    }
    return option.label
  }

  const ScopeIcon = SCOPE_OPTIONS.find((o) => o.value === citationScope)?.icon || Library

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 bg-gradient-to-r from-indigo-50/80 to-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-indigo-100 rounded-lg flex items-center justify-center">
              <ShieldCheck className="w-4 h-4 text-indigo-600" />
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-800">AI 双引擎 · 可信检索</div>
              <div className="text-[0.625rem] text-slate-500">
                AI-1 生成 + 引用标注 · AI-2 事实核查
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onTrustedSearchChange?.(!trustedSearch)}
            className="flex items-center gap-1.5 transition"
          >
            {trustedSearch ? (
              <ToggleRight className="w-7 h-7 text-indigo-600" />
            ) : (
              <ToggleLeft className="w-7 h-7 text-slate-300" />
            )}
          </button>
        </div>
      </div>

      <div className={`transition-all duration-300 ${trustedSearch ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
        <div className="px-4 py-3 grid grid-cols-2 gap-3 border-b border-slate-100">
          <ModelSelector
            label="生成位 AI-1"
            role="ai1"
            value={ai1Model}
            onChange={(v) => onAi1ModelChange?.(v)}
            icon={<Sparkles className="w-3.5 h-3.5 text-indigo-600" />}
            accentColor="indigo"
          />
          <ModelSelector
            label="审阅位 AI-2"
            role="ai2"
            value={ai2Model}
            onChange={(v) => onAi2ModelChange?.(v)}
            icon={<ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />}
            accentColor="emerald"
          />
        </div>

        <div className="px-4 py-3 space-y-2">
          <div className="text-xs font-medium text-slate-600 flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5 text-indigo-600" />
            引用范围
          </div>
          <button
            type="button"
            onClick={handleOpenModal}
            className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-left hover:border-indigo-300 transition flex items-center justify-between group"
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-6 h-6 bg-indigo-100 rounded-md flex items-center justify-center flex-shrink-0">
                <ScopeIcon className="w-3.5 h-3.5 text-indigo-600" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium text-slate-700 truncate">
                  {getScopeLabel()}
                </div>
                <div className="text-[0.625rem] text-slate-400 truncate">
                  点击设置 AI 可参考的文献范围
                </div>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-indigo-500 group-hover:translate-x-0.5 transition-all" />
          </button>
        </div>

        <div className="px-4 pb-3">
          <div className="p-2.5 bg-gradient-to-r from-emerald-50 to-teal-50 rounded-lg border border-emerald-100">
            <div className="text-[0.6875rem] text-emerald-800 leading-relaxed">
              <span className="font-semibold">工作流程：</span>
              AI-1 基于选定文献生成回答并标注 [1][2] 引用 → AI-2 逐句核查真实性 →
              仅输出通过核查的内容
            </div>
          </div>
        </div>
      </div>

      <CitationScopeModal
        open={showScopeModal}
        onClose={() => setShowScopeModal(false)}
        scope={tempScope}
        onScopeChange={setTempScope}
        selectedLiteratureIds={tempLiteratureIds}
        onToggleLiterature={handleToggleTempLiterature}
        onSelectAllLiterature={handleSelectAllTempLiterature}
        onClearLiterature={handleClearTempLiterature}
        selectedBookIds={tempBookIds}
        onToggleBook={handleToggleTempBook}
        onSelectAllBooks={handleSelectAllTempBooks}
        onClearBooks={handleClearTempBooks}
        selectedChapterIds={tempChapterIds}
        onToggleChapter={handleToggleTempChapter}
        onSelectAllChapters={handleSelectAllTempChapters}
        onClearChapters={handleClearTempChapters}
        onConfirm={handleConfirmScope}
      />
    </div>
  )
}
