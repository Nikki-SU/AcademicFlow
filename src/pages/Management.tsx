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
  Image as ImageIcon,
  Link as LinkIcon,
  StickyNote,
  FileSpreadsheet,
  FileJson,
  BookText,
  Github,
  Layers,
  Sparkles,
  ExternalLink,
  CheckSquare,
  ChevronDown,
  Folder,
  LayoutGrid,
  List,
  MoveRight,
  Tag,
  Library,
} from 'lucide-react'

type SubTabId = 'library' | 'templates' | 'knowledge' | 'import-export'

interface PaperCategory {
  id: string
  name: string
  children?: PaperCategory[]
}

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
  hasNotes: boolean
  mdStatus: 'none' | 'converting' | 'done' | 'failed'
  mdProgress: number
  categoryIds: string[]
}

interface JournalTemplateItem {
  id: string
  name: string
  publisher: string
  issn: string
  lastUpdated: string
  isDefault: boolean
  formatSummary: string
}

interface BookCategory {
  id: string
  name: string
}

interface BookVolume {
  id: string
  volume: number
  pageRange: string
  status: 'converting' | 'done' | 'failed'
  progress: number
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
  volumes?: BookVolume[]
  isSplit: boolean
  categoryIds: string[]
}

const subTabs: { id: SubTabId; label: string; icon: typeof BookMarked }[] = [
  { id: 'library', label: '文献库', icon: BookMarked },
  { id: 'templates', label: '期刊模板', icon: BookOpen },
  { id: 'knowledge', label: '知识库', icon: BookCopy },
  { id: 'import-export', label: '导入导出', icon: ArrowLeftRight },
]

const DEMO_PAPER_CATEGORIES: PaperCategory[] = [
  { id: 'all', name: '全部文献' },
  {
    id: 'my-categories',
    name: '我的分类',
    children: [
      { id: 'perovskite', name: '钙钛矿太阳能电池' },
      { id: 'co2', name: 'CO2 电催化还原' },
      { id: 'battery', name: '锂电池' },
      { id: 'nano', name: '纳米材料' },
    ],
  },
]

const DEMO_BOOK_CATEGORIES: BookCategory[] = [
  { id: 'all', name: '全部图书' },
  { id: 'phys-chem', name: '物理化学' },
  { id: 'material', name: '材料科学' },
  { id: 'electrochem', name: '电化学' },
  { id: 'semiconductor', name: '半导体物理' },
]

const DEMO_PAPERS: Paper[] = [
  { id: '1', title: '钙钛矿太阳能电池研究进展与展望', authors: '李明, 王芳, 张伟', year: '2024', journal: 'Nature Energy', keywords: ['太阳能', '钙钛矿', '光伏'], doi: '10.1038/s41560-024-01432-1', tier: 2, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=solar%20cell%20energy%20research%20cover%20image&image_size=square', hasNotes: true, mdStatus: 'done', mdProgress: 100, categoryIds: ['perovskite'] },
  { id: '2', title: 'CO2 还原电催化剂的设计策略', authors: '陈晓, 刘洋', year: '2023', journal: 'Journal of the American Chemical Society', keywords: ['催化', 'CO2还原', '电化学'], doi: '10.1021/jacs.3c04567', tier: 1, hasNotes: false, mdStatus: 'converting', mdProgress: 65, categoryIds: ['co2', 'electrochem'] },
  { id: '3', title: '深度神经网络在药物发现中的应用', authors: '赵磊, 孙娜, 周杰', year: '2024', journal: 'Nature Reviews Drug Discovery', keywords: ['AI', '药物发现', '深度学习'], doi: '10.1038/s41573-024-00892-5', tier: 2, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=drug%20discovery%20neural%20network%20medical%20research&image_size=square', hasNotes: true, mdStatus: 'done', mdProgress: 100, categoryIds: [] },
  { id: '4', title: '二维材料的量子输运特性研究', authors: '钱伟, 吴强', year: '2023', journal: 'Physical Review Letters', keywords: ['二维材料', '量子输运', '凝聚态物理'], doi: '10.1103/PhysRevLett.130.156402', tier: 1, hasNotes: false, mdStatus: 'none', mdProgress: 0, categoryIds: ['nano', 'semiconductor'] },
  { id: '5', title: 'CRISPR基因编辑技术的临床转化', authors: '郑华, 冯敏, 陈刚', year: '2024', journal: 'Cell', keywords: ['CRISPR', '基因编辑', '临床'], doi: '10.1016/j.cell.2024.02.015', tier: 2, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=CRISPR%20gene%20editing%20dna%20biotechnology&image_size=square', hasNotes: true, mdStatus: 'done', mdProgress: 100, categoryIds: [] },
  { id: '6', title: '金属有机框架材料的气体分离应用', authors: '黄磊, 徐丽', year: '2023', journal: 'Science', keywords: ['MOF', '气体分离', '材料化学'], doi: '10.1126/science.adj1234', tier: 1, hasNotes: false, mdStatus: 'failed', mdProgress: 40, categoryIds: ['material'] },
  { id: '7', title: '脑机接口技术的最新进展', authors: '杨帆, 林静, 郭涛', year: '2024', journal: 'Nature Neuroscience', keywords: ['脑机接口', '神经工程', 'BCI'], doi: '10.1038/s41593-024-01678-9', tier: 2, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=brain%20computer%20interface%20neural%20technology&image_size=square', hasNotes: false, mdStatus: 'converting', mdProgress: 30, categoryIds: [] },
  { id: '8', title: '可持续聚合物的合成与降解研究', authors: '何勇, 马丽', year: '2023', journal: 'Angewandte Chemie', keywords: ['可持续', '聚合物', '绿色化学'], doi: '10.1002/anie.202312345', tier: 1, hasNotes: true, mdStatus: 'done', mdProgress: 100, categoryIds: ['material'] },
  { id: '9', title: '量子计算在化学模拟中的应用', authors: '罗斌, 谢颖, 唐亮', year: '2024', journal: 'Nature Reviews Chemistry', keywords: ['量子计算', '化学模拟', '计算化学'], doi: '10.1038/s41570-024-00567-2', tier: 2, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=quantum%20computing%20chemistry%20simulation%20atoms&image_size=square', hasNotes: false, mdStatus: 'none', mdProgress: 0, categoryIds: ['phys-chem'] },
  { id: '10', title: '单原子催化剂的精准合成', authors: '韩雪, 曹阳', year: '2023', journal: 'Nature Catalysis', keywords: ['单原子', '催化', '合成'], doi: '10.1038/s41929-023-00987-6', tier: 1, hasNotes: true, mdStatus: 'done', mdProgress: 100, categoryIds: ['co2', 'electrochem'] },
  { id: '11', title: '类器官模型在癌症研究中的应用', authors: '邓杰, 曾红, 彭飞', year: '2024', journal: 'Cancer Cell', keywords: ['类器官', '癌症', '模型'], doi: '10.1016/j.ccell.2024.01.008', tier: 2, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=organoid%20cancer%20research%20biology%20cells&image_size=square', hasNotes: false, mdStatus: 'none', mdProgress: 0, categoryIds: [] },
  { id: '12', title: '拓扑绝缘体的自旋电子学特性', authors: '苏明, 卢芳', year: '2023', journal: 'Nature Physics', keywords: ['拓扑绝缘体', '自旋电子学', '凝聚态'], doi: '10.1038/s41567-023-02233-w', tier: 1, hasNotes: true, mdStatus: 'done', mdProgress: 100, categoryIds: ['semiconductor', 'nano'] },
]

const DEMO_TEMPLATES: JournalTemplateItem[] = [
  { id: '1', name: 'Nature Energy', publisher: 'Nature Portfolio', issn: '2058-7546', lastUpdated: '2024-03-15', isDefault: true, formatSummary: '摘要250字以内，正文含Introduction/Results/Discussion/Methods四部分，参考文献采用Nature格式，图表嵌入正文对应位置。' },
  { id: '2', name: 'JACS', publisher: 'American Chemical Society', issn: '0002-7863', lastUpdated: '2024-02-28', isDefault: false, formatSummary: '通讯类限于3页，全文含Abstract/Introduction/Results/Conclusion，参考文献ACS格式，支持Supporting Information。' },
  { id: '3', name: 'Angewandte Chemie', publisher: 'Wiley-VCH', issn: '1433-7851', lastUpdated: '2024-03-10', isDefault: false, formatSummary: '通讯类限4页，全文有严格字数限制，参考文献Wiley格式，图表标题需详细说明实验条件。' },
  { id: '4', name: 'Cell', publisher: 'Cell Press', issn: '0092-8674', lastUpdated: '2024-01-20', isDefault: false, formatSummary: '长文格式，摘要结构化（Background/Results/Conclusions），正文多小节，参考文献Cell格式，需附Author Contributions。' },
]

const DEMO_BOOKS: BookItem[] = [
  { id: '1', title: '深度学习', author: 'Ian Goodfellow', publisher: '人民邮电出版社', pages: 788, status: 'done', progress: 100, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=deep%20learning%20book%20cover%20neural%20network&image_size=portrait_4_3', isSplit: true, categoryIds: ['material'], volumes: [
    { id: 'v1', volume: 1, pageRange: '第1-180页', status: 'done', progress: 100 },
    { id: 'v2', volume: 2, pageRange: '第181-360页', status: 'done', progress: 100 },
    { id: 'v3', volume: 3, pageRange: '第361-540页', status: 'done', progress: 100 },
    { id: 'v4', volume: 4, pageRange: '第541-720页', status: 'done', progress: 100 },
    { id: 'v5', volume: 5, pageRange: '第721-788页', status: 'done', progress: 100 },
  ]},
  { id: '2', title: '统计学习方法', author: '李航', publisher: '清华大学出版社', pages: 432, status: 'converting', progress: 72, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=statistical%20learning%20book%20cover%20math%20data%20science&image_size=portrait_4_3', isSplit: true, categoryIds: ['phys-chem'], volumes: [
    { id: 'v1', volume: 1, pageRange: '第1-180页', status: 'done', progress: 100 },
    { id: 'v2', volume: 2, pageRange: '第181-360页', status: 'converting', progress: 72 },
    { id: 'v3', volume: 3, pageRange: '第361-432页', status: 'converting', progress: 15 },
  ]},
  { id: '3', title: '机器学习实战', author: 'Peter Harrington', publisher: '机械工业出版社', pages: 368, status: 'done', progress: 100, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=machine%20learning%20action%20book%20cover%20programming&image_size=portrait_4_3', isSplit: true, categoryIds: ['material'], volumes: [
    { id: 'v1', volume: 1, pageRange: '第1-180页', status: 'done', progress: 100 },
    { id: 'v2', volume: 2, pageRange: '第181-368页', status: 'done', progress: 100 },
  ]},
  { id: '4', title: '模式识别与机器学习', author: 'Christopher Bishop', publisher: 'Springer', pages: 738, status: 'converting', progress: 45, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=pattern%20recognition%20machine%20learning%20book%20cover&image_size=portrait_4_3', isSplit: true, categoryIds: ['phys-chem', 'semiconductor'], volumes: [
    { id: 'v1', volume: 1, pageRange: '第1-180页', status: 'done', progress: 100 },
    { id: 'v2', volume: 2, pageRange: '第181-360页', status: 'done', progress: 100 },
    { id: 'v3', volume: 3, pageRange: '第361-540页', status: 'converting', progress: 85 },
    { id: 'v4', volume: 4, pageRange: '第541-720页', status: 'converting', progress: 35 },
    { id: 'v5', volume: 5, pageRange: '第721-738页', status: 'converting', progress: 10 },
  ]},
  { id: '5', title: 'Python数据分析', author: 'Wes McKinney', publisher: '机械工业出版社', pages: 560, status: 'uploading', progress: 35, isSplit: false, categoryIds: [] },
  { id: '6', title: '算法导论', author: 'Thomas H. Cormen', publisher: 'MIT Press', pages: 1292, status: 'failed', progress: 20, coverImage: 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=algorithms%20book%20cover%20computer%20science&image_size=portrait_4_3', isSplit: true, categoryIds: ['semiconductor'], volumes: [
    { id: 'v1', volume: 1, pageRange: '第1-180页', status: 'failed', progress: 20 },
  ]},
]

const PAGE_SIZE = 10

function StatusBadge({ status }: { status: Paper['mdStatus'] }) {
  const config = {
    none: { label: '未转换', icon: Clock, color: 'bg-slate-100 text-slate-500' },
    converting: { label: '转换中', icon: Loader2, color: 'bg-blue-100 text-blue-600' },
    done: { label: '已完成', icon: CheckCircle2, color: 'bg-green-100 text-green-600' },
    failed: { label: '失败', icon: AlertCircle, color: 'bg-red-100 text-red-600' },
  }
  const { label, icon: Icon, color } = config[status]
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>
      <Icon className={`w-3 h-3 ${status === 'converting' ? 'animate-spin' : ''}`} />
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

function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60] p-8" onClick={onClose}>
      <img src={src} alt="" className="max-w-full max-h-full object-contain rounded-lg" onClick={(e) => e.stopPropagation()} />
      <button onClick={onClose} className="absolute top-4 right-4 p-2 text-white/70 hover:text-white hover:bg-white/10 rounded-lg transition">
        <X className="w-6 h-6" />
      </button>
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
  const [showEditPaperModal, setShowEditPaperModal] = useState(false)
  const [showImageLightbox, setShowImageLightbox] = useState<string | null>(null)
  const [editingPaper, setEditingPaper] = useState<Paper | null>(null)
  const [papers, setPapers] = useState<Paper[]>(DEMO_PAPERS)
  const [newPaper, setNewPaper] = useState({ title: '', authors: '', year: '', journal: '', doi: '', keywords: '', tier: '1' as '1' | '2', categoryIds: [] as string[] })
  const [selectedPapers, setSelectedPapers] = useState<Set<string>>(new Set())
  const [batchMode, setBatchMode] = useState(false)
  const [viewMode, setViewMode] = useState<'table' | 'card'>('table')
  const [paperCategories, setPaperCategories] = useState<PaperCategory[]>(DEMO_PAPER_CATEGORIES)
  const [activePaperCategory, setActivePaperCategory] = useState<string>('all')
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(['my-categories']))
  const [showBatchMoveModal, setShowBatchMoveModal] = useState(false)
  const [batchMoveTargetIds, setBatchMoveTargetIds] = useState<string[]>([])
  const [editingCategory, setEditingCategory] = useState<{ id?: string; name: string; parentId?: string } | null>(null)
  const [showCategoryModal, setShowCategoryModal] = useState(false)

  // 期刊模板状态
  const [templates, setTemplates] = useState<JournalTemplateItem[]>(DEMO_TEMPLATES)
  const [showTemplateModal, setShowTemplateModal] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<JournalTemplateItem | null>(null)
  const [newTemplate, setNewTemplate] = useState({ name: '', issn: '', publisher: '', guidelines: '' })
  const [isExtracting, setIsExtracting] = useState(false)

  // 知识库状态
  const [books, setBooks] = useState<BookItem[]>(DEMO_BOOKS)
  const [showBookDetail, setShowBookDetail] = useState<BookItem | null>(null)
  const [isDragOverBook, setIsDragOverBook] = useState(false)
  const [bookCategories, setBookCategories] = useState<BookCategory[]>(DEMO_BOOK_CATEGORIES)
  const [activeBookCategory, setActiveBookCategory] = useState<string>('all')
  const [editingBookCategory, setEditingBookCategory] = useState<{ id?: string; name: string } | null>(null)
  const [showBookCategoryModal, setShowBookCategoryModal] = useState(false)
  const [showUploadBookModal, setShowUploadBookModal] = useState(false)
  const [uploadBookCategories, setUploadBookCategories] = useState<string[]>([])

  // 文献分类树 - 展开关闭
  const toggleCategoryExpand = (id: string) => {
    const next = new Set(expandedCategories)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setExpandedCategories(next)
  }

  // 获取所有叶子分类（用于文献数量统计）
  const getAllLeafCategories = useMemo(() => {
    const leaves: { id: string; name: string }[] = []
    const traverse = (cats: PaperCategory[]) => {
      for (const cat of cats) {
        if (cat.children && cat.children.length > 0) {
          traverse(cat.children)
        } else if (cat.id !== 'all') {
          leaves.push({ id: cat.id, name: cat.name })
        }
      }
    }
    traverse(paperCategories)
    return leaves
  }, [paperCategories])

  // 统计各分类文献数量
  const paperCategoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: papers.length }
    for (const paper of papers) {
      for (const cid of paper.categoryIds) {
        counts[cid] = (counts[cid] || 0) + 1
      }
    }
    return counts
  }, [papers])

  // 筛选文献
  const filteredPapers = useMemo(() => {
    let result = papers
    if (activePaperCategory !== 'all') {
      result = result.filter((p) => p.categoryIds.includes(activePaperCategory))
    }
    if (tierFilter !== 'all') {
      result = result.filter((p) => p.tier === tierFilter)
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.authors.toLowerCase().includes(q) ||
          p.journal.toLowerCase().includes(q) ||
          p.keywords.some((k) => k.toLowerCase().includes(q)),
      )
    }
    return result
  }, [papers, tierFilter, searchQuery, activePaperCategory])

  const totalPages = Math.ceil(filteredPapers.length / PAGE_SIZE)
  const pagedPapers = filteredPapers.slice((libraryPage - 1) * PAGE_SIZE, libraryPage * PAGE_SIZE)

  // 知识库分类筛选
  const filteredBooks = useMemo(() => {
    if (activeBookCategory === 'all') return books
    return books.filter((b) => b.categoryIds.includes(activeBookCategory))
  }, [books, activeBookCategory])

  const bookCategoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: books.length }
    for (const book of books) {
      for (const cid of book.categoryIds) {
        counts[cid] = (counts[cid] || 0) + 1
      }
    }
    return counts
  }, [books])

  // 文献操作
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
      tier: Number(newPaper.tier) as 1 | 2,
      hasNotes: false,
      mdStatus: 'none',
      mdProgress: 0,
      categoryIds: newPaper.categoryIds,
    }
    setPapers([paper, ...papers])
    setNewPaper({ title: '', authors: '', year: '', journal: '', doi: '', keywords: '', tier: '1', categoryIds: [] })
    setShowAddPaperModal(false)
  }

  const handleDeletePaper = (id: string) => {
    setPapers(papers.filter((p) => p.id !== id))
  }

  const handleEditPaper = (paper: Paper) => {
    setEditingPaper({ ...paper })
    setShowEditPaperModal(true)
  }

  const handleSavePaper = () => {
    if (!editingPaper) return
    setPapers(papers.map((p) => (p.id === editingPaper.id ? editingPaper : p)))
    setShowEditPaperModal(false)
    setEditingPaper(null)
  }

  const handleBatchDelete = () => {
    setPapers(papers.filter((p) => !selectedPapers.has(p.id)))
    setSelectedPapers(new Set())
    setBatchMode(false)
  }

  const toggleSelectPaper = (id: string) => {
    const next = new Set(selectedPapers)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setSelectedPapers(next)
  }

  const toggleSelectAll = () => {
    if (selectedPapers.size === pagedPapers.length) {
      setSelectedPapers(new Set())
    } else {
      setSelectedPapers(new Set(pagedPapers.map((p) => p.id)))
    }
  }

  const handleBatchMove = () => {
    setPapers(papers.map((p) => {
      if (selectedPapers.has(p.id)) {
        return { ...p, categoryIds: [...new Set([...p.categoryIds, ...batchMoveTargetIds])] }
      }
      return p
    }))
    setSelectedPapers(new Set())
    setBatchMode(false)
    setShowBatchMoveModal(false)
    setBatchMoveTargetIds([])
  }

  // 文献分类管理
  const handleAddCategory = (parentId?: string) => {
    setEditingCategory({ name: '', parentId })
    setShowCategoryModal(true)
  }

  const handleEditCategory = (id: string, name: string, parentId?: string) => {
    setEditingCategory({ id, name, parentId })
    setShowCategoryModal(true)
  }

  const handleDeleteCategory = (id: string) => {
    const removeFromTree = (cats: PaperCategory[]): PaperCategory[] => {
      return cats
        .filter((c) => c.id !== id)
        .map((c) => ({
          ...c,
          children: c.children ? removeFromTree(c.children) : undefined,
        }))
    }
    setPaperCategories(removeFromTree(paperCategories))
    setPapers(papers.map((p) => ({ ...p, categoryIds: p.categoryIds.filter((cid) => cid !== id) })))
    if (activePaperCategory === id) setActivePaperCategory('all')
  }

  const handleSaveCategory = () => {
    if (!editingCategory || !editingCategory.name.trim()) return
    if (editingCategory.id) {
      const updateInTree = (cats: PaperCategory[]): PaperCategory[] => {
        return cats.map((c) => {
          if (c.id === editingCategory.id) {
            return { ...c, name: editingCategory.name }
          }
          return {
            ...c,
            children: c.children ? updateInTree(c.children) : undefined,
          }
        })
      }
      setPaperCategories(updateInTree(paperCategories))
    } else {
      const newCat: PaperCategory = {
        id: String(Date.now()),
        name: editingCategory.name,
      }
      if (editingCategory.parentId) {
        const addToTree = (cats: PaperCategory[]): PaperCategory[] => {
          return cats.map((c) => {
            if (c.id === editingCategory.parentId) {
              return { ...c, children: [...(c.children || []), newCat] }
            }
            return {
              ...c,
              children: c.children ? addToTree(c.children) : undefined,
            }
          })
        }
        setPaperCategories(addToTree(paperCategories))
        if (!expandedCategories.has(editingCategory.parentId)) {
          setExpandedCategories(new Set([...expandedCategories, editingCategory.parentId]))
        }
      } else {
        setPaperCategories([...paperCategories, newCat])
      }
    }
    setEditingCategory(null)
    setShowCategoryModal(false)
  }

  // 期刊模板操作
  const handleAddTemplate = () => {
    if (!newTemplate.name.trim()) return
    const tpl: JournalTemplateItem = {
      id: String(Date.now()),
      name: newTemplate.name,
      issn: newTemplate.issn,
      publisher: newTemplate.publisher,
      lastUpdated: new Date().toISOString().split('T')[0],
      isDefault: false,
      formatSummary: newTemplate.guidelines || '格式规范待提取...',
    }
    setTemplates([...templates, tpl])
    setNewTemplate({ name: '', issn: '', publisher: '', guidelines: '' })
    setShowTemplateModal(false)
  }

  const handleExtractFormat = () => {
    setIsExtracting(true)
    setTimeout(() => {
      setNewTemplate((prev) => ({
        ...prev,
        guidelines: 'AI 已提取格式规范：摘要限制在250字以内，正文结构包含Introduction、Methods、Results、Discussion，参考文献采用APA格式，图表需单独编号并在正文中引用。',
      }))
      setIsExtracting(false)
    }, 2000)
  }

  const handleSetDefaultTemplate = (id: string) => {
    setTemplates(templates.map((t) => ({ ...t, isDefault: t.id === id })))
  }

  const handleDeleteTemplate = (id: string) => {
    setTemplates(templates.filter((t) => t.id !== id))
  }

  const handleApplyTemplate = (id: string) => {
    const tpl = templates.find((t) => t.id === id)
    if (tpl) {
      alert(`已将「${tpl.name}」模板应用到当前项目`)
    }
  }

  // 知识库操作
  const handleBookUpload = (files: FileList | null) => {
    if (!files) return
    const newBooks: BookItem[] = Array.from(files).map((f, i) => {
      const estimatedPages = Math.floor(Math.random() * 800) + 100
      const isSplit = estimatedPages > 200
      const volumeCount = isSplit ? Math.ceil(estimatedPages / 180) : 0
      const volumes: BookVolume[] = []
      for (let v = 0; v < volumeCount; v++) {
        const start = v * 180 + 1
        const end = Math.min((v + 1) * 180, estimatedPages)
        volumes.push({
          id: `v${v + 1}`,
          volume: v + 1,
          pageRange: `第${start}-${end}页`,
          status: v === 0 ? 'converting' : 'converting',
          progress: v === 0 ? 30 : 0,
        })
      }
      return {
        id: String(Date.now() + i),
        title: f.name.replace('.pdf', ''),
        author: '未知',
        publisher: '未知',
        pages: estimatedPages,
        status: 'converting' as const,
        progress: 10,
        isSplit,
        volumes: isSplit ? volumes : undefined,
        categoryIds: uploadBookCategories,
      }
    })
    setBooks([...newBooks, ...books])
    setShowUploadBookModal(false)
    setUploadBookCategories([])
  }

  const handleDeleteBook = (id: string) => {
    setBooks(books.filter((b) => b.id !== id))
  }

  // 图书分类管理
  const handleAddBookCategory = () => {
    setEditingBookCategory({ name: '' })
    setShowBookCategoryModal(true)
  }

  const handleEditBookCategory = (id: string, name: string) => {
    setEditingBookCategory({ id, name })
    setShowBookCategoryModal(true)
  }

  const handleDeleteBookCategory = (id: string) => {
    setBookCategories(bookCategories.filter((c) => c.id !== id))
    setBooks(books.map((b) => ({ ...b, categoryIds: b.categoryIds.filter((cid) => cid !== id) })))
    if (activeBookCategory === id) setActiveBookCategory('all')
  }

  const handleSaveBookCategory = () => {
    if (!editingBookCategory || !editingBookCategory.name.trim()) return
    if (editingBookCategory.id) {
      setBookCategories(bookCategories.map((c) =>
        c.id === editingBookCategory.id ? { ...c, name: editingBookCategory.name } : c
      ))
    } else {
      setBookCategories([...bookCategories, { id: String(Date.now()), name: editingBookCategory.name }])
    }
    setEditingBookCategory(null)
    setShowBookCategoryModal(false)
  }

  // 渲染文献分类树
  const renderCategoryTree = (cats: PaperCategory[], level = 0) => {
    return cats.map((cat) => {
      const hasChildren = cat.children && cat.children.length > 0
      const isExpanded = expandedCategories.has(cat.id)
      const isActive = activePaperCategory === cat.id
      const count = cat.id === 'all' ? paperCategoryCounts.all : (paperCategoryCounts[cat.id] || 0)

      return (
        <div key={cat.id}>
          <div
            className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer transition group ${
              isActive ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-slate-600 hover:bg-slate-50'
            }`}
            style={{ paddingLeft: `${level + 0.5}rem` }}
            onClick={() => {
              if (hasChildren) {
                toggleCategoryExpand(cat.id)
              }
              if (!hasChildren || cat.id === 'all') {
                setActivePaperCategory(cat.id)
                setLibraryPage(1)
              }
            }}
          >
            {hasChildren ? (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  toggleCategoryExpand(cat.id)
                }}
                className="p-0.5 -ml-0.5 text-slate-400 hover:text-slate-600"
              >
                {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
            ) : (
              <Folder className="w-3.5 h-3.5 text-slate-400" />
            )}
            <span className="text-sm flex-1 truncate">{cat.name}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${isActive ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-500'}`}>
              {count}
            </span>
            {cat.id !== 'all' && (
              <div className="hidden group-hover:flex items-center gap-0.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleEditCategory(cat.id, cat.name, hasChildren ? cat.id : undefined)
                  }}
                  className="p-0.5 text-slate-400 hover:text-indigo-600 rounded"
                >
                  <Edit3 className="w-3 h-3" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirm(`确定删除分类「${cat.name}」吗？`)) {
                      handleDeleteCategory(cat.id)
                    }
                  }}
                  className="p-0.5 text-slate-400 hover:text-red-600 rounded"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>
          {hasChildren && isExpanded && (
            <div className="mt-0.5">
              {renderCategoryTree(cat.children!, level + 1)}
              {cat.id === 'my-categories' && (
                <button
                  onClick={() => handleAddCategory(cat.id)}
                  className="flex items-center gap-1 ml-4 mt-1 px-2 py-1 text-xs text-slate-400 hover:text-indigo-600 rounded-md hover:bg-indigo-50 transition"
                  style={{ marginLeft: `${level + 1.5}rem` }}
                >
                  <Plus className="w-3 h-3" />
                  添加子分类
                </button>
              )}
            </div>
          )}
        </div>
      )
    })
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <FolderCog className="w-6 h-6 text-indigo-600" />
            管理中心
          </h1>
          <p className="text-sm text-slate-500 mt-1">文献库、期刊模板、知识库、数据管理</p>
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
        <div className="flex gap-4">
          {/* 左侧分类树 */}
          <div className="w-64 flex-shrink-0">
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-3">
              <div className="flex items-center justify-between mb-3 px-1">
                <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
                  <Library className="w-4 h-4 text-indigo-600" />
                  文献分类
                </h3>
              </div>
              <div className="space-y-0.5">
                {renderCategoryTree(paperCategories)}
              </div>
            </div>
          </div>

          {/* 右侧文献列表 */}
          <div className="flex-1 space-y-4 min-w-0">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    placeholder="搜索标题、作者、期刊、关键词..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value)
                      setLibraryPage(1)
                    }}
                    className="pl-9 pr-4 py-2 text-sm border border-slate-200 rounded-lg w-72 focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-white"
                  />
                </div>
                {/* 视图切换 */}
                <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
                  <button
                    onClick={() => setViewMode('table')}
                    className={`p-1.5 rounded-md transition ${viewMode === 'table' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                    title="表格视图"
                  >
                    <List className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setViewMode('card')}
                    className={`p-1.5 rounded-md transition ${viewMode === 'card' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}
                    title="卡片视图"
                  >
                    <LayoutGrid className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {batchMode && (
                  <>
                    <button
                      onClick={() => setShowBatchMoveModal(true)}
                      disabled={selectedPapers.size === 0}
                      className="flex items-center gap-2 px-3 py-2 text-sm text-indigo-600 bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <MoveRight className="w-4 h-4" />
                      移动分类 ({selectedPapers.size})
                    </button>
                    <button
                      onClick={handleBatchDelete}
                      disabled={selectedPapers.size === 0}
                      className="flex items-center gap-2 px-3 py-2 text-sm text-red-600 bg-red-50 border border-red-200 hover:bg-red-100 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Trash2 className="w-4 h-4" />
                      删除选中
                    </button>
                  </>
                )}
                <button
                  onClick={() => {
                    setBatchMode(!batchMode)
                    setSelectedPapers(new Set())
                  }}
                  className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg border transition ${
                    batchMode
                      ? 'text-indigo-600 bg-indigo-50 border-indigo-200'
                      : 'text-slate-600 bg-white border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <CheckSquare className="w-4 h-4" />
                  {batchMode ? '取消批量' : '批量操作'}
                </button>
                <button
                  onClick={() => {
                    setNewPaper({ title: '', authors: '', year: '', journal: '', doi: '', keywords: '', tier: '1', categoryIds: activePaperCategory !== 'all' ? [activePaperCategory] : [] })
                    setShowAddPaperModal(true)
                  }}
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
                    {filteredPapers.length}
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
                    {filteredPapers.filter((p) => p.tier === 1).length}
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
                    {filteredPapers.filter((p) => p.tier === 2).length}
                  </span>
                </button>
              </div>

              {/* 表格视图 */}
              {viewMode === 'table' && (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-slate-50">
                      <tr>
                        {batchMode && (
                          <th className="text-left px-4 py-3 w-10">
                            <input
                              type="checkbox"
                              checked={selectedPapers.size === pagedPapers.length && pagedPapers.length > 0}
                              onChange={toggleSelectAll}
                              className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                            />
                          </th>
                        )}
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">题图</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">标题</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">作者</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">年份</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">期刊</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">关键词</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">DOI</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">分类</th>
                        <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {pagedPapers.map((paper) => (
                        <tr key={paper.id} className="hover:bg-slate-50/70 transition">
                          {batchMode && (
                            <td className="px-4 py-3">
                              <input
                                type="checkbox"
                                checked={selectedPapers.has(paper.id)}
                                onChange={() => toggleSelectPaper(paper.id)}
                                className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                              />
                            </td>
                          )}
                          <td className="px-4 py-3">
                            <div
                              className={`w-12 h-12 rounded-lg overflow-hidden bg-slate-100 flex-shrink-0 ${paper.coverImage ? 'cursor-pointer hover:opacity-80 transition' : ''}`}
                              onClick={() => paper.coverImage && setShowImageLightbox(paper.coverImage)}
                            >
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
                          <td className="px-4 py-3 text-sm text-slate-600 max-w-[7.5rem] truncate">{paper.authors}</td>
                          <td className="px-4 py-3 text-sm text-slate-600">{paper.year}</td>
                          <td className="px-4 py-3 text-sm text-slate-600 max-w-[8.75rem] truncate">{paper.journal}</td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1 max-w-[11.25rem]">
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
                              className="text-xs text-indigo-600 hover:underline max-w-[8.75rem] truncate block"
                            >
                              {paper.doi.slice(0, 20)}...
                            </a>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1 max-w-[7.5rem]">
                              {paper.categoryIds.length > 0 ? (
                                paper.categoryIds.slice(0, 1).map((cid) => {
                                  const cat = getAllLeafCategories.find((c) => c.id === cid)
                                  return cat ? (
                                    <span key={cid} className="px-1.5 py-0.5 bg-amber-50 text-amber-600 text-xs rounded">
                                      <Tag className="w-3 h-3 inline mr-0.5" />
                                      {cat.name}
                                    </span>
                                  ) : null
                                })
                              ) : (
                                <span className="text-xs text-slate-400">未分类</span>
                              )}
                              {paper.categoryIds.length > 1 && (
                                <span className="text-xs text-slate-400">+{paper.categoryIds.length - 1}</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-end gap-1">
                              <button className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition" title="阅读">
                                <Eye className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleEditPaper(paper)}
                                className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition"
                                title="编辑"
                              >
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
                          <td colSpan={batchMode ? 10 : 9} className="px-4 py-16 text-center text-slate-400">
                            暂无文献数据
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 卡片视图 */}
              {viewMode === 'card' && (
                <div className="p-4">
                  {pagedPapers.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {pagedPapers.map((paper) => (
                        <div
                          key={paper.id}
                          className={`bg-white border rounded-xl overflow-hidden hover:shadow-md transition group ${
                            batchMode ? 'cursor-pointer' : ''
                          } ${selectedPapers.has(paper.id) ? 'border-indigo-400 ring-2 ring-indigo-100' : 'border-slate-200'}`}
                          onClick={() => batchMode && toggleSelectPaper(paper.id)}
                        >
                          <div className="relative h-32 bg-slate-100 overflow-hidden">
                            {paper.coverImage ? (
                              <img src={paper.coverImage} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-slate-300">
                                {paper.tier === 2 ? <Book className="w-12 h-12" /> : <FileText className="w-12 h-12" />}
                              </div>
                            )}
                            {batchMode && (
                              <div className="absolute top-2 left-2">
                                <input
                                  type="checkbox"
                                  checked={selectedPapers.has(paper.id)}
                                  onChange={(e) => {
                                    e.stopPropagation()
                                    toggleSelectPaper(paper.id)
                                  }}
                                  className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                />
                              </div>
                            )}
                            <div className="absolute top-2 right-2">
                              <span className="text-lg">{paper.tier === 2 ? '📖' : '📄'}</span>
                            </div>
                          </div>
                          <div className="p-3">
                            <h3 className="font-medium text-slate-800 text-sm line-clamp-2 mb-1.5 min-h-[2.5rem]">{paper.title}</h3>
                            <p className="text-xs text-slate-500 line-clamp-1 mb-1">{paper.authors}</p>
                            <p className="text-xs text-slate-400 line-clamp-1 mb-2">{paper.journal} · {paper.year}</p>
                            <div className="flex flex-wrap gap-1 mb-2">
                              {paper.keywords.slice(0, 2).map((kw) => (
                                <span key={kw} className="px-1.5 py-0.5 bg-indigo-50 text-indigo-600 text-xs rounded">
                                  {kw}
                                </span>
                              ))}
                              {paper.keywords.length > 2 && (
                                <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 text-xs rounded">
                                  +{paper.keywords.length - 2}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                              <StatusBadge status={paper.mdStatus} />
                              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleEditPaper(paper)
                                  }}
                                  className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleDeletePaper(paper.id)
                                  }}
                                  className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-16 text-center text-slate-400">
                      暂无文献数据
                    </div>
                  )}
                </div>
              )}

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
        </div>
      )}

      {/* ============ 期刊模板 Tab ============ */}
      {activeTab === 'templates' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-500">管理期刊投稿模板，支持 AI 提取格式规范，用于提示和规范提取格式</p>
            <button
              onClick={() => {
                setEditingTemplate(null)
                setNewTemplate({ name: '', issn: '', publisher: '', guidelines: '' })
                setShowTemplateModal(true)
              }}
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
                  <p className="text-sm text-slate-500 mb-1">{tpl.publisher} · ISSN: {tpl.issn || '-'}</p>
                  <p className="text-xs text-slate-400 mb-3">最后更新：{tpl.lastUpdated}</p>
                  <div className="p-3 bg-slate-50 rounded-lg border border-slate-100">
                    <p className="text-xs text-slate-600 leading-relaxed line-clamp-3">{tpl.formatSummary}</p>
                  </div>
                </div>
                <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        setEditingTemplate({ ...tpl })
                        setNewTemplate({ name: tpl.name, issn: tpl.issn, publisher: tpl.publisher, guidelines: tpl.formatSummary })
                        setShowTemplateModal(true)
                      }}
                      className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition"
                      title="编辑"
                    >
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
                  <button
                    onClick={() => handleApplyTemplate(tpl.id)}
                    className="text-xs text-indigo-600 hover:text-indigo-700 font-medium flex items-center gap-1"
                  >
                    应用到项目
                    <ExternalLink className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ============ 知识库 Tab ============ */}
      {activeTab === 'knowledge' && (
        <div className="flex gap-4">
          {/* 左侧分类树 */}
          <div className="w-64 flex-shrink-0">
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-3">
              <div className="flex items-center justify-between mb-3 px-1">
                <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
                  <BookCopy className="w-4 h-4 text-indigo-600" />
                  图书分类
                </h3>
                <button
                  onClick={handleAddBookCategory}
                  className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition"
                  title="添加分类"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
              <div className="space-y-0.5">
                {bookCategories.map((cat) => {
                  const isActive = activeBookCategory === cat.id
                  const count = bookCategoryCounts[cat.id] || 0
                  return (
                    <div
                      key={cat.id}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition group ${
                        isActive ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-slate-600 hover:bg-slate-50'
                      }`}
                      onClick={() => setActiveBookCategory(cat.id)}
                    >
                      <Folder className="w-3.5 h-3.5 text-slate-400" />
                      <span className="text-sm flex-1 truncate">{cat.name}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded-full ${isActive ? 'bg-indigo-100 text-indigo-600' : 'bg-slate-100 text-slate-500'}`}>
                        {count}
                      </span>
                      {cat.id !== 'all' && (
                        <div className="hidden group-hover:flex items-center gap-0.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleEditBookCategory(cat.id, cat.name)
                            }}
                            className="p-0.5 text-slate-400 hover:text-indigo-600 rounded"
                          >
                            <Edit3 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              if (confirm(`确定删除分类「${cat.name}」吗？`)) {
                                handleDeleteBookCategory(cat.id)
                              }
                            }}
                            className="p-0.5 text-slate-400 hover:text-red-600 rounded"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* 右侧图书列表 */}
          <div className="flex-1 space-y-4 min-w-0">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-500">
                  知识库存储图书，PDF 上传后自动转换为 Markdown。超过200页按180页切分，多卷管理。
                </p>
              </div>
              <button
                onClick={() => {
                  setUploadBookCategories(activeBookCategory !== 'all' ? [activeBookCategory] : [])
                  setShowUploadBookModal(true)
                }}
                className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded-lg transition shadow-md shadow-indigo-200"
              >
                <Upload className="w-4 h-4" />
                上传图书
              </button>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault()
                setIsDragOverBook(true)
              }}
              onDragLeave={() => setIsDragOverBook(false)}
              onDrop={(e) => {
                e.preventDefault()
                setIsDragOverBook(false)
                handleBookUpload(e.dataTransfer.files)
              }}
              className={`border-2 border-dashed rounded-xl p-6 text-center transition ${
                isDragOverBook
                  ? 'border-indigo-400 bg-indigo-50/50'
                  : 'border-slate-200 bg-white hover:border-indigo-200 hover:bg-indigo-50/30'
              }`}
            >
              <p className="text-sm text-slate-500">
                拖拽 PDF 图书到此处上传，自动转换为 Markdown。<span className="text-indigo-600 font-medium">超过200页自动按180页切分</span>
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {filteredBooks.map((book) => (
                <div
                  key={book.id}
                  className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition overflow-hidden group cursor-pointer"
                  onClick={() => setShowBookDetail(book)}
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
                    {book.isSplit && book.status === 'done' && (
                      <div className="absolute top-2 left-2">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-100 text-indigo-700 text-xs font-medium rounded-full">
                          <Layers className="w-3 h-3" />
                          共{book.volumes?.length || 0}卷
                        </span>
                      </div>
                    )}
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
                    {book.categoryIds.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {book.categoryIds.slice(0, 2).map((cid) => {
                          const cat = bookCategories.find((c) => c.id === cid)
                          return cat ? (
                            <span key={cid} className="px-1.5 py-0.5 bg-amber-50 text-amber-600 text-xs rounded">
                              {cat.name}
                            </span>
                          ) : null
                        })}
                      </div>
                    )}
                  </div>
                  <div className="px-3 py-2 bg-slate-50 border-t border-slate-100 flex items-center justify-between" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setShowBookDetail(book)}
                        className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition"
                        title="详情"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                      {(book.status === 'converting' || book.status === 'uploading') && (
                        <button
                          onClick={() => setShowBookDetail(book)}
                          className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition"
                          title="查看转换进度"
                        >
                          <Loader2 className="w-4 h-4 animate-spin" />
                        </button>
                      )}
                    </div>
                    <button
                      onClick={() => handleDeleteBook(book.id)}
                      className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition"
                      title="删除"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
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
                  { name: 'CSV 导入', desc: '从 CSV 表格导入文献元数据', ext: '.csv', icon: FileSpreadsheet },
                  { name: 'JSON 导入', desc: '从 JSON 文件导入结构化数据', ext: '.json', icon: FileJson },
                  { name: 'EndNote 导入', desc: '导入 EndNote 文献库 (.enw)', ext: '.enw', icon: BookText },
                  { name: 'Zotero 导入', desc: '从 Zotero 导出的 JSON/CSV 导入', ext: '.json,.csv', icon: Database },
                ].map((item) => {
                  const Icon = item.icon
                  return (
                    <label
                      key={item.name}
                      className="flex items-center gap-3 p-3 border border-slate-200 rounded-lg hover:border-indigo-200 hover:bg-indigo-50/30 cursor-pointer transition"
                    >
                      <div className="p-2 bg-slate-100 rounded-lg">
                        <Icon className="w-5 h-5 text-slate-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-700">{item.name}</div>
                        <div className="text-xs text-slate-500">{item.desc}</div>
                      </div>
                      <input type="file" accept={item.ext} className="hidden" />
                      <span className="text-xs text-indigo-600 font-medium shrink-0">选择文件</span>
                    </label>
                  )
                })}
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
                  { name: '导出 CSV', desc: '导出为 CSV 表格格式', icon: FileSpreadsheet },
                  { name: '导出 Markdown', desc: '导出为 Markdown 文献列表', icon: FileText },
                  { name: '导出 BibTeX', desc: '导出为 BibTeX 引用格式', icon: BookText },
                ].map((item) => {
                  const Icon = item.icon
                  return (
                    <button
                      key={item.name}
                      className="w-full flex items-center gap-3 p-3 border border-slate-200 rounded-lg hover:border-indigo-200 hover:bg-indigo-50/30 transition text-left"
                    >
                      <div className="p-2 bg-slate-100 rounded-lg">
                        <Icon className="w-5 h-5 text-slate-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-slate-700">{item.name}</div>
                        <div className="text-xs text-slate-500">{item.desc}</div>
                      </div>
                      <Download className="w-4 h-4 text-indigo-500 shrink-0" />
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                <Github className="w-5 h-5 text-indigo-600" />
                GitHub 同步
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">与 GitHub 私有仓库同步文献和知识库数据</p>
            </div>
            <div className="p-5">
              <div className="flex items-center gap-4 p-4 bg-indigo-50/50 border border-indigo-100 rounded-xl">
                <div className="p-3 bg-indigo-100 rounded-xl">
                  <Github className="w-6 h-6 text-indigo-600" />
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
              <label className="block text-sm font-medium text-slate-700 mb-1.5">文献等级</label>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="tier"
                    value="1"
                    checked={newPaper.tier === '1'}
                    onChange={(e) => setNewPaper({ ...newPaper, tier: e.target.value as '1' | '2' })}
                    className="w-4 h-4 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-sm text-slate-700">📄 一级文献</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="tier"
                    value="2"
                    checked={newPaper.tier === '2'}
                    onChange={(e) => setNewPaper({ ...newPaper, tier: e.target.value as '1' | '2' })}
                    className="w-4 h-4 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-sm text-slate-700">📖 二级文献</span>
                </label>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">所属分类（可多选）</label>
              <div className="flex flex-wrap gap-2 p-3 border border-slate-200 rounded-lg bg-slate-50/50">
                {getAllLeafCategories.map((cat) => {
                  const checked = newPaper.categoryIds.includes(cat.id)
                  return (
                    <label
                      key={cat.id}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md cursor-pointer text-sm transition ${
                        checked ? 'bg-indigo-100 text-indigo-700' : 'bg-white text-slate-600 border border-slate-200 hover:border-indigo-300'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setNewPaper({ ...newPaper, categoryIds: [...newPaper.categoryIds, cat.id] })
                          } else {
                            setNewPaper({ ...newPaper, categoryIds: newPaper.categoryIds.filter((id) => id !== cat.id) })
                          }
                        }}
                        className="w-3.5 h-3.5 text-indigo-600 focus:ring-indigo-500 rounded"
                      />
                      {cat.name}
                    </label>
                  )
                })}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">上传 PDF（自动转MD）</label>
              <div className="border-2 border-dashed border-slate-200 rounded-lg p-6 text-center hover:border-indigo-300 transition cursor-pointer">
                <Upload className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                <p className="text-sm text-slate-500">点击或拖拽 PDF 到此处</p>
                <p className="text-xs text-slate-400 mt-1">PDF 上传后自动转换为 Markdown</p>
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

      {/* 编辑文献弹窗 */}
      {showEditPaperModal && editingPaper && (
        <Modal title="编辑文献" onClose={() => { setShowEditPaperModal(false); setEditingPaper(null) }} width="max-w-2xl">
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">题图</label>
                <div className="aspect-square rounded-lg overflow-hidden bg-slate-100 border border-slate-200 flex items-center justify-center">
                  {editingPaper.coverImage ? (
                    <img src={editingPaper.coverImage} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <ImageIcon className="w-8 h-8 text-slate-300" />
                  )}
                </div>
                <div className="mt-2 space-y-1">
                  <label className="flex items-center justify-center gap-1 px-2 py-1.5 text-xs text-slate-600 bg-slate-50 border border-slate-200 hover:bg-slate-100 rounded-md cursor-pointer transition">
                    <Upload className="w-3.5 h-3.5" />
                    上传图片
                    <input type="file" accept="image/*" className="hidden" />
                  </label>
                  <button
                    onClick={() => {
                      const url = prompt('请输入图片URL')
                      if (url && editingPaper) {
                        setEditingPaper({ ...editingPaper, coverImage: url })
                      }
                    }}
                    className="w-full flex items-center justify-center gap-1 px-2 py-1.5 text-xs text-slate-600 bg-slate-50 border border-slate-200 hover:bg-slate-100 rounded-md transition"
                  >
                    <LinkIcon className="w-3.5 h-3.5" />
                    从URL添加
                  </button>
                </div>
              </div>
              <div className="col-span-2 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">标题 *</label>
                  <input
                    type="text"
                    value={editingPaper.title}
                    onChange={(e) => setEditingPaper({ ...editingPaper, title: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">作者</label>
                  <input
                    type="text"
                    value={editingPaper.authors}
                    onChange={(e) => setEditingPaper({ ...editingPaper, authors: e.target.value })}
                    placeholder="多个作者用逗号分隔"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">年份</label>
                    <input
                      type="text"
                      value={editingPaper.year}
                      onChange={(e) => setEditingPaper({ ...editingPaper, year: e.target.value })}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">期刊</label>
                    <input
                      type="text"
                      value={editingPaper.journal}
                      onChange={(e) => setEditingPaper({ ...editingPaper, journal: e.target.value })}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">关键词</label>
              <input
                type="text"
                value={editingPaper.keywords.join(', ')}
                onChange={(e) => setEditingPaper({ ...editingPaper, keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) })}
                placeholder="多个关键词用逗号分隔"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">DOI</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={editingPaper.doi}
                  onChange={(e) => setEditingPaper({ ...editingPaper, doi: e.target.value })}
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
                <a
                  href={`https://doi.org/${editingPaper.doi}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 px-3 py-2 text-sm text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition"
                >
                  <ExternalLink className="w-4 h-4" />
                  测试跳转
                </a>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">所属分类（可多选，可同时属于多个分类）</label>
              <div className="flex flex-wrap gap-2 p-3 border border-slate-200 rounded-lg bg-slate-50/50 max-h-32 overflow-y-auto">
                {getAllLeafCategories.map((cat) => {
                  const checked = editingPaper.categoryIds.includes(cat.id)
                  return (
                    <label
                      key={cat.id}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md cursor-pointer text-sm transition ${
                        checked ? 'bg-indigo-100 text-indigo-700' : 'bg-white text-slate-600 border border-slate-200 hover:border-indigo-300'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setEditingPaper({ ...editingPaper, categoryIds: [...editingPaper.categoryIds, cat.id] })
                          } else {
                            setEditingPaper({ ...editingPaper, categoryIds: editingPaper.categoryIds.filter((id) => id !== cat.id) })
                          }
                        }}
                        className="w-3.5 h-3.5 text-indigo-600 focus:ring-indigo-500 rounded"
                      />
                      {cat.name}
                    </label>
                  )
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Markdown 转换</label>
                <div className="p-3 border border-slate-200 rounded-lg bg-slate-50/50">
                  <div className="flex items-center justify-between mb-2">
                    <StatusBadge status={editingPaper.mdStatus} />
                    {editingPaper.mdStatus === 'done' && (
                      <button className="text-xs text-indigo-600 hover:underline">查看</button>
                    )}
                  </div>
                  {editingPaper.mdStatus === 'converting' && (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                        <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${editingPaper.mdProgress}%` }} />
                      </div>
                      <span className="text-xs text-slate-500">{editingPaper.mdProgress}%</span>
                    </div>
                  )}
                  {(editingPaper.mdStatus === 'none' || editingPaper.mdStatus === 'failed') && (
                    <label className="flex items-center justify-center gap-1 mt-2 px-3 py-1.5 text-xs text-white bg-indigo-600 hover:bg-indigo-700 rounded-md cursor-pointer transition">
                      <Upload className="w-3.5 h-3.5" />
                      上传PDF转MD
                      <input type="file" accept=".pdf" className="hidden" />
                    </label>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">笔记</label>
                <div className="p-3 border border-slate-200 rounded-lg bg-slate-50/50">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <StickyNote className={`w-4 h-4 ${editingPaper.hasNotes ? 'text-amber-500' : 'text-slate-300'}`} />
                      <span className="text-sm text-slate-700">
                        {editingPaper.hasNotes ? '有笔记' : '无笔记'}
                      </span>
                    </div>
                    <button
                      onClick={() => setEditingPaper({ ...editingPaper, hasNotes: !editingPaper.hasNotes })}
                      className="text-xs text-indigo-600 hover:underline"
                    >
                      {editingPaper.hasNotes ? '查看笔记' : '添加笔记'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-slate-100">
            <button
              onClick={() => { setShowEditPaperModal(false); setEditingPaper(null) }}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
            >
              取消
            </button>
            <button
              onClick={handleSavePaper}
              className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded-lg transition"
            >
              <CheckCircle2 className="w-4 h-4" />
              保存
            </button>
          </div>
        </Modal>
      )}

      {/* 批量移动分类弹窗 */}
      {showBatchMoveModal && (
        <Modal title="批量移动分类" onClose={() => { setShowBatchMoveModal(false); setBatchMoveTargetIds([]) }}>
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              已选中 <span className="font-semibold text-indigo-600">{selectedPapers.size}</span> 篇文献，选择目标分类（可多选，将添加到现有分类中）：
            </p>
            <div className="flex flex-wrap gap-2 p-3 border border-slate-200 rounded-lg bg-slate-50/50 max-h-48 overflow-y-auto">
              {getAllLeafCategories.map((cat) => {
                const checked = batchMoveTargetIds.includes(cat.id)
                return (
                  <label
                    key={cat.id}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md cursor-pointer text-sm transition ${
                      checked ? 'bg-indigo-100 text-indigo-700' : 'bg-white text-slate-600 border border-slate-200 hover:border-indigo-300'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setBatchMoveTargetIds([...batchMoveTargetIds, cat.id])
                        } else {
                          setBatchMoveTargetIds(batchMoveTargetIds.filter((id) => id !== cat.id))
                        }
                      }}
                      className="w-3.5 h-3.5 text-indigo-600 focus:ring-indigo-500 rounded"
                    />
                    {cat.name}
                  </label>
                )
              })}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-slate-100">
            <button
              onClick={() => { setShowBatchMoveModal(false); setBatchMoveTargetIds([]) }}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
            >
              取消
            </button>
            <button
              onClick={handleBatchMove}
              disabled={batchMoveTargetIds.length === 0}
              className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <MoveRight className="w-4 h-4" />
              确认移动
            </button>
          </div>
        </Modal>
      )}

      {/* 分类编辑弹窗 */}
      {showCategoryModal && editingCategory && (
        <Modal title={editingCategory.id ? '编辑分类' : '添加分类'} onClose={() => { setShowCategoryModal(false); setEditingCategory(null) }}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">分类名称 *</label>
              <input
                type="text"
                value={editingCategory.name}
                onChange={(e) => setEditingCategory({ ...editingCategory, name: e.target.value })}
                placeholder="请输入分类名称"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-slate-100">
            <button
              onClick={() => { setShowCategoryModal(false); setEditingCategory(null) }}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
            >
              取消
            </button>
            <button
              onClick={handleSaveCategory}
              disabled={!editingCategory.name.trim()}
              className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle2 className="w-4 h-4" />
              保存
            </button>
          </div>
        </Modal>
      )}

      {/* 图书分类编辑弹窗 */}
      {showBookCategoryModal && editingBookCategory && (
        <Modal title={editingBookCategory.id ? '编辑分类' : '添加分类'} onClose={() => { setShowBookCategoryModal(false); setEditingBookCategory(null) }}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">分类名称 *</label>
              <input
                type="text"
                value={editingBookCategory.name}
                onChange={(e) => setEditingBookCategory({ ...editingBookCategory, name: e.target.value })}
                placeholder="请输入分类名称"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-slate-100">
            <button
              onClick={() => { setShowBookCategoryModal(false); setEditingBookCategory(null) }}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
            >
              取消
            </button>
            <button
              onClick={handleSaveBookCategory}
              disabled={!editingBookCategory.name.trim()}
              className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle2 className="w-4 h-4" />
              保存
            </button>
          </div>
        </Modal>
      )}

      {/* 新建/编辑模板弹窗 */}
      {showTemplateModal && (
        <Modal title={editingTemplate ? '编辑期刊模板' : '新建期刊模板'} onClose={() => { setShowTemplateModal(false); setEditingTemplate(null) }} width="max-w-xl">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
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
              <label className="block text-sm font-medium text-slate-700 mb-1.5">投稿须知 / 格式规范</label>
              <div className="space-y-2">
                <div className="flex gap-2">
                  <label className="flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm text-slate-600 bg-slate-50 border border-slate-200 hover:bg-slate-100 rounded-lg cursor-pointer transition">
                    <FileText className="w-4 h-4" />
                    粘贴投稿须知
                    <input type="file" accept=".pdf,.txt" className="hidden" />
                  </label>
                  <button
                    onClick={handleExtractFormat}
                    disabled={isExtracting}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded-lg transition disabled:opacity-60"
                  >
                    <Sparkles className={`w-4 h-4 ${isExtracting ? 'animate-spin' : ''}`} />
                    {isExtracting ? '提取中...' : 'AI提取'}
                  </button>
                </div>
                <textarea
                  value={newTemplate.guidelines}
                  onChange={(e) => setNewTemplate({ ...newTemplate, guidelines: e.target.value })}
                  placeholder="粘贴投稿须知内容，或点击AI提取自动生成格式规范摘要..."
                  rows={5}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 resize-none"
                />
                <p className="text-xs text-slate-400">提示：模板主要用于提示和规范提取格式，帮助统一写作风格</p>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-slate-100">
            <button
              onClick={() => { setShowTemplateModal(false); setEditingTemplate(null) }}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
            >
              取消
            </button>
            <button
              onClick={handleAddTemplate}
              className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded-lg transition"
            >
              <Plus className="w-4 h-4" />
              {editingTemplate ? '保存修改' : '创建模板'}
            </button>
          </div>
        </Modal>
      )}

      {/* 上传图书弹窗 */}
      {showUploadBookModal && (
        <Modal title="上传图书" onClose={() => { setShowUploadBookModal(false); setUploadBookCategories([]) }}>
          <div className="space-y-4">
            <div
              onDragOver={(e) => {
                e.preventDefault()
                setIsDragOverBook(true)
              }}
              onDragLeave={() => setIsDragOverBook(false)}
              onDrop={(e) => {
                e.preventDefault()
                setIsDragOverBook(false)
                handleBookUpload(e.dataTransfer.files)
              }}
              className={`border-2 border-dashed rounded-xl p-8 text-center transition ${
                isDragOverBook
                  ? 'border-indigo-400 bg-indigo-50/50'
                  : 'border-slate-200 bg-slate-50 hover:border-indigo-200 hover:bg-indigo-50/30'
              }`}
            >
              <Upload className="w-10 h-10 mx-auto mb-3 text-slate-400" />
              <p className="text-sm text-slate-600 font-medium">拖拽或点击上传 PDF 图书</p>
              <p className="text-xs text-slate-400 mt-1">支持多文件上传，自动转换为 Markdown</p>
              <p className="text-xs text-indigo-500 mt-1">超过200页自动按180页切分</p>
              <label className="inline-flex items-center gap-2 mt-4 px-4 py-2 text-sm text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded-lg transition cursor-pointer">
                <Upload className="w-4 h-4" />
                选择文件
                <input
                  type="file"
                  accept=".pdf"
                  multiple
                  className="hidden"
                  onChange={(e) => handleBookUpload(e.target.files)}
                />
              </label>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">选择分类（可多选）</label>
              <div className="flex flex-wrap gap-2 p-3 border border-slate-200 rounded-lg bg-slate-50/50">
                {bookCategories.filter((c) => c.id !== 'all').map((cat) => {
                  const checked = uploadBookCategories.includes(cat.id)
                  return (
                    <label
                      key={cat.id}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md cursor-pointer text-sm transition ${
                        checked ? 'bg-indigo-100 text-indigo-700' : 'bg-white text-slate-600 border border-slate-200 hover:border-indigo-300'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setUploadBookCategories([...uploadBookCategories, cat.id])
                          } else {
                            setUploadBookCategories(uploadBookCategories.filter((id) => id !== cat.id))
                          }
                        }}
                        className="w-3.5 h-3.5 text-indigo-600 focus:ring-indigo-500 rounded"
                      />
                      {cat.name}
                    </label>
                  )
                })}
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-slate-100">
            <button
              onClick={() => { setShowUploadBookModal(false); setUploadBookCategories([]) }}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
            >
              取消
            </button>
          </div>
        </Modal>
      )}

      {/* 图书详情弹窗 */}
      {showBookDetail && (
        <Modal
          title={showBookDetail.title}
          onClose={() => setShowBookDetail(null)}
          width="max-w-xl"
        >
          <div className="space-y-4">
            <div className="flex gap-4">
              <div className="w-24 h-32 flex-shrink-0 rounded-lg overflow-hidden bg-slate-100">
                {showBookDetail.coverImage ? (
                  <img src={showBookDetail.coverImage} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-slate-300">
                    <Book className="w-8 h-8" />
                  </div>
                )}
              </div>
              <div className="flex-1 space-y-1.5">
                <p className="text-sm text-slate-600"><span className="text-slate-400">作者：</span>{showBookDetail.author}</p>
                <p className="text-sm text-slate-600"><span className="text-slate-400">出版社：</span>{showBookDetail.publisher}</p>
                <p className="text-sm text-slate-600"><span className="text-slate-400">页数：</span>{showBookDetail.pages} 页</p>
                <p className="text-sm text-slate-600"><span className="text-slate-400">状态：</span>
                  <BookStatusBadge status={showBookDetail.status} />
                </p>
                <div className="flex flex-wrap gap-1 pt-1">
                  {showBookDetail.categoryIds.length > 0 ? (
                    showBookDetail.categoryIds.map((cid) => {
                      const cat = bookCategories.find((c) => c.id === cid)
                      return cat ? (
                        <span key={cid} className="px-1.5 py-0.5 bg-amber-50 text-amber-600 text-xs rounded">
                          <Tag className="w-3 h-3 inline mr-0.5" />
                          {cat.name}
                        </span>
                      ) : null
                    })
                  ) : (
                    <span className="text-xs text-slate-400">未分类</span>
                  )}
                </div>
              </div>
            </div>

            {showBookDetail.isSplit && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Layers className="w-4 h-4 text-indigo-600" />
                  <h4 className="text-sm font-medium text-slate-700">分卷列表（超过200页按180页切分）</h4>
                </div>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {showBookDetail.volumes?.map((vol) => (
                    <div key={vol.id} className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg border border-slate-100">
                      <div className="w-8 h-8 flex items-center justify-center bg-indigo-100 text-indigo-600 rounded-md text-sm font-bold">
                        {vol.volume}
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-slate-700">第 {vol.volume} 卷</p>
                        <p className="text-xs text-slate-500">{vol.pageRange}</p>
                      </div>
                      <div className="w-24">
                        {vol.status === 'done' ? (
                          <span className="inline-flex items-center gap-1 text-xs text-green-600">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            已完成
                          </span>
                        ) : vol.status === 'converting' ? (
                          <div className="flex items-center gap-1.5">
                            <div className="flex-1 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                              <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${vol.progress}%` }} />
                            </div>
                            <span className="text-xs text-slate-500 w-8">{vol.progress}%</span>
                          </div>
                        ) : (
                          <span className="text-xs text-red-600">失败</span>
                        )}
                      </div>
                      {vol.status === 'done' && (
                        <button className="p-1 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition">
                          <Eye className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!showBookDetail.isSplit && (
              <div className="p-3 bg-indigo-50/50 border border-indigo-100 rounded-lg">
                <p className="text-sm text-indigo-700">
                  本书页数少于200页，无需切分，单卷完整转换。
                </p>
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 mt-6 pt-4 border-t border-slate-100">
            <button
              onClick={() => setShowBookDetail(null)}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition"
            >
              关闭
            </button>
            <div className="flex items-center gap-2">
              {showBookDetail.status === 'done' && showBookDetail.isSplit && (
                <button className="flex items-center gap-2 px-4 py-2 text-sm text-indigo-600 bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 rounded-lg transition">
                  <Layers className="w-4 h-4" />
                  合并阅读
                </button>
              )}
              {showBookDetail.status === 'done' && (
                <button className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 rounded-lg transition">
                  <Book className="w-4 h-4" />
                  开始阅读
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* 图片灯箱 */}
      {showImageLightbox && (
        <ImageLightbox src={showImageLightbox} onClose={() => setShowImageLightbox(null)} />
      )}
    </div>
  )
}
