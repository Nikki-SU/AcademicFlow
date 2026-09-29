/**
 * 新建任务 / 子任务表单
 * -------------------------------------------------
 * 两种入口共用：右侧顶部的「+ 新建任务」（选大类，可指定归属父任务；不选即顶级任务）
 * 与每行的「+ 子任务」（继承父节点，不显示大类与归属选择）。只收集输入，落库交给页面。
 */
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Modal } from './Modal'
import type { ProjectType } from '../../services/projectData'

export interface TaskFormValue {
  title: string
  type: ProjectType
  dueAt: number
  parentId: string | null
}

/** 可选的归属父任务（label 已按层级缩进） */
export interface ParentOption {
  id: string
  label: string
  type: ProjectType
}

/** datetime-local 的值（YYYY-MM-DDTHH:MM）→ Unix ms */
function toMs(local: string): number {
  const t = new Date(local).getTime()
  return Number.isNaN(t) ? 0 : t
}

export function TaskFormModal({
  title,
  showType,
  initialType,
  initialParentId,
  parentOptions,
  onClose,
  onSubmit,
}: {
  title: string
  showType: boolean
  initialType: ProjectType
  initialParentId: string | null
  parentOptions: ParentOption[]
  onClose: () => void
  onSubmit: (value: TaskFormValue) => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<ProjectType>(initialType)
  const [due, setDue] = useState('')
  const [parentId, setParentId] = useState(initialParentId ?? '')

  const parent = useMemo(
    () => (parentId ? parentOptions.find((o) => o.id === parentId) : undefined),
    [parentId, parentOptions],
  )
  // 选了归属父任务就继承它的大类，避免父子类型打架
  const effectiveType = parent ? parent.type : type

  const handleSubmit = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.warning('请填写任务名称')
      return
    }
    const dueAt = toMs(due)
    if (!dueAt) {
      toast.warning('请选择截止时间')
      return
    }
    onSubmit({ title: trimmed, type: effectiveType, dueAt, parentId: parentId || null })
  }

  return (
    <Modal
      title={title}
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
            创建
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {showType && (
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1.5">归属任务</label>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm bg-paper-50 focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
            >
              <option value="">无（作为顶级任务）</option>
              {parentOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>
        )}
        {showType && !parent && (
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1.5">大类</label>
            <div className="flex gap-2">
              {(['research', 'course'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setType(t)}
                  className={`px-4 py-2 text-sm rounded-lg border transition ${
                    type === t
                      ? 'border-seal-400 bg-seal-50 text-seal-700 font-medium'
                      : 'border-ink-200 text-ink-600 hover:border-ink-300'
                  }`}
                >
                  {t === 'research' ? '研究' : '课程'}
                </button>
              ))}
            </div>
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-ink-700 mb-1.5">任务名称</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：完成第三章初稿"
            autoFocus
            className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-ink-700 mb-1.5">截止时间</label>
          <input
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
          />
        </div>
      </div>
    </Modal>
  )
}
