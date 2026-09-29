/**
 * AF 图标下拉 · 任务快速切换
 * -------------------------------------------------
 * 点左上角 AF 图标 → 下拉出「大类（研究 / 课程）+ 该大类下的具体任务」，
 * 选中即切「当前任务」（useTaskStore）。免去「每次进日程页再点进去」的高摩擦，
 * 也是「录音不绑架用户」的配套：录音在跑，人可以随手切到别的任务。见 架构.md §2.16。
 *
 * 数据由 Layout 持有并传入（同一份也用于页签「会议 / 课程」换名）；
 * 打开下拉时回调 onReload 刷新一次，保证日程页刚建的任务即时可见。
 */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, Check, FolderTree } from 'lucide-react'
import type { Project, ProjectType } from '../services/projectData'
import { colorForRoot, getRootId } from '../services/taskColors'
import { useTaskStore } from '../stores/task'

const TYPE_LABEL: Record<ProjectType, string> = { research: '研究', course: '课程' }
const TYPE_ORDER: ProjectType[] = ['research', 'course']

/** 排序：有 DDL 的按 dueAt 升序在前，无 DDL 的排后，再按标题 */
function byDueThenTitle(a: Project, b: Project): number {
  const da = a.dueAt || Number.MAX_SAFE_INTEGER
  const db = b.dueAt || Number.MAX_SAFE_INTEGER
  if (da !== db) return da - db
  return (a.title || '').localeCompare(b.title || '')
}

export default function TaskSwitcher({
  projects,
  onReload,
}: {
  projects: Project[]
  onReload: () => void
}) {
  const currentId = useTaskStore((s) => s.currentProjectId)
  const setCurrentProject = useTaskStore((s) => s.setCurrentProject)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 点面板外 / 按 Esc 关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = () => {
    // 打开前刷新一次任务列表，避免刚在日程页建的任务看不到
    if (!open) onReload()
    setOpen((v) => !v)
  }

  const byId = new Map(projects.map((p) => [p.projectId, p]))
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

  const current = currentId ? byId.get(currentId) : undefined
  const currentColor = current ? colorForRoot(getRootId(current, byId)) : null

  const handlePick = (id: string) => {
    setOpen(false)
    void setCurrentProject(id)
  }

  const renderNode = (p: Project, depth: number): JSX.Element => {
    const color = colorForRoot(getRootId(p, byId))
    const kids = childrenByParent.get(p.projectId) ?? []
    const isCur = p.projectId === currentId
    return (
      <div key={p.projectId}>
        <button
          type="button"
          onClick={() => handlePick(p.projectId)}
          style={{ paddingLeft: depth * 12 + 8 }}
          className={`flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition ${
            isCur ? 'bg-seal-50 text-seal-700' : 'text-ink-600 hover:bg-paper-100'
          }`}
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${color.bg}`} />
          <span className="min-w-0 flex-1 truncate">{p.title || '(未命名任务)'}</span>
          {isCur && <Check className="h-3.5 w-3.5 shrink-0 text-seal-600" />}
        </button>
        {kids.map((k) => renderNode(k, depth + 1))}
      </div>
    )
  }

  return (
    <div ref={rootRef} className="relative mr-6 flex-shrink-0">
      <button
        type="button"
        onClick={toggle}
        title={current ? `当前任务：${current.title || '(未命名任务)'}` : '选择当前任务'}
        className="flex w-[10rem] sm:w-[15rem] lg:w-[19rem] items-center gap-2 rounded-md px-1 py-1 transition hover:bg-paper-100"
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-seal-600">
          <span className="text-xs font-bold text-paper-50">AF</span>
        </div>
        <span className={`h-2 w-2 shrink-0 rounded-full ${currentColor?.bg ?? 'bg-ink-200'}`} />
        <span className="min-w-0 truncate text-sm font-semibold text-ink-800">
          {current ? current.title || '(未命名任务)' : '未选任务'}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-ink-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-xl border border-ink-200 bg-paper-50 shadow-lift">
          <div className="border-b border-ink-100 px-3 py-2">
            <p className="text-[11px] font-medium text-ink-400">当前任务</p>
            <p className="mt-0.5 truncate text-sm text-ink-800">
              {current ? current.title || '(未命名任务)' : '未选择'}
            </p>
          </div>

          <div className="max-h-80 overflow-y-auto p-2">
            {roots.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-ink-400">还没有任务</p>
            ) : (
              TYPE_ORDER.map((type) => {
                const group = roots.filter((r) => r.type === type)
                if (group.length === 0) return null
                return (
                  <div key={type} className="mb-1.5 last:mb-0">
                    <p className="px-2 py-1 text-[11px] font-semibold text-ink-400">{TYPE_LABEL[type]}</p>
                    {group.map((r) => renderNode(r, 0))}
                  </div>
                )
              })
            )}
          </div>

          <div className="border-t border-ink-100 p-1.5">
            <Link
              to="/schedule"
              onClick={() => setOpen(false)}
              className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-seal-600 transition hover:bg-seal-50"
            >
              <FolderTree className="h-3.5 w-3.5" />
              在日程页管理任务 →
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
