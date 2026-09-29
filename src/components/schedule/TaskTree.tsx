/**
 * 日程页 · 任务列表（层级 / 系列）
 * -------------------------------------------------
 * 与 DDL 清单**分框**：DDL 是扁平的（按时间排），任务列表保留**层级与系列**
 * —— 用 parentId 串成树，点节点即切「当前任务」。
 * 同根同色（colorForRoot），与课程表 / DDL 全局一致。
 */
import { useState } from 'react'
import { ListTree, Plus } from 'lucide-react'
import type { Project } from '../../services/projectData'
import { colorForRoot, getRootId } from '../../services/taskColors'

function byDueThenTitle(a: Project, b: Project): number {
  const da = a.dueAt || Number.MAX_SAFE_INTEGER
  const db = b.dueAt || Number.MAX_SAFE_INTEGER
  if (da !== db) return da - db
  return (a.title || '').localeCompare(b.title || '')
}

/** 一行：任务 + 其缩进深度（DFS 展开，避免递归渲染的坑） */
interface Row {
  project: Project
  depth: number
}

export function TaskTree({
  projects,
  currentId,
  isLoading,
  onSelect,
  onNewRoot,
  onAddChild,
}: {
  projects: Project[]
  currentId: string | null
  isLoading: boolean
  onSelect: (id: string) => void
  onNewRoot: () => void
  onAddChild: (parent: Project) => void
}) {
  const [collapsed, setCollapsed] = useState(false)

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
  for (const [k, arr] of childrenByParent) childrenByParent.set(k, [...arr].sort(byDueThenTitle))
  roots.sort(byDueThenTitle)

  // DFS 展平成有序行；用一个 visited 兜底，异常数据（环 / 重复）也不会死循环
  const rows: Row[] = []
  const visited = new Set<string>()
  const walk = (p: Project, depth: number) => {
    if (visited.has(p.projectId)) return
    visited.add(p.projectId)
    rows.push({ project: p, depth })
    for (const c of childrenByParent.get(p.projectId) ?? []) walk(c, depth + 1)
  }
  for (const r of roots) walk(r, 0)

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-ink-200 bg-paper-50">
      <div className="flex items-center justify-between gap-ui-gap border-b border-ink-100 px-ui-gap py-ui-gap-sm">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-ui-gap-sm text-ui-sm font-semibold text-ink-800"
        >
          <ListTree className="h-ui-icon w-ui-icon text-seal-600" />
          任务
          <span className="text-ui-xs font-normal text-ink-400">（{projects.length}）</span>
        </button>
        <button
          onClick={onNewRoot}
          className="rounded bg-seal-600 px-ui-gap-sm py-ui-gap-sm text-ui-xs font-medium text-paper-50 transition hover:bg-seal-700"
        >
          + 新建任务
        </button>
      </div>

      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-y-auto p-ui-gap-sm">
          {isLoading ? (
            <p className="py-6 text-center text-ui-xs text-ink-400">加载中…</p>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-ui-xs text-ink-400">还没有任务</p>
          ) : (
            rows.map(({ project, depth }) => {
              const color = colorForRoot(getRootId(project, byId))
              const isCurrent = project.projectId === currentId
              return (
                <div
                  key={project.projectId}
                  style={{ paddingLeft: `calc(${depth} * var(--ui-indent))` }}
                  className={`group flex items-center gap-ui-gap-sm rounded-md pr-1 transition ${
                    isCurrent ? 'bg-seal-50 ring-1 ring-seal-300' : 'hover:bg-paper-100'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(project.projectId)}
                    className="flex min-w-0 flex-1 items-center gap-ui-gap-sm py-ui-gap-sm text-left"
                  >
                    <span className={`h-ui-dot w-ui-dot shrink-0 rounded-full ${color.bg}`} />
                    <span
                      className={`min-w-0 flex-1 truncate text-ui-sm ${color.text} ${
                        isCurrent ? 'font-medium' : ''
                      }`}
                    >
                      {project.title || '(未命名任务)'}
                    </span>
                    {project.dueAt > 0 && (
                      <span className="shrink-0 text-ui-2xs text-ink-400">DDL</span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => onAddChild(project)}
                    title="加子任务"
                    className="shrink-0 rounded p-1 text-ink-300 opacity-0 transition hover:text-seal-600 group-hover:opacity-100"
                  >
                    <Plus className="h-ui-icon-sm w-ui-icon-sm" />
                  </button>
                </div>
              )
            })
          )}
        </div>
      )}
    </section>
  )
}