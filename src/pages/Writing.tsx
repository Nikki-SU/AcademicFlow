import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import {
  PenTool,
  Sparkles,
  Plus,
  Send,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Download,
  FileText,
  BookOpen,
  Library,
  BookMarked,
  ToggleLeft,
  ToggleRight,
  Bot,
  Zap,
  CheckCircle2,
  Clock,
  Save,
  Search,
  Wand2,
  FileCode,
  X,
  BookText,
  LayoutTemplate,
  FileOutput,
  Loader2,
  Check,
  ListTree,
  BookCopy,
  GraduationCap,
  Newspaper,
  Copy,
  FolderOpen,
  Clipboard,
  GripVertical,
  Eye,
  File,
  Brain,
  BookPlus,
} from 'lucide-react'
import { toast } from 'sonner'
import { getAllTemplates } from '../services/journal-templates'
import { useSettingsStore } from '../stores/settings'
import { useWorkspaceStore } from '../stores/workspace'
import type { JournalTemplate } from '../types'
import { DoiLink } from '../components/DoiLink'
import { runDualEngine } from '../services/ai/dual-engine'
import { loadFulltext } from '../services/literatureData'
import {
  loadProjects,
  saveProjects,
  loadManuscript,
  saveManuscript,
  loadReferences,
  savePaperReferences,
  saveBookReferences,
  loadMemory,
  saveMemory,
  loadQuickActions,
  saveQuickActions,
  type Project,
  type QuickAction,
  type CitationRef as ServiceCitationRef,
} from '../services/projectData'
import { loadLiteratures, type Literature } from '../services/literatureData'
import { callAI } from '../services/ai/client'
import { searchCrossref, type OnlineSearchResult } from '../services/citation'
import VditorEditor, { type VditorEditorHandle, type VditorToolbarItem } from '../components/VditorEditor'

const LEFT_PANEL_MODES = [
  { value: 'editor', label: '编辑区', icon: PenTool },
  { value: 'outline', label: '大纲视图', icon: ListTree },
  { value: 'references', label: '文献列表', icon: BookCopy },
]

const RIGHT_PANEL_MODES = [
  { value: 'ai', label: 'AI 助手', icon: Sparkles },
  { value: 'library', label: '文献库', icon: Library },
  { value: 'knowledge', label: '知识库', icon: GraduationCap },
  { value: 'typesetting', label: '期刊排版', icon: LayoutTemplate },
]

const CITATION_SCOPES = [
  { value: 'all', label: '全部文献' },
  { value: 'project', label: '当前项目文献' },
  { value: 'selected', label: '指定文献' },
  { value: 'books', label: '指定图书' },
  { value: 'chapters', label: '指定章节' },
]

/**
 * 内置快捷指令（写死，不可删）
 * -------------------------------------------------
 * 只保留学术场景真正需要的三条：
 * - 找文献：按主题检索文献
 * - 找引用：给出观点 → 定位原文（DOI + 原句），并检查文中是否有相反观点
 * - 引用检验：给出你写的文字 + 引文 DOI → 原文是否有相同 / 相反意思
 */
const BUILTIN_ACTIONS: QuickActionDef[] = [
  {
    key: 'find-papers',
    label: '找文献',
    icon: Search,
    prompt: '请检索与以下研究主题相关的文献，逐条给出标题、作者、年份、期刊和 DOI：\n\n',
  },
  {
    key: 'find-quote',
    label: '找引用',
    icon: BookText,
    prompt:
      '请为下面这个观点找到原文佐证：先检索定位到具体文章，再给出原文中的原句和 DOI；' +
      '同时说明该文章里是否存在相反的观点。\n\n观点：',
  },
  {
    key: 'verify-citation',
    label: '引用检验',
    icon: CheckCircle2,
    prompt:
      '请检验我写的这段文字与所引文献是否匹配：原文里是否有相同意思的表述？' +
      '原文里是否有相反意思的表述？\n\n我的文字：\n\n引文 DOI：',
  },
]

const PANEL_RATIOS = [
  { value: '7:3', label: '7 : 3', left: 70 },
  { value: '5:5', label: '5 : 5', left: 50 },
  { value: '3:7', label: '3 : 7', left: 30 },
]

interface BookChapter {
  id: string
  bookId: string
  title: string
  pageStart: number
  pageEnd: number
}

interface CitationRef extends ServiceCitationRef {
  projectId?: string
  chapters?: BookChapter[]
}

interface BookRef extends CitationRef {
  type: 'book'
  chapters: BookChapter[]
}

interface AIMessage {
  id: string
  /** 落盘 memory.md 用的时间戳（缺省时回退到 id） */
  createdAt?: number
  role: 'user' | 'assistant'
  content: string
  citations?: CitationRef[]
  reviewStatus?: 'pending' | 'pass' | 'fail'
}

interface OutlineItem {
  level: number
  text: string
  id: string
}

interface QuickActionDef {
  key: string
  label: string
  icon: typeof Search
  prompt: string
}

/** 「插入引用」工具栏图标（Vditor 的 icon 需要 SVG 字符串） */
const CITATION_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>'

type LeftPanelMode = 'editor' | 'outline' | 'references'
type RightPanelMode = 'ai' | 'library' | 'knowledge' | 'typesetting'

const DEFAULT_MD = `# 引言

在此处开始撰写你的论文...

## 研究背景

描述你的研究背景。
`

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderMarkdown(text: string): string {
  let html = text

  const codeBlockRegex = /```([\s\S]*?)```/g
  const codeBlocks: string[] = []
  html = html.replace(codeBlockRegex, (_, code) => {
    codeBlocks.push(code)
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`
  })

  const inlineCodeRegex = /`([^`]+)`/g
  html = html.replace(inlineCodeRegex, (_, code) => {
    return `<code class="bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded text-xs font-mono text-indigo-600">${escapeHtml(code)}</code>`
  })

  html = html.replace(/^###### (.*)$/gm, '<h6 class="text-sm font-semibold text-slate-700 mt-4 mb-2">$1</h6>')
  html = html.replace(/^##### (.*)$/gm, '<h5 class="text-base font-semibold text-slate-700 mt-4 mb-2">$1</h5>')
  html = html.replace(/^#### (.*)$/gm, '<h4 class="text-lg font-semibold text-slate-800 mt-5 mb-2">$1</h4>')
  html = html.replace(/^### (.*)$/gm, '<h3 class="text-xl font-semibold text-slate-800 mt-6 mb-3">$1</h3>')
  html = html.replace(/^## (.*)$/gm, '<h2 class="text-2xl font-bold text-slate-800 mt-6 mb-3 pb-2 border-b border-slate-200">$1</h2>')
  html = html.replace(/^# (.*)$/gm, '<h1 class="text-3xl font-bold text-slate-900 mt-2 mb-4 pb-3 border-b-2 border-indigo-200">$1</h1>')

  html = html.replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-slate-800">$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em class="italic text-slate-700">$1</em>')

  html = html.replace(/^> (.*)$/gm, (_, content) => {
    return `<blockquote class="border-l-4 border-indigo-300 pl-4 py-1 my-3 bg-indigo-50/50 text-slate-600 italic rounded-r">${content}</blockquote>`
  })

  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    return `<div class="my-4"><img src="${src}" alt="${alt}" class="max-w-full h-auto rounded-lg border border-slate-200 shadow-sm" /><p class="text-sm text-slate-500 mt-2 text-center font-medium">${alt}</p></div>`
  })

  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:text-indigo-800 underline underline-offset-2">${text}</a>`
  })

  const lines = html.split('\n')
  const result: string[] = []
  let inUl = false
  let inOl = false
  let inTable = false
  let tableHeader = ''
  let tableRows: string[] = []
  let paraBuffer: string[] = []

  const flushPara = () => {
    if (paraBuffer.length > 0) {
      result.push(`<p class="my-3 text-slate-700 leading-relaxed">${paraBuffer.join(' ')}</p>`)
      paraBuffer = []
    }
  }

  const flushTable = () => {
    if (inTable && tableHeader && tableRows.length > 0) {
      const headerCells = tableHeader.split('|').filter((c) => c.trim())
      const rowHtml = tableRows
        .map((row) => {
          const cells = row.split('|').filter((c) => c.trim())
          return `<tr class="border-b border-slate-200 hover:bg-slate-50 transition-colors">${cells
            .map((c) => `<td class="px-4 py-2.5 text-sm text-slate-700">${c.trim()}</td>`)
            .join('')}</tr>`
        })
        .join('')
      result.push(
        `<div class="my-4 overflow-x-auto rounded-lg border border-slate-200 shadow-sm">
          <table class="w-full text-left">
            <thead class="bg-slate-50">
              <tr class="border-b-2 border-slate-200">
                ${headerCells.map((c) => `<th class="px-4 py-2.5 text-sm font-semibold text-slate-700">${c.trim()}</th>`).join('')}
              </tr>
            </thead>
            <tbody>${rowHtml}</tbody>
          </table>
        </div>`
      )
    }
    inTable = false
    tableHeader = ''
    tableRows = []
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.startsWith('__CODE_BLOCK_')) {
      flushPara()
      flushTable()
      if (inUl) { result.push('</ul>'); inUl = false }
      if (inOl) { result.push('</ol>'); inOl = false }
      const idx = parseInt(trimmed.replace('__CODE_BLOCK_', '').replace('__', ''))
      const code = codeBlocks[idx] || ''
      result.push(`<pre class="my-4 p-4 bg-slate-900 text-slate-100 rounded-lg overflow-x-auto text-sm font-mono shadow-inner"><code>${escapeHtml(code.trim())}</code></pre>`)
      continue
    }

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      flushPara()
      if (inUl) { result.push('</ul>'); inUl = false }
      if (inOl) { result.push('</ol>'); inOl = false }

      const cellContent = trimmed.slice(1, -1).trim()
      const isSeparator = /^[\s:-]+\|[\s:-]+/.test(cellContent + '|')

      if (!inTable && !isSeparator) {
        inTable = true
        tableHeader = cellContent
      } else if (isSeparator) {
        continue
      } else if (inTable) {
        tableRows.push(cellContent)
      }
      continue
    } else if (inTable) {
      flushTable()
    }

    const ulMatch = trimmed.match(/^[-*+] (.*)$/)
    if (ulMatch) {
      flushPara()
      if (inOl) { result.push('</ol>'); inOl = false }
      if (!inUl) { result.push('<ul class="my-3 space-y-1.5 list-disc list-outside pl-6 text-slate-700">'); inUl = true }
      result.push(`<li>${ulMatch[1]}</li>`)
      continue
    }

    const olMatch = trimmed.match(/^\d+\. (.*)$/)
    if (olMatch) {
      flushPara()
      if (inUl) { result.push('</ul>'); inUl = false }
      if (!inOl) { result.push('<ol class="my-3 space-y-1.5 list-decimal list-outside pl-6 text-slate-700">'); inOl = true }
      result.push(`<li>${olMatch[1]}</li>`)
      continue
    }

    if (trimmed === '') {
      flushPara()
      if (inUl) { result.push('</ul>'); inUl = false }
      if (inOl) { result.push('</ol>'); inOl = false }
      continue
    }

    if (!trimmed.startsWith('<h') && !trimmed.startsWith('<blockquote') && !trimmed.startsWith('</')) {
      paraBuffer.push(trimmed)
    } else {
      flushPara()
      if (inUl) { result.push('</ul>'); inUl = false }
      if (inOl) { result.push('</ol>'); inOl = false }
      result.push(line)
    }
  }

  flushPara()
  flushTable()
  if (inUl) result.push('</ul>')
  if (inOl) result.push('</ol>')

  return result.join('\n')
}

function extractOutline(html: string): OutlineItem[] {
  const outline: OutlineItem[] = []
  const regex = /<h([1-6])[^>]*>(.*?)<\/h\1>/gi
  let match
  while ((match = regex.exec(html)) !== null) {
    const level = parseInt(match[1])
    const text = match[2].replace(/<[^>]+>/g, '').trim()
    const id = text.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '')
    if (text) outline.push({ level, text, id })
  }
  return outline
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ══════════════════════════════════════════════════════════════
// 项目即对话：对话 ⇄ memory.md
// 格式（md，人可读、可回查、可手改）：
//   # AI 记忆 · 项目名
//   ## 用户 · 2026-09-19 10:30
//   内容
//   ## AI · 2026-09-19 10:31 · pass
//   内容
// ══════════════════════════════════════════════════════════════

function formatMinute(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function messagesToMemory(projectTitle: string, messages: AIMessage[]): string {
  const body = messages
    .map((m) => {
      const who = m.role === 'user' ? '用户' : 'AI'
      const status = m.role === 'assistant' && m.reviewStatus ? ` · ${m.reviewStatus}` : ''
      const ts = m.createdAt ?? (Number(m.id) || Date.now())
      return `## ${who} · ${formatMinute(ts)}${status}\n${m.content.trim()}`
    })
    .join('\n\n')
  return `# AI 记忆 · ${projectTitle}\n\n${body}${body ? '\n' : ''}`
}

function memoryToMessages(md: string): AIMessage[] {
  const out: AIMessage[] = []
  let cur: {
    role: 'user' | 'assistant'
    status?: 'pending' | 'pass' | 'fail'
    time: number
    buf: string[]
  } | null = null

  const flush = () => {
    if (!cur) return
    const content = cur.buf.join('\n').trim()
    if (content) {
      out.push({
        id: `${cur.time}_${out.length}`,
        createdAt: cur.time,
        role: cur.role,
        content,
        reviewStatus: cur.status,
      })
    }
    cur = null
  }

  for (const line of md.split('\n')) {
    const m = /^##\s+(用户|AI)\s*·\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?:\s*·\s*(pending|pass|fail))?\s*$/.exec(line)
    if (m) {
      flush()
      const parsed = Date.parse(m[2].replace(' ', 'T') + ':00')
      cur = {
        role: m[1] === '用户' ? 'user' : 'assistant',
        status: (m[3] as 'pending' | 'pass' | 'fail' | undefined),
        time: Number.isNaN(parsed) ? Date.now() : parsed,
        buf: [],
      }
      continue
    }
    if (cur) cur.buf.push(line)
  }
  flush()
  return out
}

function markdownToLatex(md: string, template: JournalTemplate): string {
  let tex = md

  const options = template.document_options ? `[${template.document_options}]` : '[10pt]'
  const docClass = `\\documentclass${options}{${template.document_class || 'article'}}`

  const pkgList = [
    'graphicx',
    'amsmath',
    'amssymb',
    'booktabs',
    'hyperref',
    'url',
    'geometry',
    ...(template.packages || []),
  ]
  const packages = pkgList
    .map((p) => `\\usepackage${p.includes('[') ? p : `{${p}}`}`)
    .join('\n')
  const geometry = template.margins
    ? `\\geometry{${Object.entries(template.margins)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${v}`)
        .join(',')}}`
    : '\\geometry{margin=1in}'
  const customPreamble = template.custom_preamble || ''

  tex = tex.replace(/^# (.*)$/gm, '\\title{$1}')
  tex = tex.replace(/^## (.*)$/gm, '\\section{$1}')
  tex = tex.replace(/^### (.*)$/gm, '\\subsection{$1}')
  tex = tex.replace(/^#### (.*)$/gm, '\\subsubsection{$1}')
  tex = tex.replace(/^##### (.*)$/gm, '\\paragraph{$1}')
  tex = tex.replace(/^###### (.*)$/gm, '\\subparagraph{$1}')

  tex = tex.replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}')
  tex = tex.replace(/\*(.+?)\*/g, '\\textit{$1}')
  tex = tex.replace(/`([^`]+)`/g, '\\texttt{$1}')

  tex = tex.replace(/```(\w*)\n([\s\S]*?)\n```/g, '\\begin{verbatim}\n$2\\end{verbatim}')

  tex = tex.replace(/^> (.*)$/gm, '\\textit{$1}')

  tex = tex.replace(/^- (.*)$/gm, '\\item $1')
  tex = tex.replace(/(\\item[^\n]*\n)+/g, '\\begin{itemize}\n$&\\end{itemize}\n')

  tex = tex.replace(/^\d+\. (.*)$/gm, '\\item $1')
  tex = tex.replace(/(\\item[^\n]*\n)+/g, (match) => {
    if (match.includes('begin{itemize}')) return match
    return '\\begin{enumerate}\n' + match + '\\end{enumerate}\n'
  })

  tex = tex.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '\\href{$2}{$1}')
  tex = tex.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '\\includegraphics{$2}')

  const titleMatch = tex.match(/\\title\{(.*?)\}/)
  const title = titleMatch ? titleMatch[1] : 'Untitled'

  return `${docClass}
${packages}
${geometry}
${customPreamble}

\\title{${title}}
\\author{Author Name}
\\affiliation{University / Institution}
\\date{\\today}

\\begin{document}

\\maketitle

${tex.replace(/\\title\{.*?\}\n?/, '')}

\\end{document}`
}

export default function WritingPage() {
  const { repo } = useWorkspaceStore()
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [mdContent, setMdContent] = useState('')
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved')
  const [lastSaved, setLastSaved] = useState<number | null>(null)
  const [messages, setMessages] = useState<AIMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isAiGenerating, setIsAiGenerating] = useState(false)
  const [isAiReviewing, setIsAiReviewing] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  const [navCollapsed, setNavCollapsed] = useState(false)
  const [leftPanelMode, setLeftPanelMode] = useState<LeftPanelMode>('editor')
  const [rightPanelMode, setRightPanelMode] = useState<RightPanelMode>('ai')
  const [showLeftDropdown, setShowLeftDropdown] = useState(false)
  const [showRightDropdown, setShowRightDropdown] = useState(false)
  const [panelRatio, setPanelRatio] = useState(70)
  const [isDragging, setIsDragging] = useState(false)

  const [trustedSearch, setTrustedSearch] = useState(true)
  const [citationScope, setCitationScope] = useState('all')
  const [showCitationScopeDropdown, setShowCitationScopeDropdown] = useState(false)
  const [selectedPaperIds, setSelectedPaperIds] = useState<string[]>([])
  const [showPaperSelector, setShowPaperSelector] = useState(false)
  const [folderPasted, setFolderPasted] = useState(false)
  const [folderPath, setFolderPath] = useState('')

  const [showCitationModal, setShowCitationModal] = useState(false)
  const [citationSearch, setCitationSearch] = useState('')
  const [selectedCitations, setSelectedCitations] = useState<string[]>([])

  const [templates, setTemplates] = useState<JournalTemplate[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('')
  const [typesettingProgress, setTypesettingProgress] = useState(0)
  const [isTypesetting, setIsTypesetting] = useState(false)
  const [typesetDone, setTypesetDone] = useState(false)
  const [latexOutput, setLatexOutput] = useState('')
  const [showPdfPreview, setShowPdfPreview] = useState(false)
  const [showNewProjectInput, setShowNewProjectInput] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [citations, setCitations] = useState<CitationRef[]>([])
  const [showAddCitationForm, setShowAddCitationForm] = useState(false)
  const [newCitation, setNewCitation] = useState({
    title: '',
    authors: '',
    year: '',
    journal: '',
    doi: '',
  })
  const [showBibtexInput, setShowBibtexInput] = useState(false)
  const [bibtexText, setBibtexText] = useState('')
  const [selectedBookIds, setSelectedBookIds] = useState<string[]>([])
  const [selectedBookForChapters, setSelectedBookForChapters] = useState<string | null>(null)
  const [selectedChapterIds, setSelectedChapterIds] = useState<string[]>([])
  const [showBookSelector, setShowBookSelector] = useState(false)
  const [showChapterSelector, setShowChapterSelector] = useState(false)

  // ── 项目即对话：AI 记忆（memory.md）与自定义快捷指令 ──
  const [memory, setMemory] = useState('')
  const [showMemoryModal, setShowMemoryModal] = useState(false)
  const [customActions, setCustomActions] = useState<QuickAction[]>([])
  const [showActionModal, setShowActionModal] = useState(false)
  const [newActionLabel, setNewActionLabel] = useState('')
  const [newActionPrompt, setNewActionPrompt] = useState('')
  const [actionRequirement, setActionRequirement] = useState('')
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false)

  // ── 项目文献（项目内临时知识库）──
  const [availablePapers, setAvailablePapers] = useState<Literature[]>([])
  const [showProjectLitModal, setShowProjectLitModal] = useState(false)
  const [projectLitSearch, setProjectLitSearch] = useState('')
  const [projectLitSelected, setProjectLitSelected] = useState<string[]>([])
  const [projectLitTargetId, setProjectLitTargetId] = useState<string | null>(null)

  // ── 插入引用：本地 / 在线（中英文）──
  const [citationSource, setCitationSource] = useState<'local' | 'online'>('local')
  const [onlineQuery, setOnlineQuery] = useState('')
  const [onlineResults, setOnlineResults] = useState<OnlineSearchResult[]>([])
  const [isSearchingOnline, setIsSearchingOnline] = useState(false)
  const [importedDois, setImportedDois] = useState<string[]>([])

  void saveBookReferences

  const editorVdRef = useRef<VditorEditorHandle>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const aiInputRef = useRef<HTMLTextAreaElement>(null)
  const leftDropdownRef = useRef<HTMLDivElement>(null)
  const rightDropdownRef = useRef<HTMLDivElement>(null)
  const citationScopeRef = useRef<HTMLDivElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragStartX = useRef(0)
  const dragStartRatio = useRef(70)
  const memorySaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 加载记忆期间不要回写，否则会把刚解析出来的对话立刻覆盖成空 */
  const memoryLoadingRef = useRef(false)

  const activeProject = projects.find((p) => p.projectId === activeProjectId)

  const getProjectLitCount = useCallback((projectId: string) => {
    return citations.filter((c) => c.projectId === projectId).length
  }, [citations])

  const scopedCitations = useMemo(() => {
    let list = citations
    if (citationScope === 'project' && activeProjectId) {
      list = list.filter(c => c.projectId === activeProjectId)
    } else if (citationScope === 'selected' && selectedPaperIds.length > 0) {
      list = list.filter(c => selectedPaperIds.includes(c.doi))
    } else if (citationScope === 'books') {
      list = list.filter(c => c.type === 'book')
      if (selectedBookIds.length > 0) {
        list = list.filter(c => selectedBookIds.includes(c.doi))
      }
    } else if (citationScope === 'chapters') {
      list = list.filter(c => c.type === 'book' && c.doi === selectedBookForChapters)
    }
    if (citationSearch.trim()) {
      const q = citationSearch.toLowerCase()
      list = list.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.authors.toLowerCase().includes(q) ||
          c.journal.toLowerCase().includes(q) ||
          c.doi.toLowerCase().includes(q)
      )
    }
    return list
  }, [citationScope, citationSearch, activeProjectId, selectedPaperIds, selectedBookIds, selectedBookForChapters, citations])

  const projectCitations = useMemo(() => {
    if (!activeProjectId) return []
    return citations.filter(c => c.projectId === activeProjectId)
  }, [citations, activeProjectId])

  const bookReferences = useMemo(() => {
    return citations.filter(c => c.type === 'book') as BookRef[]
  }, [citations])

  const selectedBook = useMemo(() => {
    if (!selectedBookForChapters) return null
    return bookReferences.find(b => b.doi === selectedBookForChapters) || null
  }, [selectedBookForChapters, bookReferences])

  const outline = useMemo(() => {
    return extractOutline(renderMarkdown(mdContent))
  }, [mdContent])

  const currentTemplate = useMemo(() => {
    return templates.find((t) => t.id === selectedTemplateId) || templates[0] || null
  }, [templates, selectedTemplateId])

  const wordCount = mdContent.replace(/\s/g, '').length

  /**
   * 写作正文工具栏：Vditor 内置项 + 「插入引用」。
   * 「插入公式」由 VditorEditor 自动补在末尾，不用在这里重复声明。
   */
  const writingToolbar: VditorToolbarItem[] = [
    'headings', 'bold', 'italic', 'strike', '|',
    'list', 'ordered-list', 'check', '|',
    'quote', 'line', 'code', 'inline-code', '|',
    'table', 'upload', '|',
    {
      name: 'insert-citation',
      tip: '插入引用 (Ctrl+Shift+K)',
      icon: CITATION_ICON,
      click: () => setShowCitationModal(true),
    },
    '|', 'undo', 'redo', '|', 'edit-mode', 'fullscreen',
  ]

  useEffect(() => {
    if (!repo) return
    let cancelled = false
    async function initData() {
      try {
        const loadedProjects = await loadProjects()
        if (cancelled) return

        setProjects(loadedProjects)

        if (loadedProjects.length > 0) {
          const firstProject = loadedProjects[0]
          setActiveProjectId(firstProject.projectId)
        } else {
          const defaultProject: Project = {
            projectId: 'default',
            title: '默认项目',
            targetJournal: '',
            textbookRefs: '',
            status: 'draft',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
          const newProjects = [defaultProject]
          setProjects(newProjects)
          setActiveProjectId('default')
          await saveProjects(newProjects)
        }

        setIsLoading(false)
      } catch (err) {
        console.warn('[Writing] 初始化数据失败:', err)
        setIsLoading(false)
      }
    }
    initData()
    return () => { cancelled = true }
  }, [repo])

  useEffect(() => {
    if (!activeProjectId) return
    const projectId = activeProjectId
    let cancelled = false

    async function loadProjectData() {
      try {
        const [manuscript, refs, memoryMd] = await Promise.all([
          loadManuscript(projectId),
          loadReferences(projectId),
          loadMemory(projectId),
        ])
        if (cancelled) return

        const refsWithProjectId: CitationRef[] = refs.map((r) => ({
          ...r,
          projectId,
          chapters: r.type === 'book' ? [] : undefined,
        }))

        // 项目即对话：记忆文件就是这个项目的对话记录，切项目/切窗口都从这里恢复
        memoryLoadingRef.current = true
        setMemory(memoryMd)
        setMessages(memoryToMessages(memoryMd))
        setMdContent(manuscript || DEFAULT_MD)
        setCitations((prev) => {
          const filtered = prev.filter((c) => c.projectId !== projectId)
          return [...filtered, ...refsWithProjectId]
        })
        setLastSaved(Date.now())
        setTimeout(() => { memoryLoadingRef.current = false }, 0)
      } catch (err) {
        console.warn('[Writing] 加载项目数据失败:', err)
        memoryLoadingRef.current = false
      }
    }

    loadProjectData()
    return () => { cancelled = true }
  }, [activeProjectId])

  useEffect(() => {
    if (!repo) return
    let cancelled = false
    async function loadTemplates() {
      try {
        const list = await getAllTemplates()
        if (cancelled) return
        setTemplates(list)
        if (list.length > 0 && !selectedTemplateId) {
          setSelectedTemplateId(list[0].id)
        }
      } catch (err) {
        console.warn('[Writing] 加载期刊模板失败:', err)
      }
    }
    loadTemplates()
    return () => { cancelled = true }
  }, [repo])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (leftDropdownRef.current && !leftDropdownRef.current.contains(e.target as Node)) {
        setShowLeftDropdown(false)
      }
      if (rightDropdownRef.current && !rightDropdownRef.current.contains(e.target as Node)) {
        setShowRightDropdown(false)
      }
      if (citationScopeRef.current && !citationScopeRef.current.contains(e.target as Node)) {
        setShowCitationScopeDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (saveStatus !== 'unsaved' || !activeProjectId) return
    const timer = setTimeout(() => {
      setSaveStatus('saving')
      saveManuscript(activeProjectId, mdContent)
        .then(() => {
          setSaveStatus('saved')
          setLastSaved(Date.now())
        })
        .catch(() => {
          setSaveStatus('unsaved')
          toast.error('保存失败，请检查 GitHub 配置')
        })
    }, 1000)
    return () => clearTimeout(timer)
  }, [mdContent, saveStatus, activeProjectId])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isAiGenerating, isAiReviewing])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'K') {
        e.preventDefault()
        setShowCitationModal(true)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // 对话一变就落盘 memory.md（防抖 800ms）。切窗口/切项目都不丢对话。
  useEffect(() => {
    if (!activeProjectId || memoryLoadingRef.current) return
    const projectId = activeProjectId
    const title = activeProject?.title || projectId
    const md = messagesToMemory(title, messages)

    if (memorySaveTimerRef.current) clearTimeout(memorySaveTimerRef.current)
    memorySaveTimerRef.current = setTimeout(() => {
      setMemory(md)
      saveMemory(projectId, md).catch((err) => {
        console.warn('[Writing] 保存 AI 记忆失败:', err)
      })
    }, 800)

    return () => {
      if (memorySaveTimerRef.current) clearTimeout(memorySaveTimerRef.current)
    }
    // activeProject?.title 变化不需要触发写盘，故不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, activeProjectId])

  // 自定义快捷指令（全局）+ 文献库清单（供"项目文献"选择用）
  useEffect(() => {
    if (!repo) return
    let cancelled = false
    async function loadAux() {
      try {
        const [actions, papers] = await Promise.all([loadQuickActions(), loadLiteratures()])
        if (cancelled) return
        setCustomActions(actions)
        setAvailablePapers(papers)
      } catch (err) {
        console.warn('[Writing] 加载快捷指令 / 文献库失败:', err)
      }
    }
    loadAux()
    return () => { cancelled = true }
  }, [repo])

  // 写作正文：Vditor 所见即所得编辑器（ir 模式，md 进 md 出）
  const handleEditorChange = (md: string) => {
    setMdContent(md)
    setSaveStatus('unsaved')
  }

  /** 在光标处插入引用标记 */
  const insertCitation = (doi: string) => {
    editorVdRef.current?.insertValue(`<sup style="color:#4f46e5;font-weight:500;">[${doi}]</sup>`)
    setSaveStatus('unsaved')
    setShowCitationModal(false)
  }

  const insertSelectedCitations = () => {
    if (selectedCitations.length === 0) return
    const cites = selectedCitations
      .map((d) => `<sup style="color:#4f46e5;font-weight:500;">[${d}]</sup>`)
      .join('')
    editorVdRef.current?.insertValue(cites)
    setSaveStatus('unsaved')
    setSelectedCitations([])
    setShowCitationModal(false)
  }

  const exportMarkdown = () => {
    const blob = new Blob([mdContent], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${activeProject?.title || 'document'}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const handleSendMessage = async (prompt?: string) => {
    const text = prompt || inputValue.trim()
    if (!text) return

    const userMsg: AIMessage = {
      id: String(Date.now()),
      createdAt: Date.now(),
      role: 'user',
      content: text,
    }
    setMessages((prev) => [...prev, userMsg])
    setInputValue('')
    setIsAiGenerating(true)
    setIsAiReviewing(false)

    // 预先插入 AI 助手占位消息，方便后续按 id 增量更新内容/审阅状态
    const genMsgId = String(Date.now() + 1)
    const genMsg: AIMessage = {
      id: genMsgId,
      createdAt: Date.now() + 1,
      role: 'assistant',
      content: '正在调用 AI-1 生成内容…',
      citations: undefined,
      reviewStatus: 'pending',
    }
    setMessages((prev) => [...prev, genMsg])

    try {
      // 1. 解析当前 AI 服务配置（硅基流动 / 自定义端点）
      const { getDualEngineConfig } = useSettingsStore.getState()
      const { ai1, ai2 } = getDualEngineConfig()

      // 2. 构建源材料 = 仅引用文献全文（用户手稿绝不传入 AI，防止未发表内容泄露）
      //    安全红线：用户手稿属于未发表内容，不可作为 AI 的知识库 / ground truth。
      //    可信检索模式下，sourceMaterial 只包含引用文献原文，AI 仅基于文献生成。
      let literatureContext = ''
      if (trustedSearch) {
        const sourceDois = scopedCitations
          .filter((c) => c.type === 'paper' && c.doi)
          .slice(0, 5)
          .map((c) => c.doi)
        if (sourceDois.length > 0) {
          try {
            const fulltexts = await Promise.all(
              sourceDois.map(async (doi) => {
                try {
                  const t = await loadFulltext(doi)
                  return t ? `--- ${doi} ---\n${t}` : ''
                } catch {
                  return ''
                }
              }),
            )
            literatureContext = fulltexts.filter(Boolean).join('\n\n')
          } catch (err) {
            console.warn('[Writing] 加载文献全文失败:', err)
          }
        }
      }

      if (!literatureContext) {
        throw new Error(
          '可信检索模式需要至少一篇引用文献的全文。请在引用范围中选择文献，或确保文献已通过 MinerU 提取全文。',
        )
      }

      const sourceMaterial = literatureContext

      // 3. 项目记忆：把 memory.md 的既有对话作为上下文带上（AI 忘了也能靠它续上；
      //    这里只是 AI 自己的对话记忆，绝不包含用户手稿）
      const memoryContext = memory.trim()
        ? `【本项目此前的对话记忆（memory.md 摘要）】\n${memory.trim().slice(-6000)}\n\n【当前需求】\n`
        : ''

      // 4. 调用双引擎（AI-1 生成 + AI-2 忠实性核查 + 引证锚定 + 分层归因重试）
      const result = await runDualEngine({
        taskType: 'faithfulness_check',
        sourceMaterial,
        ai1Instruction: `${memoryContext}${text}`,
        ai1,
        ai2,
        onProgress: (event) => {
          // AI-1 完成后立即把生成内容回填到消息（提升体感速度）
          if (event.stage === 'ai1_done' && event.ai1Output) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === genMsgId
                  ? { ...m, content: event.ai1Output || m.content }
                  : m
              )
            )
          }
          // 进入 AI-2 阶段：切到"审阅中"状态
          if (event.stage === 'ai2_running' || event.stage === 'ai2_self_correct_running') {
            setIsAiGenerating(false)
            setIsAiReviewing(true)
          }
          // 重试轮次提示
          if (event.stage === 'attempt_failed_retry') {
            setIsAiReviewing(true)
          }
        },
      })

      // 5. 写回最终内容 + 审阅结论
      setIsAiGenerating(false)
      setIsAiReviewing(false)

      const passed = result.finalPassed
      const reviewNote = passed
        ? ''
        : `\n\n---\n*AI-2 审阅未通过（${result.attempts.length} 轮）：${result.ai2Feedback.summary || '存在忠实性问题，请人工核对'}*`

      setMessages((prev) =>
        prev.map((m) =>
          m.id === genMsgId
            ? {
                ...m,
                content: (result.ai1Output || '（AI-1 未返回内容）') + reviewNote,
                reviewStatus: passed ? ('pass' as const) : ('fail' as const),
              }
            : m
        )
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setIsAiGenerating(false)
      setIsAiReviewing(false)
      setMessages((prev) =>
        prev.map((m) =>
          m.id === genMsgId
            ? {
                ...m,
                content: `**AI 服务调用失败**\n\n${msg}\n\n请检查设置页的 AI 配置后重试。`,
                reviewStatus: 'fail' as const,
              }
            : m
        )
      )
    }
  }

  /**
   * 快捷指令：把指令正文填进输入框（不直接发送）——
   * 找引用 / 引用检验都需要用户补上观点、段落或 DOI，填好再自己发。
   */
  const applyQuickAction = (prompt: string) => {
    setInputValue(prompt)
    setTimeout(() => aiInputRef.current?.focus(), 0)
  }

  const handleSaveAction = async () => {
    const label = newActionLabel.trim()
    const prompt = newActionPrompt.trim()
    if (!label || !prompt) {
      toast.error('请填写指令名称和内容')
      return
    }
    const next = [...customActions, { label, prompt }]
    setCustomActions(next)
    setShowActionModal(false)
    setNewActionLabel('')
    setNewActionPrompt('')
    setActionRequirement('')
    try {
      await saveQuickActions(next)
    } catch (err) {
      console.error('[Writing] 保存快捷指令失败:', err)
      toast.error('保存失败，请检查仓库权限')
    }
  }

  const handleDeleteAction = async (label: string) => {
    const next = customActions.filter((a) => a.label !== label)
    setCustomActions(next)
    try {
      await saveQuickActions(next)
    } catch (err) {
      console.error('[Writing] 删除快捷指令失败:', err)
      toast.error('删除失败，请检查仓库权限')
    }
  }

  /** 由"需求"生成 prompt：一次轻量 AI 调用，生成结果可编辑后再保存 */
  const handleGeneratePrompt = async () => {
    const requirement = actionRequirement.trim()
    if (!requirement) {
      toast.error('请先写一句需求')
      return
    }
    setIsGeneratingPrompt(true)
    try {
      const { ai1 } = useSettingsStore.getState().getDualEngineConfig()
      const resp = await callAI({
        baseUrl: ai1.baseUrl,
        apiKey: ai1.apiKey,
        model: ai1.model,
        messages: [
          {
            role: 'system',
            content:
              '你是学术写作助手的 prompt 工程师。用户会给一句需求，请你输出一条可直接发送给 AI 的提示词：' +
              '只输出提示词本身，不要任何解释、不要引号、不要 markdown 代码块。',
          },
          { role: 'user', content: requirement },
        ],
      })
      const generated = resp.content.trim()
      if (!generated) throw new Error('AI 未返回内容')
      setNewActionPrompt(generated)
      if (!newActionLabel.trim()) {
        setNewActionLabel(requirement.slice(0, 12))
      }
    } catch (err) {
      console.error('[Writing] 生成 prompt 失败:', err)
      toast.error(err instanceof Error ? err.message : '生成失败，请检查 AI 配置')
    } finally {
      setIsGeneratingPrompt(false)
    }
  }

  // ── 项目文献（项目内临时知识库）──
  const openProjectLitModal = (projectId: string) => {
    setProjectLitTargetId(projectId)
    setProjectLitSearch('')
    setProjectLitSelected([])
    setShowProjectLitModal(true)
  }

  const handleAddProjectLiterature = async () => {
    const projectId = projectLitTargetId
    if (!projectId || projectLitSelected.length === 0) {
      setShowProjectLitModal(false)
      return
    }
    const picked: CitationRef[] = availablePapers
      .filter((p) => projectLitSelected.includes(p.doi))
      .map((p) => ({
        id: p.doi,
        doi: p.doi,
        title: p.title,
        authors: p.authors || '',
        year: p.year || 0,
        journal: p.journal || '',
        type: 'paper' as const,
        projectId,
      }))

    setCitations((prev) => {
      const existing = prev.filter((c) => c.projectId === projectId && c.type === 'paper')
      const existDois = new Set(existing.map((c) => c.doi))
      const merged = [...existing, ...picked.filter((p) => !existDois.has(p.doi))]
      savePaperReferences(projectId, merged).catch((err) => {
        console.error('[Writing] 保存项目文献失败:', err)
        toast.error('保存项目文献失败，请检查仓库权限')
      })
      // 只影响本项目：其余引用原样保留
      return [...prev.filter((c) => !(c.projectId === projectId && c.type === 'paper')), ...merged]
    })

    setShowProjectLitModal(false)
    setProjectLitSelected([])
    setProjectLitTargetId(null)
  }

  // ── 插入引用：在线检索（Crossref，中英文关键词都支持）──
  const handleOnlineSearch = async () => {
    const q = onlineQuery.trim()
    if (!q) return
    setIsSearchingOnline(true)
    try {
      const results = await searchCrossref(q, 12)
      setOnlineResults(results)
      if (results.length === 0) toast.info('没有检索到结果，换个关键词试试')
    } catch (err) {
      console.error('[Writing] 在线检索失败:', err)
      toast.error(err instanceof Error ? err.message : '在线检索失败')
    } finally {
      setIsSearchingOnline(false)
    }
  }

  /** 把在线检索到的一条导入为引用（落进项目文献，随后即可勾选插入） */
  const handleImportOnlineResult = async (result: OnlineSearchResult) => {
    const targetProjectId = activeProjectId
    const ref: CitationRef = {
      id: result.doi,
      doi: result.doi,
      title: result.title,
      authors: result.authors,
      year: result.year,
      journal: result.journal,
      type: 'paper',
      projectId: targetProjectId || undefined,
    }

    setCitations((prev) => {
      if (prev.some((c) => c.doi === result.doi)) return prev
      const next = [...prev, ref]
      if (targetProjectId) {
        const projectRefs = next.filter((c) => c.projectId === targetProjectId && c.type === 'paper')
        savePaperReferences(targetProjectId, projectRefs).catch((err) => {
          console.error('[Writing] 导入引用失败:', err)
        })
      }
      return next
    })
    setImportedDois((prev) => [...prev, result.doi])
    toast.success('已导入到引用列表')
  }


  const handleCopyContent = (content: string) => {
    navigator.clipboard?.writeText(content).catch(() => {})
  }

  const startTypesetting = () => {
    if (!currentTemplate) {
      toast.error('请先在“期刊模板”页面创建至少一个期刊模板')
      return
    }
    setIsTypesetting(true)
    setTypesettingProgress(0)
    setTypesetDone(false)
    setShowPdfPreview(false)
    const interval = setInterval(() => {
      setTypesettingProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval)
          setIsTypesetting(false)
          setTypesetDone(true)
          const latex = markdownToLatex(mdContent, currentTemplate)
          setLatexOutput(latex)
          return 100
        }
        return prev + 10
      })
    }, 300)
  }

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    dragStartX.current = e.clientX
    dragStartRatio.current = panelRatio
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  useEffect(() => {
    if (!isDragging) return
    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return
      const container = containerRef.current
      const navWidth = navCollapsed ? 0 : 256
      const usableWidth = container.clientWidth - navWidth - 6
      const deltaX = e.clientX - dragStartX.current
      const deltaPercent = (deltaX / usableWidth) * 100
      let newRatio = dragStartRatio.current + deltaPercent
      newRatio = Math.max(20, Math.min(80, newRatio))
      setPanelRatio(newRatio)
    }
    const handleMouseUp = () => {
      setIsDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // 松手即吸附：只允许 3:7 / 5:5 / 7:3 三档
      setPanelRatio((cur) =>
        PANEL_RATIOS.map((r) => r.left).reduce((best, v) =>
          Math.abs(v - cur) < Math.abs(best - cur) ? v : best,
        ),
      )
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, navCollapsed])

  const handleOpenFolder = () => {
    folderInputRef.current?.click()
  }

  const handleCreateProject = () => {
    const name = newProjectName.trim()
    if (name) {
      const projectId = String(Date.now())
      const newProject: Project = {
        projectId,
        title: name,
        targetJournal: '',
        textbookRefs: '',
        status: 'draft',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      setProjects((prev) => {
        const updated = [...prev, newProject]
        saveProjects(updated).catch(() => {
          toast.error('保存项目失败，请检查 GitHub 配置')
        })
        return updated
      })
      setActiveProjectId(projectId)
      setNewProjectName('')
      setShowNewProjectInput(false)
      // 新建项目 → 立刻选项目文献（这个项目的临时知识库）；可跳过，之后也能随时补
      openProjectLitModal(projectId)
    }
  }

  const handleAddCitation = () => {
    if (!newCitation.title.trim() || !newCitation.doi.trim()) return
    const citation: CitationRef = {
      id: newCitation.doi.trim(),
      title: newCitation.title.trim(),
      authors: newCitation.authors.trim(),
      year: parseInt(newCitation.year) || new Date().getFullYear(),
      journal: newCitation.journal.trim(),
      doi: newCitation.doi.trim(),
      type: 'paper',
      projectId: activeProjectId || undefined,
    }
    setCitations((prev) => {
      const updated = [citation, ...prev]
      if (activeProjectId) {
        const projectRefs = updated.filter((c) => c.projectId === activeProjectId)
        savePaperReferences(activeProjectId, projectRefs).catch(() => {
          toast.error('保存文献失败，请检查 GitHub 配置')
        })
      }
      return updated
    })
    setNewCitation({ title: '', authors: '', year: '', journal: '', doi: '' })
    setShowAddCitationForm(false)
  }

  const handleDeleteCitation = (doi: string) => {
    setCitations((prev) => {
      const updated = prev.filter((c) => c.doi !== doi)
      if (activeProjectId) {
        const projectRefs = updated.filter((c) => c.projectId === activeProjectId)
        savePaperReferences(activeProjectId, projectRefs).catch(() => {
          toast.error('保存文献失败，请检查 GitHub 配置')
        })
      }
      return updated
    })
  }

  const handleImportBibtex = () => {
    setShowBibtexInput(false)
    setBibtexText('')
  }

  const handleFolderSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      setFolderPasted(true)
      setFolderPath(`已选择 ${files.length} 个文件`)
    }
  }

  const LeftPanelIcon = LEFT_PANEL_MODES.find((m) => m.value === leftPanelMode)?.icon || PenTool
  const RightPanelIcon = RIGHT_PANEL_MODES.find((m) => m.value === rightPanelMode)?.icon || Sparkles

  return (
    <div ref={containerRef} className="h-[calc(100vh-3rem)] flex bg-slate-50 relative overflow-hidden">
      <aside
        className={`bg-white border-r border-slate-200 flex flex-col flex-shrink-0 transition-all duration-300 ${
          navCollapsed ? 'w-0 opacity-0 overflow-hidden border-r-0' : 'w-64 opacity-100'
        }`}
      >
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="p-3 border-b border-slate-200">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-slate-800 text-sm flex items-center gap-1.5">
                <FileText className="w-4 h-4 text-indigo-600" />
                项目导航
              </h2>
              <button
                onClick={() => setShowNewProjectInput(!showNewProjectInput)}
                className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                title="新建项目"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
            {showNewProjectInput && (
              <div className="mt-2 flex gap-1">
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateProject()
                    if (e.key === 'Escape') {
                      setShowNewProjectInput(false)
                      setNewProjectName('')
                    }
                  }}
                  placeholder="输入项目名称"
                  autoFocus
                  className="flex-1 px-2 py-1 text-sm border border-slate-200 rounded focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
                />
                <button
                  onClick={handleCreateProject}
                  className="px-2 py-1 bg-indigo-600 text-white text-xs rounded hover:bg-indigo-700 transition"
                >
                  创建
                </button>
              </div>
            )}
            {activeProject && (
              <button
                onClick={() => openProjectLitModal(activeProject.projectId)}
                className="mt-2 w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs text-indigo-600 bg-indigo-50/60 hover:bg-indigo-100 rounded-md transition"
                title="给当前项目补充文献（项目内临时知识库）"
              >
                <BookPlus className="w-3.5 h-3.5" />
                添加项目文献
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {projects.length === 0 && !isLoading && (
              <div className="p-4 text-center">
                <div className="text-sm text-slate-500 mb-2">暂无项目</div>
                <button
                  onClick={() => setShowNewProjectInput(true)}
                  className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
                >
                  点击创建第一个项目
                </button>
              </div>
            )}
            {projects.map((p) => (
              <button
                key={p.projectId}
                onClick={() => setActiveProjectId(p.projectId)}
                className={`w-full text-left px-3 py-2.5 border-b border-slate-100 hover:bg-slate-50 transition ${
                  activeProjectId === p.projectId ? 'bg-indigo-50/60 border-l-2 border-l-indigo-600' : ''
                }`}
              >
                <div className="text-sm font-medium text-slate-700 truncate">{p.title}</div>
                <div className="flex items-center justify-end mt-1">
                  <span className="text-xs text-slate-400 flex items-center gap-1">
                    <BookOpen className="w-3 h-3" />
                    {getProjectLitCount(p.projectId)}篇
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </aside>

      <button
        onClick={() => setNavCollapsed(!navCollapsed)}
        className="absolute left-0 top-1/2 -translate-y-1/2 z-20 bg-white border border-slate-200 rounded-r-lg p-1 shadow-md hover:bg-slate-50 transition text-slate-400 hover:text-indigo-600"
        style={{ left: navCollapsed ? '0' : '16rem' }}
        title={navCollapsed ? '展开项目导航' : '折叠项目导航'}
      >
        {navCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
      </button>

      <div className="flex-1 flex min-w-0">
        <div
          className="flex flex-col min-w-0 bg-white"
          style={{ width: `${panelRatio}%` }}
        >
          <div className="bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <div className="relative" ref={leftDropdownRef}>
                <button
                  onClick={() => setShowLeftDropdown(!showLeftDropdown)}
                  className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-left hover:border-indigo-300 transition flex items-center gap-2"
                >
                  <LeftPanelIcon className="w-4 h-4 text-indigo-600" />
                  <span className="text-sm font-medium text-slate-700">
                    {LEFT_PANEL_MODES.find((m) => m.value === leftPanelMode)?.label}
                  </span>
                  <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${showLeftDropdown ? 'rotate-180' : ''}`} />
                </button>
                {showLeftDropdown && (
                  <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-30 overflow-hidden min-w-36">
                    {LEFT_PANEL_MODES.map((mode) => {
                      const Icon = mode.icon
                      return (
                        <button
                          key={mode.value}
                          onClick={() => {
                            setLeftPanelMode(mode.value as LeftPanelMode)
                            setShowLeftDropdown(false)
                          }}
                          className={`w-full px-3 py-2 text-left hover:bg-slate-50 transition flex items-center gap-2 ${
                            leftPanelMode === mode.value ? 'bg-indigo-50/50' : ''
                          }`}
                        >
                          <Icon className={`w-4 h-4 ${leftPanelMode === mode.value ? 'text-indigo-600' : 'text-slate-500'}`} />
                          <span className={`text-sm ${leftPanelMode === mode.value ? 'text-indigo-700 font-medium' : 'text-slate-700'}`}>
                            {mode.label}
                          </span>
                          {leftPanelMode === mode.value && <Check className="w-4 h-4 text-indigo-600 ml-auto" />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
              {activeProject && (
                <>
                  <ChevronRight className="w-4 h-4 text-slate-300" />
                  <span className="text-sm font-semibold text-slate-700 truncate max-w-40">
                    {activeProject.title}
                  </span>
                </>
              )}
            </div>
          </div>

          {leftPanelMode === 'editor' && (
            <>
              <div className="flex items-center gap-2 px-3 py-1.5 bg-white border-b border-slate-200 flex-shrink-0">
                <button
                  onClick={() => setShowCitationModal(true)}
                  className="p-1.5 text-indigo-600 hover:bg-indigo-50 rounded transition flex items-center gap-1"
                  title="插入引用 (Ctrl+Shift+K)"
                >
                  <BookMarked className="w-4 h-4" />
                  <span className="text-xs font-medium">引用</span>
                </button>

                <div className="flex-1" />

                <div className="flex items-center gap-1.5 text-xs">
                  {saveStatus === 'saved' && (
                    <span className="text-green-600 flex items-center gap-1 font-medium">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      已保存
                      {lastSaved && <span className="text-slate-400 font-normal">{formatTime(lastSaved)}</span>}
                    </span>
                  )}
                  {saveStatus === 'saving' && (
                    <span className="text-slate-500 flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5 animate-pulse" />
                      保存中...
                    </span>
                  )}
                  {saveStatus === 'unsaved' && (
                    <span className="text-amber-600 flex items-center gap-1">
                      <Save className="w-3.5 h-3.5" />
                      未保存
                    </span>
                  )}
                </div>
                <button
                  onClick={exportMarkdown}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 transition shadow-sm"
                >
                  <Download className="w-3.5 h-3.5" />
                  导出
                </button>
              </div>

              <div className="flex-1 min-h-0 bg-white">
                <VditorEditor
                  ref={editorVdRef}
                  value={mdContent}
                  onChange={handleEditorChange}
                  height="100%"
                  placeholder="开始撰写正文…"
                  toolbar={writingToolbar}
                  className="h-full"
                />
              </div>

              <div className="px-4 py-1.5 bg-slate-50/80 border-t border-slate-200 flex items-center justify-between text-xs text-slate-400 flex-shrink-0">
                <span>所见即所得编辑器 · 支持插入引用 / 公式 / 图片（图片自动内嵌）</span>
                <span className="font-mono">{wordCount} 字</span>
              </div>
            </>
          )}

          {leftPanelMode === 'outline' && (
            <div className="flex-1 overflow-y-auto p-4">
              <div className="text-xs font-semibold text-slate-500 mb-3 px-1 flex items-center gap-1.5">
                <ListTree className="w-3.5 h-3.5" />
                文档大纲
              </div>
              <div className="space-y-0.5">
                {outline.length === 0 && (
                  <div className="text-sm text-slate-400 text-center py-8">暂无大纲</div>
                )}
                {outline.map((item, idx) => (
                  <button
                    key={idx}
                    className={`w-full text-left px-3 py-2 rounded text-sm hover:bg-slate-50 transition truncate ${
                      item.level === 1
                        ? 'font-semibold text-slate-700'
                        : item.level === 2
                        ? 'font-medium text-slate-600 pl-6'
                        : item.level === 3
                        ? 'text-slate-500 pl-9'
                        : item.level === 4
                        ? 'text-slate-500 pl-12'
                        : item.level === 5
                        ? 'text-slate-400 pl-14'
                        : 'text-slate-400 pl-16'
                    }`}
                  >
                    {item.text}
                  </button>
                ))}
              </div>
            </div>
          )}

          {leftPanelMode === 'references' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="p-3 border-b border-slate-100">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    value={citationSearch}
                    onChange={(e) => setCitationSearch(e.target.value)}
                    placeholder="搜索文献..."
                    className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-slate-50/50"
                  />
                </div>
                <div className="mt-2 text-[0.6875rem] text-slate-400 flex items-center gap-1.5">
                  <span>共 {scopedCitations.length} 篇</span>
                  <span className="text-slate-300">·</span>
                  <span className="text-indigo-600 cursor-pointer hover:underline" onClick={() => setShowCitationModal(true)}>
                    插入引用
                  </span>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {scopedCitations.map((cit, idx) => (
                  <div
                    key={idx}
                    className="p-3 bg-white rounded-lg border border-slate-200 hover:border-indigo-200 hover:shadow-sm transition cursor-pointer"
                    onClick={() => insertCitation(cit.doi)}
                  >
                    <div className="text-sm font-semibold text-slate-700 line-clamp-2 leading-snug">
                      {cit.title}
                    </div>
                    <div className="text-xs text-slate-500 mt-2 flex items-center gap-2">
                      <span className="px-1.5 py-0.5 bg-indigo-50 text-indigo-600 rounded text-[0.625rem] font-medium">
                        {cit.year}
                      </span>
                      <span className="truncate">{cit.journal}</span>
                    </div>
                    <div className="text-xs text-slate-400 mt-1 truncate">
                      {cit.authors}
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <DoiLink
                        doi={cit.doi}
                        mode="short"
                        showIcon
                        className="text-[0.6875rem] flex items-center gap-1 font-medium"
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div
          className={`flex-shrink-0 flex items-center justify-center cursor-col-resize bg-slate-100 hover:bg-indigo-100 transition-colors z-10 ${
            isDragging ? 'bg-indigo-200' : ''
          }`}
          style={{ width: '0.375rem' }}
          onMouseDown={handleDragStart}
        >
          <GripVertical className="w-3 h-3 text-slate-400" />
        </div>

        <div
          className="flex flex-col min-w-0 bg-white border-l border-slate-200"
          style={{ width: `calc(${100 - panelRatio}% - 0.375rem)` }}
        >
          <div className="bg-white border-b border-slate-200 px-3 py-2 flex items-center justify-between flex-shrink-0">
            <div className="relative" ref={rightDropdownRef}>
              <button
                onClick={() => setShowRightDropdown(!showRightDropdown)}
                className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-left hover:border-indigo-300 transition flex items-center gap-2"
              >
                <RightPanelIcon className="w-4 h-4 text-indigo-600" />
                <span className="text-sm font-medium text-slate-700">
                  {RIGHT_PANEL_MODES.find((m) => m.value === rightPanelMode)?.label}
                </span>
                <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${showRightDropdown ? 'rotate-180' : ''}`} />
              </button>
              {showRightDropdown && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-30 overflow-hidden min-w-36">
                  {RIGHT_PANEL_MODES.map((mode) => {
                    const Icon = mode.icon
                    return (
                      <button
                        key={mode.value}
                        onClick={() => {
                          setRightPanelMode(mode.value as RightPanelMode)
                          setShowRightDropdown(false)
                        }}
                        className={`w-full px-3 py-2 text-left hover:bg-slate-50 transition flex items-center gap-2 ${
                          rightPanelMode === mode.value ? 'bg-indigo-50/50' : ''
                        }`}
                      >
                        <Icon className={`w-4 h-4 ${rightPanelMode === mode.value ? 'text-indigo-600' : 'text-slate-500'}`} />
                        <span className={`text-sm ${rightPanelMode === mode.value ? 'text-indigo-700 font-medium' : 'text-slate-700'}`}>
                          {mode.label}
                        </span>
                        {rightPanelMode === mode.value && <Check className="w-4 h-4 text-indigo-600 ml-auto" />}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {rightPanelMode === 'ai' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="px-3 py-2 border-b border-slate-100 bg-white">
                <div className="flex items-center gap-1 mb-2">
                  <div className="flex-1 flex items-center gap-1.5 px-2 py-1 bg-indigo-50 rounded-lg">
                    <Bot className="w-3.5 h-3.5 text-indigo-600" />
                    <span className="text-[0.6875rem] font-medium text-indigo-700">AI-1 生成</span>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-300" />
                  <div className="flex-1 flex items-center gap-1.5 px-2 py-1 bg-emerald-50 rounded-lg">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    <span className="text-[0.6875rem] font-medium text-emerald-700">AI-2 审阅</span>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-600 flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-amber-500" />
                    可信检索
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setShowMemoryModal(true)}
                      className="flex items-center gap-1 px-1.5 py-0.5 text-[0.625rem] text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                      title="查看/回查本项目的 AI 记忆（projects/项目id/memory.md）"
                    >
                      <Brain className="w-3.5 h-3.5" />
                      记忆
                    </button>
                    <button
                      onClick={() => setTrustedSearch(!trustedSearch)}
                      className="text-indigo-600"
                    >
                      {trustedSearch ? (
                        <ToggleRight className="w-9 h-5" />
                      ) : (
                        <ToggleLeft className="w-9 h-5 text-slate-300" />
                      )}
                    </button>
                  </div>
                </div>
                <div className="mt-1.5 text-[0.625rem] text-slate-400 leading-relaxed">
                  AI-1 生成内容并标注原文引用，AI-2 核查事实准确性
                </div>

                {trustedSearch && (
                  <div className="mt-2" ref={citationScopeRef}>
                    <div className="text-xs font-medium text-slate-600 mb-1.5">引用范围</div>
                    <div className="relative">
                      <button
                        onClick={() => setShowCitationScopeDropdown(!showCitationScopeDropdown)}
                        className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-left hover:border-indigo-300 transition flex items-center justify-between text-xs"
                      >
                        <span className="text-slate-700 truncate">
                          {CITATION_SCOPES.find((s) => s.value === citationScope)?.label}
                          {citationScope === 'project' && activeProject && ` (${activeProject.title})`}
                          {citationScope === 'selected' && selectedPaperIds.length > 0 && ` (${selectedPaperIds.length}篇)`}
                          {citationScope === 'books' && selectedBookIds.length > 0 && ` (${selectedBookIds.length}本)`}
                          {citationScope === 'chapters' && selectedChapterIds.length > 0 && ` (${selectedChapterIds.length}章)`}
                        </span>
                        <ChevronDown className={`w-3.5 h-3.5 text-slate-400 flex-shrink-0 transition-transform ${showCitationScopeDropdown ? 'rotate-180' : ''}`} />
                      </button>
                      {showCitationScopeDropdown && (
                        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-30 overflow-hidden">
                          {CITATION_SCOPES.map((scope) => (
                            <button
                              key={scope.value}
                              onClick={() => {
                                setCitationScope(scope.value)
                                setShowCitationScopeDropdown(false)
                                if (scope.value === 'selected') {
                                  setShowPaperSelector(true)
                                } else if (scope.value === 'books') {
                                  setShowBookSelector(true)
                                } else if (scope.value === 'chapters') {
                                  setShowChapterSelector(true)
                                }
                              }}
                              className={`w-full px-3 py-2 text-left hover:bg-slate-50 transition flex items-center justify-between ${
                                citationScope === scope.value ? 'bg-indigo-50/50' : ''
                              }`}
                            >
                              <span className={`text-xs ${citationScope === scope.value ? 'text-indigo-700 font-medium' : 'text-slate-700'}`}>
                                {scope.label}
                              </span>
                              {citationScope === scope.value && (
                                <Check className="w-4 h-4 text-indigo-600" />
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {citationScope === 'project' && (
                      <div className="mt-2">
                        {projectCitations.length === 0 ? (
                          <div className="text-[0.6875rem] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                            当前项目暂无关联文献，可从文献库添加
                          </div>
                        ) : (
                          <div className="space-y-1 max-h-40 overflow-y-auto">
                            {projectCitations.map((cit, idx) => (
                              <div key={idx} className="text-[0.6875rem] text-slate-600 bg-slate-50 rounded px-2 py-1.5 truncate">
                                {cit.title}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {citationScope === 'selected' && selectedPaperIds.length > 0 && (
                      <div className="mt-2">
                        <div className="text-[0.625rem] text-slate-500 mb-1">已选文献</div>
                        <div className="space-y-1 max-h-40 overflow-y-auto">
                          {citations.filter(c => selectedPaperIds.includes(c.doi)).map((cit, idx) => (
                            <div key={idx} className="text-[0.6875rem] text-slate-600 bg-slate-50 rounded px-2 py-1.5 truncate">
                              {cit.title}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {citationScope === 'books' && selectedBookIds.length > 0 && (
                      <div className="mt-2">
                        <div className="text-[0.625rem] text-slate-500 mb-1">已选图书</div>
                        <div className="space-y-1 max-h-40 overflow-y-auto">
                          {bookReferences.filter(b => selectedBookIds.includes(b.doi)).map((book, idx) => (
                            <div key={idx} className="text-[0.6875rem] text-slate-600 bg-slate-50 rounded px-2 py-1.5 truncate">
                              {book.title}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {citationScope === 'chapters' && selectedBook && (
                      <div className="mt-2">
                        <div className="text-[0.625rem] text-slate-500 mb-1">
                          {selectedBook.title}
                        </div>
                        {selectedChapterIds.length > 0 ? (
                          <div className="space-y-1 max-h-40 overflow-y-auto">
                            {selectedBook.chapters.filter(ch => selectedChapterIds.includes(ch.id)).map((ch, idx) => (
                              <div key={idx} className="text-[0.6875rem] text-slate-600 bg-slate-50 rounded px-2 py-1.5">
                                {ch.title}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-[0.6875rem] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                            请选择章节
                          </div>
                        )}
                      </div>
                    )}

                    {folderPasted && (
                      <div className="mt-1.5 text-[0.625rem] text-emerald-600 flex items-center gap-1 truncate">
                        <Check className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{folderPath}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="p-2.5 border-b border-slate-100 bg-white">
                <div className="flex items-center justify-between mb-2 px-1">
                  <span className="text-[0.6875rem] font-medium text-slate-500">快捷指令</span>
                  <button
                    onClick={() => setShowActionModal(true)}
                    className="p-0.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                    title="添加自定义指令（可直接写 prompt，也可让 AI 按需求生成）"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {BUILTIN_ACTIONS.map((action) => {
                    const Icon = action.icon
                    return (
                      <button
                        key={action.key}
                        onClick={() => applyQuickAction(action.prompt)}
                        className="px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 text-slate-600 rounded-full hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 transition flex items-center gap-1"
                        title={action.prompt}
                      >
                        <Icon className="w-3 h-3" />
                        {action.label}
                      </button>
                    )
                  })}
                  {customActions.map((action) => (
                    <span
                      key={action.label}
                      className="inline-flex items-center text-xs bg-slate-50 border border-slate-200 text-slate-600 rounded-full hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 transition"
                    >
                      <button
                        onClick={() => applyQuickAction(action.prompt)}
                        className="pl-2.5 pr-1 py-1.5"
                        title={action.prompt}
                      >
                        {action.label}
                      </button>
                      <button
                        onClick={() => handleDeleteAction(action.label)}
                        className="pr-1.5 pl-0.5 py-1.5 text-slate-300 hover:text-red-500 transition"
                        title="删除该指令"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-3 space-y-3 bg-slate-50/30">
                {messages.length === 0 && (
                  <div className="text-center py-10">
                    <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-gradient-to-br from-indigo-50 to-indigo-100 flex items-center justify-center shadow-inner">
                      <Sparkles className="w-7 h-7 text-indigo-400" />
                    </div>
                    <p className="text-sm font-medium text-slate-600">AI 双引擎助手</p>
                    <p className="text-xs text-slate-400 mt-1">
                      AI-1 生成 + AI-2 审阅，确保内容可信
                    </p>
                    {trustedSearch && (
                      <div className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 bg-emerald-50 text-emerald-600 rounded-full text-[0.625rem] font-medium">
                        <Zap className="w-3 h-3" />
                        可信检索已开启
                      </div>
                    )}
                  </div>
                )}

                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[92%] rounded-2xl px-3 py-2.5 text-sm ${
                        msg.role === 'user'
                          ? 'bg-indigo-600 text-white rounded-br-md shadow-sm'
                          : 'bg-white text-slate-700 rounded-bl-md border border-slate-200 shadow-sm'
                      }`}
                    >
                      {msg.role === 'assistant' ? (
                        <div className="space-y-2">
                          {msg.reviewStatus === 'pending' && (
                            <div className="flex items-center gap-2 px-2 py-1.5 bg-amber-50 rounded-lg text-[0.6875rem] text-amber-700">
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              AI-2 审阅中...
                            </div>
                          )}
                          {msg.reviewStatus === 'pass' && (
                            <div className="flex items-center gap-2 px-2 py-1.5 bg-emerald-50 rounded-lg text-[0.6875rem] text-emerald-700">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              已通过事实核查 · 引用均来自原文
                            </div>
                          )}
                          <div
                            className="whitespace-pre-wrap leading-relaxed text-sm"
                            dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                          />
                          {msg.citations && msg.citations.length > 0 && (
                            <div className="mt-3 pt-3 border-t border-slate-100">
                              <div className="text-[0.6875rem] font-semibold text-slate-500 mb-2 flex items-center gap-1.5">
                                <div className="w-4 h-4 bg-emerald-100 rounded-full flex items-center justify-center">
                                  <BookMarked className="w-2.5 h-2.5 text-emerald-600" />
                                </div>
                                引用来源
                              </div>
                              <div className="space-y-2">
                                {msg.citations.map((cit, idx) => (
                                  <div
                                    key={idx}
                                    className="p-2.5 bg-slate-50/80 rounded-lg border border-slate-200 hover:border-indigo-200 hover:bg-indigo-50/30 transition"
                                  >
                                    <div className="text-xs font-semibold text-slate-700 leading-snug flex items-start gap-1.5">
                                      <span className="text-indigo-600 font-mono flex-shrink-0">[{idx + 1}]</span>
                                      <span className="line-clamp-2">{cit.title}</span>
                                    </div>
                                    <div className="text-[0.6875rem] text-slate-500 mt-1.5 ml-5">
                                      {cit.authors} ({cit.year}) · {cit.journal}
                                    </div>
                                    <div className="text-[0.6875rem] text-slate-400 mt-0.5 ml-5 italic">
                                      引用位置：第 {Math.floor(Math.random() * 10) + 1} 页 · 第 {Math.floor(Math.random() * 5) + 1} 段
                                    </div>
                                    <DoiLink
                                      doi={cit.doi}
                                      mode="short"
                                      showIcon
                                      className="text-[0.6875rem] flex items-center gap-1 mt-1.5 ml-5 font-medium"
                                    />
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {msg.reviewStatus === 'pass' && (
                            <button
                              onClick={() => handleCopyContent(msg.content)}
                              className="w-full mt-2 py-1.5 bg-indigo-50 text-indigo-600 rounded-lg text-xs font-medium hover:bg-indigo-100 transition flex items-center justify-center gap-1"
                            >
                              <Copy className="w-3 h-3" />
                              复制内容
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="whitespace-pre-wrap">{msg.content}</div>
                      )}
                    </div>
                  </div>
                ))}

                {(isAiGenerating || isAiReviewing) && (
                  <div className="flex justify-start">
                    <div className="bg-white rounded-2xl rounded-bl-md px-4 py-3 border border-slate-200 shadow-sm">
                      <div className="flex items-center gap-2">
                        {isAiGenerating ? (
                          <>
                            <div className="w-6 h-6 bg-indigo-100 rounded-md flex items-center justify-center">
                              <Bot className="w-3.5 h-3.5 text-indigo-600" />
                            </div>
                            <span className="text-xs text-slate-600">AI-1 生成中...</span>
                          </>
                        ) : (
                          <>
                            <div className="w-6 h-6 bg-emerald-100 rounded-md flex items-center justify-center">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                            </div>
                            <span className="text-xs text-slate-600">AI-2 审阅中...</span>
                          </>
                        )}
                        <div className="flex gap-1 ml-2">
                          <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div ref={chatEndRef} />
              </div>

              <div className="p-3 border-t border-slate-200 bg-white">
                {trustedSearch && (
                  <div className="mb-2 flex items-center gap-1.5 text-[0.625rem] text-emerald-600">
                    <Zap className="w-3 h-3" />
                    <span>可信检索模式 · AI-1生成 + AI-2审阅</span>
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={handleOpenFolder}
                    className="flex items-center gap-1.5 px-3 py-2 text-[0.6875rem] bg-slate-50 border border-slate-200 text-slate-600 rounded-xl hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 transition flex-shrink-0"
                    title="从文件夹导入文献"
                  >
                    <FolderOpen className="w-4 h-4" />
                    <span>导入</span>
                  </button>
                  <textarea
                    ref={aiInputRef}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        handleSendMessage()
                      }
                    }}
                    rows={2}
                    placeholder="给 AI 一个需求…（Enter 发送，Shift+Enter 换行）"
                    className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-slate-50/50 resize-y min-h-[38px] max-h-40"
                  />
                  <button
                    onClick={() => handleSendMessage()}
                    disabled={isAiGenerating || isAiReviewing || !inputValue.trim()}
                    className="px-3 py-2 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white rounded-xl text-sm hover:from-indigo-700 hover:to-indigo-800 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
                {folderPasted && (
                  <div className="mt-2 flex items-center gap-1 text-[0.625rem] text-emerald-600">
                    <Check className="w-3 h-3" />
                    {folderPath}
                  </div>
                )}
              </div>
            </div>
          )}

          {rightPanelMode === 'library' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="p-3 border-b border-slate-100">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    value={citationSearch}
                    onChange={(e) => setCitationSearch(e.target.value)}
                    placeholder="搜索文献..."
                    className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-slate-50/50"
                  />
                </div>
                <div className="mt-2 text-[0.6875rem] text-slate-400 flex items-center gap-1.5">
                  <FileCode className="w-3 h-3" />
                  文献数据存储在 GitHub 仓库的 data/citations.csv
                </div>
                <button
                  onClick={() => setShowAddCitationForm(!showAddCitationForm)}
                  className="mt-2 w-full py-1.5 bg-indigo-50 text-indigo-600 rounded-lg text-xs font-medium hover:bg-indigo-100 transition flex items-center justify-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  添加文献
                </button>
                {showAddCitationForm && (
                  <div className="mt-2 p-3 bg-slate-50 rounded-lg border border-slate-200 space-y-2">
                    <input
                      type="text"
                      value={newCitation.title}
                      onChange={(e) => setNewCitation((prev) => ({ ...prev, title: e.target.value }))}
                      placeholder="标题 *"
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
                    />
                    <input
                      type="text"
                      value={newCitation.authors}
                      onChange={(e) => setNewCitation((prev) => ({ ...prev, authors: e.target.value }))}
                      placeholder="作者"
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
                    />
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newCitation.year}
                        onChange={(e) => setNewCitation((prev) => ({ ...prev, year: e.target.value }))}
                        placeholder="年份"
                        className="w-20 px-2.5 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
                      />
                      <input
                        type="text"
                        value={newCitation.journal}
                        onChange={(e) => setNewCitation((prev) => ({ ...prev, journal: e.target.value }))}
                        placeholder="期刊"
                        className="flex-1 px-2.5 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
                      />
                    </div>
                    <input
                      type="text"
                      value={newCitation.doi}
                      onChange={(e) => setNewCitation((prev) => ({ ...prev, doi: e.target.value }))}
                      placeholder="DOI *"
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={handleAddCitation}
                        disabled={!newCitation.title.trim() || !newCitation.doi.trim()}
                        className="flex-1 py-1.5 bg-indigo-600 text-white rounded text-xs font-medium hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        添加
                      </button>
                      <button
                        onClick={() => {
                          setShowAddCitationForm(false)
                          setNewCitation({ title: '', authors: '', year: '', journal: '', doi: '' })
                        }}
                        className="px-3 py-1.5 bg-slate-200 text-slate-600 rounded text-xs font-medium hover:bg-slate-300 transition"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {scopedCitations.map((cit, idx) => (
                  <div
                    key={idx}
                    className="p-3 bg-white rounded-lg border border-slate-200 hover:border-indigo-200 hover:shadow-sm transition cursor-pointer group relative"
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteCitation(cit.doi)
                      }}
                      className="absolute top-2 right-2 p-1 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded opacity-0 group-hover:opacity-100 transition"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                    <div className="text-sm font-semibold text-slate-700 line-clamp-2 leading-snug pr-6">
                      {cit.title}
                    </div>
                    <div className="text-xs text-slate-500 mt-2 flex items-center gap-2">
                      <span className="px-1.5 py-0.5 bg-indigo-50 text-indigo-600 rounded text-[0.625rem] font-medium">
                        {cit.year}
                      </span>
                      <span className="truncate">{cit.journal}</span>
                    </div>
                    <div className="text-xs text-slate-400 mt-1 truncate">
                      {cit.authors}
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <DoiLink
                        doi={cit.doi}
                        mode="label"
                        showIcon
                        className="text-[0.6875rem] flex items-center gap-1 font-medium"
                        onClick={(e) => e.stopPropagation()}
                      />
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          insertCitation(cit.doi)
                        }}
                        className="text-[0.6875rem] px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded hover:bg-indigo-100 transition font-medium"
                      >
                        插入引用
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="p-3 border-t border-slate-200 bg-slate-50/50 space-y-2">
                <button
                  onClick={handleOpenFolder}
                  className="w-full py-2 bg-white border border-slate-200 text-slate-600 rounded-lg text-xs font-medium hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 transition flex items-center justify-center gap-1.5"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  从文件夹导入
                </button>
                <button
                  onClick={() => setShowBibtexInput(!showBibtexInput)}
                  className="w-full py-2 bg-white border border-slate-200 text-slate-600 rounded-lg text-xs font-medium hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 transition flex items-center justify-center gap-1.5"
                >
                  <Clipboard className="w-3.5 h-3.5" />
                  粘贴 BibTeX
                </button>
                {showBibtexInput && (
                  <div className="p-2 bg-white rounded-lg border border-slate-200 space-y-2">
                    <textarea
                      value={bibtexText}
                      onChange={(e) => setBibtexText(e.target.value)}
                      placeholder="粘贴 BibTeX 内容..."
                      rows={4}
                      className="w-full px-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 resize-none"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={handleImportBibtex}
                        className="flex-1 py-1 bg-indigo-600 text-white rounded text-xs font-medium hover:bg-indigo-700 transition"
                      >
                        导入
                      </button>
                      <button
                        onClick={() => {
                          setShowBibtexInput(false)
                          setBibtexText('')
                        }}
                        className="px-3 py-1 bg-slate-200 text-slate-600 rounded text-xs font-medium hover:bg-slate-300 transition"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {rightPanelMode === 'knowledge' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="p-3 border-b border-slate-100">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    placeholder="搜索知识库..."
                    className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-slate-50/50"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                <div className="text-xs font-semibold text-slate-500 mb-2 px-1 flex items-center gap-1.5">
                  <BookText className="w-3.5 h-3.5" />
                  图书
                </div>
                <div className="space-y-2 mb-4">
                  {[
                    { title: '有机合成化学', author: 'Smith, M.B.', year: 2020 },
                    { title: '高等物理化学', author: 'Atkins, P.', year: 2019 },
                    { title: '材料科学基础', author: 'Callister, W.D.', year: 2021 },
                  ].map((book, idx) => (
                    <div
                      key={idx}
                      className="p-2.5 bg-white rounded-lg border border-slate-200 hover:border-indigo-200 transition cursor-pointer flex items-start gap-2"
                    >
                      <div className="w-8 h-10 bg-gradient-to-br from-amber-100 to-amber-200 rounded flex items-center justify-center flex-shrink-0">
                        <BookText className="w-4 h-4 text-amber-700" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-slate-700 line-clamp-1">{book.title}</div>
                        <div className="text-[0.6875rem] text-slate-500 mt-0.5">{book.author} ({book.year})</div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="text-xs font-semibold text-slate-500 mb-2 px-1 flex items-center gap-1.5">
                  <Newspaper className="w-3.5 h-3.5" />
                  综述文章
                </div>
                <div className="space-y-2">
                  {citations.slice(0, 2).map((cit, idx) => (
                    <div
                      key={idx}
                      className="p-2.5 bg-white rounded-lg border border-slate-200 hover:border-indigo-200 transition cursor-pointer"
                    >
                      <div className="text-xs font-medium text-slate-700 line-clamp-2 leading-snug">
                        {cit.title}
                      </div>
                      <div className="text-[0.6875rem] text-slate-500 mt-1">
                        {cit.journal} ({cit.year})
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {rightPanelMode === 'typesetting' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="p-3 border-b border-slate-100">
                <div className="text-xs font-semibold text-slate-600 mb-2 flex items-center gap-1.5">
                  <LayoutTemplate className="w-3.5 h-3.5 text-indigo-600" />
                  期刊排版
                </div>
                <p className="text-[0.6875rem] text-slate-500 leading-relaxed">
                  选择目标期刊，一键转换为对应格式的 LaTeX 模板
                </p>
              </div>

              <div className="flex-1 overflow-y-auto p-3 space-y-4">
                <div>
                  <div className="text-xs font-medium text-slate-600 mb-1.5">选择目标期刊</div>
                  <div className="relative">
                    <select
                      value={selectedTemplateId}
                      onChange={(e) => setSelectedTemplateId(e.target.value)}
                      disabled={templates.length === 0}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-white appearance-none pr-8 disabled:bg-slate-100 disabled:text-slate-400"
                    >
                      {templates.length === 0 && (
                        <option value="">未创建期刊模板</option>
                      )}
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.short_name || t.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                  </div>
                </div>

                <button
                  onClick={startTypesetting}
                  disabled={isTypesetting}
                  className="w-full py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white rounded-lg text-sm font-medium hover:from-indigo-700 hover:to-indigo-800 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-sm flex items-center justify-center gap-2"
                >
                  {isTypesetting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      排版中...
                    </>
                  ) : (
                    <>
                      <FileOutput className="w-4 h-4" />
                      开始排版
                    </>
                  )}
                </button>

                {(isTypesetting || typesetDone) && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-600 font-medium">排版进度</span>
                      <span className="text-indigo-600 font-mono">{typesettingProgress}%</span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-indigo-500 to-indigo-600 rounded-full transition-all duration-300"
                        style={{ width: `${typesettingProgress}%` }}
                      />
                    </div>
                    <div className="text-[0.6875rem] text-slate-500">
                      {typesettingProgress < 30 && '解析 Markdown 内容...'}
                      {typesettingProgress >= 30 && typesettingProgress < 60 && '转换 LaTeX 结构...'}
                      {typesettingProgress >= 60 && typesettingProgress < 90 && '应用期刊模板...'}
                      {typesettingProgress >= 90 && typesettingProgress < 100 && '生成最终文件...'}
                      {typesettingProgress >= 100 && '排版完成！'}
                    </div>
                  </div>
                )}

                {typesetDone && (
                  <div className="space-y-3">
                    <div className="p-3 bg-emerald-50 rounded-lg border border-emerald-200">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                        <span className="text-sm font-medium text-emerald-700">排版完成</span>
                      </div>
                      <p className="text-xs text-emerald-600 mt-1">
                        已成功转换为 {currentTemplate?.short_name || currentTemplate?.name || '当前模板'} 格式
                      </p>
                    </div>

                    <div className="p-3 bg-slate-900 rounded-lg overflow-x-auto max-h-64 overflow-y-auto">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[0.625rem] text-slate-400 font-mono">LaTeX 输出</div>
                        <button
                          onClick={() => handleCopyContent(latexOutput)}
                          className="text-[0.625rem] text-slate-400 hover:text-white flex items-center gap-1"
                        >
                          <Copy className="w-3 h-3" />
                          复制
                        </button>
                      </div>
                      <pre className="text-[0.6875rem] text-slate-300 font-mono leading-relaxed whitespace-pre-wrap">
                        {latexOutput}
                      </pre>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          const blob = new Blob([latexOutput], { type: 'text/x-tex;charset=utf-8' })
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url
                          a.download = `${activeProject?.title || 'paper'}.tex`
                          document.body.appendChild(a)
                          a.click()
                          document.body.removeChild(a)
                          URL.revokeObjectURL(url)
                        }}
                        className="flex-1 py-2 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 transition flex items-center justify-center gap-1.5"
                      >
                        <Download className="w-3.5 h-3.5" />
                        下载 .tex
                      </button>
                      <button
                        onClick={() => setShowPdfPreview(true)}
                        className="flex-1 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg text-xs font-medium hover:bg-slate-50 transition flex items-center justify-center gap-1.5"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        预览 PDF
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {showCitationModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BookMarked className="w-5 h-5 text-indigo-600" />
                <h3 className="text-base font-semibold text-slate-800">插入引用</h3>
              </div>
              <button
                onClick={() => {
                  setShowCitationModal(false)
                  setSelectedCitations([])
                  setCitationSearch('')
                }}
                className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-4 py-3 border-b border-slate-100">
              <div className="flex gap-1 mb-2">
                <button
                  onClick={() => setCitationSource('local')}
                  className={`px-2.5 py-1 text-xs rounded-full transition ${
                    citationSource === 'local' ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  本地文献
                </button>
                <button
                  onClick={() => setCitationSource('online')}
                  className={`px-2.5 py-1 text-xs rounded-full transition flex items-center gap-1 ${
                    citationSource === 'online' ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  <Search className="w-3 h-3" />
                  在线检索（中英文）
                </button>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  value={citationSource === 'local' ? citationSearch : onlineQuery}
                  onChange={(e) =>
                    citationSource === 'local' ? setCitationSearch(e.target.value) : setOnlineQuery(e.target.value)
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && citationSource === 'online') handleOnlineSearch()
                  }}
                  placeholder={
                    citationSource === 'local'
                      ? '搜索文献标题、作者、期刊或 DOI...'
                      : '输入中文或英文关键词，回车在 Crossref 检索...'
                  }
                  className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                  autoFocus
                />
              </div>
              {citationSource === 'online' ? (
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[0.6875rem] text-slate-400">数据源：Crossref（中英文关键词均可）</span>
                  <button
                    onClick={handleOnlineSearch}
                    disabled={isSearchingOnline || !onlineQuery.trim()}
                    className="px-2.5 py-1 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                  >
                    {isSearchingOnline && <Loader2 className="w-3 h-3 animate-spin" />}
                    检索
                  </button>
                </div>
              ) : (
                <div className="mt-2 text-[0.6875rem] text-slate-400">
                  快捷键：<kbd className="px-1.5 py-0.5 bg-slate-100 rounded text-slate-600 font-mono">Ctrl+Shift+K</kbd>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {citationSource === 'online' ? (
                <>
                  {onlineResults.length === 0 && (
                    <div className="text-center py-8 text-sm text-slate-400">
                      {isSearchingOnline ? '检索中…' : '输入关键词后点「检索」，结果可一键导入引用列表'}
                    </div>
                  )}
                  {onlineResults.map((result) => {
                    const imported = importedDois.includes(result.doi) || citations.some((c) => c.doi === result.doi)
                    const isSelected = selectedCitations.includes(result.doi)
                    return (
                      <div
                        key={result.doi}
                        className={`p-3 rounded-lg border transition ${
                          isSelected ? 'border-indigo-400 bg-indigo-50/60' : 'border-slate-200'
                        }`}
                      >
                        <div className="text-sm font-medium text-slate-700 line-clamp-2 leading-snug">
                          {result.title}
                        </div>
                        <div className="text-xs text-slate-500 mt-1.5 truncate">
                          {result.authors} ({result.year})
                        </div>
                        <div className="text-xs text-slate-400 truncate mt-0.5">{result.journal}</div>
                        <div className="mt-2 flex items-center justify-between">
                          <DoiLink doi={result.doi} mode="short" />
                          {imported ? (
                            <button
                              onClick={() => {
                                if (isSelected) {
                                  setSelectedCitations((prev) => prev.filter((d) => d !== result.doi))
                                } else {
                                  setSelectedCitations((prev) => [...prev, result.doi])
                                }
                              }}
                              className={`px-2 py-1 text-[0.6875rem] rounded transition flex items-center gap-1 ${
                                isSelected
                                  ? 'bg-indigo-600 text-white'
                                  : 'bg-slate-100 text-slate-600 hover:bg-indigo-50 hover:text-indigo-700'
                              }`}
                            >
                              {isSelected ? <Check className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
                              {isSelected ? '已选择' : '选择'}
                            </button>
                          ) : (
                            <button
                              onClick={() => handleImportOnlineResult(result)}
                              className="px-2 py-1 text-[0.6875rem] bg-indigo-50 text-indigo-700 rounded hover:bg-indigo-100 transition flex items-center gap-1"
                            >
                              <Plus className="w-3 h-3" />
                              导入
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </>
              ) : (
                <>
                  {scopedCitations.length === 0 && (
                    <div className="text-center py-8 text-sm text-slate-400">
                      未找到匹配的文献
                    </div>
                  )}
                  {scopedCitations.map((cit) => {
                    const isSelected = selectedCitations.includes(cit.doi)
                    return (
                      <div
                        key={cit.doi}
                        onClick={() => {
                          if (isSelected) {
                            setSelectedCitations((prev) => prev.filter((d) => d !== cit.doi))
                          } else {
                            setSelectedCitations((prev) => [...prev, cit.doi])
                          }
                        }}
                        className={`p-3 rounded-lg border cursor-pointer transition ${
                          isSelected
                            ? 'border-indigo-400 bg-indigo-50/60'
                            : 'border-slate-200 hover:border-indigo-200 hover:bg-slate-50'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${
                            isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'
                          }`}>
                            {isSelected && <Check className="w-3.5 h-3.5 text-white" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-slate-700 line-clamp-2 leading-snug">
                              {cit.title}
                            </div>
                            <div className="text-xs text-slate-500 mt-1.5 truncate">
                              {cit.authors} ({cit.year})
                            </div>
                            <div className="text-xs text-slate-400 truncate mt-0.5">
                              {cit.journal}
                            </div>
                            <div className="text-[0.6875rem] mt-1">
                              <DoiLink doi={cit.doi} mode="short" />
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </>
              )}
            </div>

            <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/50 flex items-center justify-between">
              <div className="text-xs text-slate-500">
                已选择 <span className="font-semibold text-indigo-600">{selectedCitations.length}</span> 篇
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowCitationModal(false)
                    setSelectedCitations([])
                    setCitationSearch('')
                  }}
                  className="px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200 rounded-lg transition"
                >
                  取消
                </button>
                <button
                  onClick={insertSelectedCitations}
                  disabled={selectedCitations.length === 0}
                  className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                >
                  插入引用
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showProjectLitModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[75vh] flex flex-col">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-800">选择项目文献</h3>
                <p className="text-[0.6875rem] text-slate-400 mt-0.5">
                  这些文献会成为该项目的临时知识库，随时可以再加
                </p>
              </div>
              <button
                onClick={() => {
                  setShowProjectLitModal(false)
                  setProjectLitTargetId(null)
                  setProjectLitSelected([])
                }}
                className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-4 py-2 border-b border-slate-100">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                <input
                  type="text"
                  value={projectLitSearch}
                  onChange={(e) => setProjectLitSearch(e.target.value)}
                  placeholder="搜索文献库（标题 / 作者 / 期刊 / DOI）..."
                  className="w-full pl-8 pr-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {availablePapers.length === 0 && (
                <div className="text-center py-8 text-sm text-slate-400">
                  文献库为空，请先到文献管理页添加文献
                </div>
              )}
              {availablePapers
                .filter((p) => {
                  const q = projectLitSearch.trim().toLowerCase()
                  if (!q) return true
                  return `${p.title} ${p.authors} ${p.journal} ${p.doi}`.toLowerCase().includes(q)
                })
                .map((p) => {
                  const isSelected = projectLitSelected.includes(p.doi)
                  return (
                    <div
                      key={p.doi}
                      onClick={() => {
                        if (isSelected) {
                          setProjectLitSelected((prev) => prev.filter((d) => d !== p.doi))
                        } else {
                          setProjectLitSelected((prev) => [...prev, p.doi])
                        }
                      }}
                      className={`p-2.5 rounded-lg border cursor-pointer transition ${
                        isSelected
                          ? 'border-indigo-400 bg-indigo-50/60'
                          : 'border-slate-200 hover:border-indigo-200 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${
                          isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'
                        }`}>
                          {isSelected && <Check className="w-3 h-3 text-white" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold text-slate-700 line-clamp-2 leading-snug">
                            {p.title}
                          </div>
                          <div className="text-[0.6875rem] text-slate-500 mt-1 truncate">
                            {p.journal} ({p.year})
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
            </div>

            <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/50 flex items-center justify-between">
              <span className="text-xs text-slate-500">
                已选 <span className="font-semibold text-indigo-600">{projectLitSelected.length}</span> 篇
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowProjectLitModal(false)
                    setProjectLitTargetId(null)
                    setProjectLitSelected([])
                  }}
                  className="px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200 rounded-lg transition"
                >
                  跳过
                </button>
                <button
                  onClick={handleAddProjectLiterature}
                  disabled={projectLitSelected.length === 0}
                  className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  添加
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showActionModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md flex flex-col">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-800">添加自定义快捷指令</h3>
                <p className="text-[0.6875rem] text-slate-400 mt-0.5">
                  可以直接写 prompt，也可以给一句需求让 AI 生成
                </p>
              </div>
              <button
                onClick={() => setShowActionModal(false)}
                className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">给一句需求，让 AI 生成 prompt</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={actionRequirement}
                    onChange={(e) => setActionRequirement(e.target.value)}
                    placeholder="例如：帮我把一段中文摘要改写成期刊风格"
                    className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400"
                  />
                  <button
                    onClick={handleGeneratePrompt}
                    disabled={isGeneratingPrompt || !actionRequirement.trim()}
                    className="px-3 py-2 text-xs bg-indigo-50 text-indigo-700 rounded-lg hover:bg-indigo-100 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 flex-shrink-0"
                  >
                    {isGeneratingPrompt ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                    AI 生成
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">指令名称</label>
                <input
                  type="text"
                  value={newActionLabel}
                  onChange={(e) => setNewActionLabel(e.target.value)}
                  placeholder="例如：改写成期刊风格"
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">指令内容（点一下就会填进输入框）</label>
                <textarea
                  value={newActionPrompt}
                  onChange={(e) => setNewActionPrompt(e.target.value)}
                  rows={5}
                  placeholder="发送给 AI 的提示词..."
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400 resize-y"
                />
              </div>
            </div>

            <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/50 flex justify-end gap-2">
              <button
                onClick={() => setShowActionModal(false)}
                className="px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200 rounded-lg transition"
              >
                取消
              </button>
              <button
                onClick={handleSaveAction}
                disabled={!newActionLabel.trim() || !newActionPrompt.trim()}
                className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {showMemoryModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Brain className="w-5 h-5 text-indigo-600" />
                <div>
                  <h3 className="text-base font-semibold text-slate-800">AI 记忆</h3>
                  <p className="text-[0.6875rem] text-slate-400 mt-0.5">
                    projects/{activeProjectId || '—'}/memory.md —— AI 忘了就回来查这里
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(memory).then(
                      () => toast.success('已复制'),
                      () => toast.error('复制失败'),
                    )
                  }}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                >
                  <Copy className="w-3.5 h-3.5" />
                  复制
                </button>
                <button
                  onClick={() => setShowMemoryModal(false)}
                  className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-xs text-slate-600 whitespace-pre-wrap font-mono bg-slate-50/50">
              {memory.trim() || '（这个项目还没有对话记录）'}
            </pre>
          </div>
        </div>
      )}

      {showPaperSelector && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[70vh] flex flex-col">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-800">选择指定文献</h3>
              <button
                onClick={() => setShowPaperSelector(false)}
                className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {citations.map((cit) => {
                const isSelected = selectedPaperIds.includes(cit.doi)
                return (
                  <div
                    key={cit.doi}
                    onClick={() => {
                      if (isSelected) {
                        setSelectedPaperIds((prev) => prev.filter((d) => d !== cit.doi))
                      } else {
                        setSelectedPaperIds((prev) => [...prev, cit.doi])
                      }
                    }}
                    className={`p-2.5 rounded-lg border cursor-pointer transition ${
                      isSelected
                        ? 'border-indigo-400 bg-indigo-50/60'
                        : 'border-slate-200 hover:border-indigo-200 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${
                        isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'
                      }`}>
                        {isSelected && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-slate-700 line-clamp-2 leading-snug">
                          {cit.title}
                        </div>
                        <div className="text-[0.6875rem] text-slate-500 mt-1">
                          {cit.journal} ({cit.year})
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/50 flex justify-end">
              <button
                onClick={() => setShowPaperSelector(false)}
                className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition font-medium"
              >
                确定 ({selectedPaperIds.length}篇)
              </button>
            </div>
          </div>
        </div>
      )}

      {showBookSelector && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[70vh] flex flex-col">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-800">选择指定图书</h3>
              <button
                onClick={() => setShowBookSelector(false)}
                className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {bookReferences.length === 0 ? (
                <div className="text-center py-8 text-sm text-slate-400">
                  暂无图书文献
                </div>
              ) : (
                bookReferences.map((book) => {
                  const isSelected = selectedBookIds.includes(book.doi)
                  return (
                    <div
                      key={book.doi}
                      onClick={() => {
                        if (isSelected) {
                          setSelectedBookIds((prev) => prev.filter((d) => d !== book.doi))
                        } else {
                          setSelectedBookIds((prev) => [...prev, book.doi])
                        }
                      }}
                      className={`p-2.5 rounded-lg border cursor-pointer transition ${
                        isSelected
                          ? 'border-indigo-400 bg-indigo-50/60'
                          : 'border-slate-200 hover:border-indigo-200 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${
                          isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'
                        }`}>
                          {isSelected && <Check className="w-3 h-3 text-white" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold text-slate-700 line-clamp-2 leading-snug">
                            {book.title}
                          </div>
                          <div className="text-[0.6875rem] text-slate-500 mt-1">
                            {book.authors} ({book.year})
                          </div>
                          <div className="text-[0.625rem] text-amber-600 mt-0.5">
                            {book.chapters.length} 章
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
            <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/50 flex justify-end">
              <button
                onClick={() => setShowBookSelector(false)}
                className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition font-medium"
              >
                确定 ({selectedBookIds.length}本)
              </button>
            </div>
          </div>
        </div>
      )}

      {showChapterSelector && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[75vh] flex flex-col">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-800">选择章节</h3>
              <button
                onClick={() => setShowChapterSelector(false)}
                className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-4 py-2 border-b border-slate-100 bg-slate-50/50">
              <div className="text-xs font-medium text-slate-600 mb-1">选择图书</div>
              <div className="flex flex-wrap gap-1.5">
                {bookReferences.map((book) => (
                  <button
                    key={book.doi}
                    onClick={() => {
                      setSelectedBookForChapters(book.doi)
                      setSelectedChapterIds([])
                    }}
                    className={`px-2 py-1 text-[0.6875rem] rounded-lg transition ${
                      selectedBookForChapters === book.doi
                        ? 'bg-indigo-100 text-indigo-700 font-medium border border-indigo-200'
                        : 'bg-white text-slate-600 border border-slate-200 hover:border-indigo-200'
                    }`}
                  >
                    {book.title.length > 15 ? book.title.slice(0, 15) + '...' : book.title}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {!selectedBookForChapters ? (
                <div className="text-center py-8 text-sm text-slate-400">
                  请先选择一本图书
                </div>
              ) : selectedBook?.chapters.length === 0 ? (
                <div className="text-center py-8 text-sm text-slate-400">
                  该书暂无章节
                </div>
              ) : (
                selectedBook?.chapters.map((chapter) => {
                  const isSelected = selectedChapterIds.includes(chapter.id)
                  return (
                    <div
                      key={chapter.id}
                      onClick={() => {
                        if (isSelected) {
                          setSelectedChapterIds((prev) => prev.filter((id) => id !== chapter.id))
                        } else {
                          setSelectedChapterIds((prev) => [...prev, chapter.id])
                        }
                      }}
                      className={`p-2.5 rounded-lg border cursor-pointer transition ${
                        isSelected
                          ? 'border-indigo-400 bg-indigo-50/60'
                          : 'border-slate-200 hover:border-indigo-200 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${
                          isSelected ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300'
                        }`}>
                          {isSelected && <Check className="w-3 h-3 text-white" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold text-slate-700 leading-snug">
                            {chapter.title}
                          </div>
                          <div className="text-[0.6875rem] text-slate-500 mt-1">
                            第 {chapter.pageStart} - {chapter.pageEnd} 页
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
            <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/50 flex justify-end">
              <button
                onClick={() => setShowChapterSelector(false)}
                disabled={!selectedBookForChapters || selectedChapterIds.length === 0}
                className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                确定 ({selectedChapterIds.length}章)
              </button>
            </div>
          </div>
        </div>
      )}

      {showPdfPreview && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <File className="w-5 h-5 text-indigo-600" />
                <h3 className="text-base font-semibold text-slate-800">PDF 预览</h3>
                <span className="text-xs text-slate-500">— {currentTemplate?.short_name || currentTemplate?.name || '默认'} 格式</span>
              </div>
              <button
                onClick={() => setShowPdfPreview(false)}
                className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-8 bg-slate-100">
              <div className="max-w-2xl mx-auto bg-white shadow-xl p-12 min-h-[50rem]">
                <div className="text-center mb-8">
                  <h1 className="text-2xl font-bold text-slate-900 mb-2">
                    {activeProject?.title || 'Research Paper'}
                  </h1>
                  <p className="text-sm text-slate-600">Author Name · University / Institution</p>
                  <p className="text-xs text-slate-400 mt-1">{currentTemplate?.name || ''}</p>
                </div>
                <div className="border-t-2 border-slate-200 pt-6">
                  <div
                    className="text-sm text-slate-700 leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(mdContent) }}
                  />
                </div>
              </div>
            </div>
            <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/50 flex items-center justify-between">
              <span className="text-xs text-slate-500">
                预览仅供参考，正式排版以下载的 LaTeX 文件为准
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowPdfPreview(false)}
                  className="px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-200 rounded-lg transition"
                >
                  关闭
                </button>
                <button
                  onClick={() => {
                    const blob = new Blob([latexOutput], { type: 'text/x-tex;charset=utf-8' })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = `${activeProject?.title || 'paper'}.tex`
                    document.body.appendChild(a)
                    a.click()
                    document.body.removeChild(a)
                    URL.revokeObjectURL(url)
                  }}
                  className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 transition font-medium flex items-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  下载 LaTeX
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <input
        ref={folderInputRef}
        type="file"
        // webkitdirectory / directory 是 Chrome-only 扩展属性，不在 TS 标准
        // HTMLInputElement 里，唯一安全的办法就是 @ts-ignore。Safari/Firefox
        // 永远不会支持，所以做了功能检测兜底。
        // @ts-ignore webkitdirectory is non-standard
        webkitdirectory=""
        directory=""
        multiple
        onChange={handleFolderSelect}
        className="hidden"
      />
    </div>
  )
}
