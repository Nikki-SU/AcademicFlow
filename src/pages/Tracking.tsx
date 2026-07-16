/**
 * 文献追踪页面（占位）
 * 功能：多源并行追踪（CrossRef + OpenAlex + arXiv + RSS）
 */
import { Search, Bell, Settings } from 'lucide-react'

export default function TrackingPage() {
  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-800">文献追踪</h1>
          <p className="text-sm text-slate-500 mt-1">每日自动从多源拉取命中关键词的新文献</p>
        </div>
        <button className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition">
          <Settings className="w-4 h-4" />
          关键词组配置
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* 追踪状态卡片 */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-white rounded-xl border border-slate-200 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-indigo-50 rounded-lg">
                <Search className="w-5 h-5 text-indigo-600" />
              </div>
              <div>
                <h2 className="font-semibold text-slate-800">今日追踪</h2>
                <p className="text-xs text-slate-500">下次自动追踪：08:00</p>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3 text-center">
              {[
                { label: 'CrossRef', count: 0, color: 'text-slate-400' },
                { label: 'OpenAlex', count: 0, color: 'text-slate-400' },
                { label: 'arXiv', count: 0, color: 'text-slate-400' },
                { label: 'RSS', count: 0, color: 'text-slate-400' },
              ].map((source) => (
                <div key={source.label} className="p-3 bg-slate-50 rounded-lg">
                  <div className={`text-lg font-bold ${source.color}`}>{source.count}</div>
                  <div className="text-xs text-slate-500">{source.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* 追踪结果列表 */}
          <div className="bg-white rounded-xl border border-slate-200 p-6">
            <h2 className="font-semibold text-slate-800 mb-4">追踪结果</h2>
            <div className="text-center py-12 text-slate-400">
              <Bell className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">今日暂无新文献命中</p>
              <p className="text-xs mt-1">请在设置中配置关键词组后启用追踪</p>
            </div>
          </div>
        </div>

        {/* 侧边栏 */}
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <h3 className="font-semibold text-slate-800 text-sm mb-3">关键词组</h3>
            <div className="text-sm text-slate-400 py-4 text-center">
              尚未配置关键词组
            </div>
            <button className="w-full mt-2 px-3 py-2 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition">
              + 新建关键词组
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
