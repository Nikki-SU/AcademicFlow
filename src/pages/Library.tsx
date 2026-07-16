/**
 * 文献库页面（占位）
 * 功能：文献管理表格视图
 */
import { BookMarked, Filter, Search, FileText } from 'lucide-react'

export default function LibraryPage() {
  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-800">文献库</h1>
          <p className="text-sm text-slate-500 mt-1">管理已追踪和手动添加的文献</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition">
            <Filter className="w-4 h-4" />
            筛选
          </button>
          <button className="flex items-center gap-2 px-3 py-2 text-sm text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition">
            <Search className="w-4 h-4" />
            快速入库
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-200">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-500">全部</span>
            <span className="text-slate-300">|</span>
            <span className="text-slate-500">一级（无PDF）</span>
            <span className="text-slate-300">|</span>
            <span className="text-slate-500">二级（有PDF）</span>
          </div>
        </div>
        <div className="text-center py-16 text-slate-400">
          <BookMarked className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">文献库为空</p>
          <p className="text-xs mt-1">从追踪结果入库或手动添加 DOI</p>
        </div>
      </div>
    </div>
  )
}
