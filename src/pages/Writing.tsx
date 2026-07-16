import { useState, useCallback, useRef, useEffect } from 'react'
import {
  PenTool,
  Sparkles,
  Plus,
  Send,
  Eye,
  Edit3,
  Columns,
  Save,
  BookOpen,
  Quote,
  Wand2,
  Languages,
  Search,
  FileCode,
  ExternalLink,
  CheckCircle2,
  Clock,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Settings,
  Download,
  Bold,
  Italic,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Code,
  Link,
  Image,
  Table,
  AlignLeft,
  BarChart3,
  FileText,
  Library,
  BookMarked,
  ToggleLeft,
  ToggleRight,
  Bot,
  Zap,
} from 'lucide-react'

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

const KNOWLEDGE_SCOPES = [
  { value: 'all', label: '全部文献', icon: Library },
  { value: 'project', label: '当前项目关联', icon: BookMarked },
  { value: 'books', label: '仅图书', icon: BookOpen },
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

type EditorMode = 'edit' | 'split' | 'preview'

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
  figure: {
    content: '**图表描述建议：**\n\n基于你文中的性能对比表格，我建议为其撰写如下图表描述：\n\n> **表 1 不同光伏材料体系的性能对比**\n> \n> 表 1 对比了四种主流光伏技术的关键性能指标。可以看出，单晶硅电池以 26.7% 的效率和超过 25000 小时的稳定性占据主导地位，但其成本相对较高。钙钛矿电池以 26.1% 的效率紧随其后，且成本仅为单晶硅的一半左右，展现出巨大的商业化潜力。然而，钙钛矿电池的稳定性仍需进一步提升。碲化镉和 CIGS 薄膜电池在效率和成本方面处于中间位置，适合特定应用场景。\n\n**撰写要点：**\n- 先概述表格内容，再突出关键发现\n- 对比分析不同技术的优劣势\n- 重点强调钙钛矿的潜力与挑战\n- 引用相关文献支撑观点[[10.1038/s41560-024-01234-5]]',
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

function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function WritingPage() {
  const [projects, setProjects] = useState<Project[]>(DEMO_PROJECTS)
  const [activeProjectId, setActiveProjectId] = useState<string | null>('1')
  const [mdContent, setMdContent] = useState(DEMO_MD)
  const [editorMode, setEditorMode] = useState<EditorMode>('split')
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved')
  const [lastSaved, setLastSaved] = useState<number | null>(null)
  const [messages, setMessages] = useState<AIMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isAiLoading, setIsAiLoading] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [selectedModel, setSelectedModel] = useState(AI_MODELS[0].value)
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const [trustedSearch, setTrustedSearch] = useState(true)
  const [knowledgeScope, setKnowledgeScope] = useState('all')
  const [showSettings, setShowSettings] = useState(false)

  const chatEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const modelDropdownRef = useRef<HTMLDivElement>(null)

  const activeProject = projects.find((p) => p.id === activeProjectId)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
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
        else if (prompt.includes('figure') || prompt.includes('图表') || prompt.includes('figure_desc')) response = DEMO_AI_RESPONSES.figure
      } else {
        const lower = text.toLowerCase()
        if (lower.includes('继续') || lower.includes('续写')) response = DEMO_AI_RESPONSES.continue
        else if (lower.includes('润色') || lower.includes('优化') || lower.includes('polish')) response = DEMO_AI_RESPONSES.polish
        else if (lower.includes('翻译') || lower.includes('translate')) response = DEMO_AI_RESPONSES.translate
        else if (lower.includes('总结') || lower.includes('摘要') || lower.includes('summarize')) response = DEMO_AI_RESPONSES.summarize
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
      search: '请推荐与钙钛矿太阳能电池相关的文献',
      summarize: '请总结当前段落的核心要点',
      figure_desc: '请为图/表生成专业的描述文字',
    }
    handleSendMessage(prompts[action] || action)
  }

  const insertMarkdown = (prefix: string, suffix: string = '', placeholder: string = '') => {
    if (!textareaRef.current) return
    const textarea = textareaRef.current
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = mdContent.substring(start, end) || placeholder
    const newText = mdContent.substring(0, start) + prefix + selected + suffix + mdContent.substring(end)
    setMdContent(newText)
    setSaveStatus('unsaved')
    setTimeout(() => {
      textarea.focus()
      textarea.selectionStart = start + prefix.length
      textarea.selectionEnd = start + prefix.length + selected.length
    }, 0)
  }

  const insertTable = () => {
    const tableTemplate = `\n| 列1 | 列2 | 列3 |\n|-----|-----|-----|\n| 内容 | 内容 | 内容 |\n| 内容 | 内容 | 内容 |\n`
    insertMarkdown(tableTemplate, '', '')
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

  const renderedHtml = renderMarkdown(mdContent)
  const wordCount = mdContent.replace(/\s/g, '').length
  const currentModel = AI_MODELS.find((m) => m.value === selectedModel) || AI_MODELS[0]

  return (
    <div className="h-[calc(100vh-3rem)] flex bg-slate-50">
      <aside
        className={`bg-white border-r border-slate-200 flex flex-col flex-shrink-0 transition-all duration-300 ${
          sidebarCollapsed ? 'w-0 opacity-0 overflow-hidden' : 'w-60 opacity-100'
        }`}
      >
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
      </aside>

      <button
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        className="absolute left-0 top-1/2 -translate-y-1/2 z-20 bg-white border border-slate-200 rounded-r-lg p-1 shadow-md hover:bg-slate-50 transition text-slate-400 hover:text-indigo-600"
        style={{ left: sidebarCollapsed ? '0' : '240px' }}
        title={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
      >
        {sidebarCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
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

          <div className="flex items-center gap-1 bg-slate-100 rounded-lg p-0.5">
            <button
              onClick={() => setEditorMode('edit')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition flex items-center gap-1.5 ${
                editorMode === 'edit'
                  ? 'bg-white text-slate-700 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
              title="仅编辑"
            >
              <Edit3 className="w-3.5 h-3.5" />
              编辑
            </button>
            <button
              onClick={() => setEditorMode('split')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition flex items-center gap-1.5 ${
                editorMode === 'split'
                  ? 'bg-white text-slate-700 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
              title="分屏预览"
            >
              <Columns className="w-3.5 h-3.5" />
              分屏
            </button>
            <button
              onClick={() => setEditorMode('preview')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition flex items-center gap-1.5 ${
                editorMode === 'preview'
                  ? 'bg-white text-slate-700 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
              title="仅预览"
            >
              <Eye className="w-3.5 h-3.5" />
              预览
            </button>
          </div>

          <div className="flex items-center gap-3">
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

        <div className="flex-1 flex overflow-hidden">
          <div
            className={`flex flex-col bg-white border-r border-slate-200 ${
              editorMode === 'preview' ? 'hidden' : 'flex-1 min-w-0'
            }`}
          >
            <div className="flex items-center gap-0.5 px-3 py-1.5 bg-slate-50/80 border-b border-slate-200">
              <button
                onClick={() => insertMarkdown('# ', '', '标题')}
                className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                title="一级标题"
              >
                <Heading1 className="w-4 h-4" />
              </button>
              <button
                onClick={() => insertMarkdown('## ', '', '标题')}
                className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                title="二级标题"
              >
                <Heading2 className="w-4 h-4" />
              </button>
              <button
                onClick={() => insertMarkdown('### ', '', '标题')}
                className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                title="三级标题"
              >
                <Heading3 className="w-4 h-4" />
              </button>
              <div className="w-px h-4 bg-slate-200 mx-1" />
              <button
                onClick={() => insertMarkdown('**', '**', '粗体文字')}
                className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                title="加粗"
              >
                <Bold className="w-4 h-4" />
              </button>
              <button
                onClick={() => insertMarkdown('*', '*', '斜体文字')}
                className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                title="斜体"
              >
                <Italic className="w-4 h-4" />
              </button>
              <div className="w-px h-4 bg-slate-200 mx-1" />
              <button
                onClick={() => insertMarkdown('- ', '', '列表项')}
                className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                title="无序列表"
              >
                <List className="w-4 h-4" />
              </button>
              <button
                onClick={() => insertMarkdown('1. ', '', '列表项')}
                className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                title="有序列表"
              >
                <ListOrdered className="w-4 h-4" />
              </button>
              <div className="w-px h-4 bg-slate-200 mx-1" />
              <button
                onClick={() => insertMarkdown('> ', '', '引用文字')}
                className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                title="引用"
              >
                <Quote className="w-4 h-4" />
              </button>
              <button
                onClick={() => insertMarkdown('```\n', '\n```', '代码')}
                className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                title="代码块"
              >
                <Code className="w-4 h-4" />
              </button>
              <div className="w-px h-4 bg-slate-200 mx-1" />
              <button
                onClick={insertLink}
                className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                title="链接"
              >
                <Link className="w-4 h-4" />
              </button>
              <button
                onClick={insertImage}
                className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                title="图片"
              >
                <Image className="w-4 h-4" />
              </button>
              <button
                onClick={insertTable}
                className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                title="表格"
              >
                <Table className="w-4 h-4" />
              </button>
            </div>
            <textarea
              ref={textareaRef}
              value={mdContent}
              onChange={(e) => handleMdChange(e.target.value)}
              className="flex-1 w-full p-4 font-mono text-sm text-slate-800 bg-white resize-none focus:outline-none leading-relaxed"
              spellCheck={false}
              placeholder="在此撰写 Markdown 格式的论文..."
            />
            <div className="px-3 py-1.5 bg-slate-50/80 border-t border-slate-200 flex items-center justify-between text-xs text-slate-400">
              <span>Markdown</span>
              <span className="font-mono">{wordCount} 字</span>
            </div>
          </div>

          <div
            className={`flex flex-col bg-white ${
              editorMode === 'edit' ? 'hidden' : 'flex-1 min-w-0'
            }`}
          >
            <div className="px-3 py-1.5 bg-slate-50/80 border-b border-slate-200 flex items-center justify-between">
              <span className="text-xs text-slate-500 font-medium flex items-center gap-1.5">
                <Eye className="w-4 h-4" />
                实时预览
              </span>
            </div>
            <div
              className="flex-1 overflow-auto p-8"
            >
              <div
                className="max-w-3xl mx-auto bg-white"
                dangerouslySetInnerHTML={{ __html: renderedHtml }}
              />
            </div>
          </div>

          <div className="w-80 flex flex-col border-l border-slate-200 bg-white flex-shrink-0">
            <div className="px-3 py-2.5 border-b border-slate-200 bg-gradient-to-r from-indigo-50/50 to-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 bg-gradient-to-br from-indigo-500 to-indigo-600 rounded-lg flex items-center justify-center shadow-sm">
                  <Sparkles className="w-4 h-4 text-white" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-slate-700">AI 写作助手</div>
                  <div className="text-[10px] text-slate-400">可信检索双引擎</div>
                </div>
              </div>
              <button
                onClick={() => setShowSettings(!showSettings)}
                className={`p-1.5 rounded-lg transition ${
                  showSettings ? 'bg-indigo-100 text-indigo-600' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                }`}
                title="设置"
              >
                <Settings className="w-4 h-4" />
              </button>
            </div>

            {showSettings && (
              <div className="p-3 border-b border-slate-100 bg-slate-50/50 space-y-3">
                <div className="relative" ref={modelDropdownRef}>
                  <div className="text-xs font-medium text-slate-600 mb-1.5">AI 模型</div>
                  <button
                    onClick={() => setShowModelDropdown(!showModelDropdown)}
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-left hover:border-indigo-300 transition flex items-center justify-between"
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
                            selectedModel === model.value ? 'bg-indigo-600' : 'bg-s-slate-100'
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
                            <CheckCircle2 className="w-4 h-4 text-indigo-600 ml-auto" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div>
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

                <div>
                  <div className="text-xs font-medium text-slate-600 mb-1.5">知识库范围</div>
                  <div className="grid grid-cols-3 gap-1">
                    {KNOWLEDGE_SCOPES.map((scope) => {
                      const Icon = scope.icon
                      const active = knowledgeScope === scope.value
                      return (
                        <button
                          key={scope.value}
                          onClick={() => setKnowledgeScope(scope.value)}
                          disabled={!trustedSearch}
                          className={`px-2 py-2 rounded-lg text-[10px] font-medium transition flex flex-col items-center gap-1 ${
                            active
                              ? 'bg-indigo-600 text-white shadow-sm'
                              : trustedSearch
                              ? 'bg-white border border-slate-200 text-slate-600 hover:border-indigo-300'
                              : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                          }`}
                        >
                          <Icon className="w-4 h-4" />
                          {scope.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}

            <div className="p-2.5 border-b border-slate-100 bg-white">
              <div className="text-[11px] font-medium text-slate-500 mb-2 px-1">快捷指令</div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => handleQuickAction('continue')}
                  className="px-2.5 py-1.5 text-xs bg-slate-50 border border-s-slate-200 text-slate-600 rounded-full hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 transition flex items-center gap-1"
                >
                  <PenTool className="w-3 h-3" />
                  继续写作
                </button>
                <button
                  onClick={() => handleQuickAction('polish')}
                  className="px-2.5 py-1.5 text-xs bg-slate-50 border border-s-slate-200 text-slate-600 rounded-full hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 transition flex items-center gap-1"
                >
                  <Wand2 className="w-3 h-3" />
                  润色
                </button>
                <button
                  onClick={() => handleQuickAction('translate')}
                  className="px-2.5 py-1.5 text-xs bg-slate-50 border border-s-slate-200 text-slate-600 rounded-full hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 transition flex items-center gap-1"
                >
                  <Languages className="w-3 h-3" />
                  翻译
                </button>
                <button
                  onClick={() => handleQuickAction('search')}
                  className="px-2.5 py-1.5 text-xs bg-slate-50 border border-s-slate-200 text-slate-600 rounded-full hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 transition flex items-center gap-1"
                >
                  <Search className="w-3 h-3" />
                  找文献
                </button>
                <button
                  onClick={() => handleQuickAction('summarize')}
                  className="px-2.5 py-1.5 text-xs bg-slate-50 border border-s-slate-200 text-slate-600 rounded-full hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 transition flex items-center gap-1"
                >
                  <FileText className="w-3 h-3" />
                  总结段落
                </button>
                <button
                  onClick={() => handleQuickAction('figure_desc')}
                  className="px-2.5 py-1.5 text-xs bg-slate-50 border border-s-slate-200 text-slate-600 rounded-full hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 transition flex items-center gap-1"
                >
                  <BarChart3 className="w-3 h-3" />
                  图表描述
                </button>
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
                        : 'bg-white text-slate-700 rounded-bl-md border border-s-slate-200 shadow-sm'
                    }`}
                  >
                    {msg.role === 'assistant' ? (
                      <div className="space-y-2">
                        <div
                          className="whitespace-pre-wrap leading-relaxed text-sm"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                        />
                        {msg.citations && msg.citations.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-s-slate-100">
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
                                  className="p-2.5 bg-slate-50/80 rounded-lg border border-s-slate-200 hover:border-indigo-200 hover:bg-indigo-50/30 transition"
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
        </div>
      </section>
    </div>
  )
}
