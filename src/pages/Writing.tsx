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
  ScanEye,
  GraduationCap,
  Newspaper,
  Copy,
  AlertTriangle,
  FolderOpen,
  Clipboard,
  GripVertical,
  BookPlus,
  Package,
  Upload,
  Trash2,
  CloudUpload,
  Square,
} from 'lucide-react'
import { toast } from 'sonner'
import { getAllTemplates, createTemplate, updateTemplate, listTemplateAssets, loadTemplateAsset } from '../services/journal-templates'
import { planTemplateAssets, collectTexFileRefs, resolveTexFileRef } from '../services/latex-assets'
import {
  extractGuidelinesWithAI,
  applyExtractedToTemplate,
} from '../services/guideline-extractor'
import {
  convertMarkdownToLatex,
  refineLatexWithAI,
  patchLatexFromSidecar,
  resyncSidecar,
  buildLatexSkeletonFromTemplate,
  parseLatexTemplate,
  type LatexSidecar,
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
import { abortError, isAbortError } from '../services/ai/abort'
import { loadAiSourceText } from '../services/literatureData'
import {
  loadProjects,
  saveProjects,
  loadManuscript,
  saveManuscript,
  loadManuscriptLatex,
  saveManuscriptLatex,
  loadLatexMap,
  saveLatexMap,
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
import { loadLiteratures, loadTitleCns, type Literature } from '../services/literatureData'
import { callAI } from '../services/ai/client'
import {
  searchCrossref,
  enrichWithAbstracts,
  normalizeDoi,
  preflightCitations,
  type OnlineSearchResult,
} from '../services/citation'
import { downloadRepoBinaryFile, readRepoTextFile, uploadRepoBinaryFile } from '../services/github'
import { dispatchAiCall } from '../services/workflowClient'
import { getRepoContext } from '../services/userData'
import VditorEditor, { type VditorEditorHandle, type VditorToolbarItem } from '../components/VditorEditor'
import FormulaSidebar, { type FormulaEditTarget } from '../components/FormulaSidebar'
import ProofreadPanel from '../components/ProofreadPanel'
import CitationPanel from '../components/CitationPanel'
import { parseFormulas, replaceNthFormula, replaceFormulaOccurrences, deleteFormulas, setImageSize } from '../services/formula'

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
  { value: 'proofread', label: '文稿校对', icon: ScanEye },
  { value: 'citations', label: '引用表', icon: BookMarked },
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

/** 从 LaTeX 源码里抓出正文图片：md 里的仓库路径在编译前已削成 images/xxx，只认这一层 */
function extractTexImagePaths(source: string): string[] {
  const out = new Set<string>()
  const re = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const p = m[1].trim()
    if (/^images\//.test(p)) out.add(p)
  }
  return Array.from(out)
}

/**
 * 运行时压根没加载起来时的提示（不是 TeX 排出来的错）。
 * 「预览（前端）」要先在浏览器里下约 110MB / 1800+ 个文件的 XeLaTeX 运行时，
 * 途中丢一个文件整个初始化就失败，而 fetch 只会留一句 "Failed to fetch"。
 * 重试已经在 worker 里做了，剩下的情况在这里说清楚怎么自救 —— 尤其是
 * 「再点一次不会重下」这一点，否则用户会以为要重新等一遍。
 */
const RUNTIME_LOAD_FAILED_HINT =
  '【提示】「预览（前端）」要在浏览器里跑 XeLaTeX，得先把运行时下到本地\n' +
  '（约 110MB、1800+ 个文件；只需下一次，之后走浏览器缓存）。\n' +
  '这次有文件没下下来 —— 多是网络抖动，或代理 / VPN 拦掉了一部分请求。\n' +
  '可以这样办：\n' +
  '  1) 再点一次「预览（前端）」：已下好的文件不会重下，通常第二次就过；\n' +
  '  2) 还不行就刷新页面重来；\n' +
  '  3) 只想要 PDF，直接点「正式编译（后端）」，那是在你私库里跑 GitHub Actions。\n' +
  '\n'

/** 异常是不是「运行时没加载起来」这一类（对照 worker 抛出来的那几种 message） */
function isRuntimeLoadFailure(message: string): boolean {
  return (
    /Failed to fetch|NetworkError|Load failed|net::ERR_/i.test(message) ||
    /Runtime (asset|manifest) .*could not be loaded/i.test(message) ||
    /The XeLaTeX worker could not initialize/i.test(message)
  )
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
    template:
      '请基于给出的检索结果逐条整理文献：标题、作者、年份、期刊、DOI，' +
      '并为每一条写一句中文小结（说清这篇做了什么、结论是什么）。\n\n研究主题：{topic}',
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

/**
 * 把 Crossref 的真实检索结果拼成【源材料】。
 *
 * 「找文献」不能只在你勾选的文献里找 —— 那样永远找不到库外文献（可信检索要的不是
 * 「只用库里已有的」，而是「不许瞎编」）。但也不能让 AI 自己"检索"：DeepSeek 没有联网
 * 能力，让它凭记忆报标题和 DOI 只会编。
 *
 * 折中：前端真去 Crossref 检索，把返回的真实记录当 ground truth 交给双引擎。
 * AI 只能引用这里列出的条目，AI-2 照旧逐条锚定 —— 「找得到外部文献」和「不许瞎编」
 * 两件事同时成立。
 */
function buildCrossrefSourceMaterial(topic: string, records: OnlineSearchResult[]): string {
  // Crossref 的 title / container-title 里常带换行和多余空白（甚至 <sup> 标记），
  // 原样喂给 AI 会让它"顺手整理一下"，一整理就和源材料对不上字面、被 AI-2 判成
  // 引证锚定失败，然后反复重写。这里先把空白压平，让源材料本身就是规整的。
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
  const blocks = records.map((r, i) => {
    const lines = [`[${i + 1}] DOI: ${flat(r.doi)}`]
    if (r.title) lines.push(`Title: ${flat(r.title)}`)
    if (r.authors) lines.push(`Authors: ${flat(r.authors)}`)
    if (r.year) lines.push(`Year: ${r.year}`)
    if (r.journal) lines.push(`Journal: ${flat(r.journal)}`)
    // 摘要给 AI 当"写中文小结"的依据。个别摘要很长，截一下，免得十几篇把调用预算吃光。
    if (r.abstract) lines.push(`Abstract: ${flat(r.abstract).slice(0, 1500)}`)
    return lines.join('\n')
  })
  return `--- Crossref 检索结果（检索词：${topic}）---\n\n${blocks.join('\n\n')}`
}

/**
 * 从 AI 的返回里按 DOI 抠出中文小结。
 *
 * 不按行号硬对齐：模型偶尔会漏一篇、或者把 DOI 写成大写/带 https://doi.org/ 前缀。
 * 所以对每篇已知的 DOI 去全文找"提到它的那一行"，取 DOI 之后的部分当小结 ——
 * 找不到就跳过这篇（卡片上不显示小结），而不是整体失败。
 */
function parseOnlineSummaries(text: string, dois: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  for (const doi of dois) {
    const needle = doi.toLowerCase()
    const line = lines.find((l) => l.toLowerCase().includes(needle))
    if (!line) continue
    const rest = line.slice(line.toLowerCase().indexOf(needle) + doi.length)
    // 去掉箭头/冒号这类分隔符，剩下的就是小结
    const summary = rest.replace(/^[\s:：=＝\-–—>＞|,，、)）\]]+/, '').trim()
    if (summary) out[doi] = summary
  }
  return out
}

/**
 * AI-1 对「源材料未提及」的字段会按约定输出内部标记 `[NOT_IN_SOURCE] <说明>`。
 * 那是给系统识别的，不该让用户看到，直接连标记带内容删掉：
 *   - 整行的字段值就是个标记（如 `- **作者**：[NOT_IN_SOURCE] 作者`）→ 整行删掉，
 *     否则会剩下「**作者**：」这种空壳；
 *   - 标记夹在句子中间（如 `…的方式；[NOT_IN_SOURCE] 结论。`）→ 切掉标记及其后的说明，
 *     再去掉遗留的悬空分隔符（`；`/`，`/`：` 等）。
 */
function stripNotInSource(text: string): string {
  return text
    .split('\n')
    .flatMap((line) => {
      // 整条字段值缺失 → 整行去掉（留空行会在列表里撑出一道缝）
      if (/[：:]\s*\[NOT_IN_SOURCE\]/.test(line)) return []
      if (!line.includes('[NOT_IN_SOURCE]')) return [line]
      return [line.slice(0, line.indexOf('[NOT_IN_SOURCE]')).replace(/[\s；;，,、：:]+$/, '')]
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

/**
 * 从一句需求里取一个能放在按钮上的短名字。
 *
 * 快捷指令的按钮就那么宽，把整句需求当名字会直接被截断 ——
 * 所以只取第一个短句、再截到 8 个字（用户随时可以在弹窗里改）。
 */
function shortActionName(requirement: string): string {
  const head = requirement.split(/[，。；：、,.!?！？\s]/).filter(Boolean)[0] || requirement.trim()
  return head.slice(0, 8)
}

/**
 * 把中文研究主题转成 Crossref 能用的英文检索词。
 *
 * 起因是实测：Crossref 的 query.bibliographic 实际上只认英文 ——
 * 传「Pd 催化的 gem-二氟环丙烷开环氢脱氟反应」进去，返回的是一堆 1985~1995 年的
 * 冷门中文文献，完全跑偏；换成英文关键词，第一篇就是目标文献。所以中文主题先转英文。
 *
 * 只让它输出关键词串（不做整句翻译），避免把长句塞进检索接口。
 */
async function toEnglishSearchQuery(topic: string): Promise<string> {
  const { ai1 } = useSettingsStore.getState().getDualEngineConfig()
  const resp = await callAI({
    baseUrl: ai1.baseUrl,
    apiKey: ai1.apiKey,
    model: ai1.model,
    messages: [
      {
        role: 'system',
        content:
          '你是学术检索助手。把用户给的中文研究主题转成一条用于文献数据库检索的英文关键词串：' +
          '只输出英文关键词或短语本身，用空格分隔；不要引号、不要解释、不要换行、不要布尔运算符。' +
          '控制在 12 个词以内，保留专有名词与化合物名。',
      },
      { role: 'user', content: topic },
    ],
  })
  return resp.content.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ')
}

/**
 * 在一个字段里找关键词。命中就返回**该字段的内容本身**（不是"命中在哪"的标注）——
 * 关键词由 HighlightedSnippet 高亮出来，用户一眼能看出是哪里命中的。
 *
 * 短字段（标题 / 作者 / 期刊 / 关键词 / DOI）整条给出，不截断；
 * 只有摘要这类长文本才截一个以关键词为中心的窗口，否则一整段摘要会把侧栏塞满。
 */
function hitInField(value: string, query: string, isLongText = false): string | null {
  const flat = (value || '').replace(/\s+/g, ' ').trim()
  if (!flat) return null
  const idx = flat.toLowerCase().indexOf(query)
  if (idx === -1) return null
  if (!isLongText) return flat
  const start = Math.max(0, idx - 30)
  const end = Math.min(flat.length, idx + query.length + 60)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/**
 * 库内检索：把一篇文献的每个字段都过一遍，返回全部命中的内容。
 * 顺序即展示优先级 —— 标题命中最说明问题，摘要命中放最后。
 */
function findLibraryHits(query: string, paper: Literature, titleCn: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const candidates: Array<[string, boolean]> = [
    [titleCn, false],
    [paper.title, false],
    [paper.authors, false],
    [paper.journal, false],
    [paper.keywords, false],
    [paper.abstractCn, true],
    [paper.abstractEn, true],
    [paper.doi, false],
  ]
  const hits: string[] = []
  for (const [value, isLong] of candidates) {
    const hit = hitInField(value, q, isLong)
    if (hit) hits.push(hit)
  }
  return hits
}

/** 归一化后拼成完整的 DOI 链接（库里存的是裸 DOI） */
function doiLinkOf(doi: string): string {
  return `https://doi.org/${normalizeDoi(doi).doi ?? doi}`
}

/** 把命中片段里的关键词标出来。用切片拼节点，不走 dangerouslySetInnerHTML */
function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  const i = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (i === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-amber-100 text-amber-900 rounded-sm px-0.5">
        {text.slice(i, i + query.length)}
      </mark>
      {text.slice(i + query.length)}
    </>
  )
}

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
  | 'proofread'
  | 'citations'
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
    return `<code class="bg-ink-100 text-ink-700 px-1.5 py-0.5 rounded text-xs font-mono text-seal-600">${escapeHtml(code)}</code>`
  })

  html = html.replace(/^###### (.*)$/gm, '<h6 class="text-sm font-semibold text-ink-700 mt-4 mb-2">$1</h6>')
  html = html.replace(/^##### (.*)$/gm, '<h5 class="text-base font-semibold text-ink-700 mt-4 mb-2">$1</h5>')
  html = html.replace(/^#### (.*)$/gm, '<h4 class="text-lg font-semibold text-ink-800 mt-5 mb-2">$1</h4>')
  html = html.replace(/^### (.*)$/gm, '<h3 class="text-xl font-semibold text-ink-800 mt-6 mb-3">$1</h3>')
  html = html.replace(/^## (.*)$/gm, '<h2 class="text-2xl font-bold text-ink-800 mt-6 mb-3 pb-2 border-b border-ink-200">$1</h2>')
  html = html.replace(/^# (.*)$/gm, '<h1 class="text-3xl font-bold text-ink-900 mt-2 mb-4 pb-3 border-b-2 border-seal-200">$1</h1>')

  html = html.replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-ink-800">$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em class="italic text-ink-700">$1</em>')

  html = html.replace(/^> (.*)$/gm, (_, content) => {
    return `<blockquote class="border-l-4 border-seal-300 pl-4 py-1 my-3 bg-seal-50/50 text-ink-600 italic rounded-r">${content}</blockquote>`
  })

  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    return `<div class="my-4"><img src="${src}" alt="${alt}" class="max-w-full h-auto rounded-lg border border-ink-200 shadow-sm" /><p class="text-sm text-ink-500 mt-2 text-center font-medium">${alt}</p></div>`
  })

  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-seal-600 hover:text-seal-800 underline underline-offset-2">${text}</a>`
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
      result.push(`<p class="my-3 text-ink-700 leading-relaxed">${paraBuffer.join(' ')}</p>`)
      paraBuffer = []
    }
  }

  const flushTable = () => {
    if (inTable && tableHeader && tableRows.length > 0) {
      const headerCells = tableHeader.split('|').filter((c) => c.trim())
      const rowHtml = tableRows
        .map((row) => {
          const cells = row.split('|').filter((c) => c.trim())
          return `<tr class="border-b border-ink-200 hover:bg-paper-100 transition-colors">${cells
            .map((c) => `<td class="px-4 py-2.5 text-sm text-ink-700">${c.trim()}</td>`)
            .join('')}</tr>`
        })
        .join('')
      result.push(
        `<div class="my-4 overflow-x-auto rounded-lg border border-ink-200 shadow-sm">
          <table class="w-full text-left">
            <thead class="bg-paper-100">
              <tr class="border-b-2 border-ink-200">
                ${headerCells.map((c) => `<th class="px-4 py-2.5 text-sm font-semibold text-ink-700">${c.trim()}</th>`).join('')}
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
      result.push(`<pre class="my-4 p-4 bg-ink-900 text-ink-100 rounded-lg overflow-x-auto text-sm font-mono shadow-inner"><code>${escapeHtml(code.trim())}</code></pre>`)
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
      if (!inUl) { result.push('<ul class="my-3 space-y-1.5 list-disc list-outside pl-6 text-ink-700">'); inUl = true }
      result.push(`<li>${ulMatch[1]}</li>`)
      continue
    }

    const olMatch = trimmed.match(/^\d+\. (.*)$/)
    if (olMatch) {
      flushPara()
      if (inUl) { result.push('</ul>'); inUl = false }
      if (!inOl) { result.push('<ol class="my-3 space-y-1.5 list-decimal list-outside pl-6 text-ink-700">'); inOl = true }
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
  /**
   * 双引擎跑起来是分钟级的（后端要排队 + 冷启动 + 多次大模型调用），
   * 只给一句静态的「AI-1 生成中...」用户会以为卡死了。这里数已等秒数。
   */
  const [aiElapsed, setAiElapsed] = useState(0)
  /**
   * 依赖取的是「是否在忙」这一个布尔值，而不是两个状态各自的变化 ——
   * 否则 AI-1 交棒给 AI-2 的那一刻计时会归零，"已等"就骗人了。
   */
  const aiBusy = isAiGenerating || isAiReviewing
  useEffect(() => {
    if (!aiBusy) {
      setAiElapsed(0)
      return
    }
    const timer = window.setInterval(() => setAiElapsed((s) => s + 1), 1000)
    return () => window.clearInterval(timer)
  }, [aiBusy])
  const [isLoading, setIsLoading] = useState(true)

  const [navCollapsed, setNavCollapsed] = useState(false)
  /**
   * 左侧栏是「堆叠面板」：项目、文献检索、大纲三块**共同占满**整条栏。
   * 每块都能收起成一行（收起的那块不再吃高度，让给另外两块）；展开的块按 flex-1
   * 平分剩余高度，但各自带一个 min-height 兜底 —— 栏再矮也不会把某一块挤到看不见，
   * 实在放不下就让整栏滚动，而不是牺牲掉其中一块。
   */
  const [projectsExpanded, setProjectsExpanded] = useState(true)
  /** 大纲面板是否展开（收起时只剩「大纲」标题行） */
  const [outlineExpanded, setOutlineExpanded] = useState(true)
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
  /** 引用体检结果：非空时弹出闸门，让用户决定「先回去修」还是「明知会 [?] 也继续」 */
  const [citeGate, setCiteGate] = useState<{
    total: string[]
    resolved: string[]
    unresolved: string[]
    malformed: string[]
  } | null>(null)
  const [citationSearch, setCitationSearch] = useState('')
  const [selectedCitations, setSelectedCitations] = useState<string[]>([])

  // ── 公式侧栏（编辑器内部临时侧栏，点工具栏「公式」开关） ──
  const [showFormulaPanel, setShowFormulaPanel] = useState(false)
  /** 非空 = 正在改正文里第 N 个公式（否则是新建） */
  const [formulaEditTarget, setFormulaEditTarget] = useState<FormulaEditTarget | null>(null)

  const [templates, setTemplates] = useState<JournalTemplate[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('')
  // ── LaTeX 工作区：代码板（上半） + 编译器（下半） ──
  /** 代码板里的完整 LaTeX 源码：可手改，也可由正文 / 期刊模板生成 */
  const [latexCode, setLatexCode] = useState('')
  /**
   * 块映射（sidecar，存 projects/<id>/latex-map.json）。
   * 「改 md → 只更正对应 LaTeX 片段」全靠它；它不进 .tex，正文保持干净。
   */
  const [latexSidecar, setLatexSidecar] = useState<LatexSidecar | null>(null)
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
  // ── 正式编译（后端，GitHub Actions）：与浏览器内 WASM 并列的第二条通道 ──
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

  // ── 侧栏「文献检索」—— 只搜库内；库外检索是 AI 助手里「找文献」的活 ──
  const [libSearchExpanded, setLibSearchExpanded] = useState(true)
  const [libSearch, setLibSearch] = useState('')
  /** doi → 中文标题。中文标题只长在对译 md 里，得读文件，所以缓存住 */
  const [titleCnMap, setTitleCnMap] = useState<Record<string, string>>({})
  const [isLoadingTitleCn, setIsLoadingTitleCn] = useState(false)
  /** 中文标题只需在会话内批量读一次，别每敲一个字就重来 */
  const titleCnLoadedRef = useRef(false)

  // ── 插入引用：本地 / 在线（中英文）──
  const [citationSource, setCitationSource] = useState<'local' | 'online'>('local')
  const [onlineQuery, setOnlineQuery] = useState('')
  const [onlineResults, setOnlineResults] = useState<OnlineSearchResult[]>([])
  const [isSearchingOnline, setIsSearchingOnline] = useState(false)
  /** 在线检索结果的中文小结（DOI → 一句话），由「AI 中文小结」按钮按需生成 */
  const [onlineSummaries, setOnlineSummaries] = useState<Record<string, string>>({})
  const [isSummarizingOnline, setIsSummarizingOnline] = useState(false)
  const [importedDois, setImportedDois] = useState<string[]>([])

  void saveBookReferences

  /** 编辑区可能落在左边或右边，两个 ref 都留着；插入引用/跳转时取已挂载的那个 */
  const leftEditorRef = useRef<VditorEditorHandle>(null)
  const rightEditorRef = useRef<VditorEditorHandle>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const aiInputRef = useRef<HTMLTextAreaElement>(null)
  /** 当前 AI 助手指令的取消句柄：点「停止」立刻不再接收后端输出（详见 ai/abort.ts） */
  const aiAbortRef = useRef<AbortController | null>(null)
  const leftDropdownRef = useRef<HTMLDivElement>(null)
  const rightDropdownRef = useRef<HTMLDivElement>(null)
  const citationScopeRef = useRef<HTMLDivElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const packageFileInputRef = useRef<HTMLInputElement>(null)
  const packageFolderInputRef = useRef<HTMLInputElement>(null)
  /** 上传 journal sample .tex：同一个 input 服务两个入口（新建 / 覆盖当前模板） */
  const texTemplateInputRef = useRef<HTMLInputElement>(null)
  const texImportModeRef = useRef<'create' | 'overwrite'>('create')
  /** 上传出版社的整包投稿模板（.zip），交给后端解包 */
  const texPackageInputRef = useRef<HTMLInputElement>(null)
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

  /**
   * 用户开始在侧栏检索时，把库里所有文献的中文标题读出来。
   * 中文标题不在 CSV 里，只长在对译 md 的标题块中 —— 不读文件就既搜不到中文，
   * 也展示不出来。挂在「开始输入」而不是「页面加载」上：不搜就不读，
   * 免得每次打开写作页都白拉一遍全库的 md。
   */
  useEffect(() => {
    if (!libSearchExpanded || !libSearch.trim() || availablePapers.length === 0) return
    if (titleCnLoadedRef.current) return
    titleCnLoadedRef.current = true
    let cancelled = false
    setIsLoadingTitleCn(true)
    loadTitleCns(availablePapers.map((p) => p.doi))
      .then((map) => {
        if (!cancelled) setTitleCnMap((prev) => ({ ...prev, ...map }))
      })
      .catch((err) => {
        console.warn('[Writing] 读取中文标题失败:', err)
        titleCnLoadedRef.current = false // 失败允许下次重试
      })
      .finally(() => {
        if (!cancelled) setIsLoadingTitleCn(false)
      })
    return () => {
      cancelled = true
    }
  }, [libSearchExpanded, libSearch, availablePapers])

  /** 库内检索结果：每条带上「命中在哪个字段」和那段上下文 */
  const librarySearchResults = useMemo(() => {
    const q = libSearch.trim()
    if (!q) return []
    const found: Array<{ paper: Literature; titleCn: string; hits: string[] }> = []
    for (const p of availablePapers) {
      const titleCn = titleCnMap[p.doi] || ''
      const hits = findLibraryHits(q, p, titleCn)
      if (hits.length > 0) found.push({ paper: p, titleCn, hits })
    }
    return found.slice(0, 12)
  }, [libSearch, availablePapers, titleCnMap])

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
    // 不要 Vditor 自带的「引用块」（quote）：正文里的引用一律走下面我们自己的
    // [@doi:…] 标记，留一个长得像的默认按钮只会让人以为那是引用功能
    'line', 'code', 'inline-code', '|',
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
        const [manuscript, refs, memoryMd, savedLatex, savedBib, savedMap] = await Promise.all([
          loadManuscript(projectId),
          loadReferences(projectId),
          loadMemory(projectId),
          loadManuscriptLatex(projectId),
          loadBibtex(projectId),
          loadLatexMap(projectId),
        ])
        if (cancelled) return

        // 块映射（sidecar）：局部更新要靠它把 md 的改动落到 tex 的对应片段上
        try {
          setLatexSidecar(savedMap ? (JSON.parse(savedMap) as LatexSidecar) : null)
        } catch {
          setLatexSidecar(null)
        }

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
    if (!latexCode.trim() && !latexBib.trim() && !latexSidecar) return
    const timer = setTimeout(() => {
      if (latexCode.trim()) {
        saveManuscriptLatex(activeProjectId, latexCode).catch(() => {})
      }
      if (latexBib.trim()) {
        saveBibtex(activeProjectId, latexBib).catch(() => {})
      }
      // 块映射与 tex 一起落盘，避免「tex 更新了、映射还是旧的」导致下次局部更新错位
      if (latexSidecar) {
        saveLatexMap(activeProjectId, JSON.stringify(latexSidecar, null, 2)).catch(() => {})
      }
    }, 1200)
    return () => clearTimeout(timer)
  }, [latexCode, latexBib, latexSidecar, activeProjectId])

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
   * 跨栏联动：定这次操作该用哪一侧的编辑区。
   *
   * 编辑区已在某一侧显示 → 直接用那一侧，布局不动；
   * 两侧都没有 → 把 `from` 的**对侧**切成编辑区，`from` 这一栏保持原样 ——
   * 校对清单不会因为点一次跳转而消失，也不用再把它调回来。
   * `mounted=false` 表示刚切换，Vditor 实例还没建，得等挂载完再调。
   */
  const pickEditor = (from: 'left' | 'right') => {
    const visible =
      leftPanelMode === 'editor' ? 'left' : rightPanelMode === 'editor' ? 'right' : null
    const side = visible ?? (from === 'left' ? 'right' : 'left')
    if (!visible) (side === 'left' ? setLeftPanelMode : setRightPanelMode)('editor')
    return { ref: side === 'left' ? leftEditorRef : rightEditorRef, mounted: visible !== null }
  }

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

  /**
   * 取当前挂载的编辑区（左边优先，其次右边）—— 编辑区可以被放在任意一侧。
   * 拿不到就说明正文编辑器根本没挂载（两侧面板被配对规则切成别的了），
   * 这时候必须报出来 —— 早先这里用 `?.` 静默吞掉，用户看到的就是「点了没反应」。
   */
  const requireEditor = () => {
    const ed = primaryEditor()
    if (!ed) {
      toast.error('正文编辑器当前没打开：请把左侧面板切到「编辑」，再插入')
      return null
    }
    return ed
  }

  /**
   * 引用标记只放 DOI。
   * `[@doi:…]` 是转换链路的约定标记：extractCitationsFromMarkdown 认它，
   * 生成 LaTeX 时 replaceCitationMarkers 会把它换成 \cite{key}。
   * 具体排成上标还是作者年、用哪套样式，都属于排版阶段的事，这里不预设。
   */
  const citationMarker = (doi: string) => `[@doi:${normalizeDoi(doi).doi || doi}]`

  /** 在正文光标处插入引用标记 */
  const insertCitation = (doi: string) => {
    const ed = requireEditor()
    if (!ed) return
    // 用 insertAtCursor 而不是 insertValue：点按钮时焦点已经不在编辑器上了，
    // insertValue 会插到文档开头（详见 VditorEditor 里 savedRangeRef 的说明）
    ed.insertAtCursor(citationMarker(doi))
    setSaveStatus('unsaved')
    setShowCitationModal(false)
  }

  const insertSelectedCitations = () => {
    if (selectedCitations.length === 0) return
    const ed = requireEditor()
    if (!ed) return
    // 一条一个标记：extractCitationsFromMarkdown 是按单个 [@…] 整段取 DOI 的，
    // 写成 [@doi:a, @doi:b] 会被当成一个非法 DOI 直接丢掉
    ed.insertAtCursor(selectedCitations.map(citationMarker).join(''))
    setSaveStatus('unsaved')
    setSelectedCitations([])
    setShowCitationModal(false)
  }

  /** 公式插进正文时补上定界符：行内 $…$ / 行间 $$…$$ */
  const formatFormula = (tex: string, kind: 'inline' | 'block') =>
    kind === 'inline' ? ` $${tex}$ ` : `\n$$\n${tex}\n$$\n`

  /** 打开公式侧栏；target 非空表示「改正文里第 N 个公式」。from = 发起侧 */
  const openFormulaPanel = (target: FormulaEditTarget | null, from: 'left' | 'right' = 'left') => {
    // 公式侧栏挂在编辑区面板内部，先确保编辑区在对侧可见
    pickEditor(from)
    setFormulaEditTarget(target)
    setShowFormulaPanel(true)
  }

  /** 从校对清单点「改这条」：把正文里第 index 个公式丢进公式侧栏 */
  const editFormulaAt = (index: number, from: 'left' | 'right' = 'left') => {
    const f = parseFormulas(mdContent)[index]
    if (!f) return
    openFormulaPanel({ index, tex: f.tex, kind: f.kind }, from)
  }

  /**
   * 跳到正文里第 index 个「图 / 表 / 公式」（文稿校对用）。
   * `from` 是发起跳转的面板所在侧 —— 编辑区就在另一侧滚过去，不在则把那一侧开出来。
   *
   * `match` 传这一条的原文内容，编辑器优先按内容在 DOM 里认（序号法在 IR 模式下不可靠）。
   */
  const jumpToBlock = (
    kind: 'image' | 'table' | 'formula',
    index: number,
    match?: string,
    from: 'left' | 'right' = 'left',
  ) => {
    const { ref, mounted } = pickEditor(from)
    if (mounted) ref.current?.scrollToBlock(kind, index, match)
    else setTimeout(() => ref.current?.scrollToBlock(kind, index, match), 140)
  }

  /**
   * 从引用表跳到正文里引用它的位置（同样跨栏：编辑区不在这一侧就滚到另一侧）。
   * occurrence = 这篇文献在正文里第几次出现 —— 引用表右侧每个小点点对应一处。
   */
  const jumpToCitation = (doi: string, from: 'left' | 'right', occurrence = 0) => {
    const marker = citationMarker(doi)
    const { ref, mounted } = pickEditor(from)
    const run = () => ref.current?.scrollToText(marker, occurrence)
    if (mounted) run()
    else setTimeout(run, 140)
  }

  /** 收掉正文里当前的高亮（引用表的点点再点一次的语义） */
  const clearCitationHighlight = () => {
    leftEditorRef.current?.clearHighlight()
    rightEditorRef.current?.clearHighlight()
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

  const handleSendMessage = async (
    prompt?: string,
    opts?: {
      /**
       * 覆盖【源材料】的取法。默认只从「引用范围」里勾选的文献取全文，但快捷指令
       * 需要例外：「找文献」要用 Crossref 的真实检索结果，「引用检验」要锁定用户
       * 填的那个 DOI —— 两者都不该被引用范围下拉框限制住。
       */
      sourceMaterialProvider?: () => Promise<string>
      /**
       * 取回结构化条目挂到 AI 消息上（「找文献」用）。
       * 在 provider 跑完之后才调用，所以实现里可以直接读 provider 填好的变量。
       */
      attachCitations?: () => CitationRef[]
    },
  ) => {
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

    // 「停止」的句柄：从读文献正文那一秒就能停，不必等进了 AI 轮询才有反应
    const controller = new AbortController()
    aiAbortRef.current = controller

    // 预先插入 AI 助手占位消息，方便后续按 id 增量更新内容/审阅状态
    const genMsgId = String(Date.now() + 1)
    const genMsg: AIMessage = {
      id: genMsgId,
      createdAt: Date.now() + 1,
      role: 'assistant',
      content: opts?.sourceMaterialProvider
        ? '正在检索文献…'
        : trustedSearch
          ? '正在读取文献正文…'
          : '正在调用 AI-1 生成内容…',
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
      /** 正文没读到的文献 DOI —— 不静默：最后要告诉用户这次结论少了几篇依据 */
      let sourceMissing: string[] = []
      if (opts?.sourceMaterialProvider) {
        literatureContext = await opts.sourceMaterialProvider()
      } else if (trustedSearch) {
        // 同一篇文献在正文里常被引注多次 —— 按 DOI 去重后**再**截前 5 篇。
        // 不去重的话同一篇文章会被读两遍、在【源材料】里出现两份：既白烧 token，
        // 又让 AI 在同一段重复证据上反复引证。去重放在截断之前，才能真的凑满 5 篇。
        const seenDoiKeys = new Set<string>()
        const sourceDois: string[] = []
        for (const c of scopedCitations) {
          if (c.type !== 'paper' || !c.doi) continue
          const key = c.doi.trim().toLowerCase()
          if (!key || seenDoiKeys.has(key)) continue
          seenDoiKeys.add(key)
          sourceDois.push(c.doi)
          if (sourceDois.length >= 5) break
        }
        if (sourceDois.length > 0) {
          const loaded = await Promise.all(
            sourceDois.map(async (doi) => {
              try {
                // 取「清洗后的原文块」，不是 MinerU 的脏 full.md —— 详见 loadAiSourceText 的注释
                return { doi, text: (await loadAiSourceText(doi)).trim() }
              } catch (err) {
                // 以前这里是 catch { return '' }：单篇失败无声无息，AI 拿着残缺依据照答，
                // 用户只觉得"结论怪怪的"。现在记下来，最后一并交代哪几篇没读到。
                console.warn(`[Writing] 读取 ${doi} 正文失败:`, err)
                return { doi, text: '' }
              }
            }),
          )
          literatureContext = loaded
            .filter((x) => x.text)
            .map((x) => `--- ${x.doi} ---\n${x.text}`)
            .join('\n\n')
          sourceMissing = loaded.filter((x) => !x.text).map((x) => x.doi)
        }
      }

      // 取正文期间用户可能已经点了「停止」—— 那就别再往下发 AI 请求了
      if (controller.signal.aborted) throw abortError()

      // 正文取完了，接下来是 AI 的活 —— 把占位文案换回来
      setMessages((prev) =>
        prev.map((m) => (m.id === genMsgId ? { ...m, content: '正在调用 AI-1 生成内容…' } : m)),
      )

      if (!literatureContext) {
        throw new Error(
          sourceMissing.length > 0
            ? `可信检索需要文献正文，但这几篇一条都没读到：${sourceMissing.join('、')}。请确认它们已经转换完成（库里有 {slug}.md 或 full.md）。`
            : '可信检索模式需要至少一篇引用文献的正文。请在引用范围中选择文献，或确保文献已通过 MinerU 提取全文。',
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
        // 后端默认 5 轮（= 最多 10 次大模型调用，每次都要把整份源材料再传一遍）。
        // 这只是"AI-2 打回后自动重写"的机会数，通过就停；降到 2 轮，最坏 4 次调用。
        maxAttempts: 2,
        signal: controller.signal,
        onProgress: (event) => {
          // AI-1 完成后立即把生成内容回填到消息（提升体感速度）
          if (event.stage === 'ai1_done' && event.ai1Output) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === genMsgId
                  ? { ...m, content: stripNotInSource(event.ai1Output || m.content) }
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
      const lastAttempt = result.attempts[result.attempts.length - 1]
      /*
       * 「AI-2 一个字都没输出」和「AI-2 判定内容不忠实」是两码事，不能都报成"审阅未通过"。
       * 前者的实情是：输出预算（max_tokens）被推理过程烧完了，正文一个字没吐，JSON 当然解析不出来，
       * 后端只能返回 passed=false —— 界面上却显示成"未通过核查"，等于骗人。
       */
      const ai2Silent = lastAttempt?.ai2Silent ?? !(lastAttempt?.ai2RawOutput || '').trim()
      const reviewNote = passed
        ? ''
        : ai2Silent
          ? `\n\n---\n*AI-2 这一轮**没有任何输出**（第 ${result.attempts.length} 轮）—— 这不是"内容不忠实"，而是后台输出预算被推理占满了。这个结论不可信，请重试；源材料越长越容易触发。*`
          : `\n\n---\n*AI-2 审阅未通过（${result.attempts.length} 轮）：${result.ai2Feedback?.summary || '存在忠实性问题，请人工核对'}*`

      const missingNote =
        sourceMissing.length > 0
          ? `\n\n---\n*这次有 ${sourceMissing.length} 篇文献的正文没读到（${sourceMissing.join('、')}），结论只基于其余文献。*`
          : ''

      const attached = opts?.attachCitations?.() ?? []

      setMessages((prev) =>
        prev.map((m) =>
          m.id === genMsgId
            ? {
                ...m,
                content:
                  stripNotInSource(result.ai1Output || '（AI-1 未返回内容）') + missingNote + reviewNote,
                citations: attached.length > 0 ? attached : undefined,
                reviewStatus: passed ? ('pass' as const) : ('fail' as const),
              }
            : m
        )
      )
    } catch (err) {
      setIsAiGenerating(false)
      setIsAiReviewing(false)
      if (isAbortError(err)) {
        // 用户主动停止：不是失败，别报错也别让人以为配置有问题
        setMessages((prev) =>
          prev.map((m) =>
            m.id === genMsgId ? { ...m, content: '_（已停止）_', reviewStatus: undefined } : m,
          ),
        )
      } else {
        const msg = err instanceof Error ? err.message : String(err)
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
    } finally {
      if (aiAbortRef.current === controller) aiAbortRef.current = null
    }
  }

  /** 停止 AI 助手当前这条指令：前端立刻不再接收后端输出，并让后端也停下（省额度） */
  const stopAi = () => {
    aiAbortRef.current?.abort()
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

  /**
   * 不进 AI 的直接回答：把用户消息和固定答复一起塞进对话。
   * 用于「填错了/库里没有」这类能当场判定、不该浪费一次 AI 调用的情况。
   */
  const pushFixedReply = (prompt: string, reply: string) => {
    const now = Date.now()
    setInputValue('')
    setMessages((prev) => [
      ...prev,
      { id: String(now), createdAt: now, role: 'user', content: prompt },
      { id: String(now + 1), createdAt: now + 1, role: 'assistant', content: reply },
    ])
  }

  const sendQuickAction = () => {
    const prompt = composeActionPrompt()
    if (!prompt || actionIncomplete || !activeAction) return
    const action = activeAction
    const values = actionValues
    setActiveActionKey(null)

    // ── 「找文献」：先真检索，再交给双引擎 ──
    // 默认链路只把「引用范围」里勾选的文献当源材料，于是"找文献"永远只能找到
    // 你已经收藏的那几篇 —— 等于没用。这里改成前端先打 Crossref 拿真实记录，
    // 再让 AI 基于这些记录作答（AI-2 照旧逐条锚定，编不出来）。
    if (action.kind === 'builtin' && action.def.key === 'find-papers') {
      const topic = (values.topic || '').trim()
      // 检索到的条目挂到 AI 消息上：回复里除了 AI 的整理，还会列出结构化条目，
      // 每条都能点开原文、一键复制 DOI 链接。
      let found: CitationRef[] = []
      handleSendMessage(prompt, {
        sourceMaterialProvider: async () => {
          // 中文主题先转英文 —— Crossref 基本上只认英文，中文 query 会返回一堆
          // 1980 年代的冷门中文文献（实测）。纯英文/混合主题直接原样检索。
          const keyword = /[\u4e00-\u9fff]/.test(topic) ? await toEnglishSearchQuery(topic) : topic
          // 多取一些再筛：Crossref 会把同一篇论文的"补充材料"（DOI 以 .s001 结尾）
          // 也当成独立条目返回，不筛的话结果一半是这类重复项。
          const hits = (await searchCrossref(keyword, 20))
            .filter((r) => !/\.s\d{3}$/.test(r.doi))
            .slice(0, 10)
          if (hits.length === 0) {
            throw new Error(
              `Crossref 没有检索到与「${topic}」相关的文献` +
                (keyword === topic ? '' : `（已自动转成英文检索词：${keyword}）`) +
                '。换个更具体的关键词，或直接用英文关键词再试。',
            )
          }
          // Crossref 只有一半记录带 abstract，缺的走 OpenAlex 批量补一次 ——
          // 回答里要给每篇写中文小结，依据就是这些摘要
          const records = await enrichWithAbstracts(hits)
          found = records.map((r) => ({
            id: r.doi,
            doi: r.doi,
            title: r.title,
            authors: r.authors,
            year: r.year,
            journal: r.journal,
            type: 'paper' as const,
          }))
          return buildCrossrefSourceMaterial(keyword, records)
        },
        attachCitations: () => found,
      })
      return
    }

    // ── 「引用检验」：先判 DOI，库外直接给固定回答，不进 AI ──
    // 可信检索只能基于文献原文核验。库外文献没有全文，交给 AI 只会得到编造的判断，
    // 所以当场拦住并说清怎么办，比让 AI 猜一个"看起来很像"的结论好。
    if (action.kind === 'builtin' && action.def.key === 'verify-citation') {
      const rawDoi = (values.doi || '').trim()
      const parsed = normalizeDoi(rawDoi)
      if (!parsed.valid || !parsed.doi) {
        pushFixedReply(
          prompt,
          `「${rawDoi}」不是一个能识别的 DOI，没法核验。\n\n` +
            '下面这些写法都能认：\n' +
            '- `10.1021/jacs.3c07992`\n' +
            '- `https://doi.org/10.1021/jacs.3c07992`\n' +
            '- `doi:10.1021/jacs.3c07992`',
        )
        return
      }
      const doi = parsed.doi
      const inLibrary = availablePapers.some((p) => (p.doi || '').trim().toLowerCase() === doi)
      if (!inLibrary) {
        pushFixedReply(
          prompt,
          `这篇文献不在你的文献库里（DOI：\`${doi}\`），所以没法核验。\n\n` +
            '可信检索只基于**文献原文**做核验；库外文献没有全文，交给 AI 只会编出一个看着很像的结论。\n\n' +
            '先把这篇文献入库（管理页 →「快捷 DOI 入库」），等全文转换完成后再回来检验。',
        )
        return
      }
      handleSendMessage(prompt, {
        sourceMaterialProvider: async () => {
          const fulltext = await loadAiSourceText(doi)
          if (!fulltext.trim()) {
            throw new Error(
              `文献库里有 ${doi} 这条记录，但没有它的正文（{slug}.md / full.md 都读不到内容），无法核验。先让它走一遍 MinerU 转换。`,
            )
          }
          return `--- ${doi} ---\n${fulltext}`
        },
      })
      return
    }

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
        setNewActionLabel(shortActionName(requirement))
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
      setOnlineSummaries({})
      if (results.length === 0) toast.info('没有检索到结果，换个关键词试试')
      // Crossref 只有一半左右记录带摘要，缺的走 OpenAlex 补一次（失败就不补，不影响检索）
      const withAbstracts = await enrichWithAbstracts(results)
      setOnlineResults(withAbstracts)
    } catch (err) {
      console.error('[Writing] 在线检索失败:', err)
      toast.error(err instanceof Error ? err.message : '在线检索失败')
    } finally {
      setIsSearchingOnline(false)
    }
  }

  /**
   * 给当前这批检索结果生成中文小结。
   *
   * 走一次轻量 AI（跟「中文主题转英文检索词」同一条链路），按 DOI 把结果填回各自卡片。
   * 做成手动按钮而不是检索完自动跑：检索只是随手看看时不该额外等一分钟、花一次钱。
   */
  const handleSummarizeOnline = async () => {
    const usable = onlineResults.filter((r) => r.abstract)
    if (usable.length === 0) {
      toast.error('这批结果都没取到摘要，写不了小结')
      return
    }
    setIsSummarizingOnline(true)
    try {
      const { ai1 } = useSettingsStore.getState().getDualEngineConfig()
      const body = usable
        .map((r, i) => `[${i + 1}] DOI: ${r.doi}\nTitle: ${r.title}\nAbstract: ${r.abstract.slice(0, 1500)}`)
        .join('\n\n')
      const resp = await callAI({
        baseUrl: ai1.baseUrl,
        apiKey: ai1.apiKey,
        model: ai1.model,
        messages: [
          {
            role: 'system',
            content:
              '你是学术文献助手。用户会给若干篇文献的标题与摘要，请为每一篇写一句中文小结' +
              '（30-60 字，说清这篇做了什么、结论是什么，不要复述标题）。\n' +
              '输出格式：每行一条，以该篇的 DOI 开头，紧跟 " => "，然后是中文小结。' +
              '不要序号、不要 markdown、不要任何多余解释。',
          },
          { role: 'user', content: body },
        ],
      })
      const parsed = parseOnlineSummaries(resp.content, usable.map((r) => r.doi))
      const n = Object.keys(parsed).length
      if (n === 0) {
        toast.error('AI 没有按 DOI 逐条返回，稍后再试或换个模型')
        return
      }
      setOnlineSummaries((prev) => ({ ...prev, ...parsed }))
      toast.success(`已为 ${n} 篇生成中文小结`)
    } catch (err) {
      console.error('[Writing] 生成中文小结失败:', err)
      toast.error(err instanceof Error ? err.message : '生成中文小结失败')
    } finally {
      setIsSummarizingOnline(false)
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

  /** 侧栏检索结果的一键复制：复制的是完整 DOI 链接，不是裸 DOI */
  const handleCopyDoiLink = (doi: string) => {
    navigator.clipboard?.writeText(doiLinkOf(doi)).then(
      () => toast.success('已复制 DOI 链接'),
      () => toast.error('复制失败'),
    )
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
  const generateLatexFromMarkdown = async (opts?: { skipCiteGate?: boolean }) => {
    if (!currentTemplate) {
      toast.error('请先在「期刊模板」面板创建并选择一个期刊模板')
      return
    }
    if (!mdContent.trim()) {
      toast.error('正文为空，先写点东西吧')
      return
    }

    // ── 引用体检闸门 ──
    // 正文里如果有「CrossRef 查不到的 DOI」或「根本不像 DOI 的 [@...] 标记」，
    // 生成出来会在 .tex 里留下一条 .bib 里没有的 \cite，编译后 PDF 上是 [?]。
    // 这一步不阻止用户，但**必须在生成之前当面说清楚**，让用户自己决定，
    // 而不是等他投出去以后被审稿人告知。
    if (!opts?.skipCiteGate) {
      setIsGeneratingLatex(true)
      setLatexGenStatus('引用体检中...')
      try {
        const pre = await preflightCitations(mdContent)
        if (pre.unresolved.length > 0 || pre.malformed.length > 0) {
          setCiteGate(pre)
          return
        }
      } catch {
        // 体检本身失败（网络等）不该挡住出稿 —— 放行，正式生成时还会再查一次
      } finally {
        setIsGeneratingLatex(false)
        setLatexGenStatus('')
      }
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
      setLatexSidecar(result.sidecar)
      setCompileError('')

      // 块映射缺失 + 模板合规：都不阻塞出稿，但必须让用户看见
      const mapped = result.sidecar.blocks.length
      if (result.anchor_check?.missing.length) {
        toast.warning(
          `已生成，但 ${result.anchor_check.missing.length} 个段落没能建好映射 —— ` +
            '以后改 md 做「局部更新」时这些段落会整段重写（其余段落仍逐字更正）。',
          { duration: 9000 },
        )
      } else {
        toast.success(`已生成 LaTeX，${mapped} 个段落全部建立了映射，可在代码板继续修改`)
      }
      if (result.template_compliance && !result.template_compliance.passed) {
        toast.warning(
          `AI-2 模板合规审查：${result.template_compliance.summary || '发现不符合模板的地方'}（${result.template_compliance.issues.length} 条）`,
          { duration: 10000 },
        )
      }
    } catch (err) {
      toast.error(`生成失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsGeneratingLatex(false)
      setLatexGenStatus('')
    }
  }

  /**
   * 改完 md 后的**局部更新** —— 「转换后还想改文字」的正确路径。
   *
   * 绝大多数改动是**纯文字替换**：不调 AI、不润色，直接把 md 里改的那几处
   * 换到 tex 的对应片段上。只有替换不成（改动跨了 LaTeX 语法）才回退 AI，
   * 并且把「哪几段回退了」明确说出来。
   */
  const runLatexLocalUpdate = async () => {
    if (!currentTemplate) {
      toast.error('请先在「期刊模板」面板创建并选择一个期刊模板')
      return
    }
    if (!latexCode.trim()) {
      toast.error('代码板是空的：先点一次「由正文生成」')
      return
    }
    if (!latexSidecar || latexSidecar.blocks.length === 0) {
      toast.error(
        '还没有「块映射」（这次生成的稿子可能是旧版本产出的）。请先点一次「由正文生成」重建映射，之后改字就能只改对应片段。',
        { duration: 10000 },
      )
      return
    }
    const { ai1, ai2 } = useSettingsStore.getState().getDualEngineConfig()
    setIsGeneratingLatex(true)
    setLatexGenStatus('准备中...')
    try {
      const result = await patchLatexFromSidecar({
        currentLatex: latexCode,
        newMarkdown: mdContent,
        sidecar: latexSidecar,
        template: currentTemplate,
        ai1,
        ai2,
        onProgress: (e) => setLatexGenStatus(e.message || ''),
      })
      setLatexCode(result.latex)
      setLatexSidecar(result.sidecar)
      setCompileError('')

      toast.success(
        `局部更新完成：逐字改 ${result.deterministic} 段（未走 AI）/ AI 重写 ${result.regenerated} 段 / 删除 ${result.dropped} 段 / 未动 ${result.untouched} 段`,
        { duration: 9000 },
      )
      if (result.notes.length > 0) {
        // 需要人看的说明一条都不藏：回退了 AI 的、被手改过没同步的，都在这里
        toast.warning(result.notes.join('；'), { duration: 15000 })
      }
      if (result.compliance && !result.compliance.passed) {
        toast.warning(
          `AI-2 模板合规审查：${result.compliance.summary || '发现不符合模板的地方'}`,
          { duration: 10000 },
        )
      }
    } catch (err) {
      toast.error(`局部更新失败：${err instanceof Error ? err.message : String(err)}`)
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
    // 代码板被模板内容整篇替换了，旧的块映射不再适用
    setLatexSidecar(null)
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
    setLatexSidecar(null) // 代码板换成模板内容，旧块映射作废
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
   * 上传期刊官方的 sample .tex，解析成模板。
   * -------------------------------------------------
   * 让 AI 从「投稿须知」的文字里猜 documentclass / 宏包只能是猜；期刊自己给的
   * sample .tex 才是排版事实。解析走确定性正则（parseLatexTemplate），不调 AI，
   * 上传即得、也不会幻觉。整份原文存进 template_tex —— 之后 md→tex 拼装直接拿它
   * 当外壳（见 assembleFullLatex），宏包选项、宏包顺序、\newcommand 一个都不丢；
   * 同时抽出的命令骨架会喂给 AI 当结构范式，出来的稿子才像那个期刊。
   */
  const handleImportTexTemplate = async (file: File | null | undefined) => {
    if (!file) return
    const tex = await file.text()
    if (!tex.trim()) {
      toast.error('文件是空的')
      return
    }
    const parsed = parseLatexTemplate(tex)

    // 只覆盖解析到的字段：一份只有正文、没有 \documentclass 的 .tex 不该把
    // 已有模板的文档类/栏数冲成默认值。
    const fields: Partial<JournalTemplate> = { template_tex: tex }
    if (parsed.documentClass) {
      fields.document_class = parsed.documentClass
      fields.document_options = parsed.documentOptions
      fields.two_column = parsed.twoColumn
      if (parsed.fontSize) fields.font_size = parsed.fontSize
    }
    if (parsed.packages.length) fields.packages = parsed.packages
    if (parsed.bibtexStyle) fields.bibtex_style = parsed.bibtexStyle
    if (parsed.preamble) fields.custom_preamble = parsed.preamble

    setIsCreatingTemplate(true)
    setTemplateCreateStatus(`解析 ${file.name}...`)
    try {
      const overwrite = texImportModeRef.current === 'overwrite' && currentTemplate
      let targetId: string
      if (overwrite) {
        targetId = currentTemplate!.id
        await updateTemplate(targetId, fields)
      } else {
        const created = await createTemplate({
          name: newTemplateName.trim() || file.name.replace(/\.tex$/i, ''),
        })
        await updateTemplate(created.id, fields)
        targetId = created.id
        setShowNewTemplateForm(false)
        setNewTemplateName('')
      }
      const list = await getAllTemplates()
      setTemplates(list)
      const target = list.find((t) => t.id === targetId)
      if (target) adoptNewTemplate(target)
      toast.success(
        overwrite
          ? `已按 ${file.name} 更新模板`
          : `已从 ${file.name} 解析并创建模板，原文已载入代码板`,
      )
    } catch (err) {
      toast.error(`解析失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsCreatingTemplate(false)
      setTemplateCreateStatus('')
    }
  }

  /**
   * 上传出版社的整包投稿模板（.zip），由后端解包成期刊模板。
   * -------------------------------------------------
   * 期刊给的模板往往不是一个 .tex，而是一整包：主 sample .tex + .cls/.sty/.bst
   * + 页眉页脚图片 + 专用字体。所以解包必须在后端做（浏览器里拼不出 assets/），
   * 流程是：先把 zip 提交进私库 templates/packages/，再 dispatch 后端
   * template_unpack，等它写出 templates/journals/<slug>/ 后刷新模板列表。
   */
  const handleImportTemplatePackage = async (file: File | null | undefined) => {
    if (!file) return
    if (!/\.zip$/i.test(file.name)) {
      toast.error('请选择 .zip 投稿模板包')
      return
    }
    const ctx = getRepoContext()
    if (!ctx) {
      toast.error('未登录或未选择仓库，无法上传模板包')
      return
    }
    const pkgName = file.name.replace(/\.zip$/i, '')
    const pkgPath = `templates/packages/${file.name}`
    setIsCreatingTemplate(true)
    try {
      setTemplateCreateStatus(`上传 ${file.name}...`)
      await uploadRepoBinaryFile(
        ctx.owner,
        ctx.repo,
        pkgPath,
        file,
        ctx.token,
        `chore(templates): 上传投稿模板包 ${file.name}`,
      )

      setTemplateCreateStatus('后端解包中（首次约 1~2 分钟）...')
      const taskId = `tplunpack_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const outputPath = `temp/ai/template_unpack/${taskId}.json`
      await dispatchAiCall(
        taskId,
        'template_unpack',
        { package_path: pkgPath, journal_name: newTemplateName.trim() || pkgName },
        outputPath,
        1,
        ctx.owner,
        ctx.repo,
        ctx.token,
      )

      // 轮询后端结果（3s × 200 = 10min，与其它 AI 任务一致）
      let unpacked: {
        slug: string
        name: string
        asset_count: number
        file_count?: number
        main_tex: string
        ai_review?: {
          /** ok = 审完了；truncated / unavailable = **没审成**（不是「不通过」） */
          status?: 'ok' | 'truncated' | 'unavailable'
          passed?: boolean | null
          summary: string
          issues: Array<{ area: string; problem: string; suggestion: string }>
        }
        warnings?: string[]
        cross_check?: { packages_only_in_ai: string[]; packages_only_in_regex: string[] }
      } | null = null
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        const raw = await readRepoTextFile(ctx.owner, ctx.repo, outputPath, ctx.token)
        if (!raw) continue
        const parsed = JSON.parse(raw.content)
        if (parsed.error) throw new Error(parsed.error)
        if (parsed.done) {
          unpacked = parsed.data
          break
        }
      }
      if (!unpacked) throw new Error('后端解包超时（10 分钟未返回）')

      const list = await getAllTemplates()
      setTemplates(list)
      const target = list.find((t) => t.id === unpacked!.slug)
      if (target) adoptNewTemplate(target)
      setShowNewTemplateForm(false)
      setNewTemplateName('')

      // 解包结果按「好的坏的都说」呈现：整包保住了几个文件、AI-2 复核过没过、
      // 有哪些需要注意的地方，一条都不藏。
      const info = unpacked
      const review = info.ai_review
      const warnCount = info.warnings?.length || 0
      toast.success(
        `已解包「${info.name}」：主模板 ${info.main_tex}，整包 ${info.file_count ?? info.asset_count} 个文件全部保留`,
        { duration: 8000 },
      )
      // 三态：审出问题 ≠ 没审成。把「截断导致没审成」说成「复核未通过」是纯误报，
      // 会把用户吓得以为模板有问题 —— 所以这里分开说。
      if (review && review.status && review.status !== 'ok') {
        toast.info(
          `AI-2 复核「${info.name}」这次没跑完（${review.status === 'truncated' ? '输出被截断' : '无输出'}），` +
            '不代表模板有问题，请人工过目一下模板的 meta.md。',
          { duration: 12000 },
        )
      } else if (review && review.passed === false) {
        toast.warning(
          `AI-2 复核「${info.name}」发现 ${review.issues.length} 条问题：${review.summary || '见模板 meta.md'}`,
          { duration: 12000 },
        )
      }
      if (warnCount > 0) {
        toast.warning(`该模板有 ${warnCount} 条注意事项，已写入模板的 meta.md`, { duration: 9000 })
      }
    } catch (err) {
      toast.error(`解包失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsCreatingTemplate(false)
      setTemplateCreateStatus('')
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
      // 整篇被 AI 重写过：能对上号的片段留着，对不上的丢掉（宁可重写也不留错位映射）
      setLatexSidecar((prev) => (prev ? resyncSidecar(result.latex, prev) : prev))
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

  /**
   * 取「期刊模板自带、且当前源码真的引用到了」的资源文件。
   *
   * 出版社模板解包后整包文件都在 templates/journals/<slug>/assets/ 下（徽标、页眉图、
   * 字体、.bst/.bib），但之前一件都没挂进编译，模板 .tex 里一句
   * \includegraphics{head_foot/RSC_LOGO_CMYK} 就让 XeTeX 在 -halt-on-error 下直接失败 ——
   * 用户看到的是「你们下载的官方模板都编不过」。
   *
   * 只挂被引用到的几件（整包十几 MB 全下载没有意义）；引用不到的**点名报出来**，
   * 不让用户对着一句 not found 去猜是哪个文件。
   */
  const collectTemplateAssets = async (): Promise<{
    files: Array<{ path: string; data: Uint8Array }>
    missing: string[]
  }> => {
    if (!currentTemplate) return { files: [], missing: [] }
    const assetPaths = await listTemplateAssets(currentTemplate.id)
    if (assetPaths.length === 0) return { files: [], missing: [] }
    const plan = planTemplateAssets(latexCode, assetPaths)
    const files: Array<{ path: string; data: Uint8Array }> = []
    // 队列里带「assets 里的实际路径 from」和「编译目录里要放的路径 to」——
    // 两者通常一样；只有引用的写法与真实文件名对不上时才会分开（见 resolveTexFileRef）。
    const queue: Array<{ from: string; to: string }> = plan.files.map((f) => ({ ...f }))
    const placed = new Set(plan.files.map((f) => f.to))

    while (queue.length > 0) {
      const { from, to } = queue.shift() as { from: string; to: string }
      setCompileStatus(`正在加载模板资源 ${to}...`)
      const data = await loadTemplateAsset(currentTemplate.id, from)
      if (!data) continue
      files.push({ path: to, data })
      // 模板自带的类文件内部还会去磁盘上找东西（USG.cls 的 \maketitle 里就有
      // \includegraphics{Wiley_logo.eps}，而图在 assets/images/ 下）。主 .tex 里
      // 看不到这层依赖，只能把类文件读出来再顺着找一遍。
      if (!/\.(cls|sty|clo|def)$/i.test(from)) continue
      for (const ref of collectTexFileRefs(new TextDecoder().decode(data))) {
        const hit = resolveTexFileRef(ref, assetPaths)
        // 类文件里有大量条件引用（\IfFileExists、注释掉的备用分支），
        // 解不出来的一律不报缺件 —— 那是噪声，不是这次编译真会缺的东西。
        if (!hit || placed.has(hit.to)) continue
        placed.add(hit.to)
        queue.push(hit)
      }
    }
    return { files, missing: plan.missing }
  }

  /**
   * 正文里引用的图片：md 存的是仓库路径，编译目录里图片就挂在 images/ 下。
   * 只取当前源码真引用到的那几张（项目图片目录可能攒了一堆没用的）。
   */
  const collectProjectImages = async (): Promise<Array<{ path: string; data: Uint8Array }>> => {
    const ctx = getRepoContext()
    if (!ctx || !activeProjectId) return []
    const refs = extractTexImagePaths(latexCode)
    if (refs.length === 0) return []
    const files: Array<{ path: string; data: Uint8Array }> = []
    for (const rel of refs) {
      setCompileStatus(`正在加载图片 ${rel}...`)
      const res = await downloadRepoBinaryFile(
        ctx.owner,
        ctx.repo,
        `projects/${activeProjectId}/${rel}`,
        ctx.token,
      )
      if (!res) continue
      files.push({ path: rel, data: new Uint8Array(await res.blob.arrayBuffer()) })
    }
    return files
  }

  /** 缺件提示：把文件名念出来，而不是让用户去日志里找 */
  const warnMissingTemplateAssets = (missing: string[]) => {
    if (missing.length === 0) return
    toast.warning(
      `模板里没有这些文件，编译会在它们上报 not found：` +
        `${missing.slice(0, 5).join('、')}` +
        (missing.length > 5 ? ` 等 ${missing.length} 个` : ''),
      { duration: 12000 },
    )
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

      // 期刊模板整包留下的 assets/ 也要挂进去（见 collectTemplateAssets 注释）
      setCompileStatus('正在检查模板自带资源...')
      const tplAssets = await collectTemplateAssets()
      warnMissingTemplateAssets(tplAssets.missing)
      additionalFiles.push(...tplAssets.files)

      // 正文里的图片
      additionalFiles.push(...(await collectProjectImages()))

      const result = await compileLatex({
        source: latexCode,
        bibtex: latexBib.trim() || undefined,
        additionalFiles,
        onStatus: (e) => setCompileStatus(e.message),
      })
      setPdfObjectUrl(createPdfObjectUrl(result.pdf))
      setCompileStatus(`预览编译完成 · ${result.passes} 趟 XeTeX${result.bibtexRan ? ' + BibTeX' : ''}`)
      toast.success('预览编译完成')
    } catch (err) {
      const log = getCompileErrorLog(err)
      const raw = log || (err instanceof Error ? err.message : String(err))
      setCompileError(
        log
          ? withRuntimeHint(log)
          : isRuntimeLoadFailure(raw)
            ? RUNTIME_LOAD_FAILED_HINT + raw
            : raw,
      )
      setCompileStatus('')
      toast.error('预览编译失败，见下方日志')
    } finally {
      setIsCompiling(false)
    }
  }

  /**
   * 正式编译（后端）：把源文件提交进私库，叫起 GitHub Actions 跑官方 TeX Live 镜像。
   * 与浏览器内 WASM 编译并列 —— 那边快但宏包/版本被运行时钉死，这边慢但什么包都能用。
   */
  const compileInCloud = async () => {
    if (!latexCode.trim()) {
      toast.error('代码板为空，先生成或粘贴 LaTeX 源码')
      return
    }
    if (!activeProjectId) {
      toast.error('先选一个项目 —— 正式编译（后端）的产物要落到项目目录里')
      return
    }
    setIsCloudCompiling(true)
    setCompileError('')
    setCloudRunUrl('')
    setCompileStatus('正在准备正式编译（后端）...')
    try {
      // 期刊模板自带资源同样要挂（见 collectTemplateAssets 注释）——
      // 云端是把文件提交进私库、以 main.tex 所在目录为工作目录跑 latexmk，
      // 所以这些文件要在同一个目录里按相对路径存在。
      const tplAssets = await collectTemplateAssets()
      warnMissingTemplateAssets(tplAssets.missing)
      const images = await collectProjectImages()

      const result = await compileOnGitHub(
        activeProjectId,
        latexCode,
        latexBib.trim() || undefined,
        {
          onStage: (s) => setCompileStatus(s),
          onRunUrl: (url) => setCloudRunUrl(url),
          extraFiles: [...tplAssets.files, ...images],
        },
      )
      setPdfObjectUrl(createPdfObjectUrl(result.pdf))
      setCompileStatus('正式编译完成（官方 TeX Live）')
      toast.success('正式编译完成')
    } catch (err) {
      setCompileError(err instanceof Error ? err.message : String(err))
      setCompileStatus('')
      toast.error('正式编译失败，见下方日志')
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
    <div ref={containerRef} className="h-full flex bg-paper-100 relative overflow-hidden">
      <aside
        className={`bg-paper-50 border-r border-ink-200 flex flex-col flex-shrink-0 transition-all duration-300 ${
          navCollapsed ? 'w-0 opacity-0 overflow-hidden border-r-0' : 'w-64 opacity-100'
        }`}
      >
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* ── 堆叠面板 1/3：项目（收起后只剩标题行，标题显示当前项目） ── */}
          <div
            className={`flex flex-col ${
              projectsExpanded ? 'min-h-0' : 'flex-none'
            }`}
          >
            <div className="flex items-center gap-0.5 pl-1 pr-2 py-1.5 border-b border-ink-200 flex-shrink-0">
              <button
                onClick={() => setProjectsExpanded(!projectsExpanded)}
                className="flex-1 min-w-0 flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-paper-100 transition"
                title={projectsExpanded ? '收起项目' : '展开项目'}
              >
                {projectsExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 text-ink-400 flex-shrink-0" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-ink-400 flex-shrink-0" />
                )}
                <FileText className="w-4 h-4 text-seal-600 flex-shrink-0" />
                <span className="text-sm font-semibold text-ink-800 truncate">
                  {projectsExpanded ? '项目导航' : activeProject?.title || '项目导航'}
                </span>
              </button>
              <button
                onClick={() => setShowNewProjectInput(!showNewProjectInput)}
                className="p-1 flex-shrink-0 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded transition"
                title="新建项目"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>

            {projectsExpanded && (
              <>
                {(showNewProjectInput || activeProject) && (
                  <div className="px-3 py-2 border-b border-ink-100 flex-shrink-0 space-y-2">
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
                          className="flex-1 px-2 py-1 text-sm border border-ink-200 rounded focus:outline-none focus:border-seal-400 focus:ring-1 focus:ring-seal-100"
                        />
                        <button
                          onClick={handleCreateProject}
                          className="px-2 py-1 bg-seal-600 text-paper-50 text-xs rounded hover:bg-seal-700 transition"
                        >
                          创建
                        </button>
                      </div>
                    )}
                    {activeProject && (
                      <button
                        onClick={() => openProjectLitModal(activeProject.projectId)}
                        className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs text-seal-600 bg-seal-50/60 hover:bg-seal-100 rounded-md transition"
                        title="给当前项目补充文献（项目内临时知识库）"
                      >
                        <BookPlus className="w-3.5 h-3.5" />
                        添加项目文献
                      </button>
                    )}
                  </div>
                )}
                <div className="flex-auto min-h-0 overflow-y-auto">
                  {projects.length === 0 && !isLoading && (
                    <div className="p-4 text-center">
                      <div className="text-sm text-ink-500 mb-2">暂无项目</div>
                      <button
                        onClick={() => setShowNewProjectInput(true)}
                        className="text-xs text-seal-600 hover:text-seal-700 font-medium"
                      >
                        点击创建第一个项目
                      </button>
                    </div>
                  )}
                  {projects.map((p) => (
                    <button
                      key={p.projectId}
                      onClick={() => setActiveProjectId(p.projectId)}
                      className={`w-full text-left px-3 py-2.5 border-b border-ink-100 hover:bg-paper-100 transition ${
                        activeProjectId === p.projectId ? 'bg-seal-50/60 border-l-2 border-l-seal-600' : ''
                      }`}
                    >
                      <div className="text-sm font-medium text-ink-700 truncate">{p.title}</div>
                      <div className="flex items-center justify-end mt-1">
                        <span className="text-xs text-ink-400 flex items-center gap-1">
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

          {/* ── 堆叠面板 2/3：文献检索（只搜库内） ── */}
          <div
            className={`border-t border-ink-200 flex flex-col ${
              libSearchExpanded ? 'min-h-0' : 'flex-none'
            }`}
          >
            <button
              onClick={() => setLibSearchExpanded(!libSearchExpanded)}
              className="w-full flex-shrink-0 flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-ink-600 hover:bg-paper-100 transition"
              title={libSearchExpanded ? '收起文献检索' : '展开文献检索'}
            >
              {libSearchExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-ink-400" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-ink-400" />
              )}
              <Search className="w-3.5 h-3.5 text-seal-600" />
              文献检索
              <span className="ml-auto text-ink-400 font-normal">
                {libSearch.trim() ? librarySearchResults.length : availablePapers.length}
              </span>
            </button>
            {libSearchExpanded && (
              <div className="flex-auto min-h-0 flex flex-col">
                <div className="flex-shrink-0 px-2 pb-1.5">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-ink-400" />
                    <input
                      type="text"
                      value={libSearch}
                      onChange={(e) => setLibSearch(e.target.value)}
                      placeholder="标题 / 作者 / 期刊 / 关键词 / 摘要"
                      className="w-full pl-7 pr-6 py-1.5 text-xs border border-ink-200 rounded-md focus:outline-none focus:border-seal-400 focus:ring-1 focus:ring-seal-100"
                    />
                    {libSearch && (
                      <button
                        onClick={() => setLibSearch('')}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-600"
                        title="清空"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  <div className="mt-1 text-[0.625rem] text-ink-400 leading-snug">
                    只搜你的文献库。库外文献用 AI 助手的「找文献」。
                    {isLoadingTitleCn && ' 正在读取中文标题…'}
                  </div>
                </div>
                <div className="flex-auto min-h-0 overflow-y-auto px-2 pb-2 space-y-1.5">
                  {libSearch.trim() && librarySearchResults.length === 0 && (
                    <div className="text-[0.6875rem] text-ink-400 text-center py-3">
                      没找到匹配的文献
                    </div>
                  )}
                  {librarySearchResults.map(({ paper, titleCn, hits }) => {
                    const q = libSearch.trim()
                    const meta = [paper.authors, paper.year || '', paper.journal]
                      .filter(Boolean)
                      .join(' · ')
                    // 命中的内容如果本来就已经显示在上面几行了（标题/作者/期刊），
                    // 就就地高亮，不再另起一行重复一遍；只有命中在关键词/摘要/DOI
                    // 这些没露过面的字段上时，才额外显示一行内容。
                    const extra = hits.find(
                      (h) => !`${titleCn} ${paper.title} ${meta}`.includes(h),
                    )
                    return (
                      <div
                        key={paper.doi}
                        className="rounded-md border border-ink-200 bg-paper-50 px-2 py-1.5 hover:border-seal-200 transition"
                      >
                        {titleCn && (
                          <div className="text-xs font-medium text-ink-700 leading-snug">
                            <HighlightedSnippet text={titleCn} query={q} />
                          </div>
                        )}
                        <div
                          className={`text-[0.6875rem] leading-snug ${
                            titleCn ? 'text-ink-500' : 'text-ink-700 font-medium'
                          }`}
                        >
                          <HighlightedSnippet text={paper.title} query={q} />
                        </div>
                        <div className="mt-0.5 text-[0.625rem] text-ink-400 truncate">
                          <HighlightedSnippet text={meta} query={q} />
                        </div>
                        {extra && (
                          <div className="mt-1 text-[0.625rem] text-ink-500 leading-snug">
                            <HighlightedSnippet text={extra} query={q} />
                          </div>
                        )}
                        <button
                          onClick={() => handleCopyDoiLink(paper.doi)}
                          className="mt-1 flex items-center gap-1 text-[0.625rem] text-seal-600 hover:text-seal-700"
                          title={doiLinkOf(paper.doi)}
                        >
                          <Copy className="w-3 h-3" />
                          复制 DOI 链接
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {/* ── 堆叠面板 3/3：大纲（收起后只剩标题行） ── */}
          <div
            className={`border-t border-ink-200 flex flex-col ${
              outlineExpanded ? 'min-h-0' : 'flex-none'
            }`}
          >
            <button
              onClick={() => setOutlineExpanded(!outlineExpanded)}
              className="w-full flex-shrink-0 flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-ink-600 hover:bg-paper-100 transition"
              title={outlineExpanded ? '收起大纲' : '展开大纲'}
            >
              {outlineExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-ink-400" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-ink-400" />
              )}
              <ListTree className="w-3.5 h-3.5 text-seal-600" />
              大纲
              <span className="ml-auto text-ink-400 font-normal">{outline.length}</span>
            </button>
            {outlineExpanded && (
              <div className="flex-auto min-h-0 overflow-y-auto px-2 py-1 space-y-0.5">
                {outline.length === 0 && (
                  <div className="text-xs text-ink-400 text-center py-3">暂无大纲</div>
                )}
                {outline.map((item, idx) => (
                  <button
                    key={idx}
                    onClick={() => jumpToHeading(idx)}
                    className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-seal-50 hover:text-seal-700 transition truncate ${
                      item.level === 1
                        ? 'font-semibold text-ink-700'
                        : item.level === 2
                          ? 'font-medium text-ink-600'
                          : 'text-ink-500'
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
        className="absolute left-0 top-1/2 -translate-y-1/2 z-20 bg-paper-50 border border-ink-200 rounded-r-lg p-1 shadow-md hover:bg-paper-100 transition text-ink-400 hover:text-seal-600"
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
                className={`flex-shrink-0 flex items-center justify-center cursor-col-resize bg-ink-100 hover:bg-seal-100 transition-colors z-10 ${
                  isDragging ? 'bg-seal-200' : ''
                }`}
                style={{ width: '0.375rem' }}
                onMouseDown={handleDragStart}
              >
                <GripVertical className="w-3 h-3 text-ink-400" />
              </div>
            )}

            <div
              className={`flex flex-col min-w-0 bg-paper-50 ${
                p.side === 'right' ? 'border-l border-ink-200' : ''
              }`}
              style={{
                width: p.side === 'left' ? `${panelRatio}%` : `calc(${100 - panelRatio}% - 0.375rem)`,
              }}
            >
              <div className="bg-paper-50 border-b border-ink-200 px-3 py-2 flex items-center gap-2 flex-shrink-0">
                <div className="relative" ref={p.dropdownRef}>
                  <button
                    onClick={() => p.setShowDropdown(!p.showDropdown)}
                    className="px-3 py-1.5 bg-paper-100 border border-ink-200 rounded-lg text-left hover:border-seal-300 transition flex items-center gap-2"
                  >
                    <p.icon className="w-4 h-4 text-seal-600" />
                    <span className="text-sm font-medium text-ink-700">
                      {PANEL_MODES.find((m) => m.value === p.mode)?.label}
                    </span>
                    <ChevronDown className={`w-3.5 h-3.5 text-ink-400 transition-transform ${p.showDropdown ? 'rotate-180' : ''}`} />
                  </button>
                  {p.showDropdown && (
                    <div className="absolute top-full left-0 mt-1 bg-paper-50 border border-ink-200 rounded-lg shadow-lg z-30 overflow-hidden min-w-36">
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
                            className={`w-full px-3 py-2 text-left hover:bg-paper-100 transition flex items-center gap-2 ${
                              active ? 'bg-seal-50/50' : ''
                            }`}
                          >
                            <Icon className={`w-4 h-4 ${active ? 'text-seal-600' : 'text-ink-500'}`} />
                            <span className={`text-sm ${active ? 'text-seal-700 font-medium' : 'text-ink-700'}`}>
                              {mode.label}
                            </span>
                            {mode.hint && (
                              <span className="text-[0.625rem] text-ink-400">{mode.hint}</span>
                            )}
                            {active && <Check className="w-4 h-4 text-seal-600 ml-auto" />}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
                {p.side === 'left' && activeProject && (
                  <>
                    <ChevronRight className="w-4 h-4 text-ink-300" />
                    <span className="text-sm font-semibold text-ink-700 truncate max-w-40">
                      {activeProject.title}
                    </span>
                  </>
                )}
              </div>

          {p.mode === 'editor' && (
            <>
              {/*
                这里原来还有一个「书本图标 + 引用」按钮，和上面的工具栏重复了 ——
                插入引用的入口只留工具栏中间那一个（正文里的引用标记本身也已经
                渲染成普通编号，见 VditorEditor 的 af-cite）。
              */}
              <div className="flex items-center gap-2 px-3 py-1.5 bg-paper-50 border-b border-ink-200 flex-shrink-0">
                <div className="flex-1 min-w-0" />

                <div className="flex-shrink-0 whitespace-nowrap flex items-center gap-1.5 text-xs">
                  {saveStatus === 'saved' && (
                    <span className="text-green-600 flex items-center gap-1 font-medium">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      已保存
                      {lastSaved && <span className="text-ink-400 font-normal">{formatTime(lastSaved)}</span>}
                    </span>
                  )}
                  {saveStatus === 'saving' && (
                    <span className="text-ink-500 flex items-center gap-1">
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
                  className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-seal-600 text-paper-50 rounded-lg text-xs font-medium hover:bg-seal-700 transition shadow-sm"
                >
                  <Download className="w-3.5 h-3.5" />
                  导出
                </button>
              </div>

              <div className="flex-1 min-h-0 flex bg-paper-50">
                <div className="flex-1 min-w-0 h-full">
                  <VditorEditor
                    ref={p.editorRef}
                    value={mdContent}
                    onChange={handleEditorChange}
                    height="100%"
                    placeholder="开始撰写正文…"
                    toolbar={writingToolbar}
                    onFormulaClick={() => openFormulaPanel(null, p.side)}
                    className="h-full"
                    docPath={
                      activeProject ? `projects/${activeProject.projectId}/manuscript.md` : undefined
                    }
                  />
                </div>
                {/* 公式侧栏：编辑器内部的临时侧栏（点工具栏「公式」开关） */}
                {showFormulaPanel && (
                  <FormulaSidebar
                    md={mdContent}
                    onInsert={(tex, kind) => {
                      const ed = requireEditor()
                      if (!ed) return
                      ed.insertAtCursor(formatFormula(tex, kind))
                      setSaveStatus('unsaved')
                    }}
                    onReplaceAt={(index, tex, kind, global, matchTex) => {
                      const next = global
                        ? replaceFormulaOccurrences(mdContent, matchTex, tex, kind)
                        : replaceNthFormula(mdContent, index, tex, kind)
                      handleEditorChange(next)
                      setSaveStatus('unsaved')
                    }}
                    onJump={(index, tex) => jumpToBlock('formula', index, tex, p.side)}
                    onDelete={(indexes) => {
                      handleEditorChange(deleteFormulas(mdContent, indexes))
                      setSaveStatus('unsaved')
                    }}
                    editTarget={formulaEditTarget}
                    onConsumeEditTarget={() => setFormulaEditTarget(null)}
                    onClose={() => setShowFormulaPanel(false)}
                  />
                )}
              </div>

              <div className="px-4 py-1.5 bg-paper-100/80 border-t border-ink-200 flex items-center justify-between text-xs text-ink-400 flex-shrink-0">
                <span>所见即所得编辑器 · 支持插入引用 / 公式 / 图片（图片自动内嵌）</span>
                <span className="font-mono">{wordCount} 字</span>
              </div>
            </>
          )}

          {p.mode === 'proofread' && (
            <ProofreadPanel
              md={mdContent}
              onJump={(kind, index, match) => jumpToBlock(kind, index, match, p.side)}
              onEditFormula={(index) => editFormulaAt(index, p.side)}
              onResize={(index, size) => {
                handleEditorChange(setImageSize(mdContent, index, size))
                setSaveStatus('unsaved')
              }}
            />
          )}

          {p.mode === 'citations' && (
            <CitationPanel
              md={mdContent}
              templates={templates}
              currentTemplateId={selectedTemplateId}
              onSelectTemplate={setSelectedTemplateId}
              onJump={(doi, occurrence) => jumpToCitation(doi, p.side, occurrence)}
              onClearHighlight={clearCitationHighlight}
            />
          )}

          {p.mode === 'ai' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="px-3 py-2 border-b border-ink-100 bg-paper-50">
                <div className="flex items-center gap-1 mb-2">
                  <div className="flex-1 flex items-center gap-1.5 px-2 py-1 bg-seal-50 rounded-lg">
                    <Bot className="w-3.5 h-3.5 text-seal-600" />
                    <span className="text-[0.6875rem] font-medium text-seal-700">AI-1 生成</span>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-ink-300" />
                  <div className="flex-1 flex items-center gap-1.5 px-2 py-1 bg-emerald-50 rounded-lg">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    <span className="text-[0.6875rem] font-medium text-emerald-700">AI-2 审阅</span>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-600 flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-amber-500" />
                    可信检索
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setTrustedSearch(!trustedSearch)}
                      className="text-seal-600"
                    >
                      {trustedSearch ? (
                        <ToggleRight className="w-9 h-5" />
                      ) : (
                        <ToggleLeft className="w-9 h-5 text-ink-300" />
                      )}
                    </button>
                  </div>
                </div>
                <div className="mt-1.5 text-[0.625rem] text-ink-400 leading-relaxed">
                  AI-1 生成内容并标注原文引用，AI-2 核查事实准确性
                </div>

                {trustedSearch && (
                  <div className="mt-2" ref={citationScopeRef}>
                    <div className="text-xs font-medium text-ink-600 mb-1.5">引用范围</div>
                    <div className="relative">
                      <button
                        onClick={() => setShowCitationScopeDropdown(!showCitationScopeDropdown)}
                        className="w-full px-3 py-1.5 bg-paper-100 border border-ink-200 rounded-lg text-left hover:border-seal-300 transition flex items-center justify-between text-xs"
                      >
                        <span className="text-ink-700 truncate">
                          {CITATION_SCOPES.find((s) => s.value === citationScope)?.label}
                          {citationScope === 'project' && activeProject && ` (${activeProject.title})`}
                          {citationScope === 'selected' && selectedPaperIds.length > 0 && ` (${selectedPaperIds.length}篇)`}
                          {citationScope === 'books' && selectedBookIds.length > 0 && ` (${selectedBookIds.length}本)`}
                          {citationScope === 'chapters' && selectedChapterIds.length > 0 && ` (${selectedChapterIds.length}章)`}
                        </span>
                        <ChevronDown className={`w-3.5 h-3.5 text-ink-400 flex-shrink-0 transition-transform ${showCitationScopeDropdown ? 'rotate-180' : ''}`} />
                      </button>
                      {showCitationScopeDropdown && (
                        <div className="absolute top-full left-0 right-0 mt-1 bg-paper-50 border border-ink-200 rounded-lg shadow-lg z-30 overflow-hidden">
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
                              className={`w-full px-3 py-2 text-left hover:bg-paper-100 transition flex items-center justify-between ${
                                citationScope === scope.value ? 'bg-seal-50/50' : ''
                              }`}
                            >
                              <span className={`text-xs ${citationScope === scope.value ? 'text-seal-700 font-medium' : 'text-ink-700'}`}>
                                {scope.label}
                              </span>
                              {citationScope === scope.value && (
                                <Check className="w-4 h-4 text-seal-600" />
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
                              <div key={idx} className="text-[0.6875rem] text-ink-600 bg-paper-100 rounded px-2 py-1.5 truncate">
                                {cit.title}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {citationScope === 'selected' && selectedPaperIds.length > 0 && (
                      <div className="mt-2">
                        <div className="text-[0.625rem] text-ink-500 mb-1">已选文献</div>
                        <div className="space-y-1 max-h-40 overflow-y-auto">
                          {citations.filter(c => selectedPaperIds.includes(c.doi)).map((cit, idx) => (
                            <div key={idx} className="text-[0.6875rem] text-ink-600 bg-paper-100 rounded px-2 py-1.5 truncate">
                              {cit.title}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {citationScope === 'books' && selectedBookIds.length > 0 && (
                      <div className="mt-2">
                        <div className="text-[0.625rem] text-ink-500 mb-1">已选图书</div>
                        <div className="space-y-1 max-h-40 overflow-y-auto">
                          {bookReferences.filter(b => selectedBookIds.includes(b.doi)).map((book, idx) => (
                            <div key={idx} className="text-[0.6875rem] text-ink-600 bg-paper-100 rounded px-2 py-1.5 truncate">
                              {book.title}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {citationScope === 'chapters' && selectedBook && (
                      <div className="mt-2">
                        <div className="text-[0.625rem] text-ink-500 mb-1">
                          {selectedBook.title}
                        </div>
                        {selectedChapterIds.length > 0 ? (
                          <div className="space-y-1 max-h-40 overflow-y-auto">
                            {selectedBook.chapters.filter(ch => selectedChapterIds.includes(ch.id)).map((ch, idx) => (
                              <div key={idx} className="text-[0.6875rem] text-ink-600 bg-paper-100 rounded px-2 py-1.5">
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

              <div className="flex-1 overflow-y-auto p-3 space-y-3 bg-paper-100/30">
                {messages.length === 0 && (
                  <div className="text-center py-10">
                    <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-gradient-to-br from-seal-50 to-seal-100 flex items-center justify-center shadow-inner">
                      <Sparkles className="w-7 h-7 text-seal-400" />
                    </div>
                    <p className="text-sm font-medium text-ink-600">AI 双引擎助手</p>
                    <p className="text-xs text-ink-400 mt-1">
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
                          ? 'bg-seal-600 text-paper-50 rounded-br-md shadow-sm'
                          : 'bg-paper-50 text-ink-700 rounded-bl-md border border-ink-200 shadow-sm'
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
                            <div className="mt-3 pt-3 border-t border-ink-100">
                              <div className="text-[0.6875rem] font-semibold text-ink-500 mb-2 flex items-center gap-1.5">
                                <div className="w-4 h-4 bg-emerald-100 rounded-full flex items-center justify-center">
                                  <BookMarked className="w-2.5 h-2.5 text-emerald-600" />
                                </div>
                                文献条目
                              </div>
                              <div className="space-y-2">
                                {msg.citations.map((cit, idx) => (
                                  <div
                                    key={idx}
                                    className="p-2.5 bg-paper-100/80 rounded-lg border border-ink-200 hover:border-seal-200 hover:bg-seal-50/30 transition"
                                  >
                                    <div className="text-xs font-semibold text-ink-700 leading-snug flex items-start gap-1.5">
                                      <span className="text-seal-600 font-mono flex-shrink-0">[{idx + 1}]</span>
                                      <span className="line-clamp-2">{cit.title}</span>
                                    </div>
                                    <div className="text-[0.6875rem] text-ink-500 mt-1.5 ml-5">
                                      {cit.authors} ({cit.year}) · {cit.journal}
                                    </div>
                                    <div className="flex items-center gap-3 mt-1.5 ml-5">
                                      <DoiLink
                                        doi={cit.doi}
                                        mode="short"
                                        showIcon
                                        className="text-[0.6875rem] flex items-center gap-1 font-medium"
                                      />
                                      <button
                                        onClick={() => handleCopyDoiLink(cit.doi)}
                                        className="text-[0.6875rem] text-ink-400 hover:text-seal-600 transition flex items-center gap-1"
                                        title={doiLinkOf(cit.doi)}
                                      >
                                        <Copy className="w-3 h-3" />
                                        复制链接
                                      </button>
                                      <button
                                        onClick={() => insertCitation(cit.doi)}
                                        className="text-[0.6875rem] text-ink-400 hover:text-seal-600 transition flex items-center gap-1"
                                        title="把这条文献的 DOI 标记插到正文光标处"
                                      >
                                        <Plus className="w-3 h-3" />
                                        插入正文
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {msg.reviewStatus === 'pass' && (
                            <button
                              onClick={() => handleCopyContent(msg.content)}
                              className="w-full mt-2 py-1.5 bg-seal-50 text-seal-600 rounded-lg text-xs font-medium hover:bg-seal-100 transition flex items-center justify-center gap-1"
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

                {aiBusy && (
                  <div className="flex justify-start">
                    <div className="bg-paper-50 rounded-2xl rounded-bl-md px-4 py-3 border border-ink-200 shadow-sm">
                      <div className="flex items-center gap-2">
                        {isAiGenerating ? (
                          <>
                            <div className="w-6 h-6 bg-seal-100 rounded-md flex items-center justify-center">
                              <Bot className="w-3.5 h-3.5 text-seal-600" />
                            </div>
                            <span className="text-xs text-ink-600">AI-1 生成中...</span>
                          </>
                        ) : (
                          <>
                            <div className="w-6 h-6 bg-emerald-100 rounded-md flex items-center justify-center">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                            </div>
                            <span className="text-xs text-ink-600">AI-2 审阅中...</span>
                          </>
                        )}
                        <div className="flex gap-1 ml-2">
                          <span className="w-1.5 h-1.5 bg-seal-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="w-1.5 h-1.5 bg-seal-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="w-1.5 h-1.5 bg-seal-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                        {/* 后端要排队跑 Actions + 多轮大模型调用，分钟级属正常；给个计时免得以为卡死 */}
                        <span
                          className="ml-1 text-[0.625rem] text-ink-400 tabular-nums"
                          title="后端要排队跑 GitHub Actions + 多轮大模型调用，等几分钟是正常的"
                        >
                          已等 {Math.floor(aiElapsed / 60)} 分 {String(aiElapsed % 60).padStart(2, '0')} 秒
                        </span>
                        <button
                          onClick={stopAi}
                          className="ml-1 flex items-center gap-0.5 px-1.5 py-0.5 text-[0.625rem] rounded border border-ink-200 text-ink-500 hover:border-red-300 hover:text-red-600 transition flex-shrink-0"
                          title="停止：不再接收这次回答，并让后端也停下"
                        >
                          <Square className="w-2.5 h-2.5" />
                          停止
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <div ref={chatEndRef} />
              </div>

              <div className="p-3 border-t border-ink-200 bg-paper-50">
                {trustedSearch && (
                  <div className="mb-2 flex items-center gap-1.5 text-[0.625rem] text-emerald-600">
                    <Zap className="w-3 h-3" />
                    <span>可信检索模式 · AI-1生成 + AI-2审阅</span>
                  </div>
                )}

                {/* 快捷指令：点一下点亮，发送框就地换成这条指令要的空 —— 选和填在同一处，
                    不必跳到面板顶端去看另一块表单。再点一下（或点别的指令）即取消。 */}
                <div className="flex flex-wrap items-center gap-1.5 mb-2">
                  {BUILTIN_ACTIONS.map((action) => {
                    const Icon = action.icon
                    const active = activeActionKey === action.key
                    return (
                      <button
                        key={action.key}
                        onClick={() => toggleQuickAction(action.key)}
                        className={`px-2.5 py-1 text-xs rounded-full border transition flex items-center gap-1 ${
                          active
                            ? 'bg-seal-600 border-seal-600 text-paper-50 shadow-sm'
                            : 'bg-paper-100 border-ink-200 text-ink-600 hover:bg-seal-50 hover:border-seal-200 hover:text-seal-700'
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
                            ? 'bg-seal-600 border-seal-600 text-paper-50 shadow-sm'
                            : 'bg-paper-100 border-ink-200 text-ink-600 hover:bg-seal-50 hover:border-seal-200 hover:text-seal-700'
                        }`}
                      >
                        <button
                          onClick={() => toggleQuickAction(key)}
                          className="pl-2.5 pr-1 py-1 max-w-[10rem] truncate"
                          title={`${action.label}\n\n${action.prompt}`}
                        >
                          {action.label}
                        </button>
                        <button
                          onClick={() => handleDeleteAction(action.label)}
                          className={`pr-1.5 pl-0.5 py-1 transition ${
                            active ? 'text-seal-200 hover:text-paper-50' : 'text-ink-300 hover:text-red-500'
                          }`}
                          title="删除该指令"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    )
                  })}
                  <button
                    onClick={() => setShowActionModal(true)}
                    className="p-1 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded-full transition"
                    title="添加自定义指令（可直接写 prompt，也可让 AI 按需求生成）"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>

                {activeAction ? (
                  /* 指令模式：发送框位置换成这条指令需要的输入项（引用检验就是两个框） */
                  <div className="flex gap-2 items-start">
                    <div className="flex-1 space-y-1.5">
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
                                className="w-full px-3 py-2 text-sm border border-ink-200 rounded-xl focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 bg-paper-100/50 resize-y"
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
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && !actionIncomplete) {
                                    e.preventDefault()
                                    sendQuickAction()
                                  }
                                }}
                                placeholder={param.placeholder}
                                className="w-full px-3 py-2 text-sm border border-ink-200 rounded-xl focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 bg-paper-100/50"
                              />
                            ),
                          )
                        : (
                            <textarea
                              value={customPromptDraft}
                              onChange={(e) => setCustomPromptDraft(e.target.value)}
                              rows={3}
                              autoFocus
                              placeholder="这条指令的提示词…"
                              className="w-full px-3 py-2 text-sm border border-ink-200 rounded-xl focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 bg-paper-100/50 resize-y"
                            />
                          )}
                    </div>
                    <button
                      onClick={sendQuickAction}
                      disabled={
                        isAiGenerating || isAiReviewing || !!actionIncomplete || !composeActionPrompt()
                      }
                      className="px-3 py-2 bg-gradient-to-r from-seal-600 to-seal-700 text-paper-50 rounded-xl text-sm hover:from-seal-700 hover:to-seal-800 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                      title={actionIncomplete ? '把这条指令要的空填完' : '发送时自动拼成完整提示词'}
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={handleOpenFolder}
                      className="flex items-center gap-1.5 px-3 py-2 text-[0.6875rem] bg-paper-100 border border-ink-200 text-ink-600 rounded-xl hover:bg-seal-50 hover:border-seal-200 hover:text-seal-700 transition flex-shrink-0"
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
                      className="flex-1 px-3 py-2 text-sm border border-ink-200 rounded-xl focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 bg-paper-100/50 resize-y min-h-[2.375rem] max-h-[10rem]"
                    />
                    <button
                      onClick={() => handleSendMessage()}
                      disabled={isAiGenerating || isAiReviewing || !inputValue.trim()}
                      className="px-3 py-2 bg-gradient-to-r from-seal-600 to-seal-700 text-paper-50 rounded-xl text-sm hover:from-seal-700 hover:to-seal-800 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                )}
                {activeAction && (
                  <div className="mt-1.5 text-[0.625rem] text-ink-400">
                    {actionIncomplete ? '填完这条指令要的空才能发' : '发送时自动拼成完整提示词'}
                  </div>
                )}
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
              <div className="p-3 border-b border-ink-100">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-400" />
                  <input
                    type="text"
                    value={citationSearch}
                    onChange={(e) => setCitationSearch(e.target.value)}
                    placeholder="搜索文献..."
                    className="w-full pl-9 pr-3 py-2 text-sm border border-ink-200 rounded-lg focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 bg-paper-100/50"
                  />
                </div>
                <div className="mt-2 text-[0.6875rem] text-ink-400 flex items-center gap-1.5">
                  <FileCode className="w-3 h-3" />
                  文献数据存储在 GitHub 仓库的 data/citations.csv
                </div>
                <button
                  onClick={() => setShowAddCitationForm(!showAddCitationForm)}
                  className="mt-2 w-full py-1.5 bg-seal-50 text-seal-600 rounded-lg text-xs font-medium hover:bg-seal-100 transition flex items-center justify-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  添加文献
                </button>
                {showAddCitationForm && (
                  <div className="mt-2 p-3 bg-paper-100 rounded-lg border border-ink-200 space-y-2">
                    <input
                      type="text"
                      value={newCitation.title}
                      onChange={(e) => setNewCitation((prev) => ({ ...prev, title: e.target.value }))}
                      placeholder="标题 *"
                      className="w-full px-2.5 py-1.5 text-xs border border-ink-200 rounded focus:outline-none focus:border-seal-400 focus:ring-1 focus:ring-seal-100"
                    />
                    <input
                      type="text"
                      value={newCitation.authors}
                      onChange={(e) => setNewCitation((prev) => ({ ...prev, authors: e.target.value }))}
                      placeholder="作者"
                      className="w-full px-2.5 py-1.5 text-xs border border-ink-200 rounded focus:outline-none focus:border-seal-400 focus:ring-1 focus:ring-seal-100"
                    />
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newCitation.year}
                        onChange={(e) => setNewCitation((prev) => ({ ...prev, year: e.target.value }))}
                        placeholder="年份"
                        className="w-20 px-2.5 py-1.5 text-xs border border-ink-200 rounded focus:outline-none focus:border-seal-400 focus:ring-1 focus:ring-seal-100"
                      />
                      <input
                        type="text"
                        value={newCitation.journal}
                        onChange={(e) => setNewCitation((prev) => ({ ...prev, journal: e.target.value }))}
                        placeholder="期刊"
                        className="flex-1 px-2.5 py-1.5 text-xs border border-ink-200 rounded focus:outline-none focus:border-seal-400 focus:ring-1 focus:ring-seal-100"
                      />
                    </div>
                    <input
                      type="text"
                      value={newCitation.doi}
                      onChange={(e) => setNewCitation((prev) => ({ ...prev, doi: e.target.value }))}
                      placeholder="DOI *"
                      className="w-full px-2.5 py-1.5 text-xs border border-ink-200 rounded focus:outline-none focus:border-seal-400 focus:ring-1 focus:ring-seal-100"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={handleAddCitation}
                        disabled={!newCitation.title.trim() || !newCitation.doi.trim()}
                        className="flex-1 py-1.5 bg-seal-600 text-paper-50 rounded text-xs font-medium hover:bg-seal-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        添加
                      </button>
                      <button
                        onClick={() => {
                          setShowAddCitationForm(false)
                          setNewCitation({ title: '', authors: '', year: '', journal: '', doi: '' })
                        }}
                        className="px-3 py-1.5 bg-ink-200 text-ink-600 rounded text-xs font-medium hover:bg-ink-300 transition"
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
                    className="p-3 bg-paper-50 rounded-lg border border-ink-200 hover:border-seal-200 hover:shadow-sm transition cursor-pointer group relative"
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteCitation(cit.doi)
                      }}
                      className="absolute top-2 right-2 p-1 text-ink-300 hover:text-red-500 hover:bg-red-50 rounded opacity-0 group-hover:opacity-100 transition"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                    <div className="text-sm font-semibold text-ink-700 line-clamp-2 leading-snug pr-6">
                      {cit.title}
                    </div>
                    <div className="text-xs text-ink-500 mt-2 flex items-center gap-2">
                      <span className="px-1.5 py-0.5 bg-seal-50 text-seal-600 rounded text-[0.625rem] font-medium">
                        {cit.year}
                      </span>
                      <span className="truncate">{cit.journal}</span>
                    </div>
                    <div className="text-xs text-ink-400 mt-1 truncate">
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
                        className="text-[0.6875rem] px-2 py-0.5 bg-seal-50 text-seal-600 rounded hover:bg-seal-100 transition font-medium"
                      >
                        插入引用
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="p-3 border-t border-ink-200 bg-paper-100/50 space-y-2">
                <button
                  onClick={handleOpenFolder}
                  className="w-full py-2 bg-paper-50 border border-ink-200 text-ink-600 rounded-lg text-xs font-medium hover:bg-seal-50 hover:border-seal-200 hover:text-seal-700 transition flex items-center justify-center gap-1.5"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  从文件夹导入
                </button>
                <button
                  onClick={() => setShowBibtexInput(!showBibtexInput)}
                  className="w-full py-2 bg-paper-50 border border-ink-200 text-ink-600 rounded-lg text-xs font-medium hover:bg-seal-50 hover:border-seal-200 hover:text-seal-700 transition flex items-center justify-center gap-1.5"
                >
                  <Clipboard className="w-3.5 h-3.5" />
                  粘贴 BibTeX
                </button>
                {showBibtexInput && (
                  <div className="p-2 bg-paper-50 rounded-lg border border-ink-200 space-y-2">
                    <textarea
                      value={bibtexText}
                      onChange={(e) => setBibtexText(e.target.value)}
                      placeholder="粘贴 BibTeX 内容..."
                      rows={4}
                      className="w-full px-2 py-1.5 text-xs border border-ink-200 rounded focus:outline-none focus:border-seal-400 focus:ring-1 focus:ring-seal-100 resize-none"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={handleImportBibtex}
                        className="flex-1 py-1 bg-seal-600 text-paper-50 rounded text-xs font-medium hover:bg-seal-700 transition"
                      >
                        导入
                      </button>
                      <button
                        onClick={() => {
                          setShowBibtexInput(false)
                          setBibtexText('')
                        }}
                        className="px-3 py-1 bg-ink-200 text-ink-600 rounded text-xs font-medium hover:bg-ink-300 transition"
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
              <div className="p-3 border-b border-ink-100">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-400" />
                  <input
                    type="text"
                    placeholder="搜索知识库..."
                    className="w-full pl-9 pr-3 py-2 text-sm border border-ink-200 rounded-lg focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 bg-paper-100/50"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                <div className="text-xs font-semibold text-ink-500 mb-2 px-1 flex items-center gap-1.5">
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
                      className="p-2.5 bg-paper-50 rounded-lg border border-ink-200 hover:border-seal-200 transition cursor-pointer flex items-start gap-2"
                    >
                      <div className="w-8 h-10 bg-gradient-to-br from-amber-100 to-amber-200 rounded flex items-center justify-center flex-shrink-0">
                        <BookText className="w-4 h-4 text-amber-700" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-ink-700 line-clamp-1">{book.title}</div>
                        <div className="text-[0.6875rem] text-ink-500 mt-0.5">{book.author} ({book.year})</div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="text-xs font-semibold text-ink-500 mb-2 px-1 flex items-center gap-1.5">
                  <Newspaper className="w-3.5 h-3.5" />
                  综述文章
                </div>
                <div className="space-y-2">
                  {citations.slice(0, 2).map((cit, idx) => (
                    <div
                      key={idx}
                      className="p-2.5 bg-paper-50 rounded-lg border border-ink-200 hover:border-seal-200 transition cursor-pointer"
                    >
                      <div className="text-xs font-medium text-ink-700 line-clamp-2 leading-snug">
                        {cit.title}
                      </div>
                      <div className="text-[0.6875rem] text-ink-500 mt-1">
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
                    className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-seal-600 bg-seal-50/60 hover:bg-seal-100 rounded-lg transition"
                  >
                    {showNewTemplateForm ? (
                      <ChevronDown className="w-3.5 h-3.5" />
                    ) : (
                      <Plus className="w-3.5 h-3.5" />
                    )}
                    新建期刊模板
                  </button>

                  {showNewTemplateForm && (
                    <div className="mt-2 p-2.5 space-y-2 bg-paper-100 rounded-lg">
                      <input
                        type="text"
                        value={newTemplateName}
                        onChange={(e) => setNewTemplateName(e.target.value)}
                        placeholder="期刊名称，如 Nature Communications"
                        className="w-full px-2 py-1.5 text-xs border border-ink-200 rounded-lg focus:outline-none focus:border-seal-400 focus:ring-1 focus:ring-seal-100"
                      />
                      <textarea
                        value={newTemplateGuidelines}
                        onChange={(e) => setNewTemplateGuidelines(e.target.value)}
                        rows={4}
                        placeholder="投稿须知原文（可选）。粘了就可以让 AI 按须知定 documentclass / 引用样式 / 双栏等；不粘就直接建骨架，之后在代码板里改。"
                        className="w-full px-2 py-1.5 text-xs border border-ink-200 rounded-lg resize-none focus:outline-none focus:border-seal-400 focus:ring-1 focus:ring-seal-100"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={createTemplateWithAI}
                          disabled={
                            isCreatingTemplate ||
                            !newTemplateName.trim() ||
                            !newTemplateGuidelines.trim()
                          }
                          className="flex-1 py-1.5 bg-seal-600 text-paper-50 rounded-lg text-[0.6875rem] font-medium hover:bg-seal-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
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
                          className="flex-1 py-1.5 bg-paper-50 border border-ink-200 text-ink-700 rounded-lg text-[0.6875rem] font-medium hover:bg-paper-100 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          只建骨架
                        </button>
                      </div>
                      <button
                        onClick={() => {
                          texImportModeRef.current = 'create'
                          texTemplateInputRef.current?.click()
                        }}
                        disabled={isCreatingTemplate}
                        className="w-full py-1.5 bg-paper-50 border border-ink-200 text-ink-700 rounded-lg text-[0.6875rem] font-medium hover:bg-paper-100 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
                        title="上传期刊官方的 sample .tex，直接解析出 documentclass / 宏包 / 引用样式，比让 AI 从投稿须知里猜准"
                      >
                        <Upload className="w-3 h-3" />
                        上传 .tex 解析建模板
                      </button>
                      <button
                        onClick={() => texPackageInputRef.current?.click()}
                        disabled={isCreatingTemplate}
                        className="w-full py-1.5 bg-paper-50 border border-ink-200 text-ink-700 rounded-lg text-[0.6875rem] font-medium hover:bg-paper-100 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
                        title="上传出版社给的整包投稿模板（.zip，含 sample .tex + .cls/.sty/.bst + 图片/字体）。后端会解包成期刊模板，附属文件一并收好"
                      >
                        <Package className="w-3 h-3" />
                        上传投稿包 .zip 解包建模板
                      </button>
                      {!newTemplateName.trim() && (
                        <p className="text-[0.625rem] text-ink-400 leading-relaxed">
                          不填期刊名就用文件名当模板名。
                        </p>
                      )}
                      {templateCreateStatus && (
                        <p className="text-[0.625rem] text-ink-400 leading-relaxed">
                          {templateCreateStatus}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* 编译器的能力边界：写清楚内置了什么，省得用户猜 */}
                <p className="text-[0.625rem] text-ink-400 leading-relaxed bg-paper-100 rounded-lg p-2">
                  编译器是随站点分发的 XeLaTeX 运行时（不联网，约 110MB，首次编译加载一次）。
                  已内置基础宏包 amsmath / graphicx / hyperref / geometry / xcolor / longtable /
                  etoolbox / fontspec，常用宏包 booktabs、natbib、amssymb、tabularx、multirow、
                  caption / subcaption / microtype，文档类{' '}
                  <b className="font-medium text-ink-500">IEEEtran</b>、
                  <b className="font-medium text-ink-500">elsarticle</b>、
                  <b className="font-medium text-ink-500">acmart</b>、
                  <b className="font-medium text-ink-500">revtex4-2</b>，
                  中文走 xeCJK + Noto Serif SC（正文里有汉字就自动接管，拉丁文仍用文档类自己的字体）。
                  其它宏包可以自己导入：在右边编译器顶部点「宏包」，把 .sty / .cls 选进来，
                  导入一次之后每次编译自动带上。
                  <br />
                  还是编不过的（要最新 TeX Live、要 biber、要冷门宏包），就点「正式编译（后端）」——
                  那是在你自己的私库里跑 GitHub Actions + 官方 TeX Live 镜像，什么宏包都能装，
                  代价是要排队等一会儿。
                </p>

                <div>
                  <div className="text-xs font-medium text-ink-600 mb-1.5">目标期刊模板</div>
                  <div className="relative">
                    <select
                      value={selectedTemplateId}
                      onChange={(e) => setSelectedTemplateId(e.target.value)}
                      disabled={templates.length === 0}
                      className="w-full px-3 py-2 text-sm border border-ink-200 rounded-lg focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 bg-paper-50 appearance-none pr-8 disabled:bg-ink-100 disabled:text-ink-400"
                    >
                      {templates.length === 0 && <option value="">未创建期刊模板</option>}
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.short_name || t.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-400 pointer-events-none" />
                  </div>
                  {templates.length === 0 && (
                    <p className="mt-1.5 text-[0.6875rem] text-ink-400 leading-relaxed">
                      点上面的「新建期刊模板」：粘投稿须知让 AI 提取，或先建一份骨架 ——
                      建完会自动载入代码板，改到能编译再「保存回模板」。
                    </p>
                  )}
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={loadTemplateIntoLatexBoard}
                    disabled={!currentTemplate}
                    className="flex-1 py-2 bg-seal-600 text-paper-50 rounded-lg text-xs font-medium hover:bg-seal-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    载入到代码板
                  </button>
                  <button
                    onClick={saveLatexToTemplate}
                    disabled={!currentTemplate || !latexCode.trim()}
                    className="flex-1 py-2 bg-paper-50 border border-ink-200 text-ink-700 rounded-lg text-xs font-medium hover:bg-paper-100 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                  >
                    <Save className="w-3.5 h-3.5" />
                    保存回模板
                  </button>
                </div>

                <button
                  onClick={() => {
                    texImportModeRef.current = 'overwrite'
                    texTemplateInputRef.current?.click()
                  }}
                  disabled={!currentTemplate || isCreatingTemplate}
                  className="w-full py-1.5 bg-paper-50 border border-ink-200 text-ink-600 rounded-lg text-[0.6875rem] font-medium hover:bg-paper-100 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
                  title="用一份新的 .tex 覆盖当前模板：documentclass / 宏包 / 引用样式 / 正文骨架都按它重新解析，原文并存进模板"
                >
                  <Upload className="w-3 h-3" />
                  上传 .tex 覆盖当前模板
                </button>

                {currentTemplate && (
                  <div className="p-2.5 bg-paper-100 rounded-lg text-[0.6875rem] text-ink-500 leading-relaxed">
                    <div className="font-medium text-ink-600 mb-0.5">
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

                <div className="border-t border-ink-100 pt-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-ink-600">让 AI 改 LaTeX 代码</span>
                    <button
                      onClick={() => setTrustedSearch(!trustedSearch)}
                      className={`flex items-center gap-1 text-[0.6875rem] px-1.5 py-0.5 rounded transition ${
                        trustedSearch
                          ? 'text-seal-600 hover:bg-seal-50'
                          : 'text-ink-400 hover:bg-paper-100'
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
                    className="w-full px-2.5 py-2 text-xs border border-ink-200 rounded-lg resize-none focus:outline-none focus:border-seal-400 focus:ring-1 focus:ring-seal-100"
                  />
                  <button
                    onClick={refineLatexCode}
                    disabled={isRefiningLatex}
                    className="w-full py-2 bg-gradient-to-r from-seal-600 to-seal-700 text-paper-50 rounded-lg text-xs font-medium hover:from-seal-700 hover:to-seal-800 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
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
                    <p className="text-[0.625rem] text-ink-400 leading-relaxed">{refineStatus}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── LaTeX 工作区：左「代码板」 + 右「编译器」，左右并排各占一半 ── */}
          {p.mode === 'typesetting' && (
            <div className="flex-1 flex flex-row min-h-0 overflow-hidden">
              {/* 左半：LaTeX 代码板 */}
              <div className="flex-1 min-w-0 min-h-0 flex flex-col border-r border-ink-200">
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-paper-100 border-b border-ink-200 flex-shrink-0">
                  <FileCode className="w-3.5 h-3.5 text-seal-600 flex-shrink-0" />
                  <span className="text-xs font-semibold text-ink-700 flex-shrink-0">
                    LaTeX 代码板
                  </span>
                  <div className="flex-1 min-w-0" />
                  <button
                    onClick={() => void generateLatexFromMarkdown()}
                    disabled={isGeneratingLatex}
                    className="flex-shrink-0 flex items-center gap-1 px-2 py-1 text-[0.6875rem] text-paper-50 bg-seal-600 rounded hover:bg-seal-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
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
                    onClick={runLatexLocalUpdate}
                    disabled={isGeneratingLatex || !latexCode.trim()}
                    className="flex-shrink-0 flex items-center gap-1 px-2 py-1 text-[0.6875rem] text-seal-700 bg-seal-50 rounded hover:bg-seal-100 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    title="把 md 里改过的文字逐字更正到 LaTeX 对应位置；只有改不动的地方才交给 AI。改文字请走这条路，别整篇重转。"
                  >
                    改字同步到 LaTeX
                  </button>
                  <button
                    onClick={() => handleCopyContent(latexCode)}
                    disabled={!latexCode}
                    className="flex-shrink-0 p-1 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded transition disabled:opacity-40"
                    title="复制 LaTeX 源码"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={downloadLatexSource}
                    disabled={!latexCode}
                    className="flex-shrink-0 p-1 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded transition disabled:opacity-40"
                    title="下载 .tex"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                </div>
                {latexGenStatus && (
                  <div className="px-3 py-1 text-[0.625rem] text-seal-600 bg-seal-50/60 border-b border-seal-100 flex-shrink-0 truncate">
                    {latexGenStatus}
                  </div>
                )}
                <textarea
                  value={latexCode}
                  onChange={(e) => setLatexCode(e.target.value)}
                  spellCheck={false}
                  placeholder="这里是 LaTeX 源码。点上方「由正文生成」，或在左侧「期刊模板」里点「载入到代码板」。"
                  className="flex-1 min-h-0 w-full resize-none p-3 font-mono text-[0.6875rem] leading-relaxed text-ink-800 bg-paper-50 focus:outline-none"
                />
              </div>

              {/* 右半：编译器（浏览器内 XeLaTeX WASM，真编译） */}
              <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-paper-100 border-b border-ink-200 flex-shrink-0">
                  <Play className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
                  <span className="text-xs font-semibold text-ink-700 flex-shrink-0">编译器</span>
                  {compileStatus && (
                    <span className="text-[0.625rem] text-ink-400 truncate">{compileStatus}</span>
                  )}
                  <div className="flex-1 min-w-0" />
                  <button
                    onClick={() => setShowPackagesPanel((v) => !v)}
                    className={`flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[0.6875rem] transition ${
                      showPackagesPanel
                        ? 'bg-seal-100 text-seal-700'
                        : 'text-ink-500 hover:text-seal-600 hover:bg-seal-50'
                    }`}
                    title="导入 .sty / .cls 宏包，编译时自动带上"
                  >
                    <Package className="w-3 h-3" />
                    宏包
                    {latexPackages.length > 0 && (
                      <span className="text-[0.625rem] text-seal-600">
                        {latexPackages.length}
                      </span>
                    )}
                  </button>
                  {pdfUrl && (
                    <button
                      onClick={downloadCompiledPdf}
                      className="flex-shrink-0 p-1 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded transition"
                      title="下载 PDF"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={compileInCloud}
                    disabled={isCloudCompiling || isCompiling}
                    className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1 text-[0.6875rem] text-seal-700 bg-seal-50 border border-seal-200 rounded hover:bg-seal-100 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    title="正式编译（后端）：在你自己的私库里跑 GitHub Actions + 官方 TeX Live 镜像，宏包最全、版本最新；代价是提交源码并等排队（几分钟）"
                  >
                    {isCloudCompiling ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <CloudUpload className="w-3 h-3" />
                    )}
                    {isCloudCompiling ? '正式编译中' : '正式编译（后端）'}
                  </button>
                  <button
                    onClick={compileCurrentLatex}
                    disabled={isCompiling || isCloudCompiling}
                    className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1 text-[0.6875rem] text-paper-50 bg-emerald-600 rounded hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                    title="预览（前端）：在本机浏览器里跑 XeLaTeX（首次要先下约 110MB 运行时，之后走缓存），几秒出 PDF、不联网、源码不出本机；但宏包被运行时钉死"
                  >
                    {isCompiling ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Play className="w-3 h-3" />
                    )}
                    {isCompiling ? '预览中' : '预览（前端）'}
                  </button>
                </div>

                {/* 云端编译的 Actions 运行页 —— 第一次跑大概率要看着它调，给个直达链接 */}
                {cloudRunUrl && (
                  <div className="flex-shrink-0 px-3 py-1 text-[0.625rem] text-ink-400 border-b border-ink-100 truncate">
                    运行页：{' '}
                    <a
                      href={cloudRunUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-seal-600 hover:underline"
                    >
                      {cloudRunUrl}
                    </a>
                  </div>
                )}

                {/* 导入宏包：运行时只内置了常用宏包，用户自己的 .sty/.cls 从这里进来 */}
                {showPackagesPanel && (
                  <div className="flex-shrink-0 border-b border-ink-200 bg-paper-100 px-3 py-2 space-y-2 max-h-56 overflow-y-auto">
                    <p className="text-[0.625rem] text-ink-500 leading-relaxed">
                      编译器自带常用宏包与 IEEEtran / elsarticle / acmart / revtex4-2。
                      没带的（冷门宏包、自己写的 .sty）从这里导入：
                      文件存进本项目目录，<span className="text-ink-600">之后每次编译自动挂上</span>，导入一次长期可用。
                    </p>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <button
                        onClick={() => packageFileInputRef.current?.click()}
                        disabled={isImportingPackages || !activeProjectId}
                        className="flex items-center gap-1 px-2 py-1 text-[0.6875rem] text-paper-50 bg-seal-600 rounded hover:bg-seal-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
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
                        className="flex items-center gap-1 px-2 py-1 text-[0.6875rem] text-ink-700 bg-paper-50 border border-ink-200 rounded hover:bg-paper-100 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        title="整包拖进来更省事：一个宏包常有好几个 .sty/.def/.cfg"
                      >
                        <FolderOpen className="w-3 h-3" />
                        选择文件夹
                      </button>
                      {isLoadingPackages && (
                        <span className="text-[0.625rem] text-ink-400 flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          读取中
                        </span>
                      )}
                    </div>
                    {packageStatus && (
                      <pre className="text-[0.625rem] text-ink-500 whitespace-pre-wrap leading-relaxed">
                        {packageStatus}
                      </pre>
                    )}
                    {latexPackages.length > 0 ? (
                      <ul className="space-y-0.5">
                        {latexPackages.map((pkg) => (
                          <li
                            key={pkg.name}
                            className="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-paper-50 group"
                          >
                            <FileCode className="w-3 h-3 text-seal-500 flex-shrink-0" />
                            <span className="text-[0.625rem] font-mono text-ink-700 truncate">
                              {pkg.name}
                            </span>
                            <span className="text-[0.625rem] text-ink-400 flex-shrink-0">
                              {pkg.size < 1024
                                ? `${pkg.size} B`
                                : `${(pkg.size / 1024).toFixed(0)} KB`}
                            </span>
                            <div className="flex-1" />
                            <button
                              onClick={() => handleDeletePackage(pkg.name)}
                              className="flex-shrink-0 p-0.5 text-ink-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition"
                              title={`删除 ${pkg.name}`}
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      !isLoadingPackages && (
                        <p className="text-[0.625rem] text-ink-400">
                          这个项目还没导入宏包。整包文件夹拖进来最省事。
                        </p>
                      )
                    )}
                  </div>
                )}

                <div className="flex-1 min-h-0 bg-ink-100 overflow-hidden">
                  {compileError ? (
                    <div className="h-full flex flex-col">
                      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 border-b border-red-100 flex-shrink-0">
                        <X className="w-3.5 h-3.5 text-red-500" />
                        <span className="text-[0.6875rem] font-medium text-red-600">
                          编译失败 · 日志
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
                      <Play className="w-8 h-8 text-ink-300 mb-2" />
                      <p className="text-xs text-ink-400 leading-relaxed">
                        点「预览（前端）」在本机浏览器里跑 XeLaTeX
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
        <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center z-50 p-4">
          <div className="bg-paper-50 rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
            <div className="px-4 py-3 border-b border-ink-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BookMarked className="w-5 h-5 text-seal-600" />
                <h3 className="text-base font-semibold text-ink-800">插入引用</h3>
              </div>
              <button
                onClick={() => {
                  setShowCitationModal(false)
                  setSelectedCitations([])
                  setCitationSearch('')
                }}
                className="p-1 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-4 py-3 border-b border-ink-100">
              <div className="flex gap-1 mb-2">
                <button
                  onClick={() => setCitationSource('local')}
                  className={`px-2.5 py-1 text-xs rounded-full transition ${
                    citationSource === 'local' ? 'bg-seal-100 text-seal-700 font-medium' : 'text-ink-500 hover:bg-ink-100'
                  }`}
                >
                  本地文献
                </button>
                <button
                  onClick={() => setCitationSource('online')}
                  className={`px-2.5 py-1 text-xs rounded-full transition flex items-center gap-1 ${
                    citationSource === 'online' ? 'bg-seal-100 text-seal-700 font-medium' : 'text-ink-500 hover:bg-ink-100'
                  }`}
                >
                  <Search className="w-3 h-3" />
                  在线检索（中英文）
                </button>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-400" />
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
                  className="w-full pl-9 pr-3 py-2 text-sm border border-ink-200 rounded-lg focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                  autoFocus
                />
              </div>
              {citationSource === 'online' ? (
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[0.6875rem] text-ink-400">数据源：Crossref（摘要缺的用 OpenAlex 补）</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSummarizeOnline}
                      disabled={isSummarizingOnline || isSearchingOnline || onlineResults.length === 0}
                      className="px-2.5 py-1 text-xs bg-ink-100 text-ink-600 rounded-lg hover:bg-seal-50 hover:text-seal-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                      title="让 AI 给当前这批结果各写一句中文小结（走一次后端 AI，通常一分钟上下）"
                    >
                      {isSummarizingOnline ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Sparkles className="w-3 h-3" />
                      )}
                      {isSummarizingOnline ? '生成中…' : 'AI 中文小结'}
                    </button>
                    <button
                      onClick={handleOnlineSearch}
                      disabled={isSearchingOnline || !onlineQuery.trim()}
                      className="px-2.5 py-1 text-xs bg-seal-600 text-paper-50 rounded-lg hover:bg-seal-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                    >
                      {isSearchingOnline && <Loader2 className="w-3 h-3 animate-spin" />}
                      检索
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 text-[0.6875rem] text-ink-400">
                  快捷键：<kbd className="px-1.5 py-0.5 bg-ink-100 rounded text-ink-600 font-mono">Ctrl+Shift+K</kbd>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {citationSource === 'online' ? (
                <>
                  {onlineResults.length === 0 && (
                    <div className="text-center py-8 text-sm text-ink-400">
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
                          isSelected ? 'border-seal-400 bg-seal-50/60' : 'border-ink-200'
                        }`}
                      >
                        <div className="text-sm font-medium text-ink-700 line-clamp-2 leading-snug">
                          {result.title}
                        </div>
                        <div className="text-xs text-ink-500 mt-1.5 truncate">
                          {result.authors} ({result.year})
                        </div>
                        <div className="text-xs text-ink-400 truncate mt-0.5">{result.journal}</div>
                        {onlineSummaries[result.doi] && (
                          <p className="mt-2 text-xs text-seal-800 bg-seal-50/70 rounded px-2 py-1.5 leading-relaxed">
                            <span className="font-medium">中文小结：</span>
                            {onlineSummaries[result.doi]}
                          </p>
                        )}
                        {result.abstract && (
                          // 摘要动辄上千字，展开会把列表撑爆 —— 折在 details 里，要看再点开
                          <details className="mt-2">
                            <summary className="text-[0.6875rem] text-ink-400 cursor-pointer hover:text-seal-600">
                              摘要
                            </summary>
                            <p className="mt-1 text-xs text-ink-500 leading-relaxed">{result.abstract}</p>
                          </details>
                        )}
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
                                  ? 'bg-seal-600 text-paper-50'
                                  : 'bg-ink-100 text-ink-600 hover:bg-seal-50 hover:text-seal-700'
                              }`}
                            >
                              {isSelected ? <Check className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
                              {isSelected ? '已选择' : '选择'}
                            </button>
                          ) : (
                            <button
                              onClick={() => handleImportOnlineResult(result)}
                              className="px-2 py-1 text-[0.6875rem] bg-seal-50 text-seal-700 rounded hover:bg-seal-100 transition flex items-center gap-1"
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
                    <div className="text-center py-8 text-sm text-ink-400">
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
                            ? 'border-seal-400 bg-seal-50/60'
                            : 'border-ink-200 hover:border-seal-200 hover:bg-paper-100'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${
                            isSelected ? 'bg-seal-600 border-seal-600' : 'border-ink-300'
                          }`}>
                            {isSelected && <Check className="w-3.5 h-3.5 text-paper-50" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-ink-700 line-clamp-2 leading-snug">
                              {cit.title}
                            </div>
                            <div className="text-xs text-ink-500 mt-1.5 truncate">
                              {cit.authors} ({cit.year})
                            </div>
                            <div className="text-xs text-ink-400 truncate mt-0.5">
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

            <div className="px-4 py-3 border-t border-ink-200 bg-paper-100/50 flex items-center justify-between">
              <div className="text-xs text-ink-500">
                已选择 <span className="font-semibold text-seal-600">{selectedCitations.length}</span> 篇
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowCitationModal(false)
                    setSelectedCitations([])
                    setCitationSearch('')
                  }}
                  className="px-3 py-1.5 text-sm text-ink-600 hover:bg-ink-200 rounded-lg transition"
                >
                  取消
                </button>
                <button
                  onClick={insertSelectedCitations}
                  disabled={selectedCitations.length === 0}
                  className="px-4 py-1.5 bg-seal-600 text-paper-50 text-sm rounded-lg hover:bg-seal-700 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                >
                  插入引用
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showProjectLitModal && (
        <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center z-50 p-4">
          <div className="bg-paper-50 rounded-xl shadow-2xl w-full max-w-md max-h-[75vh] flex flex-col">
            <div className="px-4 py-3 border-b border-ink-200 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-ink-800">选择项目文献</h3>
                <p className="text-[0.6875rem] text-ink-400 mt-0.5">
                  这些文献会成为该项目的临时知识库，随时可以再加
                </p>
              </div>
              <button
                onClick={() => {
                  setShowProjectLitModal(false)
                  setProjectLitTargetId(null)
                  setProjectLitSelected([])
                }}
                className="p-1 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-4 py-2 border-b border-ink-100">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-400" />
                <input
                  type="text"
                  value={projectLitSearch}
                  onChange={(e) => setProjectLitSearch(e.target.value)}
                  placeholder="搜索文献库（标题 / 作者 / 期刊 / DOI）..."
                  className="w-full pl-8 pr-3 py-1.5 text-sm border border-ink-200 rounded-lg focus:outline-none focus:border-seal-400"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {availablePapers.length === 0 && (
                <div className="text-center py-8 text-sm text-ink-400">
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
                          ? 'border-seal-400 bg-seal-50/60'
                          : 'border-ink-200 hover:border-seal-200 hover:bg-paper-100'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${
                          isSelected ? 'bg-seal-600 border-seal-600' : 'border-ink-300'
                        }`}>
                          {isSelected && <Check className="w-3 h-3 text-paper-50" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold text-ink-700 line-clamp-2 leading-snug">
                            {p.title}
                          </div>
                          <div className="text-[0.6875rem] text-ink-500 mt-1 truncate">
                            {p.journal} ({p.year})
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
            </div>

            <div className="px-4 py-3 border-t border-ink-200 bg-paper-100/50 flex items-center justify-between">
              <span className="text-xs text-ink-500">
                已选 <span className="font-semibold text-seal-600">{projectLitSelected.length}</span> 篇
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowProjectLitModal(false)
                    setProjectLitTargetId(null)
                    setProjectLitSelected([])
                  }}
                  className="px-3 py-1.5 text-sm text-ink-600 hover:bg-ink-200 rounded-lg transition"
                >
                  跳过
                </button>
                <button
                  onClick={handleAddProjectLiterature}
                  disabled={projectLitSelected.length === 0}
                  className="px-3 py-1.5 text-sm bg-seal-600 text-paper-50 rounded-lg hover:bg-seal-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  添加
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {citeGate && (
        <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center z-50 p-4">
          <div className="bg-paper-50 rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div className="px-4 py-3 border-b border-ink-200 flex items-center justify-between">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-base font-semibold text-ink-800">引用体检没通过</h3>
                  <p className="text-[0.6875rem] text-ink-500 mt-0.5">
                    生成前先看一眼更好 —— 这些引用编译出来会在 PDF 上显示成 [?]
                  </p>
                </div>
              </div>
              <button
                onClick={() => setCiteGate(null)}
                className="p-1 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-4 overflow-y-auto">
              {citeGate.malformed.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-ink-700 mb-1.5">
                    写法不对，识别不出 DOI 的引用标记（{citeGate.malformed.length} 处）
                  </div>
                  <div className="space-y-1">
                    {citeGate.malformed.map((s) => (
                      <div
                        key={s}
                        className="px-2.5 py-1.5 rounded-lg bg-rose-50 border border-rose-100 text-xs font-mono text-rose-700 break-all"
                      >
                        {s}
                      </div>
                    ))}
                  </div>
                  <p className="text-[0.6875rem] text-ink-500 mt-1.5">
                    在正文里搜到这些标记，改成 <code className="font-mono">[@doi:10.xxxx/xxxx]</code> 的写法。
                  </p>
                </div>
              )}

              {citeGate.unresolved.length > 0 && (
                <div>
                  <div className="text-xs font-medium text-ink-700 mb-1.5">
                    查不到文献条目的 DOI（{citeGate.unresolved.length} / {citeGate.total.length} 条）
                  </div>
                  <div className="space-y-1">
                    {citeGate.unresolved.map((d) => (
                      <div
                        key={d}
                        className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-amber-50 border border-amber-100"
                      >
                        <span className="text-xs font-mono text-amber-800 break-all">{d}</span>
                        <a
                          href={`https://doi.org/${d}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[0.6875rem] text-seal-600 hover:underline flex-shrink-0"
                        >
                          打开 DOI
                        </a>
                      </div>
                    ))}
                  </div>
                  <p className="text-[0.6875rem] text-ink-500 mt-1.5">
                    可能是 DOI 写错了，也可能是 CrossRef 暂时查不到。点开确认一下；
                    确认没问题的话，生成后需要在 .bib 里手动补这一条。
                  </p>
                </div>
              )}
            </div>

            <div className="px-4 py-3 border-t border-ink-200 bg-paper-100/50 flex items-center justify-between gap-2">
              <button
                onClick={() => {
                  const all = [...citeGate.malformed, ...citeGate.unresolved]
                  navigator.clipboard?.writeText(all.join('\n'))
                  toast.success(`已复制 ${all.length} 条到剪贴板`)
                }}
                className="px-3 py-1.5 text-xs text-ink-600 hover:bg-ink-200 rounded-lg transition flex items-center gap-1.5"
              >
                <Copy className="w-3.5 h-3.5" />
                复制全部
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setCiteGate(null)}
                  className="px-3 py-1.5 text-sm bg-seal-600 text-paper-50 rounded-lg hover:bg-seal-700 transition"
                >
                  我先去改正文
                </button>
                <button
                  onClick={() => {
                    setCiteGate(null)
                    void generateLatexFromMarkdown({ skipCiteGate: true })
                  }}
                  className="px-3 py-1.5 text-sm text-ink-600 hover:bg-ink-200 rounded-lg transition"
                >
                  仍然生成
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showActionModal && (
        <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center z-50 p-4">
          <div className="bg-paper-50 rounded-xl shadow-2xl w-full max-w-md flex flex-col">
            <div className="px-4 py-3 border-b border-ink-200 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-ink-800">添加自定义快捷指令</h3>
                <p className="text-[0.6875rem] text-ink-400 mt-0.5">
                  可以直接写 prompt，也可以给一句需求让 AI 生成
                </p>
              </div>
              <button
                onClick={() => setShowActionModal(false)}
                className="p-1 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-ink-600 mb-1">给一句需求，让 AI 生成 prompt</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={actionRequirement}
                    onChange={(e) => setActionRequirement(e.target.value)}
                    placeholder="例如：帮我把一段中文摘要改写成期刊风格"
                    className="flex-1 px-3 py-2 text-sm border border-ink-200 rounded-lg focus:outline-none focus:border-seal-400"
                  />
                  <button
                    onClick={handleGeneratePrompt}
                    disabled={isGeneratingPrompt || !actionRequirement.trim()}
                    className="px-3 py-2 text-xs bg-seal-50 text-seal-700 rounded-lg hover:bg-seal-100 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1 flex-shrink-0"
                  >
                    {isGeneratingPrompt ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                    AI 生成
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-600 mb-1">指令名称</label>
                <input
                  type="text"
                  value={newActionLabel}
                  onChange={(e) => setNewActionLabel(e.target.value)}
                  placeholder="例如：改写成期刊风格"
                  className="w-full px-3 py-2 text-sm border border-ink-200 rounded-lg focus:outline-none focus:border-seal-400"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-ink-600 mb-1">指令内容（点一下就会填进输入框）</label>
                <textarea
                  value={newActionPrompt}
                  onChange={(e) => setNewActionPrompt(e.target.value)}
                  rows={5}
                  placeholder="发送给 AI 的提示词..."
                  className="w-full px-3 py-2 text-sm border border-ink-200 rounded-lg focus:outline-none focus:border-seal-400 resize-y"
                />
              </div>
            </div>

            <div className="px-4 py-3 border-t border-ink-200 bg-paper-100/50 flex justify-end gap-2">
              <button
                onClick={() => setShowActionModal(false)}
                className="px-3 py-1.5 text-sm text-ink-600 hover:bg-ink-200 rounded-lg transition"
              >
                取消
              </button>
              <button
                onClick={handleSaveAction}
                disabled={!newActionLabel.trim() || !newActionPrompt.trim()}
                className="px-3 py-1.5 text-sm bg-seal-600 text-paper-50 rounded-lg hover:bg-seal-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {showPaperSelector && (
        <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center z-50 p-4">
          <div className="bg-paper-50 rounded-xl shadow-2xl w-full max-w-md max-h-[70vh] flex flex-col">
            <div className="px-4 py-3 border-b border-ink-200 flex items-center justify-between">
              <h3 className="text-base font-semibold text-ink-800">选择指定文献</h3>
              <button
                onClick={() => setShowPaperSelector(false)}
                className="p-1 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded transition"
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
                        ? 'border-seal-400 bg-seal-50/60'
                        : 'border-ink-200 hover:border-seal-200 hover:bg-paper-100'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${
                        isSelected ? 'bg-seal-600 border-seal-600' : 'border-ink-300'
                      }`}>
                        {isSelected && <Check className="w-3 h-3 text-paper-50" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-ink-700 line-clamp-2 leading-snug">
                          {cit.title}
                        </div>
                        <div className="text-[0.6875rem] text-ink-500 mt-1">
                          {cit.journal} ({cit.year})
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="px-4 py-3 border-t border-ink-200 bg-paper-100/50 flex justify-end">
              <button
                onClick={() => setShowPaperSelector(false)}
                className="px-4 py-1.5 bg-seal-600 text-paper-50 text-sm rounded-lg hover:bg-seal-700 transition font-medium"
              >
                确定 ({selectedPaperIds.length}篇)
              </button>
            </div>
          </div>
        </div>
      )}

      {showBookSelector && (
        <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center z-50 p-4">
          <div className="bg-paper-50 rounded-xl shadow-2xl w-full max-w-md max-h-[70vh] flex flex-col">
            <div className="px-4 py-3 border-b border-ink-200 flex items-center justify-between">
              <h3 className="text-base font-semibold text-ink-800">选择指定图书</h3>
              <button
                onClick={() => setShowBookSelector(false)}
                className="p-1 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {bookReferences.length === 0 ? (
                <div className="text-center py-8 text-sm text-ink-400">
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
                          ? 'border-seal-400 bg-seal-50/60'
                          : 'border-ink-200 hover:border-seal-200 hover:bg-paper-100'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${
                          isSelected ? 'bg-seal-600 border-seal-600' : 'border-ink-300'
                        }`}>
                          {isSelected && <Check className="w-3 h-3 text-paper-50" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold text-ink-700 line-clamp-2 leading-snug">
                            {book.title}
                          </div>
                          <div className="text-[0.6875rem] text-ink-500 mt-1">
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
            <div className="px-4 py-3 border-t border-ink-200 bg-paper-100/50 flex justify-end">
              <button
                onClick={() => setShowBookSelector(false)}
                className="px-4 py-1.5 bg-seal-600 text-paper-50 text-sm rounded-lg hover:bg-seal-700 transition font-medium"
              >
                确定 ({selectedBookIds.length}本)
              </button>
            </div>
          </div>
        </div>
      )}

      {showChapterSelector && (
        <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center z-50 p-4">
          <div className="bg-paper-50 rounded-xl shadow-2xl w-full max-w-md max-h-[75vh] flex flex-col">
            <div className="px-4 py-3 border-b border-ink-200 flex items-center justify-between">
              <h3 className="text-base font-semibold text-ink-800">选择章节</h3>
              <button
                onClick={() => setShowChapterSelector(false)}
                className="p-1 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-4 py-2 border-b border-ink-100 bg-paper-100/50">
              <div className="text-xs font-medium text-ink-600 mb-1">选择图书</div>
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
                        ? 'bg-seal-100 text-seal-700 font-medium border border-seal-200'
                        : 'bg-paper-50 text-ink-600 border border-ink-200 hover:border-seal-200'
                    }`}
                  >
                    {book.title.length > 15 ? book.title.slice(0, 15) + '...' : book.title}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {!selectedBookForChapters ? (
                <div className="text-center py-8 text-sm text-ink-400">
                  请先选择一本图书
                </div>
              ) : selectedBook?.chapters.length === 0 ? (
                <div className="text-center py-8 text-sm text-ink-400">
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
                          ? 'border-seal-400 bg-seal-50/60'
                          : 'border-ink-200 hover:border-seal-200 hover:bg-paper-100'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 ${
                          isSelected ? 'bg-seal-600 border-seal-600' : 'border-ink-300'
                        }`}>
                          {isSelected && <Check className="w-3 h-3 text-paper-50" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold text-ink-700 leading-snug">
                            {chapter.title}
                          </div>
                          <div className="text-[0.6875rem] text-ink-500 mt-1">
                            第 {chapter.pageStart} - {chapter.pageEnd} 页
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
            <div className="px-4 py-3 border-t border-ink-200 bg-paper-100/50 flex justify-end">
              <button
                onClick={() => setShowChapterSelector(false)}
                disabled={!selectedBookForChapters || selectedChapterIds.length === 0}
                className="px-4 py-1.5 bg-seal-600 text-paper-50 text-sm rounded-lg hover:bg-seal-700 transition font-medium disabled:opacity-50 disabled:cursor-not-allowed"
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

      {/* 上传期刊 sample .tex：解析成模板（与「宏包导入」是两回事，别混） */}
      <input
        ref={texTemplateInputRef}
        type="file"
        accept=".tex"
        onChange={(e) => {
          void handleImportTexTemplate(e.target.files?.[0])
          // 清空 value，否则同一个文件再选一次不会触发 onChange
          e.target.value = ''
        }}
        className="hidden"
      />

      {/* 上传投稿模板整包（.zip）：交给后端 template_unpack 解包 */}
      <input
        ref={texPackageInputRef}
        type="file"
        accept=".zip,application/zip"
        onChange={(e) => {
          void handleImportTemplatePackage(e.target.files?.[0])
          e.target.value = ''
        }}
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
