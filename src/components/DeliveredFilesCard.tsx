/**
 * 「已交付文件」卡片（阅读页问 AI / 写作页 AI 助手共用）
 * -------------------------------------------------
 * AI 把成篇成果作为独立文件交付后，前端会把它注册成全局「其他文档」并归入当前任务。
 * 这张卡片把「交付了什么、放到哪了」显式摊给用户看 —— 否则 AI 的产出成了一堆
 * 用户不知道存在、也找不到的文件。
 *
 * 只展示、不跳转：条目本身落进「其他文档」库（本任务下），用户在那里统一浏览。
 */
import { FileText, Paperclip } from 'lucide-react'
import type { DeliveredFileChip } from '../services/ai/deliveredFiles'

export type { DeliveredFileChip }

export function DeliveredFilesCard({ files }: { files: DeliveredFileChip[] }) {
  if (files.length === 0) return null
  return (
    <div className="mt-1.5 rounded-control border border-ink-200 bg-paper-50 px-ui-gap py-1.5">
      <div className="flex items-center gap-1 text-ui-2xs text-ink-500">
        <Paperclip className="w-3 h-3 flex-shrink-0" />
        <span>已交付 {files.length} 个文件（存入「其他文档」· 归属本任务）</span>
      </div>
      <ul className="mt-1 space-y-0.5">
        {files.map((f, i) => (
          <li key={i} className="flex items-center gap-1 text-ui-xs text-ink-700 min-w-0">
            <FileText className="w-3 h-3 flex-shrink-0 text-ink-400" />
            <span className="truncate" title={f.title || '（AI 未给标题）'}>
              {f.title || '（AI 未给标题）'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
