/**
 * DDL 任务要求弹层（只读）
 * -------------------------------------------------
 * 用户要求：点 DDL 卡片弹出的**就是且只是任务要求**（只读展示），
 * 编辑走弹层右上「编辑」→ 统一编辑窗。与任务栏行内面板共用 TaskRequirementsView。
 */
import type { Project } from '../../services/projectData'
import { Modal } from './Modal'
import { TaskRequirementsView } from './TaskRequirementsView'

export function TaskRequirementsModal({
  project,
  parentTitle,
  onClose,
  onEdit,
}: {
  project: Project
  /** 归属任务名；顶级任务为 null */
  parentTitle: string | null
  onClose: () => void
  /** 打开统一编辑窗（同时关闭本弹层） */
  onEdit: () => void
}) {
  return (
    <Modal title={project.title || '(未命名任务)'} onClose={onClose}>
      <TaskRequirementsView project={project} parentTitle={parentTitle} onEdit={onEdit} />
    </Modal>
  )
}
