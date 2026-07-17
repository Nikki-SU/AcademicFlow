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
  Bold,
  Italic,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Code,
  Link,
  Image,
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
  Languages,
  FileCode,
  ExternalLink,
  AlignLeft,
  X,
  BookText,
  LayoutTemplate,
  FileOutput,
  Loader2,
  Check,
  Minus,
  ListTree,
  BookCopy,
  GraduationCap,
  Newspaper,
} from 'lucide-react'
import TableGridPicker from '../components/TableGridPicker'

const STAGES = [
  { value: 'topic', label: '选题' },
  { value: 'review', label: '文献综述' },
  { value: 'writing', label: '正文撰写' },
  { value: 'citation', label: '引用' },
  { value: 'typesetting', label: '排版' },
]

const AI_MODELS = [
  { value: 'model-a', label: '智能写作模型', desc: '擅长学术写作与润色' },
  { value: 'model-b', label: '深度研究模型', desc: '擅长文献分析与综述' },
]

const LEFT_PANEL_MODES = [
  { value: 'projects', label: '项目导航', icon: FileText },
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

const JOURNALS = [
  { value: 'jacs', label: 'JACS', name: 'Journal of the American Chemical Society' },
  { value: 'angew', label: 'Angew. Chem.', name: 'Angewandte Chemie International Edition' },
  { value: 'nature', label: 'Nature', name: 'Nature' },
  { value: 'science', label: 'Science', name: 'Science' },
  { value: 'nano-lett', label: 'Nano Lett.', name: 'Nano Letters' },
  { value: 'acs-nano', label: 'ACS Nano', name: 'ACS Nano' },
]

const QUICK_ACTIONS = [
  { key: 'continue', label: '继续写作', icon: PenTool },
  { key: 'polish', label: '润色', icon: Wand2 },
  { key: 'translate', label: '翻译', icon: Languages },
  { key: 'expand', label: '扩写', icon: Plus },
  { key: 'shorten', label: '缩写', icon: Minus },
  { key: 'search', label: '找文献', icon: Search },
  { key: 'summarize', label: '总结', icon: FileText },
]

interface Project {
  id: string
  name: string
  stage: string
  litCount: number
}

interface CitationRef {
  doi: string
  title: string
  authors: string
  year: number
  journal: string
}

interface AIMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  citations?: CitationRef[]
}

interface OutlineItem {
  level: number
  text: string
  id: string
}

type LeftPanelMode = 'projects' | 'outline' | 'references'
type RightPanelMode = 'ai' | 'library' | 'knowledge' | 'typesetting'

const DEMO_PROJECTS: Project[] = [
  { id: '1', name: '钙钛矿太阳能电池', stage: 'writing', litCount: 24 },
  { id: '2', name: 'CO2电催化还原', stage: 'review', litCount: 18 },
]

const DEMO_CITATIONS: CitationRef[] = [
  {
    doi: '10.1038/s41560-024-01234-5',
    title: '钙钛矿太阳能电池的最新进展与挑战',
    authors: 'Zhang Y, Wang L, Chen H',
    year: 2024,
    journal: 'Nature Energy',
  },
  {
    doi: '10.1021/jacs.3c11464',
    title: 'Pd/IPr^BIDEA 催化 gem-二氟环丙烷区域选择性氢化脱氟合成末端氟代烯烃',
    authors: 'Qian H, Cheng ZP, Luo Y, Lv L, Chen S, Li Z',
    year: 2024,
    journal: 'Journal of the American Chemical Society',
  },
  {
    doi: '10.1016/j.nanoen.2023.108765',
    title: 'Metal-organic framework derived nanomaterials for electrocatalytic CO2 reduction',
    authors: 'Liu X, Zhao Y, Sun M',
    year: 2023,
    journal: 'Nano Energy',
  },
]

const DEMO_MD = `# 引言

近年来，钙钛矿太阳能电池（PSCs）取得了突破性进展[[10.1038/s41560-024-01234-5]]，光电转换效率从 2009 年的 3.8% 迅速提升至 2024 年的 26.1%。

## 研究背景

钙钛矿材料具有以下优异特性：

- **高吸收系数**：可见光范围内几乎完全吸收
- *长载流子扩散长度*：可达微米级
- **可调节带隙**：通过卤素组分调控

> 钙钛矿太阳能电池被誉为"下一代光伏技术的希望之星"。

## 性能对比

| 材料体系 | 效率（%） | 稳定性（小时） | 成本（$/W） |
|---------|----------|--------------|------------|
| 单晶硅 | 26.7 | >25000 | 0.20-0.30 |
| 钙钛矿 | 26.1 | >10000 | 0.10-0.15 |
| 碲化镉 | 22.1 | >20000 | 0.18-0.25 |
| CIGS | 23.6 | >15000 | 0.25-0.35 |

## 实验方法

我们采用一步旋涂法制备钙钛矿薄膜：

\`\`\`python
def prepare_perovskite_film():
    precursor = PbI2 + MAI + DMF
    spin_coat(precursor, rpm=4000)
    anneal(temperature=100, time=60)
    return film
\`\`\`

更多细节请参考 [原始文献](https://doi.org/10.1021/jacs.3c11464)。
`

const DEMO_AI_RESPONSES: Record<string, { content: string; citations: CitationRef[] }> = {
  continue: {
    content: '基于当前上下文，我建议从以下几个方面继续展开：\n\n1. **钙钛矿薄膜的形貌调控** —— 探讨反溶剂工程、添加剂工程等策略对薄膜质量的影响。\n\n2. **界面工程与电荷传输** —— 分析电子传输层（ETL）和空穴传输层（HTL）的选择及其对器件性能的影响。\n\n3. **稳定性研究进展** —— 讨论光稳定性、热稳定性和湿度稳定性的最新突破。\n\n下面我为你撰写"形貌调控"部分的初稿：\n\n### 形貌调控策略\n\n钙钛矿薄膜的形貌直接影响器件的光电转换效率和稳定性。研究者们开发了多种调控策略，其中反溶剂法是最常用的方法之一[[10.1038/s41560-024-01234-5]]。通过在旋涂过程中滴加反溶剂（如氯苯、甲苯），可以快速诱导前驱体结晶，形成致密、均匀的钙钛矿薄膜。',
    citations: [DEMO_CITATIONS[0]],
  },
  polish: {
    content: '以下是润色后的段落：\n\n近年来，钙钛矿太阳能电池（Perovskite Solar Cells, PSCs）作为新一代光伏技术的代表，取得了举世瞩目的突破性进展[[10.1038/s41560-024-01234-5]]。自 2009 年首次报道 3.8% 的光电转换效率以来，PSCs 的效率在短短十余年间已攀升至 26.1%，这一增长速度在光伏发展史上堪称前所未有。\n\n**润色要点：**\n- 补充英文全称及缩写定义，学术规范性更强\n- "突破性进展"前增加修饰语，表达更丰富\n- 增加时间跨度的强调，突出进展的神速\n- 结尾增加评价性语句，提升段落的学术分量',
    citations: [DEMO_CITATIONS[0]],
  },
  translate: {
    content: '**英文翻译：**\n\n# Introduction\n\nIn recent years, perovskite solar cells (PSCs) have achieved breakthrough progress[[10.1038/s41560-024-01234-5]], with the power conversion efficiency rapidly increasing from 3.8% in 2009 to 26.1% in 2024.\n\n## Background\n\nPerovskite materials possess the following outstanding properties:\n\n- **High absorption coefficient**: nearly complete absorption in the visible light range\n- *Long carrier diffusion length*: reaching the micrometer scale\n- **Tunable bandgap**: regulated through halogen composition\n\n> Perovskite solar cells are hailed as "the rising star of next-generation photovoltaic technology".',
    citations: [DEMO_CITATIONS[0]],
  },
  search: {
    content: '根据你的研究方向，我为你推荐以下几篇相关文献：\n\n### 1. 钙钛矿太阳能电池综述\n\n这篇综述系统总结了钙钛矿太阳能电池近五年的关键进展，涵盖效率提升、稳定性改进和大面积制备等多个方面。引用量超过 2000 次，是该领域的经典综述之一[[10.1038/s41560-024-01234-5]]。\n\n### 2. 电催化 CO2 还原\n\n这篇研究论文报道了一种新型金属有机框架衍生纳米材料，在电催化 CO2 还原反应中表现出优异的活性和选择性[[10.1016/j.nanoen.2023.108765]]。\n\n### 3. 钯催化合成方法学\n\n这篇 JACS 论文报道了 Pd/IPr^BIDEA 催化体系在区域选择性氢化脱氟反应中的应用，对有机合成方法学研究有重要参考价值[[10.1021/jacs.3c11464]]。',
    citations: DEMO_CITATIONS,
  },
  summarize: {
    content: '**段落总结：**\n\n本段主要介绍了钙钛矿太阳能电池的研究背景和优异特性，核心要点如下：\n\n1. **效率突破**：从 2009 年的 3.8% 提升至 2024 年的 26.1%，发展迅速\n2. **材料优势**：\n   - 高吸收系数：可见光范围内几乎完全吸收\n   - 长载流子扩散长度：可达微米级\n   - 可调节带隙：通过卤素组分调控\n3. **学术地位**：被誉为"下一代光伏技术的希望之星"\n\n这些特性使得钙钛矿太阳能电池成为光伏领域最具潜力的研究方向之一[[10.1038/s41560-024-01234-5]]。',
    citations: [DEMO_CITATIONS[0]],
  },
  expand: {
    content: '**扩写后的内容：**\n\n近年来，钙钛矿太阳能电池（PSCs）作为第三代光伏技术的典型代表，在全球范围内掀起了研究热潮并取得了突破性进展[[10.1038/s41560-024-01234-5]]。自 2009 年日本科学家 Miyasaka 等人首次将钙钛矿材料应用于染料敏化太阳能电池并获得 3.8% 的光电转换效率以来，PSCs 的效率在短短十余年间实现了跨越式发展，截至 2024 年已达到 26.1% 的认证效率，逼近单晶硅电池的理论极限。这一前所未有的发展速度，使得钙钛矿太阳能电池成为光伏领域最受关注的研究方向之一。',
    citations: [DEMO_CITATIONS[0]],
  },
  shorten: {
    content: '**缩写后的内容：**\n\n钙钛矿太阳能电池（PSCs）近年来进展迅速[[10.1038/s41560-024-01234-5]]，效率从 2009 年的 3.8% 提升至 2024 年的 26.1%，被誉为下一代光伏技术的希望之星。其高吸收系数、长载流子扩散长度和可调节带隙等特性使其具有巨大的应用潜力。',
    citations: [DEMO_CITATIONS[0]],
  },
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderMarkdown(text: string): string {
  let html = text

  const doiRegex = /\[\[([^\]]+)\]\]/g
  html = html.replace(doiRegex, (_, doi) => {
    return `<a href="https://doi.org/${doi}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:text-indigo-800 underline decoration-dotted underline-offset-2 font-medium">[${doi}]</a>`
  })

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

function extractOutline(md: string): OutlineItem[] {
  const lines = md.split('\n')
  const outline: OutlineItem[] = []
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/)
    if (match) {
      const level = match[1].length
      const text = match[2].trim()
      const id = text.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '')
      outline.push({ level, text, id })
    }
  }
  return outline
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function WritingPage() {
  const [projects, setProjects] = useState<Project[]>(DEMO_PROJECTS)
  const [activeProjectId, setActiveProjectId] = useState<string | null>('1')
  const [mdContent, setMdContent] = useState(DEMO_MD)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved')
  const [lastSaved, setLastSaved] = useState<number | null>(null)
  const [messages, setMessages] = useState<AIMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isAiLoading, setIsAiLoading] = useState(false)

  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [leftPanelMode, setLeftPanelMode] = useState<LeftPanelMode>('projects')
  const [showLeftDropdown, setShowLeftDropdown] = useState(false)

  const [rightPanelMode, setRightPanelMode] = useState<RightPanelMode>('ai')
  const [showRightDropdown, setShowRightDropdown] = useState(false)

  const [selectedModel, setSelectedModel] = useState(AI_MODELS[0].value)
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const [trustedSearch, setTrustedSearch] = useState(true)
  const [citationScope, setCitationScope] = useState('all')
  const [showCitationScopeDropdown, setShowCitationScopeDropdown] = useState(false)

  const [showCitationModal, setShowCitationModal] = useState(false)
  const [citationSearch, setCitationSearch] = useState('')
  const [selectedCitations, setSelectedCitations] = useState<string[]>([])

  const [selectedJournal, setSelectedJournal] = useState(JOURNALS[0].value)
  const [typesettingProgress, setTypesettingProgress] = useState(0)
  const [isTypesetting, setIsTypesetting] = useState(false)
  const [typesetDone, setTypesetDone] = useState(false)

  const editorRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const leftDropdownRef = useRef<HTMLDivElement>(null)
  const rightDropdownRef = useRef<HTMLDivElement>(null)
  const modelDropdownRef = useRef<HTMLDivElement>(null)
  const citationScopeRef = useRef<HTMLDivElement>(null)

  const activeProject = projects.find((p) => p.id === activeProjectId)
  const renderedHtml = renderMarkdown(mdContent)
  const wordCount = mdContent.replace(/\s/g, '').length
  const currentModel = AI_MODELS.find((m) => m.value === selectedModel) || AI_MODELS[0]
  const outline = useMemo(() => extractOutline(mdContent), [mdContent])
  const currentJournal = JOURNALS.find((j) => j.value === selectedJournal) || JOURNALS[0]

  const filteredCitations = useMemo(() => {
    if (!citationSearch.trim()) return DEMO_CITATIONS
    const q = citationSearch.toLowerCase()
    return DEMO_CITATIONS.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.authors.toLowerCase().includes(q) ||
        c.journal.toLowerCase().includes(q) ||
        c.doi.toLowerCase().includes(q)
    )
  }, [citationSearch])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (leftDropdownRef.current && !leftDropdownRef.current.contains(e.target as Node)) {
        setShowLeftDropdown(false)
      }
      if (rightDropdownRef.current && !rightDropdownRef.current.contains(e.target as Node)) {
        setShowRightDropdown(false)
      }
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false)
      }
      if (citationScopeRef.current && !citationScopeRef.current.contains(e.target as Node)) {
        setShowCitationScopeDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (saveStatus !== 'unsaved') return
    const timer = setTimeout(() => {
      setSaveStatus('saving')
      setTimeout(() => {
        setSaveStatus('saved')
        setLastSaved(Date.now())
      }, 500)
    }, 1000)
    return () => clearTimeout(timer)
  }, [mdContent, saveStatus])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isAiLoading])

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

  const handleStageChange = useCallback((stage: string) => {
    if (!activeProjectId) return
    setProjects((prev) =>
      prev.map((p) => (p.id === activeProjectId ? { ...p, stage } : p))
    )
  }, [activeProjectId])

  const handleMdChange = (value: string) => {
    setMdContent(value)
    setSaveStatus('unsaved')
  }

  const handleEditorInput = () => {
    if (!editorRef.current) return
    const text = editorRef.current.innerText
    handleMdChange(text)
  }

  const insertMarkdown = (prefix: string, suffix: string = '', placeholder: string = '') => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    const selectedText = range.toString() || placeholder

    const newText = prefix + selectedText + suffix
    const textNode = document.createTextNode(newText)
    range.deleteContents()
    range.insertNode(textNode)

    range.setStart(textNode, prefix.length)
    range.setEnd(textNode, prefix.length + selectedText.length)
    selection.removeAllRanges()
    selection.addRange(range)

    handleEditorInput()
  }

  const insertTableWithSize = (rows: number, cols: number) => {
    const header = Array.from({ length: cols }, (_, i) => `列${i + 1}`).join(' | ')
    const separator = Array.from({ length: cols }, () => '---').join(' | ')
    const bodyRows = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => '内容').join(' | ')
    )
    const tableTemplate = `\n| ${header} |\n| ${separator} |\n${bodyRows.map(r => `| ${r} |`).join('\n')}\n`
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    const textNode = document.createTextNode(tableTemplate)
    range.deleteContents()
    range.insertNode(textNode)
    handleEditorInput()
  }

  const insertLink = () => {
    const url = prompt('请输入链接地址：', 'https://')
    if (!url) return
    insertMarkdown('[', `](${url})`, '链接文字')
  }

  const insertImage = () => {
    const url = prompt('请输入图片地址：', 'https://')
    if (!url) return
    insertMarkdown('![', `](${url})`, '图片描述')
  }

  const insertCitation = (doi: string) => {
    insertMarkdown(`[[${doi}]]`, '', '')
    setShowCitationModal(false)
  }

  const insertSelectedCitations = () => {
    if (selectedCitations.length === 0) return
    const text = selectedCitations.map((d) => `[[${d}]]`).join('')
    insertMarkdown(text, '', '')
    setSelectedCitations([])
    setShowCitationModal(false)
  }

  const exportMarkdown = () => {
    const blob = new Blob([mdContent], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${activeProject?.name || 'document'}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const handleSendMessage = (prompt?: string) => {
    const text = prompt || inputValue.trim()
    if (!text) return

    const userMsg: AIMessage = {
      id: String(Date.now()),
      role: 'user',
      content: text,
    }
    setMessages((prev) => [...prev, userMsg])
    setInputValue('')
    setIsAiLoading(true)

    setTimeout(() => {
      let response = DEMO_AI_RESPONSES.search
      if (prompt) {
        if (prompt.includes('continue') || prompt.includes('继续')) response = DEMO_AI_RESPONSES.continue
        else if (prompt.includes('polish') || prompt.includes('润色')) response = DEMO_AI_RESPONSES.polish
        else if (prompt.includes('translate') || prompt.includes('翻译')) response = DEMO_AI_RESPONSES.translate
        else if (prompt.includes('summarize') || prompt.includes('总结')) response = DEMO_AI_RESPONSES.summarize
        else if (prompt.includes('expand') || prompt.includes('扩写')) response = DEMO_AI_RESPONSES.expand
        else if (prompt.includes('shorten') || prompt.includes('缩写')) response = DEMO_AI_RESPONSES.shorten
      } else {
        const lower = text.toLowerCase()
        if (lower.includes('继续') || lower.includes('续写')) response = DEMO_AI_RESPONSES.continue
        else if (lower.includes('润色') || lower.includes('优化') || lower.includes('polish')) response = DEMO_AI_RESPONSES.polish
        else if (lower.includes('翻译') || lower.includes('translate')) response = DEMO_AI_RESPONSES.translate
        else if (lower.includes('总结') || lower.includes('摘要') || lower.includes('summarize')) response = DEMO_AI_RESPONSES.summarize
        else if (lower.includes('扩写') || lower.includes('expand')) response = DEMO_AI_RESPONSES.expand
        else if (lower.includes('缩写') || lower.includes('shorten')) response = DEMO_AI_RESPONSES.shorten
      }

      const aiMsg: AIMessage = {
        id: String(Date.now() + 1),
        role: 'assistant',
        content: response.content,
        citations: trustedSearch ? response.citations : undefined,
      }
      setMessages((prev) => [...prev, aiMsg])
      setIsAiLoading(false)
    }, 800)
  }

  const handleQuickAction = (action: string) => {
    const prompts: Record<string, string> = {
      continue: '请基于当前上下文继续写作',
      polish: '请润色当前段落，优化语言表达',
      translate: '请将选中内容进行中英文互译',
      expand: '请扩写当前段落，丰富内容',
      shorten: '请缩写当前段落，精简内容',
      search: '请推荐与钙钛矿太阳能电池相关的文献',
      summarize: '请总结当前段落的核心要点',
    }
    handleSendMessage(prompts[action] || action)
  }

  const startTypesetting = () => {
    setIsTypesetting(true)
    setTypesettingProgress(0)
    setTypesetDone(false)
    const interval = setInterval(() => {
      setTypesettingProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval)
          setIsTypesetting(false)
          setTypesetDone(true)
          return 100
        }
        return prev + 10
      })
    }, 300)
  }

  const LeftPanelIcon = LEFT_PANEL_MODES.find((m) => m.value === leftPanelMode)?.icon || FileText
  const RightPanelIcon = RIGHT_PANEL_MODES.find((m) => m.value === rightPanelMode)?.icon || Sparkles

  return (
    <div className="h-[calc(100vh-3rem)] flex bg-slate-50 relative">
      <aside
        className={`bg-white border-r border-slate-200 flex flex-col flex-shrink-0 transition-all duration-300 ${
          leftCollapsed ? 'w-0 opacity-0 overflow-hidden' : 'w-64 opacity-100'
        }`}
      >
        <div className="p-3 border-b border-slate-200 bg-slate-50/50">
          <div className="relative" ref={leftDropdownRef}>
            <button
              onClick={() => setShowLeftDropdown(!showLeftDropdown)}
              className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-left hover:border-indigo-300 transition flex items-center justify-between"
            >
              <div className="flex items-center gap-2">
                <LeftPanelIcon className="w-4 h-4 text-indigo-600" />
                <span className="text-sm font-medium text-slate-700">
                  {LEFT_PANEL_MODES.find((m) => m.value === leftPanelMode)?.label}
                </span>
              </div>
              <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showLeftDropdown ? 'rotate-180' : ''}`} />
            </button>
            {showLeftDropdown && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-30 overflow-hidden">
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
        </div>

        {leftPanelMode === 'projects' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="p-3 border-b border-slate-200">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-slate-800 text-sm flex items-center gap-1.5">
                  <FileText className="w-4 h-4 text-indigo-600" />
                  项目列表
                </h2>
                <button
                  onClick={() => {
                    const name = prompt('项目名称')
                    if (name) {
                      setProjects((prev) => [...prev, { id: String(Date.now()), name, stage: 'topic', litCount: 0 }])
                    }
                  }}
                  className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                  title="新建项目"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {projects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setActiveProjectId(p.id)}
                  className={`w-full text-left px-3 py-2.5 border-b border-slate-100 hover:bg-slate-50 transition ${
                    activeProjectId === p.id ? 'bg-indigo-50/60 border-l-2 border-l-indigo-600' : ''
                  }`}
                >
                  <div className="text-sm font-medium text-slate-700 truncate">{p.name}</div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded font-medium">
                      {STAGES.find((s) => s.value === p.stage)?.label}
                    </span>
                    <span className="text-xs text-slate-400 flex items-center gap-1">
                      <BookOpen className="w-3 h-3" />
                      {p.litCount}篇
                    </span>
                  </div>
                </button>
              ))}
            </div>
            <div className="border-t border-slate-200 p-3 bg-slate-50/50">
              <div className="text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wide flex items-center gap-1.5">
                <AlignLeft className="w-3.5 h-3.5" />
                阶段导航
              </div>
              <div className="space-y-1">
                {STAGES.map((s, idx) => {
                  const cur = activeProject?.stage === s.value
                  const isPast = STAGES.findIndex((st) => st.value === activeProject?.stage) > idx
                  return (
                    <button
                      key={s.value}
                      disabled={!activeProject}
                      onClick={() => handleStageChange(s.value)}
                      className={`w-full text-left px-2.5 py-2 rounded-lg text-xs transition flex items-center gap-2 ${
                        cur
                          ? 'bg-indigo-600 text-white font-medium shadow-sm'
                          : isPast
                          ? 'text-slate-500 hover:bg-slate-200/60 disabled:opacity-40 disabled:cursor-not-allowed'
                          : 'text-slate-400 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed'
                      }`}
                    >
                      <span
                        className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${
                          cur
                            ? 'bg-white/20 text-white'
                            : isPast
                            ? 'bg-green-100 text-green-600'
                            : 'bg-slate-200 text-slate-400'
                        }`}
                      >
                        {idx + 1}
                      </span>
                      {s.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {leftPanelMode === 'outline' && (
          <div className="flex-1 overflow-y-auto p-3">
            <div className="text-xs font-semibold text-slate-500 mb-2 px-1 flex items-center gap-1.5">
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
                  className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-slate-100 transition truncate ${
                    item.level === 1
                      ? 'font-semibold text-slate-700'
                      : item.level === 2
                      ? 'font-medium text-slate-600 pl-4'
                      : item.level === 3
                      ? 'text-slate-500 pl-6'
                      : 'text-slate-400 pl-8'
                  }`}
                >
                  {item.text}
                </button>
              ))}
            </div>
          </div>
        )}

        {leftPanelMode === 'references' && (
          <div className="flex-1 overflow-y-auto p-3">
            <div className="text-xs font-semibold text-slate-500 mb-2 px-1 flex items-center gap-1.5">
              <BookCopy className="w-3.5 h-3.5" />
              文献列表
            </div>
            <div className="space-y-2">
              {DEMO_CITATIONS.map((cit, idx) => (
                <div
                  key={idx}
                  className="p-2.5 bg-slate-50 rounded-lg border border-slate-200 hover:border-indigo-200 hover:bg-indigo-50/30 transition cursor-pointer"
                >
                  <div className="text-xs font-semibold text-slate-700 line-clamp-2 leading-snug">
                    {cit.title}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1 truncate">
                    {cit.authors} ({cit.year})
                  </div>
                  <div className="text-[11px] text-slate-400 truncate mt-0.5">
                    {cit.journal}
                  </div>
                  <a
                    href={`https://doi.org/${cit.doi}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-indigo-600 hover:text-indigo-800 flex items-center gap-1 mt-1.5 font-medium"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <FileCode className="w-3 h-3" />
                    {cit.doi}
                  </a>
                </div>
              ))}
            </div>
          </div>
        )}
      </aside>

      <button
        onClick={() => setLeftCollapsed(!leftCollapsed)}
        className="absolute left-0 top-1/2 -translate-y-1/2 z-20 bg-white border border-slate-200 rounded-r-lg p-1 shadow-md hover:bg-slate-50 transition text-slate-400 hover:text-indigo-600"
        style={{ left: leftCollapsed ? '0' : '256px' }}
        title={leftCollapsed ? '展开左侧栏' : '折叠左侧栏'}
      >
        {leftCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
      </button>

      <section className="flex-1 flex flex-col min-w-0">
        <div className="bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between flex-shrink-0 shadow-sm">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-slate-700">
              {activeProject ? activeProject.name : '未选择项目'}
            </span>
            {activeProject && (
              <>
                <ChevronRight className="w-4 h-4 text-slate-300" />
                <span className="px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded-full text-xs font-medium">
                  {STAGES.find((s) => s.value === activeProject.stage)?.label}
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
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
        </div>

        <div className="flex items-center gap-0.5 px-3 py-1.5 bg-white border-b border-slate-200 flex-shrink-0">
          <button
            onClick={() => insertMarkdown('# ', '', '标题')}
            className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
            title="一级标题"
          >
            <Heading1 className="w-4 h-4" />
          </button>
          <button
            onClick={() => insertMarkdown('## ', '', '标题')}
            className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
            title="二级标题"
          >
            <Heading2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => insertMarkdown('### ', '', '标题')}
            className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
            title="三级标题"
          >
            <Heading3 className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-slate-200 mx-1" />
          <button
            onClick={() => insertMarkdown('**', '**', '粗体文字')}
            className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
            title="加粗"
          >
            <Bold className="w-4 h-4" />
          </button>
          <button
            onClick={() => insertMarkdown('*', '*', '斜体文字')}
            className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
            title="斜体"
          >
            <Italic className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-slate-200 mx-1" />
          <button
            onClick={() => insertMarkdown('- ', '', '列表项')}
            className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
            title="无序列表"
          >
            <List className="w-4 h-4" />
          </button>
          <button
            onClick={() => insertMarkdown('1. ', '', '列表项')}
            className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
            title="有序列表"
          >
            <ListOrdered className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-slate-200 mx-1" />
          <button
            onClick={() => insertMarkdown('> ', '', '引用文字')}
            className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
            title="引用"
          >
            <Quote className="w-4 h-4" />
          </button>
          <button
            onClick={() => insertMarkdown('```\n', '\n```', '代码')}
            className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
            title="代码块"
          >
            <Code className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-slate-200 mx-1" />
          <button
            onClick={insertLink}
            className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
            title="链接"
          >
            <Link className="w-4 h-4" />
          </button>
          <button
            onClick={insertImage}
            className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
            title="图片"
          >
            <Image className="w-4 h-4" />
          </button>
          <TableGridPicker onSelect={insertTableWithSize} />
          <div className="w-px h-4 bg-slate-200 mx-1" />
          <button
            onClick={() => setShowCitationModal(true)}
            className="p-1.5 text-indigo-600 hover:bg-indigo-50 rounded transition flex items-center gap-1"
            title="插入引用 (Ctrl+Shift+K)"
          >
            <BookMarked className="w-4 h-4" />
            <span className="text-xs font-medium">插入引用</span>
          </button>

          <div className="flex-1" />

          <div className="flex items-center gap-1 text-xs text-slate-400">
            <span>左面板:</span>
            <span className="font-medium text-slate-600">
              {LEFT_PANEL_MODES.find((m) => m.value === leftPanelMode)?.label}
            </span>
            <span className="mx-1 text-slate-300">|</span>
            <span>右面板:</span>
            <span className="font-medium text-slate-600">
              {RIGHT_PANEL_MODES.find((m) => m.value === rightPanelMode)?.label}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-white">
          <div className="max-w-3xl mx-auto p-8">
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              onInput={handleEditorInput}
              className="min-h-full outline-none prose prose-slate max-w-none"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          </div>
        </div>

        <div className="px-4 py-1.5 bg-slate-50/80 border-t border-slate-200 flex items-center justify-between text-xs text-slate-400 flex-shrink-0">
          <span>所见即所得 Markdown</span>
          <span className="font-mono">{wordCount} 字</span>
        </div>
      </section>

      <aside className="w-80 flex flex-col border-l border-slate-200 bg-white flex-shrink-0">
        <div className="p-3 border-b border-slate-200 bg-slate-50/50">
          <div className="relative" ref={rightDropdownRef}>
            <button
              onClick={() => setShowRightDropdown(!showRightDropdown)}
              className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-left hover:border-indigo-300 transition flex items-center justify-between"
            >
              <div className="flex items-center gap-2">
                <RightPanelIcon className="w-4 h-4 text-indigo-600" />
                <span className="text-sm font-medium text-slate-700">
                  {RIGHT_PANEL_MODES.find((m) => m.value === rightPanelMode)?.label}
                </span>
              </div>
              <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showRightDropdown ? 'rotate-180' : ''}`} />
            </button>
            {showRightDropdown && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-30 overflow-hidden">
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
              <div className="relative" ref={modelDropdownRef}>
                <div className="text-xs font-medium text-slate-600 mb-1.5">AI 模型</div>
                <button
                  onClick={() => setShowModelDropdown(!showModelDropdown)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-left hover:border-indigo-300 transition flex items-center justify-between"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 bg-indigo-100 rounded-md flex items-center justify-center">
                      <Bot className="w-3.5 h-3.5 text-indigo-600" />
                    </div>
                    <div>
                      <div className="text-xs font-medium text-slate-700">{currentModel.label}</div>
                      <div className="text-[10px] text-slate-400">{currentModel.desc}</div>
                    </div>
                  </div>
                  <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showModelDropdown ? 'rotate-180' : ''}`} />
                </button>
                {showModelDropdown && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-30 overflow-hidden">
                    {AI_MODELS.map((model) => (
                      <button
                        key={model.value}
                        onClick={() => {
                          setSelectedModel(model.value)
                          setShowModelDropdown(false)
                        }}
                        className={`w-full px-3 py-2 text-left hover:bg-slate-50 transition flex items-center gap-2 ${
                          selectedModel === model.value ? 'bg-indigo-50/50' : ''
                        }`}
                      >
                        <div className={`w-6 h-6 rounded-md flex items-center justify-center ${
                          selectedModel === model.value ? 'bg-indigo-600' : 'bg-slate-100'
                        }`}>
                          <Bot className={`w-3.5 h-3.5 ${selectedModel === model.value ? 'text-white' : 'text-slate-500'}`} />
                        </div>
                        <div>
                          <div className={`text-xs font-medium ${selectedModel === model.value ? 'text-indigo-700' : 'text-slate-700'}`}>
                            {model.label}
                          </div>
                          <div className="text-[10px] text-slate-400">{model.desc}</div>
                        </div>
                        {selectedModel === model.value && (
                          <Check className="w-4 h-4 text-indigo-600 ml-auto" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-3">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-medium text-slate-600 flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-amber-500" />
                    可信检索
                  </span>
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
                <p className="text-[10px] text-slate-400 leading-relaxed">
                  开启后 AI 回答必须引用知识库内容，确保回答的学术可信度
                </p>
              </div>

              {trustedSearch && (
                <div className="mt-3" ref={citationScopeRef}>
                  <div className="text-xs font-medium text-slate-600 mb-1.5">引用范围</div>
                  <div className="relative">
                    <button
                      onClick={() => setShowCitationScopeDropdown(!showCitationScopeDropdown)}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-left hover:border-indigo-300 transition flex items-center justify-between"
                    >
                      <span className="text-xs text-slate-700">
                        {CITATION_SCOPES.find((s) => s.value === citationScope)?.label}
                      </span>
                      <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showCitationScopeDropdown ? 'rotate-180' : ''}`} />
                    </button>
                    {showCitationScopeDropdown && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-30 overflow-hidden">
                        {CITATION_SCOPES.map((scope) => (
                          <button
                            key={scope.value}
                            onClick={() => {
                              setCitationScope(scope.value)
                              setShowCitationScopeDropdown(false)
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
                </div>
              )}
            </div>

            <div className="p-2.5 border-b border-slate-100 bg-white">
              <div className="text-[11px] font-medium text-slate-500 mb-2 px-1">快捷指令</div>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_ACTIONS.map((action) => {
                  const Icon = action.icon
                  return (
                    <button
                      key={action.key}
                      onClick={() => handleQuickAction(action.key)}
                      className="px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 text-slate-600 rounded-full hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 transition flex items-center gap-1"
                    >
                      <Icon className="w-3 h-3" />
                      {action.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-3 bg-slate-50/30">
              {messages.length === 0 && (
                <div className="text-center py-10">
                  <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-gradient-to-br from-indigo-50 to-indigo-100 flex items-center justify-center shadow-inner">
                    <Sparkles className="w-7 h-7 text-indigo-400" />
                  </div>
                  <p className="text-sm font-medium text-slate-600">AI 写作助手</p>
                  <p className="text-xs text-slate-400 mt-1">
                    输入问题或点击上方快捷指令
                  </p>
                  {trustedSearch && (
                    <div className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 bg-emerald-50 text-emerald-600 rounded-full text-[10px] font-medium">
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
                        <div
                          className="whitespace-pre-wrap leading-relaxed text-sm"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                        />
                        {msg.citations && msg.citations.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-slate-100">
                            <div className="text-[11px] font-semibold text-slate-500 mb-2 flex items-center gap-1.5">
                              <div className="w-4 h-4 bg-emerald-100 rounded-full flex items-center justify-center">
                                <Quote className="w-2.5 h-2.5 text-emerald-600" />
                              </div>
                              引用来源 · 知识库
                            </div>
                            <div className="space-y-2">
                              {msg.citations.map((cit, idx) => (
                                <div
                                  key={idx}
                                  className="p-2.5 bg-slate-50/80 rounded-lg border border-slate-200 hover:border-indigo-200 hover:bg-indigo-50/30 transition"
                                >
                                  <div className="text-xs font-semibold text-slate-700 line-clamp-2 leading-snug">
                                    {cit.title}
                                  </div>
                                  <div className="text-xs text-slate-500 mt-1.5 truncate">
                                    {cit.authors} ({cit.year})
                                  </div>
                                  <div className="text-xs text-slate-400 truncate mt-0.5">
                                    {cit.journal}
                                  </div>
                                  <a
                                    href={`https://doi.org/${cit.doi}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-[11px] text-indigo-600 hover:text-indigo-800 flex items-center gap-1 mt-1.5 font-medium"
                                  >
                                    <FileCode className="w-3 h-3" />
                                    {cit.doi}
                                    <ExternalLink className="w-3 h-3" />
                                  </a>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    )}
                  </div>
                </div>
              ))}

              {isAiLoading && (
                <div className="flex justify-start">
                  <div className="bg-white rounded-2xl rounded-bl-md px-4 py-3 border border-slate-200 shadow-sm">
                    <div className="flex gap-1.5">
                      <span className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                </div>
              )}

              <div ref={chatEndRef} />
            </div>

            <div className="p-3 border-t border-slate-200 bg-white">
              {trustedSearch && (
                <div className="mb-2 flex items-center gap-1.5 text-[10px] text-emerald-600">
                  <Zap className="w-3 h-3" />
                  <span>可信检索模式 · 回答将引用知识库</span>
                </div>
              )}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleSendMessage()
                    }
                  }}
                  placeholder="询问 AI 助手..."
                  className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-slate-50/50"
                />
                <button
                  onClick={() => handleSendMessage()}
                  disabled={isAiLoading || !inputValue.trim()}
                  className="px-3 py-2 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white rounded-xl text-sm hover:from-indigo-700 hover:to-indigo-800 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
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
                  placeholder="搜索文献..."
                  className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-slate-50/50"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {DEMO_CITATIONS.map((cit, idx) => (
                <div
                  key={idx}
                  className="p-3 bg-white rounded-lg border border-slate-200 hover:border-indigo-200 hover:shadow-sm transition cursor-pointer"
                >
                  <div className="text-sm font-semibold text-slate-700 line-clamp-2 leading-snug">
                    {cit.title}
                  </div>
                  <div className="text-xs text-slate-500 mt-2 flex items-center gap-2">
                    <span className="px-1.5 py-0.5 bg-indigo-50 text-indigo-600 rounded text-[10px] font-medium">
                      {cit.year}
                    </span>
                    <span className="truncate">{cit.journal}</span>
                  </div>
                  <div className="text-xs text-slate-400 mt-1 truncate">
                    {cit.authors}
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <a
                      href={`https://doi.org/${cit.doi}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-indigo-600 hover:text-indigo-800 flex items-center gap-1 font-medium"
                    >
                      <FileCode className="w-3 h-3" />
                      DOI
                      <ExternalLink className="w-3 h-3" />
                    </a>
                    <button
                      onClick={() => insertCitation(cit.doi)}
                      className="text-[11px] px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded hover:bg-indigo-100 transition font-medium"
                    >
                      插入引用
                    </button>
                  </div>
                </div>
              ))}
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
                      <div className="text-[11px] text-slate-500 mt-0.5">{book.author} ({book.year})</div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="text-xs font-semibold text-slate-500 mb-2 px-1 flex items-center gap-1.5">
                <Newspaper className="w-3.5 h-3.5" />
                综述文章
              </div>
              <div className="space-y-2">
                {DEMO_CITATIONS.slice(0, 2).map((cit, idx) => (
                  <div
                    key={idx}
                    className="p-2.5 bg-white rounded-lg border border-slate-200 hover:border-indigo-200 transition cursor-pointer"
                  >
                    <div className="text-xs font-medium text-slate-700 line-clamp-2 leading-snug">
                      {cit.title}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-1">
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
              <p className="text-[11px] text-slate-500 leading-relaxed">
                选择目标期刊，一键转换为对应格式的 LaTeX 模板
              </p>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-4">
              <div>
                <div className="text-xs font-medium text-slate-600 mb-1.5">选择目标期刊</div>
                <div className="relative">
                  <select
                    value={selectedJournal}
                    onChange={(e) => setSelectedJournal(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-white appearance-none pr-8"
                  >
                    {JOURNALS.map((j) => (
                      <option key={j.value} value={j.value}>
                        {j.label} — {j.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-slate-600 mb-1.5">当前格式预览</div>
                <div className="p-3 bg-slate-50 rounded-lg border border-slate-200">
                  <div className="text-center">
                    <div className="text-sm font-bold text-slate-800">{currentJournal.label}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{currentJournal.name}</div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-slate-200 space-y-1.5">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-slate-500">字号</span>
                      <span className="text-slate-700 font-medium">10pt / 12pt</span>
                    </div>
                    <div className="flex justify-between text-[11px]">
                      <span className="text-slate-500">栏数</span>
                      <span className="text-slate-700 font-medium">双栏</span>
                    </div>
                    <div className="flex justify-between text-[11px]">
                      <span className="text-slate-500">参考文献</span>
                      <span className="text-slate-700 font-medium">编号制</span>
                    </div>
                    <div className="flex justify-between text-[11px]">
                      <span className="text-slate-500">图表位置</span>
                      <span className="text-slate-700 font-medium">文末</span>
                    </div>
                  </div>
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
                  <div className="text-[11px] text-slate-500">
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
                      已成功转换为 {currentJournal.label} 格式
                    </p>
                  </div>

                  <div className="p-3 bg-slate-900 rounded-lg overflow-x-auto">
                    <div className="text-[10px] text-slate-400 mb-2 font-mono">LaTeX 预览</div>
                    <pre className="text-[11px] text-slate-300 font-mono leading-relaxed">
{`\\documentclass[10pt]{article}
\\usepackage{achemso}
\\title{钙钛矿太阳能电池的研究进展}
\\author{Author One}
\\affiliation{University}
\\begin{document}
\\begin{abstract}
...
\\end{abstract}
\\section{Introduction}
...
\\end{document}`}
                    </pre>
                  </div>

                  <div className="flex gap-2">
                    <button className="flex-1 py-2 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 transition flex items-center justify-center gap-1.5">
                      <Download className="w-3.5 h-3.5" />
                      下载 .zip
                    </button>
                    <button className="flex-1 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg text-xs font-medium hover:bg-slate-50 transition flex items-center justify-center gap-1.5">
                      <FileCode className="w-3.5 h-3.5" />
                      预览 PDF
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </aside>

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
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  value={citationSearch}
                  onChange={(e) => setCitationSearch(e.target.value)}
                  placeholder="搜索文献标题、作者、期刊或 DOI..."
                  className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                  autoFocus
                />
              </div>
              <div className="mt-2 text-[11px] text-slate-400">
                快捷键：<kbd className="px-1.5 py-0.5 bg-slate-100 rounded text-slate-600 font-mono">Ctrl+Shift+K</kbd>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {filteredCitations.length === 0 && (
                <div className="text-center py-8 text-sm text-slate-400">
                  未找到匹配的文献
                </div>
              )}
              {filteredCitations.map((cit) => {
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
                        <div className="text-[11px] text-indigo-600 mt-1 font-mono">
                          {cit.doi}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
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
    </div>
  )
}
