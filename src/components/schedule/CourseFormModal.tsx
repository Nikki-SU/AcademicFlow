/**
 * 加课表单（课程表某一列）
 * -------------------------------------------------
 * 只负责收集输入，不碰数据层 —— 持久化交给页面（Schedule.tsx），
 * 这样课程表的每个列都能复用它。
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Modal } from './Modal'

export interface CourseFormValue {
  title: string
  startTime: string
  endTime: string
  location: string
}

export function CourseFormModal({
  weekdayLabel,
  onClose,
  onSubmit,
}: {
  weekdayLabel: string
  onClose: () => void
  onSubmit: (value: CourseFormValue) => void
}) {
  const [title, setTitle] = useState('')
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [location, setLocation] = useState('')

  const handleSubmit = () => {
    const name = title.trim()
    if (!name) {
      toast.warning('请填写课程名称')
      return
    }
    if (!startTime || !endTime) {
      toast.warning('请填写开始与结束时间')
      return
    }
    if (endTime < startTime) {
      toast.warning('结束时间不能早于开始时间')
      return
    }
    onSubmit({ title: name, startTime, endTime, location: location.trim() })
  }

  return (
    <Modal
      title={`加课 · ${weekdayLabel}`}
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
          <label className="block text-sm font-medium text-ink-700 mb-1.5">课程名称</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="如：高等数学"
            autoFocus
            className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1.5">开始时间</label>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1.5">结束时间</label>
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-ink-700 mb-1.5">地点</label>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="如：三教 201（可留空）"
            className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
          />
        </div>
      </div>
    </Modal>
  )
}
