/**
 * 阅读页
 * -------------------------------------------------
 * 参考 Cat 库：深度阅读 + 批注 + 结构化笔记
 * 布局：三栏（文献列表 | PDF阅读 | 笔记/批注）
 */
import { useState } from 'react'
import {
  BookOpen,
  Highlighter,
  MessageSquare,
  StickyNote,
  FileText,
  Search,
} from 'lucide-react'

const DEMO_PAPERS = [
  { id: '1', title: '示例论文 1：钙钛矿太阳能电池综述', author: 'Nature Energy', year: '2024', hasPdf: true },
  { id: '2', title: '示例论文 2：CO2还原电催化剂设计', author: 'JACS', year: '2024', hasPdf: false },
]

export default function ReadingPage() {
  const [selectedPaper, setSelectedPaper] = useState<string | null>(null)
  const [activeSideTab, setActiveSideTab] = useState<'notes' | 'annotations'>('notes')
  const [noteText, setNoteText] = useState('')

  const paper = DEMO_PAPERS.find((p) => p.id === selectedPaper)

  return (
    <div className="h-[calc(100vh-3rem)] flex">
      {/* 左栏：文献列表 */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col">
        <div className="p-3 border-b border-slate-200">
          <h2 className="font-semibold text-slate-800 text-sm flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-indigo-600" />
            文献列表
          </h2>
          <div className="mt-2 relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="搜索..."
              className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded-md focus:outline-none focus:border-indigo-400"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {DEMO_PAPERS.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedPaper(p.id)}
              className={`w-full text-left p-3 border-b border-slate-100 hover:bg-slate-50 transition ${
                selectedPaper === p.id ? 'bg-indigo-50 border-l-2 border-l-indigo-600' : ''
              }`}
            >
              <div className="text-sm font-medium text-slate-700 line-clamp-2">{p.title}</div>
              <div className="text-xs text-slate-500 mt-1 flex items-center gap-2">
                <span>{p.author}</span>
                <span>·</span>
                <span>{p.year}</span>
                {p.hasPdf && <span className="text-green-600">PDF</span>}
              </div>
            </button>
          ))}
        </div>
      </aside>

      {/* 中栏：PDF 阅读区 */}
      <section className="flex-1 bg-slate-100 flex flex-col">
        {paper ? (
          <>
            <div className="bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between">
              <div className="text-sm font-medium text-slate-700 truncate">{paper.title}</div>
              <div className="flex items-center gap-1">
                <button className="p-1.5 text-slate-500 hover:bg-slate-100 rounded" title="高亮">
                  <Highlighter className="w-4 h-4" />
                </button>
                <button className="p-1.5 text-slate-500 hover:bg-slate-100 rounded" title="批注">
                  <MessageSquare className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 flex items-center justify-center">
              {paper.hasPdf ? (
                <div className="text-center text-slate-400">
                  <FileText className="w-16 h-16 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">PDF 阅读器区域</p>
                  <p className="text-xs mt-1">实际使用时嵌入 PDF 渲染</p>
                </div>
              ) : (
                <div className="text-center text-slate-400">
                  <BookOpen className="w-16 h-16 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">暂无 PDF</p>
                  <p className="text-xs mt-1">请先上传或关联 PDF 文件</p>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-400">
            <div className="text-center">
              <BookOpen className="w-16 h-16 mx-auto mb-3 opacity-30" />
              <p className="text-sm">从左侧选择一篇文献开始阅读</p>
            </div>
          </div>
        )}
      </section>

      {/* 右栏：笔记 / 批注 */}
      <aside className="w-72 bg-white border-l border-slate-200 flex flex-col">
        <div className="flex border-b border-slate-200">
          <button
            onClick={() => setActiveSideTab('notes')}
            className={`flex-1 px-3 py-2 text-sm font-medium transition ${
              activeSideTab === 'notes'
                ? 'text-indigo-600 border-b-2 border-indigo-600'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <StickyNote className="w-3.5 h-3.5 inline mr-1" />
            笔记
          </button>
          <button
            onClick={() => setActiveSideTab('annotations')}
            className={`flex-1 px-3 py-2 text-sm font-medium transition ${
              activeSideTab === 'annotations'
                ? 'text-indigo-600 border-b-2 border-indigo-600'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <Highlighter className="w-3.5 h-3.5 inline mr-1" />
            批注
          </button>
        </div>
        <div className="flex-1 p-3 overflow-y-auto">
          {activeSideTab === 'notes' ? (
            <textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder={paper ? '在此记录阅读笔记...' : '选择文献后开始记笔记'}
              disabled={!paper}
              className="w-full h-full p-3 text-sm border border-slate-200 rounded-lg resize-none focus:outline-none focus:border-indigo-400 disabled:bg-slate-50"
            />
          ) : (
            <div className="text-center py-8 text-slate-400 text-sm">
              <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>批注将显示在这里</p>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
