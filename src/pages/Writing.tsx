/**
 * 写作页
 * -------------------------------------------------
 * 参考 PaperAssistant：项目列表 + 阶段导航 + 双栏工作区
 * 整合期刊排版功能
 */
import { useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  PenTool,
  FileText,
  Sparkles,
  ChevronRight,
  Plus,
  BookOpen,
  Send,
} from 'lucide-react'
const STAGES = [
  { value: 'topic', label: '选题' },
  { value: 'review', label: '文献综述' },
  { value: 'writing', label: '正文撰写' },
  { value: 'citation', label: '引用' },
  { value: 'typesetting', label: '排版' },
]

interface Project {
  id: string
  name: string
  stage: string
}

const DEMO_PROJECTS: Project[] = [
  { id: '1', name: '钙钛矿太阳能电池', stage: 'writing' },
  { id: '2', name: 'CO2电催化还原', stage: 'review' },
]

type WorkMode = 'md-editor' | 'latex-preview' | 'ai-chat' | 'compile'

const WORK_MODES: { value: WorkMode; label: string }[] = [
  { value: 'md-editor', label: 'Markdown 编辑器' },
  { value: 'latex-preview', label: 'LaTeX 预览' },
  { value: 'ai-chat', label: 'AI 辅助' },
  { value: 'compile', label: '投稿编译' },
]

export default function WritingPage() {
  const [projects, setProjects] = useState<Project[]>(DEMO_PROJECTS)
  const [activeProjectId, setActiveProjectId] = useState<string | null>('1')
  const [mdContent, setMdContent] = useState(`# 引言\n\n近年来，钙钛矿太阳能电池（PSCs）取得了突破性进展[@doi:10.1038/nature12345]。\n\n## 结果与讨论\n\n我们制备了高效率的钙钛矿薄膜...`)
  const [leftMode, setLeftMode] = useState<WorkMode>('md-editor')
  const [rightMode, setRightMode] = useState<WorkMode>('latex-preview')
  const [isConverting, setIsConverting] = useState(false)

  const activeProject = projects.find((p) => p.id === activeProjectId)

  const handleStageChange = useCallback((stage: string) => {
    if (!activeProjectId) return
    setProjects((prev) =>
      prev.map((p) => (p.id === activeProjectId ? { ...p, stage } : p))
    )
  }, [activeProjectId])

  return (
    <div className="h-[calc(100vh-3rem)] flex">
      {/* 左栏：项目 + 阶段 */}
      <aside className="w-56 bg-white border-r border-slate-200 flex flex-col">
        <div className="p-3 border-b border-slate-200">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-800 text-sm">项目</h2>
            <button
              onClick={() => {
                const name = prompt('项目名称')
                if (name) {
                  setProjects((prev) => [...prev, { id: String(Date.now()), name, stage: 'topic' }])
                }
              }}
              className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => setActiveProjectId(p.id)}
              className={`w-full text-left px-3 py-2.5 border-b border-slate-100 hover:bg-slate-50 transition ${
                activeProjectId === p.id ? 'bg-indigo-50 border-l-2 border-l-indigo-600' : ''
              }`}
            >
              <div className="text-sm font-medium text-slate-700 truncate">{p.name}</div>
              <div className="text-xs text-slate-500 mt-0.5">{STAGES.find((s) => s.value === p.stage)?.label}</div>
            </button>
          ))}
        </div>
        {/* 阶段导航 */}
        <div className="border-t border-slate-200 p-3">
          <div className="text-xs font-medium text-slate-500 mb-2 uppercase tracking-wide">阶段</div>
          <div className="space-y-0.5">
            {STAGES.map((s) => {
              const cur = activeProject?.stage === s.value
              return (
                <button
                  key={s.value}
                  disabled={!activeProject}
                  onClick={() => handleStageChange(s.value)}
                  className={`w-full text-left px-2 py-1.5 rounded text-xs transition ${
                    cur
                      ? 'bg-indigo-50 text-indigo-700 font-medium'
                      : 'text-slate-500 hover:bg-slate-50'
                  }`}
                >
                  <span className="inline-block w-3">{cur ? '●' : '○'}</span>
                  {s.label}
                </button>
              )
            })}
          </div>
        </div>
      </aside>

      {/* 主工作区：双栏 */}
      <section className="flex-1 flex flex-col bg-slate-50">
        {/* 顶栏 */}
        <div className="bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className="text-sm font-medium text-slate-700">
              {activeProject ? activeProject.name : '未选择项目'}
            </span>
            {activeProject && (
              <span className="text-xs px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded-full">
                {STAGES.find((s) => s.value === activeProject.stage)?.label}
              </span>
            )}
          </div>
        </div>

        {/* 双栏工作区 */}
        <div className="flex-1 flex overflow-hidden">
          {/* 左工作区 */}
          <div className="flex-1 flex flex-col border-r border-slate-200">
            <WorkPaneHeader
              side="左"
              mode={leftMode}
              onModeChange={setLeftMode}
            />
            <div className="flex-1 overflow-auto p-4">
              <WorkPaneBody
                mode={leftMode}
                mdContent={mdContent}
                onMdChange={setMdContent}
                isConverting={isConverting}
                setIsConverting={setIsConverting}
              />
            </div>
          </div>

          {/* 右工作区 */}
          <div className="flex-1 flex flex-col">
            <WorkPaneHeader
              side="右"
              mode={rightMode}
              onModeChange={setRightMode}
            />
            <div className="flex-1 overflow-auto p-4">
              <WorkPaneBody
                mode={rightMode}
                mdContent={mdContent}
                onMdChange={setMdContent}
                isConverting={isConverting}
                setIsConverting={setIsConverting}
              />
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

/** 工作区头部 */
function WorkPaneHeader(props: {
  side: string
  mode: WorkMode
  onModeChange: (m: WorkMode) => void
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-white border-b border-slate-200">
      <span className="text-xs text-slate-400 font-medium">{props.side}栏</span>
      <select
        value={props.mode}
        onChange={(e) => props.onModeChange(e.target.value as WorkMode)}
        className="text-xs border border-slate-200 rounded px-2 py-1 focus:outline-none focus:border-indigo-400"
      >
        {WORK_MODES.map((m) => (
          <option key={m.value} value={m.value}>{m.label}</option>
        ))}
      </select>
    </div>
  )
}

/** 工作区内容 */
function WorkPaneBody(props: {
  mode: WorkMode
  mdContent: string
  onMdChange: (s: string) => void
  isConverting: boolean
  setIsConverting: (v: boolean) => void
}) {
  const { mode, mdContent, onMdChange } = props

  if (mode === 'md-editor') {
    return (
      <textarea
        value={mdContent}
        onChange={(e) => onMdChange(e.target.value)}
        className="w-full h-full p-4 font-mono text-sm text-slate-800 bg-white border border-slate-200 rounded-lg resize-none focus:outline-none focus:border-indigo-400"
        spellCheck={false}
        placeholder="在此撰写 Markdown 格式的论文..."
      />
    )
  }

  if (mode === 'latex-preview') {
    return (
      <div className="h-full bg-white border border-slate-200 rounded-lg p-4">
        <div className="text-sm text-slate-500 mb-2">LaTeX 预览（简化版）</div>
        <pre className="text-xs font-mono text-slate-600 whitespace-pre-wrap">
          {mdContent.slice(0, 500)}...
        </pre>
        <div className="mt-4 text-xs text-slate-400">
          完整排版请使用「投稿编译」模式或前往
          <Link to="/journal-format" className="text-indigo-600 hover:underline ml-1">
            期刊排版页面 →
          </Link>
        </div>
      </div>
    )
  }

  if (mode === 'ai-chat') {
    return (
      <div className="h-full flex flex-col bg-white border border-slate-200 rounded-lg">
        <div className="flex-1 p-4 overflow-y-auto">
          <div className="text-sm text-slate-500 text-center py-8">
            <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p>AI 辅助写作</p>
            <p className="text-xs mt-1">输入问题获取 AI 建议</p>
          </div>
        </div>
        <div className="p-3 border-t border-slate-200">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="询问 AI..."
              className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-indigo-400"
            />
            <button className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700 transition">
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (mode === 'compile') {
    return (
      <div className="h-full bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-slate-800 flex items-center gap-2">
          <FileText className="w-5 h-5 text-indigo-600" />
          投稿编译
        </h3>
        <p className="text-sm text-slate-500">
          将当前 Markdown 稿件按目标期刊格式编译为 LaTeX / PDF
        </p>

        <Link
          to="/journal-format"
          className="block p-4 bg-gradient-to-br from-indigo-50 to-purple-50 border border-indigo-200 rounded-xl hover:shadow-md transition"
        >
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-100 rounded-lg">
              <PenTool className="w-5 h-5 text-indigo-600" />
            </div>
            <div className="flex-1">
              <div className="font-medium text-slate-800">AI 期刊排版</div>
              <div className="text-xs text-slate-500 mt-0.5">Markdown → LaTeX → PDF</div>
            </div>
            <ChevronRight className="w-5 h-5 text-indigo-400" />
          </div>
        </Link>

        <Link
          to="/journal-templates"
          className="block p-4 bg-white border border-slate-200 rounded-xl hover:shadow-md hover:border-indigo-200 transition"
        >
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-50 rounded-lg">
              <BookOpen className="w-5 h-5 text-indigo-600" />
            </div>
            <div className="flex-1">
              <div className="font-medium text-slate-800">期刊模板管理</div>
              <div className="text-xs text-slate-500 mt-0.5">管理投稿须知和格式规范</div>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-300" />
          </div>
        </Link>
      </div>
    )
  }

  return null
}
