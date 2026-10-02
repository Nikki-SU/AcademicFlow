/**
 * 任务选择器（两个条：大类 + 归属任务）
 * -------------------------------------------------
 * 「新建任务」「加定时任务」共用（用户明确要求的两层选择逻辑）：
 * - 第一个条：大类 —— 研究 / 课程，**必须显式选择**（无默认值，避免静默变成某一类）；
 * - 第二个条：把这个任务归结为「该大类」下的哪一个任务，**只列同大类的任务**；
 *   留空 = 它自己就是该大类下的**顶级任务**。
 * 刻意**不预选任何任务**（不给「默认任务」），避免造成「已经归属于某个任务」的误解。
 * 切换大类时，若原先选中的任务不属于新大类，自动清空归属。
 */
import type { Project, ProjectType } from '../../services/projectData'

/** 可选的归属父任务（label 已按层级缩进） */
export interface ParentOption {
  id: string
  label: string
  type: ProjectType
}

const TYPE_LABEL: Record<ProjectType, string> = { research: '研究', course: '课程' }

/**
 * 把任务平铺成「带层级缩进」的归属候选（DFS 顺序，与任务列表同序）。
 * 父节点缺失 / 成环的节点也会兜底列入，保证都能选到。
 */
export function buildParentOptions(projects: Project[]): ParentOption[] {
  const ids = new Set(projects.map((p) => p.projectId))
  const byTitle = (a: Project, b: Project) => (a.title || '').localeCompare(b.title || '')
  const childrenByParent = new Map<string, Project[]>()
  const roots: Project[] = []
  for (const p of projects) {
    if (!p.parentId || !ids.has(p.parentId)) {
      roots.push(p)
    } else {
      const arr = childrenByParent.get(p.parentId)
      if (arr) arr.push(p)
      else childrenByParent.set(p.parentId, [p])
    }
  }
  for (const [k, arr] of childrenByParent) childrenByParent.set(k, [...arr].sort(byTitle))
  roots.sort(byTitle)

  const out: ParentOption[] = []
  const seen = new Set<string>()
  const walk = (p: Project, depth: number) => {
    if (seen.has(p.projectId)) return
    seen.add(p.projectId)
    out.push({
      id: p.projectId,
      type: p.type,
      label: `${'　'.repeat(depth)}${depth ? '└ ' : ''}${p.title || '(未命名任务)'}`,
    })
    for (const c of childrenByParent.get(p.projectId) ?? []) walk(c, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  for (const p of projects) if (!seen.has(p.projectId)) walk(p, 0)
  return out
}

export function TaskPicker({
  parentOptions,
  type,
  onTypeChange,
  parentId,
  onParentChange,
  allowTopLevel = true,
}: {
  parentOptions: ParentOption[]
  /** '' = 尚未选择大类 */
  type: ProjectType | ''
  onTypeChange: (t: ProjectType | '') => void
  /** '' = 不归属任何任务，即该大类下的顶级任务 */
  parentId: string
  onParentChange: (id: string) => void
  /** 是否允许留空（留空 = 该大类下的顶级任务）；编辑已有时段时不允许 */
  allowTopLevel?: boolean
}) {
  const sameType = type ? parentOptions.filter((o) => o.type === type) : []

  const handleType = (next: ProjectType | '') => {
    onTypeChange(next)
    // 原归属不属于新大类 → 清空，避免跨大类挂错
    const cur = parentOptions.find((o) => o.id === parentId)
    if (!next || (cur && cur.type !== next)) onParentChange('')
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-ink-700 mb-1.5">大类</label>
        <select
          value={type}
          onChange={(e) => handleType(e.target.value as ProjectType | '')}
          className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm bg-paper-50 focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
        >
          <option value="">请选择大类…</option>
          <option value="research">研究</option>
          <option value="course">课程</option>
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-ink-700 mb-1.5">
          归属任务{' '}
          <span className="font-normal text-ink-400">
            {type && allowTopLevel ? `（留空即为「${TYPE_LABEL[type]}」下的顶级任务）` : ''}
          </span>
        </label>
        <select
          value={parentId}
          disabled={!type}
          onChange={(e) => onParentChange(e.target.value)}
          className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm bg-paper-50 focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 disabled:bg-ink-50 disabled:text-ink-400"
        >
          <option value="">
            {!type
              ? '请先选择大类'
              : allowTopLevel
                ? `无 —— 作为「${TYPE_LABEL[type]}」下的顶级任务`
                : '请选择任务…'}
          </option>
          {sameType.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
      </div>
    </div>
  )
}