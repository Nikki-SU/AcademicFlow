/**
 * MinerU 结果面板（M3.7 子组件）
 * -------------------------------------------------
 * 全流程 done 后展示：md 大小 / 图片数 / batch_id / 各阶段耗时 / 交叉验证
 * 提供下载 md、预览 md 头 2KB、预览首图三个操作
 */
import {
  CheckCircle2,
  FileText,
  ImageIcon,
  Timer,
  Upload,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MineruStage, MineruTestResult } from '../../types'
import { STAGE_LABEL } from './mineru-stages'

function StatCard(props: {
  icon: JSX.Element
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="p-2 bg-white border border-slate-200 rounded">
      <div className="flex items-center gap-1 text-slate-500 mb-0.5">
        {props.icon}
        <span>{props.label}</span>
      </div>
      <div
        className={`text-slate-800 font-semibold ${props.mono ? 'font-mono' : ''}`}
      >
        {props.value}
      </div>
    </div>
  )
}

export function MineruResultPanel(props: {
  result: MineruTestResult
  totalMs: number
}) {
  const { result, totalMs } = props
  const imageCount = Object.keys(result.images).length
  const [showMdPreview, setShowMdPreview] = useState(false)
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string | null>(null)

  const firstImageName = Object.keys(result.images)[0]

  const handleShowImage = () => {
    if (!firstImageName) return
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl)
    const url = URL.createObjectURL(result.images[firstImageName])
    setPreviewObjectUrl(url)
  }

  const handleDownloadMd = () => {
    const blob = new Blob([result.markdown], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${result.fileName.replace(/\.pdf$/i, '')}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  useEffect(() => {
    return () => {
      if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl)
    }
  }, [previewObjectUrl])

  return (
    <div className="p-4 bg-green-50 border border-green-200 rounded-md space-y-3">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-green-800">
        <CheckCircle2 className="w-4 h-4" />
        全流程通过
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <StatCard
          icon={<FileText className="w-3.5 h-3.5" />}
          label="Markdown"
          value={`${(result.markdown.length / 1024).toFixed(1)} KB`}
        />
        <StatCard
          icon={<ImageIcon className="w-3.5 h-3.5" />}
          label="图片"
          value={`${imageCount} 张`}
        />
        <StatCard
          icon={<Timer className="w-3.5 h-3.5" />}
          label="总耗时"
          value={`${(totalMs / 1000).toFixed(1)} s`}
        />
        <StatCard
          icon={<Upload className="w-3.5 h-3.5" />}
          label="Batch ID"
          value={result.batchId.slice(0, 8) + '…'}
          mono
        />
      </div>

      {/* 交叉验证 */}
      <div className="text-xs text-slate-600 space-y-0.5">
        <div>
          交叉验证：markdown 引用图片
          <b> {imageCount - result.orphanImages.length} </b>
          / zip 提供
          <b> {imageCount} </b>
          {result.missingImages.length === 0 ? (
            <span className="text-green-700 ml-1">✓ 引用全部对上</span>
          ) : (
            <span className="text-red-700 ml-1">
              ⚠ {result.missingImages.length} 张引用缺失
            </span>
          )}
        </div>
        {result.orphanImages.length > 0 && (
          <div className="text-slate-500">
            {result.orphanImages.length} 张孤儿图（layout 分析副产物，非致命）
          </div>
        )}
      </div>

      {/* 耗时分布 */}
      <div className="text-xs text-slate-500 space-y-0.5">
        {(Object.entries(result.timing) as [MineruStage, number][]).map(
          ([k, v]) => (
            <div key={k} className="flex justify-between font-mono">
              <span>{STAGE_LABEL[k]}</span>
              <span>{(v / 1000).toFixed(2)}s</span>
            </div>
          ),
        )}
      </div>

      {/* 操作 */}
      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={handleDownloadMd}
          className="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md hover:bg-slate-50"
        >
          下载 Markdown
        </button>
        <button
          type="button"
          onClick={() => setShowMdPreview((s) => !s)}
          className="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md hover:bg-slate-50"
        >
          {showMdPreview ? '收起' : '预览'} Markdown（前 2KB）
        </button>
        {imageCount > 0 && (
          <button
            type="button"
            onClick={handleShowImage}
            className="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md hover:bg-slate-50"
          >
            {previewObjectUrl ? '刷新' : '预览'}首图
          </button>
        )}
      </div>

      {showMdPreview && (
        <pre className="p-2 max-h-64 overflow-auto bg-white border border-slate-200 rounded text-xs whitespace-pre-wrap break-all">
          {result.markdown.slice(0, 2048)}
          {result.markdown.length > 2048 ? '\n\n... (截断)' : ''}
        </pre>
      )}
      {previewObjectUrl && (
        <img
          src={previewObjectUrl}
          alt={firstImageName}
          className="max-h-64 border border-slate-200 rounded"
        />
      )}
    </div>
  )
}
