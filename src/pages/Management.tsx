import { useState, useMemo } from 'react'
import {
  FolderCog,
  BookMarked,
  FileText,
  BookOpen,
  BookCopy,
  ArrowLeftRight,
  Plus,
  Edit3,
  Trash2,
  Eye,
  Upload,
  Download,
  Search,
  ChevronLeft,
  ChevronRight,
  X,
  Loader2,
  CheckCircle2,
  Clock,
  AlertCircle,
  Star,
  Book,
  RefreshCw,
  Database,
} from 'lucide-react'

type SubTabId = 'library' | 'pdf-to-md' | 'templates' | 'knowledge' | 'import-export'

interface Paper {
  id: string
  title: string
  authors: string
  year: string
  journal: string
  keywords: string[]
  doi: string
  tier: 1 | 2
  coverImage?: string
}

interface ConversionTask {
  id: string
  fileName: string
  size: string
  status: 'waiting' | 'converting' | 'done' | 'failed'
  progress: number
}

interface JournalTemplateItem {
  id: string
  name: string
  publisher: string
  lastUpdated: string
  isDefault: boolean
}

interface BookItem {
  id: string
  title: string
  author: string
  publisher: string
  pages: number
  status: 'uploading' | 'converting' | 'done' | 'failed'
  coverImage?: string
  progress: number
}

const subTabs: { id: SubTabId; label: string; icon: typeof BookMarked }[] = [
  { id: 'library', label: '文献库', icon: BookMarked },
  { id: 'pdf-to-md', label: 'PDF转MD', icon: FileText },
  { id: 'templates', label: '期刊模板', icon: BookOpen },
  { id: 'knowledge', label: '知识库', icon: BookCopy },
  { id: 'import-export', label: '导入导出', icon: ArrowLeftRight },
]

const DEMO_PAPERS: Paper[] = [
  { id: '1', title: '钙钛矿太阳能电池研究进展与展望', authors: '李明, 王芳, 张伟', year: '2024', journal: 'Nature Energy', keywords: ['太阳能', '钙钛矿', '光伏'], doi: '10.1038/s41560-024-01432-1', tier: 2, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=solar%20cell%20energy%20research%20cover%20image&image_size=square' },
  { id: '2', title: 'CO2 还原电催化剂的设计策略', authors: '陈晓, 刘洋', year: '2023', journal: 'Journal of the American Chemical Society', keywords: ['催化', 'CO2还原', '电化学'], doi: '10.1021/jacs.3c04567', tier: 1 },
  { id: '3', title: '深度神经网络在药物发现中的应用', authors: '赵磊, 孙娜, 周杰', year: '2024', journal: 'Nature Reviews Drug Discovery', keywords: ['AI', '药物发现', '深度学习'], doi: '10.1038/s41573-024-00892-5', tier: 2, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=drug%20discovery%20neural%20network%20medical%20research&image_size=square' },
  { id: '4', title: '二维材料的量子输运特性研究', authors: '钱伟, 吴强', year: '2023', journal: 'Physical Review Letters', keywords: ['二维材料', '量子输运', '凝聚态物理'], doi: '10.1103/PhysRevLett.130.156402', tier: 1 },
  { id: '5', title: 'CRISPR基因编辑技术的临床转化', authors: '郑华, 冯敏, 陈刚', year: '2024', journal: 'Cell', keywords: ['CRISPR', '基因编辑', '临床'], doi: '10.1016/j.cell.2024.02.015', tier: 2, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=CRISPR%20gene%20editing%20dna%20biotechnology&image_size=square' },
  { id: '6', title: '金属有机框架材料的气体分离应用', authors: '黄磊, 徐丽', year: '2023', journal: 'Science', keywords: ['MOF', '气体分离', '材料化学'], doi: '10.1126/science.adj1234', tier: 1 },
  { id: '7', title: '脑机接口技术的最新进展', authors: '杨帆, 林静, 郭涛', year: '2024', journal: 'Nature Neuroscience', keywords: ['脑机接口', '神经工程', 'BCI'], doi: '10.1038/s41593-024-01678-9', tier: 2, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=brain%20computer%20interface%20neural%20technology&image_size=square' },
  { id: '8', title: '可持续聚合物的合成与降解研究', authors: '何勇, 马丽', year: '2023', journal: 'Angewandte Chemie', keywords: ['可持续', '聚合物', '绿色化学'], doi: '10.1002/anie.202312345', tier: 1 },
  { id: '9', title: '量子计算在化学模拟中的应用', authors: '罗斌, 谢颖, 唐亮', year: '2024', journal: 'Nature Reviews Chemistry', keywords: ['量子计算', '化学模拟', '计算化学'], doi: '10.1038/s41570-024-00567-2', tier: 2, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=quantum%20computing%20chemistry%20simulation%20atoms&image_size=square' },
  { id: '10', title: '单原子催化剂的精准合成', authors: '韩雪, 曹阳', year: '2023', journal: 'Nature Catalysis', keywords: ['单原子', '催化', '合成'], doi: '10.1038/s41929-023-00987-6', tier: 1 },
  { id: '11', title: '类器官模型在癌症研究中的应用', authors: '邓杰, 曾红, 彭飞', year: '2024', journal: 'Cancer Cell', keywords: ['类器官', '癌症', '模型'], doi: '10.1016/j.ccell.2024.01.008', tier: 2, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=organoid%20cancer%20research%20biology%20cells&image_size=square' },
  { id: '12', title: '拓扑绝缘体的自旋电子学特性', authors: '苏明, 卢芳', year: '2023', journal: 'Nature Physics', keywords: ['拓扑绝缘体', '自旋电子学', '凝聚态'], doi: '10.1038/s41567-023-02233-w', tier: 1 },
]

const DEMO_TASKS: ConversionTask[] = [
  { id: '1', fileName: '钙钛矿太阳能电池综述.pdf', size: '4.2 MB', status: 'done', progress: 100 },
  { id: '2', fileName: 'CO2还原电催化剂设计.pdf', size: '2.8 MB', status: 'converting', progress: 65 },
  { id: '3', fileName: '深度神经网络药物发现.pdf', size: '6.1 MB', status: 'waiting', progress: 0 },
  { id: '4', fileName: '二维材料量子输运.pdf', size: '3.5 MB', status: 'failed', progress: 40 },
]

const DEMO_TEMPLATES: JournalTemplateItem[] = [
  { id: '1', name: 'Nature Energy', publisher: 'Nature Portfolio', lastUpdated: '2024-03-15', isDefault: true },
  { id: '2', name: 'JACS', publisher: 'American Chemical Society', lastUpdated: '2024-02-28', isDefault: false },
  { id: '3', name: 'Angewandte Chemie', publisher: 'Wiley-VCH', lastUpdated: '2024-03-10', isDefault: false },
  { id: '4', name: 'Cell', publisher: 'Cell Press', lastUpdated: '2024-01-20', isDefault: false },
]

const DEMO_BOOKS: BookItem[] = [
  { id: '1', title: '深度学习', author: 'Ian Goodfellow', publisher: '人民邮电出版社', pages: 788, status: 'done', progress: 100, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=deep%20learning%20book%20cover%20neural%20network&image_size=portrait_4_3' },
  { id: '2', title: '统计学习方法', author: '李航', publisher: '清华大学出版社', pages: 432, status: 'converting', progress: 72, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=statistical%20learning%20book%20cover%20math%20data%20science&image_size=portrait_4_3' },
  { id: '3', title: '机器学习实战', author: 'Peter Harrington', publisher: '机械工业出版社', pages: 368, status: 'done', progress: 100, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=machine%20learning%20action%20book%20cover%20programming&image_size=portrait_4_3' },
  { id: '4', title: '模式识别与机器学习', author: 'Christopher Bishop', publisher: 'Springer', pages: 738, status: 'uploading', progress: 35, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=pattern%20recognition%20machine%20learning%20book%20cover&image_size=portrait_4_3' },
]

const PAGE_SIZE = 10

function StatusBadge({ status }: { status: ConversionTask['status'] }) {
  const config = {
    waiting: { label: '等待中', icon: Clock, color: 'bg-slate-100 text-slate-600' },
    converting: { label: '转换中', icon: Loader2, color: 'bg-blue-100 text-blue-600' },
    done: { label: '已完成', icon: CheckCircle2, color: 'bg-green-100 text-green-600' },
    failed: { label: '失败', icon: AlertCircle, color: 'bg-red-100 text-red-600' },
  }
  const { label, icon: Icon, color } = config[status]
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${color}`}>
      <Icon className={`w-3.5 h-3.5 ${status === 'converting' ? 'animate-spin' : ''}`} />
      {label}
    </span>
  )
}

function BookStatusBadge({ status }: { status: BookItem['status'] }) {
  const config = {
    uploading: { label: '上传中', color: 'bg-slate-100 text-slate-600' },
    converting: { label: '转换中', color: 'bg-blue-100 text-blue-600' },
    done: { label: '已完成', color: 'bg-green-100 text-green-600' },
    failed: { label: '失败', color: 'bg-red-100 text-red-600' },
  }
  const { label, color } = config[status]
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {label}
    </span>
  )
}

function Modal({ title, onClose, children, width = 'max-w-lg' }: { title: string; onClose: () => void; children: React.ReactNode; width?: string }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className={`bg-white rounded-2xl shadow-xl w-full ${width} max-h-[90vh] overflow-hidden flex flex-col`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <h3 className="font-semibold text-slate-800">{title}</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 py-5 overflow-y-auto flex-1">
          {children}
        </div>
      </div>
    </div>
  )
}

export default function ManagementPage() {
  const [activeTab, setActiveTab] = useState<SubTabId>('library')

  // 文献库状态
  const [tierFilter, setTierFilter] = useState<'all' | 1 | 2>('all')
  const [libraryPage, setLibraryPage] = useState(1)
  const [searchQuery, setSearchQuery] = useState('')
  const [showAddPaperModal, setShowAddPaperModal] = useState(false)
  const [papers, setPapers] = useState<Paper[]>(DEMO_PAPERS)
  const [newPaper, setNewPaper] = useState({ title: '', authors: '', year: '', journal: '', doi: '', keywords: '' })

  // PDF转MD状态
  const [tasks, setTasks] = useState<ConversionTask[]>(DEMO_TASKS)
  const [isDragOver, setIsDragOver] = useState(false)

  // 期刊模板状态
  const [templates, setTemplates] = useState<JournalTemplateItem[]>(DEMO_TEMPLATES)
  const [showTemplateModal, setShowTemplateModal] = useState(false)
  const [newTemplate, setNewTemplate] = useState({ name: '', issn: '', publisher: '', guidelinesUrl: '' })

  // 知识库状态
  const [books] = useState<BookItem[]>(DEMO_BOOKS)

  const filteredPapers = useMemo(() => {
    let result = papers
    if (tierFilter !== 'all') {
      result = result.filter((p) => p.tier === tierFilter)
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.authors.toLowerCase().includes(q) ||
          p.journal.toLowerCase().includes(q),
      )
    }
    return result
  }, [papers, tierFilter, searchQuery])

  const totalPages = Math.ceil(filteredPapers.length / PAGE_SIZE)
  const pagedPapers = filteredPapers.slice((libraryPage - 1) * PAGE_SIZE, libraryPage * PAGE_SIZE)

  const tier1Count = papers.filter((p) => p.tier === 1).length
  const tier2Count = papers.filter((p) => p.tier === 2).length

  const handleAddPaper = () => {
    if (!newPaper.title.trim()) return
    const paper: Paper = {
      id: String(Date.now()),
      title: newPaper.title,
      authors: newPaper.authors,
      year: newPaper.year,
      journal: newPaper.journal,
      doi: newPaper.doi,
      keywords: newPaper.keywords.split(',').map((k) => k.trim()).filter(Boolean),
      tier: 1,
    }
    setPapers([paper, ...papers])
    setNewPaper({ title: '', authors: '', year: '', journal: '', doi: '', keywords: '' })
    setShowAddPaperModal(false)
  }

  const handleDeletePaper = (id: string) => {
    setPapers(papers.filter((p) => p.id !== id))
  }

  const handleAddTemplate = () => {
    if (!newTemplate.name.trim()) return
    const tpl: JournalTemplateItem = {
      id: String(Date.now()),
      name: newTemplate.name,
      publisher: newTemplate.publisher,
      lastUpdated: new Date().toISOString().split('T')[0],
      isDefault: false,
    }
    setTemplates([...templates, tpl])
    setNewTemplate({ name: '', issn: '', publisher: '', guidelinesUrl: '' })
    setShowTemplateModal(false)
  }

  const handleSetDefaultTemplate = (id: string) => {
    setTemplates(templates.map((t) => ({ ...t, isDefault: t.id === id })))
  }

  const handleDeleteTemplate = (id: string) => {
    setTemplates(templates.filter((t) => t.id !== id))
  }

  const handleFileUpload = (files: FileList | null) => {
    if (!files) return
    const newTasks: ConversionTask[] = Array.from(files).map((f, i) => ({
      id: String(Date.now() + i),
      fileName: f.name,
      size: `${(f.size / 1024 / 1024).toFixed(1)} MB`,
      status: 'waiting',
      progress: 0,
    }))
    setTasks([...newTasks, ...tasks])
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <FolderCog className="w-6 h-6 text-indigo-600" />
            管理中心
          </h1>
          <p className="text-sm text-slate-500 mt-1">文献库、格式转换、期刊模板、知识库</p>
        </div>
      </div>

      {/* 子 Tab */}
      <div className="flex items-center gap-1 mb-6 bg-white rounded-xl border border-slate-200 p-1.5 w-fit shadow-sm">
        {subTabs.map((tab) => {
          const Icon = tab.icon
          const active = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition ${
                active
                  ? 'bg-gradient-to-r from-indigo-500 to-indigo-600 text-white shadow-md shadow-indigo-200'
                  : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* ============ 文献库 Tab ============ */}
      {activeTab === 'library' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="搜索标题、作者、期刊..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value)
                    setLibraryPage(1)
                  }}
                  className="pl-9 pr-4 py-2 text-sm border border-slate-200 rounded-lg w-72 focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-white"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button className="flex items-center gap-2 px-3 py-2 text-sm text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition">
                <Database className="w-4 h-4" />
                批量操作
              </button>
              <button
                onClick={() => setShowAddPaperModal(true)}
                className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded-lg transition shadow-md shadow-indigo-200"
              >
                <Plus className="w-4 h-4" />
                手动添加文献
              </button>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="flex items-center gap-1 p-3 border-b border-slate-100 bg-slate-50/50">
              <button
                onClick={() => {
                  setTierFilter('all')
                  setLibraryPage(1)
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition ${
                  tierFilter === 'all'
                    ? 'bg-white text-indigo-600 shadow-sm border border-slate-200'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                全部
                <span className="text-xs px-1.5 py-0.5 bg-slate-200 text-slate-600 rounded-full">
                  {papers.length}
                </span>
              </button>
              <button
                onClick={() => {
                  setTierFilter(1)
                  setLibraryPage(1)
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition ${
                  tierFilter === 1
                    ? 'bg-white text-indigo-600 shadow-sm border border-slate-200'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <span className="text-base">📄</span>
                一级文献
                <span className="text-xs px-1.5 py-0.5 bg-slate-200 text-slate-600 rounded-full">
                  {tier1Count}
                </span>
              </button>
              <button
                onClick={() => {
                  setTierFilter(2)
                  setLibraryPage(1)
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition ${
                  tierFilter === 2
                    ? 'bg-white text-indigo-600 shadow-sm border border-slate-200'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <span className="text-base">📖</span>
                二级文献
                <span className="text-xs px-1.5 py-0.5 bg-slate-200 text-slate-600 rounded-full">
                  {tier2Count}
                </span>
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">题图</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">标题</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">作者</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">年份</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">期刊</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">关键词</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">DOI</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pagedPapers.map((paper) => (
                    <tr key={paper.id} className="hover:bg-slate-50/70 transition">
                      <td className="px-4 py-3">
                        <div className="w-12 h-12 rounded-lg overflow-hidden bg-slate-100 flex-shrink-0">
                          {paper.coverImage ? (
                            <img src={paper.coverImage} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-300">
                              {paper.tier === 2 ? <Book className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm">{paper.tier === 2 ? '📖' : '📄'}</span>
                          <div className="text-sm font-medium text-slate-800 line-clamp-2 max-w-xs">{paper.title}</div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600 max-w-[120px] truncate">{paper.authors}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">{paper.year}</td>
                      <td className="px-4 py-3 text-sm text-slate-600 max-w-[140px] truncate">{paper.journal}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1 max-w-[180px]">
                          {paper.keywords.slice(0, 2).map((kw) => (
                            <span key={kw} className="px-2 py-0.5 bg-indigo-50 text-indigo-600 text-xs rounded-full">
                              {kw}
                            </span>
                          ))}
                          {paper.keywords.length > 2 && (
                            <span className="px-2 py-0.5 bg-slate-100 text-slate-500 text-xs rounded-full">
                              +{paper.keywords.length - 2}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <a
                          href={`https://doi.org/${paper.doi}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-indigo-600 hover:underline max-w-[140px] truncate block"
                        >
                          {paper.doi.slice(0, 20)}...
                        </a>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition" title="阅读">
                            <Eye className="w-4 h-4" />
                          </button>
                          <button className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition" title="编辑">
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDeletePaper(paper.id)}
                            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition"
                            title="删除"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {pagedPapers.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-4 py-16 text-center text-slate-400">
                        暂无文献数据
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {totalPages > 0 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 bg-slate-50/50">
                <div className="text-sm text-slate-500">
                  共 {filteredPapers.length} 条，第 {libraryPage} / {totalPages} 页
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setLibraryPage(Math.max(1, libraryPage - 1))}
                    disabled={libraryPage === 1}
                    className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      onClick={() => setLibraryPage(p)}
                      className={`w-8 h-8 text-sm rounded-md transition ${
                        libraryPage === p
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                  <button
                    onClick={() => setLibraryPage(Math.min(totalPages, libraryPage + 1))}
                    disabled={libraryPage === totalPages}
                    className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ============ PDF转MD Tab ============ */}
      {activeTab === 'pdf-to-md' && (
        <div className="space-y-5">
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setIsDragOver(true)
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setIsDragOver(false)
              handleFileUpload(e.dataTransfer.files)
            }}
            className={`border-2 border-dashed rounded-xl p-10 text-center transition ${
              isDragOver
                ? 'border-indigo-400 bg-indigo-50/50'
                : 'border-slate-200 bg-white hover:border-indigo-200 hover:bg-indigo-50/30'
            }`}
          >
            <Upload className={`w-12 h-12 mx-auto mb-4 ${isDragOver ? 'text-indigo-500' : 'text-slate-300'}`} />
            <p className="text-sm font-medium text-slate-700 mb-1">拖拽 PDF 到此处，或点击上传</p>
            <p className="text-xs text-slate-400 mb-4">PDF 入库后自动转换为 Markdown（带图片）</p>
            <label className="inline-flex items-center gap-2 px-4 py-2 text-sm text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded-lg cursor-pointer transition shadow-md shadow-indigo-200">
              <Upload className="w-4 h-4" />
              上传 PDF
              <input
                type="file"
                accept=".pdf"
                multiple
                className="hidden"
                onChange={(e) => handleFileUpload(e.target.files)}
              />
            </label>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/50">
              <h3 className="font-medium text-slate-800 text-sm">转换队列</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50/70">
                  <tr>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">文件名</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">大小</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">状态</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider w-48">进度</th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {tasks.map((task) => (
                    <tr key={task.id} className="hover:bg-slate-50/50 transition">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-slate-400" />
                          <span className="text-sm text-slate-700 font-medium">{task.fileName}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-500">{task.size}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={task.status} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${
                                task.status === 'failed' ? 'bg-red-400' : 'bg-indigo-500'
                              }`}
                              style={{ width: `${task.progress}%` }}
                            />
                          </div>
                          <span className="text-xs text-slate-500 w-10 text-right">{task.progress}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {task.status === 'done' && (
                            <>
                              <button className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition" title="查看 Markdown">
                                <Eye className="w-4 h-4" />
                              </button>
                              <button className="p-1.5 text-slate-400 hover:text-green-600 hover:bg-green-50 rounded-md transition" title="下载 Markdown">
                                <Download className="w-4 h-4" />
                              </button>
                            </>
                          )}
                          {task.status === 'failed' && (
                            <button className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition" title="重试">
                              <RefreshCw className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            onClick={() => setTasks(tasks.filter((t) => t.id !== task.id))}
                            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition"
                            title="删除"
                          >
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

      {/* ============ 期刊模板 Tab ============ */}
      {activeTab === 'templates' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-500">管理期刊投稿模板，支持 AI 提取格式规范</p>
            <button
              onClick={() => setShowTemplateModal(true)}
              className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded-lg transition shadow-md shadow-indigo-200"
            >
              <Plus className="w-4 h-4" />
              新建模板
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {templates.map((tpl) => (
              <div
                key={tpl.id}
                className={`bg-white rounded-xl border shadow-sm hover:shadow-md transition overflow-hidden ${
                  tpl.isDefault ? 'border-indigo-300 ring-1 ring-indigo-100' : 'border-slate-200'
                }`}
              >
                <div className="p-5">
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="p-2 bg-indigo-50 rounded-lg">
                      <BookOpen className="w-6 h-6 text-indigo-600" />
                    </div>
                    {tpl.isDefault && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 text-amber-600 text-xs font-medium rounded-full">
                        <Star className="w-3 h-3 fill-current" />
                        默认
                      </span>
                    )}
                  </div>
                  <h3 className="font-semibold text-slate-800 mb-1">{tpl.name}</h3>
                  <p className="text-sm text-slate-500 mb-1">{tpl.publisher}</p>
                  <p className="text-xs text-slate-400">最后更新：{tpl.lastUpdated}</p>
                </div>
                <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <button className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition" title="编辑">
                      <Edit3 className="w-4 h-4" />
                    </button>
                    {!tpl.isDefault && (
                      <button
                        onClick={() => handleSetDefaultTemplate(tpl.id)}
                        className="p-1.5 text-slate-400 hover:text-amber-500 hover:bg-amber-50 rounded-md transition"
                        title="设为默认"
                      >
                        <Star className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => handleDeleteTemplate(tpl.id)}
                      className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition"
                      title="删除"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <button className="text-xs text-indigo-600 hover:text-indigo-700 font-medium">
                    查看详情 →
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============ 知识库 Tab ============ */}
      {activeTab === 'knowledge' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-slate-500">
                知识库存储图书，PDF 上传后自动导入 MinerU 转换为 Markdown，保存到 GitHub 私有仓库
              </p>
            </div>
            <button className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded-lg transition shadow-md shadow-indigo-200">
              <Upload className="w-4 h-4" />
              上传图书
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {books.map((book) => (
              <div
                key={book.id}
                className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition overflow-hidden group"
              >
                <div className="aspect-[3/4] bg-slate-100 relative overflow-hidden">
                  {book.coverImage ? (
                    <img src={book.coverImage} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-slate-300">
                      <Book className="w-12 h-12" />
                    </div>
                  )}
                  <div className="absolute top-2 right-2">
                    <BookStatusBadge status={book.status} />
                  </div>
                  {(book.status === 'converting' || book.status === 'uploading') && (
                    <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-black/50 backdrop-blur-sm">
                      <div className="h-1 bg-white/30 rounded-full overflow-hidden mb-1">
                        <div
                          className="h-full bg-white rounded-full transition-all"
                          style={{ width: `${book.progress}%` }}
                        />
                      </div>
                      <p className="text-xs text-white text-right">{book.progress}%</p>
                    </div>
                  )}
                </div>
                <div className="p-3">
                  <h3 className="font-medium text-slate-800 text-sm line-clamp-1 mb-0.5">{book.title}</h3>
                  <p className="text-xs text-slate-500 line-clamp-1 mb-1">{book.author}</p>
                  <p className="text-xs text-slate-400 line-clamp-1">{book.publisher} · {book.pages} 页</p>
                </div>
                <div className="px-3 py-2 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <button className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition" title="阅读">
                      <Eye className="w-4 h-4" />
                    </button>
                    {(book.status === 'converting' || book.status === 'uploading') && (
                      <button className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition" title="转换进度">
                        <Loader2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  <button className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition" title="删除">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============ 导入导出 Tab ============ */}
      {activeTab === 'import-export' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50">
                <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                  <Upload className="w-5 h-5 text-indigo-600" />
                  导入文献
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">从外部文件导入文献到文献库</p>
              </div>
              <div className="p-5 space-y-3">
                {[
                  { name: 'CSV 导入', desc: '从 CSV 表格导入文献元数据', ext: '.csv' },
                  { name: 'JSON 导入', desc: '从 JSON 文件导入结构化数据', ext: '.json' },
                  { name: 'EndNote 导入', desc: '导入 EndNote 文献库 (.enw)', ext: '.enw' },
                  { name: 'Zotero 导入', desc: '从 Zotero 导出的 JSON/CSV 导入', ext: '.json,.csv' },
                ].map((item) => (
                  <label
                    key={item.name}
                    className="flex items-center gap-3 p-3 border border-slate-200 rounded-lg hover:border-indigo-200 hover:bg-indigo-50/30 cursor-pointer transition"
                  >
                    <div className="p-2 bg-slate-100 rounded-lg">
                      <Database className="w-5 h-5 text-slate-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-700">{item.name}</div>
                      <div className="text-xs text-slate-500">{item.desc}</div>
                    </div>
                    <input type="file" accept={item.ext} className="hidden" />
                    <span className="text-xs text-indigo-600 font-medium shrink-0">选择文件</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50">
                <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                  <Download className="w-5 h-5 text-indigo-600" />
                  导出文献
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">将文献库导出为各种格式</p>
              </div>
              <div className="p-5 space-y-3">
                {[
                  { name: '导出 CSV', desc: '导出为 CSV 表格格式' },
                  { name: '导出 Markdown', desc: '导出为 Markdown 文献列表' },
                  { name: '导出 BibTeX', desc: '导出为 BibTeX 引用格式' },
                ].map((item) => (
                  <button
                    key={item.name}
                    className="w-full flex items-center gap-3 p-3 border border-slate-200 rounded-lg hover:border-indigo-200 hover:bg-indigo-50/30 transition text-left"
                  >
                    <div className="p-2 bg-slate-100 rounded-lg">
                      <FileText className="w-5 h-5 text-slate-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-700">{item.name}</div>
                      <div className="text-xs text-slate-500">{item.desc}</div>
                    </div>
                    <Download className="w-4 h-4 text-indigo-500 shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                <RefreshCw className="w-5 h-5 text-indigo-600" />
                数据同步
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">与 GitHub 私有仓库同步文献和知识库数据</p>
            </div>
            <div className="p-5">
              <div className="flex items-center gap-4 p-4 bg-indigo-50/50 border border-indigo-100 rounded-xl">
                <div className="p-3 bg-indigo-100 rounded-xl">
                  <BookCopy className="w-6 h-6 text-indigo-600" />
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium text-slate-700">GitHub 私有仓库同步</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    将文献库 Markdown 和知识库图书同步到 GitHub 私有仓库，实现版本管理和备份
                  </div>
                </div>
                <button className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded-lg transition shadow-md shadow-indigo-200">
                  <RefreshCw className="w-4 h-4" />
                  立即同步
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 添加文献弹窗 */}
      {showAddPaperModal && (
        <Modal title="手动添加文献" onClose={() => setShowAddPaperModal(false)}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">标题 *</label>
              <input
                type="text"
                value={newPaper.title}
                onChange={(e) => setNewPaper({ ...newPaper, title: e.target.value })}
                placeholder="请输入文献标题"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">作者</label>
              <input
                type="text"
                value={newPaper.authors}
                onChange={(e) => setNewPaper({ ...newPaper, authors: e.target.value })}
                placeholder="多个作者用逗号分隔"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">年份</label>
                <input
                  type="text"
                  value={newPaper.year}
                  onChange={(e) => setNewPaper({ ...newPaper, year: e.target.value })}
                  placeholder="2024"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">期刊</label>
                <input
                  type="text"
                  value={newPaper.journal}
                  onChange={(e) => setNewPaper({ ...newPaper, journal: e.target.value })}
                  placeholder="期刊名称"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">DOI</label>
              <input
                type="text"
                value={newPaper.doi}
                onChange={(e) => setNewPaper({ ...newPaper, doi: e.target.value })}
                placeholder="10.1038/..."
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">关键词</label>
              <input
                type="text"
                value={newPaper.keywords}
                onChange={(e) => setNewPaper({ ...newPaper, keywords: e.target.value })}
                placeholder="多个关键词用逗号分隔"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">上传 PDF</label>
              <div className="border-2 border-dashed border-slate-200 rounded-lg p-6 text-center hover:border-indigo-300 transition cursor-pointer">
                <Upload className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                <p className="text-sm text-slate-500">点击或拖拽 PDF 到此处</p>
                <input type="file" accept=".pdf" className="hidden" />
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-slate-100">
            <button
              onClick={() => setShowAddPaperModal(false)}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
            >
              取消
            </button>
            <button
              onClick={handleAddPaper}
              className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded-lg transition"
            >
              <Plus className="w-4 h-4" />
              添加
            </button>
          </div>
        </Modal>
      )}

      {/* 新建模板弹窗 */}
      {showTemplateModal && (
        <Modal title="新建期刊模板" onClose={() => setShowTemplateModal(false)}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">期刊名 *</label>
              <input
                type="text"
                value={newTemplate.name}
                onChange={(e) => setNewTemplate({ ...newTemplate, name: e.target.value })}
                placeholder="如：Nature Energy"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">ISSN</label>
              <input
                type="text"
                value={newTemplate.issn}
                onChange={(e) => setNewTemplate({ ...newTemplate, issn: e.target.value })}
                placeholder="如：2058-7546"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">出版社</label>
              <input
                type="text"
                value={newTemplate.publisher}
                onChange={(e) => setNewTemplate({ ...newTemplate, publisher: e.target.value })}
                placeholder="如：Nature Portfolio"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">投稿须知 URL</label>
              <input
                type="url"
                value={newTemplate.guidelinesUrl}
                onChange={(e) => setNewTemplate({ ...newTemplate, guidelinesUrl: e.target.value })}
                placeholder="https://..."
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">上传投稿须知 PDF</label>
              <div className="border-2 border-dashed border-slate-200 rounded-lg p-6 text-center hover:border-indigo-300 transition cursor-pointer">
                <Upload className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                <p className="text-sm text-slate-500">点击或拖拽 PDF 到此处</p>
                <input type="file" accept=".pdf" className="hidden" />
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-slate-100">
            <button
              onClick={() => setShowTemplateModal(false)}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
            >
              取消
            </button>
            <button
              onClick={handleAddTemplate}
              className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded-lg transition"
            >
              <Plus className="w-4 h-4" />
              创建模板
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
