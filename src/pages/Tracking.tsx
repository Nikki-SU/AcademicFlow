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
  ChevronRight,
  Loader2,
  CheckCircle2,
  Tag,
  BookMarked,
  Rss,
  Settings,
  Play,
  Newspaper,
  Hash,
  FileText,
  Upload,
  ExternalLink,
  RotateCcw,
  Languages,
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
import { dispatchDailyTracking, waitForDailyTracking } from '../services/workflowClient'
import { useWorkspaceStore } from '../stores/workspace'
import { useAuthStore } from '../stores/auth'

// ============================================================
// 类型定义
// ============================================================

interface KeywordGroup {
  id: string
  name: string
  keywords: string[]
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

/** 追踪来源（计数按「候选」实算，不再写死 0） */
const TRACKING_SOURCES = ['CrossRef', 'OpenAlex', 'arXiv', 'RSS']

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
  const [keywordGroupsCollapsed, setKeywordGroupsCollapsed] = useState(true)
  const [showKeywordModal, setShowKeywordModal] = useState(false)
  const [editingKeywordGroup, setEditingKeywordGroup] = useState<KeywordGroup | null>(null)
  const [keywordFormName, setKeywordFormName] = useState('')
  const [keywordFormKeywords, setKeywordFormKeywords] = useState<string[]>([])
  const [keywordInput, setKeywordInput] = useState('')

  // ---------- 期刊 ----------
  const [journals, setJournals] = useState<JournalItem[]>([])
  const [journalsCollapsed, setJournalsCollapsed] = useState(true)
  const [showJournalModal, setShowJournalModal] = useState(false)
  const [editingJournal, setEditingJournal] = useState<JournalItem | null>(null)
  const [journalFormName, setJournalFormName] = useState('')
  const [journalFormIssn, setJournalFormIssn] = useState('')
  const [journalFormPublisher, setJournalFormPublisher] = useState('')
  const [journalFormRssUrl, setJournalFormRssUrl] = useState('')

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
  /** 追踪候选（tracking/inbox.csv）：含「待裁决」与「已忽略」两类，页面只显示待裁决 */
  const [inbox, setInbox] = useState<TrackingCandidate[]>([])

  // ---------- 右栏：已入库但还没传 PDF ----------
  /** 文献库（literatures/literatures.csv）全量，右栏只取 pdfAddedAt === 0 的 */
  const [literatures, setLiteratures] = useState<Literature[]>([])
  /** 正在上传 PDF 的文献 DOI（用于该行 loading） */
  const [pdfUploadingDoi, setPdfUploadingDoi] = useState<string | null>(null)
  /** 待上传 PDF 的文献 DOI（隐藏 file input 复用，选中后再打开文件选择器） */
  const [pdfInputDoi, setPdfInputDoi] = useState<string | null>(null)
  const pdfInputRef = useRef<HTMLInputElement>(null)
  /** 摘要译文缓存镜像（供自动翻译队列判断「是否已译」，不触发重渲染） */
  const translatedAbstractsRef = useRef<Record<string, string>>({})
  /** 正在翻译的 DOI（防止重复入队） */
  const translatingRef = useRef<Set<string>>(new Set())
  /** 自动翻译失败只提示一次，避免刷屏 */
  const translationErrorShownRef = useRef(false)
  /** 右栏批量操作选中的 DOI */
  const [selectedLibraryDois, setSelectedLibraryDois] = useState<string[]>([])
  /** 中栏批量操作选中的候选 DOI */
  const [selectedCandidateDois, setSelectedCandidateDois] = useState<string[]>([])
  /** 中栏摘要译文缓存（DOI → 中文）；默认显示译文，缓存避免重复翻译 */
  const [translatedAbstracts, setTranslatedAbstracts] = useState<Record<string, string>>({})
  /** 中栏想看英文原文的候选 DOI（默认显示中文译文） */
  const [showOriginalDois, setShowOriginalDois] = useState<string[]>([])
  /** 中栏正在翻译（自动 + 手动）的候选 DOI，用于按钮 loading */
  const [translatingDois, setTranslatingDois] = useState<string[]>([])

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
              // expression 是给 OpenAlex 的检索式：空格或逗号分隔都认
              keywords: (r[2] || '').split(/[,\s]+/).filter(Boolean),
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
            return rows.slice(1).map((r) => ({
              id: r[0] || '',
              name: r[1] || '',
              rssUrl: r[2] || undefined,
              enabled: r[3] === '1' || r[3] === 'true',
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
            g.keywords.join(' '),
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
          ['id', 'name', 'rss_url', 'enabled'],
          (j) => [j.id, j.name, j.rssUrl || '', j.enabled ? '1' : '0'],
        )
      } catch (err) {
        console.error('[Tracking] 保存期刊到 GitHub 失败:', err)
      }
    }, 2000)
    return () => {
      if (journalsSaveTimerRef.current) clearTimeout(journalsSaveTimerRef.current)
    }
  }, [journals])

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
    const short = title.slice(0, 40)
    const suffix = title.length > 40 ? '...' : ''
    if (status === 'exists') {
      toast.message(`已在库中：${short}${suffix}`)
    } else {
      toast.success(`已入库：${short}${suffix}`)
    }
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
    setKeywordFormKeywords([])
    setKeywordInput('')
    setShowKeywordModal(true)
  }

  const openEditKeywordGroup = (group: KeywordGroup) => {
    setEditingKeywordGroup(group)
    setKeywordFormName(group.name)
    setKeywordFormKeywords([...group.keywords])
    setKeywordInput('')
    setShowKeywordModal(true)
  }

  const handleSaveKeywordGroup = () => {
    if (!keywordFormName.trim()) {
      toast.error('请输入关键词组名称')
      return
    }
    if (keywordFormKeywords.length === 0) {
      toast.error('请至少添加一个关键词')
      return
    }

    if (editingKeywordGroup) {
      setKeywordGroups((prev) =>
        prev.map((g) =>
          g.id === editingKeywordGroup.id
            ? { ...g, name: keywordFormName.trim(), keywords: keywordFormKeywords }
            : g,
        ),
      )
      toast.success('关键词组已更新')
    } else {
      const newGroup: KeywordGroup = {
        id: generateId(),
        name: keywordFormName.trim(),
        keywords: keywordFormKeywords,
        enabled: true,
        translateAbstract: false,
        createdAt: Date.now(),
      }
      setKeywordGroups((prev) => [...prev, newGroup])
      toast.success('关键词组已创建')
    }
    setShowKeywordModal(false)
  }

  const handleDeleteKeywordGroup = (id: string) => {
    setKeywordGroups((prev) => prev.filter((g) => g.id !== id))
    toast.success('关键词组已删除')
  }

  const toggleKeywordGroup = (id: string) => {
    setKeywordGroups((prev) =>
      prev.map((g) => (g.id === id ? { ...g, enabled: !g.enabled } : g)),
    )
  }

  const addKeywordTag = () => {
    const kw = keywordInput.trim()
    if (!kw) return
    if (keywordFormKeywords.includes(kw)) {
      toast.error('该关键词已存在')
      return
    }
    setKeywordFormKeywords((prev) => [...prev, kw])
    setKeywordInput('')
  }

  const removeKeywordTag = (index: number) => {
    setKeywordFormKeywords((prev) => prev.filter((_, i) => i !== index))
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
    setShowJournalModal(true)
  }

  const openEditJournal = (journal: JournalItem) => {
    setEditingJournal(journal)
    setJournalFormName(journal.name)
    setJournalFormIssn(journal.issn || '')
    setJournalFormPublisher(journal.publisher || '')
    setJournalFormRssUrl(journal.rssUrl || '')
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
      toast.success('期刊已更新')
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
      toast.success('期刊已添加')
    }
    setShowJournalModal(false)
  }

  const handleDeleteJournal = (id: string) => {
    setJournals((prev) => prev.filter((j) => j.id !== id))
    toast.success('期刊已删除')
  }

  const toggleJournal = (id: string) => {
    setJournals((prev) =>
      prev.map((j) => (j.id === id ? { ...j, enabled: !j.enabled } : j)),
    )
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
      toast.success('搜索源已更新')
    } else {
      const newSite: SearchSite = {
        id: generateId(),
        name: searchFormName.trim(),
        urlTemplate: template,
        color: searchFormColor,
      }
      setSearchSites((prev) => [...prev, newSite])
      toast.success('搜索源已添加')
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
    toast.success('搜索源已删除')
  }

  const resetSearchSites = () => {
    setSearchSites(DEFAULT_SEARCH_SITES)
    setSelectedSearchSiteId(DEFAULT_SEARCH_SITES[0].id)
    toast.success('已恢复默认搜索源')
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
      const sinceIso = new Date().toISOString()
      await dispatchDailyTracking(user.login, repo.name, token)
      toast.message('已触发追踪，等待后端返回…')

      const result = await waitForDailyTracking(user.login, repo.name, token, sinceIso)
      if (result === 'failure') {
        toast.error('追踪任务失败，请到 Actions 查看日志')
      } else if (result === 'timeout') {
        toast.message('后端仍在运行，稍后会自动出现在候选里')
      }

      const rows = await loadTrackingInbox(true)
      setInbox(rows)
      const n = pendingCandidates(rows).length
      if (result === 'success') {
        toast.success(n > 0 ? `追踪完成：${n} 篇待裁决` : '追踪完成：没有新的候选文献')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`追踪失败：${msg}`)
    } finally {
      setIsTracking(false)
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
      const short = c.title.slice(0, 40)
      toast.message(`已忽略：${short}${c.title.length > 40 ? '...' : ''}`)
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
      let added = 0
      let exists = 0
      for (const c of targets) {
        const newLit = candidateToLiterature(c)
        const status = await addLiteratureToLibrary(newLit)
        if (status === 'added') {
          added += 1
          setLiteratures((prev) => [...prev, newLit])
        } else {
          exists += 1
        }
      }
      const selected = new Set(targets.map((c) => c.doi))
      const next = inbox.filter((r) => !selected.has(r.doi))
      await saveTrackingInbox(next)
      setInbox(next)
      setSelectedCandidateDois([])
      toast.success(`已入库 ${added} 篇${exists > 0 ? `，${exists} 篇已在库` : ''}`)
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
    try {
      const next = inbox.map((r) =>
        selected.has(r.doi) && r.status === 'pending'
          ? { ...r, status: 'dismissed' as const }
          : r,
      )
      await saveTrackingInbox(next)
      setInbox(next)
      setSelectedCandidateDois([])
      toast.message(`已忽略 ${count} 篇`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`批量忽略失败：${msg}`)
    }
  }

  // ============================================================
  // 统计
  // ============================================================

  const enabledKeywordGroupCount = keywordGroups.filter((g) => g.enabled).length
  const enabledJournalCount = journals.filter((j) => j.enabled).length

  /** 待裁决的候选（页面只显示这些；已忽略的留在 inbox 里做去重） */
  const candidates = pendingCandidates(inbox)
  /** 各来源的命中数（按候选实算） */
  const sourceCount = (label: string) =>
    candidates.filter((c) => (c.source || '').toLowerCase() === label.toLowerCase()).length

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
        toast.message(`已自动清理 ${stale.length} 篇超期（超过一个月未处理）的候选`)
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
      toast.success('已移出待补 PDF 清单')
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
      const short = lit.title.slice(0, 40)
      toast.message(`已移出文献库：${short}${lit.title.length > 40 ? '...' : ''}`)
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
    toast.message(`已打开 ${targets.length} 个 DOI 链接`)
  }

  // ============================================================
  // 中栏操作：摘要翻译（默认显示中文译文，译文缓存；可切回英文原文）
  // ============================================================

  const readTranslateCfg = () => {
    const s = useSettingsStore.getState()
    return {
      baseUrl: (s.asrBaseUrl || '').trim() || 'https://api.siliconflow.cn/v1',
      model: (s.asrTranslateModel || '').trim(),
      apiKey: (s.asrApiKey || '').trim(),
    }
  }

  const setTranslated = (doi: string, zh: string) => {
    translatedAbstractsRef.current = { ...translatedAbstractsRef.current, [doi]: zh }
    setTranslatedAbstracts((prev) => ({ ...prev, [doi]: zh }))
  }

  const markTranslating = (doi: string, on: boolean) => {
    if (on) translatingRef.current.add(doi)
    else translatingRef.current.delete(doi)
    setTranslatingDois((prev) =>
      on ? (prev.includes(doi) ? prev : [...prev, doi]) : prev.filter((d) => d !== doi),
    )
  }

  /** 手动（重试）翻译单条摘要 */
  const retranslateAbstract = async (c: TrackingCandidate) => {
    const text = (c.abstractEn || '').trim()
    if (!text) {
      toast.error('这篇没有可翻译的摘要')
      return
    }
    if (translatingRef.current.has(c.doi)) return
    markTranslating(c.doi, true)
    try {
      const zh = await translateText(text, readTranslateCfg())
      setTranslated(c.doi, zh)
      setShowOriginalDois((prev) => prev.filter((d) => d !== c.doi))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`翻译失败：${msg}`, { duration: 8000 })
    } finally {
      markTranslating(c.doi, false)
    }
  }

  const toggleAbstractOriginal = (doi: string) => {
    setShowOriginalDois((prev) =>
      prev.includes(doi) ? prev.filter((d) => d !== doi) : [...prev, doi],
    )
  }

  // 中栏摘要默认显示中文译文：进视口即自动排队翻译（顺序执行，避免并发打爆）
  useEffect(() => {
    let cancelled = false
    const { apiKey } = readTranslateCfg()
    // 未配置翻译 key 就不自动翻，保留英文原文
    if (!apiKey) return
    const queue = pendingList.filter(
      (c) =>
        (c.abstractEn || '').trim() &&
        !translatedAbstractsRef.current[c.doi] &&
        !translatingRef.current.has(c.doi),
    )
    if (queue.length === 0) return
    ;(async () => {
      for (const c of queue) {
        if (cancelled) return
        markTranslating(c.doi, true)
        try {
          const zh = await translateText((c.abstractEn || '').trim(), readTranslateCfg())
          if (cancelled) return
          setTranslated(c.doi, zh)
        } catch (err) {
          if (cancelled) return
          if (!translationErrorShownRef.current) {
            translationErrorShownRef.current = true
            const msg = err instanceof Error ? err.message : String(err)
            toast.error(`摘要自动翻译失败，已显示英文原文：${msg}`, { duration: 8000 })
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
        {/* 左①（1）：功能入口 —— 添加关键词 / 添加期刊 / 立即追踪 / DOI 入库 / 搜索 */}
        {/* ============================================================ */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded-card border border-ink-200 bg-paper-50">
          <div className="af-line-b shrink-0 p-4">
            {/* 三个动作：添加关键词 / 添加期刊 / 立即追踪（红） */}
            <div className="space-y-2">
              <button
                onClick={openAddKeywordGroup}
                className="flex w-full items-center gap-2 rounded-control border border-ink-200 px-ui-gap py-2 text-ui-xs text-ink-700 transition hover:bg-paper-100"
              >
                <Tag className="h-4 w-4 text-ink-500" />
                添加关键词
              </button>
              <button
                onClick={openAddJournal}
                className="flex w-full items-center gap-2 rounded-control border border-ink-200 px-ui-gap py-2 text-ui-xs text-ink-700 transition hover:bg-paper-100"
              >
                <Newspaper className="h-4 w-4 text-ink-500" />
                添加期刊
              </button>
              <button
                onClick={handleTrackNow}
                disabled={isTracking}
                className="flex w-full items-center justify-center gap-2 rounded-control bg-seal-600 px-ui-gap py-2 text-ui-xs font-medium text-paper-50 transition hover:bg-seal-700 disabled:opacity-50"
              >
                {isTracking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                立即追踪
              </button>
            </div>

            {/* 统计 */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-control bg-seal-50 p-2.5">
                <div className="flex items-center gap-1.5">
                  <Hash className="h-3.5 w-3.5 text-seal-600" />
                  <span className="text-ui-2xs font-medium text-seal-600">关键词组</span>
                </div>
                <div className="mt-0.5 text-lg font-bold text-seal-700">
                  {enabledKeywordGroupCount}
                  <span className="ml-1 text-ui-2xs font-normal text-seal-400">/ {keywordGroups.length}</span>
                </div>
              </div>
              <div className="rounded-control bg-emerald-50 p-2.5">
                <div className="flex items-center gap-1.5">
                  <Newspaper className="h-3.5 w-3.5 text-emerald-600" />
                  <span className="text-ui-2xs font-medium text-emerald-600">追踪期刊</span>
                </div>
                <div className="mt-0.5 text-lg font-bold text-emerald-700">
                  {enabledJournalCount}
                  <span className="ml-1 text-ui-2xs font-normal text-emerald-400">/ {journals.length}</span>
                </div>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1.5 text-center">
              {TRACKING_SOURCES.map((label) => {
                const count = sourceCount(label)
                return (
                  <div key={label} className="rounded-control bg-paper-100 p-1.5">
                    <div className={`text-ui-sm font-bold ${count > 0 ? 'text-ink-700' : 'text-ink-300'}`}>{count}</div>
                    <div className="text-ui-2xs text-ink-500">{label}</div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* 可滚动功能列表：关键词组 / 期刊 / DOI 入库 / 搜索 */}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {/* ---------- 关键词组（可折叠） ---------- */}
            <div className="rounded-control border border-ink-200">
              <button
                onClick={() => setKeywordGroupsCollapsed(!keywordGroupsCollapsed)}
                className="flex w-full items-center justify-between p-3 text-left transition hover:bg-paper-100"
              >
                <h3 className="flex items-center gap-1.5 text-ui-xs font-semibold text-ink-700">
                  <Tag className="h-3.5 w-3.5 text-seal-600" />
                  关键词组
                  <span className="font-normal text-ink-400">({keywordGroups.length})</span>
                </h3>
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      openAddKeywordGroup()
                    }}
                    className="rounded-control-sm p-1 text-ink-400 transition hover:bg-seal-50 hover:text-seal-600"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                  {keywordGroupsCollapsed ? (
                    <ChevronRight className="h-3.5 w-3.5 text-ink-400" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-ink-400" />
                  )}
                </div>
              </button>

              {!keywordGroupsCollapsed && (
                <div className="af-line-t p-3">
                  {keywordGroups.length === 0 ? (
                    <div className="rounded-control border border-dashed border-ink-200 py-4 text-center text-ui-2xs text-ink-400">
                      尚未配置关键词组
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {keywordGroups.map((group) => (
                        <div
                          key={group.id}
                          className={`rounded-control border border-ink-200 p-2 transition ${group.enabled ? 'bg-paper-50' : 'bg-paper-100 opacity-60'}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <button
                                onClick={() => toggleKeywordGroup(group.id)}
                                className={`relative h-4 w-7 flex-shrink-0 rounded-full transition ${group.enabled ? 'bg-seal-600' : 'bg-ink-300'}`}
                              >
                                <div
                                  className={`absolute top-0.5 h-3 w-3 rounded-full bg-paper-50 shadow transition-transform ${group.enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`}
                                />
                              </button>
                              <span className="truncate text-ui-xs font-medium text-ink-800">{group.name}</span>
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
                          {group.keywords.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1 pl-9">
                              {group.keywords.slice(0, 4).map((kw, idx) => (
                                <span key={idx} className="rounded-full bg-seal-50 px-1.5 py-0.5 text-ui-2xs text-seal-600">
                                  {kw}
                                </span>
                              ))}
                              {group.keywords.length > 4 && (
                                <span className="rounded-full bg-ink-100 px-1.5 py-0.5 text-ui-2xs text-ink-500">
                                  +{group.keywords.length - 4}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ---------- 期刊追踪（可折叠） ---------- */}
            <div className="rounded-control border border-ink-200">
              <button
                onClick={() => setJournalsCollapsed(!journalsCollapsed)}
                className="flex w-full items-center justify-between p-3 text-left transition hover:bg-paper-100"
              >
                <h3 className="flex items-center gap-1.5 text-ui-xs font-semibold text-ink-700">
                  <BookMarked className="h-3.5 w-3.5 text-seal-600" />
                  期刊追踪
                  <span className="font-normal text-ink-400">({journals.length})</span>
                </h3>
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      openAddJournal()
                    }}
                    className="rounded-control-sm p-1 text-ink-400 transition hover:bg-seal-50 hover:text-seal-600"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                  {journalsCollapsed ? (
                    <ChevronRight className="h-3.5 w-3.5 text-ink-400" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-ink-400" />
                  )}
                </div>
              </button>

              {!journalsCollapsed && (
                <div className="af-line-t p-3">
                  {journals.length === 0 ? (
                    <div className="rounded-control border border-dashed border-ink-200 py-4 text-center text-ui-2xs text-ink-400">
                      尚未添加期刊
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {journals.map((journal) => (
                        <div
                          key={journal.id}
                          className={`flex items-center justify-between gap-2 rounded-control p-2 transition hover:bg-paper-100 ${journal.enabled ? '' : 'opacity-60'}`}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <button
                              onClick={() => toggleJournal(journal.id)}
                              className={`relative h-4 w-7 flex-shrink-0 rounded-full transition ${journal.enabled ? 'bg-seal-600' : 'bg-ink-300'}`}
                            >
                              <div
                                className={`absolute top-0.5 h-3 w-3 rounded-full bg-paper-50 shadow transition-transform ${journal.enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`}
                              />
                            </button>
                            <div className="min-w-0">
                              <div className="truncate text-ui-xs font-medium text-ink-800">{journal.name}</div>
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
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ---------- DOI 入库 ---------- */}
            <div className="rounded-control border border-ink-200 p-3">
              <h3 className="mb-2 flex items-center gap-1.5 text-ui-xs font-semibold text-ink-700">
                <Plus className="h-3.5 w-3.5 text-seal-600" />
                DOI 入库
              </h3>
              <div className="space-y-2">
                <input
                  type="text"
                  value={doiInput}
                  onChange={(e) => setDoiInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddByDoi()}
                  placeholder="输入 DOI 或 DOI 链接..."
                  className="w-full rounded-control border border-ink-300 px-ui-gap py-2 text-ui-xs focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
                />
                <button
                  onClick={handleAddByDoi}
                  disabled={isAdding || !doiInput.trim()}
                  className="flex w-full items-center justify-center gap-2 rounded-control bg-seal-600 px-ui-gap py-2 text-ui-xs font-medium text-paper-50 transition hover:bg-seal-700 disabled:opacity-50"
                >
                  {isAdding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  通过 DOI 入库
                </button>
              </div>
              <p className="mt-1.5 text-ui-2xs text-ink-400">支持 doi:10.xxx、https://doi.org/10.xxx 等格式</p>
            </div>

            {/* ---------- 学术搜索 ---------- */}
            <div className="rounded-control border border-ink-200 p-3">
              <h3 className="mb-2 flex items-center gap-1.5 text-ui-xs font-semibold text-ink-700">
                <Globe className="h-3.5 w-3.5 text-seal-600" />
                学术搜索
              </h3>
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
                    <div className="absolute left-0 top-full z-50 mt-1 w-full overflow-hidden rounded-control border border-ink-200 bg-paper-50 shadow-lg">
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
                    className="flex items-center gap-1.5 rounded-control bg-seal-600 px-ui-gap py-2 text-ui-xs font-medium text-paper-50 transition hover:bg-seal-700"
                  >
                    <Search className="h-3.5 w-3.5" />
                    搜索
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
            <h2 className="flex items-center gap-2 text-ui-sm font-semibold text-ink-800">
              <Rss className="h-4 w-4 text-seal-600" />
              待入库
              {pendingList.length > 0 && (
                <span className="rounded-control-sm bg-seal-50 px-1.5 py-0.5 text-ui-xs text-seal-600">{pendingList.length}</span>
              )}
            </h2>
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
                const zh = translatedAbstracts[paper.doi]
                const showEn = showOriginalDois.includes(paper.doi) || !zh
                const isTranslating = translatingDois.includes(paper.doi)
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
                        <h3 className="text-ui-sm font-medium leading-snug text-ink-800">{paper.title || '(无标题)'}</h3>
                        {paper.authors && <p className="mt-1 text-ui-xs text-ink-500">{paper.authors}</p>}
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-2xs text-ink-400">
                          {paper.year > 0 && <span>{paper.year}</span>}
                          {paper.journal && <span className="text-seal-600">{paper.journal}</span>}
                          {paper.source && <span className="rounded-control-sm bg-ink-100 px-1.5 py-0.5 text-ink-500">{paper.source}</span>}
                          {paper.trackingGroup && <span>来自「{paper.trackingGroup}」</span>}
                        </div>

                        {paper.abstractEn && (
                          <div className="mt-2 rounded-control bg-paper-100/60 p-2.5">
                            <div className="mb-1 flex items-center justify-between gap-2">
                              <span className="text-ui-2xs font-medium text-ink-500">
                                {showEn ? '摘要（EN）' : '中文摘要'}
                              </span>
                              <button
                                onClick={() => {
                                  if (isTranslating) return
                                  if (zh) toggleAbstractOriginal(paper.doi)
                                  else retranslateAbstract(paper)
                                }}
                                disabled={isTranslating}
                                className="flex items-center gap-1 rounded-control-sm px-1.5 py-0.5 text-ui-2xs text-seal-600 transition hover:bg-seal-50 disabled:opacity-50"
                              >
                                {isTranslating ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Languages className="h-3 w-3" />
                                )}
                                {isTranslating ? '翻译中' : zh ? (showEn ? '看译文' : '看原文') : '译为中文'}
                              </button>
                            </div>
                            <p className="text-ui-xs leading-relaxed text-ink-600">
                              {showEn ? paper.abstractEn : zh}
                            </p>
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
              <h2 className="flex items-center gap-2 text-ui-sm font-semibold text-ink-800">
                <FileText className="h-4 w-4 text-seal-600" />
                待补 PDF
                {libraryPendingPdf.length > 0 && (
                  <span className="rounded-control-sm bg-orange-50 px-1.5 py-0.5 text-ui-xs text-orange-600">{libraryPendingPdf.length}</span>
                )}
              </h2>
              {selectedLibraryDois.length > 0 && (
                <button
                  onClick={handleBatchOpenDoi}
                  className="flex items-center gap-1.5 rounded-control bg-seal-600 px-2.5 py-1.5 text-ui-2xs font-medium text-paper-50 transition hover:bg-seal-700"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  打开 DOI（{selectedLibraryDois.length}）
                </button>
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
                  关键词
                </label>
                {keywordFormKeywords.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2 p-2 border border-ink-200 rounded-control bg-paper-100 min-h-10">
                    {keywordFormKeywords.map((kw, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 px-2 py-0.5 bg-seal-100 text-seal-700 text-ui-xs rounded-full"
                      >
                        {kw}
                        <button
                          onClick={() => removeKeywordTag(idx)}
                          className="hover:text-seal-900"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
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
                  className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
                <p className="text-ui-xs text-ink-400 mt-1.5">
                  输入关键词后按 Enter 添加，点击标签上的 × 删除
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
                <input
                  type="text"
                  value={journalFormName}
                  onChange={(e) => setJournalFormName(e.target.value)}
                  placeholder="如：Sample Journal"
                  className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
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
                <input
                  type="text"
                  value={journalFormRssUrl}
                  onChange={(e) => setJournalFormRssUrl(e.target.value)}
                  placeholder="可选，用于RSS订阅追踪"
                  className="w-full px-ui-gap py-2 border border-ink-300 rounded-control text-ui-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                />
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
