/**
 * 日程页 · 任务列表（层级 / 系列）
 * -------------------------------------------------
 * 与 DDL 清单**分框**：DDL 是扁平的（按时间排），任务列表保留**层级与系列**
 * —— 用 parentId 串成树，点节点即切「当前任务」。
 * 同根同色（colorForRoot），与课程表 / DDL 全局一致。
 */
import { useEffect, useState } from 'react'
import { ListTree, Pencil, Plus, Trash2 } from 'lucide-react'
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
  onRename,
  onDelete,
}: {
  projects: Project[]
  currentId: string | null
  isLoading: boolean
  onSelect: (id: string) => void
  onNewRoot: () => void
  onAddChild: (parent: Project) => void
  onRename: (project: Project, title: string) => Promise<void>
  onDelete: (project: Project) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState<{ project: Project; x: number; y: number } | null>(null)

  // 右键菜单：点别处 / 滚动 / Esc 一律关闭
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('scroll', close, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('scroll', close, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

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

  const startEdit = (p: Project) => {
    setEditingId(p.projectId)
    setDraft(p.title || '')
  }

  const commitEdit = async (p: Project) => {
    const name = draft.trim()
    setEditingId(null)
    if (!name || name === (p.title || '')) return
    await onRename(p, name)
  }

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
              const isEditing = project.projectId === editingId
              return (
                <div
                  key={project.projectId}
                  style={{ paddingLeft: `calc(${depth} * var(--ui-indent))` }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ project, x: e.clientX, y: e.clientY })
                  }}
                  className={`group flex items-center gap-ui-gap-sm rounded-md pr-1 transition ${
                    isCurrent ? 'bg-seal-50 ring-1 ring-seal-300' : 'hover:bg-paper-100'
                  }`}
                >
                  {isEditing ? (
                    <div className="flex min-w-0 flex-1 items-center gap-ui-gap-sm py-ui-gap-sm">
                      <span className={`h-ui-dot w-ui-dot shrink-0 rounded-full ${color.bg}`} />
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitEdit(project)
                          else if (e.key === 'Escape') setEditingId(null)
                        }}
                        onBlur={() => void commitEdit(project)}
                        className="min-w-0 flex-1 rounded border border-seal-400 bg-paper-50 px-1.5 py-0.5 text-ui-sm text-ink-800 focus:outline-none focus:ring-2 focus:ring-seal-100"
                      />
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onSelect(project.projectId)}
                      onDoubleClick={() => startEdit(project)}
                      title="双击改名"
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
                  )}
                  <button
                    type="button"
                    onClick={() => startEdit(project)}
                    title="改名"
                    className="shrink-0 rounded p-1 text-ink-300 opacity-0 transition hover:text-seal-600 group-hover:opacity-100"
                  >
                    <Pencil className="h-ui-icon-sm w-ui-icon-sm" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onAddChild(project)}
                    title="加子任务"
                    className="shrink-0 rounded p-1 text-ink-300 opacity-0 transition hover:text-seal-600 group-hover:opacity-100"
                  >
                    <Plus className="h-ui-icon-sm w-ui-icon-sm" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(project)}
                    title="删除任务"
                    className="shrink-0 rounded p-1 text-ink-300 opacity-0 transition hover:text-seal-600 group-hover:opacity-100"
                  >
                    <Trash2 className="h-ui-icon-sm w-ui-icon-sm" />
                  </button>
                </div>
              )
            })
          )}
        </div>
      )}

      {menu && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{ left: menu.x, top: menu.y }}
          className="fixed z-50 min-w-36 overflow-hidden rounded-lg border border-ink-200 bg-paper-50 py-1 shadow-xl"
        >
          <button
            type="button"
            onClick={() => {
              startEdit(menu.project)
              setMenu(null)
            }}
            className="flex w-full items-center gap-ui-gap-sm px-3 py-1.5 text-left text-ui-sm text-ink-700 transition hover:bg-paper-100"
          >
            <Pencil className="h-ui-icon-sm w-ui-icon-sm text-ink-400" />
            改名
          </button>
          <button
            type="button"
            onClick={() => {
              onAddChild(menu.project)
              setMenu(null)
            }}
            className="flex w-full items-center gap-ui-gap-sm px-3 py-1.5 text-left text-ui-sm text-ink-700 transition hover:bg-paper-100"
          >
            <Plus className="h-ui-icon-sm w-ui-icon-sm text-ink-400" />
            加子任务
          </button>
          <button
            type="button"
            onClick={() => {
              onDelete(menu.project)
              setMenu(null)
            }}
            className="flex w-full items-center gap-ui-gap-sm px-3 py-1.5 text-left text-ui-sm text-seal-700 transition hover:bg-seal-50"
          >
            <Trash2 className="h-ui-icon-sm w-ui-icon-sm" />
            删除任务
          </button>
        </div>
      )}
    </section>
  )
}