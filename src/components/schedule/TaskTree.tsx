/**
 * 日程页 · 任务列表（层级 / 系列）
 * -------------------------------------------------
 * 与 DDL 清单**分框**：DDL 是扁平的（按紧急度排），任务列表保留**层级与系列**
 * —— 用 parentId 串成树，点节点即切「当前任务」。
 * 布局：**左右分列** —— 左边「研究」、右边「课程」，各一竖列、各自滚动；
 * 每个大类内部再按层级缩进展开（DFS）。同根同色（colorForRoot），与课程表 / DDL 全局一致。
 *
 * 排序（用户要求，ADJ-71）：**同层内**按「急不急」排 ——
 * ① 此刻**正在上**的课 / 定时任务置顶；② 有排期的（课程 / 定时任务）按**下一次时间由近到远**；
 * ③ 其余（没有时段的纯任务）按**修改顺序**（最近改的在前）。
 * 于是「今天要上的课」自然浮到最上面，临到点的定时任务也会顶上来。
 */
import { useEffect, useState } from 'react'
import { ListTree, Pencil, Plus, Trash2 } from 'lucide-react'
import type { Project } from '../../services/projectData'
import type { Course } from '../../services/scheduleData'
import { timeToMinutes, weekdayOfDate } from '../../services/scheduleData'
import { colorForRoot, getRootId } from '../../services/taskColors'

/** 某个时段相对 now 的出现情况：next = 下一次开始(ms)，ongoing = 此刻是否正在上 */
function slotTiming(c: Course, now: number): { next: number; ongoing: boolean } {
  const start = timeToMinutes(c.startTime)
  const end = timeToMinutes(c.endTime)
  if (start < 0 || c.weekday < 1 || c.weekday > 7) return { next: Infinity, ongoing: false }
  const d = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  const todayWd = weekdayOfDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
  const delta = (((c.weekday - todayWd) % 7) + 7) % 7
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const nowMin = d.getHours() * 60 + d.getMinutes()
  const ongoing = delta === 0 && end > start && nowMin >= start && nowMin < end
  let next = dayStart + delta * 86400000 + start * 60000
  if (next <= now) next += 7 * 86400000 // 这次已经过了 → 下一次在下周
  return { next, ongoing }
}

/** 一个任务的所有时段汇总出的排序依据 */
interface Timing {
  has: boolean
  ongoing: boolean
  next: number
}
function projectTiming(slots: Course[], now: number): Timing {
  let has = false
  let ongoing = false
  let next = Infinity
  for (const c of slots) {
    has = true
    const t = slotTiming(c, now)
    if (t.ongoing) ongoing = true
    if (t.next < next) next = t.next
  }
  return { has, ongoing, next }
}

/** 一行：任务 + 其缩进深度（DFS 展开，避免递归渲染的坑） */
interface Row {
  project: Project
  depth: number
}

/**
 * 把一批任务按 parentId 展平成有序行（DFS）。
 * 传入的已是同一大类（研究 / 课程）的任务，父节点也在其中，故用局部 map 即可。
 * 同层（根 / 同一父节点的兄弟）用 `compare` 排序；用一个 visited 兜底，异常数据（环 / 重复）也不会死循环。
 */
function buildRows(list: Project[], compare: (a: Project, b: Project) => number): Row[] {
  const byId = new Map<string, Project>()
  for (const p of list) byId.set(p.projectId, p)

  const childrenByParent = new Map<string, Project[]>()
  const roots: Project[] = []
  for (const p of list) {
    if (!p.parentId || !byId.has(p.parentId)) {
      roots.push(p)
    } else {
      const arr = childrenByParent.get(p.parentId)
      if (arr) arr.push(p)
      else childrenByParent.set(p.parentId, [p])
    }
  }
  for (const [k, arr] of childrenByParent) childrenByParent.set(k, [...arr].sort(compare))
  roots.sort(compare)

  const rows: Row[] = []
  const visited = new Set<string>()
  const walk = (p: Project, depth: number) => {
    if (visited.has(p.projectId)) return
    visited.add(p.projectId)
    rows.push({ project: p, depth })
    for (const c of childrenByParent.get(p.projectId) ?? []) walk(c, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  return rows
}

export function TaskTree({
  projects,
  courses,
  currentId,
  isLoading,
  onSelect,
  onNewRoot,
  onAddChild,
  onRename,
  onDelete,
}: {
  projects: Project[]
  courses: Course[]
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

  // 每个任务挂了哪些时段（课程 / 定时任务）
  const slotsByTask = new Map<string, Course[]>()
  for (const c of courses) {
    if (!c.taskId) continue
    const arr = slotsByTask.get(c.taskId)
    if (arr) arr.push(c)
    else slotsByTask.set(c.taskId, [c])
  }
  // 同一次渲染内复用时间判定（now 取一次，避免比较器里反复取当前时刻）
  const now = Date.now()
  const timingCache = new Map<string, Timing>()
  const timingOf = (projectId: string): Timing => {
    let t = timingCache.get(projectId)
    if (!t) {
      t = projectTiming(slotsByTask.get(projectId) ?? [], now)
      timingCache.set(projectId, t)
    }
    return t
  }
  // 排序：正在上的 → 有排期的（按下一次由近到远） → 其余（按修改顺序，最近改的在前）
  const compare = (a: Project, b: Project): number => {
    const ta = timingOf(a.projectId)
    const tb = timingOf(b.projectId)
    const ra = ta.ongoing ? 0 : ta.has ? 1 : 2
    const rb = tb.ongoing ? 0 : tb.has ? 1 : 2
    if (ra !== rb) return ra - rb
    if (ra <= 1) return ta.next - tb.next
    return (b.updatedAt || 0) - (a.updatedAt || 0)
  }

  // 左右分列：左研究、右课程（各自成树）
  const researchRows = buildRows(
    projects.filter((p) => p.type !== 'course'),
    compare,
  )
  const courseRows = buildRows(
    projects.filter((p) => p.type === 'course'),
    compare,
  )

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

  /** 渲染一个大类的竖列（列头 + 可滚动的层级列表） */
  const renderColumn = (label: string, rows: Row[]) => (
    <div className="flex min-h-0 flex-col rounded-lg border border-ink-100 bg-paper-100/40">
      <div className="flex items-center justify-between border-b border-ink-100 px-ui-gap-sm py-1">
        <span className="text-ui-xs font-medium text-ink-500">{label}</span>
        <span className="text-ui-2xs text-ink-300">{rows.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-ui-gap-sm">
        {rows.length === 0 ? (
          <p className="py-6 text-center text-ui-2xs text-ink-300">暂无{label}任务</p>
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
    </div>
  )

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
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-ui-gap-sm p-ui-gap-sm">
          {isLoading ? (
            <p className="col-span-2 py-6 text-center text-ui-xs text-ink-400">加载中…</p>
          ) : projects.length === 0 ? (
            <p className="col-span-2 py-6 text-center text-ui-xs text-ink-400">还没有任务</p>
          ) : (
            <>
              {renderColumn('研究', researchRows)}
              {renderColumn('课程', courseRows)}
            </>
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