/**
 * 添加调休日
 * -------------------------------------------------
 * 用户挑一个**周末日期**（周六/周日）→ 记为工作日，并指定它**按周几的课表**上课
 * （补班日实际上的可能是某工作日的课）。
 * 这里只做「非空」校验；周末判定 / 去重交给页面（要连 toast 一起处理）。
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { WEEKDAY_LABELS } from '../../services/scheduleData'
import { Modal } from './Modal'

export function ExtraDayModal({
  onClose,
  onSubmit,
  defaultWeekday = 0,
}: {
  onClose: () => void
  onSubmit: (date: string, note: string, followWeekday: number) => void
  /** 是否为官方补班日预填的默认「按周几」 */
  defaultWeekday?: number
}) {
  const [date, setDate] = useState('')
  const [note, setNote] = useState('')
  const [followWeekday, setFollowWeekday] = useState(defaultWeekday)

  const handleSubmit = () => {
    if (!date) {
      toast.warning('请选择调休日期')
      return
    }
    if (!(followWeekday >= 1 && followWeekday <= 7)) {
      toast.warning('请选择补班当天按周几上课')
      return
    }
    onSubmit(date, note.trim(), followWeekday)
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
          <label className="block text-sm font-medium text-ink-700 mb-1.5">
            按周几的课表上课
          </label>
          <select
            value={followWeekday}
            onChange={(e) => setFollowWeekday(Number(e.target.value))}
            className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm bg-paper-50 focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
          >
            <option value={0}>未指定（当天不排课）</option>
            {[1, 2, 3, 4, 5, 6, 7].map((w) => (
              <option key={w} value={w}>
                {WEEKDAY_LABELS[w]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-400">
            调休补班这天实际按哪一天的课表上课（学校通知里通常会写明）。
          </p>
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