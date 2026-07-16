/**
 * 期刊模板管理页面
 * -------------------------------------------------
 * 功能：
 * - 模板列表（卡片展示）
 * - 新建模板（填基本信息 + 粘贴投稿须知 + AI 提取）
 * - 编辑模板（修改所有字段）
 * - 删除模板
 * - AI 从投稿须知提取格式规范
 */
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  Plus,
  Edit3,
  Trash2,
  ArrowLeft,
  BookMarked,
  Sparkles,
  Loader2,
  FileText,
  Save,
  X,
  CheckCircle2,
  Columns,
  Type,
  Palette,
} from 'lucide-react'
import { toast } from 'sonner'
import { useSettingsStore } from '../stores/settings'
import {
  getAllTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  updateGuidelines,
} from '../services/journal-templates'
import {
  extractGuidelinesWithAI,
  type ExtractedGuidelines,
} from '../services/guideline-extractor'
import type { JournalTemplate } from '../types'
import { SILICONFLOW_BASE_URL } from '../services/ai/models'
import { DEMO_ANGEW_GUIDELINES } from '../data/demo-content'

type View = 'list' | 'create' | 'edit'

function JournalTemplatesPage() {
  const { siliconflowApiKey, ai1Model } = useSettingsStore()
  const [view, setView] = useState<View>('list')
  const [templates, setTemplates] = useState<JournalTemplate[]>([])
  const [selectedTemplate, setSelectedTemplate] = useState<JournalTemplate | null>(null)
  const [loading, setLoading] = useState(true)
  const [isExtracting, setIsExtracting] = useState(false)
  const [extracted, setExtracted] = useState<ExtractedGuidelines | null>(null)

  // 表单状态
  const [formName, setFormName] = useState('')
  const [formShortName, setFormShortName] = useState('')
  const [formPublisher, setFormPublisher] = useState('')
  const [formJournalUrl, setFormJournalUrl] = useState('')
  const [formGuidelinesUrl, setFormGuidelinesUrl] = useState('')
  const [formGuidelinesContent, setFormGuidelinesContent] = useState('')
  const [formDocumentClass, setFormDocumentClass] = useState('article')
  const [formDocumentOptions, setFormDocumentOptions] = useState('')
  const [formPackages, setFormPackages] = useState('')
  const [formBibtexStyle, setFormBibtexStyle] = useState('unsrt')
  const [formTwoColumn, setFormTwoColumn] = useState(false)
  const [formFontSize, setFormFontSize] = useState(12)
  const [formTitleNote, setFormTitleNote] = useState('')
  const [formAbstractNote, setFormAbstractNote] = useState('')
  const [formRefNote, setFormRefNote] = useState('')
  const [formCustomPreamble, setFormCustomPreamble] = useState('')
  const [formNotes, setFormNotes] = useState('')

  // 加载模板列表
  const loadTemplates = async () => {
    setLoading(true)
    try {
      const list = await getAllTemplates()
      setTemplates(list)
    } catch (err) {
      toast.error('加载模板列表失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTemplates()
  }, [])

  // 重置表单
  const resetForm = () => {
    setFormName('')
    setFormShortName('')
    setFormPublisher('')
    setFormJournalUrl('')
    setFormGuidelinesUrl('')
    setFormGuidelinesContent('')
    setFormDocumentClass('article')
    setFormDocumentOptions('')
    setFormPackages('')
    setFormBibtexStyle('unsrt')
    setFormTwoColumn(false)
    setFormFontSize(12)
    setFormTitleNote('')
    setFormAbstractNote('')
    setFormRefNote('')
    setFormCustomPreamble('')
    setFormNotes('')
    setExtracted(null)
  }

  // 打开新建
  const openCreate = () => {
    resetForm()
    setView('create')
  }

  // 打开编辑
  const openEdit = (t: JournalTemplate) => {
    setSelectedTemplate(t)
    setFormName(t.name)
    setFormShortName(t.short_name || '')
    setFormPublisher(t.publisher || '')
    setFormJournalUrl(t.journal_url || '')
    setFormGuidelinesUrl(t.guidelines_url || '')
    setFormGuidelinesContent(t.guidelines_content || '')
    setFormDocumentClass(t.document_class)
    setFormDocumentOptions(t.document_options || '')
    setFormPackages(t.packages.join('\n'))
    setFormBibtexStyle(t.bibtex_style)
    setFormTwoColumn(t.two_column)
    setFormFontSize(t.font_size || 12)
    setFormTitleNote(t.title_format_note || '')
    setFormAbstractNote(t.abstract_format_note || '')
    setFormRefNote(t.reference_format_note || '')
    setFormCustomPreamble(t.custom_preamble || '')
    setFormNotes(t.notes || '')
    setExtracted(null)
    setView('edit')
  }

  // AI 提取
  const handleExtract = async () => {
    if (!formGuidelinesContent.trim()) {
      toast.error('请先粘贴投稿须知内容')
      return
    }
    if (!siliconflowApiKey.trim()) {
      toast.error('请先配置 AI API Key')
      return
    }

    setIsExtracting(true)
    try {
      const result = await extractGuidelinesWithAI({
        guidelinesText: formGuidelinesContent,
        baseUrl: SILICONFLOW_BASE_URL,
        apiKey: siliconflowApiKey,
        model: ai1Model,
      })

      setExtracted(result)

      // 应用到表单
      setFormName(result.name || formName)
      setFormShortName(result.short_name || formShortName)
      setFormPublisher(result.publisher || formPublisher)
      setFormDocumentClass(result.document_class)
      setFormDocumentOptions(result.document_options || '')
      setFormPackages(result.packages.join('\n'))
      setFormBibtexStyle(result.bibtex_style)
      setFormTwoColumn(result.two_column)
      setFormFontSize(result.font_size)
      setFormTitleNote(result.title_format_note || '')
      setFormAbstractNote(result.abstract_format_note || '')
      setFormRefNote(result.reference_format_note || '')
      setFormCustomPreamble(result.custom_preamble || '')

      toast.success('AI 提取完成，请核对结果')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`提取失败：${msg}`)
    } finally {
      setIsExtracting(false)
    }
  }

  // 保存（新建）
  const handleCreate = async () => {
    if (!formName.trim()) {
      toast.error('请填写期刊名称')
      return
    }

    try {
      const packages = formPackages
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

      const newTpl = await createTemplate({
        name: formName.trim(),
        short_name: formShortName.trim() || undefined,
        publisher: formPublisher.trim() || undefined,
        journal_url: formJournalUrl.trim() || undefined,
        guidelines_url: formGuidelinesUrl.trim() || undefined,
        guidelines_content: formGuidelinesContent || undefined,
      })

      // 再更新其他字段
      await updateTemplate(newTpl.id, {
        document_class: formDocumentClass,
        document_options: formDocumentOptions || undefined,
        packages,
        bibtex_style: formBibtexStyle,
        two_column: formTwoColumn,
        font_size: formFontSize,
        title_format_note: formTitleNote || undefined,
        abstract_format_note: formAbstractNote || undefined,
        reference_format_note: formRefNote || undefined,
        custom_preamble: formCustomPreamble || undefined,
        notes: formNotes || undefined,
      })

      toast.success('模板创建成功')
      await loadTemplates()
      setView('list')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`创建失败：${msg}`)
    }
  }

  // 保存（编辑）
  const handleUpdate = async () => {
    if (!selectedTemplate) return
    if (!formName.trim()) {
      toast.error('请填写期刊名称')
      return
    }

    try {
      const packages = formPackages
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)

      // 更新投稿须知（如果有变化）
      if (formGuidelinesContent !== (selectedTemplate.guidelines_content || '')) {
        await updateGuidelines(selectedTemplate.id, formGuidelinesContent)
      }

      await updateTemplate(selectedTemplate.id, {
        name: formName.trim(),
        short_name: formShortName.trim() || undefined,
        publisher: formPublisher.trim() || undefined,
        journal_url: formJournalUrl.trim() || undefined,
        guidelines_url: formGuidelinesUrl.trim() || undefined,
        document_class: formDocumentClass,
        document_options: formDocumentOptions || undefined,
        packages,
        bibtex_style: formBibtexStyle,
        two_column: formTwoColumn,
        font_size: formFontSize,
        title_format_note: formTitleNote || undefined,
        abstract_format_note: formAbstractNote || undefined,
        reference_format_note: formRefNote || undefined,
        custom_preamble: formCustomPreamble || undefined,
        notes: formNotes || undefined,
      })

      toast.success('模板更新成功')
      await loadTemplates()
      setView('list')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`更新失败：${msg}`)
    }
  }

  // 删除
  const handleDelete = async (t: JournalTemplate) => {
    if (!confirm(`确定要删除模板「${t.name}」吗？`)) return
    try {
      await deleteTemplate(t.id)
      toast.success('已删除')
      await loadTemplates()
    } catch {
      toast.error('删除失败')
    }
  }

  // ===== 列表视图 =====
  if (view === 'list') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50 to-purple-50">
        <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-20">
          <div className="max-w-5xl mx-auto px-4 md:px-6 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link
                to="/"
                className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition"
              >
                <ArrowLeft className="w-5 h-5" />
              </Link>
              <div>
                <span className="font-bold text-slate-800">期刊模板管理</span>
                <p className="text-xs text-slate-500 hidden sm:block">
                  自定义期刊投稿须知，AI 提取格式规范
                </p>
              </div>
            </div>
            <button
              onClick={openCreate}
              className="flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-lg text-sm font-medium hover:from-indigo-700 hover:to-purple-700 transition shadow-md shadow-indigo-200"
            >
              <Plus className="w-4 h-4" />
              新建模板
            </button>
          </div>
        </header>

        <main className="max-w-5xl mx-auto px-4 md:px-6 py-6">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
            </div>
          ) : templates.length === 0 ? (
            <div className="text-center py-20">
              <BookMarked className="w-16 h-16 mx-auto text-slate-300 mb-4" />
              <p className="text-slate-600 font-medium">还没有期刊模板</p>
              <p className="text-sm text-slate-500 mt-1">
                点击右上角「新建模板」，粘贴投稿须知，AI 自动提取格式规范
              </p>
              <div className="mt-6 flex items-center justify-center gap-3">
                <button
                  onClick={openCreate}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-lg font-medium hover:from-indigo-700 hover:to-purple-700 transition shadow-lg shadow-indigo-200"
                >
                  <Plus className="w-4 h-4" />
                  创建第一个模板
                </button>
                <button
                  onClick={async () => {
                    try {
                      const tpl = await createTemplate({
                        name: 'Angewandte Chemie Int. Ed. (演示)',
                        short_name: 'Angew. Chem. Int. Ed.',
                        publisher: 'Wiley-VCH',
                        guidelines_content: DEMO_ANGEW_GUIDELINES,
                      })
                      toast.success('演示模板已加载：Angewandte Chemie')
                      await loadTemplates()
                      openEdit(tpl)
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : String(err)
                      toast.error(`加载失败：${msg}`)
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 bg-white border border-indigo-200 text-indigo-600 rounded-lg font-medium hover:bg-indigo-50 transition"
                >
                  <Sparkles className="w-4 h-4" />
                  加载演示示例 (Angew)
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {templates.map((t) => (
                <div
                  key={t.id}
                  className="bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md transition overflow-hidden"
                >
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-slate-800 truncate">
                          {t.name}
                        </h3>
                        {t.short_name && (
                          <p className="text-sm text-slate-500">{t.short_name}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => openEdit(t)}
                          className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded transition"
                          title="编辑"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(t)}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition"
                          title="删除"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div className="flex items-center gap-1.5 text-slate-600">
                        <FileText className="w-3.5 h-3.5 text-slate-400" />
                        <span className="font-mono">{t.document_class}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-slate-600">
                        <Columns className="w-3.5 h-3.5 text-slate-400" />
                        <span>{t.two_column ? '双栏' : '单栏'}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-slate-600">
                        <Type className="w-3.5 h-3.5 text-slate-400" />
                        <span>{t.font_size || 12}pt</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-slate-600">
                        <Palette className="w-3.5 h-3.5 text-slate-400" />
                        <span className="font-mono text-xs truncate">{t.bibtex_style}</span>
                      </div>
                    </div>

                    {t.guidelines_content && (
                      <div className="mt-3 pt-3 border-t border-slate-100">
                        <div className="flex items-center gap-1.5 text-xs text-slate-500">
                          <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                          <span>已上传投稿须知</span>
                          {t.guidelines_last_updated_at && (
                            <span className="ml-auto">
                              {new Date(t.guidelines_last_updated_at).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-100">
                    <a
                      href={`/journal-format?template=${t.id}`}
                      className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                    >
                      用此模板排版 →
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    )
  }

  // ===== 新建/编辑视图 =====
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50 to-purple-50">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 md:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setView('list')}
              className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <span className="font-bold text-slate-800">
              {view === 'create' ? '新建期刊模板' : '编辑期刊模板'}
            </span>
          </div>
          <button
            onClick={view === 'create' ? handleCreate : handleUpdate}
            className="flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-lg text-sm font-medium hover:from-indigo-700 hover:to-purple-700 transition shadow-md shadow-indigo-200"
          >
            <Save className="w-4 h-4" />
            保存
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 md:px-6 py-6 space-y-6">
        {/* 基本信息 */}
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <h2 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <BookMarked className="w-5 h-5 text-indigo-600" />
            基本信息
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                期刊名称 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="如：Angewandte Chemie International Edition"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                期刊简称
              </label>
              <input
                type="text"
                value={formShortName}
                onChange={(e) => setFormShortName(e.target.value)}
                placeholder="如：Angew. Chem. Int. Ed."
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                出版社
              </label>
              <input
                type="text"
                value={formPublisher}
                onChange={(e) => setFormPublisher(e.target.value)}
                placeholder="如：Wiley-VCH"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                期刊主页
              </label>
              <input
                type="url"
                value={formJournalUrl}
                onChange={(e) => setFormJournalUrl(e.target.value)}
                placeholder="https://..."
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                投稿须知 URL
              </label>
              <input
                type="url"
                value={formGuidelinesUrl}
                onChange={(e) => setFormGuidelinesUrl(e.target.value)}
                placeholder="https://..."
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
          </div>
        </section>

        {/* 投稿须知 */}
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-slate-800 flex items-center gap-2">
              <FileText className="w-5 h-5 text-indigo-600" />
              投稿须知
            </h2>
            <button
              onClick={handleExtract}
              disabled={isExtracting || !formGuidelinesContent.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-lg text-sm font-medium hover:from-indigo-700 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {isExtracting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
              {isExtracting ? 'AI 提取中...' : 'AI 提取格式规范'}
            </button>
          </div>

          <textarea
            value={formGuidelinesContent}
            onChange={(e) => setFormGuidelinesContent(e.target.value)}
            placeholder="在此粘贴投稿须知内容...

支持：
- 直接粘贴网页文字
- 从 Word 复制的文字
- PDF 转的纯文本
- Markdown 格式

粘贴后点击「AI 提取格式规范」自动提取排版参数。"
            className="w-full h-64 px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 font-mono text-sm resize-y"
            spellCheck={false}
          />

          <p className="mt-2 text-xs text-slate-500">
            💡 提示：投稿须知一般变化很小，粘贴一次保存后可反复使用。后续排版时系统会基于此文件的规范生成 LaTeX。
          </p>

          {/* AI 提取结果概览 */}
          {extracted && (
            <div className="mt-4 p-4 bg-indigo-50 border border-indigo-200 rounded-lg">
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle2 className="w-5 h-5 text-green-600" />
                <span className="font-medium text-slate-800">AI 提取结果</span>
              </div>
              <div className="text-sm text-slate-600 mb-3">
                <span className="font-medium">置信度：</span>
                {extracted.confidence_note}
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-medium text-slate-700">关键格式点：</p>
                <ul className="text-sm text-slate-600 space-y-1 list-disc list-inside">
                  {extracted.key_points.slice(0, 8).map((point, i) => (
                    <li key={i}>{point}</li>
                  ))}
                </ul>
              </div>
              <p className="mt-3 text-xs text-indigo-600">
                ✓ 已自动填入下方表格，请检查并手动修正不准确的部分
              </p>
            </div>
          )}
        </section>

        {/* LaTeX 排版参数 */}
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <h2 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <Palette className="w-5 h-5 text-indigo-600" />
            LaTeX 排版参数
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                文档类 (documentclass)
              </label>
              <input
                type="text"
                value={formDocumentClass}
                onChange={(e) => setFormDocumentClass(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 font-mono"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                文档选项
              </label>
              <input
                type="text"
                value={formDocumentOptions}
                onChange={(e) => setFormDocumentOptions(e.target.value)}
                placeholder="如：twocolumn,12pt"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 font-mono"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                引用样式 (BibTeX style)
              </label>
              <input
                type="text"
                value={formBibtexStyle}
                onChange={(e) => setFormBibtexStyle(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 font-mono"
              />
            </div>
            <div className="flex items-end gap-4 pb-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formTwoColumn}
                  onChange={(e) => setFormTwoColumn(e.target.checked)}
                  className="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500"
                />
                <span className="text-sm text-slate-700">双栏排版</span>
              </label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-700">字号</span>
                <input
                  type="number"
                  value={formFontSize}
                  onChange={(e) => setFormFontSize(Number(e.target.value))}
                  className="w-16 px-2 py-1.5 border border-slate-300 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 text-sm"
                  min={8}
                  max={14}
                />
                <span className="text-sm text-slate-500">pt</span>
              </div>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                宏包列表（每行一个）
              </label>
              <textarea
                value={formPackages}
                onChange={(e) => setFormPackages(e.target.value)}
                placeholder="amsmath&#10;amssymb&#10;graphicx&#10;booktabs"
                className="w-full h-24 px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 font-mono text-sm resize-y"
                spellCheck={false}
              />
            </div>
          </div>
        </section>

        {/* 格式说明 */}
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <h2 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-indigo-600" />
            格式说明（给排版 AI 看）
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                标题格式说明
              </label>
              <input
                type="text"
                value={formTitleNote}
                onChange={(e) => setFormTitleNote(e.target.value)}
                placeholder="标题大小写、字体、层级要求..."
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                摘要格式说明
              </label>
              <input
                type="text"
                value={formAbstractNote}
                onChange={(e) => setFormAbstractNote(e.target.value)}
                placeholder="摘要位置、字数限制、格式..."
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                参考文献格式说明
              </label>
              <input
                type="text"
                value={formRefNote}
                onChange={(e) => setFormRefNote(e.target.value)}
                placeholder="排序方式、编号格式、缩写规则..."
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                自定义前置代码 (preamble)
              </label>
              <textarea
                value={formCustomPreamble}
                onChange={(e) => setFormCustomPreamble(e.target.value)}
                placeholder="% 特殊宏包定义、命令重定义等..."
                className="w-full h-20 px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 font-mono text-sm resize-y"
                spellCheck={false}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                备注
              </label>
              <textarea
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                placeholder="个人备注、特殊注意事项..."
                className="w-full h-16 px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 text-sm resize-y"
              />
            </div>
          </div>
        </section>

        {/* 底部操作 */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => setView('list')}
            className="flex items-center gap-1.5 px-4 py-2 text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition"
          >
            <X className="w-4 h-4" />
            取消
          </button>
          <button
            onClick={view === 'create' ? handleCreate : handleUpdate}
            className="flex items-center gap-1.5 px-6 py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-lg font-medium hover:from-indigo-700 hover:to-purple-700 transition shadow-lg shadow-indigo-200"
          >
            <Save className="w-4 h-4" />
            保存模板
          </button>
        </div>
      </main>
    </div>
  )
}

export default JournalTemplatesPage
