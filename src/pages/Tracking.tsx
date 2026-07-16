/**
 * 追踪页
 * -------------------------------------------------
 * 功能：
 * - 文献追踪（CrossRef / OpenAlex / arXiv / RSS）
 * - 学术搜索（内置常用网站快捷入口）
 * - 快速入库（DOI / arXiv ID）
 */
import { useState } from 'react'
import {
  Bell,
  Globe,
  BookOpen,
  Atom,
  Rss,
  Database,
  Plus,
  ExternalLink,
  Loader2,
  CheckCircle2,
} from 'lucide-react'
import { toast } from 'sonner'
import { normalizeDoi, getCitationEntries } from '../services/citation'

const SEARCH_SITES = [
  { name: 'Google Scholar', url: 'https://scholar.google.com', icon: BookOpen, color: 'bg-blue-50 text-blue-600' },
  { name: 'PubMed', url: 'https://pubmed.ncbi.nlm.nih.gov', icon: Database, color: 'bg-indigo-50 text-indigo-600' },
  { name: 'arXiv', url: 'https://arxiv.org', icon: Atom, color: 'bg-red-50 text-red-600' },
  { name: 'CrossRef', url: 'https://search.crossref.org', icon: Globe, color: 'bg-green-50 text-green-600' },
  { name: 'Web of Science', url: 'https://www.webofscience.com', icon: Globe, color: 'bg-amber-50 text-amber-600' },
  { name: 'Sci-Hub', url: 'https://sci-hub.se', icon: BookOpen, color: 'bg-slate-100 text-slate-600' },
]

const TRACKING_SOURCES = [
  { label: 'CrossRef', count: 0, color: 'text-slate-400' },
  { label: 'OpenAlex', count: 0, color: 'text-slate-400' },
  { label: 'arXiv', count: 0, color: 'text-slate-400' },
  { label: 'RSS', count: 0, color: 'text-slate-400' },
]

export default function TrackingPage() {
  const [doiInput, setDoiInput] = useState('')
  const [isAdding, setIsAdding] = useState(false)

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

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* 顶栏 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-800">文献追踪</h1>
          <p className="text-sm text-slate-500 mt-1">追踪文献和搜索文献（内置常用学术网站）</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* 左侧：追踪 + 搜索 */}
        <div className="lg:col-span-2 space-y-6">
          {/* 追踪状态 */}
          <div className="bg-white rounded-xl border border-slate-200 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-indigo-50 rounded-lg">
                <Bell className="w-5 h-5 text-indigo-600" />
              </div>
              <div>
                <h2 className="font-semibold text-slate-800">今日追踪</h2>
                <p className="text-xs text-slate-500">下次自动追踪：08:00</p>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3 text-center">
              {TRACKING_SOURCES.map((source) => (
                <div key={source.label} className="p-3 bg-slate-50 rounded-lg">
                  <div className={`text-lg font-bold ${source.color}`}>{source.count}</div>
                  <div className="text-xs text-slate-500">{source.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* 学术搜索网站 */}
          <div className="bg-white rounded-xl border border-slate-200 p-6">
            <h2 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
              <Globe className="w-5 h-5 text-indigo-600" />
              学术搜索
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {SEARCH_SITES.map((site) => {
                const Icon = site.icon
                return (
                  <a
                    key={site.name}
                    href={site.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 p-3 rounded-lg border border-slate-200 hover:border-indigo-300 hover:shadow-sm transition group"
                  >
                    <div className={`p-2 rounded-lg ${site.color}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-700 group-hover:text-indigo-700 truncate">
                        {site.name}
                      </div>
                    </div>
                    <ExternalLink className="w-3.5 h-3.5 text-slate-300 group-hover:text-indigo-400" />
                  </a>
                )
              })}
            </div>
          </div>

          {/* 追踪结果 */}
          <div className="bg-white rounded-xl border border-slate-200 p-6">
            <h2 className="font-semibold text-slate-800 mb-4">追踪结果</h2>
            <div className="text-center py-12 text-slate-400">
              <Rss className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">今日暂无新文献命中</p>
              <p className="text-xs mt-1">配置关键词组后自动追踪</p>
            </div>
          </div>
        </div>

        {/* 右侧：快速入库 + 关键词 */}
        <div className="space-y-6">
          {/* 快速入库 */}
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

          {/* 关键词组 */}
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <h3 className="font-semibold text-slate-800 text-sm mb-3">关键词组</h3>
            <div className="text-sm text-slate-400 py-4 text-center">
              尚未配置关键词组
            </div>
            <button className="w-full px-3 py-2 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition">
              + 新建关键词组
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
