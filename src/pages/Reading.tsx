/**
 * 阅读页面（占位）
 * 功能：文献阅读 + 批注
 */
import { BookOpen, Highlighter, MessageSquare } from 'lucide-react'

export default function ReadingPage() {
  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-800">阅读与批注</h1>
        <p className="text-sm text-slate-500 mt-1">精读文献，添加批注和笔记</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 p-6 min-h-[500px]">
          <div className="text-center py-20 text-slate-400">
            <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">从文献库选择一篇文献开始阅读</p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <h3 className="font-semibold text-slate-800 text-sm mb-3">批注</h3>
            <div className="text-sm text-slate-400 py-4 text-center">
              选择文献后显示批注面板
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
