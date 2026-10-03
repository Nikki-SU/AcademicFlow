/**
 * 日程页 · 任务列表（层级 / 系列）
 * -------------------------------------------------
 * 与 DDL 清单**分框**：DDL 是扁平的（按紧急度排），任务列表保留**层级与系列**
 * —— 用 parentId 串成树，点节点即切「当前任务」。
 * 布局：**左右分列** —— 左边「研究」、右边「课程」，各一竖列、各自滚动；
 * 每个大类内部再按层级缩进展开（DFS）。同根同色（colorForRoot），与课程表 / DDL 全局一致。
 *
 * 交互（用户要求）：
 * - **点任务文字 → 就地展开「任务详情」**（TaskExpandPanel：可粘贴描述、可加附件）。
 * - 新建走**列头「+」**（点哪个大类的加号，就在哪个大类下建顶级任务），不再有全局「新建任务」。
 * - 行内按钮顺序：**加子任务（高频）在左**，编辑 / 删除（低频）在右。
 * - **联动高亮**：课表红线悬停 / 点击时，对应任务行亮起（`highlightId`）。
 * - **过期任务**：有截止时间且已过点的行**灰掉**（仍可点开 / 编辑）；日程页页头「显示过期」
 *   开关关掉时从列表隐藏。
 *
 * 排序（用户要求，ADJ-71）：**同层内**按「急不急」排 ——
 * ① 此刻**正在上**的课 / 定时任务置顶；② 有排期的（课程 / 定时任务）按**下一次时间由近到远**；
 * ③ 其余（没有时段的纯任务）按**修改顺序**（最近改的在前）。
 * 于是「今天要上的课」自然浮到最上面，临到点的定时任务也会顶上来。
 */
import { Fragment, useEffect, useState } from 'react'
import { CheckCircle2, Circle, ListTree, Pencil, Plus, Trash2, XCircle } from 'lucide-react'
import type { Project, ProjectType } from '../../services/projectData'
import { isOverdue } from '../../services/projectData'
import type { Course } from '../../services/scheduleData'
import { timeToMinutes, weekdayOfDate } from '../../services/scheduleData'
import { colorForRoot, getRootId } from '../../services/taskColors'
import { TaskExpandPanel } from './TaskExpandPanel'

/** 某个时段相对 now 的出现情况：next = 下一次开始(ms)，ongoing = 此刻是否正在上 */
function slotTiming(c: Course, now: number): { next: number; ongoing: boolean } {
  const start = timeToMinutes(c.startTime)
  const end = timeToMinutes(c.endTime)
  // 单次时段：只在它自己那一天出现；过了就不再参与排序（不会每周重复）
  if (c.repeat === 'once') {
    if (!c.date || start < 0 || end <= start) return { next: Infinity, ongoing: false }
    const target = new Date(`${c.date}T00:00:00`)
    if (Number.isNaN(target.getTime())) return { next: Infinity, ongoing: false }
    const d = new Date(now)
    const nowMin = d.getHours() * 60 + d.getMinutes()
    const sameDay =
      d.getFullYear() === target.getFullYear() &&
      d.getMonth() === target.getMonth() &&
      d.getDate() === target.getDate()
    const ongoing = sameDay && nowMin >= start && nowMin < end
    const nextStart = target.getTime() + start * 60000
    return { next: nextStart > now ? nextStart : Infinity, ongoing }
  }
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
  highlightId,
  showExpired,
  showCompleted,
  onSelect,
  onNewRoot,
  onAddChild,
  onEdit,
  onRename,
  onDelete,
  onToggleDone,
}: {
  projects: Project[]
  courses: Course[]
  currentId: string | null
  isLoading: boolean
  /** 当前亮起的 DDL 任务 id（课表红线悬停 / 点击联动） */
  highlightId: string | null
  /** 整页「显示过期」开关：关掉则过期任务从列表隐藏（由日程页统一控制） */
  showExpired: boolean
  /** 整页「显示已完成」开关：关掉则已完成任务从列表隐藏（由日程页统一控制） */
  showCompleted: boolean
  onSelect: (id: string) => void
  /** 列头「+」新建：指定大类（研究 / 课程）下的顶级任务 */
  onNewRoot: (type: ProjectType) => void
  onAddChild: (parent: Project) => void
  /** 打开统一编辑器（改名称 / 大类 / 归属 / 时间 / DDL / 详情） */
  onEdit: (project: Project) => void
  onRename: (project: Project, title: string) => Promise<void>
  onDelete: (project: Project) => void
  /** 勾选 / 取消勾选完成（勾 = 划掉变灰；把过期的叉点一下即变为勾） */
  onToggleDone: (project: Project) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  /** 行内展开的「任务详情」——同一时刻只展开一个 */
  const [expandedId, setExpandedId] = useState<string | null>(null)
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
  // 「显示已完成」关掉 → 过滤掉已完成任务；「显示过期」关掉 → 过滤掉过期（未完成）任务
  const visibleProjects = projects
    .filter((p) => showCompleted || !p.done)
    .filter((p) => showExpired || p.done || !isOverdue(p, now))
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
    visibleProjects.filter((p) => p.type !== 'course'),
    compare,
  )
  const courseRows = buildRows(
    visibleProjects.filter((p) => p.type === 'course'),
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
  const renderColumn = (label: string, type: ProjectType, rows: Row[]) => (
    <div className="flex min-h-0 flex-col rounded-lg border border-ink-100 bg-paper-100/40">
      <div className="flex items-center justify-between border-b border-ink-100 px-ui-gap-sm py-1">
        <span className="text-ui-xs font-medium text-ink-500">
          {label} <span className="text-ui-2xs font-normal text-ink-300">{rows.length}</span>
        </span>
        <button
          type="button"
          onClick={() => onNewRoot(type)}
          title={`新建${label}任务`}
          className="inline-flex shrink-0 items-center gap-0.5 rounded p-0.5 text-ink-400 transition hover:bg-seal-50 hover:text-seal-600"
        >
          <Plus className="h-ui-icon-sm w-ui-icon-sm" />
          <span className="text-ui-2xs">任务</span>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-ui-gap-sm">
        {rows.length === 0 ? (
          <p className="py-6 text-center text-ui-2xs text-ink-300">暂无{label}任务</p>
        ) : (
          rows.map(({ project, depth }) => {
            const color = colorForRoot(getRootId(project, byId))
            const isCurrent = project.projectId === currentId
            const isHighlight = project.projectId === highlightId
            const isEditing = project.projectId === editingId
            const isExpanded = project.projectId === expandedId
            // 完成 / 过期都算「划掉」：整行变灰、标题加删除线
            const done = project.done
            const overdue = !done && isOverdue(project, now)
            const struck = done || overdue
            const parentTitle = project.parentId
              ? byId.get(project.parentId)?.title || '(未命名任务)'
              : null
            return (
              <Fragment key={project.projectId}>
                <div
                  style={{ paddingLeft: `calc(${depth} * var(--ui-indent))` }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ project, x: e.clientX, y: e.clientY })
                  }}
                  className={`group flex items-center gap-ui-gap-sm rounded-md pr-1 transition ${
                    struck ? 'opacity-60 grayscale' : ''
                  } ${
                    isHighlight
                      ? 'bg-red-50 ring-1 ring-red-300'
                      : isCurrent
                        ? 'bg-seal-50 ring-1 ring-seal-300'
                        : 'hover:bg-paper-100'
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
                    <>
                      {/* 待办小圈圈：空圈 → 完成打勾 / 过期打叉；点一下在完成 / 未完成间切换 */}
                      <button
                        type="button"
                        onClick={() => onToggleDone(project)}
                        title={
                          done
                            ? '已完成（点击取消）'
                            : overdue
                              ? '已过期：点一下标记为完成'
                              : '标记完成'
                        }
                        className="shrink-0 rounded-full p-0.5 transition hover:scale-110"
                      >
                        {done ? (
                          <CheckCircle2 className="h-ui-icon-sm w-ui-icon-sm text-emerald-500" />
                        ) : overdue ? (
                          <XCircle className="h-ui-icon-sm w-ui-icon-sm text-red-400" />
                        ) : (
                          <Circle
                            className={`h-ui-icon-sm w-ui-icon-sm ${color.text} opacity-60 transition hover:opacity-100`}
                          />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedId((prev) => (prev === project.projectId ? null : project.projectId))
                          onSelect(project.projectId)
                        }}
                        onDoubleClick={() => startEdit(project)}
                        title="点击展开详情 · 双击改名"
                        className="flex min-w-0 flex-1 items-center gap-ui-gap-sm py-ui-gap-sm text-left"
                      >
                        <span
                          className={`min-w-0 flex-1 truncate text-ui-sm ${
                            struck ? 'text-ink-400 line-through' : color.text
                          } ${isCurrent ? 'font-medium' : ''}`}
                        >
                          {project.title || '(未命名任务)'}
                        </span>
                        {project.dueAt > 0 && (
                          <span className="shrink-0 text-ui-2xs text-ink-400">DDL</span>
                        )}
                      </button>
                    </>
                  )}
                  {/* 高频的「加子任务」放最左，改名/删除低频靠右 */}
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
                    onClick={() => onEdit(project)}
                    title="编辑任务（名称 / 归属 / 时间 / 详情）"
                    className="shrink-0 rounded p-1 text-ink-300 opacity-0 transition hover:text-seal-600 group-hover:opacity-100"
                  >
                    <Pencil className="h-ui-icon-sm w-ui-icon-sm" />
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
                {isExpanded && !isEditing && (
                  <TaskExpandPanel
                    project={project}
                    parentTitle={parentTitle}
                    onEdit={() => onEdit(project)}
                  />
                )}
              </Fragment>
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
      </div>

      {!collapsed && (
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-ui-gap-sm p-ui-gap-sm">
          {isLoading ? (
            <div className="col-span-2 flex items-center justify-center py-6">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-ink-200 border-t-seal-500" />
            </div>
          ) : (
            // 空列表也保留两列（列头「+」始终可达，否则新建无入口）
            <>
              {renderColumn('研究', 'research', researchRows)}
              {renderColumn('课程', 'course', courseRows)}
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
              onEdit(menu.project)
              setMenu(null)
            }}
            className="flex w-full items-center gap-ui-gap-sm px-3 py-1.5 text-left text-ui-sm text-ink-700 transition hover:bg-paper-100"
          >
            <Pencil className="h-ui-icon-sm w-ui-icon-sm text-ink-400" />
            编辑任务
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