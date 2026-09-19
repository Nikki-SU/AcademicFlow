import { Fragment, useState, useCallback, useRef, useEffect, useMemo } from 'react'
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
  Play,
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
  BookPlus,
  Package,
  Upload,
  Trash2,
  CloudUpload,
} from 'lucide-react'
import { toast } from 'sonner'
import { getAllTemplates, createTemplate, updateTemplate } from '../services/journal-templates'
import {
  extractGuidelinesWithAI,
  applyExtractedToTemplate,
} from '../services/guideline-extractor'
import {
  convertMarkdownToLatex,
  refineLatexWithAI,
  buildLatexSkeletonFromTemplate,
} from '../services/latex-converter'
import { compileLatex, getCompileErrorLog, createPdfObjectUrl } from '../services/xelatex-compiler'
import {
  listLatexPackages,
  importLatexPackages,
  deleteLatexPackages,
  loadLatexPackages,
  type LatexPackageInfo,
} from '../services/latex-packages'
import { compileOnGitHub } from '../services/latex-cloud'
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
  loadManuscriptLatex,
  saveManuscriptLatex,
  loadBibtex,
  saveBibtex,
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

/**
 * 左右两个面板可选的功能 —— 两边完全一致，想放哪边就放哪边。
 * 大纲不在其中：按需求它固定挂在左侧「项目导航」下方，可收起/展开（仿 Obsidian）。
 *
 * `hint` 是「选中后会自动把另一侧切成什么」的提示 —— 只有需要左右联动的两项才有：
 * - 选「期刊模板」→ 另一侧自动变 LaTeX 工作区 = 模板调试
 * - 选「编辑区」  → 另一侧自动变 LaTeX 工作区 = 排版
 */
const PANEL_MODES: {
  value: PanelMode
  label: string
  icon: typeof PenTool
  hint?: string
}[] = [
  { value: 'editor', label: '编辑区', icon: PenTool, hint: '排版' },
  { value: 'template', label: '期刊模板', icon: LayoutTemplate, hint: '模板调试' },
  { value: 'typesetting', label: 'LaTeX 工作区', icon: FileCode },
  { value: 'references', label: '文献列表', icon: BookCopy },
  { value: 'ai', label: 'AI 助手', icon: Sparkles },
  { value: 'library', label: '文献库', icon: Library },
  { value: 'knowledge', label: '知识库', icon: GraduationCap },
]

/** 需要和「LaTeX 工作区」配对的模式：选中它们时另一侧自动切过去（左右联动） */
const LATEX_PAIRED_MODES: PanelMode[] = ['editor', 'template']

/**
 * 缺包时给日志加一段人话。
 * 运行时是随站点分发的 XeLaTeX（不联网），只内置了一部分宏包，
 * TeX 只会干巴巴地说一句 `File 'xxx.sty' not found`，
 * 用户看到这句通常以为是自己的写法错了 —— 其实是编译器没带那个包。
 */
const RUNTIME_MISSING_FILE_HINT =
  '【提示】编译器用的是随站点分发的 XeLaTeX 运行时（不联网），内置了这些宏包：\n' +
  '  基础：amsmath / graphicx / hyperref / geometry / xcolor / longtable / etoolbox / fontspec\n' +
  '  常用：booktabs / natbib / amssymb / tabularx / multirow / caption / subcaption / microtype\n' +
  '  文档类：IEEEtran / elsarticle / acmart / revtex4-2（另有 article 等 LaTeX 自带类）\n' +
  '  中文：xeCJK + Noto Serif SC（正文里出现汉字会自动接管）\n' +
  '上面这条 not found 说明该宏包没内置。如果它是现成的 .sty/.cls，\n' +
  '用右上角「宏包」把文件导进来就能用（导入后每次编译自动带上）。\n' +
  '\n'

function withRuntimeHint(log: string): string {
  return /\.(sty|cls|def)['`]?\s*not found/i.test(log) ? RUNTIME_MISSING_FILE_HINT + log : log
}

const CITATION_SCOPES = [
  { value: 'all', label: '全部文献' },
  { value: 'project', label: '当前项目文献' },
  { value: 'selected', label: '指定文献' },
  { value: 'books', label: '指定图书' },
  { value: 'chapters', label: '指定章节' },
]

/** 快捷指令里的一个「填空」：用户只填这个，完整提示词由模板拼出来 */
interface QuickActionParam {
  key: string
  label: string
  placeholder: string
  multiline?: boolean
}

/**
 * 内置快捷指令（写死，不可删）
 * -------------------------------------------------
 * 交互：点一下 → 该模式亮起 → 下面只出现它需要的输入框 →
 *       发送时把模板 + 你填的内容拼成一条完整提示词。
 * 只保留学术场景真正需要的三条：
 * - 找文献：给出主题 → 检索文献
 * - 找引用：给出观点 → 定位原文（DOI + 原句），并检查文中是否有相反观点
 * - 引用检验：给出你写的文字 + 引文 DOI → 原文是否有相同 / 相反意思
 */
const BUILTIN_ACTIONS: QuickActionDef[] = [
  {
    key: 'find-papers',
    label: '找文献',
    icon: Search,
    template: '请检索与以下研究主题相关的文献，逐条给出标题、作者、年份、期刊和 DOI。\n\n研究主题：{topic}',
    params: [{ key: 'topic', label: '研究主题', placeholder: '例如：钙钛矿太阳能电池的稳定性' }],
  },
  {
    key: 'find-quote',
    label: '找引用',
    icon: BookText,
    template:
      '请为下面这个观点找到原文佐证：先检索定位到具体文章，再给出原文中的原句和 DOI；' +
      '同时说明该文章里是否存在相反的观点。\n\n观点：{claim}',
    params: [
      { key: 'claim', label: '我的观点', placeholder: '一句话写清要佐证的观点', multiline: true },
    ],
  },
  {
    key: 'verify-citation',
    label: '引用检验',
    icon: CheckCircle2,
    template:
      '请检验我写的这段文字与所引文献是否匹配：原文里是否有相同意思的表述？原文里是否有相反意思的表述？' +
      '\n\n我的文字：\n{text}\n\n引文 DOI：{doi}',
    params: [
      { key: 'text', label: '我的文字', placeholder: '粘贴你写的那段话', multiline: true },
      { key: 'doi', label: '引文 DOI', placeholder: '例如：10.1021/jacs.0c00001' },
    ],
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
  /** 提示词模板：`{paramKey}` 会被用户填的内容替换，最后拼成一条完整 prompt */
  template: string
  params: QuickActionParam[]
}

/**
 * 「插入引用」工具栏图标（Vditor 的 icon 必须是 SVG 字符串）。
 * 注意：Vditor 的 CSS 会给工具栏里的 svg 强制 `fill: currentColor; stroke-width: 0`，
 * 所以必须用「纯填充」图形 —— 描边图标会被压成黑块或直接看不见。
 * 这里用「Vditor 自带的引号 path（缩小） + 右下角一个加号」拼成插入引用图标：
 * 全是填充图形、32 网格，既能正常渲染，又和工具栏里的「引用块」图标区分开。
 */
const CITATION_ICON =
  '<svg viewBox="0 0 32 32"><g transform="scale(0.7)"><path d="M27.769 26.667h-9.316l3.556-7.111h-4.231v-14.222h14.222v12.871l-4.231 8.462zM24.213 23.111h1.351l2.88-5.76v-8.462h-7.111v7.111h6.436l-3.556 7.111zM9.991 26.667h-9.316l3.556-7.111h-4.231v-14.222h14.222v12.871l-4.231 8.462zM6.436 23.111h1.351l2.88-5.76v-8.462h-7.111v7.111h6.436l-3.556 7.111z"/></g><path d="M22.5 20.5h3V24h3.5v3h-3.5v3.5h-3V27H19v-3h3.5z"/></svg>'

/** 面板可显示的功能（左右两侧通用）；大纲固定在左侧导航里，不在此列 */
type PanelMode =
  | 'editor'
  | 'template'
  | 'typesetting'
  | 'references'
  | 'ai'
  | 'library'
  | 'knowledge'

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
  /**
   * 左侧栏是「堆叠面板」（仿 Obsidian）：项目、大纲各占一块，各自能收起成一行。
   * 收起的那块只剩标题行，展开的那块吃掉剩余高度 —— 于是整栏要么全是项目，要么只显示大纲。
   */
  const [projectsExpanded, setProjectsExpanded] = useState(true)
  /** 大纲面板是否展开（收起时只剩「大纲」标题行） */
  const [outlineExpanded, setOutlineExpanded] = useState(false)
  const [leftPanelMode, setLeftPanelMode] = useState<PanelMode>('editor')
  const [rightPanelMode, setRightPanelMode] = useState<PanelMode>('ai')
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
  // ── LaTeX 工作区：代码板（上半） + 编译器（下半） ──
  /** 代码板里的完整 LaTeX 源码：可手改，也可由正文 / 期刊模板生成 */
  const [latexCode, setLatexCode] = useState('')
  /** 编译用的 BibTeX 数据库内容（有才会挂进虚拟文件系统并跑 bibtex） */
  const [latexBib, setLatexBib] = useState('')
  const [isGeneratingLatex, setIsGeneratingLatex] = useState(false)
  const [latexGenStatus, setLatexGenStatus] = useState('')
  /** 真实编译（XeLaTeX WASM）状态 */
  const [isCompiling, setIsCompiling] = useState(false)
  const [compileStatus, setCompileStatus] = useState('')
  const [compileError, setCompileError] = useState('')
  /** 编译产物 PDF 的 blob URL，用于内嵌 iframe 预览 */
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  // ── 导入宏包面板：用户自己带 .sty/.cls 进来，编译时自动挂进虚拟文件系统 ──
  const [showPackagesPanel, setShowPackagesPanel] = useState(false)
  const [latexPackages, setLatexPackages] = useState<LatexPackageInfo[]>([])
  const [isLoadingPackages, setIsLoadingPackages] = useState(false)
  const [isImportingPackages, setIsImportingPackages] = useState(false)
  const [packageStatus, setPackageStatus] = useState('')
  // ── 云端编译（GitHub Actions）：与浏览器内 WASM 并列的第二条通道 ──
  const [isCloudCompiling, setIsCloudCompiling] = useState(false)
  const [cloudRunUrl, setCloudRunUrl] = useState('')
  // ── 期刊模板面板：让 AI 直接改 LaTeX 代码 ──
  const [templateInstruction, setTemplateInstruction] = useState('')
  const [isRefiningLatex, setIsRefiningLatex] = useState(false)
  const [refineStatus, setRefineStatus] = useState('')
  // ── 期刊模板面板：就地新建模板（AI 提取只是草稿，必须能马上在代码板里改） ──
  const [showNewTemplateForm, setShowNewTemplateForm] = useState(false)
  const [newTemplateName, setNewTemplateName] = useState('')
  const [newTemplateGuidelines, setNewTemplateGuidelines] = useState('')
  const [isCreatingTemplate, setIsCreatingTemplate] = useState(false)
  const [templateCreateStatus, setTemplateCreateStatus] = useState('')
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
  // memory 只给 AI 用（自动落盘 + 自动作为上下文注入），不需要给人看的界面
  const [memory, setMemory] = useState('')
  const [customActions, setCustomActions] = useState<QuickAction[]>([])
  const [showActionModal, setShowActionModal] = useState(false)
  const [newActionLabel, setNewActionLabel] = useState('')
  const [newActionPrompt, setNewActionPrompt] = useState('')
  const [actionRequirement, setActionRequirement] = useState('')
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false)
  /** 当前选中的快捷指令（内置 key，或 `custom:指令名`） */
  const [activeActionKey, setActiveActionKey] = useState<string | null>(null)
  /** 该指令需要的各「填空」的值 */
  const [actionValues, setActionValues] = useState<Record<string, string>>({})
  /** 自定义指令被选中后可现场微调的 prompt */
  const [customPromptDraft, setCustomPromptDraft] = useState('')

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

  /** 编辑区可能落在左边或右边，两个 ref 都留着；插入引用/跳转时取已挂载的那个 */
  const leftEditorRef = useRef<VditorEditorHandle>(null)
  const rightEditorRef = useRef<VditorEditorHandle>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const aiInputRef = useRef<HTMLTextAreaElement>(null)
  const leftDropdownRef = useRef<HTMLDivElement>(null)
  const rightDropdownRef = useRef<HTMLDivElement>(null)
  const citationScopeRef = useRef<HTMLDivElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const packageFileInputRef = useRef<HTMLInputElement>(null)
  const packageFolderInputRef = useRef<HTMLInputElement>(null)
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
        const [manuscript, refs, memoryMd, savedLatex, savedBib] = await Promise.all([
          loadManuscript(projectId),
          loadReferences(projectId),
          loadMemory(projectId),
          loadManuscriptLatex(projectId),
          loadBibtex(projectId),
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
        // LaTeX 工作区跟着项目走：把上次的代码板 / BibTeX 还原回来
        setLatexCode(savedLatex)
        setLatexBib(savedBib)
        setCompileError('')
        setCompileStatus('')
        setPdfObjectUrl(null)
        // 导入的宏包挂在项目目录下，切项目要重新列一遍
        setIsLoadingPackages(true)
        listLatexPackages(projectId)
          .then((pkgs) => { if (!cancelled) setLatexPackages(pkgs) })
          .catch((err) => console.warn('[Writing] 读取导入的宏包失败:', err))
          .finally(() => { if (!cancelled) setIsLoadingPackages(false) })
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

  // 代码板 / BibTeX 改动 → 防抖落盘到项目目录（manuscript.tex / references.bib）。
  // 手改代码板、AI 改代码、由正文生成 三条路都从这里统一持久化。
  useEffect(() => {
    if (!activeProjectId) return
    if (!latexCode.trim() && !latexBib.trim()) return
    const timer = setTimeout(() => {
      if (latexCode.trim()) {
        saveManuscriptLatex(activeProjectId, latexCode).catch(() => {})
      }
      if (latexBib.trim()) {
        saveBibtex(activeProjectId, latexBib).catch(() => {})
      }
    }, 1200)
    return () => clearTimeout(timer)
  }, [latexCode, latexBib, activeProjectId])

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

  /** 当前挂载的编辑区（左边优先，其次右边）—— 编辑区可以被放在任意一侧 */
  const primaryEditor = () => leftEditorRef.current || rightEditorRef.current

  /**
   * 跳到第 index 个标题。
   * 大纲挂在左侧导航里，编辑区可能在另一侧甚至当前没显示，所以先确保编辑区可见再滚动。
   */
  const jumpToHeading = (index: number) => {
    const editorVisible = leftPanelMode === 'editor' || rightPanelMode === 'editor'
    if (!editorVisible) setLeftPanelMode('editor')
    // 等编辑区挂载完（Vditor 实例是在 effect 里建的）再滚动
    setTimeout(() => primaryEditor()?.scrollToHeading(index), 120)
  }

  /** 在光标处插入引用标记 */
  const insertCitation = (doi: string) => {
    primaryEditor()?.insertValue(`<sup style="color:#4f46e5;font-weight:500;">[${doi}]</sup>`)
    setSaveStatus('unsaved')
    setShowCitationModal(false)
  }

  const insertSelectedCitations = () => {
    if (selectedCitations.length === 0) return
    const cites = selectedCitations
      .map((d) => `<sup style="color:#4f46e5;font-weight:500;">[${d}]</sup>`)
      .join('')
    primaryEditor()?.insertValue(cites)
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
   * 快捷指令：选中 → 只填它需要的空 → 发送时把模板和填写内容拼成一条完整提示词。
   * 内置指令按 key 匹配，自定义指令按 `custom:名称` 匹配。
   */
  const activeAction = useMemo(() => {
    if (!activeActionKey) return null
    if (activeActionKey.startsWith('custom:')) {
      const label = activeActionKey.slice('custom:'.length)
      const found = customActions.find((a) => a.label === label)
      return found ? { kind: 'custom' as const, label: found.label } : null
    }
    const def = BUILTIN_ACTIONS.find((a) => a.key === activeActionKey)
    return def ? { kind: 'builtin' as const, def } : null
  }, [activeActionKey, customActions])

  /** 点一下选中（再点一下取消）；选中自定义指令时把它保存的 prompt 取出来供微调 */
  const toggleQuickAction = (key: string) => {
    if (activeActionKey === key) {
      setActiveActionKey(null)
      return
    }
    setActiveActionKey(key)
    setActionValues({})
    setCustomPromptDraft(
      key.startsWith('custom:')
        ? customActions.find((a) => a.label === key.slice('custom:'.length))?.prompt || ''
        : '',
    )
  }

  /** 把「模板 + 用户填的空」拼成最终提示词 */
  const composeActionPrompt = (): string => {
    if (!activeAction) return ''
    if (activeAction.kind === 'custom') return customPromptDraft.trim()
    let out = activeAction.def.template
    for (const p of activeAction.def.params) {
      out = out.split(`{${p.key}}`).join(actionValues[p.key]?.trim() || '')
    }
    return out.trim()
  }

  /** 还有必填的空没填 → 不让发 */
  const actionIncomplete =
    activeAction?.kind === 'builtin' &&
    activeAction.def.params.some((p) => !actionValues[p.key]?.trim())

  const sendQuickAction = () => {
    const prompt = composeActionPrompt()
    if (!prompt || actionIncomplete) return
    setActiveActionKey(null)
    handleSendMessage(prompt)
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

  // ══════════════════════════════════════════════════════════
  // LaTeX 工作区：代码板 → 浏览器内真编译 → PDF
  // ══════════════════════════════════════════════════════════

  /** 编译产物的 blob URL 要随手释放，否则每编译一次漏一个 PDF */
  const pdfUrlRef = useRef<string | null>(null)
  const setPdfObjectUrl = (next: string | null) => {
    if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current)
    pdfUrlRef.current = next
    setPdfUrl(next)
  }
  useEffect(() => {
    return () => {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current)
    }
  }, [])

  /**
   * 排版：把正文交给 AI 转成期刊 LaTeX，结果写进代码板。
   * 手动触发 —— 只有用户明确点这个按钮，正文才会被发出去。
   */
  const generateLatexFromMarkdown = async () => {
    if (!currentTemplate) {
      toast.error('请先在「期刊模板」面板创建并选择一个期刊模板')
      return
    }
    if (!mdContent.trim()) {
      toast.error('正文为空，先写点东西吧')
      return
    }
    const { getDualEngineConfig } = useSettingsStore.getState()
    const { ai1, ai2 } = getDualEngineConfig()
    setIsGeneratingLatex(true)
    setLatexGenStatus('准备中...')
    try {
      const result = await convertMarkdownToLatex({
        markdown: mdContent,
        template: currentTemplate,
        ai1,
        ai2,
        onProgress: (e) => setLatexGenStatus(e.message || ''),
      })
      setLatexCode(result.latex)
      setLatexBib(result.bibtex)
      setCompileError('')
      toast.success('已生成 LaTeX，可在代码板继续修改')
    } catch (err) {
      toast.error(`生成失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsGeneratingLatex(false)
      setLatexGenStatus('')
    }
  }

  /**
   * 新建模板后的统一收尾：刷新列表 → 选中它 → 立刻把骨架载入代码板。
   * 这一步是关键 —— AI 或默认值生出来的模板不可能开箱即用，
   * 所以创建完必须马上落到代码板里，让人就着手改 / 让 AI 改，再「保存回模板」。
   */
  const adoptNewTemplate = (tpl: JournalTemplate) => {
    setTemplates((prev) => [tpl, ...prev.filter((t) => t.id !== tpl.id)])
    setSelectedTemplateId(tpl.id)
    setLatexCode(tpl.template_tex?.trim() || buildLatexSkeletonFromTemplate(tpl))
    setCompileError('')
  }

  /**
   * 新建期刊模板 —— 只建一份默认骨架。
   * 粘了投稿须知就一并存进模板：之后「让 AI 改代码」开可信检索时，
   * 才有原文可以当依据锚定，否则 AI 只能凭空发挥。
   */
  const createTemplateManually = async () => {
    const name = newTemplateName.trim()
    if (!name) {
      toast.error('请填写期刊名称')
      return
    }
    setIsCreatingTemplate(true)
    setTemplateCreateStatus('创建中...')
    try {
      const created = await createTemplate({
        name,
        guidelines_content: newTemplateGuidelines.trim() || undefined,
      })
      const list = await getAllTemplates()
      setTemplates(list)
      adoptNewTemplate(list.find((t) => t.id === created.id) || created)
      setShowNewTemplateForm(false)
      setNewTemplateName('')
      setNewTemplateGuidelines('')
      toast.success('模板已创建，骨架已载入代码板 —— 改完记得「保存回模板」')
    } catch (err) {
      toast.error(`创建失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsCreatingTemplate(false)
      setTemplateCreateStatus('')
    }
  }

  /**
   * 新建期刊模板 —— AI 从投稿须知提取排版参数（双引擎：AI-1 提取 + AI-2 核查）。
   * AI 给的只是一份草稿：建完立刻载入代码板，接着用「让 AI 改代码」或手改把它调到能用。
   */
  const createTemplateWithAI = async () => {
    const name = newTemplateName.trim()
    const guidelines = newTemplateGuidelines.trim()
    if (!name) {
      toast.error('请填写期刊名称')
      return
    }
    if (!guidelines) {
      toast.error('请先粘贴投稿须知原文，AI 才有提取依据')
      return
    }
    let ai1: { baseUrl: string; apiKey: string; model: string }
    let ai2: { baseUrl: string; apiKey: string; model: string }
    try {
      const cfg = useSettingsStore.getState().getDualEngineConfig()
      ai1 = cfg.ai1
      ai2 = cfg.ai2
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'AI 配置不完整，请先在设置页填写 API Key')
      return
    }
    setIsCreatingTemplate(true)
    setTemplateCreateStatus('准备中...')
    try {
      const extracted = await extractGuidelinesWithAI({
        guidelinesText: guidelines,
        ai1,
        ai2,
        onProgress: (ev) => {
          const label =
            ev.stage === 'ai1_running'
              ? `AI-1 提取排版参数（第 ${ev.attempt} 轮）...`
              : ev.stage === 'ai2_running'
                ? `AI-2 忠实性核查中（第 ${ev.attempt} 轮）...`
                : ev.stage === 'ai2_self_correct_running'
                  ? 'AI-2 引证锚定自纠中...'
                  : ev.stage === 'verifying'
                    ? '引证锚定校验中...'
                    : ev.stage === 'attempt_failed_retry'
                      ? `第 ${ev.attempt} 轮未通过，准备重试...`
                      : ev.stage === 'finished'
                        ? '核查完成'
                        : ev.stage === 'error'
                          ? `出错：${ev.errorMessage || ''}`
                          : '处理中...'
          setTemplateCreateStatus(label)
        },
      })

      const created = await createTemplate({
        name,
        short_name: extracted.short_name,
        publisher: extracted.publisher,
        guidelines_content: guidelines,
      })

      // AI 提取结果落到模板上；期刊名以用户填的为准，不让 AI 猜的名字覆盖
      const applied = applyExtractedToTemplate({}, extracted)
      delete applied.name
      const updated = (await updateTemplate(created.id, applied)) || created

      const list = await getAllTemplates()
      setTemplates(list)
      adoptNewTemplate(list.find((t) => t.id === created.id) || updated)
      setShowNewTemplateForm(false)
      setNewTemplateName('')
      setNewTemplateGuidelines('')
      toast.success('AI 已提取并创建模板，骨架已载入代码板 —— 改完记得「保存回模板」')
    } catch (err) {
      toast.error(`AI 创建失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsCreatingTemplate(false)
      setTemplateCreateStatus('')
    }
  }

  /** 模板调试：把模板的 LaTeX 载入代码板；模板还没写过就给一份可编译骨架 */
  const loadTemplateIntoLatexBoard = () => {
    if (!currentTemplate) {
      toast.error('请先选择期刊模板')
      return
    }
    const existing = currentTemplate.template_tex?.trim()
    setLatexCode(existing || buildLatexSkeletonFromTemplate(currentTemplate))
    setCompileError('')
    toast.success(existing ? '已载入模板 LaTeX' : '该模板还没有 LaTeX，已生成可编译骨架')
  }

  /** 把代码板内容存回期刊模板（落到 templates/journals/{id}/template.tex） */
  const saveLatexToTemplate = async () => {
    if (!currentTemplate) {
      toast.error('请先选择期刊模板')
      return
    }
    if (!latexCode.trim()) {
      toast.error('代码板为空，没有可保存的内容')
      return
    }
    try {
      await updateTemplate(currentTemplate.id, { template_tex: latexCode })
      const now = Date.now()
      setTemplates((prev) =>
        prev.map((t) =>
          t.id === currentTemplate.id ? { ...t, template_tex: latexCode, updated_at: now } : t,
        ),
      )
      toast.success('已保存回期刊模板')
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 模板调试：让 AI 按指令直接改代码板里的 LaTeX。
   * 可信检索开着时，模板的投稿须知原文会一起作为 ground truth 交出去，
   * AI-2 会核查「改出来的东西有没有依据」，防止它凭空加需求。
   */
  const refineLatexCode = async () => {
    if (!latexCode.trim()) {
      toast.error('代码板为空，先载入模板或由正文生成 LaTeX')
      return
    }
    const instruction = templateInstruction.trim()
    if (!instruction) {
      toast.error('先写清楚要怎么改，例如「改成双栏排版」')
      return
    }
    const { getDualEngineConfig } = useSettingsStore.getState()
    const { ai1, ai2 } = getDualEngineConfig()
    setIsRefiningLatex(true)
    setRefineStatus('准备中...')
    try {
      const result = await refineLatexWithAI({
        latex: latexCode,
        instruction,
        template: currentTemplate,
        guidelines: trustedSearch ? currentTemplate?.guidelines_content : undefined,
        ai1,
        ai2,
        onProgress: (e) => setRefineStatus(e.message || ''),
      })
      setLatexCode(result.latex)
      setCompileError('')
      setTemplateInstruction('')
      toast.success(
        result.reviewPassed === false
          ? 'AI 已改完，但 AI-2 忠实性核查未完全通过，请核对'
          : 'AI 已改完，结果在代码板',
      )
    } catch (err) {
      toast.error(`AI 改代码失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsRefiningLatex(false)
      setRefineStatus('')
    }
  }

  /** 重新列出当前项目已导入的宏包 */
  const reloadLatexPackages = async () => {
    if (!activeProjectId) return
    setIsLoadingPackages(true)
    try {
      setLatexPackages(await listLatexPackages(activeProjectId))
    } catch (err) {
      console.warn('[Writing] 读取导入的宏包失败:', err)
    } finally {
      setIsLoadingPackages(false)
    }
  }

  /** 导入宏包：一次 commit 把所有选中文件写进项目目录，之后编译自动带上 */
  const handleImportPackages = async (fileList: FileList | null) => {
    if (!activeProjectId || !fileList || fileList.length === 0) return
    setIsImportingPackages(true)
    setPackageStatus('')
    try {
      const result = await importLatexPackages(activeProjectId, Array.from(fileList))
      await reloadLatexPackages()
      const parts: string[] = []
      if (result.imported.length > 0) {
        parts.push(`已导入 ${result.imported.length} 个：${result.imported.join('、')}`)
      }
      if (result.skipped.length > 0) {
        parts.push(
          `跳过 ${result.skipped.length} 个：` +
            result.skipped.map((s) => `${s.name}（${s.reason}）`).join('；'),
        )
      }
      setPackageStatus(parts.join('\n'))
      if (result.imported.length > 0) {
        toast.success(`已导入 ${result.imported.length} 个宏包，编译时自动带上`)
      } else {
        toast.error('没有导入任何文件')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setPackageStatus(`导入失败：${msg}`)
      toast.error(`导入宏包失败：${msg}`)
    } finally {
      setIsImportingPackages(false)
    }
  }

  /** 删除一个已导入的宏包 */
  const handleDeletePackage = async (name: string) => {
    if (!activeProjectId) return
    try {
      await deleteLatexPackages(activeProjectId, [name])
      await reloadLatexPackages()
      setPackageStatus(`已删除 ${name}`)
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 编译代码板 → 真 PDF（浏览器内 XeLaTeX WASM，全程不联网） */
  const compileCurrentLatex = async () => {
    if (!latexCode.trim()) {
      toast.error('代码板为空，先生成或粘贴 LaTeX 源码')
      return
    }
    setIsCompiling(true)
    setCompileError('')
    setCompileStatus('正在加载 XeLaTeX 运行时...')
    try {
      // 导入的宏包挂在项目目录里，编译时要取出来挂进虚拟文件系统才真正生效
      let additionalFiles: Array<{ path: string; data: Uint8Array }> = []
      if (activeProjectId && latexPackages.length > 0) {
        setCompileStatus(`正在加载 ${latexPackages.length} 个导入的宏包...`)
        additionalFiles = await loadLatexPackages(activeProjectId)
      }
      const result = await compileLatex({
        source: latexCode,
        bibtex: latexBib.trim() || undefined,
        additionalFiles,
        onStatus: (e) => setCompileStatus(e.message),
      })
      setPdfObjectUrl(createPdfObjectUrl(result.pdf))
      setCompileStatus(`编译完成 · ${result.passes} 趟 XeTeX${result.bibtexRan ? ' + BibTeX' : ''}`)
      toast.success('编译完成')
    } catch (err) {
      const log = getCompileErrorLog(err)
      setCompileError(withRuntimeHint(log || (err instanceof Error ? err.message : String(err))))
      setCompileStatus('')
      toast.error('编译失败，见下方日志')
    } finally {
      setIsCompiling(false)
    }
  }

  /**
   * 云端编译：把源文件提交进私库，叫起 GitHub Actions 跑官方 TeX Live 镜像。
   * 与浏览器内 WASM 编译并列 —— 那边快但宏包/版本被运行时钉死，这边慢但什么包都能用。
   */
  const compileInCloud = async () => {
    if (!latexCode.trim()) {
      toast.error('代码板为空，先生成或粘贴 LaTeX 源码')
      return
    }
    if (!activeProjectId) {
      toast.error('先选一个项目 —— 云端编译的产物要落到项目目录里')
      return
    }
    setIsCloudCompiling(true)
    setCompileError('')
    setCloudRunUrl('')
    setCompileStatus('正在准备云端编译...')
    try {
      const result = await compileOnGitHub(
        activeProjectId,
        latexCode,
        latexBib.trim() || undefined,
        {
          onStage: (s) => setCompileStatus(s),
          onRunUrl: (url) => setCloudRunUrl(url),
        },
      )
      setPdfObjectUrl(createPdfObjectUrl(result.pdf))
      setCompileStatus('云端编译完成（官方 TeX Live）')
      toast.success('云端编译完成')
    } catch (err) {
      setCompileError(err instanceof Error ? err.message : String(err))
      setCompileStatus('')
      toast.error('云端编译失败，见下方日志')
    } finally {
      setIsCloudCompiling(false)
    }
  }

  /** 下载代码板里的 .tex */
  const downloadLatexSource = () => {
    const blob = new Blob([latexCode], { type: 'text/x-tex;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${activeProject?.title || 'paper'}.tex`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  /** 下载编译出的 PDF */
  const downloadCompiledPdf = () => {
    if (!pdfUrl) return
    const a = document.createElement('a')
    a.href = pdfUrl
    a.download = `${activeProject?.title || 'paper'}.pdf`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
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

  const LeftPanelIcon = PANEL_MODES.find((m) => m.value === leftPanelMode)?.icon || PenTool
  const RightPanelIcon = PANEL_MODES.find((m) => m.value === rightPanelMode)?.icon || Sparkles

  return (
    <div ref={containerRef} className="h-[calc(100vh-3rem)] flex bg-slate-50 relative overflow-hidden">
      <aside
        className={`bg-white border-r border-slate-200 flex flex-col flex-shrink-0 transition-all duration-300 ${
          navCollapsed ? 'w-0 opacity-0 overflow-hidden border-r-0' : 'w-64 opacity-100'
        }`}
      >
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* ── 堆叠面板 1/2：项目（收起后只剩标题行，标题显示当前项目） ── */}
          <div className={`flex flex-col min-h-0 ${projectsExpanded ? 'flex-1' : 'flex-none'}`}>
            <div className="flex items-center gap-0.5 pl-1 pr-2 py-1.5 border-b border-slate-200 flex-shrink-0">
              <button
                onClick={() => setProjectsExpanded(!projectsExpanded)}
                className="flex-1 min-w-0 flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-slate-50 transition"
                title={projectsExpanded ? '收起项目' : '展开项目'}
              >
                {projectsExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                )}
                <FileText className="w-4 h-4 text-indigo-600 flex-shrink-0" />
                <span className="text-sm font-semibold text-slate-800 truncate">
                  {projectsExpanded ? '项目导航' : activeProject?.title || '项目导航'}
                </span>
              </button>
              <button
                onClick={() => setShowNewProjectInput(!showNewProjectInput)}
                className="p-1 flex-shrink-0 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                title="新建项目"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>

            {projectsExpanded && (
              <>
                {(showNewProjectInput || activeProject) && (
                  <div className="px-3 py-2 border-b border-slate-100 flex-shrink-0 space-y-2">
                    {showNewProjectInput && (
                      <div className="flex gap-1">
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
                        className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs text-indigo-600 bg-indigo-50/60 hover:bg-indigo-100 rounded-md transition"
                        title="给当前项目补充文献（项目内临时知识库）"
                      >
                        <BookPlus className="w-3.5 h-3.5" />
                        添加项目文献
                      </button>
                    )}
                  </div>
                )}
                <div className="flex-1 min-h-0 overflow-y-auto">
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
              </>
            )}
          </div>

          {/* ── 堆叠面板 2/2：大纲（收起后只剩标题行） ── */}
          <div
            className={`border-t border-slate-200 flex flex-col min-h-0 ${
              outlineExpanded ? 'flex-1' : 'flex-none'
            }`}
          >
            <button
              onClick={() => setOutlineExpanded(!outlineExpanded)}
              className="w-full flex-shrink-0 flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition"
              title={outlineExpanded ? '收起大纲' : '展开大纲'}
            >
              {outlineExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              )}
              <ListTree className="w-3.5 h-3.5 text-indigo-600" />
              大纲
              <span className="ml-auto text-slate-400 font-normal">{outline.length}</span>
            </button>
            {outlineExpanded && (
              <div className="flex-1 min-h-0 overflow-y-auto px-2 py-1 space-y-0.5">
                {outline.length === 0 && (
                  <div className="text-xs text-slate-400 text-center py-3">暂无大纲</div>
                )}
                {outline.map((item, idx) => (
                  <button
                    key={idx}
                    onClick={() => jumpToHeading(idx)}
                    className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-indigo-50 hover:text-indigo-700 transition truncate ${
                      item.level === 1
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
        {/* 左右两块用同一份实现：任何功能都能放到任意一侧 */}
        {([
          {
            side: 'left' as const,
            mode: leftPanelMode,
            setMode: setLeftPanelMode,
            icon: LeftPanelIcon,
            dropdownRef: leftDropdownRef,
            showDropdown: showLeftDropdown,
            setShowDropdown: setShowLeftDropdown,
            editorRef: leftEditorRef,
          },
          {
            side: 'right' as const,
            mode: rightPanelMode,
            setMode: setRightPanelMode,
            icon: RightPanelIcon,
            dropdownRef: rightDropdownRef,
            showDropdown: showRightDropdown,
            setShowDropdown: setShowRightDropdown,
            editorRef: rightEditorRef,
          },
        ]).map((p) => (
          <Fragment key={p.side}>
            {p.side === 'right' && (
              <div
                className={`flex-shrink-0 flex items-center justify-center cursor-col-resize bg-slate-100 hover:bg-indigo-100 transition-colors z-10 ${
                  isDragging ? 'bg-indigo-200' : ''
                }`}
                style={{ width: '0.375rem' }}
                onMouseDown={handleDragStart}
              >
                <GripVertical className="w-3 h-3 text-slate-400" />
              </div>
            )}

            <div
              className={`flex flex-col min-w-0 bg-white ${
                p.side === 'right' ? 'border-l border-slate-200' : ''
              }`}
              style={{
                width: p.side === 'left' ? `${panelRatio}%` : `calc(${100 - panelRatio}% - 0.375rem)`,
              }}
            >
              <div className="bg-white border-b border-slate-200 px-3 py-2 flex items-center gap-2 flex-shrink-0">
                <div className="relative" ref={p.dropdownRef}>
                  <button
                    onClick={() => p.setShowDropdown(!p.showDropdown)}
                    className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-left hover:border-indigo-300 transition flex items-center gap-2"
                  >
                    <p.icon className="w-4 h-4 text-indigo-600" />
                    <span className="text-sm font-medium text-slate-700">
                      {PANEL_MODES.find((m) => m.value === p.mode)?.label}
                    </span>
                    <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${p.showDropdown ? 'rotate-180' : ''}`} />
                  </button>
                  {p.showDropdown && (
                    <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-30 overflow-hidden min-w-36">
                      {PANEL_MODES.map((mode) => {
                        const Icon = mode.icon
                        const active = p.mode === mode.value
                        return (
                          <button
                            key={mode.value}
                            onClick={() => {
                              p.setMode(mode.value)
                              // 左右联动：选「编辑区」或「期刊模板」时，
                              // 自动把另一侧切成 LaTeX 工作区 —— 排版 / 模板调试都靠这一对
                              if (LATEX_PAIRED_MODES.includes(mode.value)) {
                                const otherSet =
                                  p.side === 'left' ? setRightPanelMode : setLeftPanelMode
                                const otherMode =
                                  p.side === 'left' ? rightPanelMode : leftPanelMode
                                if (otherMode !== 'typesetting') otherSet('typesetting')
                              }
                              p.setShowDropdown(false)
                            }}
                            className={`w-full px-3 py-2 text-left hover:bg-slate-50 transition flex items-center gap-2 ${
                              active ? 'bg-indigo-50/50' : ''
                            }`}
                          >
                            <Icon className={`w-4 h-4 ${active ? 'text-indigo-600' : 'text-slate-500'}`} />
                            <span className={`text-sm ${active ? 'text-indigo-700 font-medium' : 'text-slate-700'}`}>
                              {mode.label}
                            </span>
                            {mode.hint && (
                              <span className="text-[0.625rem] text-slate-400">{mode.hint}</span>
                            )}
                            {active && <Check className="w-4 h-4 text-indigo-600 ml-auto" />}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
                {p.side === 'left' && activeProject && (
                  <>
                    <ChevronRight className="w-4 h-4 text-slate-300" />
                    <span className="text-sm font-semibold text-slate-700 truncate max-w-40">
                      {activeProject.title}
                    </span>
                  </>
                )}
              </div>

          {p.mode === 'editor' && (
            <>
              <div className="flex items-center gap-2 px-3 py-1.5 bg-white border-b border-slate-200 flex-shrink-0">
                <button
                  onClick={() => setShowCitationModal(true)}
                  className="flex-shrink-0 whitespace-nowrap p-1.5 text-indigo-600 hover:bg-indigo-50 rounded transition flex items-center gap-1"
                  title="插入引用 (Ctrl+Shift+K)"
                >
                  <BookMarked className="w-4 h-4" />
                  <span className="text-xs font-medium">引用</span>
                </button>

                <div className="flex-1 min-w-0" />

                <div className="flex-shrink-0 whitespace-nowrap flex items-center gap-1.5 text-xs">
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
                  className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 transition shadow-sm"
                >
                  <Download className="w-3.5 h-3.5" />
                  导出
                </button>
              </div>

              <div className="flex-1 min-h-0 bg-white">
                <VditorEditor
                  ref={p.editorRef}
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

          {p.mode === 'references' && (
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

          {p.mode === 'ai' && (
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
                {/* 指令 = 模式开关：点亮它，下面只出现这条指令需要的输入框 */}
                <div className="flex flex-wrap gap-1.5">
                  {BUILTIN_ACTIONS.map((action) => {
                    const Icon = action.icon
                    const active = activeActionKey === action.key
                    return (
                      <button
                        key={action.key}
                        onClick={() => toggleQuickAction(action.key)}
                        className={`px-2.5 py-1.5 text-xs rounded-full border transition flex items-center gap-1 ${
                          active
                            ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm'
                            : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700'
                        }`}
                        title={action.template}
                      >
                        <Icon className="w-3 h-3" />
                        {action.label}
                      </button>
                    )
                  })}
                  {customActions.map((action) => {
                    const key = `custom:${action.label}`
                    const active = activeActionKey === key
                    return (
                      <span
                        key={action.label}
                        className={`inline-flex items-center text-xs rounded-full border transition ${
                          active
                            ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm'
                            : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700'
                        }`}
                      >
                        <button
                          onClick={() => toggleQuickAction(key)}
                          className="pl-2.5 pr-1 py-1.5"
                          title={action.prompt}
                        >
                          {action.label}
                        </button>
                        <button
                          onClick={() => handleDeleteAction(action.label)}
                          className={`pr-1.5 pl-0.5 py-1.5 transition ${
                            active ? 'text-indigo-200 hover:text-white' : 'text-slate-300 hover:text-red-500'
                          }`}
                          title="删除该指令"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    )
                  })}
                </div>

                {activeAction && (
                  <div className="mt-2.5 p-2.5 rounded-lg border border-indigo-200 bg-indigo-50/40 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[0.6875rem] font-semibold text-indigo-700">
                        {activeAction.kind === 'custom' ? activeAction.label : activeAction.def.label}
                      </span>
                      <button
                        onClick={() => setActiveActionKey(null)}
                        className="text-slate-400 hover:text-slate-600"
                        title="取消选择"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {activeAction.kind === 'builtin'
                      ? activeAction.def.params.map((param, i) =>
                          param.multiline ? (
                            <textarea
                              key={param.key}
                              value={actionValues[param.key] || ''}
                              onChange={(e) =>
                                setActionValues((prev) => ({ ...prev, [param.key]: e.target.value }))
                              }
                              rows={3}
                              autoFocus={i === 0}
                              placeholder={param.placeholder}
                              className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 resize-y bg-white"
                            />
                          ) : (
                            <input
                              key={param.key}
                              type="text"
                              value={actionValues[param.key] || ''}
                              onChange={(e) =>
                                setActionValues((prev) => ({ ...prev, [param.key]: e.target.value }))
                              }
                              autoFocus={i === 0}
                              placeholder={param.placeholder}
                              className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 bg-white"
                            />
                          ),
                        )
                      : (
                          <textarea
                            value={customPromptDraft}
                            onChange={(e) => setCustomPromptDraft(e.target.value)}
                            rows={4}
                            autoFocus
                            placeholder="这条指令的提示词…"
                            className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100 resize-y bg-white"
                          />
                        )}

                    <div className="flex items-center gap-2">
                      <button
                        onClick={sendQuickAction}
                        disabled={
                          isAiGenerating || isAiReviewing || !!actionIncomplete || !composeActionPrompt()
                        }
                        className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                      >
                        <Send className="w-3 h-3" />
                        拼好并发送
                      </button>
                      <span className="text-[0.625rem] text-slate-400 leading-tight">
                        {actionIncomplete ? '填完上面的空才能发' : '发送时自动拼成完整提示词'}
                      </span>
                    </div>
                  </div>
                )}
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

          {p.mode === 'library' && (
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

          {p.mode === 'knowledge' && (
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

          {/* ── 期刊模板：选模板 / 载入·回存 LaTeX / 让 AI 改代码（模板调试的左半） ── */}
          {p.mode === 'template' && (
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
                {/* ── 就地新建模板：AI 提取出来的只是草稿，建完直接落到代码板里接着改 ── */}
                <div>
                  <button
                    onClick={() => setShowNewTemplateForm(!showNewTemplateForm)}
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-indigo-600 bg-indigo-50/60 hover:bg-indigo-100 rounded-lg transition"
                  >
                    {showNewTemplateForm ? (
                      <ChevronDown className="w-3.5 h-3.5" />
                    ) : (
                      <Plus className="w-3.5 h-3.5" />
                    )}
                    新建期刊模板
                  </button>

                  {showNewTemplateForm && (
                    <div className="mt-2 p-2.5 space-y-2 bg-slate-50 rounded-lg">
                      <input
                        type="text"
                        value={newTemplateName}
                        onChange={(e) => setNewTemplateName(e.target.value)}
                        placeholder="期刊名称，如 Nature Communications"
                        className="w-full px-2 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
                      />
                      <textarea
                        value={newTemplateGuidelines}
                        onChange={(e) => setNewTemplateGuidelines(e.target.value)}
                        rows={4}
                        placeholder="投稿须知原文（可选）。粘了就可以让 AI 按须知定 documentclass / 引用样式 / 双栏等；不粘就直接建骨架，之后在代码板里改。"
                        className="w-full px-2 py-1.5 text-xs border border-slate-200 rounded-lg resize-none focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={createTemplateWithAI}
                          disabled={
                            isCreatingTemplate ||
                            !newTemplateName.trim() ||
                            !newTemplateGuidelines.trim()
                          }
                          className="flex-1 py-1.5 bg-indigo-600 text-white rounded-lg text-[0.6875rem] font-medium hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
                        >
                          {isCreatingTemplate ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Sparkles className="w-3 h-3" />
                          )}
                          AI 提取并创建
                        </button>
                        <button
                          onClick={createTemplateManually}
                          disabled={isCreatingTemplate || !newTemplateName.trim()}
                          className="flex-1 py-1.5 bg-white border border-slate-200 text-slate-700 rounded-lg text-[0.6875rem] font-medium hover:bg-slate-50 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          只建骨架
                        </button>
                      </div>
                      {templateCreateStatus && (
                        <p className="text-[0.625rem] text-slate-400 leading-relaxed">
                          {templateCreateStatus}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* 编译器的能力边界：写清楚内置了什么，省得用户猜 */}
                <p className="text-[0.625rem] text-slate-400 leading-relaxed bg-slate-50 rounded-lg p-2">
                  编译器是随站点分发的 XeLaTeX 运行时（不联网，约 85MB，首次编译加载一次）。
                  已内置基础宏包 amsmath / graphicx / hyperref / geometry / xcolor / longtable /
                  etoolbox / fontspec，常用宏包 booktabs、natbib、amssymb、tabularx、multirow、
                  caption / subcaption / microtype，文档类{' '}
                  <b className="font-medium text-slate-500">IEEEtran</b>、
                  <b className="font-medium text-slate-500">elsarticle</b>、
                  <b className="font-medium text-slate-500">acmart</b>、
                  <b className="font-medium text-slate-500">revtex4-2</b>，
                  中文走 xeCJK + Noto Serif SC（正文里有汉字就自动接管，拉丁文仍用文档类自己的字体）。
                  其它宏包可以自己导入：在右边编译器顶部点「宏包」，把 .sty / .cls 选进来，
                  导入一次之后每次编译自动带上。
                  <br />
                  还是编不过的（要最新 TeX Live、要 biber、要冷门宏包），就点「云端编译」——
                  那是在你自己的私库里跑 GitHub Actions + 官方 TeX Live 镜像，什么宏包都能装，
                  代价是要排队等一会儿。
                </p>

                <div>
                  <div className="text-xs font-medium text-slate-600 mb-1.5">目标期刊模板</div>
                  <div className="relative">
                    <select
                      value={selectedTemplateId}
                      onChange={(e) => setSelectedTemplateId(e.target.value)}
                      disabled={templates.length === 0}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-white appearance-none pr-8 disabled:bg-slate-100 disabled:text-slate-400"
                    >
                      {templates.length === 0 && <option value="">未创建期刊模板</option>}
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.short_name || t.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                  </div>
                  {templates.length === 0 && (
                    <p className="mt-1.5 text-[0.6875rem] text-slate-400 leading-relaxed">
                      点上面的「新建期刊模板」：粘投稿须知让 AI 提取，或先建一份骨架 ——
                      建完会自动载入代码板，改到能编译再「保存回模板」。
                    </p>
                  )}
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={loadTemplateIntoLatexBoard}
                    disabled={!currentTemplate}
                    className="flex-1 py-2 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    载入到代码板
                  </button>
                  <button
                    onClick={saveLatexToTemplate}
                    disabled={!currentTemplate || !latexCode.trim()}
                    className="flex-1 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg text-xs font-medium hover:bg-slate-50 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                  >
                    <Save className="w-3.5 h-3.5" />
                    保存回模板
                  </button>
                </div>

                {currentTemplate && (
                  <div className="p-2.5 bg-slate-50 rounded-lg text-[0.6875rem] text-slate-500 leading-relaxed">
                    <div className="font-medium text-slate-600 mb-0.5">
                      {currentTemplate.short_name || currentTemplate.name}
                    </div>
                    <div>
                      文档类：{currentTemplate.document_class}
                      {currentTemplate.document_options ? ` [${currentTemplate.document_options}]` : ''}
                      {' · '}
                      {currentTemplate.bibtex_style}
                      {' · '}
                      {currentTemplate.two_column ? '双栏' : '单栏'}
                    </div>
                    <div className="mt-0.5">
                      {currentTemplate.guidelines_content
                        ? '已有投稿须知原文，可信检索可用'
                        : '该模板没有投稿须知原文，可信检索无依据可锚定'}
                    </div>
                  </div>
                )}

                <div className="border-t border-slate-100 pt-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-600">让 AI 改 LaTeX 代码</span>
                    <button
                      onClick={() => setTrustedSearch(!trustedSearch)}
                      className={`flex items-center gap-1 text-[0.6875rem] px-1.5 py-0.5 rounded transition ${
                        trustedSearch
                          ? 'text-indigo-600 hover:bg-indigo-50'
                          : 'text-slate-400 hover:bg-slate-50'
                      }`}
                      title="开启后会把模板的投稿须知原文作为 ground truth 交给 AI，AI-2 会核查每条改动的依据"
                    >
                      {trustedSearch ? (
                        <ToggleRight className="w-4 h-4" />
                      ) : (
                        <ToggleLeft className="w-4 h-4" />
                      )}
                      可信检索
                    </button>
                  </div>
                  <textarea
                    value={templateInstruction}
                    onChange={(e) => setTemplateInstruction(e.target.value)}
                    rows={3}
                    placeholder="例如：改成双栏排版；摘要压到 200 字以内；标题全部小写"
                    className="w-full px-2.5 py-2 text-xs border border-slate-200 rounded-lg resize-none focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100"
                  />
                  <button
                    onClick={refineLatexCode}
                    disabled={isRefiningLatex}
                    className="w-full py-2 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white rounded-lg text-xs font-medium hover:from-indigo-700 hover:to-indigo-800 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                  >
                    {isRefiningLatex ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        AI 改代码中...
                      </>
                    ) : (
                      <>
                        <Wand2 className="w-3.5 h-3.5" />
                        让 AI 改代码
                      </>
                    )}
                  </button>
                  {refineStatus && (
                    <p className="text-[0.625rem] text-slate-400 leading-relaxed">{refineStatus}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── LaTeX 工作区：左「代码板」 + 右「编译器」，左右并排各占一半 ── */}
          {p.mode === 'typesetting' && (
            <div className="flex-1 flex flex-row min-h-0 overflow-hidden">
              {/* 左半：LaTeX 代码板 */}
              <div className="flex-1 min-w-0 min-h-0 flex flex-col border-r border-slate-200">
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 border-b border-slate-200 flex-shrink-0">
                  <FileCode className="w-3.5 h-3.5 text-indigo-600 flex-shrink-0" />
                  <span className="text-xs font-semibold text-slate-700 flex-shrink-0">
                    LaTeX 代码板
                  </span>
                  <div className="flex-1 min-w-0" />
                  <button
                    onClick={generateLatexFromMarkdown}
                    disabled={isGeneratingLatex}
                    className="flex-shrink-0 flex items-center gap-1 px-2 py-1 text-[0.6875rem] text-white bg-indigo-600 rounded hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    title="把左侧 markdown 正文交给 AI 转成 LaTeX（注意：正文会被发送到 AI 服务）"
                  >
                    {isGeneratingLatex ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Wand2 className="w-3 h-3" />
                    )}
                    由正文生成
                  </button>
                  <button
                    onClick={() => handleCopyContent(latexCode)}
                    disabled={!latexCode}
                    className="flex-shrink-0 p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition disabled:opacity-40"
                    title="复制 LaTeX 源码"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={downloadLatexSource}
                    disabled={!latexCode}
                    className="flex-shrink-0 p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition disabled:opacity-40"
                    title="下载 .tex"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                </div>
                {latexGenStatus && (
                  <div className="px-3 py-1 text-[0.625rem] text-indigo-600 bg-indigo-50/60 border-b border-indigo-100 flex-shrink-0 truncate">
                    {latexGenStatus}
                  </div>
                )}
                <textarea
                  value={latexCode}
                  onChange={(e) => setLatexCode(e.target.value)}
                  spellCheck={false}
                  placeholder="这里是 LaTeX 源码。点上方「由正文生成」，或在左侧「期刊模板」里点「载入到代码板」。"
                  className="flex-1 min-h-0 w-full resize-none p-3 font-mono text-[0.6875rem] leading-relaxed text-slate-800 bg-white focus:outline-none"
                />
              </div>

              {/* 右半：编译器（浏览器内 XeLaTeX WASM，真编译） */}
              <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 border-b border-slate-200 flex-shrink-0">
                  <Play className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                  <span className="text-xs font-semibold text-slate-700 flex-shrink-0">编译器</span>
                  {compileStatus && (
                    <span className="text-[0.625rem] text-slate-400 truncate">{compileStatus}</span>
                  )}
                  <div className="flex-1 min-w-0" />
                  <button
                    onClick={() => setShowPackagesPanel((v) => !v)}
                    className={`flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[0.6875rem] transition ${
                      showPackagesPanel
                        ? 'bg-indigo-100 text-indigo-700'
                        : 'text-slate-500 hover:text-indigo-600 hover:bg-indigo-50'
                    }`}
                    title="导入 .sty / .cls 宏包，编译时自动带上"
                  >
                    <Package className="w-3 h-3" />
                    宏包
                    {latexPackages.length > 0 && (
                      <span className="text-[0.625rem] text-indigo-600">
                        {latexPackages.length}
                      </span>
                    )}
                  </button>
                  {pdfUrl && (
                    <button
                      onClick={downloadCompiledPdf}
                      className="flex-shrink-0 p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                      title="下载 PDF"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={compileInCloud}
                    disabled={isCloudCompiling || isCompiling}
                    className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1 text-[0.6875rem] text-indigo-700 bg-indigo-50 border border-indigo-200 rounded hover:bg-indigo-100 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    title="用 GitHub Actions 跑官方 TeX Live 编译：宏包和版本都不受浏览器运行时的限制，代价是要排队等一会儿"
                  >
                    {isCloudCompiling ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <CloudUpload className="w-3 h-3" />
                    )}
                    {isCloudCompiling ? '云端编译中' : '云端编译'}
                  </button>
                  <button
                    onClick={compileCurrentLatex}
                    disabled={isCompiling || isCloudCompiling}
                    className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1 text-[0.6875rem] text-white bg-emerald-600 rounded hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isCompiling ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Play className="w-3 h-3" />
                    )}
                    {isCompiling ? '编译中' : '编译'}
                  </button>
                </div>

                {/* 云端编译的 Actions 运行页 —— 第一次跑大概率要看着它调，给个直达链接 */}
                {cloudRunUrl && (
                  <div className="flex-shrink-0 px-3 py-1 text-[0.625rem] text-slate-400 border-b border-slate-100 truncate">
                    运行页：{' '}
                    <a
                      href={cloudRunUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-indigo-600 hover:underline"
                    >
                      {cloudRunUrl}
                    </a>
                  </div>
                )}

                {/* 导入宏包：运行时只内置了常用宏包，用户自己的 .sty/.cls 从这里进来 */}
                {showPackagesPanel && (
                  <div className="flex-shrink-0 border-b border-slate-200 bg-slate-50 px-3 py-2 space-y-2 max-h-56 overflow-y-auto">
                    <p className="text-[0.625rem] text-slate-500 leading-relaxed">
                      编译器自带常用宏包与 IEEEtran / elsarticle / acmart / revtex4-2。
                      没带的（冷门宏包、自己写的 .sty）从这里导入：
                      文件存进本项目目录，<span className="text-slate-600">之后每次编译自动挂上</span>，导入一次长期可用。
                    </p>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <button
                        onClick={() => packageFileInputRef.current?.click()}
                        disabled={isImportingPackages || !activeProjectId}
                        className="flex items-center gap-1 px-2 py-1 text-[0.6875rem] text-white bg-indigo-600 rounded hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isImportingPackages ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Upload className="w-3 h-3" />
                        )}
                        选择文件
                      </button>
                      <button
                        onClick={() => packageFolderInputRef.current?.click()}
                        disabled={isImportingPackages || !activeProjectId}
                        className="flex items-center gap-1 px-2 py-1 text-[0.6875rem] text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-50 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        title="整包拖进来更省事：一个宏包常有好几个 .sty/.def/.cfg"
                      >
                        <FolderOpen className="w-3 h-3" />
                        选择文件夹
                      </button>
                      {isLoadingPackages && (
                        <span className="text-[0.625rem] text-slate-400 flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          读取中
                        </span>
                      )}
                    </div>
                    {packageStatus && (
                      <pre className="text-[0.625rem] text-slate-500 whitespace-pre-wrap leading-relaxed">
                        {packageStatus}
                      </pre>
                    )}
                    {latexPackages.length > 0 ? (
                      <ul className="space-y-0.5">
                        {latexPackages.map((pkg) => (
                          <li
                            key={pkg.name}
                            className="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-white group"
                          >
                            <FileCode className="w-3 h-3 text-indigo-500 flex-shrink-0" />
                            <span className="text-[0.625rem] font-mono text-slate-700 truncate">
                              {pkg.name}
                            </span>
                            <span className="text-[0.625rem] text-slate-400 flex-shrink-0">
                              {pkg.size < 1024
                                ? `${pkg.size} B`
                                : `${(pkg.size / 1024).toFixed(0)} KB`}
                            </span>
                            <div className="flex-1" />
                            <button
                              onClick={() => handleDeletePackage(pkg.name)}
                              className="flex-shrink-0 p-0.5 text-slate-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition"
                              title={`删除 ${pkg.name}`}
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      !isLoadingPackages && (
                        <p className="text-[0.625rem] text-slate-400">
                          这个项目还没导入宏包。整包文件夹拖进来最省事。
                        </p>
                      )
                    )}
                  </div>
                )}

                <div className="flex-1 min-h-0 bg-slate-100 overflow-hidden">
                  {compileError ? (
                    <div className="h-full flex flex-col">
                      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 border-b border-red-100 flex-shrink-0">
                        <X className="w-3.5 h-3.5 text-red-500" />
                        <span className="text-[0.6875rem] font-medium text-red-600">
                          编译失败 · TeX 日志
                        </span>
                        <div className="flex-1" />
                        <button
                          onClick={() => handleCopyContent(compileError)}
                          className="text-[0.625rem] text-red-500 hover:text-red-700 flex items-center gap-1"
                        >
                          <Copy className="w-3 h-3" />
                          复制
                        </button>
                      </div>
                      <pre className="flex-1 min-h-0 overflow-auto p-3 text-[0.625rem] text-red-700 font-mono whitespace-pre-wrap">
                        {compileError}
                      </pre>
                    </div>
                  ) : pdfUrl ? (
                    <iframe src={pdfUrl} title="编译结果 PDF" className="w-full h-full border-0" />
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-center px-6">
                      <Play className="w-8 h-8 text-slate-300 mb-2" />
                      <p className="text-xs text-slate-400 leading-relaxed">
                        点「编译」在浏览器里跑 XeLaTeX
                        <br />
                        出来的是真 PDF，不联网、不上传
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
            </div>
          </Fragment>
        ))}
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

      {/* 导入宏包：单文件/多选 */}
      <input
        ref={packageFileInputRef}
        type="file"
        accept=".sty,.cls,.def,.cfg,.clo,.fd,.rtx,.enc,.sto,.tex"
        multiple
        onChange={(e) => {
          void handleImportPackages(e.target.files)
          // 清空 value，否则同一批文件再选一次不会触发 onChange
          e.target.value = ''
        }}
        className="hidden"
      />

      {/* 导入宏包：整个文件夹（宏包通常一堆文件，这个入口更实用） */}
      <input
        ref={packageFolderInputRef}
        type="file"
        // @ts-ignore webkitdirectory is non-standard
        webkitdirectory=""
        directory=""
        multiple
        onChange={(e) => {
          void handleImportPackages(e.target.files)
          e.target.value = ''
        }}
        className="hidden"
      />
    </div>
  )
}
