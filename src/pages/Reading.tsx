import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
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
  X,
  ChevronRight,
  Bold,
  Italic,
  List,
  ListOrdered,
  Quote,
  Code,
  Link,
  Image,
  Heading1,
  Heading2,
  Heading3,
  Check,
  Edit3,
  Plus,
  Languages,
} from 'lucide-react'
import { loadLiteratures, loadFulltext, loadNotes, saveNotes, loadTranslation, loadAlignedMd, doiToSlug, type Literature } from '../services/literatureData'
import { loadAnnotations, saveAnnotations, type Annotation as AnnotationData } from '../services/annotationData'
import { useWorkspaceStore } from '../stores/workspace'
import { useAuthStore } from '../stores/auth'
import { getResolvedAuthMode } from '../services/github'
import { DoiLink } from '../components/DoiLink'
import { renderMarkdownToHtml, escapeHtml } from '../services/markdown-renderer'
import { splitMarkdownIntoParagraphs, alignParagraphs, renderAlignedHtml, renderAlignedMdHtml, type TranslationMode } from '../services/translation'

type HighlightColor = 'yellow' | 'green' | 'blue' | 'purple' | 'red'
type SideTab = 'notes' | 'annotations'
type FilterType = 'all' | 'has-md' | 'no-md'

interface Annotation {
  id: string
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

interface SaveState {
  status: 'saved' | 'saving' | 'idle'
  lastSaved: number | null
}

function literatureToPaper(lit: Literature): Paper {
  return {
    id: lit.doi,
    title: lit.title,
    authors: lit.authors,
    journal: lit.journal,
    year: String(lit.year),
    keywords: lit.keywords ? lit.keywords.split(',').map(k => k.trim()).filter(Boolean) : [],
    doi: lit.doi,
    hasMarkdown: false,
    markdownContent: undefined,
  }
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

function htmlToMarkdown(html: string): string {
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  let md = ''

  const walk = (node: Node, depth: number = 0): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || ''
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return ''

    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()
    let result = ''

    switch (tag) {
      case 'h1': result = `# ${el.textContent}\n\n`; break
      case 'h2': result = `## ${el.textContent}\n\n`; break
      case 'h3': result = `### ${el.textContent}\n\n`; break
      case 'h4': result = `#### ${el.textContent}\n\n`; break
      case 'h5': result = `##### ${el.textContent}\n\n`; break
      case 'h6': result = `###### ${el.textContent}\n\n`; break
      case 'p': result = `${el.textContent}\n\n`; break
      case 'br': result = '\n'; break
      case 'strong':
      case 'b': result = `**${el.textContent}**`; break
      case 'em':
      case 'i': result = `*${el.textContent}*`; break
      case 'blockquote': result = `> ${el.textContent}\n\n`; break
      case 'code': result = `\`${el.textContent}\``; break
      case 'pre': result = `\`\`\`\n${el.textContent}\n\`\`\`\n\n`; break
      case 'a': result = `[${el.textContent}](${el.getAttribute('href') || ''})`; break
      case 'img': result = `![${el.getAttribute('alt') || ''}](${el.getAttribute('src') || ''})\n\n`; break
      case 'ul': {
        let list = ''
        el.querySelectorAll(':scope > li').forEach(li => {
          list += `- ${li.textContent}\n`
        })
        return list + '\n'
      }
      case 'ol': {
        let list = ''
        let i = 1
        el.querySelectorAll(':scope > li').forEach(li => {
          list += `${i}. ${li.textContent}\n`
          i++
        })
        return list + '\n'
      }
      case 'li': return ''
      case 'div': {
        let content = ''
        el.childNodes.forEach(child => { content += walk(child, depth + 1) })
        return content
      }
      default:
        el.childNodes.forEach(child => { result += walk(child, depth + 1) })
    }
    return result
  }

  tmp.childNodes.forEach(child => { md += walk(child) })
  return md.replace(/\n{3,}/g, '\n\n').trim()
}

function getWordCountFromHtml(html: string): number {
  const tmp = document.createElement('div')
  tmp.innerHTML = html
  return (tmp.textContent || '').replace(/\s/g, '').length
}

export default function ReadingPage() {
  const { repo } = useWorkspaceStore()
  const [papers, setPapers] = useState<Paper[]>([])
  const [papersLoading, setPapersLoading] = useState(true)
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(null)
  const [activeSideTab, setActiveSideTab] = useState<SideTab>('notes')
  const [searchQuery, setSearchQuery] = useState('')
  const [filterType, setFilterType] = useState<FilterType>('all')
  const [fontSize, setFontSize] = useState(16)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [currentNoteHtml, setCurrentNoteHtml] = useState('')
  const [noteLoaded, setNoteLoaded] = useState(false)
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

  const readerRef = useRef<HTMLDivElement>(null)
  const noteEditorRef = useRef<HTMLDivElement>(null)
  const noteSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const annotationSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const annotationEditRefs = useRef<{ [key: string]: HTMLTextAreaElement | null }>({})
  const noteImageInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!repo) return
    let cancelled = false
    async function loadPapers() {
      try {
        const lits = await loadLiteratures()
        if (!cancelled) {
          const paperList = lits.map(literatureToPaper)
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

  useEffect(() => {
    if (!selectedPaperId) {
      setAnnotations([])
      setCurrentNoteHtml('')
      setNoteLoaded(false)
      setSelectedAnnotationId(null)
      setEditingAnnotationId(null)
      set_translation_content('')
      set_aligned_content('')
      return
    }

    let cancelled = false
    const doi = selectedPaperId

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

      try {
        const annData = await loadAnnotations(doi)
        if (!cancelled) {
          const mapped: Annotation[] = annData.map(a => ({
            id: a.id,
            text: a.text,
            color: a.color as HighlightColor,
            note: a.note,
            createdAt: a.createdAt,
          }))
          setAnnotations(mapped)
        }
      } catch (err) {
        console.error('[Reading] 加载批注失败:', err)
        if (!cancelled) setAnnotations([])
      }

      try {
        const noteContent = await loadNotes(doi)
        if (!cancelled) {
          const html = renderMarkdownToHtml(noteContent)
          setCurrentNoteHtml(html)
          setNoteLoaded(true)
        }
      } catch (err) {
        console.error('[Reading] 加载笔记失败:', err)
        if (!cancelled) {
          setCurrentNoteHtml('')
          setNoteLoaded(true)
        }
      }
    }

    loadPaperData()
    return () => { cancelled = true }
  }, [selectedPaperId])

  useEffect(() => {
    if (noteEditorRef.current && noteLoaded) {
      noteEditorRef.current.innerHTML = currentNoteHtml
    }
  }, [noteLoaded, currentNoteHtml])

  const saveAnnotationsToStorage = useCallback((newAnnotations: Annotation[]) => {
    if (!selectedPaperId) return
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
      }))
      saveAnnotations(selectedPaperId, data).catch(err => console.error('[Reading] 保存批注到 GitHub 失败:', err))
      setAnnotationSaveState({ status: 'saved', lastSaved: Date.now() })
      setTimeout(() => {
        setAnnotationSaveState((prev) => ({ ...prev, status: 'idle' }))
      }, 2000)
    }, 500)
  }, [selectedPaperId])

  const saveNoteToStorage = useCallback((html: string) => {
    if (!selectedPaperId) return
    if (noteSaveTimerRef.current) {
      clearTimeout(noteSaveTimerRef.current)
    }
    setNoteSaveState({ status: 'saving', lastSaved: null })
    noteSaveTimerRef.current = setTimeout(() => {
      setCurrentNoteHtml(html)
      const md = htmlToMarkdown(html)
      saveNotes(selectedPaperId, md).catch(err => console.error('[Reading] 保存笔记到 GitHub 失败:', err))
      setNoteSaveState({ status: 'saved', lastSaved: Date.now() })
      setTimeout(() => {
        setNoteSaveState((prev) => ({ ...prev, status: 'idle' }))
      }, 2000)
    }, 800)
  }, [selectedPaperId])

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
    if (!selectedPaperId || !selectedText) return

    const newAnnotation: Annotation = {
      id: `anno-${Date.now()}`,
      text: selectedText,
      color,
      note: '',
      createdAt: Date.now(),
    }

    const newAnnotations = [...annotations, newAnnotation]
    setAnnotations(newAnnotations)
    saveAnnotationsToStorage(newAnnotations)
    setShowToolbar(false)
    setSelectedText('')
    window.getSelection()?.removeAllRanges()
    setActiveSideTab('annotations')
    setSelectedAnnotationId(newAnnotation.id)
    setEditingAnnotationId(newAnnotation.id)
  }

  const deleteAnnotation = (id: string) => {
    const newAnnotations = annotations.filter((a) => a.id !== id)
    setAnnotations(newAnnotations)
    saveAnnotationsToStorage(newAnnotations)
    if (selectedAnnotationId === id) {
      setSelectedAnnotationId(null)
    }
    if (editingAnnotationId === id) {
      setEditingAnnotationId(null)
    }
  }

  const updateAnnotationNote = (id: string, note: string) => {
    const newAnnotations = annotations.map((a) =>
      a.id === id ? { ...a, note } : a
    )
    setAnnotations(newAnnotations)
    saveAnnotationsToStorage(newAnnotations)
  }

  const filteredPapers = papers.filter((paper) => {
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

  const selectedPaper = papers.find((p) => p.id === selectedPaperId)
  const paperAnnotations = annotations

  const rendered_html = useMemo(() => {
    const opts = { imageBaseUrl: getImageBaseUrl(selectedPaperId ?? '') }

    // 新路径：有 aligned.md → 确定性 idx 对齐渲染
    if (aligned_content.trim()) {
      const result = renderAlignedMdHtml(aligned_content, translation_mode, opts)
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
  }, [selectedPaper, selectedPaperId, aligned_content, translation_content, translation_mode])

  // 图片预加载：渲染后把 api.github.com/contents URL 换成 blob URL（绕过 GFW 对 raw.githubusercontent.com 的封锁）
  useEffect(() => {
    if (!rendered_html || !readerRef.current) return
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
  }, [rendered_html])

  const focusNoteEditor = () => {
    if (noteEditorRef.current) {
      noteEditorRef.current.focus()
    }
  }

  const handleNoteInput = () => {
    if (!selectedPaperId || !noteEditorRef.current) return
    const html = noteEditorRef.current.innerHTML
    saveNoteToStorage(html)
  }

  const execNoteCommand = (command: string, value?: string) => {
    focusNoteEditor()
    document.execCommand(command, false, value)
    handleNoteInput()
  }

  const insertHeading = (level: number) => {
    execNoteCommand('formatBlock', `H${level}`)
  }

  const insertBold = () => {
    execNoteCommand('bold')
  }

  const insertItalic = () => {
    execNoteCommand('italic')
  }

  const insertLink = () => {
    focusNoteEditor()
    const sel = window.getSelection()
    const selectedText = sel?.toString() || '链接文字'
    const linkHtml = `<a href="https://" target="_blank" rel="noopener noreferrer" class="text-indigo-600 underline">${selectedText}</a>`
    document.execCommand('insertHTML', false, linkHtml)
    handleNoteInput()
  }

  const handleNoteImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !selectedPaperId) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string
      focusNoteEditor()
      document.execCommand('insertImage', false, dataUrl)
      handleNoteInput()
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const insertImage = () => {
    noteImageInputRef.current?.click()
  }

  const insertCodeBlock = () => {
    focusNoteEditor()
    const sel = window.getSelection()
    const selectedText = sel?.toString() || '代码'
    const codeHtml = `<pre class="bg-slate-100 p-3 rounded text-sm font-mono overflow-x-auto"><code>${escapeHtml(selectedText)}</code></pre><p><br></p>`
    document.execCommand('insertHTML', false, codeHtml)
    handleNoteInput()
  }

  const insertUnorderedList = () => {
    execNoteCommand('insertUnorderedList')
  }

  const insertOrderedList = () => {
    execNoteCommand('insertOrderedList')
  }

  const insertBlockquote = () => {
    execNoteCommand('formatBlock', 'BLOCKQUOTE')
  }

  const exportNote = () => {
    if (!selectedPaper || !currentNoteHtml) return
    exportMarkdown(htmlToMarkdown(currentNoteHtml), `${selectedPaper.title}-笔记.md`)
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

  const scrollToAnnotation = (anno: Annotation) => {
    setSelectedAnnotationId(anno.id)
    setEditingAnnotationId(null)
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
          span.className = `annotation-highlight ${getColorInfo(annotation.color).bg} cursor-pointer rounded-sm transition-all hover:opacity-80`
          if (selectedAnnotationId === annotation.id) {
            span.classList.add('ring-2', getColorInfo(annotation.color).ring, 'ring-offset-1')
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
          setEditingAnnotationId(null)
        }
      }
    }

    readerRef.current.addEventListener('click', handleClick)

    return () => {
      if (readerRef.current) {
        readerRef.current.removeEventListener('click', handleClick)
      }
    }
  }, [paperAnnotations, selectedAnnotationId])

  useEffect(() => {
    if (selectedAnnotationId && activeSideTab === 'annotations') {
      const element = document.getElementById(`annotation-item-${selectedAnnotationId}`)
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }
  }, [selectedAnnotationId, activeSideTab])

  const wordCount = currentNoteHtml ? getWordCountFromHtml(currentNoteHtml) : 0

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
          {papersLoading ? (
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
                onClick={() => window.location.hash = '#/literature'}
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
                  disabled={!currentNoteHtml}
                  className="px-2.5 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1"
                  title="导出笔记"
                >
                  <Download className="w-3.5 h-3.5" />
                  导出笔记
                </button>
                <div className="w-px h-5 bg-slate-200 mx-1" />
                <button
                  onClick={() => {
                    const modes: TranslationMode[] = ['original', 'bilingual', 'chinese', 'english']
                    const idx = modes.indexOf(translation_mode)
                    set_translation_mode(modes[(idx + 1) % modes.length])
                  }}
                  className="px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded transition flex items-center gap-1"
                  title={translation_content ? '切换翻译模式（已预生成）' : '翻译尚未生成'}
                >
                  <Languages className="w-3.5 h-3.5" />
                  {translation_mode === 'original' && '原文'}
                  {translation_mode === 'bilingual' && '中英对照'}
                  {translation_mode === 'chinese' && '全中文'}
                  {translation_mode === 'english' && '全英文'}
                  {!translation_content && '（未生成）'}
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {selectedPaper.hasMarkdown && selectedPaper.markdownContent ? (
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
                      dangerouslySetInnerHTML={{ __html: rendered_html }}
                    />
                    {showToolbar && (
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
              <span className="px-1.5 py-0.5 text-[0.625rem] bg-indigo-100 text-indigo-600 rounded-full font-medium">
                {paperAnnotations.length}
              </span>
            )}
          </button>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col">
          {activeSideTab === 'notes' ? (
            <div className="flex-1 flex flex-col">
              <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between flex-shrink-0 bg-slate-50/50">
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={() => insertHeading(1)}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
                    title="标题1"
                    disabled={!selectedPaper}
                  >
                    <Heading1 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => insertHeading(2)}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
                    title="标题2"
                    disabled={!selectedPaper}
                  >
                    <Heading2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => insertHeading(3)}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
                    title="标题3"
                    disabled={!selectedPaper}
                  >
                    <Heading3 className="w-3.5 h-3.5" />
                  </button>
                  <div className="w-px h-4 bg-slate-200 mx-0.5" />
                  <button
                    onClick={insertBold}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
                    title="加粗"
                    disabled={!selectedPaper}
                  >
                    <Bold className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={insertItalic}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
                    title="斜体"
                    disabled={!selectedPaper}
                  >
                    <Italic className="w-3.5 h-3.5" />
                  </button>
                  <div className="w-px h-4 bg-slate-200 mx-0.5" />
                  <button
                    onClick={insertUnorderedList}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
                    title="无序列表"
                    disabled={!selectedPaper}
                  >
                    <List className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={insertOrderedList}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
                    title="有序列表"
                    disabled={!selectedPaper}
                  >
                    <ListOrdered className="w-3.5 h-3.5" />
                  </button>
                  <div className="w-px h-4 bg-slate-200 mx-0.5" />
                  <button
                    onClick={insertBlockquote}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
                    title="引用"
                    disabled={!selectedPaper}
                  >
                    <Quote className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={insertCodeBlock}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
                    title="代码块"
                    disabled={!selectedPaper}
                  >
                    <Code className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={insertLink}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
                    title="链接"
                    disabled={!selectedPaper}
                  >
                    <Link className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={insertImage}
                    className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-white rounded transition disabled:opacity-40 disabled:cursor-not-allowed"
                    title="图片"
                    disabled={!selectedPaper}
                  >
                    <Image className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={exportNote}
                    disabled={!selectedPaper || !currentNoteHtml}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 rounded transition disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                  >
                    <Download className="w-3.5 h-3.5" />
                    导出
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto">
                {selectedPaper ? (
                  <div
                    ref={noteEditorRef}
                    contentEditable
                    suppressContentEditableWarning
                    onInput={handleNoteInput}
                    className="w-full h-full p-3 text-sm focus:outline-none prose prose-slate max-w-none note-editor"
                  />
                ) : (
                  <div className="text-center text-slate-400 py-8">
                    <StickyNote className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p className="text-sm">选择文献后开始记笔记</p>
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
              <input
                ref={noteImageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleNoteImageUpload}
              />
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
                                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${colorInfo.dot}`} />
                                <span className={`text-xs font-medium ${colorInfo.text}`}>
                                  {colorInfo.label}批注
                                </span>
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
