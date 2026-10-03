/**
 * 任务行内详情面板（点任务文字展开）—— 只读「任务要求」
 * -------------------------------------------------
 * 用户要求：点任务条目展开后，**弹出的就是且只是任务要求**（只读展示），
 * 编辑一律走行内的「笔」→ 统一编辑窗，不在这个小面板里就地编辑。
 * （此前这里放着一堆行内可编辑控件 —— 那是错的，已移除。）
 *
 * 内容与 DDL 弹层共用 TaskRequirementsView，保证两处「点开看到的东西」一致。
 */
import type { Project } from '../../services/projectData'
import { TaskRequirementsView } from './TaskRequirementsView'

export function TaskExpandPanel({
  project,
  parentTitle,
  onEdit,
}: {
  project: Project
  /** 归属任务名；顶级任务为 null */
  parentTitle: string | null
  /** 打开统一编辑窗（「笔」的同一个入口） */
  onEdit: () => void
}) {
  return (
    <div className="mb-1 ml-ui-indent rounded-lg border border-ink-200 bg-paper-50 p-ui-gap-sm">
      <TaskRequirementsView project={project} parentTitle={parentTitle} onEdit={onEdit} />
    </div>
  )
}
