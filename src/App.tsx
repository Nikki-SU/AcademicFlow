import { BookOpen, Github, Sparkles } from 'lucide-react'

function App() {
  const buildTime = new Date().toISOString()

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50 to-purple-50 flex items-center justify-center p-6">
      <div className="max-w-2xl w-full bg-white rounded-2xl shadow-xl p-8 md:p-12 border border-slate-200">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-indigo-100 rounded-lg">
            <BookOpen className="w-8 h-8 text-indigo-600" />
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-slate-800">
            AcademicFlow
          </h1>
        </div>

        <p className="text-lg text-slate-600 mb-2">
          Hello, AcademicFlow 👋
        </p>
        <p className="text-sm text-slate-500 mb-8">
          学术工作流工具 · M0 部署链路验证
        </p>

        <div className="space-y-3 mb-8">
          <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
            <Sparkles className="w-5 h-5 text-indigo-500 mt-0.5 flex-shrink-0" />
            <div className="text-sm text-slate-700">
              <strong className="text-slate-900">技术栈：</strong>
              Vite 5 + React 18 + TypeScript 5.5 + Tailwind 3.4
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-lg">
            <Github className="w-5 h-5 text-slate-700 mt-0.5 flex-shrink-0" />
            <div className="text-sm text-slate-700">
              <strong className="text-slate-900">后端：</strong>
              纯前端 SPA，通过用户自己的 GitHub 私库存储数据
            </div>
          </div>
        </div>

        <div className="pt-6 border-t border-slate-200 text-xs text-slate-400 font-mono">
          <div>Build: {buildTime}</div>
          <div>Base: /AcademicFlow/</div>
          <div>License: AGPL-3.0-or-later</div>
        </div>
      </div>
    </div>
  )
}

export default App
