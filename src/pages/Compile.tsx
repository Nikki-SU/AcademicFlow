/**
 * 投稿编译页面（占位）
 * 功能：LaTeX + Word 编译
 */
import { Send, FileText, BookOpen, ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'

export default function CompilePage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-800">投稿编译</h1>
        <p className="text-sm text-slate-500 mt-1">一份原稿 × N 期刊 → PDF + Word 双产物</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 期刊模板管理入口 */}
        <Link
          to="/journal-templates"
          className="group p-6 bg-white border border-slate-200 rounded-xl hover:shadow-lg hover:border-indigo-200 transition-all"
        >
          <div className="flex items-start gap-3">
            <div className="p-2 bg-indigo-50 rounded-lg group-hover:bg-indigo-100 transition">
              <BookOpen className="w-6 h-6 text-indigo-600" />
            </div>
            <div className="flex-1">
              <div className="font-semibold text-slate-800 group-hover:text-indigo-700 transition">
                期刊模板管理
              </div>
              <p className="text-xs text-slate-500 mt-1">
                粘贴投稿须知，AI 提取格式规范，生成可复用模板
              </p>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-300 group-hover:text-indigo-400 transition" />
          </div>
        </Link>

        {/* AI 期刊排版入口 */}
        <Link
          to="/journal-format"
          className="group p-6 bg-gradient-to-br from-indigo-50 to-purple-50 border border-indigo-200 rounded-xl hover:shadow-lg hover:border-indigo-300 transition-all"
        >
          <div className="flex items-start gap-3">
            <div className="p-2 bg-indigo-100 rounded-lg group-hover:bg-indigo-200 transition">
              <FileText className="w-6 h-6 text-indigo-600" />
            </div>
            <div className="flex-1">
              <div className="font-semibold text-slate-800 group-hover:text-indigo-700 transition">
                AI 期刊排版
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Markdown → LaTeX，按期刊格式自动排版
              </p>
            </div>
            <ChevronRight className="w-5 h-5 text-indigo-300 group-hover:text-indigo-500 transition" />
          </div>
        </Link>
      </div>

      {/* 编译状态 */}
      <div className="mt-6 bg-white rounded-xl border border-slate-200 p-6">
        <h2 className="font-semibold text-slate-800 mb-4">编译产物</h2>
        <div className="text-center py-8 text-slate-400">
          <Send className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">暂无编译产物</p>
          <p className="text-xs mt-1">在写作页面完成稿件后，选择目标期刊编译</p>
        </div>
      </div>
    </div>
  )
}
