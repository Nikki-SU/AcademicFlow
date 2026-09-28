/**
 * 日程页弹层外壳
 * -------------------------------------------------
 * 课程 / 调休 / 新建任务 / 任务详情 四个弹层共用同一套遮罩 + 卡片 + 头尾，
 * 抽出来免得各写一份（样式与 Tracking.tsx 的弹层保持一致）。
 * `maxWidth` 传 Tailwind 字面量类名（如 max-w-lg），JIT 才能扫到。
 */
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

export function Modal({
  title,
  onClose,
  children,
  footer,
  maxWidth = 'max-w-lg',
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  maxWidth?: string
}) {
  return (
    <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center z-50 p-4">
      <div
        className={`bg-paper-50 rounded-xl shadow-xl w-full ${maxWidth} max-h-[85vh] flex flex-col`}
      >
        <div className="flex items-center justify-between p-5 border-b border-ink-200">
          <h3 className="font-semibold text-ink-800">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 text-ink-400 hover:text-ink-600 transition"
            aria-label="关闭"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 p-5 border-t border-ink-200">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
