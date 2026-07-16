/**
 * 管理页
 * -------------------------------------------------
 * 参考 Cat 库：文献库管理 + 工具入口
 * 子 Tab：文献库 / PDF转MD / 期刊模板
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  FolderCog,
  BookMarked,
  Filter,
  Search,
  FileText,
  Upload,
  BookOpen,
  ChevronRight,
  Trash2,
  Edit3,
} from 'lucide-react'

const subTabs = [
  { id: 'library', label: '文献库', icon: BookMarked },
  { id: 'pdf-to-md', label: 'PDF 转 MD', icon: FileText },
  { id: 'templates', label: '期刊模板', icon: BookOpen },
]

const DEMO_PAPERS = [
  { id: '1', doi: '10.1038/s41560-024-01432-1', title: '钙钛矿太阳能电池综述', authors: 'Smith et al.', year: '2024', journal: 'Nature Energy', tags: ['solar', 'perovskite'], tier: 2, has_graphical_abstract: true },
  { id: '2', doi: '10.1021/jacs.3c04567', title: 'CO2 还原电催化剂设计', authors: 'Zhang et al.', year: '2023', journal: 'JACS', tags: ['catalysis', 'CO2'], tier: 1, has_graphical_abstract: false },
]

export default function ManagementPage() {
  const [activeTab, setActiveTab] = useState('library')

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <FolderCog className="w-6 h-6 text-indigo-600" />
            管理
          </h1>
          <p className="text-sm text-slate-500 mt-1">文献库、格式转换、期刊模板</p>
        </div>
      </div>

      {/* 子 Tab */}
      <div className="flex items-center gap-1 mb-6 bg-white rounded-lg border border-slate-200 p-1 w-fit">
        {subTabs.map((tab) => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition ${
                activeTab === tab.id
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* 文献库（spec §5.2） */}
      {activeTab === 'library' && (
        <div className="space-y-4">
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
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex items-center gap-2 text-sm">
              <span className="text-slate-500">全部</span>
              <span className="text-slate-300">|</span>
              <span className="text-slate-500">一级（无PDF）</span>
              <span className="text-slate-300">|</span>
              <span className="text-slate-500">二级（有PDF）</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">类型</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">标题</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">期刊</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">关键词</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">DOI 链接</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {DEMO_PAPERS.map((paper) => (
                    <tr key={paper.id} className="hover:bg-slate-50 transition">
                      <td className="px-4 py-4">
                        <span className={paper.tier === 2 ? 'text-green-600' : 'text-slate-400'}>
                          {paper.tier === 2 ? '📖' : '📄'}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <div className="text-sm font-medium text-slate-800">{paper.title}</div>
                        <div className="text-xs text-slate-500 mt-0.5">{paper.authors} · {paper.year}</div>
                      </td>
                      <td className="px-4 py-4">
                        <span className="text-xs text-slate-600">{paper.journal}</span>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex flex-wrap gap-1">
                          {paper.tags.map((tag) => (
                            <span key={tag} className="px-2 py-0.5 bg-slate-100 text-slate-600 text-xs rounded-full">
                              {tag}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <a
                          href={`https://doi.org/${paper.doi}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-indigo-600 hover:underline"
                        >
                          doi.org/{paper.doi.slice(0, 15)}...
                        </a>
                      </td>
                      <td className="px-4 py-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition">
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* PDF 转 MD */}
      {activeTab === 'pdf-to-md' && (
        <div className="max-w-2xl">
          <div className="bg-white rounded-xl border border-slate-200 p-8">
            <div className="border-2 border-dashed border-slate-300 rounded-xl p-12 text-center hover:border-indigo-300 transition">
              <Upload className="w-12 h-12 mx-auto mb-4 text-slate-300" />
              <p className="text-sm font-medium text-slate-600 mb-1">拖拽 PDF 到此处，或点击上传</p>
              <p className="text-xs text-slate-400">支持 ≤200 页，超出自动拆分</p>
            </div>
            <div className="mt-6 p-3 bg-amber-50 rounded-lg text-sm text-amber-700">
              需要在设置中配置 MinerU API Key 才能使用此功能
            </div>
          </div>
        </div>
      )}

      {/* 期刊模板 */}
      {activeTab === 'templates' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
        </div>
      )}
    </div>
  )
}
