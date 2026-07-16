/**
 * 期刊排版页面 — Markdown → LaTeX AI 转换
 * -------------------------------------------------
 * 布局：左右分栏
 * - 左侧：Markdown 输入 + 期刊选择 + 转换按钮
 * - 右侧：LaTeX 预览 + BibTeX 预览（tab 切换）
 */
import { useState, useEffect, useCallback } from 'react'
import {
  BookOpen,
  ChevronDown,
  Copy,
  Download,
  FileText,
  Loader2,
  Sparkles,
  BookMarked,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Settings,
  X,
  Key,
  Eye,
  FileDown,
} from 'lucide-react'
import { toast } from 'sonner'
import { useSettingsStore } from '../stores/settings'
import { convertMarkdownToLatex, type LatexConvertProgress } from '../services/latex-converter'
import { getAllTemplates } from '../services/journal-templates'
import type { JournalTemplate, LatexConversionResult } from '../types'
import { SILICONFLOW_BASE_URL } from '../services/ai/models'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { DEMO_JACS_MARKDOWN } from '../data/demo-content'
import katex from 'katex'
import 'katex/dist/katex.min.css'

/** 示例 Markdown — JACS 2024 李志平课题组论文（演示用） */
const SAMPLE_MARKDOWN = DEMO_JACS_MARKDOWN

const CITATION_SORT_OPTIONS = [
  { value: 'appearance', label: '按出现顺序' },
  { value: 'author-year', label: '按作者-年份' },
  { value: 'alphabetical', label: '按标题字母' },
] as const

function JournalFormatPage() {
  const { siliconflowApiKey, ai1Model, ai2Model } = useSettingsStore()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [templates, setTemplates] = useState<JournalTemplate[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('')
  const [markdown, setMarkdown] = useState(SAMPLE_MARKDOWN)
  const [result, setResult] = useState<LatexConversionResult | null>(null)
  const [isConverting, setIsConverting] = useState(false)
  const [progressStage, setProgressStage] = useState<Parameters<LatexConvertProgress>[0]['stage'] | null>(null)
  const [progressMessage, setProgressMessage] = useState('')
  const [activeTab, setActiveTab] = useState<'latex' | 'bibtex' | 'preview'>('latex')
  const [showTemplateDropdown, setShowTemplateDropdown] = useState(false)
  const [sortMode, setSortMode] = useState<'appearance' | 'author-year' | 'alphabetical'>('appearance')
  const [showQuickSettings, setShowQuickSettings] = useState(false)
  const [tempApiKey, setTempApiKey] = useState('')

  // 加载模板列表
  useEffect(() => {
    const load = async () => {
      try {
        const list = await getAllTemplates()
        setTemplates(list)

        // 从 URL 参数读取模板 ID
        const tplId = searchParams.get('template')
        if (tplId && list.find((t) => t.id === tplId)) {
          setSelectedTemplateId(tplId)
        } else if (list.length > 0) {
          setSelectedTemplateId(list[0].id)
        }
      } catch {
        // 加载失败就保持空列表
      }
    }
    load()
  }, [searchParams])

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId)

  // 转换处理
  const handleConvert = useCallback(async () => {
    if (!selectedTemplate) {
      toast.error('请先选择期刊模板')
      return
    }
    if (!siliconflowApiKey.trim()) {
      toast.error('请先在设置页填写 AI API Key')
      return
    }

    setIsConverting(true)
    setResult(null)

    try {
      const aiConfig = {
        baseUrl: SILICONFLOW_BASE_URL,
        apiKey: siliconflowApiKey,
        model: ai1Model,
      }

      const res = await convertMarkdownToLatex({
        markdown,
        template: selectedTemplate,
        ai1: aiConfig,
        ai2: {
          baseUrl: SILICONFLOW_BASE_URL,
          apiKey: siliconflowApiKey,
          model: ai2Model,
        },
        citationSortMode: sortMode,
        enableReview: true,
        onProgress: (p) => {
          setProgressStage(p.stage)
          setProgressMessage(p.message || '')
        },
      })

      setResult(res)
      toast.success(
        `转换完成！${res.citation_entries.length} 篇引用解析成功，${res.failed_dois.length} 篇失败`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`转换失败：${msg}`)
    } finally {
      setIsConverting(false)
      setProgressStage(null)
    }
  }, [markdown, selectedTemplate, siliconflowApiKey, ai1Model, ai2Model, sortMode])

  // 复制到剪贴板
  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${label} 已复制到剪贴板`)
    } catch {
      toast.error('复制失败')
    }
  }

  // 下载文件
  const handleDownload = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  // 用 KaTeX 渲染 LaTeX 公式为 HTML
  const renderLatexPreview = (latex: string): string => {
    // 移除 documentclass、usepackage 等 preamble
    let body = latex
      .replace(/\\documentclass(\[.*?\])?\{.*?\}/g, '')
      .replace(/\\usepackage(\[.*?\])?\{.*?\}/g, '')
      .replace(/\\begin\{document\}/g, '')
      .replace(/\\end\{document\}/g, '')
      .replace(/\\bibliographystyle\{.*?\}/g, '')
      .replace(/\\bibliography\{.*?\}/g, '')

    // 渲染行内公式 $...$
    body = body.replace(/\$([^$\n]+?)\$/g, (_, formula) => {
      try {
        return katex.renderToString(formula, { throwOnError: false, displayMode: false })
      } catch {
        return `$${formula}$`
      }
    })

    // 渲染块级公式 $$...$$
    body = body.replace(/\$\$([\s\S]+?)\$\$/g, (_, formula) => {
      try {
        return katex.renderToString(formula, { throwOnError: false, displayMode: true })
      } catch {
        return `$$${formula}$$`
      }
    })

    // 渲染 \[...\] 块级公式
    body = body.replace(/\\\[([\s\S]+?)\\\]/g, (_, formula) => {
      try {
        return katex.renderToString(formula, { throwOnError: false, displayMode: true })
      } catch {
        return `\\[${formula}\\]`
      }
    })

    // 渲染 \\(...\\) 行内公式
    body = body.replace(/\\\((.+?)\\\)/g, (_, formula) => {
      try {
        return katex.renderToString(formula, { throwOnError: false, displayMode: false })
      } catch {
        return `\\(${formula}\\)`
      }
    })

    // 简单的文本格式化
    body = body
      .replace(/\\title\{(.+?)\}/g, '<h1 class="text-2xl font-bold text-center mb-4">$1</h1>')
      .replace(/\\section\{(.+?)\}/g, '<h2 class="text-xl font-bold mt-6 mb-3">$1</h2>')
      .replace(/\\subsection\{(.+?)\}/g, '<h3 class="text-lg font-semibold mt-4 mb-2">$1</h3>')
      .replace(/\\textbf\{(.+?)\}/g, '<strong>$1</strong>')
      .replace(/\\textit\{(.+?)\}/g, '<em>$1</em>')
      .replace(/\\cite\{(.+?)\}/g, '<sup class="text-indigo-600">[$1]</sup>')
      .replace(/\\begin\{abstract\}([\s\S]+?)\\end\{abstract\}/g, '<div class="bg-slate-50 p-4 rounded-lg mb-4 text-sm"><p class="font-semibold mb-2">Abstract</p>$1</div>')
      .replace(/\\begin\{itemize\}([\s\S]+?)\\end\{itemize\}/g, '<ul class="list-disc pl-6 my-2">$1</ul>')
      .replace(/\\begin\{enumerate\}([\s\S]+?)\\end\{enumerate\}/g, '<ol class="list-decimal pl-6 my-2">$1</ol>')
      .replace(/\\item\s/g, '<li>')
      .replace(/\\par/g, '</p><p>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\\newline/g, '<br/>')
      .replace(/\\\\/g, '<br/>')

    // 兜底：所有剩余 \\command 变成普通文本
    body = body.replace(/\\([a-zA-Z]+)(\{.*?\})?/g, (_match, _cmd, arg) => {
      if (arg) return arg.slice(1, -1)
      return ''
    })

    return `<div class="latex-preview"><p>${body}</p></div>`
  }

  // PDF 导出：打开打印对话框
  const handleExportPDF = () => {
    if (!result) return
    const previewHtml = renderLatexPreview(result.latex)
    const printWindow = window.open('', '_blank')
    if (!printWindow) {
      toast.error('请允许弹出窗口以导出 PDF')
      return
    }
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>AcademicFlow - LaTeX Preview</title>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
        <style>
          body { font-family: 'Times New Roman', serif; max-width: 800px; margin: 40px auto; padding: 20px; line-height: 1.6; }
          h1 { text-align: center; font-size: 24px; margin-bottom: 20px; }
          h2 { font-size: 18px; margin-top: 24px; margin-bottom: 12px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
          h3 { font-size: 16px; margin-top: 16px; margin-bottom: 8px; }
          p { margin: 8px 0; text-align: justify; }
          .katex { font-size: 1.1em; }
          sup { color: #4f46e5; }
          @media print { body { margin: 0; padding: 20px; } }
        </style>
      </head>
      <body>
        ${previewHtml}
        <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666;">
          <p><strong>References (BibTeX):</strong></p>
          <pre style="white-space: pre-wrap; font-size: 10px; background: #f5f5f5; padding: 10px; border-radius: 4px;">${result.bibtex.replace(/</g, '&lt;')}</pre>
        </div>
        <script>window.onload = function() { setTimeout(function() { window.print(); }, 500); };</script>
      </body>
      </html>
    `)
    printWindow.document.close()
    toast.success('PDF 预览已打开，请使用浏览器的"另存为 PDF"功能下载')
  }

  const stageLabels: Record<string, string> = {
    extracting_citations: '提取引用',
    fetching_citation_data: '获取文献元数据',
    ai_converting: 'AI 格式转换',
    ai_reviewing: 'AI 格式审查',
    assembling: '组装文档',
    done: '完成',
    error: '出错',
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50 to-purple-50">
      {/* 顶栏 */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-[1600px] mx-auto px-4 md:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-1.5 bg-indigo-100 rounded-md">
              <BookOpen className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <span className="font-bold text-slate-800">AcademicFlow · 期刊排版</span>
              <p className="text-xs text-slate-500 hidden sm:block">AI 驱动的 Markdown → LaTeX 期刊格式转换</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setTempApiKey(siliconflowApiKey)
                setShowQuickSettings(true)
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition"
            >
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">API 设置</span>
              {siliconflowApiKey ? (
                <span className="w-2 h-2 bg-green-500 rounded-full" title="已配置" />
              ) : (
                <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" title="未配置" />
              )}
            </button>
            <Link
              to="/"
              className="text-sm text-slate-600 hover:text-indigo-600 px-3 py-1.5 rounded-md hover:bg-indigo-50 transition"
            >
              返回首页
            </Link>
          </div>
        </div>
      </header>

      {/* 快捷设置模态框 */}
      {showQuickSettings && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <Key className="w-5 h-5 text-indigo-600" />
                <span className="font-semibold text-slate-800">API 设置</span>
              </div>
              <button
                onClick={() => setShowQuickSettings(false)}
                className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  硅基流动 API Key
                </label>
                <input
                  type="text"
                  value={tempApiKey}
                  onChange={(e) => setTempApiKey(e.target.value)}
                  placeholder="sk-xxxxxxxxxxxxxxxx"
                  className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-sm font-mono focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                  spellCheck={false}
                />
                <p className="text-xs text-slate-500 mt-1.5">
                  用于 AI 格式转换和引用解析。在{' '}
                  <a
                    href="https://siliconflow.cn"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-indigo-600 hover:underline"
                  >
                    硅基流动
                  </a>{' '}
                  注册获取。
                </p>
              </div>
              <div className="pt-2">
                <button
                  onClick={async () => {
                    await useSettingsStore.getState().updateSettings({
                      siliconflowApiKey: tempApiKey.trim(),
                    })
                    setShowQuickSettings(false)
                    toast.success('API Key 已保存')
                  }}
                  className="w-full py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-lg font-medium hover:from-indigo-700 hover:to-purple-700 transition"
                >
                  保存设置
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 主内容区：左右分栏 */}
      <main className="max-w-[1600px] mx-auto px-4 md:px-6 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ===== 左侧：输入区 ===== */}
          <div className="space-y-4">
            {/* 期刊选择 + 排序方式 */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 space-y-4">
              <div className="flex items-start gap-4">
                {/* 期刊选择 */}
                <div className="flex-1">
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    <BookMarked className="w-4 h-4 inline mr-1.5 -mt-0.5" />
                    目标期刊
                  </label>
                  <div className="relative">
                    <button
                      onClick={() => setShowTemplateDropdown(!showTemplateDropdown)}
                      className="w-full flex items-center justify-between px-3 py-2.5 border border-slate-300 rounded-lg bg-white hover:border-indigo-400 transition text-left"
                      disabled={isConverting}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-slate-800 truncate">
                          {selectedTemplate?.name || '选择期刊模板...'}
                        </div>
                        {selectedTemplate && (
                          <div className="text-xs text-slate-500 truncate">
                            {selectedTemplate.document_class} · {selectedTemplate.two_column ? '双栏' : '单栏'} · {selectedTemplate.bibtex_style}
                          </div>
                        )}
                      </div>
                      <ChevronDown className="w-4 h-4 text-slate-400 ml-2 flex-shrink-0" />
                    </button>

                    {showTemplateDropdown && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-30 max-h-64 overflow-y-auto">
                        {templates.length === 0 ? (
                          <div className="px-3 py-4 text-center">
                            <p className="text-sm text-slate-500">还没有期刊模板</p>
                            <button
                              onClick={() => {
                                setShowTemplateDropdown(false)
                                navigate('/journal-templates')
                              }}
                              className="mt-2 text-sm text-indigo-600 hover:text-indigo-800 font-medium"
                            >
                              去创建模板 →
                            </button>
                          </div>
                        ) : (
                          <>
                            {templates.map((t) => (
                              <button
                                key={t.id}
                                onClick={() => {
                                  setSelectedTemplateId(t.id)
                                  setShowTemplateDropdown(false)
                                }}
                                className={`w-full px-3 py-2.5 text-left hover:bg-indigo-50 transition border-b border-slate-100 last:border-b-0 ${
                                  t.id === selectedTemplateId ? 'bg-indigo-50' : ''
                                }`}
                              >
                                <div className="font-medium text-slate-800">{t.name}</div>
                                <div className="text-xs text-slate-500">
                                  {t.document_class} · {t.two_column ? '双栏' : '单栏'} · {t.bibtex_style}
                                </div>
                              </button>
                            ))}
                            <div className="px-3 py-2 border-t border-slate-100 bg-slate-50">
                              <button
                                onClick={() => {
                                  setShowTemplateDropdown(false)
                                  navigate('/journal-templates')
                                }}
                                className="text-xs text-indigo-600 hover:text-indigo-800 font-medium w-full text-left"
                              >
                                管理所有模板 →
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* 排序方式 */}
                <div className="w-40">
                  <label className="block text-sm font-medium text-slate-700 mb-2">
                    引用排序
                  </label>
                  <select
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value as typeof sortMode)}
                    className="w-full px-3 py-2.5 border border-slate-300 rounded-lg bg-white text-sm focus:outline-none focus:border-indigo-400"
                    disabled={isConverting}
                  >
                    {CITATION_SORT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 期刊详情 */}
              {selectedTemplate && (
                <div className="pt-3 border-t border-slate-100 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                  <div>
                    <div className="text-slate-500">出版社</div>
                    <div className="font-medium text-slate-700">{selectedTemplate.publisher || '-'}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">文档类</div>
                    <div className="font-mono text-slate-700">{selectedTemplate.document_class}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">排版</div>
                    <div className="font-medium text-slate-700">
                      {selectedTemplate.two_column ? '双栏' : '单栏'}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500">引用样式</div>
                    <div className="font-mono text-slate-700 truncate">{selectedTemplate.bibtex_style}</div>
                  </div>
                </div>
              )}
            </div>

            {/* Markdown 编辑器 */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 bg-slate-50">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-slate-500" />
                  <span className="text-sm font-medium text-slate-700">Markdown 原稿</span>
                </div>
                <button
                  onClick={() => setMarkdown(SAMPLE_MARKDOWN)}
                  className="text-xs text-slate-500 hover:text-indigo-600 flex items-center gap-1"
                  disabled={isConverting}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  恢复示例
                </button>
              </div>
              <textarea
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                placeholder="在此粘贴 Markdown 格式的论文内容...

支持的引用格式：
- [@doi:10.1038/nature12345]
- [@10.1038/nature12345]
- https://doi.org/10.1038/nature12345"
                className="w-full h-[500px] p-4 font-mono text-sm text-slate-800 bg-white resize-none focus:outline-none"
                disabled={isConverting}
                spellCheck={false}
              />
            </div>

            {/* 转换按钮 */}
            <div className="flex items-center gap-3">
              <button
                onClick={handleConvert}
                disabled={isConverting || !markdown.trim() || !selectedTemplate}
                className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl font-medium hover:from-indigo-700 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition shadow-lg shadow-indigo-200"
              >
                {isConverting ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    {progressMessage || '转换中...'}
                  </>
                ) : (
                  <>
                    <Sparkles className="w-5 h-5" />
                    AI 转换为 LaTeX
                  </>
                )}
              </button>
            </div>

            {/* 进度条 */}
            {isConverting && progressStage && (
              <div className="bg-white rounded-lg border border-indigo-200 p-3">
                <div className="flex items-center gap-2 text-sm text-indigo-700">
                  <div className="w-2 h-2 bg-indigo-500 rounded-full animate-pulse" />
                  <span className="font-medium">{stageLabels[progressStage] || progressStage}</span>
                  <span className="text-indigo-500 ml-auto">{progressMessage}</span>
                </div>
              </div>
            )}
          </div>

          {/* ===== 右侧：输出区 ===== */}
          <div className="space-y-4">
            {/* 引用统计 */}
            {result && (
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <div className="text-2xl font-bold text-indigo-600">{result.citations.length}</div>
                    <div className="text-xs text-slate-500">检测到引用</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-green-600 flex items-center justify-center gap-1">
                      <CheckCircle2 className="w-5 h-5" />
                      {result.citation_entries.length}
                    </div>
                    <div className="text-xs text-slate-500">解析成功</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-red-500 flex items-center justify-center gap-1">
                      {result.failed_dois.length > 0 && <AlertCircle className="w-5 h-5" />}
                      {result.failed_dois.length}
                    </div>
                    <div className="text-xs text-slate-500">解析失败</div>
                  </div>
                </div>
              </div>
            )}

            {/* Tab 切换 */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="flex items-center border-b border-slate-200 bg-slate-50">
                <button
                  onClick={() => setActiveTab('latex')}
                  className={`flex-1 px-4 py-2.5 text-sm font-medium transition ${
                    activeTab === 'latex'
                      ? 'text-indigo-600 bg-white border-b-2 border-indigo-600'
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  LaTeX 源码
                </button>
                <button
                  onClick={() => setActiveTab('bibtex')}
                  className={`flex-1 px-4 py-2.5 text-sm font-medium transition ${
                    activeTab === 'bibtex'
                      ? 'text-indigo-600 bg-white border-b-2 border-indigo-600'
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  BibTeX
                  {result && (
                    <span className="ml-1.5 text-xs text-slate-400">
                      ({result.citation_entries.length})
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setActiveTab('preview')}
                  className={`flex-1 px-4 py-2.5 text-sm font-medium transition ${
                    activeTab === 'preview'
                      ? 'text-indigo-600 bg-white border-b-2 border-indigo-600'
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  <Eye className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
                  预览
                </button>

                <div className="flex items-center gap-1 pr-3">
                  {activeTab === 'preview' && result && (
                    <button
                      onClick={handleExportPDF}
                      className="flex items-center gap-1 px-2 py-1 text-xs text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50 rounded transition"
                      title="导出 PDF"
                    >
                      <FileDown className="w-3.5 h-3.5" />
                      PDF
                    </button>
                  )}
                  <button
                    onClick={() => {
                      if (activeTab === 'latex' && result) {
                        handleCopy(result.latex, 'LaTeX')
                      } else if (activeTab === 'bibtex' && result) {
                        handleCopy(result.bibtex, 'BibTeX')
                      }
                    }}
                    disabled={!result || activeTab === 'preview'}
                    className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-white rounded transition disabled:opacity-50"
                    title="复制"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => {
                      if (activeTab === 'latex' && result) {
                        handleDownload(result.latex, 'manuscript.tex')
                      } else if (activeTab === 'bibtex' && result) {
                        handleDownload(result.bibtex, 'references.bib')
                      }
                    }}
                    disabled={!result || activeTab === 'preview'}
                    className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-white rounded transition disabled:opacity-50"
                    title="下载"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* 内容区 */}
              <div className="h-[500px] overflow-auto">
                {result ? (
                  activeTab === 'preview' ? (
                    <div
                      className="p-6 bg-white text-slate-800"
                      dangerouslySetInnerHTML={{ __html: renderLatexPreview(result.latex) }}
                    />
                  ) : (
                    <pre className="p-4 text-sm font-mono text-slate-100 leading-relaxed bg-slate-900">
                      {activeTab === 'latex' ? result.latex : result.bibtex}
                    </pre>
                  )
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-slate-500 bg-slate-900">
                    <Sparkles className="w-12 h-12 mb-3 opacity-30" />
                    <p className="text-sm">点击「AI 转换为 LaTeX」按钮开始</p>
                    <p className="text-xs mt-1 text-slate-600">
                      左侧输入 Markdown → 选择期刊 → 一键生成符合格式的 LaTeX
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* 解析成功的引用列表 */}
            {result && result.citation_entries.length > 0 && (
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50">
                  <span className="text-sm font-medium text-slate-700">引用列表</span>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {result.citation_entries.map((entry, idx) => (
                    <div
                      key={entry.doi}
                      className="px-4 py-3 border-b border-slate-100 last:border-b-0 hover:bg-slate-50 transition"
                    >
                      <div className="flex items-start gap-3">
                        <span className="flex-shrink-0 w-6 h-6 bg-indigo-100 text-indigo-700 rounded-full text-xs font-medium flex items-center justify-center mt-0.5">
                          {idx + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-slate-800 line-clamp-2">
                            {entry.title || '（无标题）'}
                          </div>
                          <div className="text-xs text-slate-500 mt-1">
                            {entry.authors.slice(0, 3).map((a) => a.split(',')[0]).join(', ')}
                            {entry.authors.length > 3 && ' et al.'}
                            {entry.year ? ` · ${entry.year}` : ''}
                            {entry.journal ? ` · ${entry.journal}` : ''}
                          </div>
                          <a
                            href={`https://doi.org/${entry.doi}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-indigo-500 hover:text-indigo-700 font-mono mt-1 inline-block truncate max-w-full"
                          >
                            https://doi.org/{entry.doi}
                          </a>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 失败的引用 */}
            {result && result.failed_dois.length > 0 && (
              <div className="bg-red-50 rounded-xl border border-red-200 p-4">
                <div className="flex items-center gap-2 text-red-700 mb-2">
                  <AlertCircle className="w-4 h-4" />
                  <span className="text-sm font-medium">以下 DOI 解析失败</span>
                </div>
                <ul className="text-xs text-red-600 space-y-1 font-mono">
                  {result.failed_dois.map((doi) => (
                    <li key={doi}>{doi}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

export default JournalFormatPage
