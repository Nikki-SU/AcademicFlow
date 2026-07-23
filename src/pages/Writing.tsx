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
  Heading4,
  Heading5,
  Heading6,
  List,
  ListOrdered,
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
  Copy,
  FolderOpen,
  Clipboard,
  GripVertical,
  Eye,
  File,
} from 'lucide-react'
import TableGridPicker from '../components/TableGridPicker'
import { toast } from 'sonner'
import { readMdFile, writeMdFile } from '../services/userData'

const PROJECT_DOC_PATH = 'writing/default.md'

const STAGES = [
  { value: 'topic', label: '选题', leftPanel: 'outline', rightPanel: 'knowledge' },
  { value: 'review', label: '文献综述', leftPanel: 'references', rightPanel: 'library' },
  { value: 'writing', label: '正文撰写', leftPanel: 'editor', rightPanel: 'ai' },
  { value: 'citation', label: '引用', leftPanel: 'references', rightPanel: 'library' },
  { value: 'typesetting', label: '排版', leftPanel: 'editor', rightPanel: 'typesetting' },
]

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

const PANEL_RATIOS = [
  { value: '7:3', label: '7 : 3', left: 70 },
  { value: '5:5', label: '5 : 5', left: 50 },
  { value: '3:7', label: '3 : 7', left: 30 },
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
  projectId?: string
  type?: 'paper' | 'book'
}

interface BookChapter {
  id: string
  bookId: string
  title: string
  pageStart: number
  pageEnd: number
}

interface BookRef extends CitationRef {
  type: 'book'
  chapters: BookChapter[]
}

interface AIMessage {
  id: string
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

type LeftPanelMode = 'editor' | 'outline' | 'references'
type RightPanelMode = 'ai' | 'library' | 'knowledge' | 'typesetting'

const DEFAULT_PROJECT: Project = { id: 'default', name: '默认项目', stage: 'writing', litCount: 0 }

// 保留最小 fallback，使 UI 在无数据时仍可渲染；真实数据在组件挂载后从 GitHub 私库加载
const DEMO_PROJECTS: Project[] = [DEFAULT_PROJECT]

const DEMO_CITATIONS: CitationRef[] = [
  {
    doi: '10.1021/jacs.3c11464',
    title: 'Efficient Perovskite Solar Cells via Interface Engineering',
    authors: 'Chen, X., Li, Y.',
    year: 2023,
    journal: 'Journal of the American Chemical Society',
    projectId: 'default',
    type: 'paper',
  },
]

// 真实文献数据在组件挂载时从 GitHub 私库加载

const DEMO_BOOKS: BookRef[] = [
  {
    doi: '10.1007/978-3-030-12345-6',
    title: '有机合成化学原理与方法',
    authors: 'Smith, M.B., March, J.',
    year: 2020,
    journal: 'Wiley',
    type: 'book',
    projectId: '1',
    chapters: [
      { id: 'ch1', bookId: '10.1007/978-3-030-12345-6', title: '第一章 有机合成基础', pageStart: 1, pageEnd: 45 },
      { id: 'ch2', bookId: '10.1007/978-3-030-12345-6', title: '第二章 亲核取代反应', pageStart: 46, pageEnd: 98 },
      { id: 'ch3', bookId: '10.1007/978-3-030-12345-6', title: '第三章 消除反应', pageStart: 99, pageEnd: 145 },
      { id: 'ch4', bookId: '10.1007/978-3-030-12345-6', title: '第四章 加成反应', pageStart: 146, pageEnd: 210 },
    ],
  },
  {
    doi: '10.1016/C2018-0-12345-6',
    title: '材料科学基础',
    authors: 'Callister, W.D., Rethwisch, D.G.',
    year: 2021,
    journal: 'Wiley',
    type: 'book',
    projectId: '2',
    chapters: [
      { id: 'ch1', bookId: '10.1016/C2018-0-12345-6', title: '第一章 材料结构基础', pageStart: 1, pageEnd: 60 },
      { id: 'ch2', bookId: '10.1016/C2018-0-12345-6', title: '第二章 晶体结构', pageStart: 61, pageEnd: 120 },
      { id: 'ch3', bookId: '10.1016/C2018-0-12345-6', title: '第三章 材料力学性能', pageStart: 121, pageEnd: 200 },
    ],
  },
]

const ALL_REFERENCES: CitationRef[] = [...DEMO_CITATIONS, ...DEMO_BOOKS]

const DEMO_MD = `# 引言

近年来，钙钛矿太阳能电池（PSCs）取得了突破性进展[1]，光电转换效率从 2009 年的 3.8% 迅速提升至 2024 年的 26.1%。

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
    content: '基于当前上下文，我建议从以下几个方面继续展开：\n\n1. **钙钛矿薄膜的形貌调控** —— 探讨反溶剂工程、添加剂工程等策略对薄膜质量的影响。\n\n2. **界面工程与电荷传输** —— 分析电子传输层（ETL）和空穴传输层（HTL）的选择及其对器件性能的影响。\n\n3. **稳定性研究进展** —— 讨论光稳定性、热稳定性和湿度稳定性的最新突破。\n\n下面我为你撰写"形貌调控"部分的初稿：\n\n### 形貌调控策略\n\n钙钛矿薄膜的形貌直接影响器件的光电转换效率和稳定性。研究者们开发了多种调控策略，其中反溶剂法是最常用的方法之一[1]。通过在旋涂过程中滴加反溶剂（如氯苯、甲苯），可以快速诱导前驱体结晶，形成致密、均匀的钙钛矿薄膜。',
    citations: [DEMO_CITATIONS[0]],
  },
  polish: {
    content: '以下是润色后的段落：\n\n近年来，钙钛矿太阳能电池（Perovskite Solar Cells, PSCs）作为新一代光伏技术的代表，取得了举世瞩目的突破性进展[1]。自 2009 年首次报道 3.8% 的光电转换效率以来，PSCs 的效率在短短十余年间已攀升至 26.1%，这一增长速度在光伏发展史上堪称前所未有。\n\n**润色要点：**\n- 补充英文全称及缩写定义，学术规范性更强\n- "突破性进展"前增加修饰语，表达更丰富\n- 增加时间跨度的强调，突出进展的神速\n- 结尾增加评价性语句，提升段落的学术分量',
    citations: [DEMO_CITATIONS[0]],
  },
  translate: {
    content: '**英文翻译：**\n\n# Introduction\n\nIn recent years, perovskite solar cells (PSCs) have achieved breakthrough progress[1], with the power conversion efficiency rapidly increasing from 3.8% in 2009 to 26.1% in 2024.\n\n## Background\n\nPerovskite materials possess the following outstanding properties:\n\n- **High absorption coefficient**: nearly complete absorption in the visible light range\n- *Long carrier diffusion length*: reaching the micrometer scale\n- **Tunable bandgap**: regulated through halogen composition\n\n> Perovskite solar cells are hailed as "the rising star of next-generation photovoltaic technology".',
    citations: [DEMO_CITATIONS[0]],
  },
  search: {
    content: '根据你的研究方向，我为你推荐以下几篇相关文献：\n\n### 1. 钙钛矿太阳能电池综述\n\n这篇综述系统总结了钙钛矿太阳能电池近五年的关键进展，涵盖效率提升、稳定性改进和大面积制备等多个方面。引用量超过 2000 次，是该领域的经典综述之一[1]。\n\n### 2. 电催化 CO2 还原\n\n这篇研究论文报道了一种新型金属有机框架衍生纳米材料，在电催化 CO2 还原反应中表现出优异的活性和选择性[2]。\n\n### 3. 钯催化合成方法学\n\n这篇 JACS 论文报道了 Pd/IPr^BIDEA 催化体系在区域选择性氢化脱氟反应中的应用，对有机合成方法学研究有重要参考价值[3]。',
    citations: DEMO_CITATIONS,
  },
  summarize: {
    content: '**段落总结：**\n\n本段主要介绍了钙钛矿太阳能电池的研究背景和优异特性，核心要点如下：\n\n1. **效率突破**：从 2009 年的 3.8% 提升至 2024 年的 26.1%，发展迅速\n2. **材料优势**：\n   - 高吸收系数：可见光范围内几乎完全吸收\n   - 长载流子扩散长度：可达微米级\n   - 可调节带隙：通过卤素组分调控\n3. **学术地位**：被誉为"下一代光伏技术的希望之星"\n\n这些特性使得钙钛矿太阳能电池成为光伏领域最具潜力的研究方向之一[1]。',
    citations: [DEMO_CITATIONS[0]],
  },
  expand: {
    content: '**扩写后的内容：**\n\n近年来，钙钛矿太阳能电池（PSCs）作为第三代光伏技术的典型代表，在全球范围内掀起了研究热潮并取得了突破性进展[1]。自 2009 年日本科学家 Miyasaka 等人首次将钙钛矿材料应用于染料敏化太阳能电池并获得 3.8% 的光电转换效率以来，PSCs 的效率在短短十余年间实现了跨越式发展，截至 2024 年已达到 26.1% 的认证效率，逼近单晶硅电池的理论极限。这一前所未有的发展速度，使得钙钛矿太阳能电池成为光伏领域最受关注的研究方向之一。',
    citations: [DEMO_CITATIONS[0]],
  },
  shorten: {
    content: '**缩写后的内容：**\n\n钙钛矿太阳能电池（PSCs）近年来进展迅速[1]，效率从 2009 年的 3.8% 提升至 2024 年的 26.1%，被誉为下一代光伏技术的希望之星。其高吸收系数、长载流子扩散长度和可调节带隙等特性使其具有巨大的应用潜力。',
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

function htmlToMarkdown(html: string): string {
  let md = html

  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n')
  md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n')
  md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n')

  md = md.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
  md = md.replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
  md = md.replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
  md = md.replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')

  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) => {
    return content.trim().split('\n').map((line: string) => '> ' + line.trim()).join('\n') + '\n\n'
  })

  md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
  md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '```\n$1\n```\n\n')

  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, content) => {
    return content.replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n') + '\n'
  })

  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, content) => {
    let i = 1
    return content.replace(/<li[^>]*>(.*?)<\/li>/gi, () => {
      return `${i++}. $1\n`
    }) + '\n'
  })

  md = md.replace(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
  md = md.replace(/<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"[^>]*>/gi, '![$2]($1)')

  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
  md = md.replace(/<br\s*\/?>/gi, '\n')
  md = md.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '$1\n')
  md = md.replace(/<hr\s*\/?>/gi, '---\n\n')

  md = md.replace(/<[^>]+>/g, '')

  md = md.replace(/&nbsp;/g, ' ')
  md = md.replace(/&amp;/g, '&')
  md = md.replace(/&lt;/g, '<')
  md = md.replace(/&gt;/g, '>')
  md = md.replace(/&quot;/g, '"')

  md = md.replace(/\n{3,}/g, '\n\n')
  md = md.trim()

  return md
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

function markdownToLatex(md: string, journalKey: string): string {
  let tex = md

  const docClass = journalKey === 'nature' || journalKey === 'science'
    ? '\\documentclass[10pt,nature]{article}'
    : journalKey === 'jacs' || journalKey === 'angew'
    ? '\\documentclass[10pt]{article}'
    : '\\documentclass[10pt]{article}'

  const packages = `
\\usepackage{graphicx}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{booktabs}
\\usepackage{hyperref}
\\usepackage{url}
\\usepackage{geometry}
\\geometry{margin=1in}`

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
  const [projects, setProjects] = useState<Project[]>(DEMO_PROJECTS)
  const [activeProjectId, setActiveProjectId] = useState<string | null>('1')
  const [mdContent, setMdContent] = useState(DEMO_MD)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved')
  const [lastSaved, setLastSaved] = useState<number | null>(null)
  const [editorLoaded, setEditorLoaded] = useState(false)
  const [messages, setMessages] = useState<AIMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [isAiGenerating, setIsAiGenerating] = useState(false)
  const [isAiReviewing, setIsAiReviewing] = useState(false)

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

  const [selectedJournal, setSelectedJournal] = useState(JOURNALS[0].value)
  const [typesettingProgress, setTypesettingProgress] = useState(0)
  const [isTypesetting, setIsTypesetting] = useState(false)
  const [typesetDone, setTypesetDone] = useState(false)
  const [latexOutput, setLatexOutput] = useState('')
  const [showPdfPreview, setShowPdfPreview] = useState(false)
  const [showNewProjectInput, setShowNewProjectInput] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [citations, setCitations] = useState<CitationRef[]>(ALL_REFERENCES)
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
  const [imagePlaceholderId, setImagePlaceholderId] = useState<string | null>(null)
  const [selectedBookIds, setSelectedBookIds] = useState<string[]>([])
  const [selectedBookForChapters, setSelectedBookForChapters] = useState<string | null>(null)
  const [selectedChapterIds, setSelectedChapterIds] = useState<string[]>([])
  const [showBookSelector, setShowBookSelector] = useState(false)
  const [showChapterSelector, setShowChapterSelector] = useState(false)

  const editorRef = useRef<HTMLDivElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const leftDropdownRef = useRef<HTMLDivElement>(null)
  const rightDropdownRef = useRef<HTMLDivElement>(null)
  const citationScopeRef = useRef<HTMLDivElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragStartX = useRef(0)
  const dragStartRatio = useRef(70)
  const savedRangeRef = useRef<Range | null>(null)

  const activeProject = projects.find((p) => p.id === activeProjectId)
  const currentJournal = JOURNALS.find((j) => j.value === selectedJournal) || JOURNALS[0]

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
  }, [citationScope, citationSearch, activeProjectId, selectedPaperIds, selectedBookIds, selectedBookForChapters])

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
    const html = editorRef.current?.innerHTML || renderMarkdown(mdContent)
    return extractOutline(html)
  }, [mdContent, editorLoaded, leftPanelMode])

  const wordCount = mdContent.replace(/\s/g, '').length

  // 从 GitHub 私库加载文档内容
  useEffect(() => {
    let cancelled = false
    async function loadDocument() {
      try {
        const doc = await readMdFile(PROJECT_DOC_PATH)
        if (cancelled) return
        if (doc?.content) {
          setMdContent(doc.content)
          setLastSaved(Date.now())
        }
      } catch (err) {
        console.warn('[Writing] 加载文档失败:', err)
      }
    }
    loadDocument()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (editorRef.current && !editorLoaded) {
      editorRef.current.innerHTML = renderMarkdown(mdContent)
      setEditorLoaded(true)
    }
  }, [mdContent, editorLoaded])

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

  // 自动保存到 GitHub 私库
  useEffect(() => {
    if (saveStatus !== 'unsaved') return
    const timer = setTimeout(() => {
      setSaveStatus('saving')
      writeMdFile(PROJECT_DOC_PATH, mdContent, 'Auto-save document')
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
  }, [mdContent, saveStatus])

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

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const handlePlaceholderClick = (e: Event) => {
      const customEvent = e as CustomEvent
      if (customEvent.detail?.id) {
        setImagePlaceholderId(customEvent.detail.id)
        imageInputRef.current?.click()
      }
    }
    editor.addEventListener('imagePlaceholderClick', handlePlaceholderClick)
    return () => {
      editor.removeEventListener('imagePlaceholderClick', handlePlaceholderClick)
    }
  }, [])

  const handleStageChange = useCallback((stage: string) => {
    if (!activeProjectId) return
    setProjects((prev) =>
      prev.map((p) => (p.id === activeProjectId ? { ...p, stage } : p))
    )
    const stageConfig = STAGES.find(s => s.value === stage)
    if (stageConfig) {
      setLeftPanelMode(stageConfig.leftPanel as LeftPanelMode)
      setRightPanelMode(stageConfig.rightPanel as RightPanelMode)
    }
  }, [activeProjectId])

  const handleEditorInput = () => {
    if (!editorRef.current) return
    const html = editorRef.current.innerHTML
    const md = htmlToMarkdown(html)
    setMdContent(md)
    setSaveStatus('unsaved')
  }

  const handleEditorPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) {
          const reader = new FileReader()
          reader.onload = (ev) => {
            const dataUrl = ev.target?.result as string
            insertImageAtCursor(dataUrl, file.name, true)
          }
          reader.readAsDataURL(file)
        }
        return
      }
    }
  }

  const saveSelection = () => {
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0)
      if (editorRef.current && editorRef.current.contains(range.commonAncestorContainer)) {
        savedRangeRef.current = range.cloneRange()
      }
    }
  }

  const restoreSelection = () => {
    const sel = window.getSelection()
    if (savedRangeRef.current && editorRef.current) {
      editorRef.current.focus()
      sel?.removeAllRanges()
      sel?.addRange(savedRangeRef.current.cloneRange())
      return true
    }
    if (editorRef.current) {
      editorRef.current.focus()
    }
    return false
  }

  const handleEditorSelect = () => {
    saveSelection()
  }

  const execCommand = (command: string, value?: string) => {
    restoreSelection()
    const result = document.execCommand(command, false, value)
    if (!result && (command === 'insertUnorderedList' || command === 'insertOrderedList')) {
      insertListManual(command === 'insertOrderedList')
    }
    saveSelection()
    handleEditorInput()
  }

  const insertListManual = (isOrdered: boolean) => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const text = sel.toString() || '列表项'
    const tag = isOrdered ? 'ol' : 'ul'
    const listHtml = `<${tag} style="margin:12px 0;padding-left:24px;"><li>${text}</li></${tag}><p><br></p>`
    document.execCommand('insertHTML', false, listHtml)
  }

  const insertCodeBlock = () => {
    restoreSelection()
    const sel = window.getSelection()
    const selectedText = sel?.toString() || ''
    const codeHtml = `<pre style="margin:16px 0;padding:16px;background:#0f172a;color:#f1f5f9;border-radius:8px;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:14px;line-height:1.6;"><code>${selectedText || '// 在此输入代码'}</code></pre><p><br></p>`
    document.execCommand('insertHTML', false, codeHtml)
    saveSelection()
    handleEditorInput()
  }

  const insertHeading = (level: number) => {
    execCommand('formatBlock', `h${level}`)
  }

  const insertHorizontalRule = () => {
    execCommand('insertHorizontalRule')
  }

  const insertLink = () => {
    restoreSelection()
    const sel = window.getSelection()
    const selectedText = sel?.toString() || ''
    const linkText = selectedText || '链接文字'
    const linkHtml = `<a href="https://" target="_blank" rel="noopener noreferrer" style="color:#4f46e5;text-decoration:underline;cursor:pointer;">${linkText}</a>`
    document.execCommand('insertHTML', false, linkHtml)
    saveSelection()
    handleEditorInput()
  }

  const insertImageAtCursor = (src: string, alt: string, fromPaste = false) => {
    restoreSelection()
    if (fromPaste && imagePlaceholderId && editorRef.current) {
      const placeholder = editorRef.current.querySelector(`[data-placeholder-id="${imagePlaceholderId}"]`)
      if (placeholder) {
        const imgHtml = `<div style="margin:16px 0;text-align:center;"><img src="${src}" alt="${alt}" style="max-width:100%;height:auto;border-radius:8px;border:1px solid #e2e8f0;" /><p style="font-size:12px;color:#64748b;margin-top:8px;">${alt}</p></div>`
        placeholder.outerHTML = imgHtml
        setImagePlaceholderId(null)
        saveSelection()
        handleEditorInput()
        return
      }
    }
    const html = `<div style="margin:16px 0;text-align:center;"><img src="${src}" alt="${alt}" style="max-width:100%;height:auto;border-radius:8px;border:1px solid #e2e8f0;" /><p style="font-size:12px;color:#64748b;margin-top:8px;">${alt}</p></div><p><br></p>`
    document.execCommand('insertHTML', false, html)
    saveSelection()
    handleEditorInput()
  }

  const insertImagePlaceholder = () => {
    saveSelection()
    restoreSelection()
    const placeholderId = `img-placeholder-${Date.now()}`
    const placeholderHtml = `<div data-placeholder-id="${placeholderId}" contenteditable="false" style="margin:16px 0;padding:40px 20px;border:2px dashed #cbd5e1;border-radius:8px;background:#f8fafc;text-align:center;cursor:pointer;" onclick="this.dispatchEvent(new CustomEvent('imagePlaceholderClick', {bubbles: true, detail: {id: '${placeholderId}'}}))">
      <div style="display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;">
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
          <circle cx="9" cy="9" r="2"/>
          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
        </svg>
        <span style="font-size:14px;color:#64748b;">点击添加图片或粘贴图片</span>
        <span style="font-size:12px;color:#94a3b8;">支持 JPG、PNG、GIF 等格式</span>
      </div>
    </div><p><br></p>`
    document.execCommand('insertHTML', false, placeholderHtml)
    setImagePlaceholderId(placeholderId)
    saveSelection()
    handleEditorInput()
  }

  const handleImageButtonClick = () => {
    if (!imagePlaceholderId) {
      insertImagePlaceholder()
    }
    imageInputRef.current?.click()
  }

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string
      insertImageAtCursor(dataUrl, file.name, true)
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const insertTableWithSize = (rows: number, cols: number) => {
    restoreSelection()
    const headerCells = Array.from({ length: cols }, () => `<th style="padding:10px 16px;font-size:14px;font-weight:600;background:#f8fafc;text-align:left;border-bottom:2px solid #e2e8f0;min-width:80px;">&nbsp;</th>`).join('')
    const bodyRows = Array.from({ length: rows }, () => {
      const cells = Array.from({ length: cols }, () => `<td style="padding:10px 16px;font-size:14px;border-bottom:1px solid #e2e8f0;min-width:80px;">&nbsp;</td>`).join('')
      return `<tr>${cells}</tr>`
    }).join('')
    const tableHtml = `<div style="margin:16px 0;overflow-x:auto;border:1px solid #e2e8f0;border-radius:8px;"><table style="width:100%;border-collapse:collapse;"><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table></div><p><br></p>`
    document.execCommand('insertHTML', false, tableHtml)
    saveSelection()
    handleEditorInput()
  }

  const insertCitation = (doi: string) => {
    restoreSelection()
    const citeHtml = `<sup style="color:#4f46e5;font-weight:500;cursor:pointer;">[${doi}]</sup>`
    document.execCommand('insertHTML', false, citeHtml)
    saveSelection()
    handleEditorInput()
    setShowCitationModal(false)
  }

  const insertSelectedCitations = () => {
    if (selectedCitations.length === 0) return
    restoreSelection()
    const cites = selectedCitations.map(d => `<sup style="color:#4f46e5;font-weight:500;cursor:pointer;">[${d}]</sup>`).join('')
    document.execCommand('insertHTML', false, cites)
    saveSelection()
    handleEditorInput()
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
    setIsAiGenerating(true)
    setIsAiReviewing(false)

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

      const genMsg: AIMessage = {
        id: String(Date.now() + 1),
        role: 'assistant',
        content: response.content,
        citations: trustedSearch ? response.citations : undefined,
        reviewStatus: 'pending',
      }
      setMessages((prev) => [...prev, genMsg])
      setIsAiGenerating(false)
      setIsAiReviewing(true)

      setTimeout(() => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === genMsg.id
              ? { ...m, reviewStatus: 'pass' as const }
              : m
          )
        )
        setIsAiReviewing(false)
      }, 1200)
    }, 1000)
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

  const handleCopyContent = (content: string) => {
    navigator.clipboard?.writeText(content).catch(() => {})
  }

  const startTypesetting = () => {
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
          const latex = markdownToLatex(mdContent, selectedJournal)
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
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, navCollapsed])

  const setPresetRatio = (ratio: number) => {
    setPanelRatio(ratio)
  }

  const handleOpenFolder = () => {
    folderInputRef.current?.click()
  }

  const handleCreateProject = () => {
    const name = newProjectName.trim()
    if (name) {
      setProjects((prev) => [...prev, { id: String(Date.now()), name, stage: 'topic', litCount: 0 }])
      setNewProjectName('')
      setShowNewProjectInput(false)
    }
  }

  const handleAddCitation = () => {
    if (!newCitation.title.trim() || !newCitation.doi.trim()) return
    const citation: CitationRef = {
      title: newCitation.title.trim(),
      authors: newCitation.authors.trim(),
      year: parseInt(newCitation.year) || new Date().getFullYear(),
      journal: newCitation.journal.trim(),
      doi: newCitation.doi.trim(),
      projectId: activeProjectId || undefined,
    }
    setCitations((prev) => [citation, ...prev])
    setNewCitation({ title: '', authors: '', year: '', journal: '', doi: '' })
    setShowAddCitationForm(false)
  }

  const handleDeleteCitation = (doi: string) => {
    setCitations((prev) => prev.filter((c) => c.doi !== doi))
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
      </aside>

      <button
        onClick={() => setNavCollapsed(!navCollapsed)}
        className="absolute left-0 top-1/2 -translate-y-1/2 z-20 bg-white border border-slate-200 rounded-r-lg p-1 shadow-md hover:bg-slate-50 transition text-slate-400 hover:text-indigo-600"
        style={{ left: navCollapsed ? '0' : '256px' }}
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
                    {activeProject.name}
                  </span>
                  <span className="px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded-full text-xs font-medium flex-shrink-0">
                    {STAGES.find((s) => s.value === activeProject.stage)?.label}
                  </span>
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 text-xs">
                {PANEL_RATIOS.map((r) => (
                  <button
                    key={r.value}
                    onClick={() => setPresetRatio(r.left)}
                    className={`px-2 py-0.5 rounded font-mono transition ${
                      Math.abs(panelRatio - r.left) < 5
                        ? 'bg-indigo-100 text-indigo-700 font-medium'
                        : 'bg-slate-50 text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {leftPanelMode === 'editor' && (
            <>
              <div className="flex items-center gap-0.5 px-3 py-1.5 bg-white border-b border-slate-200 flex-shrink-0">
                <button
                  onClick={() => insertHeading(1)}
                  className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
                  title="一级标题"
                >
                  <Heading1 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => insertHeading(2)}
                  className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
                  title="二级标题"
                >
                  <Heading2 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => insertHeading(3)}
                  className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
                  title="三级标题"
                >
                  <Heading3 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => insertHeading(4)}
                  className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
                  title="四级标题"
                >
                  <Heading4 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => insertHeading(5)}
                  className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
                  title="五级标题"
                >
                  <Heading5 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => insertHeading(6)}
                  className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
                  title="六级标题"
                >
                  <Heading6 className="w-4 h-4" />
                </button>
                <div className="w-px h-4 bg-slate-200 mx-1" />
                <button
                  onClick={() => execCommand('bold')}
                  className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
                  title="加粗"
                >
                  <Bold className="w-4 h-4" />
                </button>
                <button
                  onClick={() => execCommand('italic')}
                  className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
                  title="斜体"
                >
                  <Italic className="w-4 h-4" />
                </button>
                <div className="w-px h-4 bg-slate-200 mx-1" />
                <button
                  onClick={() => execCommand('insertUnorderedList')}
                  className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
                  title="无序列表"
                >
                  <List className="w-4 h-4" />
                </button>
                <button
                  onClick={() => execCommand('insertOrderedList')}
                  className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
                  title="有序列表"
                >
                  <ListOrdered className="w-4 h-4" />
                </button>
                <div className="w-px h-4 bg-slate-200 mx-1" />
                <button
                  onClick={insertHorizontalRule}
                  className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
                  title="分隔线"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <button
                  onClick={insertCodeBlock}
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
                  onClick={handleImageButtonClick}
                  className="p-1.5 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition"
                  title="插入图片 (支持粘贴)"
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

              <div className="flex-1 overflow-auto bg-white">
                <div className="max-w-3xl mx-auto p-8">
                  <div
                    ref={editorRef}
                    contentEditable
                    suppressContentEditableWarning
                    onInput={handleEditorInput}
                    onPaste={handleEditorPaste}
                    onSelect={handleEditorSelect}
                    onMouseUp={handleEditorSelect}
                    onKeyUp={handleEditorSelect}
                    onClick={handleEditorSelect}
                    className="min-h-full outline-none prose prose-slate max-w-none"
                  />
                </div>
              </div>

              <div className="px-4 py-1.5 bg-slate-50/80 border-t border-slate-200 flex items-center justify-between text-xs text-slate-400 flex-shrink-0">
                <span>所见即所得富文本编辑器 · 支持粘贴图片</span>
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
                <div className="mt-2 text-[11px] text-slate-400 flex items-center gap-1.5">
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
                        onClick={(e) => e.stopPropagation()}
                      >
                        <FileCode className="w-3 h-3" />
                        {cit.doi}
                        <ExternalLink className="w-3 h-3" />
                      </a>
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
          style={{ width: '6px' }}
          onMouseDown={handleDragStart}
        >
          <GripVertical className="w-3 h-3 text-slate-400" />
        </div>

        <div
          className="flex flex-col min-w-0 bg-white border-l border-slate-200"
          style={{ width: `calc(${100 - panelRatio}% - 6px)` }}
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
                    <span className="text-[11px] font-medium text-indigo-700">AI-1 生成</span>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-300" />
                  <div className="flex-1 flex items-center gap-1.5 px-2 py-1 bg-emerald-50 rounded-lg">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    <span className="text-[11px] font-medium text-emerald-700">AI-2 审阅</span>
                  </div>
                </div>

                <div className="flex items-center justify-between">
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
                <div className="mt-1.5 text-[10px] text-slate-400 leading-relaxed">
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
                          {citationScope === 'project' && activeProject && ` (${activeProject.name})`}
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
                          <div className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                            当前项目暂无关联文献，可从文献库添加
                          </div>
                        ) : (
                          <div className="space-y-1 max-h-40 overflow-y-auto">
                            {projectCitations.map((cit, idx) => (
                              <div key={idx} className="text-[11px] text-slate-600 bg-slate-50 rounded px-2 py-1.5 truncate">
                                {cit.title}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {citationScope === 'selected' && selectedPaperIds.length > 0 && (
                      <div className="mt-2">
                        <div className="text-[10px] text-slate-500 mb-1">已选文献</div>
                        <div className="space-y-1 max-h-40 overflow-y-auto">
                          {citations.filter(c => selectedPaperIds.includes(c.doi)).map((cit, idx) => (
                            <div key={idx} className="text-[11px] text-slate-600 bg-slate-50 rounded px-2 py-1.5 truncate">
                              {cit.title}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {citationScope === 'books' && selectedBookIds.length > 0 && (
                      <div className="mt-2">
                        <div className="text-[10px] text-slate-500 mb-1">已选图书</div>
                        <div className="space-y-1 max-h-40 overflow-y-auto">
                          {bookReferences.filter(b => selectedBookIds.includes(b.doi)).map((book, idx) => (
                            <div key={idx} className="text-[11px] text-slate-600 bg-slate-50 rounded px-2 py-1.5 truncate">
                              {book.title}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {citationScope === 'chapters' && selectedBook && (
                      <div className="mt-2">
                        <div className="text-[10px] text-slate-500 mb-1">
                          {selectedBook.title}
                        </div>
                        {selectedChapterIds.length > 0 ? (
                          <div className="space-y-1 max-h-40 overflow-y-auto">
                            {selectedBook.chapters.filter(ch => selectedChapterIds.includes(ch.id)).map((ch, idx) => (
                              <div key={idx} className="text-[11px] text-slate-600 bg-slate-50 rounded px-2 py-1.5">
                                {ch.title}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                            请选择章节
                          </div>
                        )}
                      </div>
                    )}

                    {folderPasted && (
                      <div className="mt-1.5 text-[10px] text-emerald-600 flex items-center gap-1 truncate">
                        <Check className="w-3 h-3 flex-shrink-0" />
                        <span className="truncate">{folderPath}</span>
                      </div>
                    )}
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
                    <p className="text-sm font-medium text-slate-600">AI 双引擎助手</p>
                    <p className="text-xs text-slate-400 mt-1">
                      AI-1 生成 + AI-2 审阅，确保内容可信
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
                          {msg.reviewStatus === 'pending' && (
                            <div className="flex items-center gap-2 px-2 py-1.5 bg-amber-50 rounded-lg text-[11px] text-amber-700">
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              AI-2 审阅中...
                            </div>
                          )}
                          {msg.reviewStatus === 'pass' && (
                            <div className="flex items-center gap-2 px-2 py-1.5 bg-emerald-50 rounded-lg text-[11px] text-emerald-700">
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
                              <div className="text-[11px] font-semibold text-slate-500 mb-2 flex items-center gap-1.5">
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
                                    <div className="text-[11px] text-slate-500 mt-1.5 ml-5">
                                      {cit.authors} ({cit.year}) · {cit.journal}
                                    </div>
                                    <div className="text-[11px] text-slate-400 mt-0.5 ml-5 italic">
                                      引用位置：第 {Math.floor(Math.random() * 10) + 1} 页 · 第 {Math.floor(Math.random() * 5) + 1} 段
                                    </div>
                                    <a
                                      href={`https://doi.org/${cit.doi}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-[11px] text-indigo-600 hover:text-indigo-800 flex items-center gap-1 mt-1.5 ml-5 font-medium"
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
                  <div className="mb-2 flex items-center gap-1.5 text-[10px] text-emerald-600">
                    <Zap className="w-3 h-3" />
                    <span>可信检索模式 · AI-1生成 + AI-2审阅</span>
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={handleOpenFolder}
                    className="flex items-center gap-1.5 px-3 py-2 text-[11px] bg-slate-50 border border-slate-200 text-slate-600 rounded-xl hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 transition flex-shrink-0"
                    title="从文件夹导入文献"
                  >
                    <FolderOpen className="w-4 h-4" />
                    <span>导入</span>
                  </button>
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
                    disabled={isAiGenerating || isAiReviewing || !inputValue.trim()}
                    className="px-3 py-2 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white rounded-xl text-sm hover:from-indigo-700 hover:to-indigo-800 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </div>
                {folderPasted && (
                  <div className="mt-2 flex items-center gap-1 text-[10px] text-emerald-600">
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
                <div className="mt-2 text-[11px] text-slate-400 flex items-center gap-1.5">
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
                        onClick={(e) => e.stopPropagation()}
                      >
                        <FileCode className="w-3 h-3" />
                        DOI
                        <ExternalLink className="w-3 h-3" />
                      </a>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          insertCitation(cit.doi)
                        }}
                        className="text-[11px] px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded hover:bg-indigo-100 transition font-medium"
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

                    <div className="p-3 bg-slate-900 rounded-lg overflow-x-auto max-h-64 overflow-y-auto">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[10px] text-slate-400 font-mono">LaTeX 输出</div>
                        <button
                          onClick={() => handleCopyContent(latexOutput)}
                          className="text-[10px] text-slate-400 hover:text-white flex items-center gap-1"
                        >
                          <Copy className="w-3 h-3" />
                          复制
                        </button>
                      </div>
                      <pre className="text-[11px] text-slate-300 font-mono leading-relaxed whitespace-pre-wrap">
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
                          a.download = `${activeProject?.name || 'paper'}.tex`
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
                        <div className="text-[11px] text-slate-500 mt-1">
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
                          <div className="text-[11px] text-slate-500 mt-1">
                            {book.authors} ({book.year})
                          </div>
                          <div className="text-[10px] text-amber-600 mt-0.5">
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
                    className={`px-2 py-1 text-[11px] rounded-lg transition ${
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
                          <div className="text-[11px] text-slate-500 mt-1">
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
                <span className="text-xs text-slate-500">— {currentJournal.label} 格式</span>
              </div>
              <button
                onClick={() => setShowPdfPreview(false)}
                className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-8 bg-slate-100">
              <div className="max-w-2xl mx-auto bg-white shadow-xl p-12 min-h-[800px]">
                <div className="text-center mb-8">
                  <h1 className="text-2xl font-bold text-slate-900 mb-2">
                    {activeProject?.name || 'Research Paper'}
                  </h1>
                  <p className="text-sm text-slate-600">Author Name · University / Institution</p>
                  <p className="text-xs text-slate-400 mt-1">{currentJournal.name}</p>
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
                    a.download = `${activeProject?.name || 'paper'}.tex`
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
        ref={imageInputRef}
        type="file"
        accept="image/*"
        onChange={handleImageUpload}
        className="hidden"
      />
      <input
        ref={folderInputRef}
        type="file"
        // @ts-ignore
        webkitdirectory=""
        directory=""
        multiple
        onChange={handleFolderSelect}
        className="hidden"
      />
    </div>
  )
}
