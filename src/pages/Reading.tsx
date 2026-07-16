import { useState, useEffect, useRef, useCallback } from 'react'
import {
  BookOpen,
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
  Palette,
  X,
  Check,
  ChevronRight,
  Bold,
  Italic,
  List,
  ListOrdered,
  Quote,
  Code,
  Link,
  Eye,
  Edit3,
  Columns,
} from 'lucide-react'

type HighlightColor = 'yellow' | 'green' | 'blue' | 'purple' | 'red'
type SideTab = 'notes' | 'annotations'
type NoteEditorMode = 'edit' | 'preview' | 'split'
type FilterType = 'all' | 'has-md' | 'no-md'

interface Annotation {
  id: string
  paperId: string
  text: string
  color: HighlightColor
  note: string
  createdAt: number
}

interface Paper {
  id: string
  title: string
  authors: string
  journal: string
  year: string
  keywords: string[]
  doi: string
  hasMarkdown: boolean
  markdownContent?: string
}

interface PaperNotes {
  [paperId: string]: string
}

interface SaveState {
  status: 'saved' | 'saving' | 'idle'
  lastSaved: number | null
}

const HIGHLIGHT_COLORS: { value: HighlightColor; label: string; bg: string; border: string; text: string; dot: string }[] = [
  { value: 'yellow', label: '黄色', bg: 'bg-yellow-200/60', border: 'border-l-yellow-400 bg-yellow-50', text: 'text-yellow-700', dot: 'bg-yellow-400' },
  { value: 'green', label: '绿色', bg: 'bg-green-200/60', border: 'border-l-green-400 bg-green-50', text: 'text-green-700', dot: 'bg-green-400' },
  { value: 'blue', label: '蓝色', bg: 'bg-blue-200/60', border: 'border-l-blue-400 bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-400' },
  { value: 'purple', label: '紫色', bg: 'bg-purple-200/60', border: 'border-l-purple-400 bg-purple-50', text: 'text-purple-700', dot: 'bg-purple-400' },
  { value: 'red', label: '红色', bg: 'bg-red-200/60', border: 'border-l-red-400 bg-red-50', text: 'text-red-700', dot: 'bg-red-400' },
]

const DEMO_PAPERS: Paper[] = [
  {
    id: '1',
    title: '钙钛矿太阳能电池的最新进展与挑战',
    authors: 'Zhang Y, Wang L, Chen H',
    journal: 'Nature Energy',
    year: '2024',
    keywords: ['perovskite', 'solar cell', 'photovoltaic', 'efficiency'],
    doi: '10.1038/s41560-024-01234-5',
    hasMarkdown: true,
    markdownContent: `# 钙钛矿太阳能电池的最新进展与挑战

## 摘要

近年来，钙钛矿太阳能电池（Perovskite Solar Cells, PSCs）取得了突破性进展，光电转换效率从2009年的3.8%迅速提升至2024年的26.1%，成为光伏领域最具潜力的下一代技术。

## 1. 引言

钙钛矿材料具有优异的光电性能，包括高吸收系数、长载流子扩散长度和可调节的带隙宽度。这些特性使得钙钛矿太阳能电池在短短十几年内实现了效率的飞跃式增长。

### 1.1 钙钛矿晶体结构

钙钛矿材料的通式为ABX3，其中A位通常为甲脒（FA）、甲胺（MA）或铯（Cs）离子，B位为铅（Pb）离子，X位为卤素离子（I、Br、Cl）。

### 1.2 工作原理

钙钛矿太阳能电池的工作原理包括以下几个步骤：
1. 光子吸收与激子产生
2. 激子解离为自由载流子
3. 载流子输运
4. 载流子收集

## 2. 关键进展

### 2.1 效率突破

单结钙钛矿太阳能电池的效率已经突破26%，接近硅基太阳能电池的理论极限。串联结构的钙钛矿/硅叠层电池效率更是达到了33%以上。

### 2.2 稳定性提升

通过界面工程、组分工程和封装技术，钙钛矿电池的稳定性得到了显著提升。目前，实验室制备的器件在标准测试条件下可稳定工作超过10000小时。

### 2.3 大面积制备

刮涂法、喷涂法和蒸镀法等大面积制备技术的发展，为钙钛矿太阳能电池的产业化奠定了基础。

## 3. 面临的挑战

尽管取得了巨大进展，钙钛矿太阳能电池仍面临诸多挑战：

- **铅毒性问题**：铅基钙钛矿中的铅可能对环境造成危害
- **长期稳定性**：在湿热、紫外光照等条件下的稳定性仍需提升
- **成本控制**：部分关键材料成本较高
- **量产工艺**：大面积、高效率、低成本的量产工艺仍在探索中

## 4. 结论与展望

钙钛矿太阳能电池作为新一代光伏技术，具有广阔的发展前景。随着材料科学和器件工程的不断进步，相信钙钛矿太阳能电池将在未来的能源结构中扮演重要角色。

> "钙钛矿太阳能电池的快速发展为清洁能源的未来带来了新的希望。" — 领域专家评论

## 参考文献

1. Kojima A, et al. Organometal halide perovskites as visible-light sensitizers for photovoltaic cells. JACS, 2009.
2. National Renewable Energy Laboratory. Best Research-Cell Efficiency Chart, 2024.
`,
  },
  {
    id: '2',
    title: 'CO2还原电催化剂的设计策略',
    authors: 'Li M, Zhao J, Liu S',
    journal: 'Journal of the American Chemical Society',
    year: '2023',
    keywords: ['CO2 reduction', 'electrocatalyst', 'single atom', 'copper'],
    doi: '10.1021/jacs.3c04567',
    hasMarkdown: false,
  },
  {
    id: '3',
    title: '金属有机框架衍生纳米材料在电催化中的应用',
    authors: 'Liu X, Zhao Y, Sun M, Wang Q',
    journal: 'Nano Energy',
    year: '2023',
    keywords: ['MOF', 'electrocatalysis', 'nanomaterial', 'energy'],
    doi: '10.1016/j.nanoen.2023.108765',
    hasMarkdown: true,
    markdownContent: `# 金属有机框架衍生纳米材料在电催化中的应用

## 摘要

金属有机框架（MOFs）作为一类新型晶态多孔材料，在电催化领域展现出巨大的应用潜力。本文综述了MOF衍生纳米材料的制备方法及其在氧还原反应、析氢反应和CO2还原反应中的应用进展。

## 1. 引言

电催化是清洁能源转换与存储的核心技术之一。开发高效、稳定、廉价的电催化剂是实现这些技术大规模应用的关键。

## 2. MOF衍生纳米材料的制备

### 2.1 直接热解法

通过在惰性气氛下高温热解MOF前驱体，可以获得掺杂碳材料、金属氧化物或金属/碳复合材料。

### 2.2 模板法

利用MOF的多孔结构作为模板，引入其他活性组分后再进行热解处理。

## 3. 电催化应用

### 3.1 氧还原反应（ORR）

MOF衍生的氮掺杂碳材料在碱性条件下表现出优异的ORR催化性能，部分性能可与商业Pt/C催化剂媲美。

### 3.2 析氢反应（HER）

通过掺杂过渡金属磷化物或硫化物，可以显著提升MOF衍生材料的HER催化活性。

### 3.3 CO2还原反应（CO2RR）

MOF衍生的单原子催化剂在CO2RR中表现出高选择性和高活性，特别是铜单原子催化剂。

## 4. 结论与展望

MOF衍生纳米材料为电催化领域带来了新的机遇，但仍需在材料设计、性能优化和机理研究方面进一步深入。
`,
  },
]

const DEMO_ANNOTATIONS: Annotation[] = [
  {
    id: 'anno1',
    paperId: '1',
    text: '光电转换效率从2009年的3.8%迅速提升至2024年的26.1%',
    color: 'yellow',
    note: '**效率提升惊人！**\n\n仅用15年时间，效率提升了近7倍。这在光伏领域是非常罕见的发展速度。\n\n- 2009年：3.8%\n- 2024年：26.1%\n- 提升幅度：~6.9倍',
    createdAt: Date.now() - 86400000 * 3,
  },
  {
    id: 'anno2',
    paperId: '1',
    text: '钙钛矿材料的通式为ABX3',
    color: 'green',
    note: '晶体结构记忆点：\n\n- A位：FA/MA/Cs\n- B位：Pb\n- X位：I/Br/Cl',
    createdAt: Date.now() - 86400000 * 2,
  },
  {
    id: 'anno3',
    paperId: '1',
    text: '铅毒性问题',
    color: 'red',
    note: '重要研究方向！\n\n无铅钙钛矿是未来的重要研究方向之一。目前主要有：\n1. 锡基钙钛矿\n2. 铋基钙钛矿\n3. 双钙钛矿结构',
    createdAt: Date.now() - 86400000,
  },
]

const DEMO_NOTES: PaperNotes = {
  '1': '# 阅读笔记：钙钛矿太阳能电池\n\n## 核心要点\n\n钙钛矿太阳能电池是下一代光伏技术的有力竞争者，具有高效率、低成本的优势。\n\n## 关键数据\n\n- 效率：26.1%（单结）\n- 稳定性：>10000小时（实验室）\n- 带隙：~1.5 eV\n\n## 待深入研究\n\n1. 界面工程的具体方法\n2. 封装技术的最新进展\n3. 量产成本分析\n\n## 相关文献\n\n- [[10.1038/s41560-024-01234-5]] 本文\n- 待补充...',
  '3': '# 阅读笔记：MOF衍生电催化材料\n\n## 重点\n\nMOF衍生材料在电催化中应用广泛，特别是单原子催化剂。\n\n## 三种主要应用\n\n1. ORR - 氧还原反应\n2. HER - 析氢反应  \n3. CO2RR - CO2还原',
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderMarkdownToHtml(text: string): string {
  let html = text

  const codeBlockRegex = /```([\s\S]*?)```/g
  const codeBlocks: string[] = []
  html = html.replace(codeBlockRegex, (_, code) => {
    codeBlocks.push(code)
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`
  })

  html = html.replace(/^###### (.*)$/gm, '<h6 class="text-sm font-semibold text-slate-700 mt-3 mb-2">$1</h6>')
  html = html.replace(/^##### (.*)$/gm, '<h5 class="text-base font-semibold text-slate-700 mt-3 mb-2">$1</h5>')
  html = html.replace(/^#### (.*)$/gm, '<h4 class="text-lg font-semibold text-slate-800 mt-4 mb-2">$1</h4>')
  html = html.replace(/^### (.*)$/gm, '<h3 class="text-xl font-semibold text-slate-800 mt-5 mb-3">$1</h3>')
  html = html.replace(/^## (.*)$/gm, '<h2 class="text-2xl font-bold text-slate-800 mt-6 mb-3 pb-2 border-b border-slate-200">$1</h2>')
  html = html.replace(/^# (.*)$/gm, '<h1 class="text-3xl font-bold text-slate-900 mt-2 mb-4 pb-3 border-b-2 border-indigo-200">$1</h1>')

  html = html.replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-slate-800">$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em class="italic text-slate-700">$1</em>')
  html = html.replace(/`([^`]+)`/g, '<code class="bg-slate-100 px-1.5 py-0.5 rounded text-sm font-mono text-indigo-600">$1</code>')

  html = html.replace(/^> (.*)$/gm, (_, content) => {
    return `<blockquote class="border-l-4 border-indigo-300 pl-4 py-1 my-2 bg-indigo-50/50 text-slate-600 italic rounded-r">${content}</blockquote>`
  })

  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:text-indigo-800 underline underline-offset-2">${text}</a>`
  })

  const lines = html.split('\n')
  const result: string[] = []
  let inUl = false
  let inOl = false
  let paraBuffer: string[] = []

  const flushPara = () => {
    if (paraBuffer.length > 0) {
      result.push(`<p class="my-2 text-slate-700 leading-relaxed">${paraBuffer.join(' ')}</p>`)
      paraBuffer = []
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed.startsWith('__CODE_BLOCK_')) {
      flushPara()
      if (inUl) { result.push('</ul>'); inUl = false }
      if (inOl) { result.push('</ol>'); inOl = false }
      const idx = parseInt(trimmed.replace('__CODE_BLOCK_', '').replace('__', ''))
      const code = codeBlocks[idx] || ''
      result.push(`<pre class="my-3 p-3 bg-slate-900 text-slate-100 rounded-lg overflow-x-auto text-sm font-mono"><code>${escapeHtml(code.trim())}</code></pre>`)
      continue
    }

    const ulMatch = trimmed.match(/^[-*+] (.*)$/)
    if (ulMatch) {
      flushPara()
      if (inOl) { result.push('</ol>'); inOl = false }
      if (!inUl) { result.push('<ul class="my-2 space-y-1 list-disc list-outside pl-6 text-slate-700">'); inUl = true }
      result.push(`<li>${ulMatch[1]}</li>`)
      continue
    }

    const olMatch = trimmed.match(/^\d+\. (.*)$/)
    if (olMatch) {
      flushPara()
      if (inUl) { result.push('</ul>'); inUl = false }
      if (!inOl) { result.push('<ol class="my-2 space-y-1 list-decimal list-outside pl-6 text-slate-700">'); inOl = true }
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
  if (inUl) result.push('</ul>')
  if (inOl) result.push('</ol>')

  return result.join('\n')
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

function getColorInfo(color: HighlightColor) {
  return HIGHLIGHT_COLORS.find((c) => c.value === color) || HIGHLIGHT_COLORS[0]
}

export default function ReadingPage() {
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>('1')
  const [activeSideTab, setActiveSideTab] = useState<SideTab>('notes')
  const [searchQuery, setSearchQuery] = useState('')
  const [filterType, setFilterType] = useState<FilterType>('all')
  const [fontSize, setFontSize] = useState(16)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [notes, setNotes] = useState<PaperNotes>({})
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)
  const [showToolbar, setShowToolbar] = useState(false)
  const [toolbarPosition, setToolbarPosition] = useState({ top: 0, left: 0 })
  const [selectedText, setSelectedText] = useState('')
  const [newAnnotationText, setNewAnnotationText] = useState('')
  const [showAnnotationInput, setShowAnnotationInput] = useState(false)
  const [pendingColor, setPendingColor] = useState<HighlightColor>('yellow')
  const [noteSaveState, setNoteSaveState] = useState<SaveState>({ status: 'idle', lastSaved: null })
  const [annotationSaveState, setAnnotationSaveState] = useState<SaveState>({ status: 'idle', lastSaved: null })
  const [noteEditorMode, setNoteEditorMode] = useState<NoteEditorMode>('split')
  const [hoverAnnotationId, setHoverAnnotationId] = useState<string | null>(null)

  const readerRef = useRef<HTMLDivElement>(null)
  const annotationInputRef = useRef<HTMLTextAreaElement>(null)
  const noteTextareaRef = useRef<HTMLTextAreaElement>(null)
  const noteSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const annotationSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const savedAnnotations = localStorage.getItem('reading-annotations')
    const savedNotes = localStorage.getItem('reading-notes')

    if (savedAnnotations) {
      setAnnotations(JSON.parse(savedAnnotations))
    } else {
      setAnnotations(DEMO_ANNOTATIONS)
      localStorage.setItem('reading-annotations', JSON.stringify(DEMO_ANNOTATIONS))
    }

    if (savedNotes) {
      setNotes(JSON.parse(savedNotes))
    } else {
      setNotes(DEMO_NOTES)
      localStorage.setItem('reading-notes', JSON.stringify(DEMO_NOTES))
    }
  }, [])

  const saveAnnotationsToStorage = useCallback((newAnnotations: Annotation[]) => {
    if (annotationSaveTimerRef.current) {
      clearTimeout(annotationSaveTimerRef.current)
    }
    setAnnotationSaveState({ status: 'saving', lastSaved: null })
    annotationSaveTimerRef.current = setTimeout(() => {
      localStorage.setItem('reading-annotations', JSON.stringify(newAnnotations))
      setAnnotationSaveState({ status: 'saved', lastSaved: Date.now() })
      setTimeout(() => {
        setAnnotationSaveState((prev) => ({ ...prev, status: 'idle' }))
      }, 2000)
    }, 500)
  }, [])

  const saveNoteToStorage = useCallback((paperId: string, content: string) => {
    if (noteSaveTimerRef.current) {
      clearTimeout(noteSaveTimerRef.current)
    }
    setNoteSaveState({ status: 'saving', lastSaved: null })
    noteSaveTimerRef.current = setTimeout(() => {
      const newNotes = { ...notes, [paperId]: content }
      setNotes(newNotes)
      localStorage.setItem('reading-notes', JSON.stringify(newNotes))
      setNoteSaveState({ status: 'saved', lastSaved: Date.now() })
      setTimeout(() => {
        setNoteSaveState((prev) => ({ ...prev, status: 'idle' }))
      }, 2000)
    }, 800)
  }, [notes])

  const filteredPapers = DEMO_PAPERS.filter((paper) => {
    const matchesFilter =
      filterType === 'all' ||
      (filterType === 'has-md' && paper.hasMarkdown) ||
      (filterType === 'no-md' && !paper.hasMarkdown)

    if (!matchesFilter) return false

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

  const selectedPaper = DEMO_PAPERS.find((p) => p.id === selectedPaperId)
  const paperAnnotations = annotations.filter((a) => a.paperId === selectedPaperId)
  const currentNote = selectedPaperId ? (notes[selectedPaperId] || '') : ''

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

    setSelectedText(text)
    setToolbarPosition({
      top: rect.top - readerRect.top - 45,
      left: rect.left - readerRect.left + rect.width / 2 - 120,
    })
    setShowToolbar(true)
    setShowAnnotationInput(false)
  }, [])

  const handleHighlight = (color: HighlightColor) => {
    if (!selectedPaperId || !selectedText) return
    setPendingColor(color)
    setShowAnnotationInput(true)
    setNewAnnotationText('')
  }

  const confirmAnnotation = () => {
    if (!selectedPaperId || !selectedText) return

    const newAnnotation: Annotation = {
      id: `anno-${Date.now()}`,
      paperId: selectedPaperId,
      text: selectedText,
      color: pendingColor,
      note: newAnnotationText,
      createdAt: Date.now(),
    }

    const newAnnotations = [...annotations, newAnnotation]
    setAnnotations(newAnnotations)
    saveAnnotationsToStorage(newAnnotations)
    setShowToolbar(false)
    setShowAnnotationInput(false)
    setSelectedText('')
    setNewAnnotationText('')
    window.getSelection()?.removeAllRanges()
    setActiveSideTab('annotations')
  }

  const cancelAnnotation = () => {
    setShowAnnotationInput(false)
    setNewAnnotationText('')
  }

  const deleteAnnotation = (id: string) => {
    const newAnnotations = annotations.filter((a) => a.id !== id)
    setAnnotations(newAnnotations)
    saveAnnotationsToStorage(newAnnotations)
    if (selectedAnnotationId === id) {
      setSelectedAnnotationId(null)
    }
  }

  const handleNoteChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!selectedPaperId) return
    const value = e.target.value
    setNotes((prev) => ({ ...prev, [selectedPaperId!]: value }))
    saveNoteToStorage(selectedPaperId, value)
  }

  const insertMarkdown = (prefix: string, suffix: string = '', placeholder: string = '') => {
    if (!noteTextareaRef.current || !selectedPaperId) return
    const textarea = noteTextareaRef.current
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = currentNote.substring(start, end) || placeholder
    const newText = currentNote.substring(0, start) + prefix + selected + suffix + currentNote.substring(end)
    setNotes((prev) => ({ ...prev, [selectedPaperId!]: newText }))
    saveNoteToStorage(selectedPaperId, newText)
    setTimeout(() => {
      textarea.focus()
      textarea.selectionStart = start + prefix.length
      textarea.selectionEnd = start + prefix.length + selected.length
    }, 0)
  }

  const insertLink = () => {
    if (!selectedPaperId) return
    const url = prompt('请输入链接地址：', 'https://')
    if (!url) return
    insertMarkdown('[', `](${url})`, '链接文字')
  }

  const insertCodeBlock = () => {
    if (!noteTextareaRef.current || !selectedPaperId) return
    const textarea = noteTextareaRef.current
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = currentNote.substring(start, end) || '代码'
    const newText = currentNote.substring(0, start) + '```\n' + selected + '\n```' + currentNote.substring(end)
    setNotes((prev) => ({ ...prev, [selectedPaperId!]: newText }))
    saveNoteToStorage(selectedPaperId, newText)
  }

  const exportNote = () => {
    if (!selectedPaper || !currentNote) return
    exportMarkdown(currentNote, `${selectedPaper.title}-笔记.md`)
  }

  const exportAllAnnotations = () => {
    if (!selectedPaper || paperAnnotations.length === 0) return

    let content = `# ${selectedPaper.title} - 批注导出\n\n`
    content += `导出时间：${formatDate(Date.now())}\n\n`
    content += `批注总数：${paperAnnotations.length}\n\n---\n\n`

    paperAnnotations
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .forEach((anno, idx) => {
        content += `## 批注 ${idx + 1}\n\n`
        content += `> ${anno.text}\n\n`
        content += `**颜色**：${getColorInfo(anno.color).label}\n\n`
        content += `**时间**：${formatDate(anno.createdAt)}\n\n`
        content += `**批注内容**：\n\n${anno.note || '（无）'}\n\n---\n\n`
      })

    exportMarkdown(content, `${selectedPaper.title}-全部批注.md`)
  }

  const exportSingleAnnotation = (anno: Annotation) => {
    if (!selectedPaper) return
    const content = `# 批注\n\n**文献**：${selectedPaper.title}\n\n**高亮文字**：\n\n> ${anno.text}\n\n**颜色**：${getColorInfo(anno.color).label}\n\n**时间**：${formatDate(anno.createdAt)}\n\n**批注内容**：\n\n${anno.note || '（无）'}\n`
    exportMarkdown(content, `批注-${anno.text.slice(0, 20)}.md`)
  }

  const scrollToAnnotation = (anno: Annotation) => {
    setSelectedAnnotationId(anno.id)
    if (!readerRef.current) return

    const element = readerRef.current.querySelector(`[data-annotation-id="${anno.id}"]`)
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  useEffect(() => {
    if (!readerRef.current || paperAnnotations.length === 0) return

    const highlightText = (annotation: Annotation) => {
      if (!readerRef.current) return

      const treeWalker = document.createTreeWalker(
        readerRef.current,
        NodeFilter.SHOW_TEXT,
        null
      )

      const textNodes: Text[] = []
      let node: Node | null
      while ((node = treeWalker.nextNode())) {
        textNodes.push(node as Text)
      }

      for (const textNode of textNodes) {
        const text = textNode.textContent || ''
        const index = text.indexOf(annotation.text)

        if (index !== -1) {
          const range = document.createRange()
          range.setStart(textNode, index)
          range.setEnd(textNode, index + annotation.text.length)

          const span = document.createElement('span')
          span.setAttribute('data-annotation-id', annotation.id)
          span.className = `annotation-highlight ${getColorInfo(annotation.color).bg} cursor-pointer rounded-sm transition-colors hover:opacity-80`
          if (selectedAnnotationId === annotation.id) {
            span.classList.add('ring-2', 'ring-indigo-400', 'ring-offset-1')
          }

          try {
            range.surroundContents(span)
          } catch (e) {
            console.warn('Failed to highlight text:', e)
          }
          break
        }
      }
    }

    const spans = readerRef.current.querySelectorAll('.annotation-highlight')
    spans.forEach((span) => {
      const parent = span.parentNode
      if (parent) {
        const text = document.createTextNode(span.textContent || '')
        parent.replaceChild(text, span)
        parent.normalize()
      }
    })

    paperAnnotations.forEach(highlightText)

    const handleClick = (e: Event) => {
      const target = e.target as HTMLElement
      const annotationSpan = target.closest('.annotation-highlight')
      if (annotationSpan) {
        const id = annotationSpan.getAttribute('data-annotation-id')
        if (id) {
          setSelectedAnnotationId(id)
          setActiveSideTab('annotations')
        }
      }
    }

    const handleMouseEnter = (e: Event) => {
      const target = e.target as HTMLElement
      const annotationSpan = target.closest('.annotation-highlight')
      if (annotationSpan) {
        const id = annotationSpan.getAttribute('data-annotation-id')
        if (id) {
          setHoverAnnotationId(id)
        }
      }
    }

    const handleMouseLeave = (e: Event) => {
      const target = e.target as HTMLElement
      const annotationSpan = target.closest('.annotation-highlight')
      if (annotationSpan) {
        setHoverAnnotationId(null)
      }
    }

    readerRef.current.addEventListener('click', handleClick)
    readerRef.current.addEventListener('mouseover', handleMouseEnter)
    readerRef.current.addEventListener('mouseout', handleMouseLeave)

    return () => {
      if (readerRef.current) {
        readerRef.current.removeEventListener('click', handleClick)
        readerRef.current.removeEventListener('mouseover', handleMouseEnter)
        readerRef.current.removeEventListener('mouseout', handleMouseLeave)
      }
    }
  }, [paperAnnotations, selectedAnnotationId])

  const hoverAnnotation = hoverAnnotationId
    ? annotations.find((a) => a.id === hoverAnnotationId)
    : null

  const wordCount = currentNote.replace(/\s/g, '').length

  return (
    <div className="h-[calc(100vh-3rem)] flex bg-slate-50">
      <aside className="w-72 bg-white border-r border-slate-200 flex flex-col flex-shrink-0">
        <div className="p-3 border-b border-slate-200">
          <h2 className="font-semibold text-slate-800 text-sm flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-indigo-600" />
            文献列表
          </h2>
          <div className="mt-2 relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="标题、作者、期刊、年份、关键词、DOI..."
              className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded-md focus:outline-none focus:border-indigo-400"
            />
          </div>
          <div className="mt-2 flex gap-1">
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
              有Markdown
            </button>
            <button
              onClick={() => setFilterType('no-md')}
              className={`px-2 py-1 text-xs rounded transition ${
                filterType === 'no-md'
                  ? 'bg-amber-100 text-amber-700 font-medium'
                  : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              无Markdown
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredPapers.length === 0 ? (
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
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-green-100 text-green-700 rounded text-[10px] font-medium">
                        <FileText className="w-3 h-3" />
                        Markdown
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-[10px]">
                        待转换
                      </span>
                    )}
                    <span className="text-slate-400 text-[10px] truncate">
                      {p.doi}
                    </span>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="flex-1 bg-slate-50 flex flex-col min-w-0">
        {selectedPaper ? (
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
                <span className="text-xs text-slate-400 w-8 text-center">{fontSize}px</span>
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
                  disabled={!currentNote}
                  className="px-2.5 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                  title="导出笔记"
                >
                  <Download className="w-3.5 h-3.5" />
                  导出笔记
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {selectedPaper.hasMarkdown && selectedPaper.markdownContent ? (
                <div className="max-w-3xl mx-auto px-8 py-8">
                  <div
                    className="bg-white rounded-xl shadow-sm border border-slate-200 p-8"
                    style={{ fontSize: `${fontSize}px` }}
                  >
                    <div
                      ref={readerRef}
                      onMouseUp={handleTextSelection}
                      onMouseDown={() => {
                        setShowToolbar(false)
                      }}
                      className="relative prose-reader"
                      dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(selectedPaper.markdownContent) }}
                    />
                    {showToolbar && (
                      <div
                        className="absolute z-50 bg-white rounded-lg shadow-xl border border-slate-200 p-2 flex items-center gap-1"
                        style={{
                          top: toolbarPosition.top,
                          left: toolbarPosition.left + 120,
                          transform: 'translateX(-50%)',
                        }}
                      >
                        {showAnnotationInput ? (
                          <div className="w-72">
                            <div className="text-xs text-slate-500 mb-2 flex items-center gap-2 font-medium">
                              <Palette className="w-3.5 h-3.5" />
                              添加批注
                            </div>
                            <div className="flex gap-1 mb-2">
                              {HIGHLIGHT_COLORS.map((c) => (
                                <button
                                  key={c.value}
                                  onClick={() => setPendingColor(c.value)}
                                  className={`w-6 h-6 rounded-full ${c.bg} border-2 ${
                                    pendingColor === c.value ? 'border-slate-600 scale-110' : 'border-transparent'
                                  } transition`}
                                  title={c.label}
                                />
                              ))}
                            </div>
                            <textarea
                              ref={annotationInputRef}
                              value={newAnnotationText}
                              onChange={(e) => setNewAnnotationText(e.target.value)}
                              placeholder="输入批注内容（支持Markdown）..."
                              className="w-full h-24 p-2 text-xs border border-slate-200 rounded resize-none focus:outline-none focus:border-indigo-400"
                              autoFocus
                            />
                            <div className="flex items-center justify-end mt-2 gap-1">
                              <button
                                onClick={cancelAnnotation}
                                className="px-2.5 py-1 text-xs text-slate-500 hover:bg-slate-100 rounded transition"
                              >
                                取消
                              </button>
                              <button
                                onClick={confirmAnnotation}
                                className="px-2.5 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 transition flex items-center gap-1"
                              >
                                <Check className="w-3.5 h-3.5" />
                                保存
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {HIGHLIGHT_COLORS.map((c) => (
                              <button
                                key={c.value}
                                onClick={() => handleHighlight(c.value)}
                                className={`w-7 h-7 rounded-md ${c.bg} hover:scale-110 transition flex items-center justify-center`}
                                title={`${c.label}高亮`}
                              >
                                <Highlighter className="w-3.5 h-3.5 text-slate-700" />
                              </button>
                            ))}
                            <div className="w-px h-5 bg-slate-200 mx-1" />
                            <button
                              onClick={() => {
                                setPendingColor('yellow')
                                setShowAnnotationInput(true)
                              }}
                              className="px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 rounded transition flex items-center gap-1"
                            >
                              <MessageSquare className="w-3.5 h-3.5" />
                              批注
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
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

      <aside className="w-80 bg-white border-l border-slate-200 flex flex-col flex-shrink-0">
        <div className="flex border-b border-slate-200 flex-shrink-0">
          <button
            onClick={() => setActiveSideTab('notes')}
            className={`flex-1 px-3 py-2.5 text-sm font-medium transition flex items-center justify-center gap-1.5 ${
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
            className={`flex-1 px-3 py-2.5 text-sm font-medium transition flex items-center justify-center gap-1.5 ${
              activeSideTab === 'annotations'
                ? 'text-indigo-600 border-b-2 border-indigo-600 bg-indigo-50/30'
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Highlighter className="w-4 h-4" />
            批注
            {paperAnnotations.length > 0 && (
              <span className="px-1.5 py-0.5 text-[10px] bg-indigo-100 text-indigo-600 rounded-full font-medium">
                {paperAnnotations.length}
              </span>
            )}
          </button>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col">
          {activeSideTab === 'notes' ? (
            <div className="flex-1 flex flex-col">
              <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setNoteEditorMode('edit')}
                    className={`p-1.5 rounded transition ${
                      noteEditorMode === 'edit'
                        ? 'bg-indigo-100 text-indigo-600'
                        : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                    }`}
                    title="编辑模式"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setNoteEditorMode('split')}
                    className={`p-1.5 rounded transition ${
                      noteEditorMode === 'split'
                        ? 'bg-indigo-100 text-indigo-600'
                        : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                    }`}
                    title="分屏模式"
                  >
                    <Columns className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setNoteEditorMode('preview')}
                    className={`p-1.5 rounded transition ${
                      noteEditorMode === 'preview'
                        ? 'bg-indigo-100 text-indigo-600'
                        : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                    }`}
                    title="预览模式"
                  >
                    <Eye className="w-3.5 h-3.5" />
                  </button>
                </div>
                <button
                  onClick={exportNote}
                  disabled={!selectedPaper || !currentNote}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 rounded transition disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                >
                  <Download className="w-3.5 h-3.5" />
                  导出
                </button>
              </div>

              {noteEditorMode !== 'preview' && (
                <div className="px-3 py-1.5 border-b border-slate-100 flex items-center gap-0.5 flex-shrink-0 bg-slate-50/50">
                  <button
                    onClick={() => insertMarkdown('**', '**', '粗体文字')}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                    title="加粗"
                    disabled={!selectedPaper}
                  >
                    <Bold className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => insertMarkdown('*', '*', '斜体文字')}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                    title="斜体"
                    disabled={!selectedPaper}
                  >
                    <Italic className="w-3.5 h-3.5" />
                  </button>
                  <div className="w-px h-4 bg-slate-200 mx-0.5" />
                  <button
                    onClick={() => insertMarkdown('- ', '', '列表项')}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                    title="无序列表"
                    disabled={!selectedPaper}
                  >
                    <List className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => insertMarkdown('1. ', '', '列表项')}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                    title="有序列表"
                    disabled={!selectedPaper}
                  >
                    <ListOrdered className="w-3.5 h-3.5" />
                  </button>
                  <div className="w-px h-4 bg-slate-200 mx-0.5" />
                  <button
                    onClick={() => insertMarkdown('> ', '', '引用文字')}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                    title="引用"
                    disabled={!selectedPaper}
                  >
                    <Quote className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={insertCodeBlock}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                    title="代码块"
                    disabled={!selectedPaper}
                  >
                    <Code className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={insertLink}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition"
                    title="链接"
                    disabled={!selectedPaper}
                  >
                    <Link className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              <div className="flex-1 overflow-hidden">
                {noteEditorMode === 'edit' ? (
                  <textarea
                    ref={noteTextareaRef}
                    value={currentNote}
                    onChange={handleNoteChange}
                    placeholder={selectedPaper ? '在此记录阅读笔记...\n\n支持 Markdown 格式' : '选择文献后开始记笔记'}
                    disabled={!selectedPaper}
                    className="w-full h-full p-3 text-sm border-0 resize-none focus:outline-none disabled:bg-slate-50 font-mono leading-relaxed text-slate-700"
                  />
                ) : noteEditorMode === 'preview' ? (
                  <div className="h-full overflow-y-auto p-3">
                    {currentNote ? (
                      <div
                        className="prose-sm max-w-none"
                        dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(currentNote) }}
                      />
                    ) : (
                      <div className="text-center text-slate-400 py-8">
                        <StickyNote className="w-8 h-8 mx-auto mb-2 opacity-30" />
                        <p className="text-sm">{selectedPaper ? '暂无笔记' : '选择文献后开始记笔记'}</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="h-full flex">
                    <div className="flex-1 border-r border-slate-200">
                      <textarea
                        ref={noteTextareaRef}
                        value={currentNote}
                        onChange={handleNoteChange}
                        placeholder={selectedPaper ? '在此记录阅读笔记...' : '选择文献后开始记笔记'}
                        disabled={!selectedPaper}
                        className="w-full h-full p-3 text-xs border-0 resize-none focus:outline-none disabled:bg-slate-50 font-mono leading-relaxed text-slate-700"
                      />
                    </div>
                    <div className="flex-1 overflow-y-auto">
                      <div className="p-3">
                        {currentNote ? (
                          <div
                            className="prose-sm max-w-none text-xs"
                            dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(currentNote) }}
                          />
                        ) : (
                          <div className="text-center text-slate-400 py-8">
                            <Eye className="w-8 h-8 mx-auto mb-2 opacity-30" />
                            <p className="text-xs">预览区域</p>
                          </div>
                        )}
                      </div>
                    </div>
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
              <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
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

              <div className="flex-1 overflow-y-auto">
                {paperAnnotations.length === 0 ? (
                  <div className="text-center py-12 text-slate-400 text-sm">
                    <MessageSquare className="w-10 h-10 mx-auto mb-2 opacity-30" />
                    <p>暂无批注</p>
                    <p className="text-xs mt-1">选中文字后可添加高亮和批注</p>
                  </div>
                ) : (
                  <div className="p-2 space-y-2">
                    {paperAnnotations
                      .slice()
                      .sort((a, b) => b.createdAt - a.createdAt)
                      .map((anno) => {
                        const colorInfo = getColorInfo(anno.color)
                        return (
                          <div
                            key={anno.id}
                            onClick={() => scrollToAnnotation(anno)}
                            className={`p-3 rounded-lg border-l-4 cursor-pointer transition-all hover:shadow-md ${
                              colorInfo.border
                            } ${
                              selectedAnnotationId === anno.id
                                ? 'ring-2 ring-indigo-300 shadow-md'
                                : ''
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <div className="flex items-center gap-2">
                                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${colorInfo.dot}`} />
                                <span className={`text-xs font-medium ${colorInfo.text}`}>
                                  {colorInfo.label}批注
                                </span>
                              </div>
                              <div className="flex items-center gap-0.5">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    exportSingleAnnotation(anno)
                                  }}
                                  className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-white/60 rounded transition"
                                  title="导出此批注"
                                >
                                  <Download className="w-3 h-3" />
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
                            <div className="text-sm text-slate-600 bg-white/70 rounded px-2.5 py-2 border border-slate-200/50 italic line-clamp-2 mb-2">
                              "{anno.text}"
                            </div>
                            {anno.note && (
                              <div className="text-sm text-slate-700">
                                <div
                                  className="prose-sm max-w-none"
                                  dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(anno.note) }}
                                />
                              </div>
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

      {hoverAnnotation && (
        <div className="fixed z-50 bg-white rounded-lg shadow-xl border border-slate-200 p-3 max-w-xs">
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-2.5 h-2.5 rounded-full ${getColorInfo(hoverAnnotation.color).dot}`} />
            <span className="text-xs font-medium text-slate-600">
              {getColorInfo(hoverAnnotation.color).label}批注
            </span>
          </div>
          <div className="text-xs text-slate-500 border-l-2 border-slate-200 pl-2 italic line-clamp-2 mb-2 bg-slate-50 py-1 rounded-r">
            "{hoverAnnotation.text}"
          </div>
          {hoverAnnotation.note && (
            <div
              className="text-sm text-slate-700 max-h-32 overflow-y-auto"
              dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(hoverAnnotation.note) }}
            />
          )}
        </div>
      )}
    </div>
  )
}
