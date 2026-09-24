import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadLiteratures, saveLiteratures, doiToSlug, inferPaperTier, inferMdStatusByDoi, type Literature } from '../services/literatureData'
import { loadTextbooks, saveTextbooks, type Textbook } from '../services/textbookData'
import { loadCategories, saveCategories, type LiteratureCategory } from '../services/literatureCategoryData'
import {
  loadBookCategories,
  saveBookCategories,
  loadDocumentCategories,
  saveDocumentCategories,
  categoriesOfMember,
  setMemberCategories,
  type Category,
} from '../services/categoryData'
import {
  listDocuments,
  importMarkdownDocs,
  updateDocumentEntry,
  deleteDocuments,
  readMarkdownZip,
  titleFromFileName,
  type DocumentSummary,
  type ImportItem,
} from '../services/documentData'
import { useSettingsStore } from '../stores/settings'
import { useWorkspaceStore } from '../stores/workspace'
import { useAuthStore } from '../stores/auth'
import { githubFetch, deleteRepoFiles } from '../services/github'
import { pollProgressJson, pollBookProgressJson, getRun, getLatestRun, dispatchPaperConvert } from '../services/workflowClient'
import { invalidateCache } from '../services/userData'
import { enqueuePaperMineruConvert } from '../services/paperPipeline'
import { enqueueBookMineruConvert } from '../services/bookPipeline'
import { useTaskQueueStore, STAGE_META, type PipelineStage, type BackgroundTask } from '../stores/taskQueue'
import BackendMonitorPanel from '../components/BackendMonitorPanel'
import {
  createTemplate,
  updateTemplate,
  deleteTemplate as deleteJournalTemplate,
  getAllTemplates,
  setDefaultTemplate,
  type JournalTemplate as BackendJournalTemplate,
} from '../services/journal-templates'
import { callAI } from '../services/ai/client'
import {
  loadWords, saveWords,
  loadSentences, saveSentences,
  loadTranslations, saveTranslations,
} from '../services/learningData'
import { normalizeDoi, getCitationEntries } from '../services/citation'
import {
  FolderCog,
  BookMarked,
  FileText,
  BookOpen,
  BookCopy,
  ArrowLeftRight,
  Plus,
  Edit3,
  Trash2,
  Eye,
  Upload,
  Download,
  Search,
  ChevronLeft,
  ChevronRight,
  X,
  Loader2,
  CheckCircle2,
  Clock,
  AlertCircle,
  Star,
  Book,
  RefreshCw,
  Database,
  Image as ImageIcon,
  Link as LinkIcon,
  StickyNote,
  FileSpreadsheet,
  FileJson,
  BookText,
  Github,
  Layers,
  Sparkles,
  ExternalLink,
  CheckSquare,
  ChevronDown,
  Folder,
  LayoutGrid,
  List,
  MoveRight,
  Tag,
  Library,
  // ListTodo,
} from 'lucide-react'
import { DoiLink } from '../components/DoiLink'
import { toast } from 'sonner'
import {
  searchLibrary,
  getSearchIndex,
  buildHighlightRegex,
  KIND_LABEL,
  type SearchHit,
} from '../services/librarySearch'

type SubTabId = 'library' | 'templates' | 'knowledge' | 'documents' | 'import-export'

interface PaperCategory {
  id: string
  name: string
  children?: PaperCategory[]
}

interface Paper {
  id: string
  title: string
  authors: string
  year: string
  journal: string
  keywords: string[]
  doi: string
  tier: 1 | 2
  coverImage?: string
  hasNotes: boolean
  mdStatus: 'none' | 'converting' | 'done' | 'failed'
  mdProgress: number
  postStage?: 'none' | 'translating' | 'words' | 'done' | 'error'
  /** 是否已导入 PDF（来自 CSV 的 pdf_added_at > 0，筛选用） */
  hasPdf: boolean
  /** 所属分类 id 列表（可以同时属于多个分类） */
  categoryIds: string[]
  /** 追踪页给它打的分组；只读保留，绝不用分类去覆盖它 */
  trackingGroup: string
}

/** UI 层期刊模板项 —— 包装后端 JournalTemplate，加派生字段方便显示 */
interface JournalTemplateItem {
  id: string
  name: string
  publisher: string
  issn: string
  lastUpdated: string
  isDefault: boolean
  formatSummary: string
}

/** 后端 JournalTemplate → UI JournalTemplateItem */
function toTemplateItem(t: BackendJournalTemplate): JournalTemplateItem {
  const parts = [
    t.title_format_note && `标题: ${t.title_format_note}`,
    t.abstract_format_note && `摘要: ${t.abstract_format_note}`,
    t.reference_format_note && `参考文献: ${t.reference_format_note}`,
  ].filter(Boolean)
  const summary =
    t.guidelines_content?.slice(0, 200) ||
    parts.join('；') ||
    t.custom_preamble?.slice(0, 150) ||
    '暂无格式规范摘要'
  return {
    id: t.id,
    name: t.name,
    publisher: t.publisher || '',
    issn: t.issn || '',
    lastUpdated: t.updated_at ? new Date(t.updated_at).toISOString().split('T')[0] : '-',
    isDefault: !!t.is_default,
    formatSummary: summary,
  }
}

interface BookVolume {
  id: string
  volume: number
  pageRange: string
  status: 'converting' | 'done' | 'failed'
  progress: number
}

interface BookItem {
  id: string
  title: string
  author: string
  publisher: string
  year: number
  addedAt: number
  status: 'uploading' | 'converting' | 'done' | 'failed'
  coverImage?: string
  progress: number
  volumes?: BookVolume[]
  isSplit: boolean
  categoryIds: string[]
}

const subTabs: { id: SubTabId; label: string; icon: typeof BookMarked }[] = [
  { id: 'library', label: '文献库', icon: BookMarked },
  { id: 'knowledge', label: '图书库', icon: BookCopy },
  { id: 'documents', label: '其他文档', icon: FileText },
  { id: 'templates', label: '期刊模板', icon: BookOpen },
  { id: 'import-export', label: '导入导出', icon: ArrowLeftRight },
]

// 'all' 是伪分类（不落盘），只用来表示"全部图书"
const DEFAULT_BOOK_CATEGORIES: Category[] = [
  { id: 'all', name: '全部图书', members: [] },
]

const PAGE_SIZE = 10

function literatureToPaper(lit: Literature): Paper {
  return {
    id: lit.doi || String(lit.addedAt),
    title: lit.title,
    authors: lit.authors,
    year: String(lit.year),
    journal: lit.journal,
    keywords: lit.keywords ? lit.keywords.split(',').map((k) => k.trim()).filter(Boolean) : [],
    doi: lit.doi,
    // 历史脏数据（tier=0，早期 PDF 上传未设置）：按标题/期刊重新推断
    tier: (lit.tier === 1 || lit.tier === 2 ? lit.tier : inferPaperTier(lit.title, lit.journal)) as 1 | 2,
    hasNotes: false,
    mdStatus: lit.mdStatus || 'none',
    mdProgress: 0,
    hasPdf: (lit.pdfAddedAt || 0) > 0,
    // 分类关系存在 literatures/categories.csv 里，加载时再填进来（见 loadData）
    categoryIds: [],
    trackingGroup: lit.trackingGroup,
  }
}

function paperToLiterature(paper: Paper): Literature {
  return {
    doi: paper.doi,
    title: paper.title,
    journal: paper.journal,
    year: parseInt(paper.year, 10) || 0,
    authors: paper.authors,
    keywords: paper.keywords.join(', '),
    abstractEn: '',
    abstractCn: '',
    tier: paper.tier,
    hasGraphicalAbstract: !!paper.coverImage,
    addedAt: Date.now(),
    pdfAddedAt: 0,
    source: 'manual',
    // 追踪分组与文献分类是两回事，原样带回，不要被分类覆盖
    trackingGroup: paper.trackingGroup || '',
    mdStatus: paper.mdStatus || 'none',
  }
}

/** 把分类树拍平成一层（'全部文献' 是伪分类，不落盘） */
function flattenCategories(cats: PaperCategory[]): PaperCategory[] {
  const out: PaperCategory[] = []
  const walk = (list: PaperCategory[]) => {
    for (const c of list) {
      if (c.id === 'all') continue
      out.push(c)
      if (c.children?.length) walk(c.children)
    }
  }
  walk(cats)
  return out
}

/**
 * 分类落盘内容：分类本身 + 它的成员文献。
 * 成员关系（dois）从 papers 反推 —— 唯一事实来源是每篇文献的 categoryIds。
 */
function buildCategoryPayload(cats: PaperCategory[], papers: Paper[]): LiteratureCategory[] {
  return flattenCategories(cats).map((c) => ({
    id: c.id,
    name: c.name,
    dois: papers.filter((p) => p.categoryIds.includes(c.id)).map((p) => p.doi),
  }))
}

function textbookToBookItem(tb: Textbook, categories: Category[]): BookItem {
  return {
    id: tb.textbookId,
    title: tb.title,
    author: tb.author,
    publisher: tb.publisher,
    year: tb.year,
    addedAt: tb.addedAt,
    status: 'done',
    progress: 100,
    isSplit: false,
    // 分类关系存在 textbooks/categories.csv，主键是书名（= textbook_id）
    categoryIds: categoriesOfMember(categories, tb.textbookId),
  }
}

function bookItemToTextbook(book: BookItem): Textbook {
  return {
    textbookId: book.id,
    title: book.title,
    author: book.author,
    publisher: book.publisher,
    year: book.year,
    notes: '',
    addedAt: book.addedAt,
  }
}

function StatusBadge({ status }: { status: Paper['mdStatus'] }) {
  const config = {
    none: { label: '未转换', icon: Clock, color: 'bg-ink-100 text-ink-500' },
    converting: { label: '转换中', icon: Loader2, color: 'bg-blue-100 text-blue-600' },
    done: { label: '已完成', icon: CheckCircle2, color: 'bg-green-100 text-green-600' },
    failed: { label: '失败', icon: AlertCircle, color: 'bg-red-100 text-red-600' },
  }
  const { label, icon: Icon, color } = config[status]
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      <Icon className={`w-3 h-3 ${status === 'converting' ? 'animate-spin' : ''}`} />
      {label}
    </span>
  )
}

function BookStatusBadge({ status }: { status: BookItem['status'] }) {
  const config = {
    uploading: { label: '上传中', color: 'bg-ink-100 text-ink-600' },
    converting: { label: '转换中', color: 'bg-blue-100 text-blue-600' },
    done: { label: '已完成', color: 'bg-green-100 text-green-600' },
    failed: { label: '失败', color: 'bg-red-100 text-red-600' },
  }
  const { label, color } = config[status]
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {label}
    </span>
  )
}

function Modal({ title, onClose, children, width = 'max-w-lg' }: { title: string; onClose: () => void; children: React.ReactNode; width?: string }) {
  return (
    <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center z-50 p-4">
      <div className={`bg-paper-50 rounded-2xl shadow-xl w-full ${width} max-h-[90vh] overflow-hidden flex flex-col`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-ink-200">
          <h3 className="font-semibold text-ink-800">{title}</h3>
          <button onClick={onClose} className="p-1 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded-lg transition">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 py-5 overflow-y-auto flex-1">
          {children}
        </div>
      </div>
    </div>
  )
}

function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-ink-900/80 flex items-center justify-center z-[60] p-8" onClick={onClose}>
      <img src={src} alt="" className="max-w-full max-h-full object-contain rounded-lg" onClick={(e) => e.stopPropagation()} />
      <button onClick={onClose} className="absolute top-4 right-4 p-2 text-paper-50/70 hover:text-paper-50 hover:bg-paper-50/10 rounded-lg transition">
        <X className="w-6 h-6" />
      </button>
    </div>
  )
}

export default function ManagementPage() {
  const navigate = useNavigate()
  const { repo } = useWorkspaceStore()
  const auth = useAuthStore()
  const owner = repo?.owner?.login ?? auth.user?.login ?? ''
  const token = auth.token ?? ''
  const [activeTab, setActiveTab] = useState<SubTabId>('library')

  // 文献库状态
  const [tierFilter, setTierFilter] = useState<'all' | 1 | 2>('all')
  /** PDF 导入状态筛选：all=全部 / has=已导入 PDF / missing=未导入 PDF */
  const [pdfFilter, setPdfFilter] = useState<'all' | 'has' | 'missing'>('all')
  const [libraryPage, setLibraryPage] = useState(1)
  const [searchQuery, setSearchQuery] = useState('')
  // ── 全文检索（库内正文，不只是元数据）：结果放独立弹窗，点结果直接去阅读页定位 ──
  const [ftOpen, setFtOpen] = useState(false)
  const [ftHits, setFtHits] = useState<SearchHit[]>([])
  const [ftQuery, setFtQuery] = useState('')
  const [ftLoading, setFtLoading] = useState(false)
  const [ftProgress, setFtProgress] = useState({ done: 0, total: 0 })
  const [showAddPaperModal, setShowAddPaperModal] = useState(false)
  const [showEditPaperModal, setShowEditPaperModal] = useState(false)
  const [showImageLightbox, setShowImageLightbox] = useState<string | null>(null)
  const [editingPaper, setEditingPaper] = useState<Paper | null>(null)
  const [papers, setPapers] = useState<Paper[]>([])
  const [newPaper, setNewPaper] = useState({ title: '', authors: '', year: '', journal: '', doi: '', keywords: '', tier: 'auto' as 'auto' | '1' | '2', categoryIds: [] as string[] })
  const [doiFetching, setDoiFetching] = useState(false)
  const [doiFetchError, setDoiFetchError] = useState<string | null>(null)
  const [doiQuickInput, setDoiQuickInput] = useState('')
  const [isAddingByDoi, setIsAddingByDoi] = useState(false)
  const [selectedPapers, setSelectedPapers] = useState<Set<string>>(new Set())
  const [batchMode, setBatchMode] = useState(false)
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())
  const [viewMode, setViewMode] = useState<'table' | 'card'>('table')
  const [paperCategories, setPaperCategories] = useState<PaperCategory[]>([{ id: 'all', name: '全部文献' }])
  const [activePaperCategory, setActivePaperCategory] = useState<string>('all')
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['my-categories']))
  const [showBatchMoveModal, setShowBatchMoveModal] = useState(false)
  const [batchMoveTargetIds, setBatchMoveTargetIds] = useState<string[]>([])
  const [editingCategory, setEditingCategory] = useState<{ id?: string; name: string; parentId?: string } | null>(null)
  const [showCategoryModal, setShowCategoryModal] = useState(false)

  // 期刊模板状态
  const [templates, setTemplates] = useState<JournalTemplateItem[]>([])
  const [showTemplateModal, setShowTemplateModal] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<JournalTemplateItem | null>(null)
  const [newTemplate, setNewTemplate] = useState({ name: '', issn: '', publisher: '', guidelines: '' })
  const [isExtracting, setIsExtracting] = useState(false)

  // 知识库状态
  const [books, setBooks] = useState<BookItem[]>([])
  const [showBookDetail, setShowBookDetail] = useState<BookItem | null>(null)
  const [isDragOverBook, setIsDragOverBook] = useState(false)
  const [bookCategories, setBookCategories] = useState<Category[]>(DEFAULT_BOOK_CATEGORIES)
  const [activeBookCategory, setActiveBookCategory] = useState<string>('all')
  const [editingBookCategory, setEditingBookCategory] = useState<{ id?: string; name: string } | null>(null)
  const [showBookCategoryModal, setShowBookCategoryModal] = useState(false)
  const [showUploadBookModal, setShowUploadBookModal] = useState(false)
  const [uploadBookCategories, setUploadBookCategories] = useState<string[]>([])
  /** 图书详情弹窗里正在编辑的所属分类（与已落盘内容分开，保存时才写回） */
  const [bookDetailCategoryIds, setBookDetailCategoryIds] = useState<string[]>([])

  // 其他文档状态
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [documentsLoading, setDocumentsLoading] = useState(false)
  const [documentSearch, setDocumentSearch] = useState('')
  const [documentCategories, setDocumentCategories] = useState<Category[]>([])
  const [showImportDocModal, setShowImportDocModal] = useState(false)
  /** 导入弹窗的三种方式：上传 .md / 粘贴文本 / 上传 zip */
  const [importMode, setImportMode] = useState<'file' | 'paste' | 'zip'>('file')
  const [pasteDoc, setPasteDoc] = useState({ title: '', content: '' })
  const [importing, setImporting] = useState(false)
  const [editingDocument, setEditingDocument] = useState<DocumentSummary | null>(null)
  const [editDocForm, setEditDocForm] = useState({ title: '', author: '', categoryIds: [] as string[] })
  const [savingDocument, setSavingDocument] = useState(false)

  // 后台任务状态
  const taskQueue = useTaskQueueStore()
  const taskQueueRef = useRef(taskQueue)
  taskQueueRef.current = taskQueue

  // 加载数据：文献 + 文献分类（分类的成员关系存在 literatures/categories.csv）
  useEffect(() => {
    if (!repo) return
    const loadData = async () => {
      try {
        const [lits, cats] = await Promise.all([loadLiteratures(true), loadCategories()])
        // 分类文件是「分类 → 成员 doi」，这里反过来建成 doi → 分类 id[]
        const doiToCatIds = new Map<string, string[]>()
        for (const c of cats) {
          for (const d of c.dois) {
            const arr = doiToCatIds.get(d) || []
            arr.push(c.id)
            doiToCatIds.set(d, arr)
          }
        }
        setPaperCategories([{ id: 'all', name: '全部文献' }, ...cats.map((c) => ({ id: c.id, name: c.name }))])
        // 防缓存：跳过正在删除的 ID —— 即使 CSV 还没 propagate 也不让它冒出来
        setPapers(
          lits
            .map(literatureToPaper)
            .map((p) => ({ ...p, categoryIds: doiToCatIds.get(p.doi) || [] }))
            .filter((p) => !deletingIds.has(p.id)),
        )
      } catch (err) {
        console.error('加载文献失败:', err)
      }
    }
    loadData()
  }, [repo])

  useEffect(() => {
    if (!repo) return
    const loadData = async () => {
      try {
        // 图书分类从 textbooks/categories.csv 读，成员关系由主键（书名）反查
        const [tbs, cats] = await Promise.all([loadTextbooks(), loadBookCategories()])
        setBookCategories([...DEFAULT_BOOK_CATEGORIES, ...cats])
        setBooks(tbs.map((tb) => textbookToBookItem(tb, cats)))
      } catch (err) {
        console.error('加载教材失败:', err)
      }
    }
    loadData()
  }, [repo])

  // 加载其他文档 + 文档分类（分类成员存在 documents/categories.csv）
  useEffect(() => {
    if (!repo) return
    const loadData = async () => {
      setDocumentsLoading(true)
      try {
        const [docs, cats] = await Promise.all([listDocuments(), loadDocumentCategories()])
        setDocuments(docs)
        setDocumentCategories(cats)
      } catch (err) {
        console.error('加载其他文档失败:', err)
      } finally {
        setDocumentsLoading(false)
      }
    }
    loadData()
  }, [repo])

  // 加载期刊模板（从 GitHub 私库 journal-templates.ts 后端）
  useEffect(() => {
    if (!repo) return
    const loadTemplates = async () => {
      try {
        const backend = await getAllTemplates()
        setTemplates(backend.map(toTemplateItem))
      } catch (err) {
        console.error('加载期刊模板失败:', err)
      }
    }
    loadTemplates()
  }, [repo])

  /** 把 taskQueue 的 running 任务进度实时同步到对应 paper（卡片上的内联进度条需要） */
  useEffect(() => {
    const runningOrPending = taskQueue.tasks.filter(
      (t) => t.status === 'running' || t.status === 'pending',
    )
    if (runningOrPending.length === 0) return

    setPapers((prev) => {
      let changed = false
      const updated: Paper[] = prev.map((p) => {
        const task = runningOrPending.find(
          (t) => t.doi === p.doi && t.type === 'paper_convert',
        )
        if (!task) return p
        if (
          p.mdProgress === task.progress &&
          p.mdStatus === (task.status === 'pending' ? 'converting' : p.mdStatus)
        ) {
          return p
        }
        changed = true
        return {
          ...p,
          mdProgress: task.progress,
          mdStatus: 'converting' as const,
        }
      })
      return changed ? updated : prev
    })
  }, [taskQueue.tasks])


  /** 图书卡片进度：taskQueue 里 book_convert 任务的状态/进度实时同步到对应 book（按书名匹配） */
  useEffect(() => {
    const bookTasks = taskQueue.tasks.filter((t) => t.type === 'book_convert')
    if (bookTasks.length === 0) return

    setBooks((prev) => {
      let changed = false
      const updated: BookItem[] = prev.map((b) => {
        const task = bookTasks.find((t) => t.book_id === b.id)
        if (!task) return b
        const nextStatus: BookItem['status'] =
          task.status === 'done'
            ? 'done'
            : task.status === 'failed' || task.status === 'aborted'
              ? 'failed'
              : 'converting'
        const nextProgress = task.status === 'done' ? 100 : task.progress
        if (b.status === nextStatus && b.progress === nextProgress) return b
        changed = true
        return { ...b, status: nextStatus, progress: nextProgress }
      })
      return changed ? updated : prev
    })
  }, [taskQueue.tasks])


  // ──── 核心：taskQueue 里 pending/running 的 paper_convert 任务 ↔ 后端 progress.json 同步 ────
  // 这是右侧 BackendMonitorPanel 的真实数据源：
  //   GitHub Actions 写 .progress.json → 前端每 5 秒拉一次 → 更新 taskQueue.stage/node_index/progress
  //   → BackendMonitorPanel 订阅 taskQueue → 四节点进度条实时走
  useEffect(() => {
    if (!repo) return

    let cancelled = false
    const pollInterval = setInterval(async () => {
      if (cancelled) return
      const auth = useAuthStore.getState()
      const owner = auth.user?.login
      const token = auth.token
      if (!owner || !token) return

      const tq = useTaskQueueStore.getState()
      const activeTasks = tq.tasks.filter(
        (t: BackgroundTask) =>
          (t.status === 'pending' || t.status === 'running') &&
          (t.type === 'paper_convert' || t.type === 'book_convert'),
      )
      if (activeTasks.length === 0) return

      for (const task of activeTasks) {
        if (cancelled) break
        // metadata?.slug 由 pipeline 在任务创建时注入；doi 是文献的 fallback，
        // 图书没有 doi，用 book_id（= 书名）当 slug。
        const meta = task.metadata as Record<string, unknown> | undefined
        const metaSlug = typeof meta?.slug === 'string' ? meta.slug : undefined
        const doiSlug = task.doi ? doiToSlug(task.doi) : undefined
        const isBook = task.type === 'book_convert'
        const slug = metaSlug || doiSlug || task.book_id
        if (!slug) continue
        try {
          // 文献进度在 literatures/{slug}/，图书在 textbooks/{书名}/
          const prog = isBook
            ? await pollBookProgressJson(slug, owner, repo.name, token)
            : await pollProgressJson(slug, owner, repo.name, token)

          if (prog) {
            // 有 progress.json → 正常走后端 stage 驱动的进度更新
            const stageMeta = STAGE_META[prog.stage as PipelineStage]
            if (!stageMeta) {
              console.warn('[poll-progress] 未知 stage:', prog.stage, '→ 保持当前进度')
              continue
            }

            const patch: Partial<BackgroundTask> = {
              stage: prog.stage as PipelineStage,
              node_index: stageMeta.node,
              progress: prog.pct ?? stageMeta.pctBase,
              message: prog.message || stageMeta.label,
              updated_at: Date.now(),
            }

            if (prog.stage === 'done') {
              patch.status = 'done'
              patch.stage = 'done'
              patch.node_index = STAGE_META.done.node
              patch.progress = 100
              patch.message = '转换完成'
            } else if (prog.stage === 'failed') {
              patch.status = 'failed'
              patch.stage = 'failed'
              patch.node_index = STAGE_META.failed.node
              // 后端会存档每个阶段的中间产物：重试只跑后面的部分，这里明确告诉用户从哪继续
              const resumeHint = prog.resume_from ? `，重试将从「${prog.resume_from}」继续（前面的产物已存档）` : ''
              patch.message = prog.error ? `失败：${prog.error}${resumeHint}` : `转换失败${resumeHint}`
              patch.error = prog.error || '后端返回 failed'
            } else {
              if (task.status === 'pending') patch.status = 'running'
            }

            await tq.update_task(task.id, patch)
          } else {
            // 没有 progress.json（还没被写出来）→ 用 GitHub Actions run 状态兜底
            const runId = typeof meta?.id === 'number' ? meta.id : null
            if (!runId) {
              // 连 run_id 都没有：改用 GitHub 实际产物文件推断终态。
              // 否则后端已完成、progress.json 被清理、run_id 又丢失时，
              // 任务会永远卡在 words_verify/running 打转。
              if (!task.doi) continue
              const inferred = await inferMdStatusByDoi(task.doi)
              if (inferred === 'done') {
                await tq.update_task(task.id, {
                  status: 'done',
                  stage: 'done',
                  node_index: STAGE_META.done.node,
                  progress: 100,
                  message: '转换完成（根据产物文件推断）',
                  updated_at: Date.now(),
                })
              }
              continue
            }

            const run = await getRun(runId, owner, repo.name, token)
            if (!run) continue

            if (run.status === 'queued') {
              // 还在排队，保持 queued 但更新 message
              await tq.update_task(task.id, {
                status: 'pending',
                stage: 'queued',
                message: `GitHub Actions 排队中（#${run.id}）`,
                updated_at: Date.now(),
              })
            } else if (run.status === 'in_progress') {
              // Runner 已经 pickup 了，但 progress.json 还没写 → 至少标记 running
              await tq.update_task(task.id, {
                status: 'running',
                stage: 'queued',
                message: `Runner 运行中（#${run.id}），等待后端写进度...`,
                updated_at: Date.now(),
              })
            } else if (run.status === 'completed') {
              // Run 已经结束但 progress.json 没有 → 用 run conclusion 兜底
              if (run.conclusion === 'success') {
                await tq.update_task(task.id, {
                  status: 'done',
                  stage: 'done',
                  node_index: STAGE_META.done.node,
                  progress: 100,
                  message: '转换完成（progress.json 已清理）',
                  updated_at: Date.now(),
                })
              } else {
                await tq.update_task(task.id, {
                  status: 'failed',
                  stage: 'failed',
                  node_index: STAGE_META.failed.node,
                  message: `Runner ${run.conclusion}（#${run.id}）— 点 Actions 日志排查`,
                  error: `runner ${run.conclusion}`,
                  updated_at: Date.now(),
                })
              }
            }
            // run.status 是 failure/cancelled → 也当失败处理
          }
        } catch {
          // 单次轮询失败不影响其他任务
        }
      }
    }, 5000)

    return () => { cancelled = true; clearInterval(pollInterval) }
  }, [repo])

  /** 分类落盘：分类名 + 成员文献（成员关系从 papers 反推） */
  const persistCategoryStore = async (cats: PaperCategory[], updatedPapers: Paper[]) => {
    try {
      await saveCategories(buildCategoryPayload(cats, updatedPapers))
    } catch (err) {
      console.error('保存文献分类失败:', err)
      toast.error('保存分类失败，请检查仓库权限')
    }
  }

  // 保存文献：元数据写 literatures.csv；分类的成员关系顺带同步落盘
  const savePapers = async (updatedPapers: Paper[]) => {
    try {
      const lits = updatedPapers.map(paperToLiterature)
      await saveLiteratures(lits)
      await persistCategoryStore(paperCategories, updatedPapers)
    } catch (err) {
      console.error('保存文献失败:', err)
    }
  }

  // 保存教材（图书）
  const saveBooks = async (updatedBooks: BookItem[]) => {
    try {
      const tbs = updatedBooks.map(bookItemToTextbook)
      await saveTextbooks(tbs)
    } catch (err) {
      console.error('保存教材失败:', err)
    }
  }

  // 文献分类树 - 展开关闭
  const toggleCategoryExpand = (id: string) => {
    const next = new Set(expandedCategories)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setExpandedCategories(next)
  }

  // 获取所有叶子分类（用于文献数量统计）
  const getAllLeafCategories = useMemo(() => {
    const leaves: { id: string; name: string }[] = []
    const traverse = (cats: PaperCategory[]) => {
      for (const cat of cats) {
        if (cat.children && cat.children.length > 0) {
          traverse(cat.children)
        } else if (cat.id !== 'all') {
          leaves.push({ id: cat.id, name: cat.name })
        }
      }
    }
    traverse(paperCategories)
    return leaves
  }, [paperCategories])

  // 统计各分类文献数量
  const paperCategoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: papers.length }
    for (const paper of papers) {
      for (const cid of paper.categoryIds) {
        counts[cid] = (counts[cid] || 0) + 1
      }
    }
    return counts
  }, [papers])

  // 筛选文献：先按分类 / tier / 搜索过滤（PDF 与否单独一层，方便给筛选按钮算数量）
  const basePapers = useMemo(() => {
    let result = papers
    if (activePaperCategory !== 'all') {
      result = result.filter((p) => p.categoryIds.includes(activePaperCategory))
    }
    if (tierFilter !== 'all') {
      result = result.filter((p) => p.tier === tierFilter)
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.authors.toLowerCase().includes(q) ||
          p.journal.toLowerCase().includes(q) ||
          p.keywords.some((k) => k.toLowerCase().includes(q)),
      )
    }
    return result
  }, [papers, tierFilter, searchQuery, activePaperCategory])

  /** 一级 / 二级都支持"有没有导入 PDF"的筛选 */
  const filteredPapers = useMemo(() => {
    if (pdfFilter === 'all') return basePapers
    return basePapers.filter((p) => (pdfFilter === 'has' ? p.hasPdf : !p.hasPdf))
  }, [basePapers, pdfFilter])

  const totalPages = Math.ceil(filteredPapers.length / PAGE_SIZE)
  const pagedPapers = filteredPapers.slice((libraryPage - 1) * PAGE_SIZE, libraryPage * PAGE_SIZE)

  // 知识库分类筛选
  const filteredBooks = useMemo(() => {
    if (activeBookCategory === 'all') return books
    return books.filter((b) => b.categoryIds.includes(activeBookCategory))
  }, [books, activeBookCategory])

  const bookCategoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: books.length }
    for (const book of books) {
      for (const cid of book.categoryIds) {
        counts[cid] = (counts[cid] || 0) + 1
      }
    }
    return counts
  }, [books])

  // 其他文档搜索
  const filteredDocuments = useMemo(() => {
    const q = documentSearch.trim().toLowerCase()
    if (!q) return documents
    return documents.filter(
      (d) => d.title.toLowerCase().includes(q) || d.author.toLowerCase().includes(q),
    )
  }, [documents, documentSearch])

  // 文献操作
  // Crossref DOI 自动填充
  const handleFetchFromDoi = async (doi: string) => {
    const trimmed = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    if (!trimmed) return
    setDoiFetching(true)
    setDoiFetchError(null)
    try {
      const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(trimmed)}`, {
        headers: { 'User-Agent': 'AcademicFlow/1.0 (https://academicflow.dev)' },
      })
      if (!res.ok) {
        throw new Error(res.status === 404 ? 'DOI 不存在或 Crossref 未收录' : `Crossref 返回 ${res.status}`)
      }
      const data = await res.json()
      const m = data.message as Record<string, unknown>

      const title = (Array.isArray(m.title) ? (m.title as string[])[0] : '') || ''
      const authors = Array.isArray(m.author)
        ? (m.author as Array<{ given?: string; family?: string; name?: string }>)
            .map((a) => (a.name || `${a.given || ''} ${a.family || ''}`).trim())
            .filter(Boolean)
            .join(', ')
        : ''
      const year = (() => {
        const pd = (m['published-print'] || m['published-online'] || m.created || m.issued) as Record<string, unknown> | undefined
        const parts = pd?.['date-parts'] as Array<number[]> | undefined
        if (parts?.[0]?.[0]) return String(parts[0][0])
        return ''
      })()
      const journal = Array.isArray(m['container-title']) ? (m['container-title'] as string[])[0] || '' : ''
      const doiFinal = (m.DOI as string) || trimmed
      const keywords = Array.isArray(m.subject) ? (m.subject as string[]).join(', ') : ''

      setNewPaper((prev) => ({
        ...prev,
        title: title || prev.title,
        authors: authors || prev.authors,
        year: year || prev.year,
        journal: journal || prev.journal,
        doi: doiFinal || prev.doi,
        keywords: keywords || prev.keywords,
      }))
      toast.success('已从 Crossref 自动填充，请确认后保存')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setDoiFetchError(msg)
      toast.error(`Crossref 获取失败：${msg}`)
    } finally {
      setDoiFetching(false)
    }
  }

  /** 工具栏 DOI 快捷入库 — 输入 DOI → Crossref 查元数据 → 直接入库 */
  const handleAddByDoi = useCallback(async () => {
    const normalized = normalizeDoi(doiQuickInput)
    if (!normalized.valid || !normalized.doi) {
      toast.error('请输入有效的 DOI 或 DOI 链接（如 10.1000/sample.00000001）')
      return
    }
    const doi = normalized.doi

    // DOI 去重
    if (papers.some((p) => p.doi && normalizeDoi(p.doi).doi === doi)) {
      toast.error('该 DOI 已存在于文献库', {
        description: '如需覆盖，请先删除旧条目',
        action: { label: '清空输入', onClick: () => setDoiQuickInput('') },
      })
      return
    }

    setIsAddingByDoi(true)
    try {
      const { entries, failed } = await getCitationEntries([doi])
      if (failed.includes(doi) || entries.length === 0) {
        toast.error('DOI 解析失败，请检查输入或 Crossref 是否收录该文献')
        return
      }
      const meta = entries[0]

      // 转成 Paper 结构入库
      const paper: Paper = {
        id: doi,
        title: meta.title,
        authors: (meta.authors || []).join(', '),
        year: String(meta.year || ''),
        journal: meta.journal || '',
        doi,
        keywords: [],
        // 按标题/期刊自动推断一级（原创）/ 二级（综述）
        tier: inferPaperTier(meta.title, meta.journal),
        hasNotes: false,
        mdStatus: 'none',
        mdProgress: 0,
        hasPdf: false,
        // 在当前选中的分类里新增 → 直接归到该分类下
        categoryIds: activePaperCategory !== 'all' ? [activePaperCategory] : [],
        trackingGroup: '',
      }
      const updated = [paper, ...papers]
      setPapers(updated)
      await savePapers(updated)
      setDoiQuickInput('')
      toast.success('已添加到文献库', {
        description: meta.title.slice(0, 60) + (meta.title.length > 60 ? '…' : ''),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`DOI 入库失败：${msg}`)
    } finally {
      setIsAddingByDoi(false)
    }
  }, [doiQuickInput, papers, activePaperCategory])

  const handleAddPaper = async () => {
    if (!newPaper.title.trim()) {
      toast.warning('请先填写文献标题')
      return
    }
    const doiResult = normalizeDoi(newPaper.doi)
    if (!doiResult.valid || !doiResult.doi) {
      toast.error('DOI 无效', { description: 'DOI 不能为空，格式应为 10.XXXX/XXXXXX' })
      return
    }
    const doi = doiResult.doi

    // DOI 去重
    if (papers.some((p) => p.doi && normalizeDoi(p.doi).doi === doi)) {
      toast.error('该 DOI 已存在于文献库', {
        description: '如需覆盖，请先删除旧条目',
        action: { label: '清空 DOI', onClick: () => setNewPaper((p) => ({ ...p, doi: '' })) },
      })
      return
    }

    const prevPapers = papers
    const paper: Paper = {
      id: doi,
      title: newPaper.title.trim(),
      authors: newPaper.authors.trim(),
      year: newPaper.year,
      journal: newPaper.journal.trim(),
      doi,
      keywords: newPaper.keywords.split(',').map((k) => k.trim()).filter(Boolean),
      // 'auto' → 按标题/期刊关键词推断一级（原创）/ 二级（综述）
      tier: (newPaper.tier === 'auto'
        ? inferPaperTier(newPaper.title, newPaper.journal)
        : Number(newPaper.tier)) as 1 | 2,
      hasNotes: false,
      mdStatus: 'none',
      mdProgress: 0,
      hasPdf: false,
      categoryIds: newPaper.categoryIds,
      trackingGroup: '',
    }
    const updated = [paper, ...papers]
    setPapers(updated)
    try {
      await savePapers(updated)
      setNewPaper({ title: '', authors: '', year: '', journal: '', doi: '', keywords: '', tier: 'auto', categoryIds: [] })
      setShowAddPaperModal(false)
      toast.success('文献已保存', { description: '刷新后仍会保留' })
    } catch (err) {
      setPapers(prevPapers)
      toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`, { duration: 5000 })
    }
  }

  /** 递归列出 GitHub 仓库目录下所有文件（用 Contents API），404 返回空数组 */
  const listRepoFilesRecursive = async (
    owner: string,
    repo: string,
    dirPath: string,
    token: string,
  ): Promise<string[]> => {
    const res = await githubFetch(
      `/repos/${owner}/${repo}/contents/${encodeURI(dirPath)}`,
      token,
    )
    if (res.status === 404) return []
    if (!res.ok) {
      console.warn(`[listRepoFilesRecursive] 读取目录 ${dirPath} 失败: ${res.status}`)
      return []
    }
    const entries = (await res.json()) as Array<{ type: string; path: string }>
    const files: string[] = []
    for (const entry of entries) {
      if (entry.type === 'file') {
        files.push(entry.path)
      } else if (entry.type === 'dir') {
        const sub = await listRepoFilesRecursive(owner, repo, entry.path, token)
        files.push(...sub)
      }
    }
    return files
  }

  /**
   * 收集要删除的文献目录下所有文件路径
   * 用 git/trees?recursive=1 一次请求列出整个子树，避免 N 次 404 试探
   * 如果目录还不存在（literatures/{slug} 根本没建），返回空数组
   */
  const collectLiteratureFilePaths = async (paperDoi: string): Promise<string[]> => {
    const ctx = getRepoContextForDelete()
    if (!ctx) return []
    const slug = doiToSlug(paperDoi)
    const dirPath = `literatures/${slug}`

    // 一次性列出 literatures/ 下面所有条目，再过滤出以 dirPath/ 开头的
    const treeRes = await githubFetch(
      `/repos/${ctx.owner}/${ctx.repo}/git/trees/main?recursive=1`,
      ctx.token,
    )
    if (treeRes.status === 404) return []
    if (!treeRes.ok) return []

    try {
      const data = await treeRes.json()
      const allEntries = (data.tree ?? []) as Array<{ path: string; type: string }>
      const paths: string[] = []
      for (const entry of allEntries) {
        if (entry.type === 'blob' && entry.path.startsWith(`${dirPath}/`)) {
          paths.push(entry.path)
        }
      }
      return paths
    } catch {
      return []
    }
  }

  const getRepoContextForDelete = (): { owner: string; repo: string; token: string } | null => {
    const auth = useAuthStore.getState()
    const ws = useWorkspaceStore.getState()
    if (!auth.token || !auth.user || !ws.repo) return null
    return { owner: auth.user.login, repo: ws.repo.name, token: auth.token }
  }

  /** 从 CSV 删除所有 source_doi === paperDoi 的行（load → filter → save） */
  const cleanUpCsvByDoi = async (paperDoi: string) => {
    const errors: string[] = []
    try {
      const words = await loadWords(true)
      const remaining = words.filter((w) => w.sourceDoi !== paperDoi)
      if (remaining.length !== words.length) await saveWords(remaining)
    } catch (e) {
      errors.push(`vocabulary.csv 删除失败`)
      console.warn('[cleanUpCsv] vocabulary:', e)
    }
    try {
      const sentences = await loadSentences(true)
      const remaining = sentences.filter((s) => s.sourceDoi !== paperDoi)
      if (remaining.length !== sentences.length) await saveSentences(remaining)
    } catch (e) {
      errors.push(`sentences.csv 删除失败`)
      console.warn('[cleanUpCsv] sentences:', e)
    }
    try {
      const translations = await loadTranslations(true)
      const remaining = translations.filter((t) => t.sourceDoi !== paperDoi)
      if (remaining.length !== translations.length) await saveTranslations(remaining)
    } catch (e) {
      errors.push(`translation_practice.csv 删除失败`)
      console.warn('[cleanUpCsv] translations:', e)
    }
    return errors
  }

  /** 从 taskQueue 中清理某 DOI 的所有 paper_convert 任务（无论什么状态） */
  const cleanupTasksForDoi = async (doi: string) => {
    try {
      const tq = useTaskQueueStore.getState()
      const matching = tq.tasks.filter(
        (t: BackgroundTask) => t.doi === doi && t.type === 'paper_convert',
      )
      if (matching.length === 0) return
      console.log(`[cleanupTasksForDoi] 清理 ${matching.length} 个任务:`, matching.map((t: BackgroundTask) => `${t.id}(${t.status})`))
      for (const t of matching) {
        if (t.status === 'running' || t.status === 'pending') {
          try { await tq.abort_task(t.id) } catch {}
        }
        try { await tq.remove_task(t.id) } catch {}
      }
    } catch (e) {
      console.warn('[cleanupTasksForDoi] 失败（不阻塞删除）:', e)
    }
  }

  /**
   * 异步删除 GitHub 文件 + race cleanup（fire-and-forget，不阻塞 UI）
   * Phase1 立即删，Phase2/3 race retry 放后台 setTimeout(5s) 跑
   * 返回一个 Promise<{deletedCount, phase1Ok}> — Phase1 完成就 resolve
   */
  const deleteLiteratureFilesFast = async (
    doi: string,
    owner: string,
    repo: string,
    token: string,
  ): Promise<{ deletedCount: number; phase1Ok: boolean; error?: string }> => {
    try {
      // Phase 1: 立即删（同步等它完成，因为用户点了删除就期望文件真的消失）
      const paths1 = await collectLiteratureFilePaths(doi)
      if (paths1.length > 0) {
        await deleteRepoFiles(
          paths1,
          `chore: delete literature ${doi.slice(0, 30)}`,
          owner, repo, token,
        )
        console.log(`[deleteFilesFast] phase1 删除 ${paths1.length} 个文件`)
      } else {
        console.log(`[deleteFilesFast] phase1: 无文件可删`)
      }

      // Phase 2/3: 后台 setTimeout 做 race cleanup（5 秒后，不阻塞）
      setTimeout(async () => {
        try {
          const paths2 = await collectLiteratureFilePaths(doi)
          if (paths2.length > 0) {
            console.log(`[deleteFilesFast] phase2 发现 ${paths2.length} 个残留（race 回写），异步重试删除`)
            await deleteRepoFiles(
              paths2,
              `chore: retry delete literature ${doi.slice(0, 30)} (race)`,
              owner, repo, token,
            )
          }
          // 最终校验
          const remaining = await collectLiteratureFilePaths(doi)
          if (remaining.length > 0) {
            console.warn(`[deleteFilesFast] ⚠️ 仍有 ${remaining.length} 个残留（新 pipeline 正在跑？）`)
          } else {
            console.log(`[deleteFilesFast] phase2 race cleanup OK — 干净`)
          }
        } catch (e) {
          console.warn(`[deleteFilesFast] phase2 失败（忽略）:`, e)
        }
      }, 5000)

      return { deletedCount: paths1.length, phase1Ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { deletedCount: 0, phase1Ok: false, error: msg }
    }
  }

  const handleDeletePaper = async (id: string) => {
    const paper = papers.find((p) => p.id === id)
    if (!paper) return

    const confirmed = window.confirm(
      `确定删除文献「${paper.title}」吗？\n这会同时删除 GitHub 仓库中的 Markdown、翻译、批注、以及关联的单词/例句记录。\n此操作不可撤销。`,
    )
    if (!confirmed) return

    // ═══ 防重复点击：正在删就跳过 ═══
    if (deletingIds.has(id)) return

    const paperDoi = paper.doi ?? ''
    const ctx = getRepoContextForDelete()
    const prevPapers = papers  // 备份，savePapers 失败要回滚

    // ═══ 立即标记为删除中（按钮显示点点动画）═══
    setDeletingIds((prev) => new Set(prev).add(id))

    try {
      // ═══ 0. 立即清理 taskQueue（同步、很快） ═══
      if (paperDoi) {
        await cleanupTasksForDoi(paperDoi)
      }

      // ═══ 1. 【乐观更新 + 持久化】必须 savePapers 成功才从 UI 移除 ═══
      // 先算好 updated，保存成功再 setPapers —— 防止 save 失败导致"删了又回来"
      const updated = prevPapers.filter((p) => p.id !== id)
      try {
        await savePapers(updated)
        invalidateCache('literatures/literatures.csv')
        setPapers(updated)
        toast.success('文献已删除（GitHub 文件清理在后台进行）')
      } catch (saveErr) {
        // savePapers 失败：不乐观更新，回滚 deletingIds，让用户看到失败
        console.warn('[handleDeletePaper] savePapers 失败:', saveErr)
        toast.error(`删除失败：无法保存 CSV — ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`, { duration: 5000 })
        setDeletingIds((prev) => { const s = new Set(prev); s.delete(id); return s })
        return  // 提前退出，不继续删 GitHub 文件（CSV 都没更新）
      }

      // ═══ 2. GitHub 文件删除（Phase 1 同步等完，Phase 2 后台跑） ═══
      if (ctx && paperDoi) {
        const result = await deleteLiteratureFilesFast(
          paperDoi, ctx.owner, ctx.repo, ctx.token,
        )
        if (!result.phase1Ok) {
          toast.warning(`GitHub 文件删除失败: ${result.error}，将在后台重试`, { duration: 6000 })
        } else if (result.deletedCount > 0) {
          console.log(`[handleDeletePaper] GitHub 文件已删 ${result.deletedCount} 个`)
        }
      }

      // ═══ 3. CSV 关联清理（放后台 fire-and-forget，失败不阻塞） ═══
      if (paperDoi) {
        cleanUpCsvByDoi(paperDoi).then((csvErrors) => {
          if (csvErrors.length > 0) {
            console.warn('[handleDeletePaper] CSV 后台清理有警告:', csvErrors)
          }
        }).catch((e) => console.warn('[handleDeletePaper] CSV 后台清理异常:', e))
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[handleDeletePaper] 主流程异常:', e)
      toast.error(`删除失败: ${msg}`, { duration: 5000 })
      // 主流程异常：恢复 papers（乐观更新已做的话）
      setPapers(prevPapers)
    } finally {
      // ═══ 无论成功失败，清除 deletingIds 标记 ═══
      setDeletingIds((prev) => { const s = new Set(prev); s.delete(id); return s })
    }
  }

  /** 跳转到阅读页并直接打开这篇文献 */
  const handleOpenReading = useCallback((paper: Paper) => {
    if (!paper.doi) {
      toast.error('这篇文献没有 DOI，无法阅读')
      return
    }
    navigate(`/reading?doc=paper:${encodeURIComponent(paper.doi)}`)
  }, [navigate])

  /** 重新触发 pipeline（复用私库里已上传的 PDF，不要求重新上传） */
  const handleReconvertPaper = useCallback(async (paper: Paper) => {
    if (!paper.doi) {
      toast.error('这篇文献没有 DOI，无法重新转换')
      return
    }
    if (!repo || !token || !owner) {
      toast.error('工作区未初始化，请先登录并完成 Onboarding')
      return
    }
    const slug = doiToSlug(paper.doi)

    // 关键：PDF 实际上传时带时间戳（如 1789678524767__pdf.pdf），
    // 不能硬编码 source/source.pdf，否则 runner GET 404 → all jobs failed。
    // 依次：内存任务队列记录 → 列举 source/ 目录 → 最后才退回默认名。
    let pdfPath = ''
    const remembered = useTaskQueueStore
      .getState()
      .tasks.filter((t) => t.doi === paper.doi && t.metadata?.pdf_github_path)
      .sort((a, b) => b.updated_at - a.updated_at)[0]?.metadata?.pdf_github_path as string | undefined
    if (remembered) pdfPath = remembered
    if (!pdfPath) {
      try {
        const res = await githubFetch(
          `/repos/${owner}/${repo.name}/contents/literatures/${slug}/source`,
          token,
        )
        if (res.ok) {
          const files = (await res.json()) as Array<{ name: string; path: string; type: string; size?: number }>
          const pdf = files
            .filter((f) => f.type === 'file' && /\.pdf$/i.test(f.name))
            .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0]
          if (pdf) pdfPath = pdf.path
        }
      } catch { /* 目录读不到就走兜底 */ }
    }
    if (!pdfPath) pdfPath = `literatures/${slug}/source/source.pdf`

    // 1. 先把 mdStatus 设成 converting
    setPapers((prev) => prev.map((p) => (p.id === paper.id ? { ...p, mdStatus: 'converting' as const, mdProgress: 0 } : p)))

    console.log('[handleReconvertPaper] step 1 done, registering taskQueue...')

    // 2. 注册进 taskQueue — 右侧后台监控面板立即可见任务
    const taskId = `paper_${slug}_${Date.now()}`
    const now = Date.now()
    try {
      await taskQueue.add_task({
        id: taskId,
        type: 'paper_convert',
        doi: paper.doi,
        book_id: undefined,
        title: paper.title,
        stage: 'queued',
        node_index: STAGE_META.queued.node,
        progress: 0,
        status: 'pending',
        message: '重新转换已注册，等待后端处理...',
        created_at: now,
        updated_at: now,
        error: undefined,
        metadata: {
          pdf_github_path: pdfPath,
          slug,
          source: 'reconvert',
        },
      })
      console.log('[handleReconvertPaper] taskQueue 已注册:', taskId, 'tasks=', taskQueue.tasks.length)
    } catch (err: any) {
      console.warn('[handleReconvert] taskQueue.add_task 失败:', err?.message)
    }

    console.log('[handleReconvertPaper] dispatching pipeline...')

    // 3. dispatch pipeline
    try {
      const beforeRun = await getLatestRun('paper_convert', owner as string, repo.name, token)
      const beforeCreatedAt = beforeRun?.created_at ?? new Date(Date.now() - 60_000).toISOString()

      await dispatchPaperConvert(paper.doi, paper.title || slug, pdfPath, owner as string, repo.name, token)
      console.log('[handleReconvertPaper] dispatch success')
      toast.success('已重新提交后端处理', { description: '右侧后台监控面板可查看实时进度' })

      // 异步捕获新 run id 存入 metadata（非阻塞），供轮询时 run 状态兜底
      void (async () => {
        try {
          let newRunId: number | null = null
          for (let i = 0; i < 15; i++) {
            await new Promise((r) => setTimeout(r, 1000))
            const rs = await getLatestRun('paper_convert', owner as string, repo.name, token, beforeCreatedAt)
            if (rs) { newRunId = rs.id; break }
          }
          if (newRunId) {
            await taskQueue.update_task(taskId, { metadata: { id: newRunId } })
            console.log('[handleReconvertPaper] run id 已记录:', newRunId)
          }
        } catch { /* 不阻塞 */ }
      })()
    } catch (err: any) {
      // dispatch 失败 → 标记 taskQueue 任务为 failed
      try {
        await taskQueue.update_task(taskId, {
          status: 'failed',
          stage: 'failed',
          node_index: STAGE_META.failed.node,
          message: `触发后端失败：${err?.message || String(err)}`,
          error: err?.message || String(err),
        })
      } catch {}
      setPapers((prev) => prev.map((p) => (p.id === paper.id ? { ...p, mdStatus: 'failed' as const } : p)))
      toast.error(`触发后端失败：${err?.message || String(err)}`)
    }
  }, [repo, token, owner, taskQueue])

  const handleEditPaper = (paper: Paper) => {
    setEditingPaper({ ...paper })
    setShowEditPaperModal(true)
  }

  const handleSavePaper = async () => {
    if (!editingPaper) return
    const prevPapers = papers
    const updated = papers.map((p) => (p.id === editingPaper.id ? editingPaper : p))
    setPapers(updated)
    try {
      await savePapers(updated)
      setShowEditPaperModal(false)
      setEditingPaper(null)
      toast.success('修改已保存')
    } catch (err) {
      setPapers(prevPapers)
      toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`, { duration: 5000 })
    }
  }

  const handleBatchDelete = async () => {
    const papersToDelete = papers.filter((p) => selectedPapers.has(p.id))
    if (papersToDelete.length === 0) return
    const ctx = getRepoContextForDelete()
    const prevPapers = papers

    // ═══ 防重复点击 + 标记所有要删的 ═══
    const idsToDelete = papersToDelete.map((p) => p.id).filter((id) => !deletingIds.has(id))
    if (idsToDelete.length === 0) return
    setDeletingIds((prev) => { const s = new Set(prev); idsToDelete.forEach((id) => s.add(id)); return s })

    try {
      // ═══ 0. 先清 taskQueue（同步） ═══
      for (const paper of papersToDelete) {
        if (paper.doi) await cleanupTasksForDoi(paper.doi)
      }

      // ═══ 1. 【乐观更新 + 持久化】必须 savePapers 成功才从 UI 移除 ═══
      const updated = prevPapers.filter((p) => !selectedPapers.has(p.id))
      try {
        await savePapers(updated)
        invalidateCache('literatures/literatures.csv')
        setPapers(updated)
        setSelectedPapers(new Set())
        setBatchMode(false)
        toast.success(`已删除 ${papersToDelete.length} 篇文献（GitHub 清理在后台进行）`)
      } catch (e) {
        // savePapers 失败：不乐观更新
        toast.error(`批量删除失败：无法保存 CSV — ${e instanceof Error ? e.message : String(e)}`, { duration: 5000 })
        setDeletingIds((prev) => { const s = new Set(prev); idsToDelete.forEach((id) => s.delete(id)); return s })
        return
      }

      // ═══ 2. GitHub 文件删除（Phase 1 同步 + Phase 2 后台 race cleanup） ═══
      if (ctx) {
        try {
          const allPaths: string[] = []
          for (const paper of papersToDelete) {
            try { const paths = await collectLiteratureFilePaths(paper.doi); allPaths.push(...paths) } catch {}
          }
          if (allPaths.length > 0) {
            await deleteRepoFiles(allPaths, `chore: batch delete ${papersToDelete.length} literatures`, ctx.owner, ctx.repo, ctx.token)
            console.log(`[handleBatchDelete] phase1 删除 ${allPaths.length} 个文件`)
          }
        } catch (e) {
          console.warn('[handleBatchDelete] phase1 失败:', e)
          toast.warning(`GitHub 文件清理失败: ${e instanceof Error ? e.message : String(e)}`)
        }

        // Phase 2: 5s 后批量检查残留 + retry（fire-and-forget）
        setTimeout(async () => {
          try {
            const retryPaths: string[] = []
            for (const paper of papersToDelete) {
              try { const paths = await collectLiteratureFilePaths(paper.doi); retryPaths.push(...paths) } catch {}
            }
            if (retryPaths.length > 0) {
              console.log(`[handleBatchDelete] phase2 残留 ${retryPaths.length} 个，异步重试`)
              await deleteRepoFiles(retryPaths, `chore: batch delete retry (race)`, ctx.owner, ctx.repo, ctx.token)
            }
          } catch (e) { console.warn('[handleBatchDelete] phase2 失败:', e) }
        }, 5000)
      }

      // ═══ 3. CSV 关联清理（fire-and-forget） ═══
      for (const paper of papersToDelete) {
        if (paper.doi) {
          cleanUpCsvByDoi(paper.doi).catch((e) => console.warn('[handleBatchDelete] CSV 清理失败:', paper.doi, e))
        }
      }
    } catch (e) {
      console.error('[handleBatchDelete] 主流程异常:', e)
      toast.error(`批量删除失败: ${e instanceof Error ? e.message : String(e)}`, { duration: 5000 })
      setPapers(prevPapers)
    } finally {
      setDeletingIds((prev) => { const s = new Set(prev); idsToDelete.forEach((id) => s.delete(id)); return s })
    }
  }

  const toggleSelectPaper = (id: string) => {
    const next = new Set(selectedPapers)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setSelectedPapers(next)
  }

  const toggleSelectAll = () => {
    if (selectedPapers.size === pagedPapers.length) {
      setSelectedPapers(new Set())
    } else {
      setSelectedPapers(new Set(pagedPapers.map((p) => p.id)))
    }
  }

  const handleBatchMove = () => {
    const updated = papers.map((p) => {
      if (selectedPapers.has(p.id)) {
        return { ...p, categoryIds: [...new Set([...p.categoryIds, ...batchMoveTargetIds])] }
      }
      return p
    })
    setPapers(updated)
    savePapers(updated)
    setSelectedPapers(new Set())
    setBatchMode(false)
    setShowBatchMoveModal(false)
    setBatchMoveTargetIds([])
  }

  // 文献分类管理
  const handleAddCategory = (parentId?: string) => {
    setEditingCategory({ name: '', parentId })
    setShowCategoryModal(true)
  }

  const handleEditCategory = (id: string, name: string, parentId?: string) => {
    setEditingCategory({ id, name, parentId })
    setShowCategoryModal(true)
  }

  const handleDeleteCategory = (id: string) => {
    const removeFromTree = (cats: PaperCategory[]): PaperCategory[] => {
      return cats
        .filter((c) => c.id !== id)
        .map((c) => ({
          ...c,
          children: c.children ? removeFromTree(c.children) : undefined,
        }))
    }
    const updatedCats = removeFromTree(paperCategories)
    const updatedPapers = papers.map((p) => ({ ...p, categoryIds: p.categoryIds.filter((cid) => cid !== id) }))
    setPaperCategories(updatedCats)
    setPapers(updatedPapers)
    // 分类与成员都在分类文件里，一次写清即可（不碰 literatures.csv）
    persistCategoryStore(updatedCats, updatedPapers)
    if (activePaperCategory === id) setActivePaperCategory('all')
  }

  const handleSaveCategory = () => {
    if (!editingCategory || !editingCategory.name.trim()) return
    let updatedCats: PaperCategory[]
    if (editingCategory.id) {
      const updateInTree = (cats: PaperCategory[]): PaperCategory[] => {
        return cats.map((c) => {
          if (c.id === editingCategory.id) {
            return { ...c, name: editingCategory.name }
          }
          return {
            ...c,
            children: c.children ? updateInTree(c.children) : undefined,
          }
        })
      }
      updatedCats = updateInTree(paperCategories)
      setPaperCategories(updatedCats)
    } else {
      const newCat: PaperCategory = {
        id: String(Date.now()),
        name: editingCategory.name,
      }
      if (editingCategory.parentId) {
        const addToTree = (cats: PaperCategory[]): PaperCategory[] => {
          return cats.map((c) => {
            if (c.id === editingCategory.parentId) {
              return { ...c, children: [...(c.children || []), newCat] }
            }
            return {
              ...c,
              children: c.children ? addToTree(c.children) : undefined,
            }
          })
        }
        updatedCats = addToTree(paperCategories)
        setPaperCategories(updatedCats)
        if (!expandedCategories.has(editingCategory.parentId)) {
          setExpandedCategories(new Set([...expandedCategories, editingCategory.parentId]))
        }
      } else {
        updatedCats = [...paperCategories, newCat]
        setPaperCategories(updatedCats)
      }
    }
    persistCategoryStore(updatedCats, papers)
    setEditingCategory(null)
    setShowCategoryModal(false)
  }

  // 期刊模板操作 —— 全部通过 journal-templates.ts 持久化到 GitHub 私库
  const handleAddTemplate = async () => {
    if (!newTemplate.name.trim()) return
    try {
      const backend = await createTemplate({
        name: newTemplate.name.trim(),
        issn: newTemplate.issn.trim() || undefined,
        publisher: newTemplate.publisher.trim() || undefined,
        guidelines_content: newTemplate.guidelines.trim() || undefined,
      })
      setTemplates((prev) => [...prev, toTemplateItem(backend)])
      setNewTemplate({ name: '', issn: '', publisher: '', guidelines: '' })
      setShowTemplateModal(false)
      toast.success(`期刊模板「${backend.name}」已创建并保存到 GitHub`)
    } catch (err) {
      toast.error(`创建模板失败: ${err instanceof Error ? err.message : String(err)}`)
      console.error('[handleAddTemplate]', err)
    }
  }

  /** AI 真正提取格式规范摘要（基于已有的投稿须知全文） */
  const handleExtractFormat = async () => {
    const guidelinesText = newTemplate.guidelines.trim()
    if (!guidelinesText) {
      toast.warning('请先粘贴或填写投稿须知内容，AI 才能帮你提取格式规范摘要')
      return
    }
    setIsExtracting(true)
    try {
      const { customAi1ApiKey, customAi1BaseUrl, ai1Model } = useSettingsStore.getState()
      if (!customAi1ApiKey || !customAi1BaseUrl || !ai1Model) {
        throw new Error('请先在设置页配置 AI-1 服务（API Key / Base URL / Model）')
      }

      const resp = await callAI({
        baseUrl: customAi1BaseUrl,
        apiKey: customAi1ApiKey,
        model: ai1Model,
        temperature: 0.2,
        maxTokens: 1024,
        messages: [
          {
            role: 'system',
            content: [
              '你是一名学术期刊投稿规范分析助手。用户会粘贴一份期刊的投稿须知原文。',
              '请从中提取出关键的格式规范要求，按以下结构输出：',
              '1. **标题**：标题格式、字数限制',
              '2. **摘要**：摘要字数、结构要求（是否结构化）',
              '3. **正文**：段落结构、字数限制、层级编号',
              '4. **图表**：图表标题、编号方式、位置',
              '5. **参考文献**：引用格式（APA/MLA/Vancouver 等）、参考文献样式',
              '6. **其他**：页码、行距、字号、边距等',
              '',
              '要求：用简洁的 bullet points 列出关键约束，不要重复原文。总长度控制在 300-500 字。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `【期刊名称】${newTemplate.name}\n\n【投稿须知】\n${guidelinesText}`,
          },
        ],
      })

      setNewTemplate((prev) => ({
        ...prev,
        guidelines: guidelinesText, // 保留用户粘贴的全文（AI 提取的摘要会显示在 toast 和 console）
      }))
      toast.success('AI 已提取格式规范摘要，可直接编辑调整')
      console.log('[handleExtractFormat] AI 提取结果:', resp.content)
    } catch (err) {
      toast.error(`AI 提取失败: ${err instanceof Error ? err.message : String(err)}`)
      console.error('[handleExtractFormat]', err)
    } finally {
      setIsExtracting(false)
    }
  }

  const handleSaveTemplate = async () => {
    if (!editingTemplate) return
    try {
      await updateTemplate(editingTemplate.id, {
        name: editingTemplate.name,
        issn: editingTemplate.issn || undefined,
        publisher: editingTemplate.publisher || undefined,
      })
      const backend = await getAllTemplates()
      setTemplates(backend.map(toTemplateItem))
      setShowTemplateModal(false)
      setEditingTemplate(null)
      toast.success('模板已更新并保存到 GitHub')
    } catch (err) {
      toast.error(`保存模板失败: ${err instanceof Error ? err.message : String(err)}`)
      console.error('[handleSaveTemplate]', err)
    }
  }

  const handleSetDefaultTemplate = async (id: string) => {
    try {
      await setDefaultTemplate(id)
      const backend = await getAllTemplates()
      setTemplates(backend.map(toTemplateItem))
      toast.success('已设为默认模板')
    } catch (err) {
      toast.error(`设置失败: ${err instanceof Error ? err.message : String(err)}`)
      console.error('[handleSetDefaultTemplate]', err)
    }
  }

  const handleDeleteTemplate = async (id: string) => {
    const tpl = templates.find((t) => t.id === id)
    const confirmed = window.confirm(`确定删除期刊模板「${tpl?.name ?? id}」吗？`)
    if (!confirmed) return
    try {
      await deleteJournalTemplate(id)
      const backend = await getAllTemplates()
      setTemplates(backend.map(toTemplateItem))
      toast.success('模板已删除')
    } catch (err) {
      toast.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`)
      console.error('[handleDeleteTemplate]', err)
    }
  }

  const handleApplyTemplate = (id: string) => {
    // 应用到项目 = 设为默认模板 + 提示用户去排版页面使用
    handleSetDefaultTemplate(id)
    toast.success('已设为默认模板，前往「排版」页面开始写作', {
      description: '模板的格式规范会自动应用到新文档',
      duration: 4000,
    })
  }

  // ============================================================
  // 后台化：所有 PDF 转换都走 taskQueue（fire-and-forget）
  // ============================================================

  /**
   * 上传某篇 paper 的 PDF 并立即触发后端转换。
   * 调用后立即 set mdStatus='converting' 让卡片 UI + 编辑模态框同步秒级反馈，
   * 然后等 taskQueue + 后端 progress.json 驱动后续进度。
   */
  const startPaperMineruConvert = async (paper: Paper, file: File) => {
    const paperDoi = paper.doi
    if (!paperDoi) {
      toast.error('这篇文献没有 DOI，无法上传转换')
      return
    }
    const prevProgress = paper.mdProgress

    // helper：同时更新全局 papers 数组 + 正在编辑的 editingPaper（如果是同一篇）
    const syncStatus = (patch: { mdStatus: Paper['mdStatus']; mdProgress: number }) => {
      setPapers((prev) => prev.map((p) =>
        p.id === paper.id ? { ...p, ...patch } : p,
      ))
      setEditingPaper((prev) =>
        prev && prev.id === paper.id ? { ...prev, ...patch } : prev,
      )
    }

    // 立即更新 UI：状态变 converting，进度从 0 开始
    syncStatus({ mdStatus: 'converting', mdProgress: 0 })

    try {
      const result = await enqueuePaperMineruConvert(paperDoi, file, paper.title)
      if (!result.ok) {
        // enqueue 失败：回滚 UI 状态为 failed
        syncStatus({ mdStatus: 'failed', mdProgress: prevProgress })
      }
    } catch (err) {
      // 异常：回滚 UI 状态为 failed
      syncStatus({ mdStatus: 'failed', mdProgress: prevProgress })
      toast.error(`上传异常：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleBookUpload = async (files: FileList | null) => {
    if (!files) return
    const fileArray = Array.from(files)

    const newBooks: BookItem[] = fileArray.map((f) => {
      // 书名即主键：textbooks/ 下的目录名与 textbook_id 都用书名（书基本不会重名），
      // 阅读页按书名定位 textbooks/{书名}/content.md
      const title = f.name.replace(/\.pdf$/i, '').trim()
      return {
        id: title,
        title,
        author: '未知',
        publisher: '未知',
        year: new Date().getFullYear(),
        addedAt: Date.now(),
        status: 'converting' as const,
        progress: 5,
        isSplit: false,
        volumes: undefined,
        categoryIds: uploadBookCategories,
      }
    })
    const updated = [...newBooks, ...books]
    setBooks(updated)
    await saveBooks(updated)

    // 分类成员单独落盘：textbooks/ 只存元数据，分类关系在 textbooks/categories.csv
    if (uploadBookCategories.length > 0) {
      let nextCats = bookCategories
      for (const b of newBooks) nextCats = setMemberCategories(nextCats, b.id, uploadBookCategories)
      setBookCategories(nextCats)
      try {
        await persistBookCategories(nextCats)
      } catch (err) {
        toast.error(`图书分类保存失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    setShowUploadBookModal(false)
    setUploadBookCategories([])

    // fire-and-forget: 每个文件上传 PDF + dispatch 后端 book_convert
    fileArray.forEach((file, i) => {
      void enqueueBookMineruConvert(newBooks[i].id, file, newBooks[i].title)
    })
  }

  const handleDeleteBook = async (id: string) => {
    const updated = books.filter((b) => b.id !== id)
    setBooks(updated)
    await saveBooks(updated)
    // 删书也要摘掉它在分类里的成员身份，否则 categories.csv 会留下幽灵
    if (bookCategories.some((c) => c.members.includes(id))) {
      const nextCats = setMemberCategories(bookCategories, id, [])
      setBookCategories(nextCats)
      try {
        await persistBookCategories(nextCats)
      } catch (err) {
        toast.error(`图书分类更新失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /** 图书分类落盘：伪分类 'all' 不入库（与文献分类保持一致） */
  const persistBookCategories = async (cats: Category[]) => {
    await saveBookCategories(cats.filter((c) => c.id !== 'all'))
  }

  /** 打开图书详情：顺带把已落盘的分类填进编辑态 */
  const openBookDetail = (book: BookItem) => {
    setBookDetailCategoryIds(categoriesOfMember(bookCategories, book.id))
    setShowBookDetail(book)
  }

  /** 图书详情弹窗里保存所属分类 */
  const handleSaveBookDetailCategories = async () => {
    if (!showBookDetail) return
    const nextCats = setMemberCategories(bookCategories, showBookDetail.id, bookDetailCategoryIds)
    setBookCategories(nextCats)
    setBooks((prev) => prev.map((b) => (b.id === showBookDetail.id ? { ...b, categoryIds: bookDetailCategoryIds } : b)))
    setShowBookDetail({ ...showBookDetail, categoryIds: bookDetailCategoryIds })
    try {
      await persistBookCategories(nextCats)
      toast.success('分类已保存')
    } catch (err) {
      toast.error(`分类保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 图书分类管理
  const handleAddBookCategory = () => {
    setEditingBookCategory({ name: '' })
    setShowBookCategoryModal(true)
  }

  const handleEditBookCategory = (id: string, name: string) => {
    setEditingBookCategory({ id, name })
    setShowBookCategoryModal(true)
  }

  const handleDeleteBookCategory = async (id: string) => {
    const updatedCats = bookCategories.filter((c) => c.id !== id)
    setBookCategories(updatedCats)
    setBooks((prev) => prev.map((b) => ({ ...b, categoryIds: b.categoryIds.filter((cid) => cid !== id) })))
    if (activeBookCategory === id) setActiveBookCategory('all')
    try {
      await persistBookCategories(updatedCats)
      toast.success('分类已删除')
    } catch (err) {
      toast.error(`删除分类失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleSaveBookCategory = async () => {
    if (!editingBookCategory || !editingBookCategory.name.trim()) return
    const editingId = editingBookCategory.id
    const name = editingBookCategory.name.trim()
    const updatedCats = editingId
      ? bookCategories.map((c) => (c.id === editingId ? { ...c, name } : c))
      : [...bookCategories, { id: String(Date.now()), name, members: [] }]
    setBookCategories(updatedCats)
    setEditingBookCategory(null)
    setShowBookCategoryModal(false)
    try {
      await persistBookCategories(updatedCats)
      toast.success(editingId ? '分类已更新' : '分类已添加')
    } catch (err) {
      toast.error(`保存分类失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── 其他文档 ──
  /** 重新拉列表：导入 / 编辑 / 删除后调用（写 CSV 已刷新缓存，不必 force） */
  const refreshDocuments = useCallback(async () => {
    try {
      setDocuments(await listDocuments())
    } catch (err) {
      console.error('刷新其他文档失败:', err)
    }
  }, [])

  /** 三种导入方式的公共出口：统一写仓库 → 提示 → 刷新 → 关弹窗 */
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
    } catch (err) {
      // zip 里可能几十个文件，失败原因（仓库未就绪 / 写冲突）要原样带出来
      toast.error(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setImporting(false)
    }
  }

  /** 上传本地 .md / .markdown / .txt */
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

  const handleEditDocument = (doc: DocumentSummary) => {
    setEditingDocument(doc)
    setEditDocForm({
      title: doc.title,
      author: doc.author,
      categoryIds: categoriesOfMember(documentCategories, doc.id),
    })
  }

  const handleSaveDocument = async () => {
    if (!editingDocument) return
    if (!editDocForm.title.trim()) {
      toast.error('标题不能为空')
      return
    }
    setSavingDocument(true)
    try {
      await updateDocumentEntry(editingDocument.id, {
        title: editDocForm.title.trim(),
        author: editDocForm.author.trim(),
      })
      const nextCats = setMemberCategories(documentCategories, editingDocument.id, editDocForm.categoryIds)
      await saveDocumentCategories(nextCats)
      setDocumentCategories(nextCats)
      toast.success('已保存')
      setEditingDocument(null)
      await refreshDocuments()
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSavingDocument(false)
    }
  }

  const handleDeleteDocument = async (doc: DocumentSummary) => {
    if (!confirm(`确定删除「${doc.title}」吗？会连同正文、笔记、批注一起删除，且不可恢复。`)) return
    try {
      await deleteDocuments([doc.id])
      // 顺带把它从文档分类里摘掉，避免留下幽灵成员
      if (documentCategories.some((c) => c.members.includes(doc.id))) {
        const nextCats = setMemberCategories(documentCategories, doc.id, [])
        await saveDocumentCategories(nextCats)
        setDocumentCategories(nextCats)
      }
      toast.success('已删除')
      await refreshDocuments()
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 跳转到阅读页并直接打开这份文档 */
  const handleOpenDocumentReading = (doc: DocumentSummary) => {
    navigate(`/reading?doc=document:${encodeURIComponent(doc.id)}`)
  }

  /** 跳转到阅读页并直接打开这本书 */
  const handleOpenBookReading = (book: BookItem) => {
    navigate(`/reading?doc=book:${encodeURIComponent(book.id)}`)
  }

  // 渲染文献分类树
  const renderCategoryTree = (cats: PaperCategory[], level = 0) => {
    return cats.map((cat) => {
      const hasChildren = cat.children && cat.children.length > 0
      const isExpanded = expandedCategories.has(cat.id)
      const isActive = activePaperCategory === cat.id
      const count = cat.id === 'all' ? paperCategoryCounts.all : (paperCategoryCounts[cat.id] || 0)

      return (
        <div key={cat.id}>
          <div
            className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer transition group ${
              isActive ? 'bg-seal-50 text-seal-700 font-medium' : 'text-ink-600 hover:bg-paper-100'
            }`}
            style={{ paddingLeft: `${level + 0.5}rem` }}
            onClick={() => {
              if (hasChildren) {
                toggleCategoryExpand(cat.id)
              }
              if (!hasChildren || cat.id === 'all') {
                setActivePaperCategory(cat.id)
                setLibraryPage(1)
              }
            }}
          >
            {hasChildren ? (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  toggleCategoryExpand(cat.id)
                }}
                className="p-0.5 -ml-0.5 text-ink-400 hover:text-ink-600"
              >
                {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
            ) : (
              <Folder className="w-3.5 h-3.5 text-ink-400" />
            )}
            <span className="text-sm flex-1 truncate">{cat.name}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${isActive ? 'bg-seal-100 text-seal-600' : 'bg-ink-100 text-ink-500'}`}>
              {count}
            </span>
            {cat.id !== 'all' && (
              <div className="hidden group-hover:flex items-center gap-0.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleEditCategory(cat.id, cat.name, hasChildren ? cat.id : undefined)
                  }}
                  className="p-0.5 text-ink-400 hover:text-seal-600 rounded"
                >
                  <Edit3 className="w-3 h-3" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirm(`确定删除分类「${cat.name}」吗？`)) {
                      handleDeleteCategory(cat.id)
                    }
                  }}
                  className="p-0.5 text-ink-400 hover:text-red-600 rounded"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>
          {hasChildren && isExpanded && (
            <div className="mt-0.5">
              {renderCategoryTree(cat.children!, level + 1)}
              {cat.id === 'my-categories' && (
                <button
                  onClick={() => handleAddCategory(cat.id)}
                  className="flex items-center gap-1 ml-4 mt-1 px-2 py-1 text-xs text-ink-400 hover:text-seal-600 rounded-md hover:bg-seal-50 transition"
                  style={{ marginLeft: `${level + 1.5}rem` }}
                >
                  <Plus className="w-3 h-3" />
                  添加子分类
                </button>
              )}
            </div>
          )}
        </div>
      )
    })
  }

  /**
   * 提交全文检索（搜索框里按 Enter / 点放大镜）。
   * 结果放独立弹窗：管理页本体的职责是"管理"，把结果面板塞进列表区会把两种语义搅在一起。
   */
  const runFullTextSearch = async (raw: string) => {
    const q = raw.trim()
    if (!q || ftLoading) return
    setFtQuery(q)
    setFtHits([])
    setFtOpen(true)
    setFtLoading(true)
    try {
      const hits = await searchLibrary(q, (done, total) => setFtProgress({ done, total }))
      setFtHits(hits)
    } catch (err) {
      toast.error(`全文检索失败：${err instanceof Error ? err.message : String(err)}`)
      setFtOpen(false)
    } finally {
      setFtLoading(false)
    }
  }

  /** 点结果：去阅读页，检索词交给阅读页做滚动定位 + 高亮 */
  const openHitInReader = (hit: SearchHit) => {
    setFtOpen(false)
    navigate(`/reading?doc=${hit.kind}:${encodeURIComponent(hit.id)}&q=${encodeURIComponent(ftQuery)}`)
  }

  /** 片段里的检索词包成 <mark>：split 带捕获组时，奇数位就是命中的词 */
  const renderHitSnippet = (text: string) => {
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

  return (
    <div className="page-container py-8 grid gap-6 items-start grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_clamp(18rem,24vw,26rem)]">
      {/* ──── 左侧主内容 ──── */}
      <div className="flex-1 min-w-0">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-ink-800 flex items-center gap-2">
            <FolderCog className="w-6 h-6 text-seal-600" />
            管理中心
          </h1>
          <p className="text-sm text-ink-500 mt-1">文献库、图书库、期刊模板、数据管理</p>
        </div>
      </div>

      {/* Tab 切换条 */}
      <div className="flex items-center gap-1 p-1 bg-ink-100 rounded-lg mb-5 w-fit">
        {subTabs.map((tab) => {
          const Icon = tab.icon
          const active = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition ${
                active
                  ? 'bg-paper-50 text-seal-600 shadow-sm'
                  : 'text-ink-500 hover:text-ink-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* ============ 文献库 Tab ============ */}
      {activeTab === 'library' && (
        <div className="flex gap-4">
          {/* 左侧分类树 */}
          <div className="w-64 flex-shrink-0">
            <div className="bg-paper-50 rounded-xl border border-ink-200 shadow-sm p-3">
              <div className="flex items-center justify-between mb-3 px-1">
                <h3 className="text-sm font-semibold text-ink-700 flex items-center gap-1.5">
                  <Library className="w-4 h-4 text-seal-600" />
                  文献分类
                </h3>
                <button
                  onClick={() => handleAddCategory()}
                  className="flex items-center gap-0.5 px-1.5 py-0.5 text-xs text-seal-600 hover:bg-seal-50 rounded transition"
                  title="新建分类"
                >
                  <Plus className="w-3.5 h-3.5" />
                  新建
                </button>
              </div>
              <div className="space-y-0.5">
                {renderCategoryTree(paperCategories)}
              </div>
              <button
                onClick={() => handleAddCategory()}
                className="mt-2 w-full flex items-center justify-center gap-1 py-1.5 text-xs text-ink-500 hover:text-seal-600 hover:bg-seal-50 rounded-lg transition"
                title="新建分类"
              >
                <Plus className="w-3.5 h-3.5" />
                新建分类
              </button>
            </div>
          </div>

          {/* 右侧文献列表 */}
          <div className="flex-1 space-y-4 min-w-0">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
                  <input
                    type="text"
                    placeholder="标题/作者/期刊/关键词…（Enter 全文检索）"
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value)
                      setLibraryPage(1)
                    }}
                    onKeyDown={(e) => {
                      // 输入法组词中的回车是"选词"，不是"提交"
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        runFullTextSearch(searchQuery)
                      }
                    }}
                    className="pl-9 pr-4 py-2 text-sm border border-ink-200 rounded-lg w-[clamp(12rem,22vw,20rem)] focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 bg-paper-50"
                  />
                </div>
                {/* 视图切换 */}
                <div className="flex items-center bg-ink-100 rounded-lg p-0.5">
                  <button
                    onClick={() => setViewMode('table')}
                    className={`p-1.5 rounded-md transition ${viewMode === 'table' ? 'bg-paper-50 text-seal-600 shadow-sm' : 'text-ink-400 hover:text-ink-600'}`}
                    title="表格视图"
                  >
                    <List className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setViewMode('card')}
                    className={`p-1.5 rounded-md transition ${viewMode === 'card' ? 'bg-paper-50 text-seal-600 shadow-sm' : 'text-ink-400 hover:text-ink-600'}`}
                    title="卡片视图"
                  >
                    <LayoutGrid className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {/* DOI 快捷添加 — inline 紧凑版，优先于批量/手动 */}
                <div className="flex items-center bg-paper-50 rounded-lg border border-ink-200 overflow-hidden focus-within:border-seal-400 focus-within:ring-2 focus-within:ring-seal-100">
                  <span className="pl-2.5 text-xs font-medium text-ink-400 whitespace-nowrap">DOI</span>
                  <input
                    type="text"
                    value={doiQuickInput}
                    onChange={(e) => setDoiQuickInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !isAddingByDoi && handleAddByDoi()}
                    placeholder="输入 DOI 或链接..."
                    className="w-56 px-2 py-1.5 text-sm bg-transparent focus:outline-none"
                    title="快捷 DOI 入库（Enter 触发）"
                  />
                  <button
                    onClick={handleAddByDoi}
                    disabled={isAddingByDoi || !doiQuickInput.trim()}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-paper-50 bg-seal-600 hover:bg-seal-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                    title="通过 DOI 快捷添加"
                  >
                    {isAddingByDoi ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5" />
                    )}
                    添加
                  </button>
                </div>

                {batchMode && (
                  <>
                    <button
                      onClick={() => setShowBatchMoveModal(true)}
                      disabled={selectedPapers.size === 0}
                      className="flex items-center gap-2 px-3 py-2 text-sm text-seal-600 bg-seal-50 border border-seal-200 hover:bg-seal-100 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <MoveRight className="w-4 h-4" />
                      移动分类 ({selectedPapers.size})
                    </button>
                    <button
                      onClick={handleBatchDelete}
                      disabled={selectedPapers.size === 0}
                      className="flex items-center gap-2 px-3 py-2 text-sm text-red-600 bg-red-50 border border-red-200 hover:bg-red-100 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Trash2 className="w-4 h-4" />
                      删除选中
                    </button>
                  </>
                )}
                <button
                  onClick={() => {
                    setBatchMode(!batchMode)
                    setSelectedPapers(new Set())
                  }}
                  className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg border transition ${
                    batchMode
                      ? 'text-seal-600 bg-seal-50 border-seal-200'
                      : 'text-ink-600 bg-paper-50 border-ink-200 hover:bg-paper-100'
                  }`}
                >
                  <CheckSquare className="w-4 h-4" />
                  {batchMode ? '取消批量' : '批量操作'}
                </button>
                <button
                  onClick={() => {
                    setNewPaper({ title: '', authors: '', year: '', journal: '', doi: '', keywords: '', tier: 'auto', categoryIds: activePaperCategory !== 'all' ? [activePaperCategory] : [] })
                    setShowAddPaperModal(true)
                  }}
                  className="flex items-center gap-2 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition shadow-md shadow-seal-200"
                >
                  <Plus className="w-4 h-4" />
                  手动添加文献
                </button>
              </div>
            </div>

            <div className="bg-paper-50 rounded-xl border border-ink-200 shadow-sm overflow-hidden">
              <div className="flex items-center gap-1 p-3 border-b border-ink-100 bg-paper-100/50">
                <button
                  onClick={() => {
                    setTierFilter('all')
                    setLibraryPage(1)
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition ${
                    tierFilter === 'all'
                      ? 'bg-paper-50 text-seal-600 shadow-sm border border-ink-200'
                      : 'text-ink-500 hover:text-ink-700'
                  }`}
                >
                  全部
                  <span className="text-xs px-1.5 py-0.5 bg-ink-200 text-ink-600 rounded-full">
                    {filteredPapers.length}
                  </span>
                </button>
                <button
                  onClick={() => {
                    setTierFilter(1)
                    setLibraryPage(1)
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition ${
                    tierFilter === 1
                      ? 'bg-paper-50 text-seal-600 shadow-sm border border-ink-200'
                      : 'text-ink-500 hover:text-ink-700'
                  }`}
                >
                  <span className="text-base">📄</span>
                  一级文献
                  <span className="text-xs px-1.5 py-0.5 bg-ink-200 text-ink-600 rounded-full">
                    {filteredPapers.filter((p) => p.tier === 1).length}
                  </span>
                </button>
                <button
                  onClick={() => {
                    setTierFilter(2)
                    setLibraryPage(1)
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition ${
                    tierFilter === 2
                      ? 'bg-paper-50 text-seal-600 shadow-sm border border-ink-200'
                      : 'text-ink-500 hover:text-ink-700'
                  }`}
                >
                  <span className="text-base">📖</span>
                  二级文献
                  <span className="text-xs px-1.5 py-0.5 bg-ink-200 text-ink-600 rounded-full">
                    {filteredPapers.filter((p) => p.tier === 2).length}
                  </span>
                </button>

                {/* PDF 筛选：一级 / 二级通用 */}
                <div className="ml-auto flex items-center gap-1 pl-3 border-l border-ink-200">
                  <span className="text-xs text-ink-400 px-1">PDF</span>
                  {([
                    { v: 'all', label: '全部' },
                    { v: 'has', label: '已导入' },
                    { v: 'missing', label: '未导入' },
                  ] as const).map((o) => {
                    const count = o.v === 'all'
                      ? basePapers.length
                      : o.v === 'has'
                        ? basePapers.filter((p) => p.hasPdf).length
                        : basePapers.filter((p) => !p.hasPdf).length
                    return (
                      <button
                        key={o.v}
                        onClick={() => {
                          setPdfFilter(o.v)
                          setLibraryPage(1)
                        }}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition ${
                          pdfFilter === o.v
                            ? 'bg-paper-50 text-seal-600 shadow-sm border border-ink-200'
                            : 'text-ink-500 hover:text-ink-700'
                        }`}
                      >
                        {o.label}
                        <span className="text-xs px-1.5 py-0.5 bg-ink-200 text-ink-600 rounded-full">
                          {count}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* 表格视图 */}
              {viewMode === 'table' && (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-paper-100">
                      <tr>
                        {batchMode && (
                          <th className="text-left px-4 py-3 w-10">
                            <input
                              type="checkbox"
                              checked={selectedPapers.size === pagedPapers.length && pagedPapers.length > 0}
                              onChange={toggleSelectAll}
                              className="w-4 h-4 rounded border-ink-300 text-seal-600 focus:ring-seal-500"
                            />
                          </th>
                        )}
                        <th className="text-left px-4 py-3 text-xs font-semibold text-ink-500 uppercase tracking-wider">题图</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-ink-500 uppercase tracking-wider">标题</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-ink-500 uppercase tracking-wider">作者</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-ink-500 uppercase tracking-wider">年份</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-ink-500 uppercase tracking-wider">期刊</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-ink-500 uppercase tracking-wider">关键词</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-ink-500 uppercase tracking-wider">DOI 链接</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-ink-500 uppercase tracking-wider">分类</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-ink-500 uppercase tracking-wider">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-100">
                      {pagedPapers.map((paper) => (
                        <tr key={paper.id} className="hover:bg-paper-100/70 transition">
                          {batchMode && (
                            <td className="px-4 py-3">
                              <input
                                type="checkbox"
                                checked={selectedPapers.has(paper.id)}
                                onChange={() => toggleSelectPaper(paper.id)}
                                className="w-4 h-4 rounded border-ink-300 text-seal-600 focus:ring-seal-500"
                              />
                            </td>
                          )}
                          <td className="px-4 py-3">
                            <div
                              className={`w-12 h-12 rounded-lg overflow-hidden bg-ink-100 flex-shrink-0 ${paper.coverImage ? 'cursor-pointer hover:opacity-80 transition' : ''}`}
                              onClick={() => paper.coverImage && setShowImageLightbox(paper.coverImage)}
                            >
                              {paper.coverImage ? (
                                <img src={paper.coverImage} alt="" className="w-full h-full object-cover" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-ink-300">
                                  {paper.tier === 2 ? <Book className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <span className="text-sm">{paper.tier === 2 ? '📖' : '📄'}</span>
                              <div className="text-sm font-medium text-ink-800 line-clamp-2 max-w-xs">{paper.title}</div>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-sm text-ink-600 max-w-[7.5rem] truncate">{paper.authors}</td>
                          <td className="px-4 py-3 text-sm text-ink-600">{paper.year}</td>
                          <td className="px-4 py-3 text-sm text-ink-600 max-w-[8.75rem] truncate">{paper.journal}</td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1 max-w-[11.25rem]">
                              {paper.keywords.slice(0, 2).map((kw) => (
                                <span key={kw} className="px-2 py-0.5 bg-seal-50 text-seal-600 text-xs rounded-full">
                                  {kw}
                                </span>
                              ))}
                              {paper.keywords.length > 2 && (
                                <span className="px-2 py-0.5 bg-ink-100 text-ink-500 text-xs rounded-full">
                                  +{paper.keywords.length - 2}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <DoiLink doi={paper.doi} className="text-xs max-w-[8.75rem] truncate block" />
                          </td>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => handleEditPaper(paper)}
                              className="flex flex-wrap gap-1 max-w-[11rem] text-left hover:opacity-80 transition"
                              title="点击修改所属分类（可多选）"
                            >
                              {paper.categoryIds.length > 0 ? (
                                paper.categoryIds.map((cid) => {
                                  const cat = getAllLeafCategories.find((c) => c.id === cid)
                                  return cat ? (
                                    <span key={cid} className="px-1.5 py-0.5 bg-amber-50 text-amber-600 text-xs rounded whitespace-nowrap">
                                      <Tag className="w-3 h-3 inline mr-0.5" />
                                      {cat.name}
                                    </span>
                                  ) : null
                                })
                              ) : (
                                <span className="text-xs text-ink-400">未分类</span>
                              )}
                            </button>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-end gap-1">
                              {/* Upload PDF 按钮：仅在未转换/转换失败时显示 */}
                              {paper.doi && (paper.mdStatus === 'none' || paper.mdStatus === 'failed') && (
                                <label
                                  className="p-1.5 rounded-md transition cursor-pointer text-seal-500 hover:text-seal-600 hover:bg-seal-50"
                                  title="上传 PDF 开始转换"
                                >
                                  <Upload className="w-4 h-4" />
                                  <input
                                    type="file"
                                    accept=".pdf"
                                    className="hidden"
                                    onChange={(e) => {
                                      const file = e.target.files?.[0]
                                      if (file) void startPaperMineruConvert(paper, file)
                                      e.target.value = ''
                                    }}
                                  />
                                </label>
                              )}
                              <button
                                disabled={paper.mdStatus === 'converting'}
                                onClick={() => handleOpenReading(paper)}
                                className={`p-1.5 rounded-md transition ${
                                  paper.mdStatus === 'converting'
                                    ? 'text-ink-300 cursor-not-allowed'
                                    : 'text-ink-400 hover:text-seal-600 hover:bg-seal-50'
                                }`}
                                title={paper.mdStatus === 'converting' ? '转换中，暂时无法阅读' : '阅读'}
                              >
                                <Eye className="w-4 h-4" />
                              </button>
                              <button
                                disabled={paper.mdStatus === 'converting' || !paper.doi}
                                onClick={() => handleReconvertPaper(paper)}
                                className={`p-1.5 rounded-md transition ${
                                  paper.mdStatus === 'converting' || !paper.doi
                                    ? 'text-ink-300 cursor-not-allowed'
                                    : 'text-ink-400 hover:text-amber-600 hover:bg-amber-50'
                                }`}
                                title={!paper.doi ? '无 DOI 无法转换' : paper.mdStatus === 'converting' ? '正在转换' : '重新转换'}
                              >
                                <RefreshCw className={`w-4 h-4 ${paper.mdStatus === 'converting' ? 'animate-spin' : ''}`} />
                              </button>
                              <button
                                onClick={() => handleEditPaper(paper)}
                                className="p-1.5 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded-md transition"
                                title="编辑"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                              <button
                                disabled={deletingIds.has(paper.id)}
                                onClick={() => handleDeletePaper(paper.id)}
                                className={`p-1.5 rounded-md transition ${
                                  deletingIds.has(paper.id)
                                    ? 'text-red-500 bg-red-50 cursor-not-allowed'
                                    : 'text-ink-400 hover:text-red-600 hover:bg-red-50'
                                }`}
                                title={deletingIds.has(paper.id) ? '删除中...' : '删除'}
                              >
                                {deletingIds.has(paper.id) ? (
                                  <span className="inline-flex items-center gap-0.5">
                                    <span className="w-1 h-1 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                    <span className="w-1 h-1 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                    <span className="w-1 h-1 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                  </span>
                                ) : (
                                  <Trash2 className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {pagedPapers.length === 0 && (
                        <tr>
                          <td colSpan={batchMode ? 10 : 9} className="px-4 py-16 text-center">
                            <div className="text-ink-400 mb-3">
                              <FileText className="w-12 h-12 mx-auto mb-2 opacity-50" />
                              <p className="text-sm">暂无文献数据</p>
                            </div>
                            <button
                              onClick={() => {
                                setNewPaper({ title: '', authors: '', year: '', journal: '', doi: '', keywords: '', tier: 'auto', categoryIds: activePaperCategory !== 'all' ? [activePaperCategory] : [] })
                                setShowAddPaperModal(true)
                              }}
                              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition"
                            >
                              <Plus className="w-4 h-4" />
                              添加第一篇文献
                            </button>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 卡片视图 */}
              {viewMode === 'card' && (
                <div className="p-4">
                  {pagedPapers.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {pagedPapers.map((paper) => (
                        <div
                          key={paper.id}
                          className={`bg-paper-50 border rounded-xl overflow-hidden hover:shadow-md transition group ${
                            batchMode ? 'cursor-pointer' : ''
                          } ${selectedPapers.has(paper.id) ? 'border-seal-400 ring-2 ring-seal-100' : 'border-ink-200'}`}
                          onClick={() => batchMode && toggleSelectPaper(paper.id)}
                        >
                          <div className="relative h-32 bg-ink-100 overflow-hidden">
                            {paper.coverImage ? (
                              <img src={paper.coverImage} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-ink-300">
                                {paper.tier === 2 ? <Book className="w-12 h-12" /> : <FileText className="w-12 h-12" />}
                              </div>
                            )}
                            {batchMode && (
                              <div className="absolute top-2 left-2">
                                <input
                                  type="checkbox"
                                  checked={selectedPapers.has(paper.id)}
                                  onChange={(e) => {
                                    e.stopPropagation()
                                    toggleSelectPaper(paper.id)
                                  }}
                                  className="w-4 h-4 rounded border-ink-300 text-seal-600 focus:ring-seal-500"
                                />
                              </div>
                            )}
                            <div className="absolute top-2 right-2">
                              <span className="text-lg">{paper.tier === 2 ? '📖' : '📄'}</span>
                            </div>
                          </div>
                          <div className="p-3">
                            <h3 className="font-medium text-ink-800 text-sm line-clamp-2 mb-1.5 min-h-[2.5rem]">{paper.title}</h3>
                            <p className="text-xs text-ink-500 line-clamp-1 mb-1">{paper.authors}</p>
                            <p className="text-xs text-ink-400 line-clamp-1 mb-2">{paper.journal} · {paper.year}</p>
                            <div className="flex flex-wrap gap-1 mb-2">
                              {paper.keywords.slice(0, 2).map((kw) => (
                                <span key={kw} className="px-1.5 py-0.5 bg-seal-50 text-seal-600 text-xs rounded">
                                  {kw}
                                </span>
                              ))}
                              {paper.keywords.length > 2 && (
                                <span className="px-1.5 py-0.5 bg-ink-100 text-ink-500 text-xs rounded">
                                  +{paper.keywords.length - 2}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center justify-between pt-2 border-t border-ink-100">
                              <StatusBadge status={paper.mdStatus} />
                              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition">
                                {/* Upload PDF 按钮：仅在未转换/转换失败时显示 */}
                                {paper.doi && (paper.mdStatus === 'none' || paper.mdStatus === 'failed') && (
                                  <label
                                    className="p-1 rounded transition cursor-pointer text-seal-500 hover:text-seal-600 hover:bg-seal-50"
                                    title="上传 PDF 开始转换"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <Upload className="w-3.5 h-3.5" />
                                    <input
                                      type="file"
                                      accept=".pdf"
                                      className="hidden"
                                      onChange={(e) => {
                                        const file = e.target.files?.[0]
                                        if (file) void startPaperMineruConvert(paper, file)
                                        e.target.value = ''
                                      }}
                                    />
                                  </label>
                                )}
                                <button
                                  disabled={paper.mdStatus === 'converting' || !paper.doi}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleOpenReading(paper)
                                  }}
                                  className={`p-1 rounded transition ${
                                    paper.mdStatus === 'converting' || !paper.doi
                                      ? 'text-ink-300 cursor-not-allowed'
                                      : 'text-ink-400 hover:text-seal-600 hover:bg-seal-50'
                                  }`}
                                  title={!paper.doi ? '无 DOI 无法阅读' : paper.mdStatus === 'converting' ? '转换中，暂时无法阅读' : '阅读'}
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  disabled={paper.mdStatus === 'converting' || !paper.doi}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleReconvertPaper(paper)
                                  }}
                                  className={`p-1 rounded transition ${
                                    paper.mdStatus === 'converting' || !paper.doi
                                      ? 'text-ink-300 cursor-not-allowed'
                                      : 'text-ink-400 hover:text-amber-600 hover:bg-amber-50'
                                  }`}
                                  title={!paper.doi ? '无 DOI 无法转换' : paper.mdStatus === 'converting' ? '正在转换' : '重新转换'}
                                >
                                  <RefreshCw className={`w-3.5 h-3.5 ${paper.mdStatus === 'converting' ? 'animate-spin' : ''}`} />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleEditPaper(paper)
                                  }}
                                  className="p-1 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded transition"
                                  title="编辑"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  disabled={deletingIds.has(paper.id)}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleDeletePaper(paper.id)
                                  }}
                                  className={`p-1 rounded transition ${
                                    deletingIds.has(paper.id)
                                      ? 'text-red-500 bg-red-50 cursor-not-allowed'
                                      : 'text-ink-400 hover:text-red-600 hover:bg-red-50'
                                  }`}
                                  title={deletingIds.has(paper.id) ? '删除中...' : '删除'}
                                >
                                  {deletingIds.has(paper.id) ? (
                                    <span className="inline-flex items-center gap-0.5">
                                      <span className="w-1 h-1 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                      <span className="w-1 h-1 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                      <span className="w-1 h-1 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                    </span>
                                  ) : (
                                    <Trash2 className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-16 text-center">
                      <div className="text-ink-400 mb-3">
                        <LayoutGrid className="w-12 h-12 mx-auto mb-2 opacity-50" />
                        <p className="text-sm">暂无文献数据</p>
                      </div>
                      <button
                        onClick={() => {
                          setNewPaper({ title: '', authors: '', year: '', journal: '', doi: '', keywords: '', tier: 'auto', categoryIds: activePaperCategory !== 'all' ? [activePaperCategory] : [] })
                          setShowAddPaperModal(true)
                        }}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition"
                      >
                        <Plus className="w-4 h-4" />
                        添加第一篇文献
                      </button>
                    </div>
                  )}
                </div>
              )}

              {totalPages > 0 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-ink-100 bg-paper-100/50">
                  <div className="text-sm text-ink-500">
                    共 {filteredPapers.length} 条，第 {libraryPage} / {totalPages} 页
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setLibraryPage(Math.max(1, libraryPage - 1))}
                      disabled={libraryPage === 1}
                      className="p-1.5 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded-md transition disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                      <button
                        key={p}
                        onClick={() => setLibraryPage(p)}
                        className={`w-8 h-8 text-sm rounded-md transition ${
                          libraryPage === p
                            ? 'bg-seal-600 text-paper-50'
                            : 'text-ink-500 hover:bg-ink-100 hover:text-ink-700'
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                    <button
                      onClick={() => setLibraryPage(Math.min(totalPages, libraryPage + 1))}
                      disabled={libraryPage === totalPages}
                      className="p-1.5 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded-md transition disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ============ 期刊模板 Tab ============ */}
      {activeTab === 'templates' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-ink-500">管理期刊投稿模板，支持 AI 提取格式规范，用于提示和规范提取格式</p>
            <button
              onClick={() => {
                setEditingTemplate(null)
                setNewTemplate({ name: '', issn: '', publisher: '', guidelines: '' })
                setShowTemplateModal(true)
              }}
              className="flex items-center gap-2 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition shadow-md shadow-seal-200"
            >
              <Plus className="w-4 h-4" />
              新建模板
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {templates.map((tpl) => (
              <div
                key={tpl.id}
                className={`bg-paper-50 rounded-xl border shadow-sm hover:shadow-md transition overflow-hidden ${
                  tpl.isDefault ? 'border-seal-300 ring-1 ring-seal-100' : 'border-ink-200'
                }`}
              >
                <div className="p-5">
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="p-2 bg-seal-50 rounded-lg">
                      <BookOpen className="w-6 h-6 text-seal-600" />
                    </div>
                    {tpl.isDefault && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 text-amber-600 text-xs font-medium rounded-full">
                        <Star className="w-3 h-3 fill-current" />
                        默认
                      </span>
                    )}
                  </div>
                  <h3 className="font-semibold text-ink-800 mb-1">{tpl.name}</h3>
                  <p className="text-sm text-ink-500 mb-1">{tpl.publisher} · ISSN: {tpl.issn || '-'}</p>
                  <p className="text-xs text-ink-400 mb-3">最后更新：{tpl.lastUpdated}</p>
                  <div className="p-3 bg-paper-100 rounded-lg border border-ink-100">
                    <p className="text-xs text-ink-600 leading-relaxed line-clamp-3">{tpl.formatSummary}</p>
                  </div>
                </div>
                <div className="px-5 py-3 bg-paper-100 border-t border-ink-100 flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        setEditingTemplate({ ...tpl })
                        setNewTemplate({ name: tpl.name, issn: tpl.issn, publisher: tpl.publisher, guidelines: tpl.formatSummary })
                        setShowTemplateModal(true)
                      }}
                      className="p-1.5 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded-md transition"
                      title="编辑"
                    >
                      <Edit3 className="w-4 h-4" />
                    </button>
                    {!tpl.isDefault && (
                      <button
                        onClick={() => handleSetDefaultTemplate(tpl.id)}
                        className="p-1.5 text-ink-400 hover:text-amber-500 hover:bg-amber-50 rounded-md transition"
                        title="设为默认"
                      >
                        <Star className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => handleDeleteTemplate(tpl.id)}
                      className="p-1.5 text-ink-400 hover:text-red-600 hover:bg-red-50 rounded-md transition"
                      title="删除"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <button
                    onClick={() => handleApplyTemplate(tpl.id)}
                    className="text-xs text-seal-600 hover:text-seal-700 font-medium flex items-center gap-1"
                  >
                    应用到项目
                    <ExternalLink className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
          {templates.length === 0 && (
            <div className="bg-paper-50 rounded-xl border border-ink-200 shadow-sm p-12 text-center">
              <div className="text-ink-400 mb-3">
                <BookOpen className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p className="text-sm">暂无期刊模板</p>
                <p className="text-xs mt-1">创建期刊模板，用于规范投稿格式</p>
              </div>
              <button
                onClick={() => {
                  setEditingTemplate(null)
                  setNewTemplate({ name: '', issn: '', publisher: '', guidelines: '' })
                  setShowTemplateModal(true)
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition"
              >
                <Plus className="w-4 h-4" />
                创建第一个模板
              </button>
            </div>
          )}
        </div>
      )}

      {/* ============ 知识库 Tab ============ */}
      {activeTab === 'knowledge' && (
        <div className="flex gap-4">
          {/* 左侧分类树 */}
          <div className="w-64 flex-shrink-0">
            <div className="bg-paper-50 rounded-xl border border-ink-200 shadow-sm p-3">
              <div className="flex items-center justify-between mb-3 px-1">
                <h3 className="text-sm font-semibold text-ink-700 flex items-center gap-1.5">
                  <BookCopy className="w-4 h-4 text-seal-600" />
                  图书分类
                </h3>
                <button
                  onClick={handleAddBookCategory}
                  className="p-1 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded-md transition"
                  title="添加分类"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
              <div className="space-y-0.5">
                {bookCategories.map((cat) => {
                  const isActive = activeBookCategory === cat.id
                  const count = bookCategoryCounts[cat.id] || 0
                  return (
                    <div
                      key={cat.id}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition group ${
                        isActive ? 'bg-seal-50 text-seal-700 font-medium' : 'text-ink-600 hover:bg-paper-100'
                      }`}
                      onClick={() => setActiveBookCategory(cat.id)}
                    >
                      <Folder className="w-3.5 h-3.5 text-ink-400" />
                      <span className="text-sm flex-1 truncate">{cat.name}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded-full ${isActive ? 'bg-seal-100 text-seal-600' : 'bg-ink-100 text-ink-500'}`}>
                        {count}
                      </span>
                      {cat.id !== 'all' && (
                        <div className="hidden group-hover:flex items-center gap-0.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleEditBookCategory(cat.id, cat.name)
                            }}
                            className="p-0.5 text-ink-400 hover:text-seal-600 rounded"
                          >
                            <Edit3 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              if (confirm(`确定删除分类「${cat.name}」吗？`)) {
                                handleDeleteBookCategory(cat.id)
                              }
                            }}
                            className="p-0.5 text-ink-400 hover:text-red-600 rounded"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* 右侧图书列表 */}
          <div className="flex-1 space-y-4 min-w-0">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-ink-500">
                  图书库存储图书，PDF 上传后自动转换为 Markdown。超过200页按180页切分，多卷管理。
                </p>
              </div>
              <button
                onClick={() => {
                  setUploadBookCategories(activeBookCategory !== 'all' ? [activeBookCategory] : [])
                  setShowUploadBookModal(true)
                }}
                className="flex items-center gap-2 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition shadow-md shadow-seal-200"
              >
                <Upload className="w-4 h-4" />
                上传图书
              </button>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault()
                setIsDragOverBook(true)
              }}
              onDragLeave={() => setIsDragOverBook(false)}
              onDrop={(e) => {
                e.preventDefault()
                setIsDragOverBook(false)
                handleBookUpload(e.dataTransfer.files)
              }}
              className={`border-2 border-dashed rounded-xl p-6 text-center transition ${
                isDragOverBook
                  ? 'border-seal-400 bg-seal-50/50'
                  : 'border-ink-200 bg-paper-50 hover:border-seal-200 hover:bg-seal-50/30'
              }`}
            >
              <p className="text-sm text-ink-500">
                拖拽 PDF 图书到此处上传，自动转换为 Markdown。<span className="text-seal-600 font-medium">超过200页自动按180页切分</span>
              </p>
            </div>

            {filteredBooks.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                {filteredBooks.map((book) => (
                  <div
                    key={book.id}
                    className="bg-paper-50 rounded-xl border border-ink-200 shadow-sm hover:shadow-md transition overflow-hidden group cursor-pointer"
                    onClick={() => openBookDetail(book)}
                  >
                    <div className="aspect-[3/4] bg-ink-100 relative overflow-hidden">
                      {book.coverImage ? (
                        <img src={book.coverImage} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-ink-300">
                          <Book className="w-12 h-12" />
                        </div>
                      )}
                      <div className="absolute top-2 right-2">
                        <BookStatusBadge status={book.status} />
                      </div>
                      {book.isSplit && book.status === 'done' && (
                        <div className="absolute top-2 left-2">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-seal-100 text-seal-700 text-xs font-medium rounded-full">
                            <Layers className="w-3 h-3" />
                            共{book.volumes?.length || 0}卷
                          </span>
                        </div>
                      )}
                      {(book.status === 'converting' || book.status === 'uploading') && (
                        <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-ink-900/50 backdrop-blur-sm">
                          <div className="h-1 bg-paper-50/30 rounded-full overflow-hidden mb-1">
                            <div
                              className="h-full bg-paper-50 rounded-full transition-all"
                              style={{ width: `${book.progress}%` }}
                            />
                          </div>
                          <p className="text-xs text-paper-50 text-right">{book.progress}%</p>
                        </div>
                      )}
                    </div>
                    <div className="p-3">
                      <h3 className="font-medium text-ink-800 text-sm line-clamp-1 mb-0.5">{book.title}</h3>
                      <p className="text-xs text-ink-500 line-clamp-1 mb-1">{book.author}</p>
                      <p className="text-xs text-ink-400 line-clamp-1">
                        {[book.publisher, book.year ? `${book.year} 年` : ''].filter(Boolean).join(' · ')}
                      </p>
                      {book.categoryIds.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {book.categoryIds.slice(0, 2).map((cid) => {
                            const cat = bookCategories.find((c) => c.id === cid)
                            return cat ? (
                              <span key={cid} className="px-1.5 py-0.5 bg-amber-50 text-amber-600 text-xs rounded">
                                {cat.name}
                              </span>
                            ) : null
                          })}
                        </div>
                      )}
                    </div>
                    <div className="px-3 py-2 bg-paper-100 border-t border-ink-100 flex items-center justify-between" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleOpenBookReading(book)}
                          className="p-1.5 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded-md transition"
                          title="阅读"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        {(book.status === 'converting' || book.status === 'uploading') && (
                          <button
                            onClick={() => openBookDetail(book)}
                            className="p-1.5 text-ink-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition"
                            title="查看转换进度"
                          >
                            <Loader2 className="w-4 h-4 animate-spin" />
                          </button>
                        )}
                      </div>
                      <button
                        onClick={() => handleDeleteBook(book.id)}
                        className="p-1.5 text-ink-400 hover:text-red-600 hover:bg-red-50 rounded-md transition"
                        title="删除"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-paper-50 rounded-xl border border-ink-200 shadow-sm p-12 text-center">
                <div className="text-ink-400 mb-3">
                  <BookCopy className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">暂无图书数据</p>
                  <p className="text-xs mt-1">上传 PDF 图书，自动转换为 Markdown</p>
                </div>
                <button
                  onClick={() => {
                    setUploadBookCategories(activeBookCategory !== 'all' ? [activeBookCategory] : [])
                    setShowUploadBookModal(true)
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition"
                >
                  <Upload className="w-4 h-4" />
                  上传第一本图书
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ============ 其他文档 Tab ============ */}
      {activeTab === 'documents' && (
        <div className="space-y-4">
          <div className="flex items-start justify-between flex-wrap gap-3">
            <div>
              <h3 className="text-base font-semibold text-ink-800 flex items-center gap-1.5">
                <FileText className="w-4 h-4 text-seal-600" />
                其他文档
              </h3>
              <p className="text-sm text-ink-500 mt-0.5">
                导入自己的 markdown（.md 文件 / 粘贴文本 / zip），直接阅读，不经过转换
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
                <input
                  type="text"
                  placeholder="标题、作者…（Enter 全文检索）"
                  value={documentSearch}
                  onChange={(e) => setDocumentSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      runFullTextSearch(documentSearch)
                    }
                  }}
                  className="pl-9 pr-4 py-2 text-sm border border-ink-200 rounded-lg w-[clamp(11rem,20vw,18rem)] focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 bg-paper-50"
                />
              </div>
              <button
                onClick={() => setShowImportDocModal(true)}
                className="flex items-center gap-2 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition shadow-md shadow-seal-200"
              >
                <Upload className="w-4 h-4" />
                导入文档
              </button>
            </div>
          </div>

          {documentsLoading ? (
            <div className="bg-paper-50 rounded-xl border border-ink-200 shadow-sm p-12 text-center text-ink-400 text-sm">
              <div className="w-8 h-8 border-2 border-ink-200 border-t-seal-500 rounded-full animate-spin mx-auto mb-2" />
              <p>加载中...</p>
            </div>
          ) : documents.length === 0 ? (
            <div className="bg-paper-50 rounded-xl border border-ink-200 shadow-sm p-12 text-center">
              <div className="text-ink-400 mb-3">
                <FileText className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p className="text-sm">还没有其他文档</p>
                <p className="text-xs mt-1">去导入 .md 文件、粘贴 markdown，或上传 zip 批量导入</p>
              </div>
              <button
                onClick={() => setShowImportDocModal(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition"
              >
                <Upload className="w-4 h-4" />
                导入第一个文档
              </button>
            </div>
          ) : filteredDocuments.length === 0 ? (
            <div className="bg-paper-50 rounded-xl border border-ink-200 shadow-sm p-12 text-center text-ink-400 text-sm">
              <Search className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>没有找到匹配的文档</p>
            </div>
          ) : (
            <div className="bg-paper-50 rounded-xl border border-ink-200 shadow-sm divide-y divide-ink-100 overflow-hidden">
              {filteredDocuments.map((doc) => {
                const catNames = documentCategories
                  .filter((c) => c.members.includes(doc.id))
                  .map((c) => c.name)
                return (
                  <div key={doc.id} className="flex items-center gap-3 px-4 py-3 hover:bg-paper-100 transition">
                    <div className="w-9 h-9 flex-shrink-0 flex items-center justify-center bg-seal-50 text-seal-600 rounded-lg">
                      <FileText className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-ink-800 truncate">{doc.title}</p>
                        {doc.hasContent ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-green-100 text-green-700 rounded text-[0.625rem] font-medium shrink-0">
                            <CheckCircle2 className="w-3 h-3" />
                            已导入
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-1.5 py-0.5 bg-ink-100 text-ink-500 rounded text-[0.625rem] shrink-0">
                            无正文
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-ink-500">
                        <span className="truncate">{doc.author || '未知作者'}</span>
                        {catNames.length > 0 && (
                          <span className="flex items-center gap-1 truncate">
                            <Tag className="w-3 h-3 text-ink-400" />
                            {catNames.join('、')}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleOpenDocumentReading(doc)}
                        className="p-1.5 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded-md transition"
                        title="打开阅读"
                      >
                        <BookOpen className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleEditDocument(doc)}
                        className="p-1.5 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded-md transition"
                        title="编辑"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteDocument(doc)}
                        className="p-1.5 text-ink-400 hover:text-red-600 hover:bg-red-50 rounded-md transition"
                        title="删除"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ============ 导入导出 Tab ============ */}
      {activeTab === 'import-export' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="bg-paper-50 rounded-xl border border-ink-200 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-ink-100 bg-paper-100/50">
                <h3 className="font-semibold text-ink-800 flex items-center gap-2">
                  <Upload className="w-5 h-5 text-seal-600" />
                  导入文献
                </h3>
                <p className="text-xs text-ink-500 mt-0.5">从外部文件导入文献到文献库</p>
              </div>
              <div className="p-5 space-y-3">
                {[
                  { name: 'CSV 导入', desc: '从 CSV 表格导入文献元数据', ext: '.csv', icon: FileSpreadsheet },
                  { name: 'JSON 导入', desc: '从 JSON 文件导入结构化数据', ext: '.json', icon: FileJson },
                  { name: 'EndNote 导入', desc: '导入 EndNote 文献库 (.enw)', ext: '.enw', icon: BookText },
                  { name: 'Zotero 导入', desc: '从 Zotero 导出的 JSON/CSV 导入', ext: '.json,.csv', icon: Database },
                ].map((item) => {
                  const Icon = item.icon
                  return (
                    <label
                      key={item.name}
                      className="flex items-center gap-3 p-3 border border-ink-200 rounded-lg hover:border-seal-200 hover:bg-seal-50/30 cursor-pointer transition"
                    >
                      <div className="p-2 bg-ink-100 rounded-lg">
                        <Icon className="w-5 h-5 text-ink-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-ink-700">{item.name}</div>
                        <div className="text-xs text-ink-500">{item.desc}</div>
                      </div>
                      <input type="file" accept={item.ext} className="hidden" />
                      <span className="text-xs text-seal-600 font-medium shrink-0">选择文件</span>
                    </label>
                  )
                })}
              </div>
            </div>

            <div className="bg-paper-50 rounded-xl border border-ink-200 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-ink-100 bg-paper-100/50">
                <h3 className="font-semibold text-ink-800 flex items-center gap-2">
                  <Download className="w-5 h-5 text-seal-600" />
                  导出文献
                </h3>
                <p className="text-xs text-ink-500 mt-0.5">将文献库导出为各种格式</p>
              </div>
              <div className="p-5 space-y-3">
                {[
                  { name: '导出 CSV', desc: '导出为 CSV 表格格式', icon: FileSpreadsheet },
                  { name: '导出 Markdown', desc: '导出为 Markdown 文献列表', icon: FileText },
                  { name: '导出 BibTeX', desc: '导出为 BibTeX 引用格式', icon: BookText },
                ].map((item) => {
                  const Icon = item.icon
                  return (
                    <button
                      key={item.name}
                      className="w-full flex items-center gap-3 p-3 border border-ink-200 rounded-lg hover:border-seal-200 hover:bg-seal-50/30 transition text-left"
                    >
                      <div className="p-2 bg-ink-100 rounded-lg">
                        <Icon className="w-5 h-5 text-ink-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-ink-700">{item.name}</div>
                        <div className="text-xs text-ink-500">{item.desc}</div>
                      </div>
                      <Download className="w-4 h-4 text-seal-500 shrink-0" />
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          <div className="bg-paper-50 rounded-xl border border-ink-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-ink-100 bg-paper-100/50">
              <h3 className="font-semibold text-ink-800 flex items-center gap-2">
                <Github className="w-5 h-5 text-seal-600" />
                GitHub 同步
              </h3>
              <p className="text-xs text-ink-500 mt-0.5">与 GitHub 私有仓库同步文献和知识库数据</p>
            </div>
            <div className="p-5">
              <div className="flex items-center gap-4 p-4 bg-seal-50/50 border border-seal-100 rounded-xl">
                <div className="p-3 bg-seal-100 rounded-xl">
                  <Github className="w-6 h-6 text-seal-600" />
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium text-ink-700">GitHub 私有仓库同步</div>
                  <div className="text-xs text-ink-500 mt-0.5">
                    将文献库 Markdown 和知识库图书同步到 GitHub 私有仓库，实现版本管理和备份
                  </div>
                </div>
                <button className="flex items-center gap-2 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition shadow-md shadow-seal-200">
                  <RefreshCw className="w-4 h-4" />
                  立即同步
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 添加文献弹窗 */}
      {showAddPaperModal && (
        <Modal title="手动添加文献" onClose={() => setShowAddPaperModal(false)}>
          <div className="space-y-4">
            {/* Crossref DOI 自动填充工具条 */}
            <div className="p-3 bg-seal-50 border border-seal-200 rounded-lg space-y-2">
              <p className="text-xs font-semibold text-seal-700 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" />
                从 DOI 自动填充（Crossref）
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newPaper.doi}
                  onChange={(e) => { setNewPaper({ ...newPaper, doi: e.target.value }); setDoiFetchError(null) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !doiFetching) handleFetchFromDoi(newPaper.doi) }}
                  placeholder="粘贴 DOI，例如 10.1038/s41586-024-07500-3 或 https://doi.org/..."
                  className="flex-1 px-3 py-2 border border-seal-300 rounded-lg text-sm focus:outline-none focus:border-seal-500 focus:ring-2 focus:ring-seal-100 bg-paper-50"
                />
                <button
                  onClick={() => handleFetchFromDoi(newPaper.doi)}
                  disabled={doiFetching || !newPaper.doi.trim()}
                  className="px-4 py-2 text-sm font-medium text-paper-50 bg-seal-600 hover:bg-seal-700 disabled:bg-ink-400 disabled:cursor-not-allowed rounded-lg transition flex items-center gap-1.5 whitespace-nowrap"
                >
                  {doiFetching ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      获取中…
                    </>
                  ) : (
                    <>
                      <ExternalLink className="w-3.5 h-3.5" />
                      自动填充
                    </>
                  )}
                </button>
              </div>
              {doiFetchError && (
                <p className="text-xs text-red-600">{doiFetchError}</p>
              )}
              <p className="text-[11px] text-seal-500/70">
                DOI 填充后可手动调整标题/作者/期刊/关键词等字段
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">标题 *</label>
              <input
                type="text"
                value={newPaper.title}
                onChange={(e) => setNewPaper({ ...newPaper, title: e.target.value })}
                placeholder="请输入文献标题"
                className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">作者</label>
              <input
                type="text"
                value={newPaper.authors}
                onChange={(e) => setNewPaper({ ...newPaper, authors: e.target.value })}
                placeholder="多个作者用逗号分隔"
                className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1.5">年份</label>
                <input
                  type="text"
                  value={newPaper.year}
                  onChange={(e) => setNewPaper({ ...newPaper, year: e.target.value })}
                  placeholder="2024"
                  className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1.5">期刊</label>
                <input
                  type="text"
                  value={newPaper.journal}
                  onChange={(e) => setNewPaper({ ...newPaper, journal: e.target.value })}
                  placeholder="期刊名称"
                  className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">DOI</label>
              <input
                type="text"
                value={newPaper.doi}
                onChange={(e) => setNewPaper({ ...newPaper, doi: e.target.value })}
                placeholder="10.1000/sample.00000001"
                className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">关键词</label>
              <input
                type="text"
                value={newPaper.keywords}
                onChange={(e) => setNewPaper({ ...newPaper, keywords: e.target.value })}
                placeholder="多个关键词用逗号分隔"
                className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">文献等级</label>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="tier"
                    value="auto"
                    checked={newPaper.tier === 'auto'}
                    onChange={(e) => setNewPaper({ ...newPaper, tier: e.target.value as 'auto' | '1' | '2' })}
                    className="w-4 h-4 text-seal-600 focus:ring-seal-500"
                  />
                  <span className="text-sm text-ink-700">
                    ✨ 自动
                    <span className="text-xs text-ink-400 ml-1">（按标题/期刊推断，综述类为二级）</span>
                  </span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="tier"
                    value="1"
                    checked={newPaper.tier === '1'}
                    onChange={(e) => setNewPaper({ ...newPaper, tier: e.target.value as 'auto' | '1' | '2' })}
                    className="w-4 h-4 text-seal-600 focus:ring-seal-500"
                  />
                  <span className="text-sm text-ink-700">📄 一级</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="tier"
                    value="2"
                    checked={newPaper.tier === '2'}
                    onChange={(e) => setNewPaper({ ...newPaper, tier: e.target.value as 'auto' | '1' | '2' })}
                    className="w-4 h-4 text-seal-600 focus:ring-seal-500"
                  />
                  <span className="text-sm text-ink-700">📖 二级</span>
                </label>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">所属分类（可多选）</label>
              <div className="flex flex-wrap gap-2 p-3 border border-ink-200 rounded-lg bg-paper-100/50">
                {getAllLeafCategories.map((cat) => {
                  const checked = newPaper.categoryIds.includes(cat.id)
                  return (
                    <label
                      key={cat.id}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md cursor-pointer text-sm transition ${
                        checked ? 'bg-seal-100 text-seal-700' : 'bg-paper-50 text-ink-600 border border-ink-200 hover:border-seal-300'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setNewPaper({ ...newPaper, categoryIds: [...newPaper.categoryIds, cat.id] })
                          } else {
                            setNewPaper({ ...newPaper, categoryIds: newPaper.categoryIds.filter((id) => id !== cat.id) })
                          }
                        }}
                        className="w-3.5 h-3.5 text-seal-600 focus:ring-seal-500 rounded"
                      />
                      {cat.name}
                    </label>
                  )
                })}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">上传 PDF（自动转MD）</label>
              <div className="border-2 border-dashed border-ink-200 rounded-lg p-6 text-center hover:border-seal-300 transition cursor-pointer">
                <Upload className="w-8 h-8 mx-auto mb-2 text-ink-300" />
                <p className="text-sm text-ink-500">点击或拖拽 PDF 到此处</p>
                <p className="text-xs text-ink-400 mt-1">PDF 上传后自动转换为 Markdown</p>
                <input type="file" accept=".pdf" className="hidden" />
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-ink-100">
            <button
              onClick={() => setShowAddPaperModal(false)}
              className="px-4 py-2 text-sm text-ink-600 hover:bg-ink-100 rounded-lg transition"
            >
              取消
            </button>
            <button
              onClick={handleAddPaper}
              className="flex items-center gap-2 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition"
            >
              <Plus className="w-4 h-4" />
              添加
            </button>
          </div>
        </Modal>
      )}

      {/* 编辑文献弹窗 */}
      {showEditPaperModal && editingPaper && (
        <Modal title="编辑文献" onClose={() => { setShowEditPaperModal(false); setEditingPaper(null) }} width="max-w-2xl">
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1.5">题图</label>
                <div className="aspect-square rounded-lg overflow-hidden bg-ink-100 border border-ink-200 flex items-center justify-center">
                  {editingPaper.coverImage ? (
                    <img src={editingPaper.coverImage} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <ImageIcon className="w-8 h-8 text-ink-300" />
                  )}
                </div>
                <div className="mt-2 space-y-1">
                  <label className="flex items-center justify-center gap-1 px-2 py-1.5 text-xs text-ink-600 bg-paper-100 border border-ink-200 hover:bg-ink-100 rounded-md cursor-pointer transition">
                    <Upload className="w-3.5 h-3.5" />
                    上传图片
                    <input type="file" accept="image/*" className="hidden" />
                  </label>
                  <button
                    onClick={() => {
                      const url = prompt('请输入图片URL')
                      if (url && editingPaper) {
                        setEditingPaper({ ...editingPaper, coverImage: url })
                      }
                    }}
                    className="w-full flex items-center justify-center gap-1 px-2 py-1.5 text-xs text-ink-600 bg-paper-100 border border-ink-200 hover:bg-ink-100 rounded-md transition"
                  >
                    <LinkIcon className="w-3.5 h-3.5" />
                    从URL添加
                  </button>
                </div>
              </div>
              <div className="col-span-2 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-ink-700 mb-1.5">标题 *</label>
                  <input
                    type="text"
                    value={editingPaper.title}
                    onChange={(e) => setEditingPaper({ ...editingPaper, title: e.target.value })}
                    className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-ink-700 mb-1.5">作者</label>
                  <input
                    type="text"
                    value={editingPaper.authors}
                    onChange={(e) => setEditingPaper({ ...editingPaper, authors: e.target.value })}
                    placeholder="多个作者用逗号分隔"
                    className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-ink-700 mb-1.5">年份</label>
                    <input
                      type="text"
                      value={editingPaper.year}
                      onChange={(e) => setEditingPaper({ ...editingPaper, year: e.target.value })}
                      className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-ink-700 mb-1.5">期刊</label>
                    <input
                      type="text"
                      value={editingPaper.journal}
                      onChange={(e) => setEditingPaper({ ...editingPaper, journal: e.target.value })}
                      className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">关键词</label>
              <input
                type="text"
                value={editingPaper.keywords.join(', ')}
                onChange={(e) => setEditingPaper({ ...editingPaper, keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) })}
                placeholder="多个关键词用逗号分隔"
                className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">DOI</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={editingPaper.doi}
                  onChange={(e) => setEditingPaper({ ...editingPaper, doi: e.target.value })}
                  className="flex-1 px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
                <DoiLink
                  doi={editingPaper.doi}
                  showIcon
                  className="flex items-center gap-1 px-3 py-2 text-sm bg-seal-50 hover:bg-seal-100 rounded-lg transition"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">文献等级</label>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="edit-tier"
                    value="1"
                    checked={editingPaper.tier === 1}
                    onChange={() => setEditingPaper({ ...editingPaper, tier: 1 })}
                    className="w-4 h-4 text-seal-600 focus:ring-seal-500"
                  />
                  <span className="text-sm text-ink-700">📄 一级文献（原创研究）</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="edit-tier"
                    value="2"
                    checked={editingPaper.tier === 2}
                    onChange={() => setEditingPaper({ ...editingPaper, tier: 2 })}
                    className="w-4 h-4 text-seal-600 focus:ring-seal-500"
                  />
                  <span className="text-sm text-ink-700">📖 二级文献（综述/评述）</span>
                </label>
                <button
                  type="button"
                  onClick={() => setEditingPaper({
                    ...editingPaper,
                    // 按当前标题/期刊重新自动推断
                    tier: inferPaperTier(editingPaper.title, editingPaper.journal),
                  })}
                  className="text-xs px-2 py-1 bg-seal-50 text-seal-600 rounded-md hover:bg-seal-100 transition"
                >
                  ✨ 按标题重新推断
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">所属分类（可多选，可同时属于多个分类）</label>
              <div className="flex flex-wrap gap-2 p-3 border border-ink-200 rounded-lg bg-paper-100/50 max-h-32 overflow-y-auto">
                {getAllLeafCategories.map((cat) => {
                  const checked = editingPaper.categoryIds.includes(cat.id)
                  return (
                    <label
                      key={cat.id}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md cursor-pointer text-sm transition ${
                        checked ? 'bg-seal-100 text-seal-700' : 'bg-paper-50 text-ink-600 border border-ink-200 hover:border-seal-300'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setEditingPaper({ ...editingPaper, categoryIds: [...editingPaper.categoryIds, cat.id] })
                          } else {
                            setEditingPaper({ ...editingPaper, categoryIds: editingPaper.categoryIds.filter((id) => id !== cat.id) })
                          }
                        }}
                        className="w-3.5 h-3.5 text-seal-600 focus:ring-seal-500 rounded"
                      />
                      {cat.name}
                    </label>
                  )
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1.5">Markdown 转换</label>
                <div className="p-3 border border-ink-200 rounded-lg bg-paper-100/50">
                  <div className="flex items-center justify-between mb-2">
                    <StatusBadge status={editingPaper.mdStatus} />
                    {editingPaper.mdStatus === 'done' && (
                      <button className="text-xs text-seal-600 hover:underline">查看</button>
                    )}
                    {editingPaper.mdStatus === 'converting' && (
                      <span className="text-[10px] text-ink-400">
                        {(() => {
                          const t = taskQueue.tasks.find(
                            (x) => x.doi === editingPaper.doi && x.type === 'paper_convert',
                          )
                          return t ? STAGE_META[t.stage]?.label || '' : ''
                        })()}
                      </span>
                    )}
                  </div>
                  {editingPaper.mdStatus === 'converting' && (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-ink-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-seal-500 rounded-full transition-all duration-300"
                          style={{ width: `${Math.min(100, editingPaper.mdProgress)}%` }}
                        />
                      </div>
                      <span className="text-xs text-ink-500 font-mono tabular-nums">
                        {Math.round(editingPaper.mdProgress)}%
                      </span>
                    </div>
                  )}
                  {editingPaper.mdStatus === 'done' && (
                    <div className="text-[11px] text-green-600 italic">✓ 全流程完成</div>
                  )}
                  {editingPaper.mdStatus === 'failed' && (
                    <div className="text-[11px] text-red-500 italic">
                      转换失败，可重新上传
                    </div>
                  )}
                  {(editingPaper.mdStatus === 'none' || editingPaper.mdStatus === 'failed') && (
                    <label className="flex items-center justify-center gap-1 mt-2 px-3 py-1.5 text-xs text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-md cursor-pointer transition">
                      <Upload className="w-3.5 h-3.5" />
                      上传PDF转MD
                      <input
                        type="file"
                        accept=".pdf"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (file && editingPaper) {
                            void startPaperMineruConvert(editingPaper, file)
                          }
                          e.target.value = ''
                        }}
                      />
                    </label>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1.5">笔记</label>
                <div className="p-3 border border-ink-200 rounded-lg bg-paper-100/50">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <StickyNote className={`w-4 h-4 ${editingPaper.hasNotes ? 'text-amber-500' : 'text-ink-300'}`} />
                      <span className="text-sm text-ink-700">
                        {editingPaper.hasNotes ? '有笔记' : '无笔记'}
                      </span>
                    </div>
                    <button
                      onClick={() => setEditingPaper({ ...editingPaper, hasNotes: !editingPaper.hasNotes })}
                      className="text-xs text-seal-600 hover:underline"
                    >
                      {editingPaper.hasNotes ? '查看笔记' : '添加笔记'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-ink-100">
            <button
              onClick={() => { setShowEditPaperModal(false); setEditingPaper(null) }}
              className="px-4 py-2 text-sm text-ink-600 hover:bg-ink-100 rounded-lg transition"
            >
              取消
            </button>
            <button
              onClick={handleSavePaper}
              className="flex items-center gap-2 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition"
            >
              <CheckCircle2 className="w-4 h-4" />
              保存
            </button>
          </div>
        </Modal>
      )}

      {/* 批量移动分类弹窗 */}
      {showBatchMoveModal && (
        <Modal title="批量移动分类" onClose={() => { setShowBatchMoveModal(false); setBatchMoveTargetIds([]) }}>
          <div className="space-y-4">
            <p className="text-sm text-ink-600">
              已选中 <span className="font-semibold text-seal-600">{selectedPapers.size}</span> 篇文献，选择目标分类（可多选，将添加到现有分类中）：
            </p>
            <div className="flex flex-wrap gap-2 p-3 border border-ink-200 rounded-lg bg-paper-100/50 max-h-48 overflow-y-auto">
              {getAllLeafCategories.map((cat) => {
                const checked = batchMoveTargetIds.includes(cat.id)
                return (
                  <label
                    key={cat.id}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md cursor-pointer text-sm transition ${
                      checked ? 'bg-seal-100 text-seal-700' : 'bg-paper-50 text-ink-600 border border-ink-200 hover:border-seal-300'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setBatchMoveTargetIds([...batchMoveTargetIds, cat.id])
                        } else {
                          setBatchMoveTargetIds(batchMoveTargetIds.filter((id) => id !== cat.id))
                        }
                      }}
                      className="w-3.5 h-3.5 text-seal-600 focus:ring-seal-500 rounded"
                    />
                    {cat.name}
                  </label>
                )
              })}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-ink-100">
            <button
              onClick={() => { setShowBatchMoveModal(false); setBatchMoveTargetIds([]) }}
              className="px-4 py-2 text-sm text-ink-600 hover:bg-ink-100 rounded-lg transition"
            >
              取消
            </button>
            <button
              onClick={handleBatchMove}
              disabled={batchMoveTargetIds.length === 0}
              className="flex items-center gap-2 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <MoveRight className="w-4 h-4" />
              确认移动
            </button>
          </div>
        </Modal>
      )}

      {/* 分类编辑弹窗 */}
      {showCategoryModal && editingCategory && (
        <Modal title={editingCategory.id ? '编辑分类' : '添加分类'} onClose={() => { setShowCategoryModal(false); setEditingCategory(null) }}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">分类名称 *</label>
              <input
                type="text"
                value={editingCategory.name}
                onChange={(e) => setEditingCategory({ ...editingCategory, name: e.target.value })}
                placeholder="请输入分类名称"
                className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-ink-100">
            <button
              onClick={() => { setShowCategoryModal(false); setEditingCategory(null) }}
              className="px-4 py-2 text-sm text-ink-600 hover:bg-ink-100 rounded-lg transition"
            >
              取消
            </button>
            <button
              onClick={handleSaveCategory}
              disabled={!editingCategory.name.trim()}
              className="flex items-center gap-2 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle2 className="w-4 h-4" />
              保存
            </button>
          </div>
        </Modal>
      )}

      {/* 图书分类编辑弹窗 */}
      {showBookCategoryModal && editingBookCategory && (
        <Modal title={editingBookCategory.id ? '编辑分类' : '添加分类'} onClose={() => { setShowBookCategoryModal(false); setEditingBookCategory(null) }}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">分类名称 *</label>
              <input
                type="text"
                value={editingBookCategory.name}
                onChange={(e) => setEditingBookCategory({ ...editingBookCategory, name: e.target.value })}
                placeholder="请输入分类名称"
                className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-ink-100">
            <button
              onClick={() => { setShowBookCategoryModal(false); setEditingBookCategory(null) }}
              className="px-4 py-2 text-sm text-ink-600 hover:bg-ink-100 rounded-lg transition"
            >
              取消
            </button>
            <button
              onClick={handleSaveBookCategory}
              disabled={!editingBookCategory.name.trim()}
              className="flex items-center gap-2 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle2 className="w-4 h-4" />
              保存
            </button>
          </div>
        </Modal>
      )}

      {/* 新建/编辑模板弹窗 */}
      {showTemplateModal && (
        <Modal title={editingTemplate ? '编辑期刊模板' : '新建期刊模板'} onClose={() => { setShowTemplateModal(false); setEditingTemplate(null) }} width="max-w-xl">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1.5">期刊名 *</label>
                <input
                  type="text"
                  value={newTemplate.name}
                  onChange={(e) => setNewTemplate({ ...newTemplate, name: e.target.value })}
                  placeholder="如：Sample Journal"
                  className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1.5">ISSN</label>
                <input
                  type="text"
                  value={newTemplate.issn}
                  onChange={(e) => setNewTemplate({ ...newTemplate, issn: e.target.value })}
                  placeholder="如：2058-7546"
                  className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">出版社</label>
              <input
                type="text"
                value={newTemplate.publisher}
                onChange={(e) => setNewTemplate({ ...newTemplate, publisher: e.target.value })}
                placeholder="如：示例出版社"
                className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">投稿须知 / 格式规范</label>
              <div className="space-y-2">
                <div className="flex gap-2">
                  <label className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm text-ink-600 bg-paper-100 border border-ink-200 hover:bg-ink-100 rounded-lg cursor-pointer transition">
                    <FileText className="w-4 h-4" />
                    粘贴投稿须知
                    <input type="file" accept=".pdf,.txt" className="hidden" />
                  </label>
                  <button
                    onClick={handleExtractFormat}
                    disabled={isExtracting}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition disabled:opacity-60"
                  >
                    <Sparkles className={`w-4 h-4 ${isExtracting ? 'animate-spin' : ''}`} />
                    {isExtracting ? '提取中...' : 'AI提取'}
                  </button>
                </div>
                <textarea
                  value={newTemplate.guidelines}
                  onChange={(e) => setNewTemplate({ ...newTemplate, guidelines: e.target.value })}
                  placeholder="粘贴投稿须知内容，或点击AI提取自动生成格式规范摘要..."
                  rows={5}
                  className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 resize-none"
                />
                <p className="text-xs text-ink-400">提示：模板主要用于提示和规范提取格式，帮助统一写作风格</p>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-ink-100">
            <button
              onClick={() => { setShowTemplateModal(false); setEditingTemplate(null) }}
              className="px-4 py-2 text-sm text-ink-600 hover:bg-ink-100 rounded-lg transition"
            >
              取消
            </button>
            <button
              onClick={editingTemplate ? handleSaveTemplate : handleAddTemplate}
              className="flex items-center gap-2 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition"
            >
              <Plus className="w-4 h-4" />
              {editingTemplate ? '保存修改' : '创建模板'}
            </button>
          </div>
        </Modal>
      )}

      {/* 上传图书弹窗 */}
      {showUploadBookModal && (
        <Modal title="上传图书" onClose={() => { setShowUploadBookModal(false); setUploadBookCategories([]) }}>
          <div className="space-y-4">
            <div
              onDragOver={(e) => {
                e.preventDefault()
                setIsDragOverBook(true)
              }}
              onDragLeave={() => setIsDragOverBook(false)}
              onDrop={(e) => {
                e.preventDefault()
                setIsDragOverBook(false)
                handleBookUpload(e.dataTransfer.files)
              }}
              className={`border-2 border-dashed rounded-xl p-8 text-center transition ${
                isDragOverBook
                  ? 'border-seal-400 bg-seal-50/50'
                  : 'border-ink-200 bg-paper-100 hover:border-seal-200 hover:bg-seal-50/30'
              }`}
            >
              <Upload className="w-10 h-10 mx-auto mb-3 text-ink-400" />
              <p className="text-sm text-ink-600 font-medium">拖拽或点击上传 PDF 图书</p>
              <p className="text-xs text-ink-400 mt-1">支持多文件上传，自动转换为 Markdown</p>
              <p className="text-xs text-seal-500 mt-1">超过200页自动按180页切分</p>
              <label className="inline-flex items-center gap-2 mt-4 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition cursor-pointer">
                <Upload className="w-4 h-4" />
                选择文件
                <input
                  type="file"
                  accept=".pdf"
                  multiple
                  className="hidden"
                  onChange={(e) => handleBookUpload(e.target.files)}
                />
              </label>
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">选择分类（可多选）</label>
              <div className="flex flex-wrap gap-2 p-3 border border-ink-200 rounded-lg bg-paper-100/50">
                {bookCategories.filter((c) => c.id !== 'all').map((cat) => {
                  const checked = uploadBookCategories.includes(cat.id)
                  return (
                    <label
                      key={cat.id}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md cursor-pointer text-sm transition ${
                        checked ? 'bg-seal-100 text-seal-700' : 'bg-paper-50 text-ink-600 border border-ink-200 hover:border-seal-300'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setUploadBookCategories([...uploadBookCategories, cat.id])
                          } else {
                            setUploadBookCategories(uploadBookCategories.filter((id) => id !== cat.id))
                          }
                        }}
                        className="w-3.5 h-3.5 text-seal-600 focus:ring-seal-500 rounded"
                      />
                      {cat.name}
                    </label>
                  )
                })}
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-ink-100">
            <button
              onClick={() => { setShowUploadBookModal(false); setUploadBookCategories([]) }}
              className="px-4 py-2 text-sm text-ink-600 hover:bg-ink-100 rounded-lg transition"
            >
              取消
            </button>
          </div>
        </Modal>
      )}

      {/* 图书详情弹窗 */}
      {showBookDetail && (
        <Modal
          title={showBookDetail.title}
          onClose={() => setShowBookDetail(null)}
          width="max-w-xl"
        >
          <div className="space-y-4">
            <div className="flex gap-4">
              <div className="w-24 h-32 flex-shrink-0 rounded-lg overflow-hidden bg-ink-100">
                {showBookDetail.coverImage ? (
                  <img src={showBookDetail.coverImage} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-ink-300">
                    <Book className="w-8 h-8" />
                  </div>
                )}
              </div>
              <div className="flex-1 space-y-1.5">
                <p className="text-sm text-ink-600"><span className="text-ink-400">作者：</span>{showBookDetail.author}</p>
                <p className="text-sm text-ink-600"><span className="text-ink-400">出版社：</span>{showBookDetail.publisher}</p>
                <p className="text-sm text-ink-600"><span className="text-ink-400">年份：</span>{showBookDetail.year || '—'}</p>
                <p className="text-sm text-ink-600"><span className="text-ink-400">状态：</span>
                  <BookStatusBadge status={showBookDetail.status} />
                </p>
              </div>
            </div>

            {/* 给这本图书设置所属分类（主键 = 书名） */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-ink-700 flex items-center gap-1.5">
                  <Tag className="w-4 h-4 text-seal-600" />
                  所属分类
                </label>
                <button
                  onClick={handleSaveBookDetailCategories}
                  className="text-xs px-2.5 py-1 text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-md transition"
                >
                  保存分类
                </button>
              </div>
              {bookCategories.filter((c) => c.id !== 'all').length === 0 ? (
                <p className="text-xs text-ink-400">还没有图书分类，可在左侧「图书分类」里新建后再回来设置</p>
              ) : (
                <div className="flex flex-wrap gap-2 p-3 border border-ink-200 rounded-lg bg-paper-100/50">
                  {bookCategories.filter((c) => c.id !== 'all').map((cat) => {
                    const checked = bookDetailCategoryIds.includes(cat.id)
                    return (
                      <label
                        key={cat.id}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md cursor-pointer text-sm transition ${
                          checked ? 'bg-seal-100 text-seal-700' : 'bg-paper-50 text-ink-600 border border-ink-200 hover:border-seal-300'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => setBookDetailCategoryIds(
                            e.target.checked
                              ? [...bookDetailCategoryIds, cat.id]
                              : bookDetailCategoryIds.filter((id) => id !== cat.id),
                          )}
                          className="w-3.5 h-3.5 text-seal-600 focus:ring-seal-500 rounded"
                        />
                        {cat.name}
                      </label>
                    )
                  })}
                </div>
              )}
            </div>

            {showBookDetail.isSplit && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Layers className="w-4 h-4 text-seal-600" />
                  <h4 className="text-sm font-medium text-ink-700">分卷列表（超过200页按180页切分）</h4>
                </div>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {showBookDetail.volumes?.map((vol) => (
                    <div key={vol.id} className="flex items-center gap-3 p-3 bg-paper-100 rounded-lg border border-ink-100">
                      <div className="w-8 h-8 flex items-center justify-center bg-seal-100 text-seal-600 rounded-md text-sm font-bold">
                        {vol.volume}
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-ink-700">第 {vol.volume} 卷</p>
                        <p className="text-xs text-ink-500">{vol.pageRange}</p>
                      </div>
                      <div className="w-24">
                        {vol.status === 'done' ? (
                          <span className="inline-flex items-center gap-1 text-xs text-green-600">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            已完成
                          </span>
                        ) : vol.status === 'converting' ? (
                          <div className="flex items-center gap-1.5">
                            <div className="flex-1 h-1.5 bg-ink-200 rounded-full overflow-hidden">
                              <div className="h-full bg-seal-500 rounded-full" style={{ width: `${vol.progress}%` }} />
                            </div>
                            <span className="text-xs text-ink-500 w-8">{vol.progress}%</span>
                          </div>
                        ) : (
                          <span className="text-xs text-red-600">失败</span>
                        )}
                      </div>
                      {vol.status === 'done' && (
                        <button className="p-1 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded transition">
                          <Eye className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!showBookDetail.isSplit && (
              <div className="p-3 bg-seal-50/50 border border-seal-100 rounded-lg">
                <p className="text-sm text-seal-700">
                  本书页数少于200页，无需切分，单卷完整转换。
                </p>
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 mt-6 pt-4 border-t border-ink-100">
            <button
              onClick={() => setShowBookDetail(null)}
              className="px-4 py-2 text-sm text-ink-600 hover:bg-ink-100 rounded-lg transition"
            >
              关闭
            </button>
            <div className="flex items-center gap-2">
              {showBookDetail.status === 'done' && showBookDetail.isSplit && (
                <button className="flex items-center gap-2 px-4 py-2 text-sm text-seal-600 bg-seal-50 border border-seal-200 hover:bg-seal-100 rounded-lg transition">
                  <Layers className="w-4 h-4" />
                  合并阅读
                </button>
              )}
              {showBookDetail.status === 'done' && (
                <button className="flex items-center gap-2 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition">
                  <Book className="w-4 h-4" />
                  开始阅读
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* 导入其他文档弹窗（三种方式：上传 .md / 粘贴 / zip） */}
      {showImportDocModal && (
        <Modal
          title="导入文档"
          onClose={() => { if (!importing) setShowImportDocModal(false) }}
          width="max-w-2xl"
        >
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
                importing ? 'opacity-60 pointer-events-none' : 'border-ink-200 bg-paper-100 hover:border-seal-200 hover:bg-seal-50/30 cursor-pointer'
              }`}
            >
              {importing
                ? <Loader2 className="w-10 h-10 text-seal-500 animate-spin" />
                : <Upload className="w-10 h-10 text-ink-400" />}
              <p className="text-sm text-ink-600 font-medium">{importing ? '导入中...' : '点击选择 .md / .markdown / .txt 文件'}</p>
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
                  className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
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
                  className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm font-mono focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 resize-y"
                />
              </div>
            </div>
          )}

          {importMode === 'zip' && (
            <label
              className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl p-8 text-center transition ${
                importing ? 'opacity-60 pointer-events-none' : 'border-ink-200 bg-paper-100 hover:border-seal-200 hover:bg-seal-50/30 cursor-pointer'
              }`}
            >
              {importing
                ? <Loader2 className="w-10 h-10 text-seal-500 animate-spin" />
                : <Folder className="w-10 h-10 text-ink-400" />}
              <p className="text-sm text-ink-600 font-medium">{importing ? '导入中...' : '点击选择 .zip 压缩包'}</p>
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

      {/* 编辑其他文档弹窗 */}
      {editingDocument && (
        <Modal title="编辑文档" onClose={() => { if (!savingDocument) setEditingDocument(null) }}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">标题 *</label>
              <input
                type="text"
                value={editDocForm.title}
                onChange={(e) => setEditDocForm({ ...editDocForm, title: e.target.value })}
                placeholder="文档标题"
                className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">作者</label>
              <input
                type="text"
                value={editDocForm.author}
                onChange={(e) => setEditDocForm({ ...editDocForm, author: e.target.value })}
                placeholder="作者（可留空）"
                className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-700 mb-1.5">所属分类（可多选）</label>
              {documentCategories.length === 0 ? (
                <p className="text-xs text-ink-400">还没有文档分类</p>
              ) : (
                <div className="flex flex-wrap gap-2 p-3 border border-ink-200 rounded-lg bg-paper-100/50">
                  {documentCategories.map((cat) => {
                    const checked = editDocForm.categoryIds.includes(cat.id)
                    return (
                      <label
                        key={cat.id}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md cursor-pointer text-sm transition ${
                          checked ? 'bg-seal-100 text-seal-700' : 'bg-paper-50 text-ink-600 border border-ink-200 hover:border-seal-300'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => setEditDocForm({
                            ...editDocForm,
                            categoryIds: e.target.checked
                              ? [...editDocForm.categoryIds, cat.id]
                              : editDocForm.categoryIds.filter((id) => id !== cat.id),
                          })}
                          className="w-3.5 h-3.5 text-seal-600 focus:ring-seal-500 rounded"
                        />
                        {cat.name}
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-ink-100">
            <button
              onClick={() => { if (!savingDocument) setEditingDocument(null) }}
              disabled={savingDocument}
              className="px-4 py-2 text-sm text-ink-600 hover:bg-ink-100 rounded-lg transition disabled:opacity-60"
            >
              取消
            </button>
            <button
              onClick={handleSaveDocument}
              disabled={savingDocument || !editDocForm.title.trim()}
              className="flex items-center gap-2 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {savingDocument ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              保存
            </button>
          </div>
        </Modal>
      )}

      {/* 图片灯箱 */}
      {showImageLightbox && (
        <ImageLightbox src={showImageLightbox} onClose={() => setShowImageLightbox(null)} />
      )}
      </div>{/* ──── 左侧主内容 END ──── */}

      {/* ──── 右侧 sticky 后台监控面板（常驻、不弹窗） ──── */}
      <aside className="hidden lg:block min-w-0">
        <div className="sticky top-4 max-h-[calc(100dvh-6rem)] overflow-y-auto">
          <BackendMonitorPanel taskQueue={taskQueue} />
        </div>
      </aside>

      {/* 全文检索结果：命中片段 + 点结果去阅读页滚动定位并高亮 */}
      {ftOpen && (
        <Modal title={`全文检索 · ${ftQuery}`} onClose={() => setFtOpen(false)} width="max-w-3xl">
          {ftLoading ? (
            <div className="text-center py-10 text-ink-400 text-sm">
              <div className="w-8 h-8 border-2 border-ink-200 border-t-seal-500 rounded-full animate-spin mx-auto mb-2" />
              {getSearchIndex()
                ? '正在检索…'
                : `首次检索，正在建立全文索引 ${ftProgress.done}/${ftProgress.total}`}
            </div>
          ) : ftHits.length === 0 ? (
            <div className="text-center py-10 text-ink-400 text-sm">
              <Search className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p>全库正文里没有匹配的词</p>
              <p className="text-xs mt-1">检索范围：文献 / 图书 / 其他文档的正文</p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-xs text-ink-400">
                {ftHits.length} 篇命中，点结果直达正文命中处
              </div>
              {ftHits.map((hit) => (
                <button
                  key={`${hit.kind}:${hit.id}`}
                  onClick={() => openHitInReader(hit)}
                  title="跳到正文命中处"
                  className="w-full text-left p-3 rounded-lg border border-ink-200 hover:border-seal-300 hover:bg-seal-50/40 transition"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex-shrink-0 px-1.5 py-0.5 rounded bg-ink-100 text-ink-500 text-[0.625rem]">
                      {KIND_LABEL[hit.kind]}
                    </span>
                    <span className="text-sm font-medium text-ink-700 truncate">{hit.title}</span>
                    <span className="ml-auto flex-shrink-0 text-[0.6875rem] text-ink-400">{hit.total} 处</span>
                  </div>
                  {hit.snippets.map((sn, i) => (
                    <div key={i} className="mt-1.5 text-xs leading-relaxed text-ink-500 line-clamp-3">
                      {renderHitSnippet(sn.text)}
                    </div>
                  ))}
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
