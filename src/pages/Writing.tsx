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
} from 'lucide-react'

const STAGES = [
  { value: 'topic', label: '选题' },
  { value: 'review', label: '文献综述' },
  { value: 'writing', label: '正文撰写' },
  { value: 'citation', label: '引用' },
  { value: 'typesetting', label: '排版' },
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
}

function renderMarkdown(text: string): string {
  let html = text

  const doiRegex = /\[\[([^\]]+)\]\]/g
  html = html.replace(doiRegex, (_, doi) => {
    return `<a href="https://doi.org/${doi}" target="_blank" rel="noopener noreferrer" class="text-indigo-600 hover:text-indigo-800 underline decoration-dotted underline-offset-2">[${doi}]</a>`
  })

  const codeBlockRegex = /```([\s\S]*?)```/g
  const codeBlocks: string[] = []
  html = html.replace(codeBlockRegex, (_, code) => {
    codeBlocks.push(code)
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`
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
    return `<div class="my-4"><img src="${src}" alt="${alt}" class="max-w-full h-auto rounded-lg border border-slate-200" /><p class="text-sm text-slate-500 mt-1 text-center">${alt}</p></div>`
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
      result.push(`<p class="my-3 text-slate-700 leading-relaxed">${paraBuffer.join(' ')}</p>`)
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
      result.push(`<pre class="my-4 p-4 bg-slate-900 text-slate-100 rounded-lg overflow-x-auto text-sm font-mono"><code>${escapeHtml(code.trim())}</code></pre>`)
      continue
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
  if (inUl) result.push('</ul>')
  if (inOl) result.push('</ol>')

  return result.join('\n')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export default function WritingPage() {
  const [projects, setProjects] = useState<Project[]>(DEMO_PROJECTS)
  const [activeProjectId, setActiveProjectId] = useState<string | null>('1')
  const [mdContent, setMdContent] = useState(DEMO_MD)
  const [editorMode, setEditorMode] = useState<EditorMode>('split')
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved')
  const [messages, setMessages] = useState<AIMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isAiLoading, setIsAiLoading] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)

  const activeProject = projects.find((p) => p.id === activeProjectId)

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
      setTimeout(() => setSaveStatus('saved'), 500)
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
      } else {
        const lower = text.toLowerCase()
        if (lower.includes('继续') || lower.includes('续写')) response = DEMO_AI_RESPONSES.continue
        else if (lower.includes('润色') || lower.includes('优化') || lower.includes('polish')) response = DEMO_AI_RESPONSES.polish
        else if (lower.includes('翻译') || lower.includes('translate')) response = DEMO_AI_RESPONSES.translate
      }

      const aiMsg: AIMessage = {
        id: String(Date.now() + 1),
        role: 'assistant',
        content: response.content,
        citations: response.citations,
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
    }
    handleSendMessage(prompts[action] || action)
  }

  const renderedHtml = renderMarkdown(mdContent)

  return (
    <div className="h-[calc(100vh-3rem)] flex bg-slate-50">
      <aside className="w-60 bg-white border-r border-slate-200 flex flex-col flex-shrink-0">
        <div className="p-3 border-b border-slate-200">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-800 text-sm">项目</h2>
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
                activeProjectId === p.id ? 'bg-indigo-50 border-l-2 border-l-indigo-600' : ''
              }`}
            >
              <div className="text-sm font-medium text-slate-700 truncate">{p.name}</div>
              <div className="flex items-center justify-between mt-0.5">
                <span className="text-xs text-slate-500">
                  {STAGES.find((s) => s.value === p.stage)?.label}
                </span>
                <span className="text-xs text-slate-400 flex items-center gap-1">
                  <BookOpen className="w-3 h-3" />
                  {p.litCount}
                </span>
              </div>
            </button>
          ))}
        </div>
        <div className="border-t border-slate-200 p-3">
          <div className="text-xs font-medium text-slate-500 mb-2 uppercase tracking-wide">阶段</div>
          <div className="space-y-0.5">
            {STAGES.map((s) => {
              const cur = activeProject?.stage === s.value
              return (
                <button
                  key={s.value}
                  disabled={!activeProject}
                  onClick={() => handleStageChange(s.value)}
                  className={`w-full text-left px-2 py-1.5 rounded text-xs transition ${
                    cur
                      ? 'bg-indigo-50 text-indigo-700 font-medium'
                      : 'text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed'
                  }`}
                >
                  <span className="inline-block w-3">{cur ? '●' : '○'}</span>
                  {s.label}
                </button>
              )
            })}
          </div>
        </div>
      </aside>

      <section className="flex-1 flex flex-col min-w-0">
        <div className="bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-4">
            <span className="text-sm font-medium text-slate-700">
              {activeProject ? activeProject.name : '未选择项目'}
            </span>
            {activeProject && (
              <span className="text-xs px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded-full font-medium">
                {STAGES.find((s) => s.value === activeProject.stage)?.label}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {saveStatus === 'saved' && (
              <span className="text-xs text-green-600 flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                已保存
              </span>
            )}
            {saveStatus === 'saving' && (
              <span className="text-xs text-slate-500 flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 animate-pulse" />
                保存中...
              </span>
            )}
            {saveStatus === 'unsaved' && (
              <span className="text-xs text-amber-600 flex items-center gap-1">
                <Save className="w-3.5 h-3.5" />
                未保存
              </span>
            )}
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div
            className={`flex flex-col bg-white border-r border-slate-200 ${
              editorMode === 'preview' ? 'hidden' : 'flex-1 min-w-0'
            }`}
          >
            <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-200">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500 font-medium flex items-center gap-1">
                  <Edit3 className="w-3.5 h-3.5" />
                  编辑器
                </span>
              </div>
              <div className="flex items-center gap-0.5 bg-white rounded-md border border-slate-200 p-0.5">
                <button
                  onClick={() => setEditorMode('edit')}
                  className={`px-2 py-1 rounded text-xs transition flex items-center gap-1 ${
                    editorMode === 'edit'
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-500 hover:bg-slate-50'
                  }`}
                  title="仅编辑"
                >
                  <Edit3 className="w-3 h-3" />
                </button>
                <button
                  onClick={() => setEditorMode('split')}
                  className={`px-2 py-1 rounded text-xs transition flex items-center gap-1 ${
                    editorMode === 'split'
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-500 hover:bg-slate-50'
                  }`}
                  title="编辑+预览"
                >
                  <Columns className="w-3 h-3" />
                </button>
                <button
                  onClick={() => setEditorMode('preview')}
                  className={`px-2 py-1 rounded text-xs transition flex items-center gap-1 ${
                    editorMode === 'preview'
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-500 hover:bg-slate-50'
                  }`}
                  title="仅预览"
                >
                  <Eye className="w-3 h-3" />
                </button>
              </div>
            </div>
            <textarea
              value={mdContent}
              onChange={(e) => handleMdChange(e.target.value)}
              className="flex-1 w-full p-4 font-mono text-sm text-slate-800 bg-white resize-none focus:outline-none leading-relaxed"
              spellCheck={false}
              placeholder="在此撰写 Markdown 格式的论文..."
            />
          </div>

          <div
            className={`flex flex-col bg-white ${
              editorMode === 'edit' ? 'hidden' : 'flex-1 min-w-0'
            }`}
          >
            <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-200">
              <span className="text-xs text-slate-500 font-medium flex items-center gap-1">
                <Eye className="w-3.5 h-3.5" />
                实时预览
              </span>
            </div>
            <div
              className="flex-1 overflow-auto p-6 prose prose-slate max-w-none"
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          </div>

          <div className="w-80 flex flex-col border-l border-slate-200 bg-white flex-shrink-0">
            <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-600" />
              <span className="text-sm font-medium text-slate-700">AI 辅助写作</span>
            </div>

            <div className="p-2 border-b border-slate-100 bg-white">
              <div className="grid grid-cols-4 gap-1.5">
                <button
                  onClick={() => handleQuickAction('continue')}
                  className="flex flex-col items-center gap-1 px-2 py-2 rounded-lg border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 transition text-xs text-slate-600 hover:text-indigo-700"
                  title="继续写作"
                >
                  <PenTool className="w-4 h-4" />
                  <span>继续写作</span>
                </button>
                <button
                  onClick={() => handleQuickAction('polish')}
                  className="flex flex-col items-center gap-1 px-2 py-2 rounded-lg border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 transition text-xs text-slate-600 hover:text-indigo-700"
                  title="润色"
                >
                  <Wand2 className="w-4 h-4" />
                  <span>润色</span>
                </button>
                <button
                  onClick={() => handleQuickAction('translate')}
                  className="flex flex-col items-center gap-1 px-2 py-2 rounded-lg border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 transition text-xs text-slate-600 hover:text-indigo-700"
                  title="翻译"
                >
                  <Languages className="w-4 h-4" />
                  <span>翻译</span>
                </button>
                <button
                  onClick={() => handleQuickAction('search')}
                  className="flex flex-col items-center gap-1 px-2 py-2 rounded-lg border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 transition text-xs text-slate-600 hover:text-indigo-700"
                  title="找文献"
                >
                  <Search className="w-4 h-4" />
                  <span>找文献</span>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {messages.length === 0 && (
                <div className="text-center py-12">
                  <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-indigo-50 flex items-center justify-center">
                    <Sparkles className="w-6 h-6 text-indigo-400" />
                  </div>
                  <p className="text-sm text-slate-500">AI 辅助写作</p>
                  <p className="text-xs text-slate-400 mt-1">
                    输入问题或点击上方快捷指令
                  </p>
                </div>
              )}

              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={`max-w-[90%] rounded-2xl px-3 py-2 text-sm ${
                      msg.role === 'user'
                        ? 'bg-indigo-600 text-white rounded-br-md'
                        : 'bg-slate-100 text-slate-700 rounded-bl-md'
                    }`}
                  >
                    {msg.role === 'assistant' ? (
                      <div className="space-y-2">
                        <div
                          className="whitespace-pre-wrap leading-relaxed text-sm"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                        />
                        {msg.citations && msg.citations.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-slate-200">
                            <div className="text-xs font-medium text-slate-500 mb-2 flex items-center gap-1">
                              <Quote className="w-3 h-3" />
                              引用自知识库
                            </div>
                            <div className="space-y-2">
                              {msg.citations.map((cit, idx) => (
                                <div
                                  key={idx}
                                  className="p-2 bg-white rounded-lg border border-slate-200 hover:border-indigo-200 transition"
                                >
                                  <div className="text-xs font-medium text-slate-700 line-clamp-2">
                                    {cit.title}
                                  </div>
                                  <div className="text-xs text-slate-500 mt-1 truncate">
                                    {cit.authors} ({cit.year})
                                  </div>
                                  <div className="text-xs text-slate-400 truncate mt-0.5">
                                    {cit.journal}
                                  </div>
                                  <a
                                    href={`https://doi.org/${cit.doi}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-indigo-600 hover:text-indigo-800 flex items-center gap-1 mt-1"
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
                  <div className="bg-slate-100 rounded-2xl rounded-bl-md px-3 py-2">
                    <div className="flex gap-1">
                      <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                </div>
              )}

              <div ref={chatEndRef} />
            </div>

            <div className="p-3 border-t border-slate-200">
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
                  placeholder="询问 AI..."
                  className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
                />
                <button
                  onClick={() => handleSendMessage()}
                  disabled={isAiLoading || !inputValue.trim()}
                  className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
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
