import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
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
  Clock,
  X,
  ChevronRight,
  ChevronDown,
  Check,
  Edit3,
  Plus,
  Languages,
  ListTree,
  Sparkles,
  AlertTriangle,
} from 'lucide-react'
import { loadLiteratures, loadFulltext, loadTranslation, loadAlignedMd, saveFulltext, saveAlignedMd, doiToSlug, type Literature } from '../services/literatureData'
import { listBooks, loadBookContent, type BookSummary } from '../services/textbookData'
import { listDocuments, loadDocumentContent, type DocumentSummary } from '../services/documentData'
import { loadBookCategories, loadDocumentCategories, categoriesOfMember, type Category } from '../services/categoryData'
import { loadCategories as loadPaperCategories, type LiteratureCategory } from '../services/literatureCategoryData'
import { loadAnnotations, saveAnnotations, type Annotation as AnnotationData } from '../services/annotationData'
import { loadNotes, saveNotes, loadProgress, saveProgress, type DocRef, type ReadingProgress } from '../services/readingDocData'
import { useWorkspaceStore } from '../stores/workspace'
import { useAuthStore } from '../stores/auth'
import { getResolvedAuthMode } from '../services/github'
import { DoiLink } from '../components/DoiLink'
import { renderMarkdownToHtml } from '../services/markdown-renderer'
import { splitMarkdownIntoParagraphs, alignParagraphs, renderAlignedHtml, renderAlignedMdHtml, type TranslationMode } from '../services/translation'
import { readAnyDocument, blockId, type ReadBlockItem } from '../services/blocks.mjs'
import { clearHighlights, highlightAnnotation } from '../services/text-highlight'
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

export default function ReadingPage() {
  const { repo } = useWorkspaceStore()
  const navigate = useNavigate()
  const [papers, setPapers] = useState<Paper[]>([])
  const [papersLoading, setPapersLoading] = useState(true)
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null)
  const [activeSideTab, setActiveSideTab] = useState<SideTab>('notes')
  const [searchQuery, setSearchQuery] = useState('')
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
  const [articleDraft, setArticleDraft] = useState('')
  const [articleSaving, setArticleSaving] = useState(false)

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
  /** 左栏大纲面板展开态（文献 / 图书共用） */
  const [outlineOpen, setOutlineOpen] = useState(true)
  const [listExpanded, setListExpanded] = useState(true)

  const readerRef = useRef<HTMLDivElement>(null)
  const noteVditorRef = useRef<VditorEditorHandle>(null)
  const articleVditorRef = useRef<VditorEditorHandle>(null)
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
          if (paperList.length > 0) {
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
    setArticleDraft('')

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
    setSavedProgress(null)
    setActiveAnchor('')
    if (!docRef) return
    let cancelled = false
    loadProgress(docRef)
      .then((p) => { if (!cancelled) setSavedProgress(p) })
      .catch((err) => console.error('[Reading] 加载阅读进度失败:', err))
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
    window.setTimeout(() => { restoringRef.current = false }, 120)
  }, [savedProgress])

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
      const anchor = el.id
      setActiveAnchor(anchor)
      if (!docRef) return
      if (progressSaveTimerRef.current) clearTimeout(progressSaveTimerRef.current)
      progressSaveTimerRef.current = setTimeout(() => {
        const item = outlineByAnchor.get(anchor)
        saveProgress(docRef, {
          anchor,
          heading: item?.text ?? (el.textContent ?? '').trim(),
          level: item?.level ?? Number(el.tagName.slice(1)),
          updated_at: new Date().toISOString(),
        }).catch((err) => console.error('[Reading] 保存阅读进度失败:', err))
      }, 1200)
    })
    // docRef 每次渲染都是新对象，但它只有 kind/id 有意义 —— 这里用 docKey 兜住
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickCurrentHeading, outlineByAnchor, docKey])

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

  const enterEditMode = () => {
    if (!selectedPaper?.hasMarkdown) return
    setArticleDraft(articleSourceMd)
    setEditMode(true)
    setShowToolbar(false)
  }

  const saveArticle = async () => {
    if (!selectedPaperId) return
    setArticleSaving(true)
    try {
      if (aligned_content.trim()) {
        await saveAlignedMd(selectedPaperId, articleDraft)
        set_aligned_content(articleDraft)
      } else {
        await saveFulltext(selectedPaperId, articleDraft)
        setPapers(prev => prev.map(p =>
          p.id === selectedPaperId ? { ...p, markdownContent: articleDraft } : p
        ))
      }
      setEditMode(false)
    } catch (err) {
      console.error('[Reading] 保存文献失败:', err)
      alert('保存失败，请检查网络或仓库权限后重试')
    } finally {
      setArticleSaving(false)
    }
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
      className="absolute z-50 bg-white rounded-lg shadow-xl border border-slate-200 px-2 py-1.5 flex items-center gap-1"
      style={{
        top: toolbarPosition.top,
        left: toolbarPosition.left,
      }}
    >
      <span className="text-xs text-slate-400 px-1.5 font-medium">高亮颜色</span>
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c.value}
          onClick={() => handleHighlight(c.value)}
          className={`w-6 h-6 rounded-full ${c.dot} hover:scale-110 transition-transform border-2 border-white shadow-sm hover:shadow-md`}
          title={`${c.label}高亮并添加批注`}
        />
      ))}
    </div>
  ) : null

  return (
    <div className="h-[calc(100vh-3rem)] flex bg-slate-50">
      <aside className="w-72 bg-white border-r border-slate-200 flex flex-col flex-shrink-0 overflow-hidden">
        {/* 固定：阅读对象切换（文献 / 图书 / 其他文档） */}
        <div className="p-2 border-b border-slate-200 flex-shrink-0">
          <div className="flex gap-1 p-0.5 bg-slate-100 rounded-md">
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
                    ? 'bg-white text-indigo-600 font-medium shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
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
            className="w-full flex-shrink-0 flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition"
            title={listExpanded ? '收起列表' : '展开列表'}
          >
            {listExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
            )}
            {isBook ? (
              <BookCopy className="w-3.5 h-3.5 text-indigo-600" />
            ) : isDoc ? (
              <FileText className="w-3.5 h-3.5 text-indigo-600" />
            ) : (
              <BookOpen className="w-3.5 h-3.5 text-indigo-600" />
            )}
            {isBook ? '图书列表' : isDoc ? '文档列表' : '文献列表'}
            <span className="ml-auto text-slate-400 font-normal">
              {isBook
                ? filteredBooks.length
                : isDoc
                  ? filteredDocuments.length
                  : filteredPapers.length}
            </span>
          </button>
          {listExpanded && (
          <div className="flex-auto min-h-0 flex flex-col">
          <div className="flex-shrink-0 px-2 pb-2 space-y-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                isBook
                  ? '按书名搜索...'
                  : isDoc
                    ? '按标题搜索...'
                    : '标题、作者、期刊、年份、关键词、DOI...'
              }
              className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded-md focus:outline-none focus:border-indigo-400"
            />
          </div>
          <div className="mt-2 space-y-1.5">
            {/* 分类筛选：三类交互一致，选项来自各自的分类表 */}
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="w-full px-2 py-1 text-xs border border-slate-200 rounded-md text-slate-600 bg-white focus:outline-none focus:border-indigo-400"
            >
              <option value="all">全部分类</option>
              {(isBook ? bookCategories : isDoc ? documentCategories : paperCategories).map(
                (c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ),
              )}
            </select>

            <div className="flex flex-wrap gap-1">
              {/* 有无 md：其他文档导入的必然有 md，不给它这个按钮 */}
              {!isDoc && (
                <>
                  <button
                    onClick={() => setFilterType('all')}
                    className={`px-2 py-1 text-xs rounded transition flex items-center gap-1 ${
                      filterType === 'all'
                        ? 'bg-indigo-100 text-indigo-700 font-medium'
                        : 'text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    <Filter className="w-3 h-3" />
                    全部
                  </button>
                  <button
                    onClick={() => setFilterType('has-md')}
                    className={`px-2 py-1 text-xs rounded transition ${
                      filterType === 'has-md'
                        ? 'bg-green-100 text-green-700 font-medium'
                        : 'text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    {isBook ? '有正文' : '有Markdown'}
                  </button>
                  <button
                    onClick={() => setFilterType('no-md')}
                    className={`px-2 py-1 text-xs rounded transition ${
                      filterType === 'no-md'
                        ? 'bg-amber-100 text-amber-700 font-medium'
                        : 'text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    {isBook ? '无正文' : '无Markdown'}
                  </button>
                </>
              )}
              {/* 一级 / 二级文献：只有文献有这个维度 */}
              {!isPlain && (
                <>
                  <button
                    onClick={() => setTierFilter(tierFilter === 1 ? 'all' : 1)}
                    className={`px-2 py-1 text-xs rounded transition ${
                      tierFilter === 1
                        ? 'bg-blue-100 text-blue-700 font-medium'
                        : 'text-slate-500 hover:bg-slate-100'
                    }`}
                    title="一级文献（原创研究论文）"
                  >
                    一级
                  </button>
                  <button
                    onClick={() => setTierFilter(tierFilter === 2 ? 'all' : 2)}
                    className={`px-2 py-1 text-xs rounded transition ${
                      tierFilter === 2
                        ? 'bg-purple-100 text-purple-700 font-medium'
                        : 'text-slate-500 hover:bg-slate-100'
                    }`}
                    title="二级文献（综述 / meta 分析等二手文献）"
                  >
                    二级
                  </button>
                </>
              )}
            </div>
          </div>
          </div>
          <div className="flex-auto min-h-0 overflow-y-auto">
          {isBook ? (
            booksLoading ? (
              <div className="text-center py-8 text-slate-400 text-sm">
                <div className="w-8 h-8 border-2 border-slate-200 border-t-indigo-500 rounded-full animate-spin mx-auto mb-2" />
                <p>加载中...</p>
              </div>
            ) : books.length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-sm px-4">
                <BookCopy className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-slate-500 font-medium mb-1">还没有图书</p>
                <p className="text-xs text-slate-400 mb-3">
                  上传图书 PDF 转换后，正文会落到 textbooks/&lt;书名&gt;/content.md
                </p>
                <button
                  onClick={() => navigate('/management')}
                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-indigo-600 text-white text-xs rounded-md hover:bg-indigo-700 transition"
                >
                  <Plus className="w-3.5 h-3.5" />
                  去上传图书
                </button>
              </div>
            ) : filteredBooks.length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-sm">
                <Search className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p>没有找到匹配的图书</p>
              </div>
            ) : (
              filteredBooks.map((b) => (
                <button
                  key={b.id}
                  onClick={() => setSelectedBookId(b.id)}
                  className={`w-full text-left p-3 border-b border-slate-100 hover:bg-slate-50 transition ${
                    selectedBookId === b.id ? 'bg-indigo-50 border-l-2 border-l-indigo-600' : ''
                  }`}
                >
                  <div className="text-sm font-medium text-slate-700 line-clamp-2 leading-snug">
                    {b.title}
                  </div>
                  <div className="flex items-center gap-2 mt-1.5">
                    {b.hasContent ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-green-100 text-green-700 rounded text-[0.625rem] font-medium">
                        <FileText className="w-3 h-3" />
                        已转换
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-[0.625rem]">
                        待转换
                      </span>
                    )}
                  </div>
                </button>
              ))
            )
          ) : isDoc ? (
            documentsLoading ? (
              <div className="text-center py-8 text-slate-400 text-sm">
                <div className="w-8 h-8 border-2 border-slate-200 border-t-indigo-500 rounded-full animate-spin mx-auto mb-2" />
                <p>加载中...</p>
              </div>
            ) : documents.length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-sm px-4">
                <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-slate-500 font-medium mb-1">还没有其他文档</p>
                <p className="text-xs text-slate-400 mb-3">
                  到管理页导入 .md 文件、粘贴 markdown 或上传 zip，
                  正文会落到 documents/&lt;目录名&gt;/content.md
                </p>
                <button
                  onClick={() => navigate('/management')}
                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-indigo-600 text-white text-xs rounded-md hover:bg-indigo-700 transition"
                >
                  <Plus className="w-3.5 h-3.5" />
                  去导入文档
                </button>
              </div>
            ) : filteredDocuments.length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-sm">
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
                  }}
                  className={`w-full text-left p-3 border-b border-slate-100 hover:bg-slate-50 transition ${
                    selectedDocumentId === d.id ? 'bg-indigo-50 border-l-2 border-l-indigo-600' : ''
                  }`}
                >
                  <div className="text-sm font-medium text-slate-700 line-clamp-2 leading-snug">
                    {d.title}
                  </div>
                  <div className="flex items-center gap-2 mt-1.5 text-xs text-slate-400">
                    {d.author ? <span className="truncate">{d.author}</span> : null}
                    {d.hasContent ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-green-100 text-green-700 rounded text-[0.625rem] font-medium">
                        <FileText className="w-3 h-3" />
                        已导入
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-[0.625rem]">
                        无正文
                      </span>
                    )}
                  </div>
                </button>
              ))
            )
          ) : papersLoading ? (
            <div className="text-center py-8 text-slate-400 text-sm">
              <div className="w-8 h-8 border-2 border-slate-200 border-t-indigo-500 rounded-full animate-spin mx-auto mb-2" />
              <p>加载中...</p>
            </div>
          ) : papers.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-sm px-4">
              <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-slate-500 font-medium mb-1">还没有添加文献</p>
              <p className="text-xs text-slate-400 mb-3">请到文献管理页添加文献后开始阅读</p>
              <button
                onClick={() => navigate('/management')}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-indigo-600 text-white text-xs rounded-md hover:bg-indigo-700 transition"
              >
                <Plus className="w-3.5 h-3.5" />
                去添加文献
              </button>
            </div>
          ) : filteredPapers.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-sm">
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
                }}
                className={`w-full text-left p-3 border-b border-slate-100 hover:bg-slate-50 transition ${
                  selectedPaperId === p.id ? 'bg-indigo-50 border-l-2 border-l-indigo-600' : ''
                }`}
              >
                <div className="text-sm font-medium text-slate-700 line-clamp-2 leading-snug">
                  {p.title}
                </div>
                <div className="text-xs text-slate-500 mt-1.5 space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate">{p.authors}</span>
                    <span>·</span>
                    <span className="flex-shrink-0">{p.year}</span>
                  </div>
                  <div className="text-slate-400 truncate">{p.journal}</div>
                  <div className="flex items-center gap-2 mt-1">
                    {p.hasMarkdown ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-green-100 text-green-700 rounded text-[0.625rem] font-medium">
                        <FileText className="w-3 h-3" />
                        Markdown
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-[0.625rem]">
                        待转换
                      </span>
                    )}
                    <span className="text-slate-400 text-[0.625rem] truncate">
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
        <div className={`flex flex-col border-t border-slate-200 ${outlineOpen ? 'min-h-0' : 'flex-none'}`}>
          <button
            onClick={() => setOutlineOpen(!outlineOpen)}
            className="w-full flex-shrink-0 flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition"
            title={outlineOpen ? '收起大纲' : '展开大纲'}
          >
            {outlineOpen ? (
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
            )}
            <ListTree className="w-3.5 h-3.5 text-indigo-600" />
            大纲
            <span className="ml-auto text-slate-400 font-normal">{outline.length}</span>
          </button>
          {outlineOpen && (
            <div className="flex-auto min-h-0 overflow-y-auto px-2 py-1 space-y-0.5">
              {outline.length === 0 && (
                <div className="text-xs text-slate-400 text-center py-3">
                  {docRef ? '暂无大纲' : '选择阅读对象后显示大纲'}
                </div>
              )}
              {outline.map((item) => (
                <button
                  key={item.anchor}
                  onClick={() => jumpToAnchor(item.anchor)}
                  className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-indigo-50 hover:text-indigo-700 transition truncate ${
                    item.anchor === activeAnchor
                      ? 'bg-indigo-50 text-indigo-700 font-medium'
                      : item.level === 1
                        ? 'font-semibold text-slate-700'
                        : item.level === 2
                          ? 'font-medium text-slate-600'
                          : 'text-slate-500'
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

      <section className="flex-1 bg-slate-50 flex flex-col min-w-0">
        {isPlain ? (
          plainId ? (
            <>
              <div className="bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                  <button
                    onClick={() => (isBook ? setSelectedBookId(null) : setSelectedDocumentId(null))}
                    className="p-1.5 text-slate-500 hover:bg-slate-100 rounded transition flex-shrink-0"
                    title="返回列表"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-700 truncate">
                      {docTitle}
                    </div>
                    <div className="text-xs text-slate-400 truncate">
                      {isBook ? '图书' : '其他文档'} · {isBook ? 'textbooks' : 'documents'}/
                      {plainId}/content.md
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => setZebraBands((v) => !v)}
                    className={`px-2 py-1.5 text-xs rounded transition flex items-center gap-1 ${
                      zebraBands ? 'bg-lime-100 text-lime-800' : 'text-slate-600 hover:bg-slate-100'
                    }`}
                    title="逐行交替底色：正文每一行交替极浅淡绿（1 行有色 / 1 行无色），按行高精确对齐，帮你锚住当前行、防看漏"
                  >
                    <Highlighter className="w-3.5 h-3.5" />
                    隔行底色
                  </button>
                  <div className="w-px h-5 bg-slate-200 mx-1" />
                  <button
                    onClick={() => setFontSize((s) => Math.max(12, s - 1))}
                    className="p-1.5 text-slate-500 hover:bg-slate-100 rounded transition"
                    title="减小字号"
                  >
                    <ZoomOut className="w-4 h-4" />
                  </button>
                  <span className="text-xs text-slate-400 w-8 text-center">{fontSize / 16}rem</span>
                  <button
                    onClick={() => setFontSize((s) => Math.min(24, s + 1))}
                    className="p-1.5 text-slate-500 hover:bg-slate-100 rounded transition"
                    title="增大字号"
                  >
                    <ZoomIn className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto" ref={scrollRef} onScroll={handleReaderScroll}>
                {plainLoading ? (
                  <div className="flex items-center justify-center py-16 text-slate-400 text-sm">
                    <div className="text-center">
                      <div className="w-8 h-8 border-2 border-slate-200 border-t-indigo-500 rounded-full animate-spin mx-auto mb-2" />
                      <p>加载正文...</p>
                    </div>
                  </div>
                ) : bookRenderedHtml ? (
                  <div className="max-w-3xl mx-auto px-8 py-8">
                    <div
                      className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 relative"
                      style={{ fontSize: `${fontSize / 16}rem` }}
                    >
                      <div
                        ref={readerRef}
                        onMouseUp={handleTextSelection}
                        onMouseDown={() => {
                          setShowToolbar(false)
                        }}
                        className="relative prose-reader"
                        dangerouslySetInnerHTML={{ __html: bookRenderedHtml }}
                      />
                      {selectionToolbar}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-center py-16 text-slate-400">
                    <div className="text-center px-6">
                      {isDoc ? (
                        <>
                          <FileText className="w-16 h-16 mx-auto mb-3 opacity-30" />
                          <p className="text-sm text-slate-500">这个文档还没有正文</p>
                          <p className="text-xs mt-1">
                            正文应位于 documents/{plainId}/content.md
                          </p>
                        </>
                      ) : (
                        <>
                          <BookCopy className="w-16 h-16 mx-auto mb-3 opacity-30" />
                          <p className="text-sm text-slate-500">这本书还没有正文</p>
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
            <div className="flex-1 flex items-center justify-center text-slate-400">
              <div className="text-center">
                <BookCopy className="w-16 h-16 mx-auto mb-3 opacity-30" />
                <p className="text-sm">从左侧选择一本书开始阅读</p>
              </div>
            </div>
          )
        ) : selectedPaper ? (
          <>
            <div className="bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-3 min-w-0">
                <button
                  onClick={() => setSelectedPaperId(null)}
                  className="p-1.5 text-slate-500 hover:bg-slate-100 rounded transition flex-shrink-0"
                  title="返回列表"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-700 truncate">
                    {selectedPaper.title}
                  </div>
                  <div className="text-xs text-slate-400 truncate">
                    {selectedPaper.authors} · {selectedPaper.journal} · {selectedPaper.year}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => setFontSize((s) => Math.max(12, s - 1))}
                  className="p-1.5 text-slate-500 hover:bg-slate-100 rounded transition"
                  title="减小字号"
                >
                  <ZoomOut className="w-4 h-4" />
                </button>
                <span className="text-xs text-slate-400 w-8 text-center">{fontSize / 16}rem</span>
                <button
                  onClick={() => setFontSize((s) => Math.min(24, s + 1))}
                  className="p-1.5 text-slate-500 hover:bg-slate-100 rounded transition"
                  title="增大字号"
                >
                  <ZoomIn className="w-4 h-4" />
                </button>
                <div className="w-px h-5 bg-slate-200 mx-1" />
                <button
                  onClick={exportAllAnnotations}
                  disabled={paperAnnotations.length === 0}
                  className="px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                  title="导出全部批注"
                >
                  <Download className="w-3.5 h-3.5" />
                  导出批注
                </button>
                <button
                  onClick={exportNote}
                  disabled={!currentNoteMd.trim()}
                  className="px-2.5 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                  title="导出笔记"
                >
                  <Download className="w-3.5 h-3.5" />
                  导出笔记
                </button>
                <div className="w-px h-5 bg-slate-200 mx-1" />
                <button
                  onClick={() => setZebraBands((v) => !v)}
                  className={`px-2.5 py-1.5 text-xs rounded transition flex items-center gap-1 ${
                    zebraBands ? 'bg-lime-100 text-lime-800' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                  title="逐行交替底色：正文每一行交替极浅淡绿（1 行有色 / 1 行无色），按行高精确对齐，帮你锚住当前行、防段内串行（不改字号字色）"
                >
                  <Highlighter className="w-3.5 h-3.5" />
                  隔行底色
                </button>
                <div className="w-px h-5 bg-slate-200 mx-1" />
                {editMode ? (
                  <>
                    <span className="text-xs text-slate-400 px-1">编辑中 · {articleSourceLabel}</span>
                    <button
                      onClick={saveArticle}
                      disabled={articleSaving}
                      className="px-2.5 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 transition disabled:opacity-50 flex items-center gap-1"
                      title="保存到仓库"
                    >
                      <Save className="w-3.5 h-3.5" />
                      {articleSaving ? '保存中…' : '保存'}
                    </button>
                    <button
                      onClick={() => { setEditMode(false); setArticleDraft('') }}
                      disabled={articleSaving}
                      className="px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded transition disabled:opacity-50"
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
                      className="px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded transition flex items-center gap-1"
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
                      className="px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded transition flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                      title="编辑模式开关：开启后可修改文献正文"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      编辑
                    </button>
                  </>
                )}
              </div>
            </div>

            <div
              className={editMode ? 'flex-1 min-h-0' : 'flex-1 overflow-y-auto'}
              ref={scrollRef}
              onScroll={handleReaderScroll}
            >
              {selectedPaper.hasMarkdown && selectedPaper.markdownContent ? (
                editMode ? (
                  <VditorEditor
                    ref={articleVditorRef}
                    value={articleDraft}
                    onChange={setArticleDraft}
                    height="100%"
                    placeholder="编辑文献 Markdown（⟨⟨⟨…⟩⟩⟩ 为块元信息，改动正文即可）"
                    className="h-full"
                  />
                ) : (
                <div className="max-w-3xl mx-auto px-8 py-8">
                  <div
                    className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 relative"
                    style={{ fontSize: `${fontSize / 16}rem` }}
                  >
                    <div
                      ref={readerRef}
                      onMouseUp={handleTextSelection}
                      onMouseDown={() => {
                        setShowToolbar(false)
                      }}
                      className="relative prose-reader"
                      dangerouslySetInnerHTML={{ __html: paperRenderedHtml }}
                    />
                    {selectionToolbar}
                  </div>
                </div>
                )
              ) : (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center text-slate-400">
                    <FileText className="w-16 h-16 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">暂无 Markdown 内容</p>
                    <p className="text-xs mt-1">请先使用 MinerU 将 PDF 转换为 Markdown</p>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-400">
            <div className="text-center">
              <BookOpen className="w-16 h-16 mx-auto mb-3 opacity-30" />
              <p className="text-sm">从左侧选择一篇文献开始阅读</p>
            </div>
          </div>
        )}
      </section>

      {/* 右栏：问 AI / 笔记 / 批注 —— 文献与图书同一套 */}
      <aside className="w-80 bg-white border-l border-slate-200 flex flex-col flex-shrink-0">
        <div className="flex border-b border-slate-200 flex-shrink-0">
          <button
            onClick={() => setActiveSideTab('ask')}
            className={`flex-1 px-2 py-2.5 text-xs font-medium transition flex items-center justify-center gap-1 ${
              activeSideTab === 'ask'
                ? 'text-indigo-600 border-b-2 border-indigo-600 bg-indigo-50/30'
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            问 AI
          </button>
          <button
            onClick={() => setActiveSideTab('notes')}
            className={`flex-1 px-2 py-2.5 text-xs font-medium transition flex items-center justify-center gap-1 ${
              activeSideTab === 'notes'
                ? 'text-indigo-600 border-b-2 border-indigo-600 bg-indigo-50/30'
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            }`}
          >
            <StickyNote className="w-4 h-4" />
            笔记
          </button>
          <button
            onClick={() => setActiveSideTab('annotations')}
            className={`flex-1 px-2 py-2.5 text-xs font-medium transition flex items-center justify-center gap-1 ${
              activeSideTab === 'annotations'
                ? 'text-indigo-600 border-b-2 border-indigo-600 bg-indigo-50/30'
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Highlighter className="w-4 h-4" />
            批注
            {paperAnnotations.length > 0 && (
              <span className="px-1.5 py-0.5 text-[0.625rem] bg-indigo-100 text-indigo-600 rounded-full font-medium">
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
              docMarkdown={isPlain ? plainMarkdown : (aligned_content.trim() || selectedPaper?.markdownContent || '')}
              selectedText={selectedText}
            />
          ) : activeSideTab === 'notes' ? (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-end flex-shrink-0 bg-slate-50/50">
                <button
                  onClick={exportNote}
                  disabled={!docRef || !currentNoteMd.trim()}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 rounded transition disabled:opacity-40 disabled:cursor-not-allowed font-medium"
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
                  />
                ) : (
                  <div className="text-center text-slate-400 py-8">
                    <StickyNote className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">选择文献或图书后开始记笔记</p>
                  </div>
                )}
              </div>

              <div className="px-3 py-2 border-t border-slate-100 flex items-center justify-between flex-shrink-0 bg-slate-50/50">
                <div className="flex items-center gap-1.5 text-xs text-slate-400">
                  {noteSaveState.status === 'saving' && (
                    <>
                      <span className="w-2.5 h-2.5 border border-slate-300 border-t-indigo-500 rounded-full animate-spin" />
                      <span className="text-indigo-600">保存中...</span>
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
                <span className="text-xs text-slate-400 font-mono">
                  {wordCount} 字
                </span>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col">
              <div className="px-3 py-2 border-b border-slate-100 flex-shrink-0 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500">
                    共 <span className="font-medium text-slate-700">{paperAnnotations.length}</span> 条批注
                  </span>
                  <button
                    onClick={exportAllAnnotations}
                    disabled={paperAnnotations.length === 0}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 rounded transition disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                  >
                    <Download className="w-3.5 h-3.5" />
                    导出全部
                  </button>
                </div>
                {/* 批量操作条 —— 批注一多，逐条点 × 删太折磨 */}
                {paperAnnotations.length > 0 && (
                  <div className="flex items-center gap-2 text-xs">
                    <label className="flex items-center gap-1.5 cursor-pointer text-slate-600 select-none">
                      <input
                        type="checkbox"
                        className="w-3.5 h-3.5 accent-indigo-600"
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
                      <span className="text-slate-400">已选 {checkedAnnotationIds.length} 条</span>
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
                        className="px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 transition disabled:opacity-40 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
                      >
                        删除选中
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`确定清空全部 ${paperAnnotations.length} 条批注吗？此操作不可撤销。`)) {
                            deleteAnnotations(paperAnnotations.map((a) => a.id))
                          }
                        }}
                        className="px-2 py-1 rounded border border-slate-200 text-slate-500 hover:bg-slate-50 transition"
                      >
                        清空
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto">
                {paperAnnotations.length === 0 ? (
                  <div className="text-center py-12 text-slate-400 text-sm">
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
                        return (
                          <div
                            key={anno.id}
                            id={`annotation-item-${anno.id}`}
                            className={`p-3 rounded-lg border-l-4 cursor-pointer transition-all ${
                              colorInfo.border
                            } ${
                              isSelected
                                ? 'ring-2 ring-indigo-300 shadow-md'
                                : 'hover:shadow-md'
                            }`}
                            onClick={() => {
                              scrollToAnnotation(anno)
                            }}
                          >
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <div className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  className="w-3.5 h-3.5 accent-indigo-600 flex-shrink-0"
                                  title="选中后可批量删除"
                                  checked={checkedAnnotationIds.includes(anno.id)}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) =>
                                    setCheckedAnnotationIds((prev) =>
                                      e.target.checked
                                        ? [...prev, anno.id]
                                        : prev.filter((x) => x !== anno.id),
                                    )
                                  }
                                />
                                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${colorInfo.dot}`} />
                                <span className={`text-xs font-medium ${colorInfo.text}`}>
                                  {colorInfo.label}批注
                                </span>
                                {/* 锚点标签：让人一眼看出这条挂在英文段还是中文段上 */}
                                {anno.anchor && (
                                  <span className="text-[10px] px-1 py-0.5 rounded bg-slate-100 text-slate-500 font-mono whitespace-nowrap">
                                    {anno.anchor.startsWith('cn-') ? '中文' : '英文'} {anno.anchor.slice(3)}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-0.5">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    if (isEditing) {
                                      setEditingAnnotationId(null)
                                    } else {
                                      setEditingAnnotationId(anno.id)
                                      setTimeout(() => {
                                        annotationEditRefs.current[anno.id]?.focus()
                                      }, 0)
                                    }
                                  }}
                                  className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-white/60 rounded transition"
                                  title={isEditing ? '完成编辑' : '编辑批注'}
                                >
                                  {isEditing ? (
                                    <Check className="w-3 h-3" />
                                  ) : (
                                    <Edit3 className="w-3 h-3" />
                                  )}
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    if (confirm('确定删除这条批注吗？')) {
                                      deleteAnnotation(anno.id)
                                    }
                                  }}
                                  className="p-1 text-slate-400 hover:text-red-600 hover:bg-white/60 rounded transition"
                                  title="删除批注"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                            <blockquote className={`mb-3 pl-3 py-1 border-l-4 ${colorInfo.border.split(' ')[0]} ${colorInfo.bg} rounded-r`}>
                              <p className="text-sm text-slate-600 italic leading-relaxed">
                                "{anno.text}"
                              </p>
                            </blockquote>
                            {isEditing ? (
                              <div onClick={(e) => e.stopPropagation()}>
                                <textarea
                                  ref={(el) => {
                                    annotationEditRefs.current[anno.id] = el
                                  }}
                                  value={anno.note}
                                  onChange={(e) => updateAnnotationNote(anno.id, e.target.value)}
                                  placeholder="输入批注内容（支持Markdown）..."
                                  className="w-full h-28 p-2 text-xs border border-slate-200 rounded resize-none focus:outline-none focus:border-indigo-400 bg-white"
                                />
                                <div className="text-xs text-slate-400 mt-1">支持 Markdown 格式 · 自动保存</div>
                              </div>
                            ) : (
                              anno.note && (
                                <div className="text-sm text-slate-700">
                                  <div
                                    className="prose-sm max-w-none"
                                    dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(anno.note) }}
                                  />
                                </div>
                              )
                            )}
                            {!isEditing && !anno.note && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setEditingAnnotationId(anno.id)
                                  setTimeout(() => {
                                    annotationEditRefs.current[anno.id]?.focus()
                                  }, 0)
                                }}
                                className="text-xs text-indigo-500 hover:text-indigo-700 font-medium"
                              >
                                + 添加批注内容
                              </button>
                            )}
                            <div className="mt-2 flex items-center gap-1 text-xs text-slate-400">
                              <Clock className="w-3 h-3" />
                              {formatDate(anno.createdAt)}
                              <ChevronRight className="w-3 h-3 ml-auto" />
                            </div>
                          </div>
                        )
                      })}
                  </div>
                )}
              </div>

              <div className="px-3 py-2 border-t border-slate-100 flex items-center justify-between flex-shrink-0 bg-slate-50/50">
                <div className="flex items-center gap-1.5 text-xs text-slate-400">
                  {annotationSaveState.status === 'saving' && (
                    <>
                      <span className="w-2.5 h-2.5 border border-slate-300 border-t-indigo-500 rounded-full animate-spin" />
                      <span className="text-indigo-600">保存中...</span>
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
    </div>
  )
}
