/**
 * PDF → Markdown 页面（占位）
 * 功能：MinerU API 转换 PDF 为 Markdown
 */
import { Upload, FileText, Image, AlertCircle } from 'lucide-react'

export default function PdfToMdPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-800">PDF 转 Markdown</h1>
        <p className="text-sm text-slate-500 mt-1">上传 PDF，MinerU 自动转换为 Markdown（保留图片和公式）</p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-8">
        <div className="border-2 border-dashed border-slate-300 rounded-xl p-12 text-center hover:border-indigo-300 transition">
          <Upload className="w-12 h-12 mx-auto mb-4 text-slate-300" />
          <p className="text-sm font-medium text-slate-600 mb-1">拖拽 PDF 到此处，或点击上传</p>
          <p className="text-xs text-slate-400">支持 ≤200 页，超出自动拆分</p>
        </div>

        <div className="mt-6 flex items-start gap-2 p-3 bg-amber-50 rounded-lg text-sm">
          <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-amber-700">
            <p>需要在设置中配置 MinerU API Key 才能使用此功能</p>
          </div>
        </div>
      </div>
    </div>
  )
}
