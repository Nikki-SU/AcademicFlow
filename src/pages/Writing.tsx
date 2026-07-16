/**
 * 学术写作页面（占位）
 * 功能：编辑器 + AI 辅助写作
 */
import { PenTool, Sparkles, Wand2 } from 'lucide-react'

export default function WritingPage() {
  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-800">学术写作</h1>
          <p className="text-sm text-slate-500 mt-1">内联编辑器 + AI 辅助（起草 / 新颖性检查 / 术语一致性）</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition">
            <Wand2 className="w-4 h-4" />
            新颖性检查
          </button>
          <button className="flex items-center gap-2 px-3 py-2 text-sm text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition">
            <Sparkles className="w-4 h-4" />
            AI 辅助
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 min-h-[600px] flex items-center justify-center">
        <div className="text-center text-slate-400">
          <PenTool className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">编辑器开发中</p>
          <p className="text-xs mt-1">Vditor wysiwyg 模式 + 内联编辑</p>
        </div>
      </div>
    </div>
  )
}
