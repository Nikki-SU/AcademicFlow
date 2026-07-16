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
  Loader2,
  Timer,
  Upload,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import JSZip from 'jszip'
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
  const [isZipping, setIsZipping] = useState(false)
  const [blobUrls, setBlobUrls] = useState<Record<string, string>>({})

  const firstImageName = Object.keys(result.images)[0]

  // 为预览创建 blob URL 映射（images/xxx.jpg → blob:...）
  useEffect(() => {
    const urls: Record<string, string> = {}
    for (const [name, blob] of Object.entries(result.images)) {
      urls[name] = URL.createObjectURL(blob)
    }
    setBlobUrls(urls)
    return () => {
      Object.values(urls).forEach(URL.revokeObjectURL)
    }
  }, [result.images])

  const handleShowImage = () => {
    if (!firstImageName) return
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl)
    const url = URL.createObjectURL(result.images[firstImageName])
    setPreviewObjectUrl(url)
  }

  const handleDownloadZip = async () => {
    setIsZipping(true)
    try {
      const zip = new JSZip()
      const baseName = result.fileName.replace(/\.pdf$/i, '')
      // 用 PDF 文件名命名 markdown，而不是 MinerU 默认的 full.md
      zip.file(`${baseName}.md`, result.markdown)
      const imgFolder = zip.folder('images')
      for (const [name, blob] of Object.entries(result.images)) {
        // 去掉 images/ 前缀，只存文件名
        const imgName = name.replace(/^images\//, '')
        imgFolder?.file(imgName, blob)
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${baseName}_mineru.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } finally {
      setIsZipping(false)
    }
  }

  /** 把 Blob 转为 base64 data URI */
  const blobToDataUri = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  /** 下载单文件 Markdown，图片以 base64 内嵌 */
  const handleDownloadInlineMd = async () => {
    setIsZipping(true)
    try {
      let md = result.markdown
      for (const [name, blob] of Object.entries(result.images)) {
        const dataUri = await blobToDataUri(blob)
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        md = md.replace(new RegExp(escaped, 'g'), dataUri)
      }
      const blob = new Blob([md], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${result.fileName.replace(/\.pdf$/i, '')}_inline.md`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } finally {
      setIsZipping(false)
    }
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
          onClick={handleDownloadZip}
          disabled={isZipping}
          className="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md hover:bg-slate-50
                     disabled:opacity-50 disabled:cursor-wait flex items-center gap-1.5"
        >
          {isZipping ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              打包中...
            </>
          ) : (
            '下载 ZIP（MD + 图片文件夹）'
          )}
        </button>
        <button
          type="button"
          onClick={handleDownloadInlineMd}
          disabled={isZipping}
          className="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md hover:bg-slate-50
                     disabled:opacity-50 disabled:cursor-wait flex items-center gap-1.5"
        >
          {isZipping ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              内嵌中...
            </>
          ) : (
            '下载单文件 MD（图片内嵌，适合分享）'
          )}
        </button>
        <button
          type="button"
          onClick={() => setShowMdPreview((s) => !s)}
          className="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-md hover:bg-slate-50"
        >
          {showMdPreview ? '收起' : '预览'}（含图片渲染）
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
        <div className="space-y-2">
          <pre className="p-2 max-h-48 overflow-auto bg-white border border-slate-200 rounded text-xs whitespace-pre-wrap break-all">
            {result.markdown.slice(0, 4096)}
            {result.markdown.length > 4096 ? '\n\n... (截断，完整内容请下载 ZIP)' : ''}
          </pre>
          {imageCount > 0 && (
            <div className="p-2 bg-white border border-slate-200 rounded">
              <p className="text-xs text-slate-500 mb-2">图片预览（共 {imageCount} 张，展示前 12 张）</p>
              <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
                {Object.entries(result.images).slice(0, 12).map(([name]) => (
                  <img
                    key={name}
                    src={blobUrls[name] ?? ''}
                    alt={name}
                    className="w-full h-24 object-contain border border-slate-200 rounded"
                    title={name}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
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
