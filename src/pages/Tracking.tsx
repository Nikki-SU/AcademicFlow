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
import { useState, useEffect, useRef } from 'react'
import {
  Bell,
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
  ExternalLink,
} from 'lucide-react'
import { toast } from 'sonner'
import { normalizeDoi, getCitationEntries } from '../services/citation'
import { readCsvFile, writeCsvFile } from '../services/userData'

// ============================================================
// 类型定义
// ============================================================

interface KeywordGroup {
  id: string
  name: string
  keywords: string[]
  enabled: boolean
}

interface JournalItem {
  id: string
  name: string
  issn?: string
  publisher?: string
  rssUrl?: string
  enabled: boolean
}

interface SearchSite {
  id: string
  name: string
  urlTemplate: string
  color: string
}

interface TrackedPaper {
  id: string
  title: string
  authors: string
  year: number
  journal: string
  doi: string
  source: string
}

// ============================================================
// 常量
// ============================================================

const DEFAULT_SEARCH_SITES: SearchSite[] = [
  { id: 'cnki', name: '中国知网', urlTemplate: 'https://kns.cnki.net/kns8s/defaultresult/index?kw={query}', color: 'bg-red-50 text-red-600' },
  { id: 'xmol', name: 'X-MOL', urlTemplate: 'https://www.x-mol.com/paper/search?q={query}', color: 'bg-blue-50 text-blue-600' },
  { id: 'scholar', name: 'Google Scholar', urlTemplate: 'https://scholar.google.com/scholar?q={query}', color: 'bg-slate-50 text-slate-600' },
  { id: 'pubmed', name: 'PubMed', urlTemplate: 'https://pubmed.ncbi.nlm.nih.gov/?term={query}', color: 'bg-indigo-50 text-indigo-600' },
  { id: 'arxiv', name: 'arXiv', urlTemplate: 'https://arxiv.org/search/?query={query}&searchtype=all', color: 'bg-slate-100 text-slate-600' },
]

const TRACKING_SOURCES = [
  { label: 'CrossRef', count: 0, color: 'text-slate-400' },
  { label: 'OpenAlex', count: 0, color: 'text-slate-400' },
  { label: 'arXiv', count: 0, color: 'text-slate-400' },
  { label: 'RSS', count: 0, color: 'text-slate-400' },
]

const DEMO_TRACKED_PAPERS: TrackedPaper[] = []

// ============================================================
// localStorage 工具函数
// ============================================================

const STORAGE_KEYS = {
  KEYWORD_GROUPS: 'tracking_keyword_groups',
  JOURNALS: 'tracking_journals',
  SEARCH_SITES: 'tracking_search_sites',
  KEYWORD_GROUPS_COLLAPSED: 'tracking_kw_groups_collapsed',
  JOURNALS_COLLAPSED: 'tracking_journals_collapsed',
}

function loadFromStorage<T>(key: string, defaultValue: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      return JSON.parse(raw) as T
    }
  } catch {
    // ignore
  }
  return defaultValue
}

function saveToStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore
  }
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// ============================================================
// 主组件
// ============================================================

export default function TrackingPage() {
  // ---------- 快速入库 ----------
  const [doiInput, setDoiInput] = useState('')
  const [isAdding, setIsAdding] = useState(false)

  // ---------- 关键词组 ----------
  const [keywordGroups, setKeywordGroups] = useState<KeywordGroup[]>([])
  const [keywordGroupsCollapsed, setKeywordGroupsCollapsed] = useState(() =>
    loadFromStorage<boolean>(STORAGE_KEYS.KEYWORD_GROUPS_COLLAPSED, true),
  )
  const [showKeywordModal, setShowKeywordModal] = useState(false)
  const [editingKeywordGroup, setEditingKeywordGroup] = useState<KeywordGroup | null>(null)
  const [keywordFormName, setKeywordFormName] = useState('')
  const [keywordFormKeywords, setKeywordFormKeywords] = useState<string[]>([])
  const [keywordInput, setKeywordInput] = useState('')

  // ---------- 期刊 ----------
  const [journals, setJournals] = useState<JournalItem[]>([])
  const [journalsCollapsed, setJournalsCollapsed] = useState(() =>
    loadFromStorage<boolean>(STORAGE_KEYS.JOURNALS_COLLAPSED, true),
  )
  const [showJournalModal, setShowJournalModal] = useState(false)
  const [editingJournal, setEditingJournal] = useState<JournalItem | null>(null)
  const [journalFormName, setJournalFormName] = useState('')
  const [journalFormIssn, setJournalFormIssn] = useState('')
  const [journalFormPublisher, setJournalFormPublisher] = useState('')
  const [journalFormRssUrl, setJournalFormRssUrl] = useState('')

  // ---------- 搜索 ----------
  const [searchSites, setSearchSites] = useState<SearchSite[]>(() =>
    loadFromStorage<SearchSite[]>(STORAGE_KEYS.SEARCH_SITES, DEFAULT_SEARCH_SITES),
  )
  const [selectedSearchSiteId, setSelectedSearchSiteId] = useState(() => {
    const saved = loadFromStorage<SearchSite[]>(STORAGE_KEYS.SEARCH_SITES, DEFAULT_SEARCH_SITES)
    return saved.length > 0 ? saved[0].id : DEFAULT_SEARCH_SITES[0].id
  })
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearchDropdown, setShowSearchDropdown] = useState(false)
  const [showSearchManager, setShowSearchManager] = useState(false)
  const [editingSearchSite, setEditingSearchSite] = useState<SearchSite | null>(null)
  const [searchFormName, setSearchFormName] = useState('')
  const [searchFormUrlTemplate, setSearchFormUrlTemplate] = useState('')
  const [searchFormColor, setSearchFormColor] = useState('bg-indigo-50 text-indigo-600')
  const searchDropdownRef = useRef<HTMLDivElement>(null)

  // ---------- 立即追踪 ----------
  const [isTracking, setIsTracking] = useState(false)
  const [trackedPapers, setTrackedPapers] = useState<TrackedPaper[]>(DEMO_TRACKED_PAPERS)

  // ============================================================
  // 持久化
  // ============================================================

  // 搜索源、折叠状态等 UI 偏好继续用 localStorage
  useEffect(() => {
    saveToStorage(STORAGE_KEYS.SEARCH_SITES, searchSites)
  }, [searchSites])

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.KEYWORD_GROUPS_COLLAPSED, keywordGroupsCollapsed)
  }, [keywordGroupsCollapsed])

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.JOURNALS_COLLAPSED, journalsCollapsed)
  }, [journalsCollapsed])

  // 关键词组 & 期刊从 GitHub 私库加载
  const dataLoadedRef = useRef(false)
  useEffect(() => {
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
              keywords: (r[2] || '').split(',').filter(Boolean),
              enabled: r[3] === '1' || r[3] === 'true',
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
      if (!cancelled) dataLoadedRef.current = true
    }
    loadData()
    return () => {
      cancelled = true
    }
  }, [])

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
          ['id', 'name', 'keywords', 'enabled'],
          (g) => [g.id, g.name, g.keywords.join(','), g.enabled ? '1' : '0'],
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
      toast.success(`已入库：${meta.title.slice(0, 40)}${meta.title.length > 40 ? '...' : ''}`)
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
    setSearchFormColor('bg-indigo-50 text-indigo-600')
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
    if (!searchFormUrlTemplate.trim() || !searchFormUrlTemplate.includes('{query}')) {
      toast.error('请输入包含 {query} 占位符的搜索URL模板')
      return
    }

    if (editingSearchSite) {
      setSearchSites((prev) =>
        prev.map((s) =>
          s.id === editingSearchSite.id
            ? { ...s, name: searchFormName.trim(), urlTemplate: searchFormUrlTemplate.trim(), color: searchFormColor }
            : s,
        ),
      )
      toast.success('搜索源已更新')
    } else {
      const newSite: SearchSite = {
        id: generateId(),
        name: searchFormName.trim(),
        urlTemplate: searchFormUrlTemplate.trim(),
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
  // 立即追踪
  // ============================================================

  const handleTrackNow = () => {
    const enabledGroups = keywordGroups.filter((g) => g.enabled)
    const enabledJournals = journals.filter((j) => j.enabled)
    if (enabledGroups.length === 0 && enabledJournals.length === 0) {
      toast.error('请先启用至少一个关键词组或期刊')
      return
    }
    setIsTracking(true)
    setTimeout(() => {
      setIsTracking(false)
      setTrackedPapers([])
      toast.success('追踪完成，暂无新文献命中')
    }, 1500)
  }

  const handleAddPaperToLibrary = (paper: TrackedPaper) => {
    toast.success(`已入库：${paper.title.slice(0, 40)}${paper.title.length > 40 ? '...' : ''}`)
  }

  // ============================================================
  // 统计
  // ============================================================

  const enabledKeywordGroupCount = keywordGroups.filter((g) => g.enabled).length
  const enabledJournalCount = journals.filter((j) => j.enabled).length

  // ============================================================
  // 颜色选项
  // ============================================================

  const colorOptions = [
    'bg-indigo-50 text-indigo-600',
    'bg-blue-50 text-blue-600',
    'bg-red-50 text-red-600',
    'bg-orange-50 text-orange-600',
    'bg-amber-50 text-amber-600',
    'bg-emerald-50 text-emerald-600',
    'bg-teal-50 text-teal-600',
    'bg-purple-50 text-purple-600',
    'bg-pink-50 text-pink-600',
    'bg-slate-50 text-slate-600',
  ]

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* 顶栏 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-800">文献追踪</h1>
          <p className="text-sm text-slate-500 mt-1">关键词追踪、期刊订阅、学术搜索</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ============================================================ */}
        {/* 左侧（2/3 宽度）：今日追踪 + 学术搜索 + 追踪结果 */}
        {/* ============================================================ */}
        <div className="lg:col-span-2 space-y-6">
          {/* ---------- 今日追踪卡片 ---------- */}
          <div className="bg-white rounded-xl border border-slate-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-50 rounded-lg">
                  <Bell className="w-5 h-5 text-indigo-600" />
                </div>
                <div>
                  <h2 className="font-semibold text-slate-800">今日追踪</h2>
                  <p className="text-xs text-slate-500">下次自动追踪：08:00</p>
                </div>
              </div>
              <button
                onClick={handleTrackNow}
                disabled={isTracking}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition"
              >
                {isTracking ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
                立即追踪
              </button>
            </div>

            {/* 配置统计 */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="p-3 bg-indigo-50 rounded-lg">
                <div className="flex items-center gap-2">
                  <Hash className="w-4 h-4 text-indigo-600" />
                  <span className="text-xs text-indigo-600 font-medium">关键词组</span>
                </div>
                <div className="mt-1 text-2xl font-bold text-indigo-700">
                  {enabledKeywordGroupCount}
                  <span className="text-sm font-normal text-indigo-400 ml-1">/ {keywordGroups.length}</span>
                </div>
              </div>
              <div className="p-3 bg-emerald-50 rounded-lg">
                <div className="flex items-center gap-2">
                  <Newspaper className="w-4 h-4 text-emerald-600" />
                  <span className="text-xs text-emerald-600 font-medium">追踪期刊</span>
                </div>
                <div className="mt-1 text-2xl font-bold text-emerald-700">
                  {enabledJournalCount}
                  <span className="text-sm font-normal text-emerald-400 ml-1">/ {journals.length}</span>
                </div>
              </div>
            </div>

            {/* 追踪源统计 */}
            <div className="grid grid-cols-4 gap-3 text-center">
              {TRACKING_SOURCES.map((source) => (
                <div key={source.label} className="p-3 bg-slate-50 rounded-lg">
                  <div className={`text-lg font-bold ${source.color}`}>{source.count}</div>
                  <div className="text-xs text-slate-500">{source.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ---------- 学术搜索框 ---------- */}
          <div className="bg-white rounded-xl border border-slate-200 p-6">
            <h2 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
              <Globe className="w-5 h-5 text-indigo-600" />
              学术搜索
            </h2>
            <div className="flex gap-2" ref={searchDropdownRef}>
              {/* 搜索源选择下拉 */}
              <div className="relative">
                <button
                  onClick={() => setShowSearchDropdown(!showSearchDropdown)}
                  className="flex items-center gap-2 px-3 py-2 border border-slate-300 rounded-lg text-sm hover:border-indigo-400 transition bg-white"
                >
                  <div className={`w-7 h-7 rounded-md flex items-center justify-center ${selectedSearchSite?.color || 'bg-slate-50 text-slate-600'}`}>
                    <Search className="w-3.5 h-3.5" />
                  </div>
                  <span className="text-slate-700 max-w-24 truncate">{selectedSearchSite?.name}</span>
                  <ChevronDown className="w-4 h-4 text-slate-400" />
                </button>

                {showSearchDropdown && (
                  <div className="absolute top-full left-0 mt-1 w-64 bg-white border border-slate-200 rounded-lg shadow-lg z-50 overflow-hidden">
                    <div className="max-h-72 overflow-y-auto py-1">
                      {searchSites.map((site) => (
                        <button
                          key={site.id}
                          onClick={() => {
                            setSelectedSearchSiteId(site.id)
                            setShowSearchDropdown(false)
                          }}
                          className={`w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50 transition ${
                            selectedSearchSiteId === site.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'
                          }`}
                        >
                          <div className={`w-7 h-7 rounded-md flex items-center justify-center ${site.color}`}>
                            <Search className="w-3.5 h-3.5" />
                          </div>
                          <span className="flex-1 text-left truncate">{site.name}</span>
                          {selectedSearchSiteId === site.id && (
                            <CheckCircle2 className="w-4 h-4 text-indigo-600" />
                          )}
                        </button>
                      ))}
                    </div>
                    <div className="border-t border-slate-100 p-2">
                      <button
                        onClick={() => {
                          setShowSearchDropdown(false)
                          openAddSearchSite()
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-indigo-600 hover:bg-indigo-50 rounded-md transition"
                      >
                        <Settings className="w-4 h-4" />
                        管理搜索源
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* 搜索输入框 */}
              <div className="flex-1 flex gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  placeholder="输入搜索关键词..."
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
                <button
                  onClick={handleSearch}
                  className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition"
                >
                  <Search className="w-4 h-4" />
                  搜索
                </button>
              </div>
            </div>
            <p className="text-xs text-slate-400 mt-2">
              提示：按 Enter 快速搜索，在新标签页打开结果
            </p>
          </div>

          {/* ---------- 追踪结果 ---------- */}
          <div className="bg-white rounded-xl border border-slate-200 p-6">
            <h2 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
              <FileText className="w-5 h-5 text-indigo-600" />
              追踪结果
            </h2>

            {trackedPapers.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <Rss className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="text-sm font-medium">今日暂无新文献</p>
                <p className="text-xs mt-1">配置关键词组或期刊后自动追踪</p>
              </div>
            ) : (
              <div className="space-y-4">
                {trackedPapers.map((paper) => (
                  <div
                    key={paper.id}
                    className="p-4 border border-slate-200 rounded-lg hover:border-indigo-200 hover:bg-indigo-50/30 transition"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-medium text-slate-800 text-sm leading-snug mb-2">
                          {paper.title}
                        </h3>
                        <p className="text-xs text-slate-500 mb-1.5">
                          {paper.authors}
                        </p>
                        <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">
                          <span>{paper.year}</span>
                          <span className="text-slate-300">·</span>
                          <span className="text-indigo-600">{paper.journal}</span>
                          {paper.doi && (
                            <>
                              <span className="text-slate-300">·</span>
                              <a
                                href={`https://doi.org/${paper.doi}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-slate-400 hover:text-indigo-600 inline-flex items-center gap-0.5"
                              >
                                DOI
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            </>
                          )}
                          <span className="text-slate-300">·</span>
                          <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded">
                            {paper.source}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => handleAddPaperToLibrary(paper)}
                        className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white text-xs font-medium rounded-lg hover:bg-indigo-700 transition"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        入库
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ============================================================ */}
        {/* 右侧（1/3 宽度）：快速入库 + 关键词组 + 期刊追踪 */}
        {/* ============================================================ */}
        <div className="space-y-6">
          {/* ---------- 快速入库 ---------- */}
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <h3 className="font-semibold text-slate-800 text-sm mb-3 flex items-center gap-2">
              <Plus className="w-4 h-4 text-indigo-600" />
              快速入库
            </h3>
            <div className="space-y-2">
              <input
                type="text"
                value={doiInput}
                onChange={(e) => setDoiInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddByDoi()}
                placeholder="输入 DOI 或 DOI 链接..."
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
              <button
                onClick={handleAddByDoi}
                disabled={isAdding || !doiInput.trim()}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition"
              >
                {isAdding ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-4 h-4" />
                )}
                通过 DOI 入库
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-2">
              支持 doi:10.xxx、https://doi.org/10.xxx 等格式
            </p>
          </div>

          {/* ---------- 关键词组（可折叠） ---------- */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <button
              onClick={() => setKeywordGroupsCollapsed(!keywordGroupsCollapsed)}
              className="w-full flex items-center justify-between p-5 hover:bg-slate-50 transition"
            >
              <h3 className="font-semibold text-slate-800 text-sm flex items-center gap-2">
                <Tag className="w-4 h-4 text-indigo-600" />
                关键词组
                <span className="text-xs font-normal text-slate-400">
                  ({keywordGroups.length})
                </span>
              </h3>
              <div className="flex items-center gap-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    openAddKeywordGroup()
                  }}
                  className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                  title="新建关键词组"
                >
                  <Plus className="w-4 h-4" />
                </button>
                {keywordGroupsCollapsed ? (
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-slate-400" />
                )}
              </div>
            </button>

            {!keywordGroupsCollapsed && (
              <div className="px-5 pb-5 border-t border-slate-100">
                {keywordGroups.length === 0 ? (
                  <div className="text-center py-6 text-slate-400">
                    <Tag className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p className="text-xs">尚未配置关键词组</p>
                    <button
                      onClick={openAddKeywordGroup}
                      className="mt-2 text-xs text-indigo-600 hover:underline"
                    >
                      立即添加
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2 mt-3 max-h-80 overflow-y-auto">
                    {keywordGroups.map((group) => (
                      <div
                        key={group.id}
                        className={`p-3 border rounded-lg transition ${
                          group.enabled
                            ? 'border-slate-200 bg-white'
                            : 'border-slate-200 bg-slate-50 opacity-60'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <button
                              onClick={() => toggleKeywordGroup(group.id)}
                              className={`w-8 h-4.5 rounded-full transition relative flex-shrink-0 ${
                                group.enabled ? 'bg-indigo-600' : 'bg-slate-300'
                              }`}
                            >
                              <div
                                className={`absolute top-0.5 w-3.5 h-3.5 bg-white rounded-full shadow transition-transform ${
                                  group.enabled ? 'translate-x-4' : 'translate-x-0.5'
                                }`}
                              />
                            </button>
                            <span className="font-medium text-sm text-slate-800 truncate">
                              {group.name}
                            </span>
                          </div>
                          <div className="flex items-center gap-0.5 flex-shrink-0">
                            <button
                              onClick={() => openEditKeywordGroup(group)}
                              className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleDeleteKeywordGroup(group.id)}
                              className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1 ml-10">
                          {group.keywords.slice(0, 5).map((kw, idx) => (
                            <span
                              key={idx}
                              className="px-1.5 py-0.5 bg-indigo-50 text-indigo-600 text-xs rounded-full"
                            >
                              {kw}
                            </span>
                          ))}
                          {group.keywords.length > 5 && (
                            <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 text-xs rounded-full">
                              +{group.keywords.length - 5}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ---------- 期刊追踪（可折叠） ---------- */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <button
              onClick={() => setJournalsCollapsed(!journalsCollapsed)}
              className="w-full flex items-center justify-between p-5 hover:bg-slate-50 transition"
            >
              <h3 className="font-semibold text-slate-800 text-sm flex items-center gap-2">
                <BookMarked className="w-4 h-4 text-indigo-600" />
                期刊追踪
                <span className="text-xs font-normal text-slate-400">
                  ({journals.length})
                </span>
              </h3>
              <div className="flex items-center gap-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    openAddJournal()
                  }}
                  className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                  title="添加期刊"
                >
                  <Plus className="w-4 h-4" />
                </button>
                {journalsCollapsed ? (
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-slate-400" />
                )}
              </div>
            </button>

            {!journalsCollapsed && (
              <div className="px-5 pb-5 border-t border-slate-100">
                {journals.length === 0 ? (
                  <div className="text-center py-6 text-slate-400">
                    <Newspaper className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    <p className="text-xs">尚未添加期刊</p>
                    <button
                      onClick={openAddJournal}
                      className="mt-2 text-xs text-indigo-600 hover:underline"
                    >
                      立即添加
                    </button>
                  </div>
                ) : (
                  <div className="space-y-1.5 mt-3 max-h-80 overflow-y-auto">
                    {journals.map((journal) => (
                      <div
                        key={journal.id}
                        className={`flex items-center justify-between p-2.5 rounded-lg transition ${
                          journal.enabled
                            ? 'hover:bg-slate-50'
                            : 'opacity-60 hover:bg-slate-50'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <button
                            onClick={() => toggleJournal(journal.id)}
                            className={`w-8 h-4.5 rounded-full transition relative flex-shrink-0 ${
                              journal.enabled ? 'bg-indigo-600' : 'bg-slate-300'
                            }`}
                          >
                            <div
                              className={`absolute top-0.5 w-3.5 h-3.5 bg-white rounded-full shadow transition-transform ${
                                journal.enabled ? 'translate-x-4' : 'translate-x-0.5'
                              }`}
                            />
                          </button>
                          <div className="min-w-0">
                            <div className="font-medium text-sm text-slate-800 truncate">
                              {journal.name}
                            </div>
                            {journal.issn && (
                              <div className="text-xs text-slate-400">{journal.issn}</div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-0.5 flex-shrink-0">
                          <button
                            onClick={() => openEditJournal(journal)}
                            className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeleteJournal(journal.id)}
                            className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ============================================================ */}
      {/* 关键词组编辑弹窗 */}
      {/* ============================================================ */}
      {showKeywordModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
            <div className="flex items-center justify-between p-5 border-b border-slate-200">
              <h3 className="font-semibold text-slate-800">
                {editingKeywordGroup ? '编辑关键词组' : '新建关键词组'}
              </h3>
              <button
                onClick={() => setShowKeywordModal(false)}
                className="p-1 text-slate-400 hover:text-slate-600 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  关键词组名称
                </label>
                <input
                  type="text"
                  value={keywordFormName}
                  onChange={(e) => setKeywordFormName(e.target.value)}
                  placeholder="如：钙钛矿太阳能电池"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  关键词
                </label>
                {keywordFormKeywords.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2 p-2 border border-slate-200 rounded-lg bg-slate-50 min-h-10">
                    {keywordFormKeywords.map((kw, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-100 text-indigo-700 text-xs rounded-full"
                      >
                        {kw}
                        <button
                          onClick={() => removeKeywordTag(idx)}
                          className="hover:text-indigo-900"
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
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
                <p className="text-xs text-slate-400 mt-1.5">
                  输入关键词后按 Enter 添加，点击标签上的 × 删除
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 p-5 border-t border-slate-200">
              <button
                onClick={() => setShowKeywordModal(false)}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                取消
              </button>
              <button
                onClick={handleSaveKeywordGroup}
                className="px-4 py-2 text-sm text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition font-medium"
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
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
            <div className="flex items-center justify-between p-5 border-b border-slate-200">
              <h3 className="font-semibold text-slate-800">
                {editingJournal ? '编辑期刊' : '添加期刊'}
              </h3>
              <button
                onClick={() => setShowJournalModal(false)}
                className="p-1 text-slate-400 hover:text-slate-600 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  期刊名称 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={journalFormName}
                  onChange={(e) => setJournalFormName(e.target.value)}
                  placeholder="如：Nature"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    ISSN
                  </label>
                  <input
                    type="text"
                    value={journalFormIssn}
                    onChange={(e) => setJournalFormIssn(e.target.value)}
                    placeholder="可选"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    出版社
                  </label>
                  <input
                    type="text"
                    value={journalFormPublisher}
                    onChange={(e) => setJournalFormPublisher(e.target.value)}
                    placeholder="可选"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  RSS 地址
                </label>
                <input
                  type="text"
                  value={journalFormRssUrl}
                  onChange={(e) => setJournalFormRssUrl(e.target.value)}
                  placeholder="可选，用于RSS订阅追踪"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 p-5 border-t border-slate-200">
              <button
                onClick={() => setShowJournalModal(false)}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                取消
              </button>
              <button
                onClick={handleSaveJournal}
                className="px-4 py-2 text-sm text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition font-medium"
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
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-5 border-b border-slate-200">
              <h3 className="font-semibold text-slate-800">管理搜索源</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={resetSearchSites}
                  className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-md transition"
                >
                  恢复默认
                </button>
                <button
                  onClick={() => setShowSearchManager(false)}
                  className="p-1 text-slate-400 hover:text-slate-600 transition"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* 已有搜索源列表 */}
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-slate-700">已有搜索源</h4>
                {searchSites.map((site) => (
                  <div
                    key={site.id}
                    className="flex items-center gap-3 p-3 border border-slate-200 rounded-lg hover:bg-slate-50 transition"
                  >
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${site.color}`}>
                      <Search className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm text-slate-800">{site.name}</div>
                      <div className="text-xs text-slate-500 truncate">{site.urlTemplate}</div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => openEditSearchSite(site)}
                        className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteSearchSite(site.id)}
                        className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* 新增/编辑表单 */}
              <div className="border-t border-slate-200 pt-4">
                <h4 className="text-sm font-medium text-slate-700 mb-3">
                  {editingSearchSite ? '编辑搜索源' : '添加搜索源'}
                </h4>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      网站名称
                    </label>
                    <input
                      type="text"
                      value={searchFormName}
                      onChange={(e) => setSearchFormName(e.target.value)}
                      placeholder="如：百度学术"
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      搜索URL模板
                    </label>
                    <input
                      type="text"
                      value={searchFormUrlTemplate}
                      onChange={(e) => setSearchFormUrlTemplate(e.target.value)}
                      placeholder="https://xueshu.baidu.com/s?wd={query}"
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                    />
                    <p className="text-xs text-slate-400 mt-1">
                      用 <code className="px-1 py-0.5 bg-slate-100 rounded">{'{query}'}</code> 作为搜索关键词的占位符
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1.5">
                      图标颜色
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {colorOptions.map((color) => (
                        <button
                          key={color}
                          onClick={() => setSearchFormColor(color)}
                          className={`w-8 h-8 rounded-lg flex items-center justify-center transition ${color} ${
                            searchFormColor === color
                              ? 'ring-2 ring-offset-1 ring-indigo-500'
                              : 'hover:ring-1 hover:ring-slate-300'
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

            <div className="flex items-center justify-end gap-2 p-5 border-t border-slate-200">
              <button
                onClick={() => {
                  setEditingSearchSite(null)
                  setShowSearchManager(false)
                }}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                关闭
              </button>
              <button
                onClick={handleSaveSearchSite}
                className="px-4 py-2 text-sm text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition font-medium"
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
