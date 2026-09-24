/**
 * PDF 快速上传组件
 * -------------------------------------------------
 * 独立组件：支持在看板、管理页后台任务面板等处快速上传 PDF 入库 + MinerU 转换。
 * 两种用法：
 *   A) <PdfQuickUploadButton> — 自带触发按钮，点了弹出确认 modal
 *   B) <PdfQuickUploadModal open onClose> — 被外部控制 open/close
 */
import { useState, useRef } from 'react'
import { Upload, X, CheckCircle2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { normalizeDoi, getCitationEntries } from '../services/citation'
import { loadLiteratures, saveLiteratures, inferPaperTier, type Literature } from '../services/literatureData'
import { enqueuePaperMineruConvert } from '../services/paperPipeline'

interface UploadLogicProps {
  pdf: File | null
  doi: string
  title: string
  setDoi: (s: string) => void
  setTitle: (s: string) => void
  setPdf: (f: File | null) => void
  onSuccess?: (doi: string, title: string) => void
  onCancel: () => void
}

/** 内部共用：执行入库 + MinerU 入队逻辑 */
async function doUpload(props: UploadLogicProps) {
  const { pdf, doi, title, setDoi, setTitle, setPdf, onSuccess, onCancel } = props
  if (!pdf) return

  // ---- 基础文件校验 ----
  if (pdf.size < 1024) {
    toast.error('PDF 文件过小（< 1KB），可能是损坏文件')
    return
  }
  if (pdf.size > 100 * 1024 * 1024) {
    toast.error('PDF 文件过大（> 100MB），暂不支持')
    return
  }
  const isLikelyPdf =
    pdf.type === 'application/pdf' ||
    pdf.name.toLowerCase().endsWith('.pdf')
  if (!isLikelyPdf) {
    toast.error('请选择 PDF 文件')
    return
  }

  const normalized = normalizeDoi(doi)
  if (!normalized.valid || !normalized.doi) {
    toast.error('请输入有效的 DOI')
    return
  }
  const finalTitle = title.trim() || pdf.name.replace(/\.pdf$/i, '')

  try {
    const lits = await loadLiteratures()
    const exists = lits.some((l) => l.doi === normalized.doi)
    if (!exists) {
      const now = Date.now()
      const newLit: Literature = {
        doi: normalized.doi,
        title: finalTitle,
        journal: '', year: 0, authors: '', keywords: '',
        abstractEn: '', abstractCn: '',
        // 按标题自动推断一级（原创研究）/ 二级（综述）；之后可在编辑弹窗手改
        tier: inferPaperTier(finalTitle),
        hasGraphicalAbstract: false, addedAt: now, pdfAddedAt: now,
        source: 'PDF', trackingGroup: '', mdStatus: 'none',
      }
      await saveLiteratures([...lits, newLit])
      toast.success(`已入库：${finalTitle}`)
    } else {
      toast.message(`文献已在库中：${finalTitle}`)
    }
    const result = await enqueuePaperMineruConvert(normalized.doi, pdf, finalTitle)
    if (result.ok) onSuccess?.(normalized.doi, finalTitle)
    onCancel()
    setPdf(null); setDoi(''); setTitle('')
  } catch (err) {
    toast.error(`上传失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 确认弹窗（纯 UI，被外部控制 open/close） */
export function PdfQuickUploadModal(props: {
  open: boolean
  onClose: () => void
  onSuccess?: (doi: string, title: string) => void
}) {
  const { open, onClose, onSuccess } = props
  const [pendingPdf, setPendingPdf] = useState<File | null>(null)
  const [doi, setDoi] = useState('')
  const [title, setTitle] = useState('')
  const [autoResolving, setAutoResolving] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Modal 关闭时清空
  if (!open) {
    // 不 return null — 让 state 在 open=true 时保持
    return null
  }

  const onPickPdf = (file: File) => {
    setPendingPdf(file)
    setTitle(file.name.replace(/\.pdf$/i, ''))
    setDoi('')
  }

  const tryAutoFill = async () => {
    const normalized = normalizeDoi(doi)
    if (!normalized.valid || !normalized.doi) { toast.error('请先输入 DOI'); return }
    setAutoResolving(true)
    try {
      const { entries, failed } = await getCitationEntries([normalized.doi])
      if (failed.length === 0 && entries[0]) {
        setTitle(entries[0].title || title)
        toast.success(`已自动获取标题`)
      } else {
        toast.warning('DOI 解析失败，请手动填写')
      }
    } catch { toast.warning('DOI 解析出错') }
    finally { setAutoResolving(false) }
  }

  const handleConfirm = () => {
    if (!pendingPdf) return
    void doUpload({
      pdf: pendingPdf, doi, title,
      setDoi, setTitle, setPdf: setPendingPdf,
      onSuccess, onCancel: onClose,
    })
  }

  const handleClose = () => {
    setPendingPdf(null); setDoi(''); setTitle('')
    if (fileRef.current) fileRef.current.value = ''
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-900/40 p-4">
      <div className="bg-paper-50 rounded-xl shadow-2xl w-full max-w-md p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-seal-50 flex items-center justify-center">
            <Upload className="w-5 h-5 text-seal-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-semibold text-ink-800">PDF 上传入库</h4>
            <p className="text-xs text-ink-500 truncate">
              {pendingPdf
                ? `${pendingPdf.name} · ${Math.round(pendingPdf.size / 1024)} KB`
                : '请选择 PDF 文件'}
            </p>
          </div>
          <button onClick={handleClose} className="p-1.5 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded-lg transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 第一步：选 PDF */}
        {!pendingPdf && (
          <label className="block cursor-pointer">
            <div className="border-2 border-dashed border-ink-200 rounded-lg p-8 text-center hover:border-seal-400 hover:bg-seal-50/30 transition">
              <Upload className="w-10 h-10 mx-auto mb-3 text-ink-300" />
              <p className="text-sm text-ink-600">点击选择 PDF 文件</p>
              <p className="text-xs text-ink-400 mt-1">支持拖拽到此区域（或点选）</p>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) onPickPdf(f)
                  e.target.value = ''
                }}
              />
            </div>
          </label>
        )}

        {/* 第二步：填 DOI + 标题 */}
        {pendingPdf && (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-ink-600 mb-1">
                DOI <span className="text-red-500">*</span>
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={doi}
                  onChange={(e) => setDoi(e.target.value)}
                  placeholder="10.1039/c3cs60076a"
                  className="flex-1 px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
                  autoFocus
                />
                <button
                  onClick={tryAutoFill}
                  disabled={!doi.trim() || autoResolving}
                  className="px-3 py-2 text-xs text-seal-600 bg-seal-50 hover:bg-seal-100 disabled:opacity-50 rounded-lg transition whitespace-nowrap"
                >
                  {autoResolving ? '解析...' : '自动获取'}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-600 mb-1">标题（可选）</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="留空用文件名"
                className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
              />
            </div>

            <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
              ⚠️ 上传后自动调用 MinerU 转换为 Markdown
            </div>

            <div className="flex items-center justify-between gap-2 mt-5">
              <button
                onClick={() => { setPendingPdf(null); if (fileRef.current) fileRef.current.value = '' }}
                className="px-3 py-2 text-sm text-ink-500 hover:text-ink-700 transition"
              >
                ← 重新选择
              </button>
              <div className="flex gap-2">
                <button onClick={handleClose} className="px-4 py-2 text-sm text-ink-600 hover:bg-ink-100 rounded-lg transition">
                  取消
                </button>
                <button
                  onClick={handleConfirm}
                  disabled={!doi.trim()}
                  className="flex items-center gap-2 px-4 py-2 text-sm text-paper-50 bg-gradient-to-r from-seal-600 to-seal-700 hover:from-seal-700 hover:to-seal-800 disabled:opacity-50 rounded-lg transition"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  入库并上传
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** 便捷：自带触发按钮的完整封装（点 + 自动弹窗） */
export function PdfQuickUploadButton(props: {
  /** 按钮内容（ReactNode），默认显示"+ 上传 PDF" */
  children?: React.ReactNode
  onSuccess?: (doi: string, title: string) => void
}) {
  const { children, onSuccess } = props
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs text-seal-600 bg-seal-50 hover:bg-seal-100 rounded-md transition"
      >
        {children ?? (<><Plus className="w-3.5 h-3.5" />上传 PDF</>)}
      </button>
      <PdfQuickUploadModal open={open} onClose={() => setOpen(false)} onSuccess={onSuccess} />
    </>
  )
}
