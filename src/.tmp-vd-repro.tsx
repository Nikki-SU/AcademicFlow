/** 临时复现入口：只用来量「编辑区上方工具栏换行后被裁剪 / 插入引用按钮消失」。验证完删除。 */
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import VditorEditor, { type VditorToolbarItem } from './components/VditorEditor'

const CITATION_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>'

const writingToolbar: VditorToolbarItem[] = [
  'headings', 'bold', 'italic', 'strike', '|',
  'list', 'ordered-list', 'check', '|',
  'quote', 'line', 'code', 'inline-code', '|',
  'table', 'upload', '|',
  { name: 'insert-citation', tip: '插入引用', icon: CITATION_ICON, click: () => {} },
  '|', 'undo', 'redo', '|', 'edit-mode', 'fullscreen',
]

function App() {
  const [ratio, setRatio] = useState(30)
  const [boxH, setBoxH] = useState(575)

  return (
    <div className="p-2 bg-slate-200">
      {/* 模拟写作页：固定高度的容器 + overflow-hidden（与 Writing.tsx 根节点一致） */}
      <div className="flex bg-white overflow-hidden" style={{ height: `${boxH}px`, width: `${ratio}%` }}>
        <div className="flex flex-col min-w-0 bg-white flex-1">
          <div className="bg-white border-b px-4 py-2 flex items-center justify-between flex-shrink-0">
            <button id="insert-citation-top" className="text-xs px-2 py-1 bg-indigo-50 rounded">
              引用（应用层按钮）
            </button>
            <span className="text-xs text-slate-400">模拟编辑区</span>
          </div>
          <div className="flex-1 min-h-0 bg-white">
            <VditorEditor value={'# 引言\n\n正文一段。\n\n## 研究背景\n\n背景。\n\n### 方法\n\n方法。'} height="100%" toolbar={writingToolbar} className="h-full" />
          </div>
          <div className="px-4 py-1.5 bg-slate-50 border-t text-xs text-slate-400 flex-shrink-0">页脚</div>
        </div>
      </div>
      <div className="mt-2 flex gap-2 bg-white p-2 border rounded shadow text-xs items-center">
        <span>宽度</span>
        {[30, 50, 70, 100].map((r) => (
          <button key={r} className="px-2 py-1 bg-slate-100 rounded" onClick={() => setRatio(r)}>{r}%</button>
        ))}
        <span className="ml-2">容器高度</span>
        {[240, 320, 450, 575, 700].map((h) => (
          <button key={h} className="px-2 py-1 bg-slate-100 rounded" onClick={() => setBoxH(h)}>{h}</button>
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
