/**
 * 追踪页
 * -------------------------------------------------
 * 功能：
 * - 自定义关键词组管理（添加/删除/编辑/启用禁用）
 * - 自定义期刊追踪列表
 * - 学术搜索框（可切换搜索源，优先知网/XMOL）
 * - 快速入库（DOI / arXiv ID）
 * - 追踪结果展示
 */
import { useState, useEffect, useMemo, useRef, type ChangeEvent } from 'react'
import {
  Globe,
  Search,
  Plus,
  X,
  Edit3,
  Trash2,
  ChevronDown,
  Loader2,
  CheckCircle2,
  Tag,
  BookMarked,
  Rss,
  Settings,
  Play,
  Newspaper,
  Radar,
  FileText,
  Upload,
  ExternalLink,
  RotateCcw,
  Languages,
  Sparkles,
  Clock,
} from 'lucide-react'
import { toast } from 'sonner'
import { normalizeDoi, getCitationEntries } from '../services/citation'
import { DoiLink } from '../components/DoiLink'
import { readCsvFile, writeCsvFile } from '../services/userData'
import {
  loadLiteratures,
  saveLiteratures,
  markPaperPdfAdded,
  removeLiterature,
  type Literature,
} from '../services/literatureData'
import { enqueuePaperMineruConvert } from '../services/paperPipeline'
import { translateText } from '../services/asr'
import { useSettingsStore } from '../stores/settings'
import {
  loadTrackingInbox,
  saveTrackingInbox,
  pendingCandidates,
  type TrackingCandidate,
} from '../services/trackingData'
import { dispatchDailyTracking, waitForDailyTracking, syncTrackingCron } from '../services/workflowClient'
import { resolveJournals, findJournalRss, type JournalCandidate } from '../services/journalResolve'
import {
  parseExpression,
  serializeExpression,
  expressionTerms,
  validateExpression,
  type ExprToken,
} from '../services/keywordGroupData'
import {
  loadTrackingPlans,
  saveTrackingPlans,
  newPlanId,
  validatePlan,
  describeSchedule,
  nextRunAt,
  weekdayLabel,
  PLAN_INTERVALS,
  type TrackingPlan,
  type PlanInterval,
} from '../services/trackingPlanData'
import { useWorkspaceStore } from '../stores/workspace'
import { useAuthStore } from '../stores/auth'

// ============================================================
// 类型定义
// ============================================================

interface KeywordGroup {
  id: string
  name: string
  /** 后端列 expression：关键词布尔表达式（AND / OR / NOT + 括号），由标签序列拼装 */
  expression: string
  enabled: boolean
  /** 后端列 translate_abstract（前端暂未暴露开关，读取时保留原值） */
  translateAbstract: boolean
  /** 后端列 created_at（Unix 秒） */
  createdAt: number
}

interface JournalItem {
  id: string
  name: string
  issn?: string
  publisher?: string
  rssUrl?: string
  enabled: boolean
}

// 常见搜索参数名，按优先级排序（长的优先避免误匹配）
const SEARCH_PARAM_NAMES = [
  'search_query', 'query', 'keyword', 'search', 'option',
  'word', 'text', 'wd', 'qs', 'q', 'k',
]

/** 自动检测搜索网址中的查询参数，把值替换为 {query} */
function autoDetectSearchTemplate(url: string): string | null {
  for (const param of SEARCH_PARAM_NAMES) {
    const regex = new RegExp(`([?&]${param}=)([^&#]*)`, 'i')
    const match = url.match(regex)
    if (match && match[2]) {
      return url.replace(regex, `$1{query}`)
    }
  }
  return null
}

interface SearchSite {
  id: string
  name: string
  urlTemplate: string
  color: string
}

// ============================================================
// 常量
// ============================================================

const DEFAULT_SEARCH_SITES: SearchSite[] = [
  { id: 'cnki', name: '中国知网', urlTemplate: 'https://kns.cnki.net/kns8s/defaultresult/index?kw={query}', color: 'bg-red-50 text-red-600' },
  { id: 'xmol', name: 'X-MOL', urlTemplate: 'https://www.x-mol.com/paper/search/q?option={query}', color: 'bg-blue-50 text-blue-600' },
  { id: 'scholar', name: 'Google Scholar', urlTemplate: 'https://scholar.google.com/scholar?q={query}', color: 'bg-paper-100 text-ink-600' },
  { id: 'pubmed', name: 'PubMed', urlTemplate: 'https://pubmed.ncbi.nlm.nih.gov/?term={query}', color: 'bg-seal-50 text-seal-600' },
  { id: 'arxiv', name: 'arXiv', urlTemplate: 'https://arxiv.org/search/?query={query}&searchtype=all', color: 'bg-ink-100 text-ink-600' },
]

// ============================================================
// SPEC §0/§2.3：用户数据全部存 GitHub 私库，不使用 localStorage。
// 搜索源是用户配置 → GitHub CSV；折叠状态是纯 UI 态 → 内存。
// ============================================================

const SEARCH_SITES_PATH = 'settings/search_sites.csv'

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// ============================================================
// 主组件
// ============================================================

export default function TrackingPage() {
  const { repo } = useWorkspaceStore()

  // ---------- 快速入库 ----------
  const [doiInput, setDoiInput] = useState('')
  const [isAdding, setIsAdding] = useState(false)

  // ---------- 关键词组 ----------
  const [keywordGroups, setKeywordGroups] = useState<KeywordGroup[]>([])
  /** 关键词组「管理」弹窗：列出已有 + 新建 / 编辑 / 删除 / 启停 */
  const [showKeywordGroupsModal, setShowKeywordGroupsModal] = useState(false)
  const [showKeywordModal, setShowKeywordModal] = useState(false)
  const [editingKeywordGroup, setEditingKeywordGroup] = useState<KeywordGroup | null>(null)
  const [keywordFormName, setKeywordFormName] = useState('')
  const [keywordFormTokens, setKeywordFormTokens] = useState<ExprToken[]>([])
  const [keywordInput, setKeywordInput] = useState('')
  /** 关键词编辑弹窗里的「运算符」下拉是否展开 */
  const [showKeywordOperatorMenu, setShowKeywordOperatorMenu] = useState(false)

  // ---------- 期刊 ----------
  const [journals, setJournals] = useState<JournalItem[]>([])
  /** 期刊「管理」弹窗：列出已有 + 添加 / 编辑 / 删除 / 启停 */
  const [showJournalsModal, setShowJournalsModal] = useState(false)
  const [showJournalModal, setShowJournalModal] = useState(false)
  const [editingJournal, setEditingJournal] = useState<JournalItem | null>(null)
  const [journalFormName, setJournalFormName] = useState('')
  const [journalFormIssn, setJournalFormIssn] = useState('')
  const [journalFormPublisher, setJournalFormPublisher] = useState('')
  const [journalFormRssUrl, setJournalFormRssUrl] = useState('')
  /** 智能匹配出的期刊候选（点选即填名称/ISSN/出版社） */
  const [journalMatches, setJournalMatches] = useState<JournalCandidate[]>([])
  /** 智能匹配请求中（AI 归一化 + Crossref/OpenAlex 回查可能较慢，需要 loading 反馈） */
  const [isResolvingJournal, setIsResolvingJournal] = useState(false)
  /** RSS 联网检索中（后端 AI 联网较慢，需要 loading 反馈） */
  const [isFindingRss, setIsFindingRss] = useState(false)

  // ---------- 搜索 ----------
  const [searchSites, setSearchSites] = useState<SearchSite[]>(DEFAULT_SEARCH_SITES)
  const [selectedSearchSiteId, setSelectedSearchSiteId] = useState(DEFAULT_SEARCH_SITES[0].id)
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearchDropdown, setShowSearchDropdown] = useState(false)
  const [showSearchManager, setShowSearchManager] = useState(false)
  const [editingSearchSite, setEditingSearchSite] = useState<SearchSite | null>(null)
  const [searchFormName, setSearchFormName] = useState('')
  const [searchFormUrlTemplate, setSearchFormUrlTemplate] = useState('')
  const [searchFormColor, setSearchFormColor] = useState('bg-seal-50 text-seal-600')
  const searchDropdownRef = useRef<HTMLDivElement>(null)

  // ---------- 立即追踪 / 候选 ----------
  const [isTracking, setIsTracking] = useState(false)
  /** 本次（本会话内）追踪结果摘要：追踪了多少期刊 / 关键词组、命中多少新文献 */
  const [trackRun, setTrackRun] = useState<{ groups: number; journals: number; found: number } | null>(null)
  /** 追踪候选（tracking/inbox.csv）：含「待裁决」与「已忽略」两类，页面只显示待裁决 */
  const [inbox, setInbox] = useState<TrackingCandidate[]>([])

  // ---------- 定时追踪计划 ----------
  /** 定时追踪计划（tracking/plans.csv）：一个计划 = 时间规则 + 多个期刊（组内 OR）+ 一个关键词表达式 */
  const [plans, setPlans] = useState<TrackingPlan[]>([])
  /** 计划「管理」弹窗：列出已有 + 新建 / 编辑 / 删除 / 启停 */
  const [showPlansModal, setShowPlansModal] = useState(false)
  const [showPlanModal, setShowPlanModal] = useState(false)
  const [editingPlan, setEditingPlan] = useState<TrackingPlan | null>(null)
  const [planFormName, setPlanFormName] = useState('')
  const [planFormInterval, setPlanFormInterval] = useState<PlanInterval>('daily')
  /** 北京时间 0-23 / 0-59 */
  const [planFormHour, setPlanFormHour] = useState(9)
  const [planFormMinute, setPlanFormMinute] = useState(0)
  /** weekly 用（1-7，周一=1） */
  const [planFormWeekday, setPlanFormWeekday] = useState(1)
  /** monthly 用（1-28） */
  const [planFormDayOfMonth, setPlanFormDayOfMonth] = useState(1)
  /** 该计划追踪的期刊 id 列表（组内 OR） */
  const [planFormJournalIds, setPlanFormJournalIds] = useState<string[]>([])
  const [planFormTokens, setPlanFormTokens] = useState<ExprToken[]>([])
  const [planFormInput, setPlanFormInput] = useState('')
  /** 正在「立即试跑」的计划 id（该行按钮 loading；一次性，不影响定时） */
  const [testingPlanId, setTestingPlanId] = useState<string | null>(null)

  // ---------- 右栏：已入库但还没传 PDF ----------
  /** 文献库（literatures/literatures.csv）全量，右栏只取 pdfAddedAt === 0 的 */
  const [literatures, setLiteratures] = useState<Literature[]>([])
  /** 正在上传 PDF 的文献 DOI（用于该行 loading） */
  const [pdfUploadingDoi, setPdfUploadingDoi] = useState<string | null>(null)
  /** 待上传 PDF 的文献 DOI（隐藏 file input 复用，选中后再打开文件选择器） */
  const [pdfInputDoi, setPdfInputDoi] = useState<string | null>(null)
  const pdfInputRef = useRef<HTMLInputElement>(null)
  /** 标题译文缓存镜像（供自动翻译队列判断「是否已译」，不触发重渲染） */
  const translatedTitlesRef = useRef<Record<string, string>>({})
  /** 正在翻译的 DOI（防止重复入队） */
  const translatingRef = useRef<Set<string>>(new Set())
  /** 自动翻译失败只提示一次，避免刷屏 */
  const translationErrorShownRef = useRef(false)
  /** 右栏批量操作选中的 DOI */
  const [selectedLibraryDois, setSelectedLibraryDois] = useState<string[]>([])
  /** 中栏批量操作选中的候选 DOI */
  const [selectedCandidateDois, setSelectedCandidateDois] = useState<string[]>([])
  /** 关键词组「管理」弹窗：批量操作选中的分组 id */
  const [selectedKeywordGroupIds, setSelectedKeywordGroupIds] = useState<string[]>([])
  /** 期刊「管理」弹窗：批量操作选中的期刊 id */
  const [selectedJournalIds, setSelectedJournalIds] = useState<string[]>([])
  /** 中栏标题译文缓存（DOI → 中文标题）；默认显示中文，缓存避免重复翻译 */
  const [translatedTitles, setTranslatedTitles] = useState<Record<string, string>>({})
  /** 中栏想看英文原标题的候选 DOI（默认显示中文标题） */
  const [showOriginalTitleDois, setShowOriginalTitleDois] = useState<string[]>([])
  /** 中栏正在翻译（自动 + 手动）标题的候选 DOI，用于按钮 loading */
  const [translatingTitleDois, setTranslatingTitleDois] = useState<string[]>([])

  // ============================================================
  // 持久化（全部存 GitHub 私库，不使用 localStorage —— SPEC §0/§2.3）
  // ============================================================

  // 关键词组 & 期刊 & 搜索源从 GitHub 私库加载
  const dataLoadedRef = useRef(false)
  useEffect(() => {
    if (!repo) return
    let cancelled = false
    async function loadData() {
      try {
        const groups = await readCsvFile<KeywordGroup>(
          'keyword_groups/keyword_groups.csv',
          (rows) => {
            if (rows.length <= 1) return []
            return rows.slice(1).map((r) => ({
              id: r[0] || '',
              name: r[1] || '',
              // expression 是布尔检索式（AND / OR / NOT + 括号），原样保留交给后端求值
              expression: r[2] || '',
              enabled: r[3] === '1' || r[3] === 'true',
              translateAbstract: r[4] === '1' || r[4] === 'true',
              createdAt: parseInt(r[5] || '0', 10) || 0,
            }))
          },
        )
        if (!cancelled && groups.length > 0) {
          setKeywordGroups(groups)
        }
      } catch (err) {
        console.warn('[Tracking] 从 GitHub 加载关键词组失败:', err)
      }

      try {
        const loadedJournals = await readCsvFile<JournalItem>(
          'journals/journal_tracking.csv',
          (rows) => {
            if (rows.length <= 1) return []
            // 表头：id,name,rss_url,enabled,issn,publisher（后两列由 v8 迁移补齐）
            return rows.slice(1).map((r) => ({
              id: r[0] || '',
              name: r[1] || '',
              rssUrl: r[2] || undefined,
              enabled: r[3] === '1' || r[3] === 'true',
              issn: r[4] || undefined,
              publisher: r[5] || undefined,
            }))
          },
        )
        if (!cancelled && loadedJournals.length > 0) {
          setJournals(loadedJournals)
        }
      } catch (err) {
        console.warn('[Tracking] 从 GitHub 加载期刊失败:', err)
      }

      // 追踪候选（后端「每日追踪」的产物，不再是前端占位数据）
      try {
        const inboxRows = await loadTrackingInbox()
        if (!cancelled) setInbox(inboxRows)
      } catch (err) {
        console.warn('[Tracking] 从 GitHub 加载追踪候选失败:', err)
      }

      // 定时追踪计划（时间规则 + 多期刊 + 单个表达式）
      try {
        const loadedPlans = await loadTrackingPlans()
        if (!cancelled && loadedPlans.length > 0) setPlans(loadedPlans)
      } catch (err) {
        console.warn('[Tracking] 从 GitHub 加载定时计划失败:', err)
      }

      // 文献库（右栏「已入库未传 PDF」的数据源）
      try {
        const lits = await loadLiteratures()
        if (!cancelled) setLiteratures(lits)
      } catch (err) {
        console.warn('[Tracking] 从 GitHub 加载文献库失败:', err)
      }

      // 搜索源从 GitHub 私库加载
      try {
        const loadedSites = await readCsvFile<SearchSite>(
          SEARCH_SITES_PATH,
          (rows) => {
            if (rows.length <= 1) return []
            return rows.slice(1).map((r) => ({
              id: r[0] || '',
              name: r[1] || '',
              urlTemplate: r[2] || '',
              color: r[3] || 'bg-seal-50 text-seal-600',
            }))
          },
        )
        if (!cancelled && loadedSites.length > 0) {
          // 迁移：旧版 X-MOL 模板（?q=）→ 新版（/q?option=），用户无感知升级
          let migrated = false
          const migratedSites = loadedSites.map((s) => {
            if (s.id === 'xmol' && s.urlTemplate === 'https://www.x-mol.com/paper/search?q={query}') {
              migrated = true
              return { ...s, urlTemplate: 'https://www.x-mol.com/paper/search/q?option={query}' }
            }
            return s
          })
          setSearchSites(migratedSites)
          setSelectedSearchSiteId(migratedSites[0].id)
          // 发生迁移时，标记 dataLoaded 让防抖 effect 把新模板写回 CSV
          if (migrated) dataLoadedRef.current = true
        }
      } catch (err) {
        console.warn('[Tracking] 从 GitHub 加载搜索源失败，使用默认值:', err)
      }

      if (!cancelled) dataLoadedRef.current = true
    }
    loadData()
    return () => {
      cancelled = true
    }
  }, [repo])

  // 关键词组变化时防抖保存到 GitHub
  const keywordGroupsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!dataLoadedRef.current) return
    if (keywordGroupsSaveTimerRef.current) clearTimeout(keywordGroupsSaveTimerRef.current)
    keywordGroupsSaveTimerRef.current = setTimeout(async () => {
      try {
        await writeCsvFile(
          'keyword_groups/keyword_groups.csv',
          keywordGroups,
          // ⚠️ 表头必须与骨架 CSV_HEADERS.keyword_groups 逐字一致：
          //   后端 daily_tracking.py 按 group_id / group_name / expression 读取，
          //   字段名对不上（例如写成 keywords）后端就取不到关键词。
          ['group_id', 'group_name', 'expression', 'enabled', 'translate_abstract', 'created_at'],
          (g) => [
            g.id,
            g.name,
            g.expression,
            g.enabled ? 'true' : 'false',
            g.translateAbstract ? 'true' : 'false',
            String(g.createdAt || Date.now()),
          ],
        )
      } catch (err) {
        console.error('[Tracking] 保存关键词组到 GitHub 失败:', err)
      }
    }, 2000)
    return () => {
      if (keywordGroupsSaveTimerRef.current) clearTimeout(keywordGroupsSaveTimerRef.current)
    }
  }, [keywordGroups])

  // 期刊变化时防抖保存到 GitHub
  const journalsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!dataLoadedRef.current) return
    if (journalsSaveTimerRef.current) clearTimeout(journalsSaveTimerRef.current)
    journalsSaveTimerRef.current = setTimeout(async () => {
      try {
        await writeCsvFile(
          'journals/journal_tracking.csv',
          journals,
          // ⚠️ 表头必须与 v8 迁移后的表头逐字一致：
          //   后端 daily_tracking.py 按 issn 精确检索 OpenAlex，issn 列丢了期刊就只能靠反查。
          ['id', 'name', 'rss_url', 'enabled', 'issn', 'publisher'],
          (j) => [j.id, j.name, j.rssUrl || '', j.enabled ? '1' : '0', j.issn || '', j.publisher || ''],
        )
      } catch (err) {
        console.error('[Tracking] 保存期刊到 GitHub 失败:', err)
      }
    }, 2000)
    return () => {
      if (journalsSaveTimerRef.current) clearTimeout(journalsSaveTimerRef.current)
    }
  }, [journals])

  // 定时计划变化时防抖保存到 GitHub，并按需重写 workflow 的 schedule（动态 cron）
  const plansSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!dataLoadedRef.current) return
    if (plansSaveTimerRef.current) clearTimeout(plansSaveTimerRef.current)
    plansSaveTimerRef.current = setTimeout(async () => {
      try {
        await saveTrackingPlans(plans)
        // 计划变了 → 只为「启用计划实际用到的 时:分」排 cron；没有计划就不排，避免空跑
        const { token, user } = useAuthStore.getState()
        if (token && user && repo) {
          await syncTrackingCron(user.login, repo.name, token, plans)
        }
      } catch (err) {
        console.error('[Tracking] 保存定时计划 / 同步 cron 失败:', err)
      }
    }, 2000)
    return () => {
      if (plansSaveTimerRef.current) clearTimeout(plansSaveTimerRef.current)
    }
  }, [plans, repo])

  // 搜索源变化时防抖保存到 GitHub
  const searchSitesSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!dataLoadedRef.current) return
    if (searchSitesSaveTimerRef.current) clearTimeout(searchSitesSaveTimerRef.current)
    searchSitesSaveTimerRef.current = setTimeout(async () => {
      try {
        await writeCsvFile(
          SEARCH_SITES_PATH,
          searchSites,
          ['id', 'name', 'url_template', 'color'],
          (s) => [s.id, s.name, s.urlTemplate, s.color],
        )
      } catch (err) {
        console.error('[Tracking] 保存搜索源到 GitHub 失败:', err)
      }
    }, 2000)
    return () => {
      if (searchSitesSaveTimerRef.current) clearTimeout(searchSitesSaveTimerRef.current)
    }
  }, [searchSites])

  // 点击外部关闭搜索下拉
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchDropdownRef.current && !searchDropdownRef.current.contains(e.target as Node)) {
        setShowSearchDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // ============================================================
  // 快速入库
  // ============================================================

  // 写入文献库（literatures/literatures.csv），按 DOI 去重
  const addLiteratureToLibrary = async (lit: Literature): Promise<'added' | 'exists'> => {
    const lits = await loadLiteratures()
    if (lits.some((l) => l.doi === lit.doi)) {
      return 'exists'
    }
    await saveLiteratures([...lits, lit])
    return 'added'
  }

  const toastAdded = (title: string, status: 'added' | 'exists') => {
    if (status !== 'exists') return
    const short = title.slice(0, 40)
    const suffix = title.length > 40 ? '...' : ''
    toast.message(`已在库中：${short}${suffix}`)
  }

  const handleAddByDoi = async () => {
    const result = normalizeDoi(doiInput)
    if (!result.valid || !result.doi) {
      toast.error('请输入有效的 DOI 或 DOI 链接')
      return
    }
    setIsAdding(true)
    try {
      const { entries, failed } = await getCitationEntries([result.doi])
      if (failed.length > 0) {
        toast.error('DOI 解析失败，请检查输入')
        return
      }
      const meta = entries[0]
      const newLit: Literature = {
        doi: meta.doi,
        title: meta.title,
        journal: meta.journal || '',
        year: meta.year || 0,
        authors: meta.authors.join(', '),
        keywords: '',
        // 元数据里的摘要要收下 —— 它是摘要翻译练习的题面/参考答案来源
        abstractEn: (meta.abstract || '').trim(),
        abstractCn: '',
        tier: 0,
        hasGraphicalAbstract: false,
        addedAt: Date.now(),
        pdfAddedAt: 0,
        source: 'DOI',
        trackingGroup: '',
        mdStatus: 'none',
        correspondingAuthor: '',
      }
      const status = await addLiteratureToLibrary(newLit)
      if (status === 'added') setLiteratures((prev) => [...prev, newLit])
      toastAdded(meta.title, status)
      setDoiInput('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`入库失败：${msg}`)
    } finally {
      setIsAdding(false)
    }
  }

  // ============================================================
  // 关键词组管理
  // ============================================================

  const openAddKeywordGroup = () => {
    setEditingKeywordGroup(null)
    setKeywordFormName('')
    setKeywordFormTokens([])
    setKeywordInput('')
    setShowKeywordOperatorMenu(false)
    setShowKeywordModal(true)
  }

  const openEditKeywordGroup = (group: KeywordGroup) => {
    setEditingKeywordGroup(group)
    setKeywordFormName(group.name)
    setKeywordFormTokens(parseExpression(group.expression))
    setKeywordInput('')
    setShowKeywordOperatorMenu(false)
    setShowKeywordModal(true)
  }

  const handleSaveKeywordGroup = () => {
    if (!keywordFormName.trim()) {
      toast.error('请输入关键词组名称')
      return
    }
    // 先约束：表达式结构非法直接拦下，不让「看起来像结果其实是垃圾」的式子进库
    const exprError = validateExpression(keywordFormTokens)
    if (exprError) {
      toast.error(exprError)
      return
    }
    const expression = serializeExpression(keywordFormTokens)

    if (editingKeywordGroup) {
      setKeywordGroups((prev) =>
        prev.map((g) =>
          g.id === editingKeywordGroup.id
            ? { ...g, name: keywordFormName.trim(), expression }
            : g,
        ),
      )
    } else {
      const newGroup: KeywordGroup = {
        id: generateId(),
        name: keywordFormName.trim(),
        expression,
        enabled: true,
        translateAbstract: false,
        createdAt: Date.now(),
      }
      setKeywordGroups((prev) => [...prev, newGroup])
    }
    setShowKeywordModal(false)
  }

  const handleDeleteKeywordGroup = (id: string) => {
    setKeywordGroups((prev) => prev.filter((g) => g.id !== id))
    setSelectedKeywordGroupIds((prev) => prev.filter((x) => x !== id))
  }

  /** 关键词组「全选」：语义是全选当前列表里的全部（无筛选） */
  const toggleSelectAllKeywordGroups = () => {
    const allIds = keywordGroups.map((g) => g.id)
    const allSelected = allIds.length > 0 && allIds.every((id) => selectedKeywordGroupIds.includes(id))
    setSelectedKeywordGroupIds(allSelected ? [] : allIds)
  }

  const handleBatchDeleteKeywordGroups = () => {
    const count = selectedKeywordGroupIds.filter((id) => keywordGroups.some((g) => g.id === id)).length
    if (count === 0) return
    if (!window.confirm(`确定删除选中的 ${count} 个关键词组？此操作不可撤销。`)) return
    const selected = new Set(selectedKeywordGroupIds)
    setKeywordGroups((prev) => prev.filter((g) => !selected.has(g.id)))
    setSelectedKeywordGroupIds([])
  }

  const toggleKeywordGroupSelect = (id: string) => {
    setSelectedKeywordGroupIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const toggleKeywordGroup = (id: string) => {
    setKeywordGroups((prev) =>
      prev.map((g) => (g.id === id ? { ...g, enabled: !g.enabled } : g)),
    )
  }

  const addKeywordTag = () => {
    // 去掉会破坏表达式语法的引号 / 括号（后端按裸词或双引号短语解析）
    const kw = keywordInput.trim().replace(/["()]/g, '').trim()
    if (!kw) return
    if (expressionTerms(keywordFormTokens).some((t) => t.toLowerCase() === kw.toLowerCase())) {
      toast.error('该关键词已存在')
      return
    }
    setKeywordFormTokens((prev) => {
      const last = prev[prev.length - 1]
      // 前一个 token 是关键词 / 右括号时，补一个显式 AND（相邻词默认 AND）
      const needAnd = !!last && (last.kind === 'term' || (last.kind === 'op' && last.value === ')'))
      return needAnd
        ? [...prev, { kind: 'op', value: 'AND' }, { kind: 'term', value: kw }]
        : [...prev, { kind: 'term', value: kw }]
    })
    setKeywordInput('')
  }

  /** 运算符下拉：把 AND / OR / NOT / 括号追加到表达式末尾 */
  const appendKeywordOperator = (op: 'AND' | 'OR' | 'NOT' | '(' | ')') => {
    setKeywordFormTokens((prev) => [...prev, { kind: 'op', value: op }])
    setKeywordInput('')
  }

  const removeKeywordTag = (index: number) => {
    setKeywordFormTokens((prev) => prev.filter((_, i) => i !== index))
  }

  // ============================================================
  // 定时追踪计划管理
  // 一个计划 = 时间规则 + 多个期刊（组内 OR）+ 一个关键词表达式。
  // 想追踪不同主题 → 建多个计划；**不需要**问「多个词组之间是什么关系」。
  // ============================================================

  const openAddPlan = () => {
    setEditingPlan(null)
    setPlanFormName('')
    setPlanFormInterval('daily')
    setPlanFormHour(9)
    setPlanFormMinute(0)
    setPlanFormWeekday(1)
    setPlanFormDayOfMonth(1)
    setPlanFormJournalIds([])
    setPlanFormTokens([])
    setPlanFormInput('')
    setShowPlanModal(true)
  }

  const openEditPlan = (plan: TrackingPlan) => {
    setEditingPlan(plan)
    setPlanFormName(plan.planName)
    setPlanFormInterval(plan.interval)
    setPlanFormHour(plan.hour)
    setPlanFormMinute(plan.minute)
    setPlanFormWeekday(plan.weekdays[0] || 1)
    setPlanFormDayOfMonth(plan.dayOfMonth || 1)
    setPlanFormJournalIds(plan.journalIds)
    setPlanFormTokens(parseExpression(plan.expression))
    setPlanFormInput('')
    setShowPlanModal(true)
  }

  const handleSavePlan = () => {
    // 先约束：表达式结构非法直接拦下，不让「看着像结果其实是垃圾」的式子进库
    const exprError = validateExpression(planFormTokens)
    if (exprError) {
      toast.error(exprError)
      return
    }
    const draft: TrackingPlan = {
      planId: editingPlan?.planId || newPlanId(),
      planName: planFormName.trim(),
      enabled: editingPlan?.enabled ?? true,
      interval: planFormInterval,
      hour: planFormHour,
      minute: planFormMinute,
      weekdays: planFormInterval === 'weekly' ? [planFormWeekday] : [],
      dayOfMonth: planFormInterval === 'monthly' ? planFormDayOfMonth : 0,
      journalIds: planFormJournalIds,
      expression: serializeExpression(planFormTokens),
      translateAbstract: editingPlan?.translateAbstract ?? false,
      lastRunDate: editingPlan?.lastRunDate ?? '',
      createdAt: editingPlan?.createdAt ?? Date.now(),
    }
    const planError = validatePlan(draft)
    if (planError) {
      toast.error(planError)
      return
    }
    if (editingPlan) {
      setPlans((prev) => prev.map((p) => (p.planId === editingPlan.planId ? draft : p)))
    } else {
      setPlans((prev) => [...prev, draft])
    }
    setShowPlanModal(false)
  }

  const handleDeletePlan = (planId: string) => {
    setPlans((prev) => prev.filter((p) => p.planId !== planId))
  }

  const togglePlan = (planId: string) => {
    setPlans((prev) => prev.map((p) => (p.planId === planId ? { ...p, enabled: !p.enabled } : p)))
  }

  const togglePlanJournal = (journalId: string) => {
    setPlanFormJournalIds((prev) =>
      prev.includes(journalId) ? prev.filter((x) => x !== journalId) : [...prev, journalId],
    )
  }

  /** 从现成关键词组导入表达式（也可完全手写）—— 复用现成、但不限制只能用它 */
  const importKeywordGroupToPlan = (groupId: string) => {
    const g = keywordGroups.find((x) => x.id === groupId)
    if (!g) return
    setPlanFormTokens(parseExpression(g.expression))
  }

  const addPlanTag = () => {
    const kw = planFormInput.trim().replace(/["()]/g, '').trim()
    if (!kw) return
    if (expressionTerms(planFormTokens).some((t) => t.toLowerCase() === kw.toLowerCase())) {
      toast.error('该关键词已存在')
      return
    }
    setPlanFormTokens((prev) => {
      const last = prev[prev.length - 1]
      const needAnd = !!last && (last.kind === 'term' || (last.kind === 'op' && last.value === ')'))
      return needAnd
        ? [...prev, { kind: 'op', value: 'AND' }, { kind: 'term', value: kw }]
        : [...prev, { kind: 'term', value: kw }]
    })
    setPlanFormInput('')
  }

  const appendPlanOperator = (op: 'AND' | 'OR' | 'NOT' | '(' | ')') => {
    setPlanFormTokens((prev) => [...prev, { kind: 'op', value: op }])
    setPlanFormInput('')
  }

  const removePlanTag = (index: number) => {
    setPlanFormTokens((prev) => prev.filter((_, i) => i !== index))
  }

  /** 表单预览：由当前表单字段拼一个临时计划，交给 describeSchedule 生成可读时间规则 */
  const planFormPreview: TrackingPlan = {
    planId: '',
    planName: planFormName,
    enabled: true,
    interval: planFormInterval,
    hour: planFormHour,
    minute: planFormMinute,
    weekdays: planFormInterval === 'weekly' ? [planFormWeekday] : [],
    dayOfMonth: planFormInterval === 'monthly' ? planFormDayOfMonth : 0,
    journalIds: planFormJournalIds,
    expression: '',
    translateAbstract: false,
    lastRunDate: editingPlan?.lastRunDate ?? '',
    createdAt: editingPlan?.createdAt ?? Date.now(),
  }

  // ============================================================
  // 期刊管理
  // ============================================================

  const openAddJournal = () => {
    setEditingJournal(null)
    setJournalFormName('')
    setJournalFormIssn('')
    setJournalFormPublisher('')
    setJournalFormRssUrl('')
    setJournalMatches([])
    setIsFindingRss(false)
    setShowJournalModal(true)
  }

  const openEditJournal = (journal: JournalItem) => {
    setEditingJournal(journal)
    setJournalFormName(journal.name)
    setJournalFormIssn(journal.issn || '')
    setJournalFormPublisher(journal.publisher || '')
    setJournalFormRssUrl(journal.rssUrl || '')
    setJournalMatches([])
    setIsFindingRss(false)
    setShowJournalModal(true)
  }

  const handleSaveJournal = () => {
    if (!journalFormName.trim()) {
      toast.error('请输入期刊名称')
      return
    }

    if (editingJournal) {
      setJournals((prev) =>
        prev.map((j) =>
          j.id === editingJournal.id
            ? {
                ...j,
                name: journalFormName.trim(),
                issn: journalFormIssn.trim() || undefined,
                publisher: journalFormPublisher.trim() || undefined,
                rssUrl: journalFormRssUrl.trim() || undefined,
              }
            : j,
        ),
      )
    } else {
      const newJournal: JournalItem = {
        id: generateId(),
        name: journalFormName.trim(),
        issn: journalFormIssn.trim() || undefined,
        publisher: journalFormPublisher.trim() || undefined,
        rssUrl: journalFormRssUrl.trim() || undefined,
        enabled: true,
      }
      setJournals((prev) => [...prev, newJournal])
    }
    setShowJournalModal(false)
  }

  const handleDeleteJournal = (id: string) => {
    setJournals((prev) => prev.filter((j) => j.id !== id))
    setSelectedJournalIds((prev) => prev.filter((x) => x !== id))
  }

  /** 期刊「全选」：语义是全选当前列表里的全部（无筛选） */
  const toggleSelectAllJournals = () => {
    const allIds = journals.map((j) => j.id)
    const allSelected = allIds.length > 0 && allIds.every((id) => selectedJournalIds.includes(id))
    setSelectedJournalIds(allSelected ? [] : allIds)
  }

  const handleBatchDeleteJournals = () => {
    const count = selectedJournalIds.filter((id) => journals.some((j) => j.id === id)).length
    if (count === 0) return
    if (!window.confirm(`确定删除选中的 ${count} 个期刊？此操作不可撤销。`)) return
    const selected = new Set(selectedJournalIds)
    setJournals((prev) => prev.filter((j) => !selected.has(j.id)))
    setSelectedJournalIds([])
  }

  const toggleJournalSelect = (id: string) => {
    setSelectedJournalIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const toggleJournal = (id: string) => {
    setJournals((prev) =>
      prev.map((j) => (j.id === id ? { ...j, enabled: !j.enabled } : j)),
    )
  }

  /**
   * 智能匹配：把用户填的模糊输入（中文名 / 简称 / 大小写随意的英文 / 记不清的片段）
   * 解析成期刊候选。走 Crossref（刊名 / ISSN / 出版社的权威源）+ OpenAlex（能否追踪的验证源），
   * 中文等模糊输入才动用 AI 归一化；全程无需用户在本机配 AI Key。
   */
  const handleResolveJournal = async () => {
    const q = journalFormName.trim()
    if (!q) {
      toast.error('请先输入期刊名称或关键词')
      return
    }
    setIsResolvingJournal(true)
    setJournalMatches([])
    try {
      const matches = await resolveJournals(q)
      if (matches.length === 0) {
        toast.error('没找到匹配的期刊，换个写法或直接手动填写')
      } else {
        setJournalMatches(matches)
      }
    } catch {
      toast.error('智能匹配失败，请稍后重试或直接手动填写')
    } finally {
      setIsResolvingJournal(false)
    }
  }

  /** 点选候选：把权威刊名 / ISSN / 出版社填进表单 */
  const applyJournalMatch = (m: JournalCandidate) => {
    setJournalFormName(m.name)
    if (m.issn) setJournalFormIssn(m.issn)
    if (m.publisher) setJournalFormPublisher(m.publisher)
    setJournalMatches([])
    if (m.trackable === false) {
      toast.warning('该刊未见后端检索库收录，可能追踪不到新文章')
    }
  }

  /**
   * 自动找 RSS：期刊 feed 不带 CORS 头，浏览器直连不了，交给后端 AI 联网检索。
   * 检索到的地址只做预填，仍需用户确认后保存。
   */
  const handleFindRss = async () => {
    const name = journalFormName.trim()
    if (!name) {
      toast.error('请先填写期刊名称')
      return
    }
    setIsFindingRss(true)
    try {
      const rss = await findJournalRss(name, journalFormIssn.trim() || undefined)
      if (!rss) {
        toast.error('没找到官方 RSS 地址，可手动填写或留空')
      } else {
        setJournalFormRssUrl(rss)
      }
    } catch {
      toast.error('RSS 检索失败，可手动填写或留空')
    } finally {
      setIsFindingRss(false)
    }
  }

  // ============================================================
  // 搜索站点管理
  // ============================================================

  const selectedSearchSite = searchSites.find((s) => s.id === selectedSearchSiteId) || searchSites[0]

  const handleSearch = () => {
    const query = searchQuery.trim()
    if (!query) {
      toast.error('请输入搜索关键词')
      return
    }
    if (!selectedSearchSite) return
    const url = selectedSearchSite.urlTemplate.replace('{query}', encodeURIComponent(query))
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const openAddSearchSite = () => {
    setEditingSearchSite(null)
    setSearchFormName('')
    setSearchFormUrlTemplate('')
    setSearchFormColor('bg-seal-50 text-seal-600')
    setShowSearchManager(true)
  }

  const openEditSearchSite = (site: SearchSite) => {
    setEditingSearchSite(site)
    setSearchFormName(site.name)
    setSearchFormUrlTemplate(site.urlTemplate)
    setSearchFormColor(site.color)
    setShowSearchManager(true)
  }

  const handleSaveSearchSite = () => {
    if (!searchFormName.trim()) {
      toast.error('请输入网站名称')
      return
    }
    if (!searchFormUrlTemplate.trim()) {
      toast.error('请粘贴搜索网址')
      return
    }

    // 自动检测搜索参数并生成模板：
    // - 网址中已含 {query}（编辑已有搜索源）→ 直接用
    // - 否则尝试自动识别 wd= / q= / query= 等常见参数
    let template = searchFormUrlTemplate.trim()
    if (!template.includes('{query}')) {
      const detected = autoDetectSearchTemplate(template)
      if (!detected) {
        toast.error('无法识别搜索参数，请确认网址是用搜索功能打开的（需包含 ?q= 或 ?wd= 等参数）')
        return
      }
      template = detected
    }

    if (editingSearchSite) {
      setSearchSites((prev) =>
        prev.map((s) =>
          s.id === editingSearchSite.id
            ? { ...s, name: searchFormName.trim(), urlTemplate: template, color: searchFormColor }
            : s,
        ),
      )
    } else {
      const newSite: SearchSite = {
        id: generateId(),
        name: searchFormName.trim(),
        urlTemplate: template,
        color: searchFormColor,
      }
      setSearchSites((prev) => [...prev, newSite])
    }
    setShowSearchManager(false)
  }

  const handleDeleteSearchSite = (id: string) => {
    if (searchSites.length <= 1) {
      toast.error('至少保留一个搜索源')
      return
    }
    setSearchSites((prev) => prev.filter((s) => s.id !== id))
    if (selectedSearchSiteId === id) {
      const remaining = searchSites.filter((s) => s.id !== id)
      if (remaining.length > 0) {
        setSelectedSearchSiteId(remaining[0].id)
      }
    }
  }

  const resetSearchSites = () => {
    setSearchSites(DEFAULT_SEARCH_SITES)
    setSelectedSearchSiteId(DEFAULT_SEARCH_SITES[0].id)
  }

  // ============================================================
  // 立即追踪（真触发后端 workflow，不再造假动画）
  // ============================================================

  const handleTrackNow = async () => {
    const enabledGroups = keywordGroups.filter((g) => g.enabled)
    const enabledJournals = journals.filter((j) => j.enabled)
    if (enabledGroups.length === 0 && enabledJournals.length === 0) {
      toast.error('请先启用至少一个关键词组或期刊')
      return
    }
    const { token, user } = useAuthStore.getState()
    if (!token || !user || !repo) {
      toast.error('未登录或工作区未就绪')
      return
    }

    setIsTracking(true)
    try {
      // 跑之前先记下现有候选的 DOI，跑完用差集算「本次新增」——确定、不靠猜时间戳
      const beforeDois = new Set((await loadTrackingInbox()).map((r) => r.doi))
      const sinceIso = new Date().toISOString()
      await dispatchDailyTracking(user.login, repo.name, token)

      const result = await waitForDailyTracking(user.login, repo.name, token, sinceIso)
      if (result === 'failure') {
        toast.error('追踪任务失败，请到 Actions 查看日志')
      } else if (result === 'timeout') {
        toast.message('后端仍在运行，稍后会自动出现在候选里')
      }

      const rows = await loadTrackingInbox(true)
      setInbox(rows)
      const pending = pendingCandidates(rows)
      const found = pending.filter((r) => !beforeDois.has(r.doi)).length
      setTrackRun({ groups: enabledGroups.length, journals: enabledJournals.length, found })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`追踪失败：${msg}`)
    } finally {
      setIsTracking(false)
    }
  }

  /**
   * 立即试跑单个计划（一次性验证）：只跑这一个计划的管线，不写 last_run_date、不影响定时防重。
   * 与「立即追踪」共用同一后端 workflow，只是带上 plan_id。
   */
  const handleTestPlan = async (plan: TrackingPlan) => {
    const { token, user } = useAuthStore.getState()
    if (!token || !user || !repo) {
      toast.error('未登录或工作区未就绪')
      return
    }
    if (!plan.journalIds.length && !plan.expression.trim()) {
      toast.error('该计划未选期刊、也没有关键词表达式，跑不出结果')
      return
    }
    setTestingPlanId(plan.planId)
    try {
      const beforeDois = new Set((await loadTrackingInbox()).map((r) => r.doi))
      const sinceIso = new Date().toISOString()
      await dispatchDailyTracking(user.login, repo.name, token, plan.planId)

      const result = await waitForDailyTracking(user.login, repo.name, token, sinceIso)
      if (result === 'failure') {
        toast.error(`计划「${plan.planName}」试跑失败，请到 Actions 查看日志`)
      } else if (result === 'timeout') {
        toast.message('试跑仍在运行，稍后会自动出现在候选里')
      }

      const rows = await loadTrackingInbox(true)
      setInbox(rows)
      const found = pendingCandidates(rows).filter((r) => !beforeDois.has(r.doi)).length
      if (result === 'success') {
        toast.success(`计划「${plan.planName}」试跑完成，新增候选 ${found} 篇`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`试跑失败：${msg}`)
    } finally {
      setTestingPlanId(null)
    }
  }

  // ============================================================
  // 候选裁决：入库 / 忽略
  // ============================================================
  const candidateToLiterature = (c: TrackingCandidate): Literature => ({
    doi: c.doi,
    title: c.title,
    journal: c.journal,
    year: c.year,
    authors: c.authors,
    keywords: c.keywords,
    abstractEn: c.abstractEn,
    abstractCn: '',
    tier: 0,
    hasGraphicalAbstract: false,
    addedAt: Date.now(),
    pdfAddedAt: 0,
    source: c.source || '追踪',
    trackingGroup: c.trackingGroup,
    mdStatus: 'none',
    correspondingAuthor: '',
  })

  const handleIngestCandidate = async (c: TrackingCandidate) => {
    if (!c.doi) {
      toast.error('该候选缺少 DOI，无法入库')
      return
    }
    try {
      const newLit = candidateToLiterature(c)
      const status = await addLiteratureToLibrary(newLit)
      if (status === 'added') setLiteratures((prev) => [...prev, newLit])
      // 入库后从候选里移除：它已经在 literatures.csv，后续靠 DOI 去重
      const next = inbox.filter((r) => r.doi !== c.doi)
      await saveTrackingInbox(next)
      setInbox(next)
      setSelectedCandidateDois((prev) => prev.filter((d) => d !== c.doi))
      toastAdded(c.title, status)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`入库失败：${msg}`)
    }
  }

  const handleDismissCandidate = async (c: TrackingCandidate) => {
    try {
      // 保留这一行、标 dismissed：否则明天追踪会把同一篇又命中一遍、重新冒出来
      const next = inbox.map((r) =>
        r.doi === c.doi ? { ...r, status: 'dismissed' as const } : r,
      )
      await saveTrackingInbox(next)
      setInbox(next)
      setSelectedCandidateDois((prev) => prev.filter((d) => d !== c.doi))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`忽略失败：${msg}`)
    }
  }

  const toggleCandidateSelect = (doi: string) => {
    setSelectedCandidateDois((prev) =>
      prev.includes(doi) ? prev.filter((d) => d !== doi) : [...prev, doi],
    )
  }

  /** 中栏批量入库：选中的候选一次性入库并移出候选 */
  const handleBatchIngestCandidates = async () => {
    const targets = pendingList.filter((c) => c.doi && selectedCandidateDois.includes(c.doi))
    if (targets.length === 0) return
    try {
      for (const c of targets) {
        const newLit = candidateToLiterature(c)
        const status = await addLiteratureToLibrary(newLit)
        if (status === 'added') {
          setLiteratures((prev) => [...prev, newLit])
        }
      }
      const selected = new Set(targets.map((c) => c.doi))
      const next = inbox.filter((r) => !selected.has(r.doi))
      await saveTrackingInbox(next)
      setInbox(next)
      setSelectedCandidateDois([])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`批量入库失败：${msg}`)
    }
  }

  /** 中栏批量删除：选中的候选统一标 dismissed（保留行做去重，不再出现） */
  const handleBatchDismissCandidates = async () => {
    const selected = new Set(selectedCandidateDois)
    const count = pendingList.filter((c) => selected.has(c.doi)).length
    if (count === 0) return
    if (count >= 5 && !window.confirm(`确定删除选中的 ${count} 篇候选？它们将不再出现在待入库里。`)) return
    try {
      const next = inbox.map((r) =>
        selected.has(r.doi) && r.status === 'pending'
          ? { ...r, status: 'dismissed' as const }
          : r,
      )
      await saveTrackingInbox(next)
      setInbox(next)
      setSelectedCandidateDois([])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`批量忽略失败：${msg}`)
    }
  }

  // ============================================================
  // 候选集合
  // ============================================================

  /** 待裁决的候选（页面只显示这些；已忽略的留在 inbox 里做去重） */
  const candidates = pendingCandidates(inbox)

  // ============================================================
  // 颜色选项
  // ============================================================

  const colorOptions = [
    'bg-seal-50 text-seal-600',
    'bg-blue-50 text-blue-600',
    'bg-red-50 text-red-600',
    'bg-orange-50 text-orange-600',
    'bg-amber-50 text-amber-600',
    'bg-emerald-50 text-emerald-600',
    'bg-teal-50 text-teal-600',
    'bg-purple-50 text-purple-600',
    'bg-pink-50 text-pink-600',
    'bg-paper-100 text-ink-600',
  ]

  // ============================================================
  // 中栏 / 右栏 派生列表
  // ============================================================

  /** 中栏「待入库」：按发现时间越新越上（foundAt 为 Unix 秒） */
  const pendingList = useMemo(() => {
    const cutoff = Date.now() / 1000 - 30 * 86400
    return candidates.filter((c) => c.foundAt >= cutoff).sort((a, b) => b.foundAt - a.foundAt)
  }, [candidates])

  /** 中栏批量操作选中的有效条目数（只算仍在待入库列表里的） */
  const selectedCandidateCount = pendingList.filter((c) =>
    selectedCandidateDois.includes(c.doi),
  ).length

  /** 中栏「全选」：是否已把待入库全部勾上（用于复选框的全选 / 半选态） */
  const allPendingSelected = pendingList.length > 0 && selectedCandidateCount === pendingList.length
  const somePendingSelected = selectedCandidateCount > 0 && !allPendingSelected

  /** 中栏「全选」：有筛选就是筛选项，这里无筛选即当前待入库全部 */
  const toggleSelectAllCandidates = () => {
    if (allPendingSelected) {
      const all = new Set(pendingList.map((c) => c.doi))
      setSelectedCandidateDois((prev) => prev.filter((d) => !all.has(d)))
    } else {
      setSelectedCandidateDois((prev) =>
        Array.from(new Set([...prev, ...pendingList.map((c) => c.doi).filter(Boolean)])),
      )
    }
  }

  // 超期（满一个月未处理）的候选直接自动删除，不再堆积（用户 2026-10-04 拍板）
  useEffect(() => {
    const cutoff = Date.now() / 1000 - 30 * 86400
    const stale = inbox.filter((r) => r.status === 'pending' && r.foundAt < cutoff)
    if (stale.length === 0) return
    const next = inbox.filter((r) => !(r.status === 'pending' && r.foundAt < cutoff))
    ;(async () => {
      try {
        await saveTrackingInbox(next)
        setInbox(next)
      } catch (err) {
        console.error('[Tracking] 自动清理超期候选失败:', err)
      }
    })()
  }, [inbox])

  /** 右栏「已入库未传 PDF」：按入库时间越旧越上（催处理，别让新的盖过旧的） */
  const libraryPendingPdf = useMemo(
    () => literatures.filter((l) => !l.pdfAddedAt).sort((a, b) => a.addedAt - b.addedAt),
    [literatures],
  )

  /** 右栏批量操作选中的有效条目数 */
  const selectedLibraryCount = libraryPendingPdf.filter((l) =>
    selectedLibraryDois.includes(l.doi),
  ).length

  /** 右栏「全选」：是否已把待补 PDF 全部勾上 */
  const allLibrarySelected = libraryPendingPdf.length > 0 && selectedLibraryCount === libraryPendingPdf.length
  const someLibrarySelected = selectedLibraryCount > 0 && !allLibrarySelected

  /** 右栏「全选」：无筛选即当前待补 PDF 列表全部 */
  const toggleSelectAllLibrary = () => {
    if (allLibrarySelected) {
      const all = new Set(libraryPendingPdf.map((l) => l.doi))
      setSelectedLibraryDois((prev) => prev.filter((d) => !all.has(d)))
    } else {
      setSelectedLibraryDois((prev) =>
        Array.from(new Set([...prev, ...libraryPendingPdf.map((l) => l.doi).filter(Boolean)])),
      )
    }
  }

  // ============================================================
  // 右栏操作：上传 PDF / 撤销入库 / 批量跳转 DOI
  // ============================================================

  const handleUploadPdf = (lit: Literature) => {
    setPdfInputDoi(lit.doi)
    pdfInputRef.current?.click()
  }

  const onPdfFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    const doi = pdfInputDoi
    // 先清空 input，保证同一文件再次选择也能触发 change
    e.target.value = ''
    setPdfInputDoi(null)
    if (!file || !doi) return

    const lit = literatures.find((l) => l.doi === doi)
    if (!lit) return
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('请选择 PDF 文件')
      return
    }

    setPdfUploadingDoi(doi)
    try {
      const res = await enqueuePaperMineruConvert(doi, file, lit.title)
      // enqueuePaperMineruConvert 内部已 toast 成功/失败，这里只负责成功后落 pdf_added_at
      if (!res.ok) return
      await markPaperPdfAdded(doi)
      setLiteratures((prev) =>
        prev.map((l) => (l.doi === doi ? { ...l, pdfAddedAt: Date.now() } : l)),
      )
      setSelectedLibraryDois((prev) => prev.filter((d) => d !== doi))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`上传失败：${msg}`)
    } finally {
      setPdfUploadingDoi(null)
    }
  }

  const handleUndoIngest = async (lit: Literature) => {
    try {
      await removeLiterature(lit.doi)
      setLiteratures((prev) => prev.filter((l) => l.doi !== lit.doi))
      setSelectedLibraryDois((prev) => prev.filter((d) => d !== lit.doi))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`撤销入库失败：${msg}`)
    }
  }

  const toggleLibrarySelect = (doi: string) => {
    setSelectedLibraryDois((prev) =>
      prev.includes(doi) ? prev.filter((d) => d !== doi) : [...prev, doi],
    )
  }

  const handleBatchOpenDoi = () => {
    const targets = libraryPendingPdf.filter((l) => l.doi && selectedLibraryDois.includes(l.doi))
    if (targets.length === 0) return
    targets.forEach((l) =>
      window.open(`https://doi.org/${l.doi}`, '_blank', 'noopener,noreferrer'),
    )
  }

  /** 右栏批量撤销入库：选中的一次性移出文献库 */
  const handleBatchUndoIngest = async () => {
    const targets = libraryPendingPdf.filter((l) => l.doi && selectedLibraryDois.includes(l.doi))
    const count = targets.length
    if (count === 0) return
    if (count >= 5 && !window.confirm(`确定将选中的 ${count} 篇移出文献库？此操作不可撤销。`)) return
    try {
      for (const l of targets) await removeLiterature(l.doi)
      const selected = new Set(targets.map((l) => l.doi))
      setLiteratures((prev) => prev.filter((l) => !selected.has(l.doi)))
      setSelectedLibraryDois([])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`批量撤销入库失败：${msg}`)
    }
  }

  // ============================================================
  // 中栏操作：标题英译中（默认显示中文标题，译文缓存；可切回英文原标题）
  // ============================================================

  const readTranslateCfg = () => {
    const s = useSettingsStore.getState()
    return {
      baseUrl: (s.asrBaseUrl || '').trim() || 'https://api.siliconflow.cn/v1',
      model: (s.asrTranslateModel || '').trim(),
      apiKey: (s.asrApiKey || '').trim(),
    }
  }

  /** 标题只有不含中文（即英文等外文）时才需要翻译 */
  const isEnglishTitle = (title: string) => !!title.trim() && !/[\u4e00-\u9fff]/.test(title)

  const setTranslatedTitle = (doi: string, zh: string) => {
    translatedTitlesRef.current = { ...translatedTitlesRef.current, [doi]: zh }
    setTranslatedTitles((prev) => ({ ...prev, [doi]: zh }))
  }

  const markTranslating = (doi: string, on: boolean) => {
    if (on) translatingRef.current.add(doi)
    else translatingRef.current.delete(doi)
    setTranslatingTitleDois((prev) =>
      on ? (prev.includes(doi) ? prev : [...prev, doi]) : prev.filter((d) => d !== doi),
    )
  }

  /** 手动（重试）翻译单条标题 */
  const retranslateTitle = async (c: TrackingCandidate) => {
    const text = (c.title || '').trim()
    if (!text) {
      toast.error('这篇没有可翻译的标题')
      return
    }
    if (translatingRef.current.has(c.doi)) return
    markTranslating(c.doi, true)
    try {
      const zh = await translateText(text, readTranslateCfg())
      setTranslatedTitle(c.doi, zh)
      setShowOriginalTitleDois((prev) => prev.filter((d) => d !== c.doi))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`翻译失败：${msg}`, { duration: 8000 })
    } finally {
      markTranslating(c.doi, false)
    }
  }

  const toggleTitleOriginal = (doi: string) => {
    setShowOriginalTitleDois((prev) =>
      prev.includes(doi) ? prev.filter((d) => d !== doi) : [...prev, doi],
    )
  }

  // 中栏标题默认显示中文译文：进视口即自动排队翻译（顺序执行，避免并发打爆）
  useEffect(() => {
    let cancelled = false
    const { apiKey } = readTranslateCfg()
    // 未配置翻译 key 就不自动翻，保留英文原标题
    if (!apiKey) return
    const queue = pendingList.filter(
      (c) =>
        isEnglishTitle(c.title) &&
        !translatedTitlesRef.current[c.doi] &&
        !translatingRef.current.has(c.doi),
    )
    if (queue.length === 0) return
    ;(async () => {
      for (const c of queue) {
        if (cancelled) return
        markTranslating(c.doi, true)
        try {
          const zh = await translateText((c.title || '').trim(), readTranslateCfg())
          if (cancelled) return
          setTranslatedTitle(c.doi, zh)
        } catch (err) {
          if (cancelled) return
          if (!translationErrorShownRef.current) {
            translationErrorShownRef.current = true
            const msg = err instanceof Error ? err.message : String(err)
            toast.error(`标题自动翻译失败，已显示英文原题：${msg}`, { duration: 8000 })
          }
        } finally {
          markTranslating(c.doi, false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingList])

  return (
    <div className="page-container flex h-full flex-col py-ui-page">
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[repeat(3,minmax(0,1fr))] gap-ui-gap-lg lg:grid-cols-ratio-122 lg:grid-rows-[minmax(0,1fr)]">
        {/* ============================================================ */}
        {/* 左①（1）：工具入口列 —— 三张互相独立的卡片：
            ① 文献追踪（关键词组 / 期刊追踪 + 立即追踪 + 结果摘要）
            ② DOI 入库
            ③ 学术搜索
            三张同级功能块：头部 / 内边距 / 字号统一口径，各自是独立卡片。 */}
        {/* ============================================================ */}
        <section className="flex min-h-0 flex-col gap-ui-gap-lg">
          {/* ---------- ① 文献追踪 ---------- */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-ink-200 bg-paper-50">
            <div className="af-line-b shrink-0 px-ui-gap py-3">
              <h2 className="flex items-center gap-2 text-ui-sm font-semibold text-ink-800">
                <Radar className="h-4 w-4 text-seal-600" />
                文献追踪
              </h2>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
              {/* 关键词组 / 期刊追踪：两个入口并排，点开弹窗查看与管理 */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setShowKeywordGroupsModal(true)}
                  className="flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control border border-ink-200 px-2 py-2 text-ui-xs text-ink-700 transition hover:bg-paper-100"
                >
                  <Tag className="h-4 w-4 shrink-0 text-ink-500" />
                  关键词组
                  <span className="text-ink-400">({keywordGroups.length})</span>
                </button>
                <button
                  onClick={() => setShowJournalsModal(true)}
                  className="flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control border border-ink-200 px-2 py-2 text-ui-xs text-ink-700 transition hover:bg-paper-100"
                >
                  <Newspaper className="h-4 w-4 shrink-0 text-ink-500" />
                  期刊追踪
                  <span className="text-ink-400">({journals.length})</span>
                </button>
              </div>
              {/* 定时追踪：计划列表入口（时间规则 + 多期刊 + 表达式） */}
              <button
                onClick={() => setShowPlansModal(true)}
                className="flex w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-control border border-ink-200 px-2 py-2 text-ui-xs text-ink-700 transition hover:bg-paper-100"
              >
                <Clock className="h-4 w-4 shrink-0 text-ink-500" />
                定时追踪
                <span className="text-ink-400">({plans.length})</span>
              </button>
              {/* 立即追踪单独一行 */}
              <button
                onClick={handleTrackNow}
                disabled={isTracking}
                className="flex w-full items-center justify-center gap-2 rounded-control bg-seal-600 px-ui-gap py-2 text-ui-xs font-medium text-paper-50 transition hover:bg-seal-700 disabled:opacity-50"
              >
                {isTracking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                立即追踪
              </button>
              {/* 结果摘要：只报「本次追了几个刊 / 关键词组、命中几篇」，不做逐刊明细 */}
              <p className="text-ui-2xs leading-relaxed text-ink-500">
                {isTracking
                  ? '追踪中，后端跑完即出候选…'
                  : trackRun
                    ? `上次追踪：${trackRun.journals} 个期刊 · ${trackRun.groups} 个关键词组，命中 ${trackRun.found} 篇新文献`
                    : '尚未发起追踪'}
              </p>
            </div>
          </div>

          {/* ---------- ② DOI 入库 ---------- */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-ink-200 bg-paper-50">
            <div className="af-line-b shrink-0 px-ui-gap py-3">
              <h2 className="flex items-center gap-2 text-ui-sm font-semibold text-ink-800">
                <Plus className="h-4 w-4 text-seal-600" />
                DOI 入库
              </h2>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={doiInput}
                  onChange={(e) => setDoiInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddByDoi()}
                  placeholder="输入 DOI 或 DOI 链接..."
                  className="min-w-0 flex-1 rounded-control border border-ink-300 px-ui-gap py-2 text-ui-xs focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
                />
                <button
                  onClick={handleAddByDoi}
                  disabled={isAdding || !doiInput.trim()}
                  title="入库"
                  className="flex shrink-0 items-center justify-center rounded-control bg-seal-600 px-2.5 py-2 text-paper-50 transition hover:bg-seal-700 disabled:opacity-50"
                >
                  {isAdding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          </div>

          {/* ---------- ③ 学术搜索 ---------- */}
          {/* 不带 overflow-hidden：底部下拉要向上弹、需溢出卡片顶部才不被裁掉 */}
          <div className="flex min-h-0 flex-1 flex-col rounded-card border border-ink-200 bg-paper-50">
            <div className="af-line-b shrink-0 px-ui-gap py-3">
              <h2 className="flex items-center gap-2 text-ui-sm font-semibold text-ink-800">
                <Globe className="h-4 w-4 text-seal-600" />
                学术搜索
              </h2>
            </div>
            <div className="min-h-0 flex-1 p-4">
              <div className="space-y-2" ref={searchDropdownRef}>
                <div className="relative">
                  <button
                    onClick={() => setShowSearchDropdown(!showSearchDropdown)}
                    className="flex w-full items-center gap-2 rounded-control border border-ink-300 px-ui-gap py-2 text-ui-xs transition hover:border-seal-400"
                  >
                    <div className={`flex h-6 w-6 items-center justify-center rounded-control-sm ${selectedSearchSite?.color || 'bg-paper-100 text-ink-600'}`}>
                      <Search className="h-3 w-3" />
                    </div>
                    <span className="flex-1 truncate text-left text-ink-700">{selectedSearchSite?.name}</span>
                    <ChevronDown className="h-3.5 w-3.5 text-ink-400" />
                  </button>
                  {showSearchDropdown && (
                    <div className="absolute bottom-full left-0 z-50 mb-1 w-full overflow-hidden rounded-control border border-ink-200 bg-paper-50 shadow-lg">
                      <div className="max-h-72 overflow-y-auto py-1">
                        {searchSites.map((site) => (
                          <button
                            key={site.id}
                            onClick={() => {
                              setSelectedSearchSiteId(site.id)
                              setShowSearchDropdown(false)
                            }}
                            className={`flex w-full items-center gap-3 px-ui-gap py-2 text-ui-xs transition hover:bg-paper-100 ${selectedSearchSiteId === site.id ? 'bg-seal-50 text-seal-700' : 'text-ink-700'}`}
                          >
                            <div className={`flex h-6 w-6 items-center justify-center rounded-control-sm ${site.color}`}>
                              <Search className="h-3 w-3" />
                            </div>
                            <span className="flex-1 truncate text-left">{site.name}</span>
                            {selectedSearchSiteId === site.id && <CheckCircle2 className="h-3.5 w-3.5 text-seal-600" />}
                          </button>
                        ))}
                      </div>
                      <div className="af-line-t p-2">
                        <button
                          onClick={() => {
                            setShowSearchDropdown(false)
                            openAddSearchSite()
                          }}
                          className="flex w-full items-center gap-2 rounded-control-sm px-ui-gap py-2 text-ui-xs text-seal-600 transition hover:bg-seal-50"
                        >
                          <Settings className="h-3.5 w-3.5" />
                          管理搜索源
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    placeholder="输入搜索关键词..."
                    className="min-w-0 flex-1 rounded-control border border-ink-300 px-ui-gap py-2 text-ui-xs focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
                  />
                  <button
                    onClick={handleSearch}
                    title="搜索"
                    className="flex shrink-0 items-center justify-center rounded-control bg-seal-600 px-2.5 py-2 text-paper-50 transition hover:bg-seal-700"
                  >
                    <Search className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ============================================================ */}
        {/* 中②（2）：待入库 —— 筛出来的候选；入库 / 删除后消失；越新越上 */}
        {/* ============================================================ */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded-card border border-ink-200 bg-paper-50">
          <div className="af-line-b flex shrink-0 items-center justify-between gap-2 px-ui-gap py-3">
            <div className="flex min-w-0 items-center gap-2.5">
              {pendingList.length > 0 && (
                <label className="flex flex-shrink-0 cursor-pointer items-center gap-1.5 text-ui-2xs text-ink-500" title="全选待入库">
                  <input
                    type="checkbox"
                    checked={allPendingSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = somePendingSelected
                    }}
                    onChange={toggleSelectAllCandidates}
                    className="h-3.5 w-3.5 accent-seal-600"
                  />
                  全选
                </label>
              )}
              <h2 className="flex min-w-0 items-center gap-2 text-ui-sm font-semibold text-ink-800">
                <Rss className="h-4 w-4 flex-shrink-0 text-seal-600" />
                待入库
                {pendingList.length > 0 && (
                  <span className="rounded-control-sm bg-seal-50 px-1.5 py-0.5 text-ui-xs text-seal-600">{pendingList.length}</span>
                )}
              </h2>
            </div>
            {selectedCandidateCount > 0 ? (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={handleBatchDismissCandidates}
                  className="flex items-center gap-1 rounded-control border border-ink-200 px-2 py-1 text-ui-2xs font-medium text-ink-500 transition hover:bg-ink-100"
                >
                  <X className="h-3 w-3" />
                  删除（{selectedCandidateCount}）
                </button>
                <button
                  onClick={handleBatchIngestCandidates}
                  className="flex items-center gap-1 rounded-control bg-seal-600 px-2 py-1 text-ui-2xs font-medium text-paper-50 transition hover:bg-seal-700"
                >
                  <Plus className="h-3 w-3" />
                  入库（{selectedCandidateCount}）
                </button>
              </div>
            ) : (
              <span className="text-ui-2xs text-ink-400">超过一个月未处理会自动清理</span>
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {pendingList.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center py-12 text-ink-400">
                <Rss className="mb-3 h-10 w-10 opacity-30" />
                <p className="text-ui-xs font-medium">暂无待入库的文献</p>
                <p className="mt-1 px-6 text-center text-ui-2xs">点「立即追踪」，或等每天自动追踪把命中的文献放进候选</p>
              </div>
            ) : (
              pendingList.map((paper) => {
                const titleZh = translatedTitles[paper.doi]
                const showEn = showOriginalTitleDois.includes(paper.doi) || !titleZh
                const isTranslating = translatingTitleDois.includes(paper.doi)
                const canTranslate = isEnglishTitle(paper.title)
                return (
                  <article
                    key={paper.doi}
                    className="rounded-control border border-ink-200 p-3 transition hover:border-seal-200 hover:bg-seal-50/30"
                  >
                    <div className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        checked={selectedCandidateDois.includes(paper.doi)}
                        onChange={() => toggleCandidateSelect(paper.doi)}
                        className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 accent-seal-600"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="min-w-0 flex-1 text-ui-sm font-medium leading-snug text-ink-800">
                            {showEn ? paper.title || '(无标题)' : titleZh}
                          </h3>
                          {canTranslate && (
                            <button
                              onClick={() => {
                                if (isTranslating) return
                                if (titleZh) toggleTitleOriginal(paper.doi)
                                else retranslateTitle(paper)
                              }}
                              disabled={isTranslating}
                              title={isTranslating ? '翻译中' : titleZh ? (showEn ? '看中文标题' : '看英文原题') : '译为中文'}
                              className="mt-0.5 flex flex-shrink-0 items-center gap-1 rounded-control-sm px-1.5 py-0.5 text-ui-2xs text-seal-600 transition hover:bg-seal-50 disabled:opacity-50"
                            >
                              {isTranslating ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Languages className="h-3 w-3" />
                              )}
                              {isTranslating ? '翻译中' : titleZh ? (showEn ? '看译文' : '看原文') : '译为中文'}
                            </button>
                          )}
                        </div>
                        {paper.authors && <p className="mt-1 text-ui-xs text-ink-500">{paper.authors}</p>}
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-2xs text-ink-400">
                          {paper.year > 0 && <span>{paper.year}</span>}
                          {paper.journal && <span className="text-seal-600">{paper.journal}</span>}
                          {paper.source && <span className="rounded-control-sm bg-ink-100 px-1.5 py-0.5 text-ink-500">{paper.source}</span>}
                          {paper.trackingGroup && <span>来自「{paper.trackingGroup}」</span>}
                        </div>

                        {paper.abstractEn && (
                          <div className="mt-2 rounded-control bg-paper-100/60 p-2.5">
                            <span className="text-ui-2xs font-medium text-ink-500">摘要（EN）</span>
                            <p className="mt-1 text-ui-xs leading-relaxed text-ink-600">{paper.abstractEn}</p>
                          </div>
                        )}

                        <div className="mt-2.5 flex items-center justify-end gap-2">
                          {paper.doi && (
                            <DoiLink doi={paper.doi} mode="label" showIcon className="mr-auto inline-flex items-center gap-0.5 text-ui-2xs" />
                          )}
                          <button
                            onClick={() => handleDismissCandidate(paper)}
                            title="删除这篇（不再出现）"
                            className="flex items-center gap-1.5 rounded-control border border-ink-200 px-2.5 py-1.5 text-ui-xs font-medium text-ink-500 transition hover:bg-ink-100"
                          >
                            <X className="h-3.5 w-3.5" />
                            删除
                          </button>
                          <button
                            onClick={() => handleIngestCandidate(paper)}
                            className="flex items-center gap-1.5 rounded-control bg-seal-600 px-2.5 py-1.5 text-ui-xs font-medium text-paper-50 transition hover:bg-seal-700"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            入库
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>
                )
              })
            )}
          </div>
        </section>

        {/* ============================================================ */}
        {/* 右②（2）：已入库但还没传 PDF —— 催你尽快把 PDF 找进来；越旧越上 */}
        {/* ============================================================ */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded-card border border-ink-200 bg-paper-50">
          <div className="af-line-b shrink-0 px-ui-gap py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2.5">
                {libraryPendingPdf.length > 0 && (
                  <label className="flex flex-shrink-0 cursor-pointer items-center gap-1.5 text-ui-2xs text-ink-500" title="全选待补 PDF">
                    <input
                      type="checkbox"
                      checked={allLibrarySelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someLibrarySelected
                      }}
                      onChange={toggleSelectAllLibrary}
                      className="h-3.5 w-3.5 accent-seal-600"
                    />
                    全选
                  </label>
                )}
                <h2 className="flex min-w-0 items-center gap-2 text-ui-sm font-semibold text-ink-800">
                  <FileText className="h-4 w-4 flex-shrink-0 text-seal-600" />
                  待补 PDF
                  {libraryPendingPdf.length > 0 && (
                    <span className="rounded-control-sm bg-orange-50 px-1.5 py-0.5 text-ui-xs text-orange-600">{libraryPendingPdf.length}</span>
                  )}
                </h2>
              </div>
              {selectedLibraryCount > 0 && (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={handleBatchUndoIngest}
                    className="flex items-center gap-1 rounded-control border border-ink-200 px-2 py-1 text-ui-2xs font-medium text-ink-500 transition hover:bg-ink-100"
                  >
                    <Trash2 className="h-3 w-3" />
                    移出（{selectedLibraryCount}）
                  </button>
                  <button
                    onClick={handleBatchOpenDoi}
                    className="flex items-center gap-1 rounded-control bg-seal-600 px-2 py-1 text-ui-2xs font-medium text-paper-50 transition hover:bg-seal-700"
                  >
                    <ExternalLink className="h-3 w-3" />
                    打开 DOI（{selectedLibraryCount}）
                  </button>
                </div>
              )}
            </div>
            <p className="mt-1 text-ui-2xs text-ink-400">决定要读的，就赶紧把 PDF 找进来，别拖着</p>
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
            {libraryPendingPdf.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center py-12 text-ink-400">
                <CheckCircle2 className="mb-3 h-10 w-10 opacity-30" />
                <p className="text-ui-xs font-medium">都补上 PDF 了，没有拖欠</p>
              </div>
            ) : (
              libraryPendingPdf.map((lit) => (
                <div
                  key={lit.doi}
                  className="flex items-center gap-2 rounded-control border border-ink-200 p-2.5 transition hover:border-seal-200"
                >
                  <input
                    type="checkbox"
                    checked={selectedLibraryDois.includes(lit.doi)}
                    onChange={() => toggleLibrarySelect(lit.doi)}
                    className="h-3.5 w-3.5 flex-shrink-0 accent-seal-600"
                  />
                  <span className="min-w-0 flex-1 truncate text-ui-xs text-ink-800" title={lit.title}>
                    {lit.title || '(无标题)'}
                  </span>
                  {lit.doi && (
                    <DoiLink doi={lit.doi} mode="label" showIcon className="flex-shrink-0 text-ui-2xs" />
                  )}
                  <button
                    onClick={() => handleUploadPdf(lit)}
                    disabled={pdfUploadingDoi === lit.doi}
                    title="上传 PDF"
                    className="flex-shrink-0 rounded-control-sm p-1.5 text-ink-500 transition hover:bg-seal-50 hover:text-seal-600 disabled:opacity-50"
                  >
                    {pdfUploadingDoi === lit.doi ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    onClick={() => handleUndoIngest(lit)}
                    title="撤销入库（从文献库移除）"
                    className="flex-shrink-0 rounded-control-sm p-1.5 text-ink-400 transition hover:bg-red-50 hover:text-red-600"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
          <input
            ref={pdfInputRef}
            type="file"
            accept=".pdf,application/pdf"
            className="hidden"
            onChange={onPdfFileChange}
          />
        </section>
      </div>

      {/* ============================================================ */}
      {/* 关键词组管理弹窗：列出已有 + 新建 / 编辑 / 删除 / 启停 */}
      {/* ============================================================ */}
      {showKeywordGroupsModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4"
          onClick={() => setShowKeywordGroupsModal(false)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-card bg-paper-50 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="af-line-b flex shrink-0 items-center justify-between gap-3 p-5">
              <h3 className="flex items-center gap-2 font-semibold text-ink-800">
                <Tag className="h-4 w-4 text-seal-600" />
                关键词组
                <span className="font-normal text-ink-400">({keywordGroups.length})</span>
              </h3>
              <div className="flex items-center gap-3">
                {keywordGroups.length > 0 && (
                  <label
                    className="flex cursor-pointer items-center gap-1.5 text-ui-2xs text-ink-500"
                    title="全选关键词组"
                  >
                    <input
                      type="checkbox"
                      checked={selectedKeywordGroupIds.length === keywordGroups.length}
                      ref={(el) => {
                        if (el)
                          el.indeterminate =
                            selectedKeywordGroupIds.length > 0 &&
                            selectedKeywordGroupIds.length < keywordGroups.length
                      }}
                      onChange={toggleSelectAllKeywordGroups}
                      className="h-3.5 w-3.5 accent-seal-600"
                    />
                    全选
                  </label>
                )}
                <button
                  onClick={() => setShowKeywordGroupsModal(false)}
                  className="p-1 text-ink-400 transition hover:text-ink-600"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-5">
              {keywordGroups.length === 0 ? (
                <div className="rounded-control border border-dashed border-ink-200 py-8 text-center text-ui-sm text-ink-400">
                  尚未配置关键词组
                </div>
              ) : (
                keywordGroups.map((group) => (
                  <div
                    key={group.id}
                    className={`rounded-control border border-ink-200 p-3 transition ${group.enabled ? 'bg-paper-50' : 'bg-paper-100 opacity-60'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedKeywordGroupIds.includes(group.id)}
                          onChange={() => toggleKeywordGroupSelect(group.id)}
                          className="h-3.5 w-3.5 flex-shrink-0 accent-seal-600"
                        />
                        <button
                          onClick={() => toggleKeywordGroup(group.id)}
                          className={`relative h-4 w-7 flex-shrink-0 rounded-full transition ${group.enabled ? 'bg-seal-600' : 'bg-ink-300'}`}
                        >
                          <div
                            className={`absolute top-0.5 h-3 w-3 rounded-full bg-paper-50 shadow transition-transform ${group.enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`}
                          />
                        </button>
                        <span className="truncate text-ui-sm font-medium text-ink-800">{group.name}</span>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-0.5">
                        <button
                          onClick={() => openEditKeywordGroup(group)}
                          className="rounded-control-sm p-1 text-ink-400 transition hover:bg-seal-50 hover:text-seal-600"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => handleDeleteKeywordGroup(group.id)}
                          className="rounded-control-sm p-1 text-ink-400 transition hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    {group.expression.trim() && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-9">
                        {parseExpression(group.expression).map((t, idx) =>
                          t.kind === 'term' ? (
                            <span key={idx} className="rounded-full bg-seal-50 px-1.5 py-0.5 text-ui-2xs text-seal-600">
                              {t.value}
                            </span>
                          ) : (
                            <span key={idx} className="text-ui-2xs font-medium text-ink-400">
                              {t.value}
                            </span>
                          ),
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="af-line-t flex shrink-0 items-center justify-between gap-2 p-5">
              <div>
                {selectedKeywordGroupIds.length > 0 && (
                  <button
                    onClick={handleBatchDeleteKeywordGroups}
                    className="flex items-center gap-1.5 rounded-control border border-red-200 px-ui-gap py-2 text-ui-sm font-medium text-red-600 transition hover:bg-red-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    删除（{selectedKeywordGroupIds.length}）
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowKeywordGroupsModal(false)}
                  className="rounded-control px-ui-gap py-2 text-ui-sm text-ink-600 transition hover:bg-ink-100"
                >
                  关闭
                </button>
                <button
                  onClick={() => {
                    setShowKeywordGroupsModal(false)
                    openAddKeywordGroup()
                  }}
                  className="rounded-control bg-seal-600 px-ui-gap py-2 text-ui-sm font-medium text-paper-50 transition hover:bg-seal-700"
                >
                  新建关键词组
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* 定时计划管理弹窗：列出已有 + 新建 / 编辑 / 删除 / 启停 */}
      {/* ============================================================ */}
      {showPlansModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4"
          onClick={() => setShowPlansModal(false)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-card bg-paper-50 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="af-line-b flex shrink-0 items-center justify-between gap-3 p-5">
              <h3 className="flex items-center gap-2 font-semibold text-ink-800">
                <Clock className="h-4 w-4 text-seal-600" />
                定时追踪计划
                <span className="font-normal text-ink-400">({plans.length})</span>
              </h3>
              <button
                onClick={() => setShowPlansModal(false)}
                className="p-1 text-ink-400 transition hover:text-ink-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-5">
              {plans.length === 0 ? (
                <div className="rounded-control border border-dashed border-ink-200 py-8 text-center text-ui-sm text-ink-400">
                  尚未创建定时计划
                </div>
              ) : (
                plans.map((plan) => {
                  const next = nextRunAt(plan)
                  const journalNames = plan.journalIds
                    .map((jid) => journals.find((j) => j.id === jid)?.name)
                    .filter(Boolean)
                  return (
                    <div
                      key={plan.planId}
                      className={`rounded-control border border-ink-200 p-3 transition ${plan.enabled ? 'bg-paper-50' : 'bg-paper-100 opacity-60'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <button
                            onClick={() => togglePlan(plan.planId)}
                            className={`relative h-4 w-7 flex-shrink-0 rounded-full transition ${plan.enabled ? 'bg-seal-600' : 'bg-ink-300'}`}
                          >
                            <div
                              className={`absolute top-0.5 h-3 w-3 rounded-full bg-paper-50 shadow transition-transform ${plan.enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`}
                            />
                          </button>
                          <span className="truncate text-ui-sm font-medium text-ink-800">{plan.planName}</span>
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-0.5">
                          <button
                            onClick={() => handleTestPlan(plan)}
                            disabled={testingPlanId !== null}
                            title="立即试跑一次（一次性，不影响定时）"
                            className="rounded-control-sm p-1 text-ink-400 transition hover:bg-seal-50 hover:text-seal-600 disabled:opacity-40"
                          >
                            {testingPlanId === plan.planId ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Play className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            onClick={() => openEditPlan(plan)}
                            className="rounded-control-sm p-1 text-ink-400 transition hover:bg-seal-50 hover:text-seal-600"
                          >
                            <Edit3 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeletePlan(plan.planId)}
                            className="rounded-control-sm p-1 text-ink-400 transition hover:bg-red-50 hover:text-red-600"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="mt-1.5 space-y-0.5 pl-9 text-ui-2xs text-ink-500">
                        <p className="flex items-center gap-1">
                          <Clock className="h-3 w-3 text-ink-400" />
                          {describeSchedule(plan)}
                          {plan.enabled && next && (
                            <span className="text-ink-400">
                              · 下次{' '}
                              {next.toLocaleString('zh-CN', {
                                hour12: false,
                                month: '2-digit',
                                day: '2-digit',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                          )}
                        </p>
                        <p className="truncate">
                          {journalNames.length > 0 ? journalNames.join(' / ') : '未选期刊'}
                          {plan.expression.trim() && ` · ${plan.expression}`}
                        </p>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
            <div className="af-line-t flex shrink-0 items-center justify-end gap-2 p-5">
              <button
                onClick={() => setShowPlansModal(false)}
                className="rounded-control px-ui-gap py-2 text-ui-sm text-ink-600 transition hover:bg-ink-100"
              >
                关闭
              </button>
              <button
                onClick={() => {
                  setShowPlansModal(false)
                  openAddPlan()
                }}
                className="rounded-control bg-seal-600 px-ui-gap py-2 text-ui-sm font-medium text-paper-50 transition hover:bg-seal-700"
              >
                新建计划
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* 定时计划「新建 / 编辑」弹窗：时间规则 + 多期刊（OR）+ 单个表达式 */}
      {/* 注意：一个计划只有一个关键词表达式，不问「多个词组之间的关系」。 */}
      {/* 想同时追踪不同主题 → 建多个计划。 */}
      {/* ============================================================ */}
      {showPlanModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4"
          onClick={() => setShowPlanModal(false)}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-card bg-paper-50 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="af-line-b flex shrink-0 items-center justify-between gap-3 p-5">
              <h3 className="flex items-center gap-2 font-semibold text-ink-800">
                <Clock className="h-4 w-4 text-seal-600" />
                {editingPlan ? '编辑定时计划' : '新建定时计划'}
              </h3>
              <button
                onClick={() => setShowPlanModal(false)}
                className="p-1 text-ink-400 transition hover:text-ink-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
              {/* 计划名称 */}
              <div>
                <label className="mb-1.5 block text-ui-sm font-medium text-ink-700">计划名称</label>
                <input
                  type="text"
                  value={planFormName}
                  onChange={(e) => setPlanFormName(e.target.value)}
                  placeholder="如：AI 教育 每日追踪"
                  className="w-full rounded-control border border-ink-300 px-ui-gap py-2 text-ui-sm focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
                />
              </div>

              {/* 时间规则 */}
              <div className="rounded-control border border-ink-200 bg-paper-100 p-3">
                <p className="mb-2 flex items-center gap-1.5 text-ui-sm font-medium text-ink-700">
                  <Clock className="h-3.5 w-3.5 text-ink-400" />
                  追踪时间（北京时间）
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={planFormInterval}
                    onChange={(e) => setPlanFormInterval(e.target.value as PlanInterval)}
                    className="rounded-control border border-ink-300 bg-paper-50 px-ui-gap py-1.5 text-ui-sm focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
                  >
                    {PLAN_INTERVALS.map((it) => (
                      <option key={it.value} value={it.value}>
                        {it.label}
                      </option>
                    ))}
                  </select>
                  {planFormInterval === 'weekly' && (
                    <select
                      value={planFormWeekday}
                      onChange={(e) => setPlanFormWeekday(Number(e.target.value))}
                      className="rounded-control border border-ink-300 bg-paper-50 px-ui-gap py-1.5 text-ui-sm focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
                    >
                      {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                        <option key={n} value={n}>
                          {weekdayLabel(n)}
                        </option>
                      ))}
                    </select>
                  )}
                  {planFormInterval === 'monthly' && (
                    <select
                      value={planFormDayOfMonth}
                      onChange={(e) => setPlanFormDayOfMonth(Number(e.target.value))}
                      className="rounded-control border border-ink-300 bg-paper-50 px-ui-gap py-1.5 text-ui-sm focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
                    >
                      {Array.from({ length: 28 }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n} 日
                        </option>
                      ))}
                    </select>
                  )}
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={planFormHour}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        if (!Number.isNaN(v)) setPlanFormHour(Math.min(23, Math.max(0, Math.trunc(v))))
                      }}
                      className="w-14 rounded-control border border-ink-300 bg-paper-50 px-2 py-1.5 text-center text-ui-sm focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
                    />
                    <span className="text-ink-400">:</span>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={planFormMinute}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        if (!Number.isNaN(v)) setPlanFormMinute(Math.min(59, Math.max(0, Math.trunc(v))))
                      }}
                      className="w-14 rounded-control border border-ink-300 bg-paper-50 px-2 py-1.5 text-center text-ui-sm focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
                    />
                  </div>
                </div>
                <p className="mt-1.5 text-ui-xs text-ink-400">规则：{describeSchedule(planFormPreview)}</p>
              </div>

              {/* 期刊（组内 OR） */}
              <div>
                <label className="mb-1.5 block text-ui-sm font-medium text-ink-700">
                  追踪期刊
                  <span className="ml-1.5 font-normal text-ink-400">（可多选，命中任一即可）</span>
                </label>
                {journals.length === 0 ? (
                  <p className="rounded-control border border-dashed border-ink-200 px-3 py-3 text-ui-xs text-ink-400">
                    还没有期刊，请先在「期刊追踪」里添加
                  </p>
                ) : (
                  <div className="max-h-40 space-y-1 overflow-y-auto rounded-control border border-ink-200 bg-paper-100 p-2">
                    {journals.map((j) => (
                      <label
                        key={j.id}
                        className="flex cursor-pointer items-center gap-2 rounded-control-sm px-2 py-1.5 text-ui-sm text-ink-700 transition hover:bg-paper-50"
                      >
                        <input
                          type="checkbox"
                          checked={planFormJournalIds.includes(j.id)}
                          onChange={() => togglePlanJournal(j.id)}
                          className="h-3.5 w-3.5 accent-seal-600"
                        />
                        <span className="truncate">{j.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* 关键词表达式（单个） */}
              <div>
                <div className="mb-1.5 flex items-end justify-between gap-2">
                  <label className="block text-ui-sm font-medium text-ink-700">关键词表达式</label>
                  {keywordGroups.length > 0 && (
                    <select
                      value=""
                      onChange={(e) => {
                        if (e.target.value) importKeywordGroupToPlan(e.target.value)
                      }}
                      className="rounded-control border border-ink-300 bg-paper-50 px-2 py-1 text-ui-xs text-ink-600 focus:border-seal-400 focus:outline-none"
                    >
                      <option value="">从关键词组导入…</option>
                      {keywordGroups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="mb-2 flex min-h-10 flex-wrap items-center gap-1.5 rounded-control border border-ink-200 bg-paper-100 p-2">
                  {planFormTokens.length === 0 && (
                    <span className="px-1 text-ui-xs text-ink-400">
                      留空表示不按关键词过滤（只看期刊）；也可添加关键词并用运算符组合
                    </span>
                  )}
                  {planFormTokens.map((t, idx) =>
                    t.kind === 'term' ? (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 rounded-full bg-seal-100 px-2 py-0.5 text-ui-xs text-seal-700"
                      >
                        {t.value}
                        <button onClick={() => removePlanTag(idx)} className="hover:text-seal-900">
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ) : (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 rounded-full bg-ink-200 px-2 py-0.5 text-ui-xs font-medium text-ink-600"
                      >
                        {t.value}
                        <button onClick={() => removePlanTag(idx)} className="hover:text-ink-800">
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ),
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={planFormInput}
                    onChange={(e) => setPlanFormInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addPlanTag()
                      }
                    }}
                    placeholder="输入关键词后按回车添加"
                    className="min-w-0 flex-1 rounded-control border border-ink-300 px-ui-gap py-2 text-ui-sm focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
                  />
                  <button
                    onClick={addPlanTag}
                    className="rounded-control bg-seal-50 px-ui-gap py-2 text-ui-sm font-medium text-seal-700 transition hover:bg-seal-100"
                  >
                    添加
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {(['AND', 'OR', 'NOT', '(', ')'] as const).map((op) => (
                    <button
                      key={op}
                      onClick={() => appendPlanOperator(op)}
                      className="rounded-control-sm border border-ink-300 px-2 py-1 text-ui-xs font-medium text-ink-600 transition hover:bg-ink-100"
                    >
                      {op}
                    </button>
                  ))}
                </div>
                {planFormTokens.length > 0 && (
                  <p className="mt-1.5 text-ui-xs">
                    <span className="text-ink-400">预览：</span>
                    <span className="text-ink-700">{serializeExpression(planFormTokens)}</span>
                    {validateExpression(planFormTokens) && (
                      <span className="ml-2 text-red-500">{validateExpression(planFormTokens)}</span>
                    )}
                  </p>
                )}
                <p className="mt-1.5 text-ui-xs text-ink-400">
                  一个计划只写一个表达式；相邻关键词默认「且（AND）」；要追踪不同主题，请新建多个计划。
                </p>
              </div>
            </div>

            <div className="af-line-t flex shrink-0 items-center justify-end gap-2 p-5">
              <button
                onClick={() => setShowPlanModal(false)}
                className="rounded-control px-ui-gap py-2 text-ui-sm text-ink-600 transition hover:bg-ink-100"
              >
                取消
              </button>
              <button
                onClick={handleSavePlan}
                className="rounded-control bg-seal-600 px-ui-gap py-2 text-ui-sm font-medium text-paper-50 transition hover:bg-seal-700"
              >
                {editingPlan ? '保存' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* 期刊管理弹窗：列出已有 + 添加 / 编辑 / 删除 / 启停 */}
      {/* ============================================================ */}
      {showJournalsModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4"
          onClick={() => setShowJournalsModal(false)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-card bg-paper-50 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="af-line-b flex shrink-0 items-center justify-between gap-3 p-5">
              <h3 className="flex items-center gap-2 font-semibold text-ink-800">
                <BookMarked className="h-4 w-4 text-seal-600" />
                期刊追踪
                <span className="font-normal text-ink-400">({journals.length})</span>
              </h3>
              <div className="flex items-center gap-3">
                {journals.length > 0 && (
                  <label
                    className="flex cursor-pointer items-center gap-1.5 text-ui-2xs text-ink-500"
                    title="全选期刊"
                  >
                    <input
                      type="checkbox"
                      checked={selectedJournalIds.length === journals.length}
                      ref={(el) => {
                        if (el)
                          el.indeterminate =
                            selectedJournalIds.length > 0 &&
                            selectedJournalIds.length < journals.length
                      }}
                      onChange={toggleSelectAllJournals}
                      className="h-3.5 w-3.5 accent-seal-600"
                    />
                    全选
                  </label>
                )}
                <button
                  onClick={() => setShowJournalsModal(false)}
                  className="p-1 text-ink-400 transition hover:text-ink-600"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-5">
              {journals.length === 0 ? (
                <div className="rounded-control border border-dashed border-ink-200 py-8 text-center text-ui-sm text-ink-400">
                  尚未添加期刊
                </div>
              ) : (
                journals.map((journal) => (
                  <div
                    key={journal.id}
                    className={`flex items-center justify-between gap-2 rounded-control p-3 transition hover:bg-paper-100 ${journal.enabled ? '' : 'opacity-60'}`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedJournalIds.includes(journal.id)}
                        onChange={() => toggleJournalSelect(journal.id)}
                        className="h-3.5 w-3.5 flex-shrink-0 accent-seal-600"
                      />
                      <button
                        onClick={() => toggleJournal(journal.id)}
                        className={`relative h-4 w-7 flex-shrink-0 rounded-full transition ${journal.enabled ? 'bg-seal-600' : 'bg-ink-300'}`}
                      >
                        <div
                          className={`absolute top-0.5 h-3 w-3 rounded-full bg-paper-50 shadow transition-transform ${journal.enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`}
                        />
                      </button>
                      <div className="min-w-0">
                        <div className="truncate text-ui-sm font-medium text-ink-800">{journal.name}</div>
                        {journal.issn && <div className="text-ui-2xs text-ink-400">{journal.issn}</div>}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-0.5">
                      <button
                        onClick={() => openEditJournal(journal)}
                        className="rounded-control-sm p-1 text-ink-400 transition hover:bg-seal-50 hover:text-seal-600"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => handleDeleteJournal(journal.id)}
                        className="rounded-control-sm p-1 text-ink-400 transition hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="af-line-t flex shrink-0 items-center justify-between gap-2 p-5">
              <div>
                {selectedJournalIds.length > 0 && (
                  <button
                    onClick={handleBatchDeleteJournals}
                    className="flex items-center gap-1.5 rounded-control border border-red-200 px-ui-gap py-2 text-ui-sm font-medium text-red-600 transition hover:bg-red-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    删除（{selectedJournalIds.length}）
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowJournalsModal(false)}
                  className="rounded-control px-ui-gap py-2 text-ui-sm text-ink-600 transition hover:bg-ink-100"
                >
                  关闭
                </button>
                <button
                  onClick={() => {
                    setShowJournalsModal(false)
                    openAddJournal()
                  }}
                  className="rounded-control bg-seal-600 px-ui-gap py-2 text-ui-sm font-medium text-paper-50 transition hover:bg-seal-700"
                >
                  添加期刊
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* 关键词组编辑弹窗 */}
      {/* ============================================================ */}
      {showKeywordModal && (
        <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center z-50 p-4">
          <div className="bg-paper-50 rounded-card shadow-xl w-full max-w-lg">
            <div className="af-line-b flex items-center justify-between p-5">
              <h3 className="font-semibold text-ink-800">
                {editingKeywordGroup ? '编辑关键词组' : '新建关键词组'}
              </h3>
              <button
                onClick={() => setShowKeywordModal(false)}
                className="p-1 text-ink-400 hover:text-ink-600 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">
                  关键词组名称
                </label>
                <input
                  type="text"
                  value={keywordFormName}
                  onChange={(e) => setKeywordFormName(e.target.value)}
                  placeholder="如：学术研究方法"
                  className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
              </div>
              <div>
                <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">
                  关键词表达式
                </label>
                {/* 标签区：关键词 / 运算符 / 括号均可点 × 删除 */}
                <div className="mb-2 flex min-h-10 flex-wrap items-center gap-1.5 rounded-control border border-ink-200 bg-paper-100 p-2">
                  {keywordFormTokens.length === 0 && (
                    <span className="px-1 text-ui-xs text-ink-400">先添加关键词，再用「运算符」插入 AND / OR / NOT</span>
                  )}
                  {keywordFormTokens.map((t, idx) =>
                    t.kind === 'term' ? (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 rounded-full bg-seal-100 px-2 py-0.5 text-ui-xs text-seal-700"
                      >
                        {t.value}
                        <button onClick={() => removeKeywordTag(idx)} className="hover:text-seal-900">
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ) : (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 rounded-full bg-ink-200 px-2 py-0.5 text-ui-xs font-medium text-ink-600"
                      >
                        {t.value}
                        <button onClick={() => removeKeywordTag(idx)} className="hover:text-ink-800">
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ),
                  )}
                </div>
                {/* 输入行：关键词输入 + 添加 + 运算符下拉 */}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={keywordInput}
                    onChange={(e) => setKeywordInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addKeywordTag()
                      }
                    }}
                    placeholder="输入关键词后按回车添加"
                    className="flex-1 rounded-control border border-ink-300 px-ui-gap py-2 text-ui-sm focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
                  />
                  <button
                    onClick={addKeywordTag}
                    className="rounded-control bg-seal-50 px-ui-gap py-2 text-ui-sm font-medium text-seal-700 transition hover:bg-seal-100"
                  >
                    添加
                  </button>
                  <div className="relative">
                    <button
                      onClick={() => setShowKeywordOperatorMenu((v) => !v)}
                      className="inline-flex items-center gap-1 rounded-control border border-ink-300 px-ui-gap py-2 text-ui-sm text-ink-600 transition hover:bg-ink-100"
                    >
                      运算符
                      <ChevronDown className="h-4 w-4" />
                    </button>
                    {showKeywordOperatorMenu && (
                      <div className="absolute right-0 z-10 mt-1 w-24 rounded-control border border-ink-200 bg-paper-50 py-1 shadow-lg">
                        {(['AND', 'OR', 'NOT', '(', ')'] as const).map((op) => (
                          <button
                            key={op}
                            onClick={() => {
                              appendKeywordOperator(op)
                              setShowKeywordOperatorMenu(false)
                            }}
                            className="block w-full px-3 py-1.5 text-left text-ui-sm text-ink-700 transition hover:bg-seal-50"
                          >
                            {op}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                {/* 实时预览 + 结构校验：非法立即提示，不让「看着像结果」的式子进库 */}
                {keywordFormTokens.length > 0 && (
                  <p className="mt-1.5 text-ui-xs">
                    <span className="text-ink-400">预览：</span>
                    <span className="text-ink-700">{serializeExpression(keywordFormTokens)}</span>
                    {validateExpression(keywordFormTokens) && (
                      <span className="ml-2 text-red-500">{validateExpression(keywordFormTokens)}</span>
                    )}
                  </p>
                )}
                <p className="mt-1.5 text-ui-xs text-ink-400">
                  相邻关键词默认「且（AND）」；用运算符下拉插入 AND / OR / NOT 与括号组合多个条件
                </p>
              </div>
            </div>
            <div className="af-line-t flex items-center justify-end gap-2 p-5">
              <button
                onClick={() => setShowKeywordModal(false)}
                className="px-ui-gap py-2 text-ui-sm text-ink-600 hover:bg-ink-100 rounded-control transition"
              >
                取消
              </button>
              <button
                onClick={handleSaveKeywordGroup}
                className="px-ui-gap py-2 text-ui-sm text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-control transition font-medium"
              >
                {editingKeywordGroup ? '保存' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* 期刊编辑弹窗 */}
      {/* ============================================================ */}
      {showJournalModal && (
        <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center z-50 p-4">
          <div className="bg-paper-50 rounded-card shadow-xl w-full max-w-lg">
            <div className="af-line-b flex items-center justify-between p-5">
              <h3 className="font-semibold text-ink-800">
                {editingJournal ? '编辑期刊' : '添加期刊'}
              </h3>
              <button
                onClick={() => setShowJournalModal(false)}
                className="p-1 text-ink-400 hover:text-ink-600 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">
                  期刊名称 <span className="text-red-500">*</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={journalFormName}
                    onChange={(e) => setJournalFormName(e.target.value)}
                    placeholder="输入中文名 / 简称 / ISSN，如：JACS、美国化学会志"
                    className="flex-1 min-w-0 px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                  />
                  <button
                    type="button"
                    onClick={handleResolveJournal}
                    disabled={isResolvingJournal}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 text-ui-sm rounded-control border border-seal-200 text-seal-700 bg-seal-50 hover:bg-seal-100 transition disabled:opacity-60"
                  >
                    {isResolvingJournal ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Sparkles className="w-4 h-4" />
                    )}
                    智能匹配
                  </button>
                </div>
                <p className="mt-1.5 text-ui-xs text-ink-400">
                  不确定正式刊名？输入中文名 / 简称 / 大小写随意的英文，点「智能匹配」按 Crossref 权威数据补全正式刊名、ISSN 与出版社。
                </p>
                {journalMatches.length > 0 && (
                  <div className="mt-2 border border-ink-200 rounded-control divide-y divide-ink-100 max-h-52 overflow-auto">
                    {journalMatches.map((m, i) => (
                      <button
                        key={`${m.issn || m.name}-${i}`}
                        type="button"
                        onClick={() => applyJournalMatch(m)}
                        className="w-full text-left px-3 py-2 hover:bg-seal-50 transition"
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="text-ui-sm text-ink-800 font-medium">{m.name}</span>
                          {m.trackable === true && (
                            <span className="shrink-0 px-1.5 py-0.5 rounded-control-sm text-ui-xs text-emerald-700 bg-emerald-50">
                              已验证可追踪
                            </span>
                          )}
                          {m.trackable === false && (
                            <span className="shrink-0 px-1.5 py-0.5 rounded-control-sm text-ui-xs text-amber-700 bg-amber-50">
                              后端恐追踪不到
                            </span>
                          )}
                        </div>
                        <div className="text-ui-xs text-ink-400 mt-0.5">
                          {m.issn ? `ISSN ${m.issn}` : '无 ISSN'}
                          {m.publisher ? ` · ${m.publisher}` : ''}
                          {m.worksCount ? ` · 收录 ${m.worksCount.toLocaleString()} 篇` : ''}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">
                    ISSN
                  </label>
                  <input
                    type="text"
                    value={journalFormIssn}
                    onChange={(e) => setJournalFormIssn(e.target.value)}
                    placeholder="可选"
                    className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                  />
                </div>
                <div>
                  <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">
                    出版社
                  </label>
                  <input
                    type="text"
                    value={journalFormPublisher}
                    onChange={(e) => setJournalFormPublisher(e.target.value)}
                    placeholder="可选"
                    className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                  />
                </div>
              </div>
              <div>
                <label className="block text-ui-sm font-medium text-ink-700 mb-1.5">
                  RSS 地址
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={journalFormRssUrl}
                    onChange={(e) => setJournalFormRssUrl(e.target.value)}
                    placeholder="可选，用于RSS订阅追踪"
                    className="flex-1 min-w-0 px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                  />
                  <button
                    type="button"
                    onClick={handleFindRss}
                    disabled={isFindingRss}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 text-ui-sm rounded-control border border-seal-200 text-seal-700 bg-seal-50 hover:bg-seal-100 transition disabled:opacity-60"
                  >
                    {isFindingRss ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Sparkles className="w-4 h-4" />
                    )}
                    自动查找
                  </button>
                </div>
                <p className="mt-1.5 text-ui-xs text-ink-400">
                  期刊 feed 不允许浏览器直连，这里由 AI 联网检索；填入的地址请在保存前确认。
                </p>
              </div>
            </div>
            <div className="af-line-t flex items-center justify-end gap-2 p-5">
              <button
                onClick={() => setShowJournalModal(false)}
                className="px-ui-gap py-2 text-ui-sm text-ink-600 hover:bg-ink-100 rounded-control transition"
              >
                取消
              </button>
              <button
                onClick={handleSaveJournal}
                className="px-ui-gap py-2 text-ui-sm text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-control transition font-medium"
              >
                {editingJournal ? '保存' : '添加'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* 搜索源管理弹窗 */}
      {/* ============================================================ */}
      {showSearchManager && (
        <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center z-50 p-4">
          <div className="bg-paper-50 rounded-card shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="af-line-b flex items-center justify-between p-5">
              <h3 className="font-semibold text-ink-800">管理搜索源</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={resetSearchSites}
                  className="px-ui-gap py-1.5 text-ui-xs text-ink-500 hover:text-ink-700 hover:bg-ink-100 rounded-control-sm transition"
                >
                  恢复默认
                </button>
                <button
                  onClick={() => setShowSearchManager(false)}
                  className="p-1 text-ink-400 hover:text-ink-600 transition"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* 已有搜索源列表 */}
              <div className="space-y-2">
                <h4 className="text-ui-sm font-medium text-ink-700">已有搜索源</h4>
                {searchSites.map((site) => (
                  <div
                    key={site.id}
                    className="flex items-center gap-3 p-3 border border-ink-200 rounded-control hover:bg-paper-100 transition"
                  >
                    <div className={`w-9 h-9 rounded-control flex items-center justify-center ${site.color}`}>
                      <Search className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-ui-sm text-ink-800">{site.name}</div>
                      <div className="text-ui-xs text-ink-500 truncate">{site.urlTemplate}</div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openEditSearchSite(site)}
                        className="p-1.5 text-ink-400 hover:text-seal-600 hover:bg-seal-50 rounded-control-sm transition"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteSearchSite(site.id)}
                        className="p-1.5 text-ink-400 hover:text-red-600 hover:bg-red-50 rounded-control-sm transition"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* 新增/编辑表单 */}
              <div className="af-line-t pt-4">
                <h4 className="text-ui-sm font-medium text-ink-700 mb-3">
                  {editingSearchSite ? '编辑搜索源' : '添加搜索源'}
                </h4>
                <div className="space-y-3">
                  <div>
                    <label className="block text-ui-xs font-medium text-ink-600 mb-1">
                      网站名称
                    </label>
                    <input
                      type="text"
                      value={searchFormName}
                      onChange={(e) => setSearchFormName(e.target.value)}
                      placeholder="如：百度学术"
                      className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                    />
                  </div>
                  <div>
                    <label className="block text-ui-xs font-medium text-ink-600 mb-1">
                      搜索网址
                    </label>
                    <input
                      type="text"
                      value={searchFormUrlTemplate}
                      onChange={(e) => setSearchFormUrlTemplate(e.target.value)}
                      placeholder={editingSearchSite
                        ? '搜索URL模板（含 {query}）'
                        : '去搜索网站搜一个词，把网址粘贴到这里'}
                      className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                    />
                    {!editingSearchSite && (
                      <p className="text-ui-xs text-ink-400 mt-1">
                        系统会自动识别搜索参数（如 ?q= 或 ?wd=），无需手动处理
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-ui-xs font-medium text-ink-600 mb-1.5">
                      图标颜色
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {colorOptions.map((color) => (
                        <button
                          key={color}
                          onClick={() => setSearchFormColor(color)}
                          className={`w-8 h-8 rounded-control flex items-center justify-center transition ${color} ${
                            searchFormColor === color
                              ? 'ring-2 ring-offset-1 ring-seal-500'
                              : 'hover:ring-1 hover:ring-ink-300'
                          }`}
                        >
                          <Search className="w-4 h-4" />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="af-line-t flex items-center justify-end gap-2 p-5">
              <button
                onClick={() => {
                  setEditingSearchSite(null)
                  setShowSearchManager(false)
                }}
                className="px-ui-gap py-2 text-ui-sm text-ink-600 hover:bg-ink-100 rounded-control transition"
              >
                关闭
              </button>
              <button
                onClick={handleSaveSearchSite}
                className="px-ui-gap py-2 text-ui-sm text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-control transition font-medium"
              >
                {editingSearchSite ? '保存修改' : '添加搜索源'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
