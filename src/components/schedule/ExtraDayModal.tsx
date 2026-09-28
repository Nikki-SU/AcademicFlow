/**
 * 添加调休日
 * -------------------------------------------------
 * 用户挑一个**周末日期**（周六/周日）→ 记为工作日，课程表里会为它出现一列。
 * 这里只做「非空」校验；周末判定 / 去重交给页面（要连 toast 一起处理）。
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Modal } from './Modal'

export function ExtraDayModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void
  onSubmit: (date: string, note: string) => void
}) {
  const [date, setDate] = useState('')
  const [note, setNote] = useState('')

  const handleSubmit = () => {
    if (!date) {
      toast.warning('请选择调休日期')
      return
    }
    onSubmit(date, note.trim())
  }

  return (
    <Modal
      title="添加调休日"
      onClose={onClose}
      footer={
        <>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-ink-600 hover:bg-ink-100 rounded-lg transition"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            className="px-4 py-2 text-sm text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-lg transition font-medium"
          >
            添加
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-ink-700 mb-1.5">
            日期（周末 · 周六 / 周日）
          </label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-ink-700 mb-1.5">备注</label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="如：国庆调休上班（可留空）"
            className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
          />
        </div>
      </div>
    </Modal>
  )
}
