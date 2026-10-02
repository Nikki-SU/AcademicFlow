/**
 * 新建任务 / 子任务表单
 * -------------------------------------------------
 * 两种入口共用：右侧「+ 新建任务」（选大类 + 归属任务；不选归属即该大类下的顶级任务）
 * 与每行的「+ 子任务」（归属锁定为父节点，继承其大类，不显示选择条）。只收集输入，落库交给页面。
 *
 * 任务归属用两层选择（TaskPicker）：① 大类（研究 / 课程）② 该大类下的归属任务（可留空）。
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Modal } from './Modal'
import { TaskPicker, type ParentOption } from './TaskPicker'
import type { ProjectType } from '../../services/projectData'

export type { ParentOption }

export interface TaskFormValue {
  title: string
  type: ProjectType
  dueAt: number
  parentId: string | null
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
  /** null = 不预选大类（新建任务时让用户显式选）；子任务入口传父节点的大类 */
  initialType: ProjectType | null
  initialParentId: string | null
  parentOptions: ParentOption[]
  onClose: () => void
  onSubmit: (value: TaskFormValue) => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<ProjectType | ''>(initialType ?? '')
  const [due, setDue] = useState('')
  const [parentId, setParentId] = useState(initialParentId ?? '')

  // 选了归属任务就继承它的大类，避免父子类型打架
  const parent = parentOptions.find((o) => o.id === parentId)
  const effectiveType: ProjectType | '' = parent ? parent.type : type

  const handleSubmit = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.warning('请填写任务名称')
      return
    }
    if (!effectiveType) {
      toast.warning('请选择大类')
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
          <TaskPicker
            parentOptions={parentOptions}
            type={type}
            onTypeChange={setType}
            parentId={parentId}
            onParentChange={setParentId}
          />
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