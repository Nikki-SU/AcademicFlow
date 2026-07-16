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
} from 'lucide-react'

type HighlightColor = 'yellow' | 'green' | 'blue' | 'purple' | 'red'

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

const HIGHLIGHT_COLORS: { value: HighlightColor; label: string; bg: string; border: string; text: string }[] = [
  { value: 'yellow', label: '黄色', bg: 'bg-yellow-200', border: 'border-yellow-400', text: 'text-yellow-700' },
  { value: 'green', label: '绿色', bg: 'bg-green-200', border: 'border-green-400', text: 'text-green-700' },
  { value: 'blue', label: '蓝色', bg: 'bg-blue-200', border: 'border-blue-400', text: 'text-blue-700' },
  { value: 'purple', label: '紫色', bg: 'bg-purple-200', border: 'border-purple-400', text: 'text-purple-700' },
  { value: 'red', label: '红色', bg: 'bg-red-200', border: 'border-red-400', text: 'text-red-700' },
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
}

function getHighlightClass(color: HighlightColor): string {
  const colorMap: Record<HighlightColor, string> = {
    yellow: 'bg-yellow-200/60',
    green: 'bg-green-200/60',
    blue: 'bg-blue-200/60',
    purple: 'bg-purple-200/60',
    red: 'bg-red-200/60',
  }
  return colorMap[color]
}

function getBorderClass(color: HighlightColor): string {
  const colorMap: Record<HighlightColor, string> = {
    yellow: 'border-l-yellow-400 bg-yellow-50',
    green: 'border-l-green-400 bg-green-50',
    blue: 'border-l-blue-400 bg-blue-50',
    purple: 'border-l-purple-400 bg-purple-50',
    red: 'border-l-red-400 bg-red-50',
  }
  return colorMap[color]
}

function getDotClass(color: HighlightColor): string {
  const colorMap: Record<HighlightColor, string> = {
    yellow: 'bg-yellow-400',
    green: 'bg-green-400',
    blue: 'bg-blue-400',
    purple: 'bg-purple-400',
    red: 'bg-red-400',
  }
  return colorMap[color]
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
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

function renderSimpleMarkdown(text: string): React.ReactNode {
  const lines = text.split('\n')
  const elements: React.ReactNode[] = []
  let inList = false
  let inQuote = false

  lines.forEach((line, index) => {
    if (line.startsWith('# ')) {
      inList = false
      inQuote = false
      elements.push(
        <h1 key={index} className="text-2xl font-bold text-slate-800 mb-4 mt-6 first:mt-0">
          {line.slice(2)}
        </h1>
      )
    } else if (line.startsWith('## ')) {
      inList = false
      inQuote = false
      elements.push(
        <h2 key={index} className="text-xl font-bold text-slate-800 mb-3 mt-5">
          {line.slice(3)}
        </h2>
      )
    } else if (line.startsWith('### ')) {
      inList = false
      inQuote = false
      elements.push(
        <h3 key={index} className="text-lg font-semibold text-slate-700 mb-2 mt-4">
          {line.slice(4)}
        </h3>
      )
    } else if (line.startsWith('> ')) {
      if (!inQuote) {
        inQuote = true
        inList = false
      }
      elements.push(
        <blockquote key={index} className="border-l-4 border-indigo-300 pl-4 py-1 text-slate-600 italic my-2 bg-indigo-50/50">
          {line.slice(2)}
        </blockquote>
      )
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      if (!inList) {
        inList = true
        inQuote = false
      }
      elements.push(
        <li key={index} className="ml-4 text-slate-700 leading-relaxed list-disc">
          {renderInlineMarkdown(line.slice(2))}
        </li>
      )
    } else if (/^\d+\.\s/.test(line)) {
      if (!inList) {
        inList = true
        inQuote = false
      }
      elements.push(
        <li key={index} className="ml-4 text-slate-700 leading-relaxed list-decimal">
          {renderInlineMarkdown(line.replace(/^\d+\.\s/, ''))}
        </li>
      )
    } else if (line.trim() === '') {
      inList = false
      inQuote = false
      elements.push(<div key={index} className="h-2" />)
    } else {
      inList = false
      inQuote = false
      elements.push(
        <p key={index} className="text-slate-700 leading-relaxed mb-2">
          {renderInlineMarkdown(line)}
        </p>
      )
    }
  })

  return elements
}

function renderInlineMarkdown(text: string): React.ReactNode {
  const parts: React.ReactNode[] = []
  let remaining = text
  let key = 0

  const boldRegex = /\*\*(.+?)\*\*/
  const italicRegex = /\*(.+?)\*/
  const codeRegex = /`(.+?)`/

  while (remaining.length > 0) {
    const boldMatch = remaining.match(boldRegex)
    const italicMatch = remaining.match(italicRegex)
    const codeMatch = remaining.match(codeRegex)

    let earliestMatch: RegExpMatchArray | null = null
    let earliestIndex = Infinity
    let matchType = ''

    if (boldMatch && boldMatch.index !== undefined && boldMatch.index < earliestIndex) {
      earliestMatch = boldMatch
      earliestIndex = boldMatch.index
      matchType = 'bold'
    }
    if (italicMatch && italicMatch.index !== undefined && italicMatch.index < earliestIndex) {
      earliestMatch = italicMatch
      earliestIndex = italicMatch.index
      matchType = 'italic'
    }
    if (codeMatch && codeMatch.index !== undefined && codeMatch.index < earliestIndex) {
      earliestMatch = codeMatch
      earliestIndex = codeMatch.index
      matchType = 'code'
    }

    if (!earliestMatch || earliestIndex === Infinity) {
      parts.push(<span key={key++}>{remaining}</span>)
      break
    }

    if (earliestIndex > 0) {
      parts.push(<span key={key++}>{remaining.slice(0, earliestIndex)}</span>)
    }

    if (matchType === 'bold') {
      parts.push(<strong key={key++} className="font-bold">{earliestMatch[1]}</strong>)
    } else if (matchType === 'italic') {
      parts.push(<em key={key++} className="italic">{earliestMatch[1]}</em>)
    } else if (matchType === 'code') {
      parts.push(
        <code key={key++} className="bg-slate-100 px-1.5 py-0.5 rounded text-sm font-mono text-indigo-600">
          {earliestMatch[1]}
        </code>
      )
    }

    remaining = remaining.slice(earliestIndex + earliestMatch[0].length)
  }

  return parts
}

export default function ReadingPage() {
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>('1')
  const [activeSideTab, setActiveSideTab] = useState<'notes' | 'annotations'>('notes')
  const [searchQuery, setSearchQuery] = useState('')
  const [filterType, setFilterType] = useState<'all' | 'has-md' | 'no-md'>('all')
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
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | null>(null)
  const [hoverAnnotation, setHoverAnnotation] = useState<Annotation | null>(null)

  const readerRef = useRef<HTMLDivElement>(null)
  const annotationInputRef = useRef<HTMLTextAreaElement>(null)

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

  const saveAnnotations = useCallback((newAnnotations: Annotation[]) => {
    setAnnotations(newAnnotations)
    localStorage.setItem('reading-annotations', JSON.stringify(newAnnotations))
  }, [])

  const saveNotes = useCallback((paperId: string, content: string) => {
    const newNotes = { ...notes, [paperId]: content }
    setNotes(newNotes)
    localStorage.setItem('reading-notes', JSON.stringify(newNotes))
    setSaveStatus('saving')
    setTimeout(() => setSaveStatus('saved'), 500)
    setTimeout(() => setSaveStatus(null), 2000)
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

    saveAnnotations([...annotations, newAnnotation])
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
    saveAnnotations(annotations.filter((a) => a.id !== id))
    if (selectedAnnotationId === id) {
      setSelectedAnnotationId(null)
    }
  }

  const handleNoteChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!selectedPaperId) return
    saveNotes(selectedPaperId, e.target.value)
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

    paperAnnotations.forEach((anno, idx) => {
      content += `## 批注 ${idx + 1}\n\n`
      content += `> ${anno.text}\n\n`
      content += `**颜色**：${HIGHLIGHT_COLORS.find((c) => c.value === anno.color)?.label}\n\n`
      content += `**时间**：${formatDate(anno.createdAt)}\n\n`
      content += `**批注内容**：\n\n${anno.note}\n\n---\n\n`
    })

    exportMarkdown(content, `${selectedPaper.title}-全部批注.md`)
  }

  const exportSingleAnnotation = (anno: Annotation) => {
    if (!selectedPaper) return
    const content = `# 批注\n\n**文献**：${selectedPaper.title}\n\n**高亮文字**：\n\n> ${anno.text}\n\n**颜色**：${HIGHLIGHT_COLORS.find((c) => c.value === anno.color)?.label}\n\n**时间**：${formatDate(anno.createdAt)}\n\n**批注内容**：\n\n${anno.note}\n`
    exportMarkdown(content, `批注-${anno.text.slice(0, 20)}.md`)
  }

  const scrollToAnnotation = (anno: Annotation) => {
    setSelectedAnnotationId(anno.id)
    if (!readerRef.current) return

    const readerContent = readerRef.current.innerText
    const index = readerContent.indexOf(anno.text)
    if (index !== -1) {
      const element = readerRef.current.querySelector(`[data-annotation-id="${anno.id}"]`)
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
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
          span.className = `annotation-highlight ${getHighlightClass(annotation.color)} cursor-pointer rounded-sm transition-colors hover:opacity-80`
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
        const anno = annotations.find((a) => a.id === id)
        if (anno) {
          setHoverAnnotation(anno)
          const rect = annotationSpan.getBoundingClientRect()
          setToolbarPosition({
            top: rect.top,
            left: rect.left + rect.width / 2,
          })
        }
      }
    }

    const handleMouseLeave = (e: Event) => {
      const target = e.target as HTMLElement
      const annotationSpan = target.closest('.annotation-highlight')
      if (annotationSpan) {
        setHoverAnnotation(null)
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
  }, [paperAnnotations, selectedAnnotationId, annotations])

  const renderContentWithHighlights = (content: string) => {
    return (
      <div
        ref={readerRef}
        onMouseUp={handleTextSelection}
        onMouseDown={() => {
          setShowToolbar(false)
        }}
        className="relative"
      >
        {renderSimpleMarkdown(content)}
        {showToolbar && (
          <div
            className="fixed z-50 bg-white rounded-lg shadow-xl border border-slate-200 p-2 flex items-center gap-1"
            style={{
              top: toolbarPosition.top + (readerRef.current?.getBoundingClientRect().top || 0) + 45,
              left: toolbarPosition.left + (readerRef.current?.getBoundingClientRect().left || 0) + 120,
            }}
          >
            {showAnnotationInput ? (
              <div className="w-64">
                <div className="text-xs text-slate-500 mb-2 flex items-center gap-2">
                  <Palette className="w-3.5 h-3.5" />
                  添加批注
                </div>
                <textarea
                  ref={annotationInputRef}
                  value={newAnnotationText}
                  onChange={(e) => setNewAnnotationText(e.target.value)}
                  placeholder="输入批注内容（支持Markdown）..."
                  className="w-full h-24 p-2 text-xs border border-slate-200 rounded resize-none focus:outline-none focus:border-indigo-400"
                  autoFocus
                />
                <div className="flex items-center justify-between mt-2">
                  <div className="flex gap-1">
                    {HIGHLIGHT_COLORS.map((c) => (
                      <button
                        key={c.value}
                        onClick={() => setPendingColor(c.value)}
                        className={`w-5 h-5 rounded-full ${c.bg} border-2 ${
                          pendingColor === c.value ? 'border-slate-600 scale-110' : 'border-transparent'
                        } transition`}
                        title={c.label}
                      />
                    ))}
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={cancelAnnotation}
                      className="px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 rounded transition"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={confirmAnnotation}
                      className="px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 transition flex items-center gap-1"
                    >
                      <Check className="w-3.5 h-3.5" />
                      保存
                    </button>
                  </div>
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
    )
  }

  return (
    <div className="h-[calc(100vh-3rem)] flex">
      {/* 左栏：文献列表 */}
      <aside className="w-72 bg-white border-r border-slate-200 flex flex-col">
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
                  ? 'bg-indigo-100 text-indigo-700'
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
                  ? 'bg-green-100 text-green-700'
                  : 'text-slate-500 hover:bg-slate-100'
              }`}
            >
              有Markdown
            </button>
            <button
              onClick={() => setFilterType('no-md')}
              className={`px-2 py-1 text-xs rounded transition ${
                filterType === 'no-md'
                  ? 'bg-amber-100 text-amber-700'
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

      {/* 中栏：Markdown 阅读区 */}
      <section className="flex-1 bg-slate-50 flex flex-col min-w-0">
        {selectedPaper ? (
          <>
            {/* 顶部工具栏 */}
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
                  className="p-1.5 text-slate-500 hover:bg-slate-100 rounded transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                  title="导出批注"
                >
                  <Download className="w-4 h-4" />
                  <span className="text-xs hidden sm:inline">导出批注</span>
                </button>
              </div>
            </div>

            {/* Markdown 内容区域 */}
            <div className="flex-1 overflow-y-auto">
              {selectedPaper.hasMarkdown && selectedPaper.markdownContent ? (
                <div className="max-w-3xl mx-auto px-8 py-8">
                  <div
                    className="bg-white rounded-xl shadow-sm border border-slate-200 p-8"
                    style={{ fontSize: `${fontSize}px` }}
                  >
                    {renderContentWithHighlights(selectedPaper.markdownContent)}
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

      {/* 右栏：笔记 / 批注 */}
      <aside className="w-80 bg-white border-l border-slate-200 flex flex-col flex-shrink-0">
        <div className="flex border-b border-slate-200 flex-shrink-0">
          <button
            onClick={() => setActiveSideTab('notes')}
            className={`flex-1 px-3 py-2.5 text-sm font-medium transition ${
              activeSideTab === 'notes'
                ? 'text-indigo-600 border-b-2 border-indigo-600'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <StickyNote className="w-3.5 h-3.5 inline mr-1" />
            笔记
          </button>
          <button
            onClick={() => setActiveSideTab('annotations')}
            className={`flex-1 px-3 py-2.5 text-sm font-medium transition ${
              activeSideTab === 'annotations'
                ? 'text-indigo-600 border-b-2 border-indigo-600'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <Highlighter className="w-3.5 h-3.5 inline mr-1" />
            批注
            {paperAnnotations.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-[10px] bg-indigo-100 text-indigo-600 rounded-full">
                {paperAnnotations.length}
              </span>
            )}
          </button>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col">
          {activeSideTab === 'notes' ? (
            <div className="flex-1 flex flex-col">
              <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
                <span className="text-xs text-slate-500">整体笔记</span>
                <button
                  onClick={exportNote}
                  disabled={!selectedPaper || !currentNote}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Download className="w-3.5 h-3.5" />
                  导出笔记
                </button>
              </div>
              <div className="flex-1 p-3 overflow-hidden">
                <textarea
                  value={currentNote}
                  onChange={handleNoteChange}
                  placeholder={selectedPaper ? '在此记录阅读笔记...\n\n支持 Markdown 格式' : '选择文献后开始记笔记'}
                  disabled={!selectedPaper}
                  className="w-full h-full p-3 text-sm border border-slate-200 rounded-lg resize-none focus:outline-none focus:border-indigo-400 disabled:bg-slate-50 font-mono leading-relaxed"
                />
              </div>
              <div className="px-3 py-2 border-t border-slate-100 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-1 text-xs text-slate-400">
                  {saveStatus === 'saving' && (
                    <>
                      <span className="w-2 h-2 border border-slate-300 border-t-slate-500 rounded-full animate-spin" />
                      保存中...
                    </>
                  )}
                  {saveStatus === 'saved' && (
                    <>
                      <Save className="w-3 h-3 text-green-500" />
                      <span className="text-green-600">已保存</span>
                    </>
                  )}
                  {saveStatus === null && (
                    <>
                      <Save className="w-3 h-3" />
                      自动保存
                    </>
                  )}
                </div>
                <span className="text-xs text-slate-400">
                  {currentNote.length} 字
                </span>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col">
              <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
                <span className="text-xs text-slate-500">
                  共 {paperAnnotations.length} 条批注
                </span>
                <button
                  onClick={exportAllAnnotations}
                  disabled={paperAnnotations.length === 0}
                  className="flex items-center gap-1 px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
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
                      .map((anno) => (
                        <div
                          key={anno.id}
                          onClick={() => scrollToAnnotation(anno)}
                          className={`p-3 rounded-lg border-l-4 cursor-pointer transition hover:shadow-sm ${
                            getBorderClass(anno.color)
                          } ${
                            selectedAnnotationId === anno.id
                              ? 'ring-2 ring-indigo-300'
                              : ''
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${getDotClass(anno.color)}`} />
                              <span className="text-xs text-slate-500 font-medium flex-shrink-0">
                                {HIGHLIGHT_COLORS.find((c) => c.value === anno.color)?.label}
                              </span>
                            </div>
                            <div className="flex items-center gap-1">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  exportSingleAnnotation(anno)
                                }}
                                className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-white/50 rounded transition"
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
                                className="p-1 text-slate-400 hover:text-red-600 hover:bg-white/50 rounded transition"
                                title="删除批注"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                          <blockquote className="mt-2 text-sm text-slate-600 bg-white/60 rounded px-2 py-1.5 border-l-2 border-slate-200 italic line-clamp-2">
                            "{anno.text}"
                          </blockquote>
                          {anno.note && (
                            <div className="mt-2 text-sm text-slate-700">
                              <div className="prose-sm max-w-none">
                                {renderSimpleMarkdown(anno.note)}
                              </div>
                            </div>
                          )}
                          <div className="mt-2 flex items-center gap-1 text-xs text-slate-400">
                            <Clock className="w-3 h-3" />
                            {formatDate(anno.createdAt)}
                            <ChevronRight className="w-3 h-3 ml-auto" />
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* 悬停批注预览 */}
      {hoverAnnotation && (
        <div className="fixed z-50 bg-white rounded-lg shadow-xl border border-slate-200 p-3 max-w-xs">
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-2 h-2 rounded-full ${getDotClass(hoverAnnotation.color)}`} />
            <span className="text-xs font-medium text-slate-600">
              {HIGHLIGHT_COLORS.find((c) => c.value === hoverAnnotation.color)?.label}批注
            </span>
          </div>
          <div className="text-xs text-slate-500 border-l-2 border-slate-200 pl-2 italic line-clamp-2 mb-2">
            "{hoverAnnotation.text}"
          </div>
          {hoverAnnotation.note && (
            <div className="text-sm text-slate-700 max-h-32 overflow-y-auto">
              {renderSimpleMarkdown(hoverAnnotation.note)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

