import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { loadLiteratures, saveLiteratures, doiToSlug, inferPaperTier, inferMdStatusByDoi, type Literature } from '../services/literatureData'
import { loadTextbooks, saveTextbooks, bookHasContent, type Textbook } from '../services/textbookData'
import {
  loadMaterialMeta,
  saveMaterialMeta,
  taskOf,
  tagsOf,
  setMeta,
  dropMeta,
  type MaterialMeta,
} from '../services/materialMeta'
import {
  loadProjects,
  buildTaskFilterOptions,
  taskFilterMatches,
  type Project,
  type TaskFilterOption,
} from '../services/projectData'
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
import { useTaskStore } from '../stores/task'
import { githubFetch, deleteRepoFiles } from '../services/github'
import { pollProgressJson, pollBookProgressJson, pollNoteConvertProgress, getRun, getLatestRun, dispatchPaperConvert } from '../services/workflowClient'
import { invalidateCache } from '../services/userData'
import { noteHasContent } from '../services/readingDocData'
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
  isValidMorphemeSplit, MORPHEME_TYPE_LABELS,
} from '../services/learningData'
import type { WordData, Morpheme, MorphemeType } from '../services/learningData'
import { normalizeDoi, getCitationEntries, cleanAbstract } from '../services/citation'
import { loadJournalAbbrevMap, saveJournalAbbrev, mergeJournalAbbrevs, lookupJournalAbbrevsWithAI } from '../services/journalAbbrev'
import {
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
  Image as ImageIcon,
  Link as LinkIcon,
  StickyNote,
  Github,
  Sparkles,
  ExternalLink,
  CheckSquare,
  Folder,
  MoveRight,
  Tag,
  ListTodo,
  Pencil,
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
import { listNotes, type DocRef } from '../services/readingDocData'
import { loadAnnotations } from '../services/annotationData'
import BookEditModal from '../components/BookEditModal'

type SubTabId = 'library' | 'templates' | 'knowledge' | 'documents' | 'import-export'

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
  /** 归属任务（projects.csv 的 project_id）；空串 = 未归属 */
  taskId: string
  /** 自由标签，可被检索 */
  tags: string[]
  /** 追踪页给它打的分组；只读保留 */
  trackingGroup: string
  /**
   * 摘要。来自 DOI 元数据（Crossref / OpenAlex）或转换为 md 时的抽取。
   * 必须在这里带着走：它是摘要翻译练习的题面/参考答案来源，
   * 一旦在读写链路里被抹成空串，那道题就再也出不来（见 paperToLiterature）。
   */
  abstractEn: string
  abstractCn: string
  /**
   * 通讯作者。Crossref 元数据里没有，只能从 PDF/md 抽取 ——
   * 转换流程跑完由后端写进 CSV。为空时界面就不显示通讯那一行。
   */
  correspondingAuthor: string
}

/** UI 层期刊模板项 —— 包装后端 JournalTemplate，加派生字段方便显示 */
interface JournalTemplateItem {
  id: string
  name: string
  publisher: string
  issn: string
  lastUpdated: string
  isDefault: boolean
  /** 投稿须知原文（用户粘贴的源材料） */
  guidelinesContent: string
  /** 格式规范摘要（用户确认/编辑过，落 meta.md 的 notes） */
  formatSummary: string
}

/** 后端 JournalTemplate → UI JournalTemplateItem */
function toTemplateItem(t: BackendJournalTemplate): JournalTemplateItem {
  const parts = [
    t.title_format_note && `标题: ${t.title_format_note}`,
    t.abstract_format_note && `摘要: ${t.abstract_format_note}`,
    t.reference_format_note && `参考文献: ${t.reference_format_note}`,
  ].filter(Boolean)
  // 摘要优先取用户存过的 notes；没有才用投稿须知/格式说明拼一份只读兜底（仅显示用）
  const summary =
    (t.notes || '').trim() ||
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
    guidelinesContent: t.guidelines_content || '',
    formatSummary: summary,
  }
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
  taskId: string
  tags: string[]
}

const subTabs: { id: SubTabId; label: string; icon: typeof BookMarked }[] = [
  { id: 'library', label: '文献库', icon: BookMarked },
  { id: 'knowledge', label: '图书库', icon: BookCopy },
  { id: 'documents', label: '其他文档', icon: FileText },
  { id: 'templates', label: '期刊模板', icon: BookOpen },
  { id: 'import-export', label: '导入导出', icon: ArrowLeftRight },
]

const PAGE_SIZE = 10

/**
 * 管理页列表通用翻页条 —— 文献 / 图书 / 期刊模板 / 其他文档四处共用同一套口径。
 * 排版对齐、常驻可见；工作台里靠翻页而不是上下滚动来浏览列表（见 UX_DETAILS）。
 */
function PaginationBar({
  total,
  page,
  totalPages,
  onPage,
}: {
  total: number
  page: number
  totalPages: number
  onPage: (p: number) => void
}) {
  if (totalPages <= 0) return null
  return (
    <div className="af-line-t flex items-center justify-between px-ui-gap py-3 bg-paper-100/50">
      <div className="text-ui-sm text-ink-500">
        共 {total} 条，第 {page} / {totalPages} 页
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPage(Math.max(1, page - 1))}
          disabled={page === 1}
          className="p-1.5 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded-control-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
          <button
            key={p}
            onClick={() => onPage(p)}
            className={`w-8 h-8 text-ui-sm rounded-control-sm transition ${
              page === p ? 'bg-seal-600 text-paper-50' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-700'
            }`}
          >
            {p}
          </button>
        ))}
        <button
          onClick={() => onPage(Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
          className="p-1.5 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded-control-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

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
    // 任务 / 标签关系存在 materials/meta.csv，加载时再填进来（见 loadData）
    taskId: '',
    tags: [],
    trackingGroup: lit.trackingGroup,
    abstractEn: lit.abstractEn || '',
    abstractCn: lit.abstractCn || '',
    correspondingAuthor: lit.correspondingAuthor || '',
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
    // 摘要必须原样回写。曾经这里写死 ''，导致用户在管理页保存任意一次文献后，
    // 转换流程抽出来的摘要就被清空，摘要翻译练习随之再也出不来。
    abstractEn: paper.abstractEn || '',
    abstractCn: paper.abstractCn || '',
    tier: paper.tier,
    hasGraphicalAbstract: !!paper.coverImage,
    addedAt: Date.now(),
    pdfAddedAt: 0,
    source: 'manual',
    // 追踪分组与文献分类是两回事，原样带回，不要被分类覆盖
    trackingGroup: paper.trackingGroup || '',
    mdStatus: paper.mdStatus || 'none',
    correspondingAuthor: paper.correspondingAuthor || '',
  }
}

/** 作者名里可能残留的标记符号：通讯 `*`、共一 `†/‡`、脚注 `#`、CSV 逃逸 `"` */
const AUTHOR_MARKERS = /[*†‡#"]/g

/** 单个作者名清洗：去引号/标记、吃掉分隔用的 `and`、压缩空白 */
function cleanAuthorName(raw: string): string {
  return raw
    .replace(/\band\b/gi, ' ')
    .replace(AUTHOR_MARKERS, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 把 authors 字符串拆成作者列表（仅显示用清洗，不改数据）。
 * authors 形如 "San Zhang, Si Li, Wu Wang"，可能带 `*` 通讯标记；
 * 库里数据来源多（PDF 抽取 / Crossref / 手填），可能残留 CSV 双重转义引号、
 * markdown 粗体星号、末尾英文 `and`，这里一并清掉。
 * 返回的 starred 表示该名字自带 `*`（后端从 PDF 抽出的通讯标记）。
 */
function splitAuthors(authors: string): { name: string; starred: boolean }[] {
  // CSV 里含逗号的字段会被整体加引号，二次转义后会残留成 `"""name, name"""`，
  // 先归一化各种引号、再去掉整串外层多余的引号（成对或成串都吃掉）。
  const unquoted = (authors || '')
    .replace(/[“”‘’]/g, '"')
    .trim()
    .replace(/^["']+/, '')
    .replace(/["']+$/, '')
  return unquoted
    .split(/[,，;；]/)
    .map((raw) => ({ name: cleanAuthorName(raw), starred: /[*†‡]/.test(raw) }))
    .filter((a) => a.name)
}

/** 通讯作者名字集合（后端用 `; ` 连接多个，这里逗号/分号都兼容） */
function correspondingNames(correspondingAuthor: string): Set<string> {
  return new Set(
    (correspondingAuthor || '')
      .replace(/[“”‘’]/g, '"')
      .split(/[,，;；]/)
      .map((s) => cleanAuthorName(s))
      .filter(Boolean),
  )
}

/** 文献分级配色：一级（原创）暖色 amber，二级（综述等二手文献）冷色 sky。
 *  用「整行底色 + 页签底色」区分，不在标题前放图标（图标占格子且不表意）。 */
const TIER_STYLE = {
  1: {
    row: 'bg-amber-50/40 hover:bg-amber-100/50',
    // 选中态整块上色；未选中态也保留淡色，保证两个页签**始终**能靠颜色区分
    tab: 'bg-amber-100 text-amber-700 border border-amber-300',
    tabIdle: 'bg-amber-50/50 text-amber-700/80 border border-amber-200/60 hover:bg-amber-100/60',
  },
  2: {
    row: 'bg-sky-50/40 hover:bg-sky-100/50',
    tab: 'bg-sky-100 text-sky-700 border border-sky-300',
    tabIdle: 'bg-sky-50/50 text-sky-700/80 border border-sky-200/60 hover:bg-sky-100/60',
  },
} as const

function textbookToBookItem(tb: Textbook): BookItem {
  return {
    id: tb.textbookId,
    title: tb.title,
    author: tb.author,
    publisher: tb.publisher,
    year: tb.year,
    addedAt: tb.addedAt,
    status: 'done',
    progress: 100,
    taskId: '',
    tags: [],
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
    <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap px-1.5 py-0.5 rounded-full text-ui-xs font-medium ${color}`}>
      <Icon className={`w-3 h-3 shrink-0 ${status === 'converting' ? 'animate-spin' : ''}`} />
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
    <span className={`inline-flex shrink-0 items-center whitespace-nowrap px-1.5 py-0.5 rounded-full text-ui-xs font-medium ${color}`}>
      {label}
    </span>
  )
}

function Modal({ title, onClose, children, width = 'max-w-lg' }: { title: string; onClose: () => void; children: React.ReactNode; width?: string }) {
  return (
    <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center z-50 p-4">
      <div className={`bg-paper-50 rounded-card shadow-xl w-full ${width} max-h-[90vh] overflow-hidden flex flex-col`}>
        <div className="af-line-b flex items-center justify-between px-6 py-4">
          <h3 className="font-semibold text-ink-800">{title}</h3>
          <button onClick={onClose} className="p-1 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded-control transition">
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
      <img src={src} alt="" className="max-w-full max-h-full object-contain rounded-control" onClick={(e) => e.stopPropagation()} />
      <button onClick={onClose} className="absolute top-4 right-4 p-2 text-paper-50/70 hover:text-paper-50 hover:bg-paper-50/10 rounded-control transition">
        <X className="w-6 h-6" />
      </button>
    </div>
  )
}

/**
 * 「编辑文献」弹窗里的词根词缀核对区。
 *
 * 为什么挂在这儿：切分是 AI 从这篇文献的正文里提词时一起产出的，改它是**补锅**而不是日常 ——
 * 跟改文献元数据同一个入口，用户不必为此再学一套独立的编辑流程。
 * 只列本篇提取出的词（source_doi === 该文献 doi）。
 */
function PaperMorphemeSection({
  doi,
  words,
  onChange,
}: {
  doi: string
  words: WordData[] | null
  onChange: (next: WordData[]) => void
}) {
  const mine = useMemo(
    () => (words || []).filter((w) => w.sourceDoi && w.sourceDoi === doi),
    [words, doi],
  )
  const [open, setOpen] = useState(false)

  const label = <label className="block text-ui-sm font-medium text-ink-700">词根词缀</label>

  if (words === null) {
    return (
      <div>
        <div className="mb-1.5">{label}</div>
        <div className="p-3 border border-ink-200 rounded-control bg-paper-100/50 text-ui-xs text-ink-400">
          正在读取本文提取的字词…
        </div>
      </div>
    )
  }
  if (mine.length === 0) {
    return (
      <div>
        <div className="mb-1.5">{label}</div>
        <div className="p-3 border border-ink-200 rounded-control bg-paper-100/50 text-ui-xs text-ink-400">
          这篇文献还没有提取出单词 —— 转换 PDF 时会自动提取并切分。
        </div>
      </div>
    )
  }
  const splitCount = mine.filter((w) => isValidMorphemeSplit(w.word, w.morphemes)).length
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        {label}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-ui-xs text-seal-600 hover:underline"
        >
          {open ? '收起' : `展开核对（${splitCount}/${mine.length} 个词已切分）`}
        </button>
      </div>
      <div className="p-3 border border-ink-200 rounded-control bg-paper-100/50">
        <p className="text-ui-xs text-ink-400">
          只有确实能拆成词缀的词才需要切分，拆不开就留空（学习时按整词/逐字母处理）。
          这里改的是 AI 的产出，属于修正而非日常操作。
        </p>
        {open && (
          <div className="mt-3 space-y-3 max-h-72 overflow-y-auto">
            {mine.map((w) => (
              <MorphemeSplitEditor
                key={w.id}
                word={w.word}
                morphemes={w.morphemes || []}
                onChange={(next) =>
                  onChange(words.map((x) => (x.id === w.id ? { ...x, morphemes: next } : x)))
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 单个单词的切分编辑：上面一行用 · 分隔写切分，下面按片段配类型与含义。
 * 片段文本没变就沿用原来的类型/含义 —— 用户加/删一个片段不必重填其它片段的含义。
 */
function MorphemeSplitEditor({
  word,
  morphemes,
  onChange,
}: {
  word: string
  morphemes: Morpheme[]
  onChange: (next: Morpheme[]) => void
}) {
  const [split, setSplit] = useState(() => morphemes.map((m) => m.text).join('·'))

  const derive = (raw: string): Morpheme[] =>
    raw
      .split('·')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((text) => {
        const prev = morphemes.find((m) => m.text === text)
        return prev ? { ...prev, text } : { text, type: 'root' as MorphemeType, meaning: '' }
      })

  const segments = derive(split)
  const matched = isValidMorphemeSplit(word, segments)

  const patch = (i: number, key: 'type' | 'meaning', value: string) => {
    onChange(segments.map((m, k) => (k === i ? { ...m, [key]: value } : m)))
  }

  return (
    <div className="bg-paper-50 border border-ink-200 rounded-control p-3">
      <div className="flex items-center gap-2">
        <span className="text-ui-sm font-semibold text-ink-800 shrink-0">{word}</span>
        <input
          type="text"
          value={split}
          onChange={(e) => { setSplit(e.target.value); onChange(derive(e.target.value)) }}
          placeholder="用 · 分隔，如 photo·synth·esis；留空 = 不拆"
          className="flex-1 min-w-0 px-2 py-1 border border-ink-200 rounded-control-sm text-ui-xs focus:outline-none focus:border-seal-400"
        />
      </div>
      {segments.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {segments.map((m, i) => (
            <div key={`${m.text}-${i}`} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-ui-xs font-medium text-seal-700 truncate">{m.text}</span>
              <select
                value={m.type}
                onChange={(e) => patch(i, 'type', e.target.value)}
                className="px-1.5 py-1 border border-ink-200 rounded-control-sm text-ui-xs bg-paper-50"
              >
                {(Object.keys(MORPHEME_TYPE_LABELS) as MorphemeType[]).map((t) => (
                  <option key={t} value={t}>{MORPHEME_TYPE_LABELS[t]}</option>
                ))}
              </select>
              <input
                type="text"
                value={m.meaning}
                onChange={(e) => patch(i, 'meaning', e.target.value)}
                placeholder="含义，如 光"
                className="flex-1 min-w-0 px-2 py-1 border border-ink-200 rounded-control-sm text-ui-xs focus:outline-none focus:border-seal-400"
              />
            </div>
          ))}
          <p className={`text-ui-xs ${matched ? 'text-green-600' : 'text-red-500'}`}>
            {matched
              ? '✓ 各段拼起来正好是原词'
              : `各段拼起来是「${segments.map((m) => m.text).join('')}」，跟原词对不上 —— 学习时会当作未切分`}
          </p>
        </div>
      )}
    </div>
  )
}

/** 归属任务下拉：未归属 / 本任务（当前任务，置顶）/ 其余任务（按层级缩进） */
function TaskSelect({
  value,
  onChange,
  tasks,
  currentProjectId,
}: {
  value: string
  onChange: (v: string) => void
  tasks: Project[]
  currentProjectId?: string | null
}) {
  const byId = new Map(tasks.map((t) => [t.projectId, t]))
  const childrenByParent = new Map<string, Project[]>()
  for (const t of tasks) {
    const key = t.parentId && byId.has(t.parentId) ? t.parentId : ''
    const arr = childrenByParent.get(key)
    if (arr) arr.push(t)
    else childrenByParent.set(key, [t])
  }
  const current = currentProjectId ? byId.get(currentProjectId) : undefined
  const rows: { id: string; title: string; depth: number }[] = []
  const walk = (parentKey: string, depth: number) => {
    for (const t of childrenByParent.get(parentKey) ?? []) {
      if (current && t.projectId === current.projectId) {
        walk(t.projectId, depth)
        continue
      }
      rows.push({ id: t.projectId, title: t.title, depth })
      walk(t.projectId, depth + 1)
    }
  }
  walk('', 0)
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-ui-gap py-2 text-ui-sm border border-ink-200 rounded-control bg-paper-50 focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
    >
      <option value="">未归属</option>
      {current && <option value={current.projectId}>本任务 · {current.title}</option>}
      {rows.map((r) => (
        <option key={r.id} value={r.id}>
          {r.depth > 0 ? `${'　'.repeat(r.depth)}${r.title}` : r.title}
        </option>
      ))}
    </select>
  )
}

/** 标签编辑器：回车 / 逗号添加，退格删除末尾，chip 可点 × 移除 */
function TagEditor({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const t = draft.trim()
    if (t && !value.includes(t)) onChange([...value, t])
    setDraft('')
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 min-h-[2.5rem] border border-ink-200 rounded-control bg-paper-50 focus-within:border-seal-400 focus-within:ring-2 focus-within:ring-seal-100">
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 px-2 py-0.5 bg-seal-100 text-seal-700 text-ui-xs rounded-control-sm"
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(value.filter((x) => x !== tag))}
            className="text-seal-500 hover:text-seal-800"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ',' || e.key === '、') && !e.nativeEvent.isComposing) {
            e.preventDefault()
            add()
          } else if (e.key === 'Backspace' && !draft && value.length > 0) {
            onChange(value.slice(0, -1))
          }
        }}
        onBlur={add}
        placeholder={value.length ? '' : '输入标签后回车'}
        className="flex-1 min-w-[6rem] bg-transparent text-ui-sm focus:outline-none"
      />
    </div>
  )
}

export default function ManagementPage() {
  const navigate = useNavigate()
  const { repo } = useWorkspaceStore()
  const auth = useAuthStore()
  const owner = repo?.owner?.login ?? auth.user?.login ?? ''
  const token = auth.token ?? ''
  // 全局当前任务：全站「任务过滤」三类口径的唯一来源
  const currentProjectId = useTaskStore((s) => s.currentProjectId)
  const isTaskLoaded = useTaskStore((s) => s.isLoaded)
  const loadCurrentTask = useTaskStore((s) => s.loadCurrent)
  useEffect(() => {
    if (!isTaskLoaded) void loadCurrentTask()
  }, [isTaskLoaded, loadCurrentTask])
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
  /**
   * 编辑弹窗里的笔记面板：真实反映这篇文献的笔记（notes/{名称}.md）与批注数量。
   * 以前这里是「hasNotes 就地取反」的假开关，点一下有、再点一下无，毫无意义。
   */
  const [paperNoteInfo, setPaperNoteInfo] = useState<{
    loading: boolean
    notes: string[]
    annotations: number
  }>({ loading: false, notes: [], annotations: 0 })
  /**
   * 「编辑文献」弹窗里的词根词缀修正。
   * 文献是从原文提取单词的源头，所以"改切分"这件事挂在这里，跟改文献元数据同一个入口 ——
   * 它是补锅手段，不是日常操作（日常全靠 AI 提取时切好）。
   * 存的是**全量**单词（saveWords 是整表重写），null = 还没读回来。
   */
  const [paperWords, setPaperWords] = useState<WordData[] | null>(null)
  const [paperWordsDirty, setPaperWordsDirty] = useState(false)
  const [papers, setPapers] = useState<Paper[]>([])
  const [newPaper, setNewPaper] = useState({ title: '', authors: '', year: '', journal: '', doi: '', keywords: '', abstractEn: '', abstractCn: '', tier: 'auto' as 'auto' | '1' | '2', taskId: '', tags: [] as string[] })
  const [doiFetching, setDoiFetching] = useState(false)
  const [doiFetchError, setDoiFetchError] = useState<string | null>(null)
  const [doiQuickInput, setDoiQuickInput] = useState('')
  const [isAddingByDoi, setIsAddingByDoi] = useState(false)
  const [selectedPapers, setSelectedPapers] = useState<Set<string>>(new Set())
  const [batchMode, setBatchMode] = useState(false)
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())
  /** 期刊缩写本地覆盖表（全名 → 缩写） */
  const [journalAbbrevMap, setJournalAbbrevMap] = useState<Record<string, string>>({})
  // ── 统一分类体系：分类 = 归属任务（Project），标签 = 自由标注（MaterialMeta） ──
  /** 全部任务（左栏任务面板 / 归属下拉的数据源） */
  const [tasks, setTasks] = useState<Project[]>([])
  /** 材料元数据单一真源：任务归属 + 标签 */
  const [materialMeta, setMaterialMeta] = useState<MaterialMeta[]>([])
  /** 左栏选中的任务过滤：'all' | 'cat:research' | 'cat:course' | 'node:<projectId>' */
  const [activeTaskId, setActiveTaskId] = useState<string>('all')
  /** 任务面板里已展开的节点（默认全折叠，只有用户手动展开才显示子任务） */
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set())
  /** 选中的标签过滤（空串 = 不过滤） */
  const [tagFilter, setTagFilter] = useState<string>('')
  const [showBatchMoveModal, setShowBatchMoveModal] = useState(false)
  const [batchMoveTaskId, setBatchMoveTaskId] = useState<string>('')

  // 期刊模板状态
  const [templates, setTemplates] = useState<JournalTemplateItem[]>([])
  const [templateSearch, setTemplateSearch] = useState('')
  const [templatePage, setTemplatePage] = useState(1)
  const [showTemplateModal, setShowTemplateModal] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<JournalTemplateItem | null>(null)
  const [newTemplate, setNewTemplate] = useState({ name: '', issn: '', publisher: '', guidelines: '', formatSummary: '' })
  const [isExtracting, setIsExtracting] = useState(false)

  // 知识库状态
  const [books, setBooks] = useState<BookItem[]>([])
  const [bookSearch, setBookSearch] = useState('')
  const [bookPage, setBookPage] = useState(1)
  const [showBookDetail, setShowBookDetail] = useState<BookItem | null>(null)
  const [isDragOverBook, setIsDragOverBook] = useState(false)
  const [showUploadBookModal, setShowUploadBookModal] = useState(false)
  /** 上传图书弹窗里正在编辑的任务归属 + 标签 */
  const [uploadBookTaskId, setUploadBookTaskId] = useState<string>('')
  const [uploadBookTags, setUploadBookTags] = useState<string[]>([])
  /** 图书详情弹窗里正在编辑的任务 / 标签（保存时才写回） */
  const [bookDetailTaskId, setBookDetailTaskId] = useState<string>('')
  const [bookDetailTags, setBookDetailTags] = useState<string[]>([])
  /** 打开「编辑图书」弹窗的目标书名（null = 未打开；书名 = 目录名 = 主键） */
  const [editingBookId, setEditingBookId] = useState<string | null>(null)
  /** 图书列表强制刷新计数：改名 / 保存正文后自增触发重载 */
  const [booksReloadKey, setBooksReloadKey] = useState(0)

  // 其他文档状态
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [documentsLoading, setDocumentsLoading] = useState(false)
  const [documentSearch, setDocumentSearch] = useState('')
  const [documentPage, setDocumentPage] = useState(1)
  const [showImportDocModal, setShowImportDocModal] = useState(false)
  /** 导入弹窗的三种方式：上传 .md / 粘贴文本 / 上传 zip */
  const [importMode, setImportMode] = useState<'file' | 'paste' | 'zip'>('file')
  const [pasteDoc, setPasteDoc] = useState({ title: '', content: '' })
  const [importing, setImporting] = useState(false)
  const [editingDocument, setEditingDocument] = useState<DocumentSummary | null>(null)
  const [editDocForm, setEditDocForm] = useState({ title: '', author: '', taskId: '', tags: [] as string[] })
  const [savingDocument, setSavingDocument] = useState(false)
  // 文献 / 模板保存中：禁用对应按钮并显示「保存中…」
  const [savingPaper, setSavingPaper] = useState(false)
  const [savingTemplate, setSavingTemplate] = useState(false)

  // 后台任务状态
  const taskQueue = useTaskQueueStore()
  const taskQueueRef = useRef(taskQueue)
  taskQueueRef.current = taskQueue

  // 加载数据：三种材料 + 统一元数据（任务归属 / 标签）
  useEffect(() => {
    if (!repo) return
    const loadData = async () => {
      setDocumentsLoading(true)
      try {
        const [lits, tbs, docs, meta, projects] = await Promise.all([
          loadLiteratures(true),
          loadTextbooks(),
          listDocuments(),
          loadMaterialMeta(true),
          loadProjects(),
        ])
        setTasks(projects)
        setMaterialMeta(meta)
        // 防缓存：跳过正在删除的 ID —— 即使 CSV 还没 propagate 也不让它冒出来
        setPapers(
          lits
            .map(literatureToPaper)
            .map((p) => ({
              ...p,
              taskId: taskOf(meta, 'paper', p.doi),
              tags: tagsOf(meta, 'paper', p.doi),
            }))
            .filter((p) => !deletingIds.has(p.id)),
        )
        setBooks(
          tbs.map((tb) => ({
            ...textbookToBookItem(tb),
            taskId: taskOf(meta, 'book', tb.textbookId),
            tags: tagsOf(meta, 'book', tb.textbookId),
          })),
        )
        setDocuments(docs)
      } catch (err) {
        console.error('加载材料失败:', err)
      } finally {
        setDocumentsLoading(false)
      }
    }
    loadData()
  }, [repo, booksReloadKey])

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

  // 期刊缩写覆盖表：只在挂载时读一次
  useEffect(() => {
    loadJournalAbbrevMap().then(setJournalAbbrevMap).catch(() => {})
  }, [])

  /**
   * 第一次见到某个期刊 → 用 AI 查它的**约定俗成**缩写，结果落进覆盖表。
   *
   * 为什么必须查而不是本地推：机械取首字母给出的是 Angewandte Chemie International
   * Edition → ACIE，而学术界写的是 Angew. Chem. Int. Ed. —— 列表里显示错缩写等于摆错信息。
   *
   * 只在本会话尝试一次（abbrevTriedRef）；一次请求带上所有没查过的期刊（后端通道单次
   * 往返是分钟级，逐本查太慢）。没登录 / 没配 AI / 查不出来都静默——列表就显示原期刊名，
   * 绝不拿"取首字母"去猜（见 journalAbbrev.ts 顶部说明）。
   */
  const abbrevTriedRef = useRef(false)
  useEffect(() => {
    if (abbrevTriedRef.current || papers.length === 0) return
    const known = new Set(Object.keys(journalAbbrevMap))
    const missing = [...new Set(papers.map((p) => p.journal.trim()).filter((j) => j && !known.has(j)))]
    abbrevTriedRef.current = true
    if (missing.length === 0) return
    const { ai1 } = useSettingsStore.getState().getDualEngineConfig()
    lookupJournalAbbrevsWithAI(missing, ai1)
      .then(async (found) => {
        const hits = Object.entries(found).filter(([, v]) => v.trim())
        if (hits.length === 0) return
        setJournalAbbrevMap(await mergeJournalAbbrevs(Object.fromEntries(hits)))
      })
      .catch(() => { /* 查不到就显示原期刊名，不打扰用户 */ })
  }, [papers, journalAbbrevMap])

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
          (t.type === 'paper_convert' || t.type === 'book_convert' || t.type === 'note_convert'),
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
        const isNote = task.type === 'note_convert'
        const slug = metaSlug || doiSlug || task.book_id
        if (!slug) continue
        try {
          // 文献进度在 literatures/{slug}/，图书在 textbooks/{书名}/，笔记在其所属文档目录下
          const prog = isBook
            ? await pollBookProgressJson(slug, owner, repo.name, token)
            : isNote
              ? await pollNoteConvertProgress(slug, owner, repo.name, token)
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
              //
              // 图书没有 doi，得走 textbooks/{书名}/ 的产物判断（content.md 在 = 转换完成）；
              // 之前这里对图书直接 `if (!task.doi) continue`，于是图书跑完后永远停在
              // 最后一帧 mineru_download —— 就是这个 bug。
              if (isBook) {
                const hasContent = await bookHasContent(slug)
                if (hasContent === true) {
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
              // 笔记：产物是 {base_path}/notes/{note_name}.md，出现即完成
              if (isNote) {
                const noteName = typeof meta?.note_name === 'string' ? meta.note_name : undefined
                if (noteName) {
                  const hasNote = await noteHasContent(slug, noteName)
                  if (hasNote === true) {
                    await tq.update_task(task.id, {
                      status: 'done',
                      stage: 'done',
                      node_index: STAGE_META.done.node,
                      progress: 100,
                      message: '转换完成（根据产物文件推断）',
                      updated_at: Date.now(),
                    })
                  }
                }
                continue
              }
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

  // 保存文献：元数据写 literatures.csv
  const savePapers = async (updatedPapers: Paper[]) => {
    try {
      const lits = updatedPapers.map(paperToLiterature)
      await saveLiteratures(lits)
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

  /** 材料元数据落盘（任务归属 + 标签） */
  const persistMeta = async (next: MaterialMeta[]) => {
    setMaterialMeta(next)
    try {
      await saveMaterialMeta(next)
    } catch (err) {
      console.error('保存材料元数据失败:', err)
      toast.error('保存失败，请检查仓库权限')
    }
  }

  /** 任务过滤（统一三类口径：全部 / 研究·课程大类 / 当前任务及其全部子任务） */
  const matchTask = (taskId: string) => taskFilterMatches(tasks, activeTaskId, taskId)

  /** 当前筛选选中的具体任务 id（'all'/大类/未选中 → 空串）；「添加到本任务」的默认归属即取此值 */
  const presetTaskId = () => (activeTaskId.startsWith('node:') ? activeTaskId.slice(5) : '')

  /** 标签过滤：空串不过滤 */
  const matchTag = (tags: string[]) => !tagFilter || tags.includes(tagFilter)

  /** 当前 tab 下带任务 / 标签的材料视图（文档的任务标签存在 meta 里） */
  const scopedMaterials = useMemo(() => {
    if (activeTab === 'library') return papers.map((p) => ({ taskId: p.taskId, tags: p.tags }))
    if (activeTab === 'knowledge') return books.map((b) => ({ taskId: b.taskId, tags: b.tags }))
    return documents.map((d) => ({
      taskId: taskOf(materialMeta, 'document', d.id),
      tags: tagsOf(materialMeta, 'document', d.id),
    }))
  }, [activeTab, papers, books, documents, materialMeta])

  /** 左栏任务面板选项（统一三类口径） */
  const taskOptions = useMemo(() => buildTaskFilterOptions(tasks, currentProjectId), [tasks, currentProjectId])

  /** 左栏任务面板数量（当前 tab）：按统一口径对每个选项计数（含子树累加） */
  const taskCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const opt of taskOptions) {
      counts[opt.value] = scopedMaterials.filter((m) => taskFilterMatches(tasks, opt.value, m.taskId)).length
    }
    return counts
  }, [taskOptions, scopedMaterials, tasks])

  // 选中的过滤项若已失效（如切换了当前任务），回落到「全部」，避免列表被清空
  useEffect(() => {
    if (!taskOptions.some((o) => o.value === activeTaskId)) setActiveTaskId('all')
  }, [taskOptions, activeTaskId])

  /** 左栏标签面板（当前 tab 去重） */
  const availableTags = useMemo(() => {
    const set = new Set<string>()
    for (const item of scopedMaterials) for (const t of item.tags) set.add(t)
    return [...set].sort()
  }, [scopedMaterials])

  // 筛选文献：按任务 / 标签 / tier / 搜索过滤（PDF 与否单独一层）
  const basePapers = useMemo(() => {
    let result = papers.filter((p) => matchTask(p.taskId) && matchTag(p.tags))
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
  }, [papers, tierFilter, searchQuery, activeTaskId, tagFilter, tasks])

  /** 一级 / 二级都支持"有没有导入 PDF"的筛选 */
  const filteredPapers = useMemo(() => {
    if (pdfFilter === 'all') return basePapers
    return basePapers.filter((p) => (pdfFilter === 'has' ? p.hasPdf : !p.hasPdf))
  }, [basePapers, pdfFilter])

  const totalPages = Math.ceil(filteredPapers.length / PAGE_SIZE)
  const pagedPapers = filteredPapers.slice((libraryPage - 1) * PAGE_SIZE, libraryPage * PAGE_SIZE)

  // 图书按任务 / 标签 / 搜索筛选
  const filteredBooks = useMemo(() => {
    let result = books.filter((b) => matchTask(b.taskId) && matchTag(b.tags))
    const q = bookSearch.trim().toLowerCase()
    if (q) {
      result = result.filter(
        (b) =>
          b.title.toLowerCase().includes(q) ||
          b.author.toLowerCase().includes(q) ||
          (b.publisher || '').toLowerCase().includes(q),
      )
    }
    return result
  }, [books, activeTaskId, tagFilter, bookSearch, tasks])

  // 其他文档搜索
  const filteredDocuments = useMemo(() => {
    let result = documents.filter(
      (d) =>
        matchTask(taskOf(materialMeta, 'document', d.id)) &&
        matchTag(tagsOf(materialMeta, 'document', d.id)),
    )
    const q = documentSearch.trim().toLowerCase()
    if (!q) return result
    result = result.filter(
      (d) => d.title.toLowerCase().includes(q) || d.author.toLowerCase().includes(q),
    )
    return result
  }, [documents, documentSearch, activeTaskId, tagFilter, materialMeta, tasks])

  // 图书 / 文档 / 模板：一律翻页（与文献库同一口径），不靠整列上下滚动
  const bookTotalPages = Math.ceil(filteredBooks.length / PAGE_SIZE)
  const pagedBooks = filteredBooks.slice((bookPage - 1) * PAGE_SIZE, bookPage * PAGE_SIZE)

  const documentTotalPages = Math.ceil(filteredDocuments.length / PAGE_SIZE)
  const pagedDocuments = filteredDocuments.slice((documentPage - 1) * PAGE_SIZE, documentPage * PAGE_SIZE)

  // 期刊模板搜索（名称 / 出版社 / ISSN）
  const filteredTemplates = useMemo(() => {
    const q = templateSearch.trim().toLowerCase()
    if (!q) return templates
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.publisher.toLowerCase().includes(q) ||
        t.issn.toLowerCase().includes(q),
    )
  }, [templates, templateSearch])
  const templateTotalPages = Math.ceil(filteredTemplates.length / PAGE_SIZE)
  const pagedTemplates = filteredTemplates.slice((templatePage - 1) * PAGE_SIZE, templatePage * PAGE_SIZE)

  // 筛选 / 任务切换后条目变少 → 当前页越界时回夹，避免停在空页
  useEffect(() => {
    setLibraryPage((p) => Math.min(p, Math.max(1, totalPages)))
  }, [totalPages])
  useEffect(() => {
    setBookPage((p) => Math.min(p, Math.max(1, bookTotalPages)))
  }, [bookTotalPages])
  useEffect(() => {
    setDocumentPage((p) => Math.min(p, Math.max(1, documentTotalPages)))
  }, [documentTotalPages])
  useEffect(() => {
    setTemplatePage((p) => Math.min(p, Math.max(1, templateTotalPages)))
  }, [templateTotalPages])

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
      const abstract = cleanAbstract(m.abstract as string | undefined)

      setNewPaper((prev) => ({
        ...prev,
        title: title || prev.title,
        authors: authors || prev.authors,
        year: year || prev.year,
        journal: journal || prev.journal,
        doi: doiFinal || prev.doi,
        keywords: keywords || prev.keywords,
        abstractEn: abstract || prev.abstractEn,
      }))
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
        // 当前选中的任务下新增 → 直接归到该任务
        taskId: presetTaskId(),
        tags: [],
        trackingGroup: '',
        // DOI 快捷入库只有元数据：把元数据里带的摘要收下，
        // 这样即便没有 md，摘要翻译练习也有题面/参考答案可用
        abstractEn: (meta.abstract || '').trim(),
        abstractCn: '',
        // 通讯作者不在元数据里，得等这篇转过 PDF 后由后端从 md 抽出
        correspondingAuthor: '',
      }
      const updated = [paper, ...papers]
      setPapers(updated)
      await savePapers(updated)
      await persistMeta(setMeta(materialMeta, 'paper', doi, { taskId: paper.taskId, tags: paper.tags }))
      setDoiQuickInput('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`DOI 入库失败：${msg}`)
    } finally {
      setIsAddingByDoi(false)
    }
  }, [doiQuickInput, papers, activeTaskId, materialMeta])

  const handleAddPaper = async () => {
    if (savingPaper) return
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
      taskId: newPaper.taskId,
      tags: newPaper.tags,
      trackingGroup: '',
      abstractEn: newPaper.abstractEn.trim(),
      abstractCn: newPaper.abstractCn.trim(),
      correspondingAuthor: '',
    }
    const updated = [paper, ...papers]
    setPapers(updated)
    setSavingPaper(true)
    try {
      await savePapers(updated)
      await persistMeta(setMeta(materialMeta, 'paper', doi, { taskId: paper.taskId, tags: paper.tags }))
      setNewPaper({ title: '', authors: '', year: '', journal: '', doi: '', keywords: '', abstractEn: '', abstractCn: '', tier: 'auto', taskId: '', tags: [] })
      setShowAddPaperModal(false)
    } catch (err) {
      setPapers(prevPapers)
      toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`, { duration: 5000 })
    } finally {
      setSavingPaper(false)
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
        if (paperDoi) await persistMeta(dropMeta(materialMeta, 'paper', paperDoi))
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

  /** 编辑某期刊的显示缩写：prompt 取值 → 落盘 → 刷新覆盖表 */
  const handleEditJournalAbbrev = async (journal: string) => {
    // 默认值同样是「没查过就填原名」，不拿启发式结果当底 —— 用户看到错的默认值会直接回车接受
    const current = journalAbbrevMap[journal] || journal
    const input = prompt('期刊缩写', current)
    if (input === null) return
    await saveJournalAbbrev(journal, input.trim())
    setJournalAbbrevMap(await loadJournalAbbrevMap())
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
    // 顺带把这篇文献提取出的单词读回来（词根词缀修正用）；读失败不影响改元数据
    setPaperWords(null)
    setPaperWordsDirty(false)
    loadWords(true)
      .then((all) => setPaperWords(all))
      .catch(() => setPaperWords([]))
  }

  // 打开编辑弹窗时，读回这篇文献真实的笔记（notes/{名称}.md）与批注数量
  useEffect(() => {
    if (!showEditPaperModal || !editingPaper?.doi) {
      setPaperNoteInfo({ loading: false, notes: [], annotations: 0 })
      return
    }
    let cancelled = false
    const ref: DocRef = { kind: 'paper', id: editingPaper.doi }
    setPaperNoteInfo({ loading: true, notes: [], annotations: 0 })
    Promise.all([
      listNotes(ref).catch(() => [] as string[]),
      loadAnnotations(ref).catch(() => []),
    ]).then(([notes, anns]) => {
      if (!cancelled) setPaperNoteInfo({ loading: false, notes, annotations: anns.length })
    })
    return () => {
      cancelled = true
    }
    // editingPaper?.doi 变化即换了一篇文献
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showEditPaperModal, editingPaper?.doi])

  const handleSavePaper = async () => {
    if (!editingPaper || savingPaper) return
    setSavingPaper(true)
    try {
      // 词根词缀先写：整表重写，失败就别把弹窗关掉（用户还能重试）
      if (paperWords && paperWordsDirty) {
        try {
          await saveWords(paperWords)
        } catch (err) {
          toast.error(`词根词缀保存失败：${err instanceof Error ? err.message : String(err)}`, { duration: 5000 })
          return
        }
      }
      const prevPapers = papers
      const updated = papers.map((p) => (p.id === editingPaper.id ? editingPaper : p))
      setPapers(updated)
      try {
        await savePapers(updated)
        if (editingPaper.doi) {
          await persistMeta(setMeta(materialMeta, 'paper', editingPaper.doi, { taskId: editingPaper.taskId, tags: editingPaper.tags }))
        }
        setShowEditPaperModal(false)
        setEditingPaper(null)
        setPaperWords(null)
        setPaperWordsDirty(false)
      } catch (err) {
        setPapers(prevPapers)
        toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`, { duration: 5000 })
      }
    } finally {
      setSavingPaper(false)
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
        let nextMeta = materialMeta
        for (const p of papersToDelete) {
          if (p.doi) nextMeta = dropMeta(nextMeta, 'paper', p.doi)
        }
        await persistMeta(nextMeta)
        setSelectedPapers(new Set())
        setBatchMode(false)
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
    const target = batchMoveTaskId
    const updated = papers.map((p) => (selectedPapers.has(p.id) ? { ...p, taskId: target } : p))
    setPapers(updated)
    savePapers(updated)
    let nextMeta = materialMeta
    for (const p of updated) {
      if (selectedPapers.has(p.id)) {
        nextMeta = setMeta(nextMeta, 'paper', p.doi, { taskId: target, tags: p.tags })
      }
    }
    persistMeta(nextMeta)
    setSelectedPapers(new Set())
    setBatchMode(false)
    setShowBatchMoveModal(false)
    setBatchMoveTaskId('')
  }

  // 期刊模板操作 —— 全部通过 journal-templates.ts 持久化到 GitHub 私库
  const handleAddTemplate = async () => {
    if (!newTemplate.name.trim() || savingTemplate) return
    setSavingTemplate(true)
    try {
      const backend = await createTemplate({
        name: newTemplate.name.trim(),
        issn: newTemplate.issn.trim() || undefined,
        publisher: newTemplate.publisher.trim() || undefined,
        guidelines_content: newTemplate.guidelines.trim() || undefined,
        notes: newTemplate.formatSummary.trim() || undefined,
      })
      setTemplates((prev) => [...prev, toTemplateItem(backend)])
      setNewTemplate({ name: '', issn: '', publisher: '', guidelines: '', formatSummary: '' })
      setShowTemplateModal(false)
    } catch (err) {
      toast.error(`创建模板失败: ${err instanceof Error ? err.message : String(err)}`)
      console.error('[handleAddTemplate]', err)
    } finally {
      setSavingTemplate(false)
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
              '只依据投稿须知原文，不得引入原文没有的外部知识或猜测；原文没写的内容宁可不提，也不要补。',
              '这份摘要会作为「草稿」交给用户人工确认修改，请如实标注不确定的地方。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `【期刊名称】${newTemplate.name}\n\n【投稿须知】\n${guidelinesText}`,
          },
        ],
      })

      // 结果落到一个「可编辑」的摘要框里，让人确认 / 修改后再保存 —— 不是丢进 toast 就没了
      setNewTemplate((prev) => ({
        ...prev,
        guidelines: guidelinesText, // 保留用户粘贴的全文，作为模板的投稿须知源材料
        formatSummary: resp.content, // 摘要有独立入口，可编辑
      }))
    } catch (err) {
      toast.error(`AI 提取失败: ${err instanceof Error ? err.message : String(err)}`)
      console.error('[handleExtractFormat]', err)
    } finally {
      setIsExtracting(false)
    }
  }

  const handleSaveTemplate = async () => {
    if (!editingTemplate || savingTemplate) return
    if (!newTemplate.name.trim()) {
      toast.error('请填写期刊名')
      return
    }
    setSavingTemplate(true)
    try {
      // 存的是表单里的值（newTemplate），不是打开时的旧值 —— 否则用户在弹窗里改的全丢了
      await updateTemplate(editingTemplate.id, {
        name: newTemplate.name.trim(),
        issn: newTemplate.issn.trim() || undefined,
        publisher: newTemplate.publisher.trim() || undefined,
        guidelines_content: newTemplate.guidelines.trim() || undefined,
        notes: newTemplate.formatSummary.trim() || undefined,
      })
      const backend = await getAllTemplates()
      setTemplates(backend.map(toTemplateItem))
      setShowTemplateModal(false)
      setEditingTemplate(null)
    } catch (err) {
      toast.error(`保存模板失败: ${err instanceof Error ? err.message : String(err)}`)
      console.error('[handleSaveTemplate]', err)
    } finally {
      setSavingTemplate(false)
    }
  }

  const handleSetDefaultTemplate = async (id: string) => {
    try {
      await setDefaultTemplate(id)
      const backend = await getAllTemplates()
      setTemplates(backend.map(toTemplateItem))
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
    } catch (err) {
      toast.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`)
      console.error('[handleDeleteTemplate]', err)
    }
  }

  const handleApplyTemplate = (id: string) => {
    // 应用到项目 = 设为默认模板 + 提示用户去排版页面使用
    handleSetDefaultTemplate(id)
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
        taskId: uploadBookTaskId,
        tags: uploadBookTags,
      }
    })
    const updated = [...newBooks, ...books]
    setBooks(updated)
    await saveBooks(updated)

    // 任务归属 + 标签写入 materials/meta.csv
    let nextMeta = materialMeta
    for (const b of newBooks) {
      nextMeta = setMeta(nextMeta, 'book', b.id, { taskId: uploadBookTaskId, tags: uploadBookTags })
    }
    await persistMeta(nextMeta)
    setShowUploadBookModal(false)
    setUploadBookTaskId('')
    setUploadBookTags([])

    // fire-and-forget: 每个文件上传 PDF + dispatch 后端 book_convert
    fileArray.forEach((file, i) => {
      void enqueueBookMineruConvert(newBooks[i].id, file, newBooks[i].title)
    })
  }

  const handleDeleteBook = async (id: string) => {
    const updated = books.filter((b) => b.id !== id)
    setBooks(updated)
    await saveBooks(updated)
    await persistMeta(dropMeta(materialMeta, 'book', id))
  }

  /** 打开图书详情：顺带把已落盘的任务 / 标签填进编辑态 */
  const openBookDetail = (book: BookItem) => {
    setBookDetailTaskId(book.taskId)
    setBookDetailTags(book.tags)
    setShowBookDetail(book)
  }

  /** 图书详情弹窗里保存任务归属 + 标签 */
  const handleSaveBookDetail = async () => {
    if (!showBookDetail) return
    const nextMeta = setMeta(materialMeta, 'book', showBookDetail.id, { taskId: bookDetailTaskId, tags: bookDetailTags })
    setBooks((prev) => prev.map((b) => (b.id === showBookDetail.id ? { ...b, taskId: bookDetailTaskId, tags: bookDetailTags } : b)))
    setShowBookDetail({ ...showBookDetail, taskId: bookDetailTaskId, tags: bookDetailTags })
    await persistMeta(nextMeta)
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
      await importMarkdownDocs(usable)
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
      taskId: taskOf(materialMeta, 'document', doc.id),
      tags: tagsOf(materialMeta, 'document', doc.id),
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
      await persistMeta(
        setMeta(materialMeta, 'document', editingDocument.id, { taskId: editDocForm.taskId, tags: editDocForm.tags }),
      )
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
      await persistMeta(dropMeta(materialMeta, 'document', doc.id))
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

  /** 打开「手动添加文献」弹窗：默认继承左栏当前任务 */
  const openAddPaper = () => {
    setNewPaper({ title: '', authors: '', year: '', journal: '', doi: '', keywords: '', abstractEn: '', abstractCn: '', tier: 'auto', taskId: presetTaskId(), tags: [] })
    setShowAddPaperModal(true)
  }

  /** 打开「上传图书」弹窗：默认继承左栏当前任务 */
  const openUploadBook = () => {
    setUploadBookTaskId(presetTaskId())
    setUploadBookTags([])
    setShowUploadBookModal(true)
  }

  /** 打开「新建期刊模板」弹窗 */
  const openNewTemplate = () => {
    setEditingTemplate(null)
    setNewTemplate({ name: '', issn: '', publisher: '', guidelines: '', formatSummary: '' })
    setShowTemplateModal(true)
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
    <div className="page-container flex h-full flex-col py-ui-page">
      {/* 管理页布局：左=功能栏（类型切换 + 任务/标签）｜中=内容｜右=后台监控（1:3:1）
          工作台形态：外壳不滚，三栏各自 min-h-0 + 滚动。窄屏塌成两行（功能栏 + 内容）。 */}
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-ui-gap lg:grid-cols-ratio-131 lg:grid-rows-[minmax(0,1fr)]">
        {/* ──── 左：功能栏 ──── */}
        <aside className="flex min-w-0 min-h-0 flex-col gap-ui-gap">
          {/* 类型切换（竖排） */}
          <nav className="shrink-0 rounded-card border border-ink-200 bg-paper-50 p-1.5 shadow-sm">
            {subTabs.map((tab) => {
              const Icon = tab.icon
              const active = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex w-full items-center gap-ui-gap-sm rounded-control-sm px-ui-gap-sm py-2 text-left text-ui-sm font-medium transition ${
                    active ? 'bg-seal-50 text-seal-600' : 'text-ink-600 hover:bg-paper-100 hover:text-ink-800'
                  }`}
                >
                  <Icon className="h-ui-icon w-ui-icon" />
                  {tab.label}
                </button>
              )
            })}
          </nav>

          {/* 文献库：全文检索 → DOI 链接入库 → 手动入库（入库的两种方式） */}
          {activeTab === 'library' && (
            <div className="shrink-0 rounded-card border border-ink-200 bg-paper-50 p-3 shadow-sm space-y-2">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
                <input
                  type="text"
                  placeholder="全文检索…"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value)
                    setLibraryPage(1)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      runFullTextSearch(searchQuery)
                    }
                  }}
                  className="w-full pl-8 pr-3 py-2 text-ui-sm border border-ink-200 rounded-control bg-paper-50 focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
              </div>
              <div className="flex items-center bg-paper-50 rounded-control border border-ink-200 overflow-hidden focus-within:border-seal-400 focus-within:ring-2 focus-within:ring-seal-100">
                <span className="pl-2 text-ui-xs font-medium text-ink-400 whitespace-nowrap">DOI</span>
                <input
                  type="text"
                  value={doiQuickInput}
                  onChange={(e) => setDoiQuickInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !isAddingByDoi && handleAddByDoi()}
                  placeholder="链接入库…"
                  className="min-w-0 flex-1 px-2 py-2 text-ui-sm bg-transparent focus:outline-none"
                />
                <button
                  onClick={handleAddByDoi}
                  disabled={isAddingByDoi || !doiQuickInput.trim()}
                  className="flex items-center gap-1 px-2.5 py-2 text-ui-xs font-medium text-paper-50 bg-seal-600 hover:bg-seal-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  {isAddingByDoi ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  入库
                </button>
              </div>
              <button
                onClick={openAddPaper}
                className="flex w-full items-center justify-center gap-2 px-ui-gap py-2 text-ui-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-control transition shadow-md shadow-seal-200"
              >
                <Plus className="w-4 h-4" />
                手动入库
              </button>
            </div>
          )}

          {/* 图书库：全文检索 + 上传图书 */}
          {activeTab === 'knowledge' && (
            <div className="shrink-0 rounded-card border border-ink-200 bg-paper-50 p-3 shadow-sm space-y-2">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
                <input
                  type="text"
                  placeholder="书名、作者、出版社…（Enter 全文检索）"
                  value={bookSearch}
                  onChange={(e) => {
                    setBookSearch(e.target.value)
                    setBookPage(1)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      runFullTextSearch(bookSearch)
                    }
                  }}
                  className="w-full pl-8 pr-3 py-2 text-ui-sm border border-ink-200 rounded-control bg-paper-50 focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
              </div>
              <button
                onClick={openUploadBook}
                className="flex w-full items-center justify-center gap-2 px-ui-gap py-2 text-ui-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-control transition shadow-md shadow-seal-200"
              >
                <Upload className="w-4 h-4" />
                上传图书
              </button>
            </div>
          )}

          {/* 其他文档：全文检索 + 导入文档 */}
          {activeTab === 'documents' && (
            <div className="shrink-0 rounded-card border border-ink-200 bg-paper-50 p-3 shadow-sm space-y-2">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
                <input
                  type="text"
                  placeholder="标题、作者…（Enter 全文检索）"
                  value={documentSearch}
                  onChange={(e) => {
                    setDocumentSearch(e.target.value)
                    setDocumentPage(1)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      runFullTextSearch(documentSearch)
                    }
                  }}
                  className="w-full pl-8 pr-3 py-2 text-ui-sm border border-ink-200 rounded-control bg-paper-50 focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
              </div>
              <button
                onClick={() => setShowImportDocModal(true)}
                className="flex w-full items-center justify-center gap-2 px-ui-gap py-2 text-ui-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-control transition shadow-md shadow-seal-200"
              >
                <Upload className="w-4 h-4" />
                导入文档
              </button>
            </div>
          )}

          {/* 期刊模板：检索 + 新建（同卡片相邻，与文献/图书/文档一致） */}
          {activeTab === 'templates' && (
            <div className="shrink-0 rounded-card border border-ink-200 bg-paper-50 p-3 shadow-sm space-y-2">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
                <input
                  type="text"
                  placeholder="模板名称、出版社、ISSN…"
                  value={templateSearch}
                  onChange={(e) => {
                    setTemplateSearch(e.target.value)
                    setTemplatePage(1)
                  }}
                  className="w-full pl-8 pr-3 py-2 text-ui-sm border border-ink-200 rounded-control bg-paper-50 focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
              </div>
              <button
                onClick={openNewTemplate}
                className="flex w-full items-center justify-center gap-2 px-ui-gap py-2 text-ui-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-control transition shadow-md shadow-seal-200"
              >
                <Plus className="w-4 h-4" />
                新建模板
              </button>
            </div>
          )}

          {/* 导入导出：功能全收进左栏 */}
          {activeTab === 'import-export' && (
            <div className="rounded-card border border-ink-200 bg-paper-50 p-3 shadow-sm space-y-3">
              <div className="space-y-1.5">
                <p className="px-1 text-ui-xs font-semibold text-ink-500">导入</p>
                {[
                  { name: 'CSV', ext: '.csv' },
                  { name: 'JSON', ext: '.json' },
                  { name: 'EndNote', ext: '.enw' },
                  { name: 'Zotero', ext: '.json,.csv' },
                ].map((item) => (
                  <label
                    key={item.name}
                    className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-ui-sm text-ink-700 border border-ink-200 rounded-control hover:border-seal-300 hover:bg-seal-50/40 cursor-pointer transition"
                  >
                    <span>{item.name}</span>
                    <Upload className="w-4 h-4 text-ink-400" />
                    <input type="file" accept={item.ext} className="hidden" />
                  </label>
                ))}
              </div>
              <div className="space-y-1.5">
                <p className="px-1 text-ui-xs font-semibold text-ink-500">导出</p>
                {['CSV', 'Markdown', 'BibTeX'].map((name) => (
                  <button
                    key={name}
                    className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-ui-sm text-ink-700 border border-ink-200 rounded-control hover:border-seal-300 hover:bg-seal-50/40 transition"
                  >
                    <span>{name}</span>
                    <Download className="w-4 h-4 text-ink-400" />
                  </button>
                ))}
              </div>
              <button className="flex w-full items-center justify-center gap-2 px-ui-gap py-2 text-ui-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-control transition shadow-md shadow-seal-200">
                <Github className="w-4 h-4" />
                GitHub 同步
              </button>
            </div>
          )}

          {/* 任务 + 标签：仅内容类 tab（文献 / 图书 / 文档）过滤用 */}
          {(activeTab === 'library' || activeTab === 'knowledge' || activeTab === 'documents') && (
          <>
          <div className="flex min-h-0 flex-1 flex-col rounded-card border border-ink-200 bg-paper-50 p-3 shadow-sm">
            <h3 className="mb-3 px-1 text-ui-sm font-semibold text-ink-700 flex items-center gap-1.5 shrink-0">
              <ListTodo className="w-4 h-4 text-seal-600" />
              任务
            </h3>
            <div className="min-h-0 flex-1 -mr-1 space-y-0.5 overflow-y-auto pr-1">
              {(() => {
                const collapsed = new Set<string>()
                const visible: TaskFilterOption[] = []
                for (const opt of taskOptions) {
                  if (opt.parent && collapsed.has(opt.parent)) {
                    if (opt.hasChildren) collapsed.add(opt.value)
                    continue
                  }
                  visible.push(opt)
                  if (opt.hasChildren && !expandedTasks.has(opt.value)) collapsed.add(opt.value)
                }
                return visible
              })().map((opt) => {
                const isActive = activeTaskId === opt.value
                const expanded = expandedTasks.has(opt.value)
                return (
                  <div
                    key={opt.value}
                    className="flex items-center gap-0.5"
                    style={{ paddingLeft: `${opt.depth * 0.75}rem` }}
                  >
                    {opt.hasChildren ? (
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedTasks((prev) => {
                            const next = new Set(prev)
                            if (next.has(opt.value)) next.delete(opt.value)
                            else next.add(opt.value)
                            return next
                          })
                        }
                        title={expanded ? '折叠子任务' : '展开子任务'}
                        className="shrink-0 rounded-control-sm p-0.5 text-ink-400 transition hover:bg-paper-100 hover:text-ink-600"
                      >
                        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                      </button>
                    ) : (
                      <span className="w-4 shrink-0" />
                    )}
                    <button
                      onClick={() => setActiveTaskId(opt.value)}
                      className={`flex min-w-0 flex-1 items-center gap-2 rounded-control px-2 py-1.5 text-left transition ${
                        isActive ? 'bg-seal-50 text-seal-700 font-medium' : 'text-ink-600 hover:bg-paper-100'
                      }`}
                    >
                      <span className="flex-1 truncate text-ui-sm">{opt.label}</span>
                      <span className={`rounded-full px-1.5 py-0.5 text-ui-xs ${isActive ? 'bg-seal-100 text-seal-600' : 'bg-ink-100 text-ink-500'}`}>
                        {taskCounts[opt.value] || 0}
                      </span>
                    </button>
                  </div>
                )
              })}
            </div>
          </div>

          {/* 标签（跨 tab 共用） */}
          {availableTags.length > 0 && (
            <div className="rounded-card border border-ink-200 bg-paper-50 p-3 shadow-sm">
              <h3 className="mb-3 px-1 text-ui-sm font-semibold text-ink-700 flex items-center gap-1.5">
                <Tag className="w-4 h-4 text-seal-600" />
                标签
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {availableTags.map((tag) => {
                  const isActive = tagFilter === tag
                  return (
                    <button
                      key={tag}
                      onClick={() => setTagFilter(isActive ? '' : tag)}
                      className={`px-2 py-0.5 text-ui-xs rounded-control-sm transition ${
                        isActive ? 'bg-seal-100 text-seal-700' : 'bg-ink-100 text-ink-500 hover:bg-ink-200'
                      }`}
                    >
                      {tag}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          </>
          )}
        </aside>

        {/* ──── 中：内容 ──── */}
        <div className="min-w-0 min-h-0 overflow-y-auto">

      {/* ============ 文献库 Tab ============ */}
      {activeTab === 'library' && (
        <div className="min-w-0 space-y-4">
            <div className="bg-paper-50 rounded-card border border-ink-200 shadow-sm overflow-hidden">
              <div className="af-line-b flex items-center gap-1 p-3 bg-paper-100/50">
                <button
                  onClick={() => {
                    setTierFilter('all')
                    setLibraryPage(1)
                  }}
                  className={`flex items-center gap-1.5 px-ui-gap py-1.5 rounded-control-sm text-ui-sm font-medium transition ${
                    tierFilter === 'all'
                      ? 'bg-paper-50 text-seal-600 shadow-sm border border-ink-200'
                      : 'text-ink-500 hover:text-ink-700'
                  }`}
                >
                  全部
                  <span className="text-ui-xs px-1.5 py-0.5 bg-ink-200 text-ink-600 rounded-full">
                    {filteredPapers.length}
                  </span>
                </button>
                <button
                  onClick={() => {
                    setTierFilter(1)
                    setLibraryPage(1)
                  }}
                  className={`flex items-center gap-1.5 px-ui-gap py-1.5 rounded-control-sm text-ui-sm font-medium transition ${
                    tierFilter === 1
                      ? TIER_STYLE[1].tab
                      : TIER_STYLE[1].tabIdle
                  }`}
                >
                  一级文献
                  <span className="text-ui-xs px-1.5 py-0.5 bg-ink-200 text-ink-600 rounded-full">
                    {filteredPapers.filter((p) => p.tier === 1).length}
                  </span>
                </button>
                <button
                  onClick={() => {
                    setTierFilter(2)
                    setLibraryPage(1)
                  }}
                  className={`flex items-center gap-1.5 px-ui-gap py-1.5 rounded-control-sm text-ui-sm font-medium transition ${
                    tierFilter === 2
                      ? TIER_STYLE[2].tab
                      : TIER_STYLE[2].tabIdle
                  }`}
                >
                  二级文献
                  <span className="text-ui-xs px-1.5 py-0.5 bg-ink-200 text-ink-600 rounded-full">
                    {filteredPapers.filter((p) => p.tier === 2).length}
                  </span>
                </button>

                {/* PDF 筛选：一级 / 二级通用 */}
                <div className="ml-auto flex items-center gap-1 pl-3 border-l border-ink-200">
                  <span className="text-ui-xs text-ink-400 px-1">PDF</span>
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
                        className={`flex items-center gap-1.5 px-ui-gap py-1.5 rounded-control-sm text-ui-sm font-medium transition ${
                          pdfFilter === o.v
                            ? 'bg-paper-50 text-seal-600 shadow-sm border border-ink-200'
                            : 'text-ink-500 hover:text-ink-700'
                        }`}
                      >
                        {o.label}
                        <span className="text-ui-xs px-1.5 py-0.5 bg-ink-200 text-ink-600 rounded-full">
                          {count}
                        </span>
                      </button>
                    )
                  })}
                </div>

                {/* 批量操作 — 归位到「操作」列正上方 */}
                {batchMode && (
                  <>
                    <button
                      onClick={() => setShowBatchMoveModal(true)}
                      disabled={selectedPapers.size === 0}
                      className="flex items-center gap-1.5 px-ui-gap py-1.5 text-ui-sm text-seal-600 bg-seal-50 border border-seal-200 hover:bg-seal-100 rounded-control-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <MoveRight className="w-4 h-4" />
                      移动任务 ({selectedPapers.size})
                    </button>
                    <button
                      onClick={handleBatchDelete}
                      disabled={selectedPapers.size === 0}
                      className="flex items-center gap-1.5 px-ui-gap py-1.5 text-ui-sm text-red-600 bg-red-50 border border-red-200 hover:bg-red-100 rounded-control-sm transition disabled:opacity-50 disabled:cursor-not-allowed"
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
                  className={`flex items-center gap-1.5 px-ui-gap py-1.5 text-ui-sm rounded-control-sm border transition ${
                    batchMode
                      ? 'text-seal-600 bg-seal-50 border-seal-200'
                      : 'text-ink-600 bg-paper-50 border-ink-200 hover:bg-paper-100'
                  }`}
                >
                  <CheckSquare className="w-4 h-4" />
                  {batchMode ? '取消批量' : '批量操作'}
                </button>
              </div>

              {/* 文献表格：一条文献 = 一行，字段横向铺开成列；格子里该换行就换行 */}
              {batchMode && pagedPapers.length > 0 && (
                <div className="af-line-b flex items-center gap-2 px-ui-gap py-2 bg-paper-100/50">
                  <input
                    type="checkbox"
                    checked={selectedPapers.size === pagedPapers.length && pagedPapers.length > 0}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded-control-sm border-ink-300 text-seal-600 focus:ring-seal-500"
                  />
                  <span className="text-ui-xs text-ink-500">全选本页</span>
                </div>
              )}
              {pagedPapers.length > 0 && (
                <div>
                  {/* table-fixed + w-full：表格恒等于容器宽度，列宽按比例分，**绝不横向滚动**。
                      标题列吃剩余空间、完整展示不省略；作者一格一个作者纵向排、期刊年份纵向堆叠，
                      格子内该换行就换行 → 行高随内容自适应（每条高度可以不一样）。 */}
                  <table className="w-full table-fixed text-left border-collapse">
                    <thead>
                      <tr className="bg-paper-100 text-ui-xs text-ink-500">
                        {batchMode && <th className="w-8 border border-ink-200 px-2 py-2 font-normal" />}
                        <th className="w-[3.75rem] border border-ink-200 px-2 py-2 font-normal" />
                        <th className="border border-ink-200 px-ui-gap py-2 font-normal">标题</th>
                        <th className="w-[16%] border border-ink-200 px-ui-gap py-2 font-normal">作者</th>
                        <th className="w-[11%] border border-ink-200 px-ui-gap py-2 font-normal">期刊 · 年份</th>
                        <th className="w-[11%] border border-ink-200 px-ui-gap py-2 font-normal">任务 / 标签</th>
                        <th className="w-[5.5rem] border border-ink-200 px-2 py-2 font-normal">状态</th>
                        <th className="w-[14%] border border-ink-200 px-ui-gap py-2 font-normal text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                {pagedPapers.map((paper) => {
                  const authorList = splitAuthors(paper.authors)
                  const corresponding = correspondingNames(paper.correspondingAuthor)
                  // 只认「用户手改的 / AI 查到的」；查不到就显示**原期刊名**。
                  // ⚠️ 不要用「取首字母」去猜缩写：Angewandte Chemie International Edition
                  // 猜成 ACIE 并不是学术界通用的写法，用户会照着抄进参考文献 ——
                  // 一个错的缩写，比长一点的期刊名危害大得多。查不到就不缩写。
                  const abbrev = journalAbbrevMap[paper.journal] || paper.journal
                  return (
                    <tr
                      key={paper.id}
                      className={`transition ${TIER_STYLE[paper.tier].row} ${
                        batchMode ? 'cursor-pointer' : ''
                      } ${selectedPapers.has(paper.id) ? '!bg-seal-50' : ''}`}
                      onClick={() => batchMode && toggleSelectPaper(paper.id)}
                    >
                      {batchMode && (
                        <td className="border border-ink-200 px-2 py-2.5 align-top">
                          <input
                            type="checkbox"
                            checked={selectedPapers.has(paper.id)}
                            onChange={(e) => {
                              e.stopPropagation()
                              toggleSelectPaper(paper.id)
                            }}
                            className="w-4 h-4 rounded-control-sm border-ink-300 text-seal-600 focus:ring-seal-500"
                          />
                        </td>
                      )}

                      {/* 题图 */}
                      <td className="border border-ink-200 px-2 py-2.5 align-top">
                        <div
                          className={`w-10 h-14 rounded-control overflow-hidden bg-ink-100 ${paper.coverImage ? 'cursor-pointer hover:opacity-80 transition' : ''}`}
                          onClick={(e) => {
                            if (paper.coverImage) {
                              e.stopPropagation()
                              setShowImageLightbox(paper.coverImage)
                            }
                          }}
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

                      {/* 标题：**完整展示、绝不省略**（省略了用户就没法认这篇文献），
                          换行行数随标题长度自适应 → 条目高度可以比其他条更高 */}
                      <td className="border border-ink-200 px-ui-gap py-2.5 align-top">
                        <h3 className="text-ui-sm font-medium text-ink-800 break-words">
                          {paper.title}
                        </h3>

                        {paper.keywords.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5">
                            {paper.keywords.slice(0, 2).map((kw) => (
                              <span key={kw} className="px-1.5 py-0.5 bg-seal-50 text-seal-600 text-ui-xs rounded-control-sm">
                                {kw}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>

                      {/* 作者：**一个作者一行**（纵向堆叠，不在横向摊开、不左右滚）；
                          一作标「一作」、通讯标「通讯」 */}
                      <td className="border border-ink-200 px-ui-gap py-2.5 align-top">
                        {authorList.length === 0 ? (
                          <div className="text-ui-xs text-ink-500">—</div>
                        ) : (
                          <div className="flex flex-col gap-0.5 text-ui-xs">
                            {authorList.map((a, i) => {
                              const isFirst = i === 0
                              const isCorresponding = a.starred || corresponding.has(a.name)
                              return (
                                <div key={i} className="flex items-center gap-1 min-w-0">
                                  <span
                                    className={`min-w-0 break-words ${
                                      isCorresponding
                                        ? 'text-seal-600 font-medium'
                                        : isFirst
                                          ? 'text-ink-700'
                                          : 'text-ink-500'
                                    }`}
                                  >
                                    {a.name}
                                  </span>
                                  {isFirst && (
                                    <span className="px-0.5 py-px rounded-control-sm bg-ink-100 text-ink-500 text-ui-2xs leading-none shrink-0">
                                      一作
                                    </span>
                                  )}
                                  {isCorresponding && (
                                    <span className="px-0.5 py-px rounded-control-sm bg-seal-50 text-seal-600 text-ui-2xs leading-none shrink-0">
                                      通讯
                                    </span>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </td>

                      {/* 期刊（上）· 年份（下）：同一格内**纵向堆叠**，不横着摊开（横着摊 = 逼出左右滚动） */}
                      <td className="border border-ink-200 px-ui-gap py-2.5 align-top">
                        <div className="flex flex-col gap-0.5 text-ui-xs text-ink-400">
                          {paper.journal && (
                            <span className="flex items-start gap-1 min-w-0">
                              <span className="min-w-0 break-words">{abbrev}</span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void handleEditJournalAbbrev(paper.journal)
                                }}
                                className="p-0.5 text-ink-300 hover:text-seal-600 rounded-control-sm transition shrink-0"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                            </span>
                          )}
                          {paper.year && <span>{paper.year}</span>}
                        </div>
                      </td>

                      {/* 任务 / 标签 */}
                      <td className="border border-ink-200 px-ui-gap py-2.5 align-top">
                        <div className="flex flex-wrap gap-1">
                          {(() => {
                            const t = tasks.find((x) => x.projectId === paper.taskId)
                            return (
                              <>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleEditPaper(paper)
                                  }}
                                  className={`px-1.5 py-0.5 text-ui-xs rounded-control-sm whitespace-nowrap hover:opacity-80 transition ${t ? 'bg-seal-50 text-seal-700' : 'bg-ink-100 text-ink-400'}`}
                                  title="修改归属与标签"
                                >
                                  {t ? t.title : '未归属'}
                                </button>
                                {paper.tags.map((tag) => (
                                  <span
                                    key={tag}
                                    className="px-1.5 py-0.5 text-ui-xs rounded-control-sm whitespace-nowrap bg-ink-100 text-ink-600"
                                  >
                                    <Tag className="w-3 h-3 inline mr-0.5" />
                                    {tag}
                                  </span>
                                ))}
                              </>
                            )
                          })()}
                        </div>
                      </td>

                      {/* 状态 */}
                      <td className="border border-ink-200 px-2 py-2.5 align-top">
                        <div className="flex flex-wrap items-center gap-1">
                          <StatusBadge status={paper.mdStatus} />
                          {paper.hasPdf && (
                            <span className="inline-flex items-center px-1.5 py-0.5 bg-ink-100 text-ink-500 text-ui-2xs font-medium rounded-control-sm shrink-0">
                              PDF
                            </span>
                          )}
                        </div>
                      </td>

                      {/* 操作 */}
                      <td className="border border-ink-200 px-ui-gap py-2.5 align-top">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {/* Upload PDF 按钮：仅在未转换/转换失败时显示 */}
                          {paper.doi && (paper.mdStatus === 'none' || paper.mdStatus === 'failed') && (
                            <label
                              className="p-1.5 rounded-control-sm transition cursor-pointer text-seal-500 hover:text-seal-600 hover:bg-seal-50"
                              onClick={(e) => e.stopPropagation()}
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
                          {/* DOI 跳转：点图标直接打开原文（doi.org 解析），不做复制 */}
                          {paper.doi && (
                            <a
                              href={`https://doi.org/${normalizeDoi(paper.doi).doi ?? paper.doi}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="打开原文（DOI 跳转）"
                              onClick={(e) => e.stopPropagation()}
                              className="p-1.5 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded-control-sm transition"
                            >
                              <ExternalLink className="w-4 h-4" />
                            </a>
                          )}
                          <button
                            disabled={paper.mdStatus === 'converting'}
                            onClick={(e) => {
                              e.stopPropagation()
                              handleOpenReading(paper)
                            }}
                            className={`p-1.5 rounded-control-sm transition ${
                              paper.mdStatus === 'converting'
                                ? 'text-ink-300 cursor-not-allowed'
                                : 'text-ink-400 hover:text-seal-600 hover:bg-seal-50'
                            }`}
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          <button
                            disabled={paper.mdStatus === 'converting' || !paper.doi}
                            onClick={(e) => {
                              e.stopPropagation()
                              handleReconvertPaper(paper)
                            }}
                            className={`p-1.5 rounded-control-sm transition ${
                              paper.mdStatus === 'converting' || !paper.doi
                                ? 'text-ink-300 cursor-not-allowed'
                                : 'text-ink-400 hover:text-amber-600 hover:bg-amber-50'
                            }`}
                          >
                            <RefreshCw className={`w-4 h-4 ${paper.mdStatus === 'converting' ? 'animate-spin' : ''}`} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleEditPaper(paper)
                            }}
                            className="p-1.5 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded-control-sm transition"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            disabled={deletingIds.has(paper.id)}
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDeletePaper(paper.id)
                            }}
                            className={`p-1.5 rounded-control-sm transition ${
                              deletingIds.has(paper.id)
                                ? 'text-red-500 bg-red-50 cursor-not-allowed'
                                : 'text-ink-400 hover:text-red-600 hover:bg-red-50'
                            }`}
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
                  )
                })}
                    </tbody>
                  </table>
                </div>
              )}

              {pagedPapers.length === 0 && (
                <div className="py-16 text-center">
                  <div className="text-ink-400 mb-3">
                    <FileText className="w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p className="text-ui-sm">暂无文献数据</p>
                  </div>
                  <button
                    onClick={() => {
                      setNewPaper({ title: '', authors: '', year: '', journal: '', doi: '', keywords: '', abstractEn: '', abstractCn: '', tier: 'auto', taskId: presetTaskId(), tags: [] })
                      setShowAddPaperModal(true)
                    }}
                    className="inline-flex items-center gap-1.5 px-ui-gap py-2 text-ui-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-control transition"
                  >
                    <Plus className="w-4 h-4" />
                    添加第一篇文献
                  </button>
                </div>
              )}

              <PaginationBar
                total={filteredPapers.length}
                page={libraryPage}
                totalPages={totalPages}
                onPage={setLibraryPage}
              />
            </div>
        </div>
      )}

      {/* ============ 期刊模板 Tab ============ */}
      {activeTab === 'templates' && (
        <div className="space-y-4">
          {filteredTemplates.length > 0 && (
          <div className="bg-paper-50 rounded-card border border-ink-200 shadow-sm af-divided overflow-hidden">
            {pagedTemplates.map((tpl) => (
              <div key={tpl.id} className="flex items-center gap-3 px-ui-gap py-3 hover:bg-paper-100/70 transition">
                <div className="w-10 h-10 shrink-0 flex items-center justify-center bg-seal-50 rounded-control">
                  <BookOpen className="w-5 h-5 text-seal-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-ui-sm font-medium text-ink-800 line-clamp-2">{tpl.name}</p>
                    {tpl.isDefault && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 text-amber-600 text-ui-xs font-medium rounded-full shrink-0">
                        <Star className="w-3 h-3 fill-current" />
                        默认
                      </span>
                    )}
                  </div>
                  <p className="text-ui-xs text-ink-500 truncate">{tpl.publisher} · ISSN: {tpl.issn || '-'}</p>
                  <p className="text-ui-xs text-ink-400 truncate">最后更新：{tpl.lastUpdated}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => {
                      setEditingTemplate({ ...tpl })
                      setNewTemplate({ name: tpl.name, issn: tpl.issn, publisher: tpl.publisher, guidelines: tpl.guidelinesContent, formatSummary: tpl.formatSummary })
                      setShowTemplateModal(true)
                    }}
                    className="p-1.5 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded-control-sm transition"
                  >
                    <Edit3 className="w-4 h-4" />
                  </button>
                  {!tpl.isDefault && (
                    <button
                      onClick={() => handleSetDefaultTemplate(tpl.id)}
                      className="p-1.5 text-ink-400 hover:text-amber-500 hover:bg-amber-50 rounded-control-sm transition"
                    >
                      <Star className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={() => handleDeleteTemplate(tpl.id)}
                    className="p-1.5 text-ink-400 hover:text-red-600 hover:bg-red-50 rounded-control-sm transition"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleApplyTemplate(tpl.id)}
                    className="ml-1 text-ui-xs text-seal-600 hover:text-seal-700 font-medium flex items-center gap-1 shrink-0"
                  >
                    应用到项目
                    <ExternalLink className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
            <PaginationBar
              total={filteredTemplates.length}
              page={templatePage}
              totalPages={templateTotalPages}
              onPage={setTemplatePage}
            />
          </div>
          )}
          {templates.length === 0 && (
            <div className="bg-paper-50 rounded-card border border-ink-200 shadow-sm p-12 text-center">
              <div className="text-ink-400 mb-3">
                <BookOpen className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p className="text-ui-sm">暂无期刊模板</p>
                <p className="text-ui-xs mt-1">创建期刊模板，用于规范投稿格式</p>
              </div>
              <button
                onClick={() => {
                  setEditingTemplate(null)
                  setNewTemplate({ name: '', issn: '', publisher: '', guidelines: '', formatSummary: '' })
                  setShowTemplateModal(true)
                }}
                className="inline-flex items-center gap-1.5 px-ui-gap py-2 text-ui-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-control transition"
              >
                <Plus className="w-4 h-4" />
                创建第一个模板
              </button>
            </div>
          )}
          {templates.length > 0 && filteredTemplates.length === 0 && (
            <div className="bg-paper-50 rounded-card border border-ink-200 shadow-sm p-12 text-center text-ink-400 text-ui-sm">
              <Search className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>没有找到匹配的期刊模板</p>
            </div>
          )}
        </div>
      )}

      {/* ============ 知识库 Tab ============ */}
      {activeTab === 'knowledge' && (
        <div className="min-w-0 space-y-4">
            {filteredBooks.length > 0 ? (
              <div className="bg-paper-50 rounded-card border border-ink-200 shadow-sm af-divided overflow-hidden">
                {pagedBooks.map((book) => (
                  <div
                    key={book.id}
                    className="flex items-center gap-4 px-ui-gap py-3 hover:bg-paper-100/70 transition cursor-pointer"
                    onClick={() => openBookDetail(book)}
                  >
                    {/* 固定尺寸图标块（图书没有封面） */}
                    <div className="w-12 h-14 shrink-0 flex items-center justify-center bg-ink-100 text-ink-300 rounded-control">
                      <Book className="w-5 h-5" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-ui-sm font-medium text-ink-800 line-clamp-2">{book.title}</p>
                        <BookStatusBadge status={book.status} />
                      </div>
                      <p className="text-ui-xs text-ink-500 truncate mt-0.5">{book.author}</p>
                      <p className="text-ui-xs text-ink-400 truncate">
                        {[book.publisher, book.year ? `${book.year} 年` : ''].filter(Boolean).join(' · ')}
                      </p>
                      {(book.taskId || book.tags.length > 0) && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {(() => {
                            const t = tasks.find((x) => x.projectId === book.taskId)
                            return t ? (
                              <span className="px-1.5 py-0.5 bg-seal-50 text-seal-700 text-ui-xs rounded-control-sm">
                                {t.title}
                              </span>
                            ) : null
                          })()}
                          {book.tags.map((tag) => (
                            <span key={tag} className="px-1.5 py-0.5 bg-amber-50 text-amber-600 text-ui-xs rounded-control-sm">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      {(book.status === 'converting' || book.status === 'uploading') && (
                        <div className="flex items-center gap-2 mt-1">
                          <div className="h-1 flex-1 bg-ink-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-seal-500 rounded-full transition-all"
                              style={{ width: `${book.progress}%` }}
                            />
                          </div>
                          <span className="text-ui-xs text-ink-500 shrink-0">{book.progress}%</span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => handleOpenBookReading(book)}
                        className="p-1.5 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded-control-sm transition"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                      {(book.status === 'converting' || book.status === 'uploading') && (
                        <button
                          onClick={() => openBookDetail(book)}
                          className="p-1.5 text-ink-400 hover:text-blue-600 hover:bg-blue-50 rounded-control-sm transition"
                        >
                          <Loader2 className="w-4 h-4 animate-spin" />
                        </button>
                      )}
                      <button
                        onClick={() => handleDeleteBook(book.id)}
                        className="p-1.5 text-ink-400 hover:text-red-600 hover:bg-red-50 rounded-control-sm transition"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
                <PaginationBar
                  total={filteredBooks.length}
                  page={bookPage}
                  totalPages={bookTotalPages}
                  onPage={setBookPage}
                />
              </div>
            ) : books.length > 0 ? (
              <div className="bg-paper-50 rounded-card border border-ink-200 shadow-sm p-12 text-center text-ink-400 text-ui-sm">
                <Search className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p>没有找到匹配的图书</p>
              </div>
            ) : (
              <div className="bg-paper-50 rounded-card border border-ink-200 shadow-sm p-12 text-center">
                <div className="text-ink-400 mb-3">
                  <BookCopy className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p className="text-ui-sm">暂无图书数据</p>
                  <p className="text-ui-xs mt-1">上传 PDF 图书，自动转换为 Markdown</p>
                </div>
                <button
                  onClick={() => {
                    setUploadBookTaskId(presetTaskId())
                    setUploadBookTags([])
                    setShowUploadBookModal(true)
                  }}
                  className="inline-flex items-center gap-1.5 px-ui-gap py-2 text-ui-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-control transition"
                >
                  <Upload className="w-4 h-4" />
                  上传第一本图书
                </button>
              </div>
            )}
        </div>
      )}

      {/* ============ 其他文档 Tab ============ */}
      {activeTab === 'documents' && (
        <div className="space-y-4">
          {documentsLoading ? (
            <div className="bg-paper-50 rounded-card border border-ink-200 shadow-sm p-12 text-center text-ink-400 text-ui-sm">
              <div className="w-8 h-8 border-2 border-ink-200 border-t-seal-500 rounded-full animate-spin mx-auto mb-2" />
              <p>加载中...</p>
            </div>
          ) : documents.length === 0 ? (
            <div className="bg-paper-50 rounded-card border border-ink-200 shadow-sm p-12 text-center">
              <div className="text-ink-400 mb-3">
                <FileText className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p className="text-ui-sm">还没有其他文档</p>
                <p className="text-ui-xs mt-1">支持 .md / 粘贴文本 / zip</p>
              </div>
              <button
                onClick={() => setShowImportDocModal(true)}
                className="inline-flex items-center gap-1.5 px-ui-gap py-2 text-ui-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-control transition"
              >
                <Upload className="w-4 h-4" />
                导入第一个文档
              </button>
            </div>
          ) : filteredDocuments.length === 0 ? (
            <div className="bg-paper-50 rounded-card border border-ink-200 shadow-sm p-12 text-center text-ink-400 text-ui-sm">
              <Search className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>没有找到匹配的文档</p>
            </div>
          ) : (
            <div className="bg-paper-50 rounded-card border border-ink-200 shadow-sm af-divided overflow-hidden">
              {pagedDocuments.map((doc) => {
                const docTaskId = taskOf(materialMeta, 'document', doc.id)
                const docTags = tagsOf(materialMeta, 'document', doc.id)
                const docTask = tasks.find((t) => t.projectId === docTaskId)
                return (
                  <div key={doc.id} className="flex items-center gap-3 px-ui-gap py-3 hover:bg-paper-100 transition">
                    <div className="w-9 h-9 flex-shrink-0 flex items-center justify-center bg-seal-50 text-seal-600 rounded-control">
                      <FileText className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-ui-sm font-medium text-ink-800 truncate">{doc.title}</p>
                        {doc.hasContent ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-green-100 text-green-700 rounded-control-sm text-ui-2xs font-medium shrink-0">
                            <CheckCircle2 className="w-3 h-3" />
                            已导入
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-1.5 py-0.5 bg-ink-100 text-ink-500 rounded-control-sm text-ui-2xs shrink-0">
                            无正文
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-ui-xs text-ink-500">
                        <span className="truncate">{doc.author || '未知作者'}</span>
                        {docTask && (
                          <span className="truncate text-seal-600">{docTask.title}</span>
                        )}
                        {docTags.length > 0 && (
                          <span className="flex items-center gap-1 truncate">
                            <Tag className="w-3 h-3 text-ink-400" />
                            {docTags.join('、')}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleOpenDocumentReading(doc)}
                        className="p-1.5 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded-control-sm transition"
                      >
                        <BookOpen className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleEditDocument(doc)}
                        className="p-1.5 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded-control-sm transition"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteDocument(doc)}
                        className="p-1.5 text-ink-400 hover:text-red-600 hover:bg-red-50 rounded-control-sm transition"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )
              })}
              <PaginationBar
                total={filteredDocuments.length}
                page={documentPage}
                totalPages={documentTotalPages}
                onPage={setDocumentPage}
              />
            </div>
          )}
        </div>
      )}

      {/* ============ 导入导出 Tab ============ */}
      {activeTab === 'import-export' && <div className="space-y-5" />}

      {/* 添加文献弹窗 */}
      {showAddPaperModal && (
        <Modal title="手动添加文献" onClose={() => setShowAddPaperModal(false)}>
          <div className="space-y-4">
            {/* Crossref DOI 自动填充工具条 */}
            <div className="p-3 bg-seal-50 border border-seal-200 rounded-control space-y-2">
              <p className="text-ui-xs font-semibold text-seal-700 flex items-center gap-1.5">
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
                  className="flex-1 px-ui-gap py-2 border border-seal-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-500 focus:ring-2 focus:ring-seal-100 bg-paper-50"
                />
                <button
                  onClick={() => handleFetchFromDoi(newPaper.doi)}
                  disabled={doiFetching || !newPaper.doi.trim()}
                  className="px-ui-gap py-2 text-ui-sm font-medium text-paper-50 bg-seal-600 hover:bg-seal-700 disabled:bg-ink-400 disabled:cursor-not-allowed rounded-control transition flex items-center gap-1.5 whitespace-nowrap"
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
                <p className="text-ui-xs text-red-600">{doiFetchError}</p>
              )}
              <p className="text-ui-xs text-seal-500/70">
                DOI 填充后可手动调整标题/作者/期刊/关键词等字段
              </p>
            </div>

            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">标题 *</label>
              <input
                type="text"
                value={newPaper.title}
                onChange={(e) => setNewPaper({ ...newPaper, title: e.target.value })}
                placeholder="请输入文献标题"
                className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>
            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">作者</label>
              <input
                type="text"
                value={newPaper.authors}
                onChange={(e) => setNewPaper({ ...newPaper, authors: e.target.value })}
                placeholder="多个作者用逗号分隔"
                className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">年份</label>
                <input
                  type="text"
                  value={newPaper.year}
                  onChange={(e) => setNewPaper({ ...newPaper, year: e.target.value })}
                  placeholder="2024"
                  className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
              </div>
              <div>
                <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">期刊</label>
                <input
                  type="text"
                  value={newPaper.journal}
                  onChange={(e) => setNewPaper({ ...newPaper, journal: e.target.value })}
                  placeholder="期刊名称"
                  className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
              </div>
            </div>
            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">DOI</label>
              <input
                type="text"
                value={newPaper.doi}
                onChange={(e) => setNewPaper({ ...newPaper, doi: e.target.value })}
                placeholder="10.1000/sample.00000001"
                className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>
            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">关键词</label>
              <input
                type="text"
                value={newPaper.keywords}
                onChange={(e) => setNewPaper({ ...newPaper, keywords: e.target.value })}
                placeholder="多个关键词用逗号分隔"
                className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">英文摘要</label>
                <textarea
                  value={newPaper.abstractEn}
                  onChange={(e) => setNewPaper({ ...newPaper, abstractEn: e.target.value })}
                  rows={3}
                  placeholder="摘要翻译练习（英译中）的题面。DOI 自动填充会带回来"
                  className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 resize-none"
                />
              </div>
              <div>
                <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">中文摘要</label>
                <textarea
                  value={newPaper.abstractCn}
                  onChange={(e) => setNewPaper({ ...newPaper, abstractCn: e.target.value })}
                  rows={3}
                  placeholder="英译中的参考答案 / 中译英的题面。只靠 DOI 元数据通常只有英文摘要，可在此补齐"
                  className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 resize-none"
                />
              </div>
            </div>
            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">文献等级</label>
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
                  <span className="text-ui-sm text-ink-700">
                    ✨ 自动
                    <span className="text-ui-xs text-ink-400 ml-1">（按标题/期刊推断，综述类为二级）</span>
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
                  <span className="text-ui-sm text-ink-700">📄 一级</span>
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
                  <span className="text-ui-sm text-ink-700">📖 二级</span>
                </label>
              </div>
            </div>
            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">归属任务</label>
              <TaskSelect value={newPaper.taskId} onChange={(v) => setNewPaper({ ...newPaper, taskId: v })} tasks={tasks} currentProjectId={currentProjectId} />
            </div>
            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">标签</label>
              <TagEditor value={newPaper.tags} onChange={(tags) => setNewPaper({ ...newPaper, tags })} />
            </div>
            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">上传 PDF（自动转MD）</label>
              <div className="border-2 border-dashed border-ink-200 rounded-control p-6 text-center hover:border-seal-300 transition cursor-pointer">
                <Upload className="w-8 h-8 mx-auto mb-2 text-ink-300" />
                <p className="text-ui-sm text-ink-500">点击或拖拽 PDF 到此处</p>
                <p className="text-ui-xs text-ink-400 mt-1">PDF 上传后自动转换为 Markdown</p>
                <input type="file" accept=".pdf" className="hidden" />
              </div>
            </div>
          </div>
          <div className="af-line-t flex items-center justify-end gap-2 mt-6 pt-4">
            <button
              onClick={() => setShowAddPaperModal(false)}
              className="px-ui-gap py-2 text-ui-sm text-ink-600 hover:bg-ink-100 rounded-control transition"
            >
              取消
            </button>
            <button
              onClick={handleAddPaper}
              disabled={savingPaper}
              className="flex items-center gap-2 px-ui-gap py-2 text-ui-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-control transition disabled:opacity-60"
            >
              {savingPaper ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {savingPaper ? '添加中…' : '添加'}
            </button>
          </div>
        </Modal>
      )}

      {/* 编辑文献弹窗 */}
      {showEditPaperModal && editingPaper && (
        <Modal title="编辑文献" onClose={() => { setShowEditPaperModal(false); setEditingPaper(null); setPaperWords(null); setPaperWordsDirty(false) }} width="max-w-2xl">
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">题图</label>
                <div className="aspect-square rounded-control overflow-hidden bg-ink-100 border border-ink-200 flex items-center justify-center">
                  {editingPaper.coverImage ? (
                    <img src={editingPaper.coverImage} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <ImageIcon className="w-8 h-8 text-ink-300" />
                  )}
                </div>
                <div className="mt-2 space-y-1">
                  <label className="flex items-center justify-center gap-1 px-2 py-1.5 text-ui-xs text-ink-600 bg-paper-100 border border-ink-200 hover:bg-ink-100 rounded-control-sm cursor-pointer transition">
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
                    className="w-full flex items-center justify-center gap-1 px-2 py-1.5 text-ui-xs text-ink-600 bg-paper-100 border border-ink-200 hover:bg-ink-100 rounded-control-sm transition"
                  >
                    <LinkIcon className="w-3.5 h-3.5" />
                    从URL添加
                  </button>
                </div>
              </div>
              <div className="col-span-2 space-y-4">
                <div>
                  <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">标题 *</label>
                  <input
                    type="text"
                    value={editingPaper.title}
                    onChange={(e) => setEditingPaper({ ...editingPaper, title: e.target.value })}
                    className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                  />
                </div>
                <div>
                  <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">作者</label>
                  <input
                    type="text"
                    value={editingPaper.authors}
                    onChange={(e) => setEditingPaper({ ...editingPaper, authors: e.target.value })}
                    placeholder="多个作者用逗号分隔"
                    className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                  />
                </div>
                <div>
                  <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">通讯作者</label>
                  <input
                    type="text"
                    value={editingPaper.correspondingAuthor}
                    onChange={(e) => setEditingPaper({ ...editingPaper, correspondingAuthor: e.target.value })}
                    placeholder="PDF 转换后自动从全文抽取；也可在这里手改"
                    className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">年份</label>
                    <input
                      type="text"
                      value={editingPaper.year}
                      onChange={(e) => setEditingPaper({ ...editingPaper, year: e.target.value })}
                      className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                    />
                  </div>
                  <div>
                    <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">期刊</label>
                    <input
                      type="text"
                      value={editingPaper.journal}
                      onChange={(e) => setEditingPaper({ ...editingPaper, journal: e.target.value })}
                      className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">关键词</label>
              <input
                type="text"
                value={editingPaper.keywords.join(', ')}
                onChange={(e) => setEditingPaper({ ...editingPaper, keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) })}
                placeholder="多个关键词用逗号分隔"
                className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">英文摘要</label>
                <textarea
                  value={editingPaper.abstractEn}
                  onChange={(e) => setEditingPaper({ ...editingPaper, abstractEn: e.target.value })}
                  rows={4}
                  placeholder="摘要翻译练习（英译中）的题面"
                  className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 resize-none"
                />
              </div>
              <div>
                <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">中文摘要</label>
                <textarea
                  value={editingPaper.abstractCn}
                  onChange={(e) => setEditingPaper({ ...editingPaper, abstractCn: e.target.value })}
                  rows={4}
                  placeholder="英译中的参考答案 / 中译英的题面"
                  className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 resize-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">DOI</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={editingPaper.doi}
                  onChange={(e) => setEditingPaper({ ...editingPaper, doi: e.target.value })}
                  className="flex-1 px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
                <DoiLink
                  doi={editingPaper.doi}
                  showIcon
                  className="flex items-center gap-1 px-ui-gap py-2 text-ui-sm bg-seal-50 hover:bg-seal-100 rounded-control transition"
                />
              </div>
            </div>

            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">文献等级</label>
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
                  <span className="text-ui-sm text-ink-700">📄 一级文献（原创研究）</span>
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
                  <span className="text-ui-sm text-ink-700">📖 二级文献（综述/评述）</span>
                </label>
                <button
                  type="button"
                  onClick={() => setEditingPaper({
                    ...editingPaper,
                    // 按当前标题/期刊重新自动推断
                    tier: inferPaperTier(editingPaper.title, editingPaper.journal),
                  })}
                  className="text-ui-xs px-2 py-1 bg-seal-50 text-seal-600 rounded-control-sm hover:bg-seal-100 transition"
                >
                  ✨ 按标题重新推断
                </button>
              </div>
            </div>

            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">归属任务</label>
              <TaskSelect value={editingPaper.taskId} onChange={(v) => setEditingPaper({ ...editingPaper, taskId: v })} tasks={tasks} currentProjectId={currentProjectId} />
            </div>
            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">标签</label>
              <TagEditor value={editingPaper.tags} onChange={(tags) => setEditingPaper({ ...editingPaper, tags })} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">Markdown 转换</label>
                <div className="p-3 border border-ink-200 rounded-control bg-paper-100/50">
                  <div className="flex items-center justify-between mb-2">
                    <StatusBadge status={editingPaper.mdStatus} />
                    {editingPaper.mdStatus === 'done' && (
                      <button className="text-ui-xs text-seal-600 hover:underline">查看</button>
                    )}
                    {editingPaper.mdStatus === 'converting' && (
                      <span className="text-ui-2xs text-ink-400">
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
                      <span className="text-ui-xs text-ink-500 font-mono tabular-nums">
                        {Math.round(editingPaper.mdProgress)}%
                      </span>
                    </div>
                  )}
                  {editingPaper.mdStatus === 'done' && (
                    <div className="text-ui-xs text-green-600 italic">✓ 全流程完成</div>
                  )}
                  {editingPaper.mdStatus === 'failed' && (
                    <div className="text-ui-xs text-red-500 italic">
                      转换失败，可重新上传
                    </div>
                  )}
                  {(editingPaper.mdStatus === 'none' || editingPaper.mdStatus === 'failed') && (
                    <label className="flex items-center justify-center gap-1 mt-2 px-ui-gap py-1.5 text-ui-xs text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-control-sm cursor-pointer transition">
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
                <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">笔记</label>
                <div className="p-3 border border-ink-200 rounded-control bg-paper-100/50">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <StickyNote
                          className={`w-4 h-4 ${
                            paperNoteInfo.notes.length > 0 || paperNoteInfo.annotations > 0
                              ? 'text-amber-500'
                              : 'text-ink-300'
                          }`}
                        />
                        <span className="text-ui-sm text-ink-700">
                          {paperNoteInfo.loading
                            ? '读取中…'
                            : paperNoteInfo.notes.length > 0 || paperNoteInfo.annotations > 0
                              ? `有 ${paperNoteInfo.notes.length} 篇笔记 · ${paperNoteInfo.annotations} 条批注`
                              : '暂无笔记'}
                        </span>
                      </div>
                      {!paperNoteInfo.loading && paperNoteInfo.notes.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {paperNoteInfo.notes.map((n) => (
                            <span
                              key={n}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-ink-100 text-ink-600 text-ui-xs rounded-control-sm"
                            >
                              <FileText className="w-3 h-3" />
                              {n}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="text-ui-xs text-ink-400 mt-1.5">
                        笔记在阅读页维护：一篇文献可以写多篇命名笔记，也可上传 md / docx / zip 的总结文稿。
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        setShowEditPaperModal(false)
                        handleOpenReading(editingPaper)
                      }}
                      className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1.5 text-ui-xs bg-seal-600 text-paper-50 rounded-control-sm hover:bg-seal-700 transition"
                    >
                      <StickyNote className="w-3.5 h-3.5" />
                      打开笔记
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <PaperMorphemeSection
              doi={editingPaper.doi}
              words={paperWords}
              onChange={(next) => { setPaperWords(next); setPaperWordsDirty(true) }}
            />
          </div>

          <div className="af-line-t flex items-center justify-end gap-2 mt-6 pt-4">
            <button
              onClick={() => { setShowEditPaperModal(false); setEditingPaper(null); setPaperWords(null); setPaperWordsDirty(false) }}
              className="px-ui-gap py-2 text-ui-sm text-ink-600 hover:bg-ink-100 rounded-control transition"
            >
              取消
            </button>
            <button
              onClick={handleSavePaper}
              disabled={savingPaper}
              className="flex items-center gap-2 px-ui-gap py-2 text-ui-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-control transition disabled:opacity-60"
            >
              {savingPaper ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              {savingPaper ? '保存中…' : '保存'}
            </button>
          </div>
        </Modal>
      )}

      {/* 批量移动任务弹窗 */}
      {showBatchMoveModal && (
        <Modal title="批量移动任务" onClose={() => { setShowBatchMoveModal(false); setBatchMoveTaskId('') }}>
          <div className="space-y-4">
            <p className="text-ui-sm text-ink-600">
              已选中 <span className="font-semibold text-seal-600">{selectedPapers.size}</span> 篇文献，选择目标任务：
            </p>
            <TaskSelect value={batchMoveTaskId} onChange={setBatchMoveTaskId} tasks={tasks} currentProjectId={currentProjectId} />
          </div>
          <div className="af-line-t flex items-center justify-end gap-2 mt-6 pt-4">
            <button
              onClick={() => { setShowBatchMoveModal(false); setBatchMoveTaskId('') }}
              className="px-ui-gap py-2 text-ui-sm text-ink-600 hover:bg-ink-100 rounded-control transition"
            >
              取消
            </button>
            <button
              onClick={handleBatchMove}
              className="flex items-center gap-2 px-ui-gap py-2 text-ui-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-control transition"
            >
              <MoveRight className="w-4 h-4" />
              确认移动
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
                <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">期刊名 *</label>
                <input
                  type="text"
                  value={newTemplate.name}
                  onChange={(e) => setNewTemplate({ ...newTemplate, name: e.target.value })}
                  placeholder="如：Sample Journal"
                  className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
              </div>
              <div>
                <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">ISSN</label>
                <input
                  type="text"
                  value={newTemplate.issn}
                  onChange={(e) => setNewTemplate({ ...newTemplate, issn: e.target.value })}
                  placeholder="如：2058-7546"
                  className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
              </div>
            </div>
            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">出版社</label>
              <input
                type="text"
                value={newTemplate.publisher}
                onChange={(e) => setNewTemplate({ ...newTemplate, publisher: e.target.value })}
                placeholder="如：示例出版社"
                className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>
            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">投稿须知原文（AI 提取的依据）</label>
              <div className="space-y-2">
                <div className="flex gap-2">
                  <label className="flex-1 flex items-center justify-center gap-2 px-ui-gap py-2 text-ui-sm text-ink-600 bg-paper-100 border border-ink-200 hover:bg-ink-100 rounded-control cursor-pointer transition">
                    <FileText className="w-4 h-4" />
                    上传投稿须知文件（.txt/.md）
                    <input
                      type="file"
                      accept=".txt,.md,text/plain,text/markdown"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        try {
                          const text = await file.text()
                          setNewTemplate((prev) => ({ ...prev, guidelines: text }))
                        } catch {
                          toast.error('读取文件失败，请直接把内容粘贴到下方文本框')
                        } finally {
                          e.target.value = ''
                        }
                      }}
                    />
                  </label>
                  <button
                    onClick={handleExtractFormat}
                    disabled={isExtracting}
                    className="flex items-center gap-2 px-ui-gap py-2 text-ui-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-control transition disabled:opacity-60"
                  >
                    <Sparkles className={`w-4 h-4 ${isExtracting ? 'animate-spin' : ''}`} />
                    {isExtracting ? '提取中...' : 'AI提取'}
                  </button>
                </div>
                <textarea
                  value={newTemplate.guidelines}
                  onChange={(e) => setNewTemplate({ ...newTemplate, guidelines: e.target.value })}
                  placeholder="直接粘贴投稿须知原文（或上传文件）—— 这是 AI 提取格式规范的唯一依据，请保持与原文一致..."
                  rows={5}
                  className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 resize-none"
                />
              </div>
            </div>
            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">
                格式规范摘要（可编辑，点「AI提取」生成草稿后请人工确认）
              </label>
              <textarea
                value={newTemplate.formatSummary}
                onChange={(e) => setNewTemplate({ ...newTemplate, formatSummary: e.target.value })}
                placeholder="点上方「AI提取」生成草稿；这里的内容可在保存前直接修改。它只依据上面的投稿须知原文，不引入外部知识。"
                rows={5}
                className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 resize-y"
              />
              <p className="text-ui-xs text-ink-400 mt-1">保存后写入模板的 meta.md（notes），用于排版时提示写作 AI 统一格式。</p>
            </div>
          </div>
          <div className="af-line-t flex items-center justify-end gap-2 mt-6 pt-4">
            <button
              onClick={() => { setShowTemplateModal(false); setEditingTemplate(null) }}
              className="px-ui-gap py-2 text-ui-sm text-ink-600 hover:bg-ink-100 rounded-control transition"
            >
              取消
            </button>
            <button
              onClick={editingTemplate ? handleSaveTemplate : handleAddTemplate}
              disabled={savingTemplate}
              className="flex items-center gap-2 px-ui-gap py-2 text-ui-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-control transition disabled:opacity-60"
            >
              {savingTemplate ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {savingTemplate ? (editingTemplate ? '保存中…' : '创建中…') : (editingTemplate ? '保存修改' : '创建模板')}
            </button>
          </div>
        </Modal>
      )}

      {/* 上传图书弹窗 */}
      {showUploadBookModal && (
        <Modal title="上传图书" onClose={() => { setShowUploadBookModal(false); setUploadBookTaskId(''); setUploadBookTags([]) }}>
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
              className={`border-2 border-dashed rounded-card p-8 text-center transition ${
                isDragOverBook
                  ? 'border-seal-400 bg-seal-50/50'
                  : 'border-ink-200 bg-paper-100 hover:border-seal-200 hover:bg-seal-50/30'
              }`}
            >
              <Upload className="w-10 h-10 mx-auto mb-3 text-ink-400" />
              <p className="text-ui-sm text-ink-600 font-medium">拖拽或点击上传 PDF 图书</p>
              <p className="text-ui-xs text-ink-400 mt-1">支持多文件上传，自动转换为 Markdown</p>
              <p className="text-ui-xs text-seal-500 mt-1">超过200页自动按180页切分</p>
              <label className="inline-flex items-center gap-2 mt-4 px-ui-gap py-2 text-ui-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-control transition cursor-pointer">
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
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">归属任务</label>
              <TaskSelect value={uploadBookTaskId} onChange={setUploadBookTaskId} tasks={tasks} currentProjectId={currentProjectId} />
            </div>
            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">标签</label>
              <TagEditor value={uploadBookTags} onChange={setUploadBookTags} />
            </div>
          </div>
          <div className="af-line-t flex items-center justify-end gap-2 mt-6 pt-4">
            <button
              onClick={() => { setShowUploadBookModal(false); setUploadBookTaskId(''); setUploadBookTags([]) }}
              className="px-ui-gap py-2 text-ui-sm text-ink-600 hover:bg-ink-100 rounded-control transition"
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
              <div className="w-24 h-32 flex-shrink-0 rounded-control overflow-hidden bg-ink-100">
                {showBookDetail.coverImage ? (
                  <img src={showBookDetail.coverImage} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-ink-300">
                    <Book className="w-8 h-8" />
                  </div>
                )}
              </div>
              <div className="flex-1 space-y-1.5">
                <p className="text-ui-sm text-ink-600"><span className="text-ink-400">作者：</span>{showBookDetail.author}</p>
                <p className="text-ui-sm text-ink-600"><span className="text-ink-400">出版社：</span>{showBookDetail.publisher}</p>
                <p className="text-ui-sm text-ink-600"><span className="text-ink-400">年份：</span>{showBookDetail.year || '—'}</p>
                <p className="text-ui-sm text-ink-600"><span className="text-ink-400">状态：</span>
                  <BookStatusBadge status={showBookDetail.status} />
                </p>
              </div>
            </div>

            {/* 给这本图书设置归属任务 + 标签（主键 = 书名） */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-ui-sm font-medium text-ink-700">归属任务</label>
                <button
                  onClick={handleSaveBookDetail}
                  className="text-ui-xs px-2.5 py-1 text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-control-sm transition"
                >
                  保存归属
                </button>
              </div>
              <TaskSelect value={bookDetailTaskId} onChange={setBookDetailTaskId} tasks={tasks} currentProjectId={currentProjectId} />
              <label className="block text-ui-sm font-medium text-ink-700">标签</label>
              <TagEditor value={bookDetailTags} onChange={setBookDetailTags} />
            </div>
          </div>
          <div className="af-line-t flex items-center justify-between gap-2 mt-6 pt-4">
            <button
              onClick={() => setShowBookDetail(null)}
              className="px-ui-gap py-2 text-ui-sm text-ink-600 hover:bg-ink-100 rounded-control transition"
            >
              关闭
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setEditingBookId(showBookDetail.id)}
                className="flex items-center gap-1.5 px-ui-gap py-2 text-ui-sm text-ink-600 hover:bg-ink-100 rounded-control transition"
              >
                <Edit3 className="w-4 h-4" />
                编辑图书
              </button>
              {showBookDetail.status === 'done' && (
                <button className="flex items-center gap-2 px-ui-gap py-2 text-ui-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-control transition">
                  <Book className="w-4 h-4" />
                  开始阅读
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* 图书编辑弹窗（改书名 / 改大纲层级 / 改正文）—— 与阅读页共用同一组件 */}
      {editingBookId && (
        <BookEditModal
          bookId={editingBookId}
          onClose={() => setEditingBookId(null)}
          onRenamed={() => {
            setEditingBookId(null)
            setShowBookDetail(null)
            setBooksReloadKey((k) => k + 1)
          }}
          onSaved={() => setBooksReloadKey((k) => k + 1)}
        />
      )}

      {/* 导入其他文档弹窗（三种方式：上传 .md / 粘贴 / zip） */}
      {showImportDocModal && (
        <Modal
          title="导入文档"
          onClose={() => { if (!importing) setShowImportDocModal(false) }}
          width="max-w-2xl"
        >
          <div className="flex items-center gap-1 p-1 bg-ink-100 rounded-control mb-5 w-fit">
            {([
              { id: 'file', label: '上传 .md 文件' },
              { id: 'paste', label: '粘贴文本' },
              { id: 'zip', label: '上传 zip' },
            ] as const).map((m) => (
              <button
                key={m.id}
                onClick={() => setImportMode(m.id)}
                disabled={importing}
                className={`px-ui-gap py-1.5 rounded-control-sm text-ui-sm font-medium transition disabled:opacity-60 ${
                  importMode === m.id ? 'bg-paper-50 text-seal-600 shadow-sm' : 'text-ink-500 hover:text-ink-700'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {importMode === 'file' && (
            <label
              className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-card p-8 text-center transition ${
                importing ? 'opacity-60 pointer-events-none' : 'border-ink-200 bg-paper-100 hover:border-seal-200 hover:bg-seal-50/30 cursor-pointer'
              }`}
            >
              {importing
                ? <Loader2 className="w-10 h-10 text-seal-500 animate-spin" />
                : <Upload className="w-10 h-10 text-ink-400" />}
              <p className="text-ui-sm text-ink-600 font-medium">{importing ? '导入中...' : '点击选择 .md / .markdown / .txt 文件'}</p>
              <p className="text-ui-xs text-ink-400">支持多选，标题取文件名</p>
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
                <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">标题 *</label>
                <input
                  type="text"
                  value={pasteDoc.title}
                  onChange={(e) => setPasteDoc({ ...pasteDoc, title: e.target.value })}
                  placeholder="文档标题"
                  disabled={importing}
                  className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
              </div>
              <div>
                <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">Markdown 内容 *</label>
                <textarea
                  value={pasteDoc.content}
                  onChange={(e) => setPasteDoc({ ...pasteDoc, content: e.target.value })}
                  placeholder="在此粘贴 markdown 正文..."
                  rows={10}
                  disabled={importing}
                  className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm font-mono focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 resize-y"
                />
              </div>
            </div>
          )}

          {importMode === 'zip' && (
            <label
              className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-card p-8 text-center transition ${
                importing ? 'opacity-60 pointer-events-none' : 'border-ink-200 bg-paper-100 hover:border-seal-200 hover:bg-seal-50/30 cursor-pointer'
              }`}
            >
              {importing
                ? <Loader2 className="w-10 h-10 text-seal-500 animate-spin" />
                : <Folder className="w-10 h-10 text-ink-400" />}
              <p className="text-ui-sm text-ink-600 font-medium">{importing ? '导入中...' : '点击选择 .zip 压缩包'}</p>
              <p className="text-ui-xs text-ink-400">自动解出包内所有 .md / .markdown / .txt 条目</p>
              <input
                type="file"
                accept=".zip"
                className="hidden"
                disabled={importing}
                onChange={(e) => { void handleImportZip(e.target.files?.[0]); e.target.value = '' }}
              />
            </label>
          )}

          <div className="af-line-t flex items-center justify-end gap-2 mt-6 pt-4">
            {importMode === 'paste' && (
              <button
                onClick={handlePasteImport}
                disabled={importing}
                className="flex items-center gap-2 px-ui-gap py-2 text-ui-sm text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-control transition disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                {importing ? '导入中...' : '导入'}
              </button>
            )}
            <button
              onClick={() => { if (!importing) setShowImportDocModal(false) }}
              disabled={importing}
              className="px-ui-gap py-2 text-ui-sm text-ink-600 hover:bg-ink-100 rounded-control transition disabled:opacity-60"
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
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">标题 *</label>
              <input
                type="text"
                value={editDocForm.title}
                onChange={(e) => setEditDocForm({ ...editDocForm, title: e.target.value })}
                placeholder="文档标题"
                className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>
            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">作者</label>
              <input
                type="text"
                value={editDocForm.author}
                onChange={(e) => setEditDocForm({ ...editDocForm, author: e.target.value })}
                placeholder="作者（可留空）"
                className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>
            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">归属任务</label>
              <TaskSelect value={editDocForm.taskId} onChange={(v) => setEditDocForm({ ...editDocForm, taskId: v })} tasks={tasks} currentProjectId={currentProjectId} />
            </div>
            <div>
              <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">标签</label>
              <TagEditor value={editDocForm.tags} onChange={(tags) => setEditDocForm({ ...editDocForm, tags })} />
            </div>
          </div>
          <div className="af-line-t flex items-center justify-end gap-2 mt-6 pt-4">
            <button
              onClick={() => { if (!savingDocument) setEditingDocument(null) }}
              disabled={savingDocument}
              className="px-ui-gap py-2 text-ui-sm text-ink-600 hover:bg-ink-100 rounded-control transition disabled:opacity-60"
            >
              取消
            </button>
            <button
              onClick={handleSaveDocument}
              disabled={savingDocument || !editDocForm.title.trim()}
              className="flex items-center gap-2 px-ui-gap py-2 text-ui-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 rounded-control transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {savingDocument ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              {savingDocument ? '保存中…' : '保存'}
            </button>
          </div>
        </Modal>
      )}

      {/* 图片灯箱 */}
      {showImageLightbox && (
        <ImageLightbox src={showImageLightbox} onClose={() => setShowImageLightbox(null)} />
      )}
      </div>{/* ──── 中：内容 END ──── */}

      {/* ──── 右侧 后台监控面板（常驻、不弹窗；拉满整列高，滚动由面板内部承担） ──── */}
      <aside className="hidden min-w-0 min-h-0 lg:block">
        <BackendMonitorPanel taskQueue={taskQueue} />
      </aside>

      {/* 全文检索结果：命中片段 + 点结果去阅读页滚动定位并高亮 */}
      {ftOpen && (
        <Modal title={`全文检索 · ${ftQuery}`} onClose={() => setFtOpen(false)} width="max-w-3xl">
          {ftLoading ? (
            <div className="text-center py-10 text-ink-400 text-ui-sm">
              <div className="w-8 h-8 border-2 border-ink-200 border-t-seal-500 rounded-full animate-spin mx-auto mb-2" />
              {getSearchIndex()
                ? '正在检索…'
                : `首次检索，正在建立全文索引 ${ftProgress.done}/${ftProgress.total}`}
            </div>
          ) : ftHits.length === 0 ? (
            <div className="text-center py-10 text-ink-400 text-ui-sm">
              <Search className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p>全库正文里没有匹配的词</p>
              <p className="text-ui-xs mt-1">检索范围：文献 / 图书 / 其他文档的正文</p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-ui-xs text-ink-400">
                {ftHits.length} 篇命中
              </div>
              {ftHits.map((hit) => (
                <button
                  key={`${hit.kind}:${hit.id}`}
                  onClick={() => openHitInReader(hit)}
                  className="w-full text-left p-3 rounded-control border border-ink-200 hover:border-seal-300 hover:bg-seal-50/40 transition"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex-shrink-0 px-1.5 py-0.5 rounded-control-sm bg-ink-100 text-ink-500 text-ui-2xs">
                      {KIND_LABEL[hit.kind]}
                    </span>
                    <span className="text-ui-sm font-medium text-ink-700 truncate">{hit.title}</span>
                    <span className="ml-auto flex-shrink-0 text-ui-xs text-ink-400">{hit.total} 处</span>
                  </div>
                  {hit.snippets.map((sn, i) => (
                    <div key={i} className="mt-1.5 text-ui-xs leading-relaxed text-ink-500 line-clamp-3">
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
    </div>
  )
}
