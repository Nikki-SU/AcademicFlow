/**
 * 会议/课程页 · 左栏：任务层级树（固定，不可移动）
 * -------------------------------------------------
 * 用 loadProjects() 的结果按 parentId 串成树；根任务按根 id 着色（同根同色）。
 * 点击节点 = 切换「当前任务」（useTaskStore.setCurrentProject）。
 */
import { Link } from 'react-router-dom'
import { ListTree } from 'lucide-react'
import type { Project } from '../../services/projectData'
import { colorForRoot, getRootId } from '../../services/taskColors'
import { Panel, PanelHeader, PanelBody, EmptyState } from '../ui/Panel'

/** 排序：有 DDL 的按 dueAt 升序在前，无 DDL 的排后，再按标题 */
function sortProjects(list: Project[]): Project[] {
  return [...list].sort((a, b) => {
    const da = a.dueAt || Number.MAX_SAFE_INTEGER
    const db = b.dueAt || Number.MAX_SAFE_INTEGER
    if (da !== db) return da - db
    return (a.title || '').localeCompare(b.title || '')
  })
}

function TreeNode({
  project,
  depth,
  byId,
  childrenByParent,
  currentId,
  onSelect,
  seen,
}: {
  project: Project
  depth: number
  byId: Map<string, Project>
  childrenByParent: Map<string, Project[]>
  currentId: string | null
  onSelect: (id: string) => void
  seen: Set<string>
}) {
  if (seen.has(project.projectId)) return null
  seen.add(project.projectId)

  const color = colorForRoot(getRootId(project, byId))
  const children = childrenByParent.get(project.projectId) ?? []
  const isCurrent = project.projectId === currentId

  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(project.projectId)}
        style={{ paddingLeft: `calc(${depth} * var(--ui-indent) + var(--ui-gap-sm))` }}
        className={`flex w-full items-center gap-ui-gap-sm rounded-control-sm py-1 pr-ui-gap-sm text-left transition ${
          isCurrent ? 'bg-seal-50 ring-1 ring-seal-300' : 'hover:bg-paper-100'
        }`}
      >
        <span className={`h-ui-dot w-ui-dot shrink-0 rounded-full ${color.bg}`} />
        <span className={`min-w-0 flex-1 truncate text-ui-sm ${color.text} ${isCurrent ? 'font-medium' : ''}`}>
          {project.title || '(未命名任务)'}
        </span>
      </button>
      {children.map((c) => (
        <TreeNode
          key={c.projectId}
          project={c}
          depth={depth + 1}
          byId={byId}
          childrenByParent={childrenByParent}
          currentId={currentId}
          onSelect={onSelect}
          seen={seen}
        />
      ))}
    </div>
  )
}

export default function SessionTaskTree({
  projects,
  currentId,
  isLoading,
  onSelect,
}: {
  projects: Project[]
  currentId: string | null
  isLoading: boolean
  onSelect: (id: string) => void
}) {
  const byId = new Map<string, Project>()
  for (const p of projects) byId.set(p.projectId, p)

  const childrenByParent = new Map<string, Project[]>()
  const roots: Project[] = []
  for (const p of projects) {
    if (!p.parentId || !byId.has(p.parentId)) {
      roots.push(p)
    } else {
      const arr = childrenByParent.get(p.parentId)
      if (arr) arr.push(p)
      else childrenByParent.set(p.parentId, [p])
    }
  }
  for (const [k, arr] of childrenByParent) childrenByParent.set(k, sortProjects(arr))

  return (
    <Panel>
      <PanelHeader icon={<ListTree />} title="任务" />
      <PanelBody>
        {isLoading ? (
          <p className="py-6 text-center text-ui-xs text-ink-400">加载中…</p>
        ) : roots.length === 0 ? (
          <EmptyState
            icon={<ListTree />}
            title="还没有任务"
            hint={
              <Link to="/schedule" className="text-seal-600 hover:underline">
                去日程页新建 →
              </Link>
            }
          />
        ) : (
          <div className="space-y-0.5">
            {sortProjects(roots).map((p) => (
              <TreeNode
                key={p.projectId}
                project={p}
                depth={0}
                byId={byId}
                childrenByParent={childrenByParent}
                currentId={currentId}
                onSelect={onSelect}
                seen={new Set()}
              />
            ))}
          </div>
        )}
      </PanelBody>
    </Panel>
  )
}
