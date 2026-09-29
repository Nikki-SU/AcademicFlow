/**
 * DDL 清单（右栏）
 * -------------------------------------------------
 * - 只展示有截止时间的节点（dueAt > 0），**按 dueAt 升序**（最紧急在最上），
 *   不按层级堆叠；层级只用左侧缩进体现（缩进 = 祖先数 × 12px）。
 * - 同一棵子树用「根任务颜色」着色，同根同色，方便在一堆平铺 DDL 里归堆。
 * - 每行可「+ 子任务」，顶部可「+ 新建任务」（根任务）。
 */
import type { Project } from '../../services/projectData'
import { colorForRoot, getRootId } from '../../services/taskColors'

/** 祖先数（深度）；遇环 / 父节点缺失即停，绝不死循环 */
function depthOf(project: Project, byId: Map<string, Project>): number {
  const seen = new Set<string>()
  let depth = 0
  let cur = project
  while (cur.parentId && !seen.has(cur.projectId)) {
    seen.add(cur.projectId)
    const parent = byId.get(cur.parentId)
    if (!parent) break
    depth++
    cur = parent
  }
  return depth
}

/** Unix ms → YYYY-MM-DD HH:MM */
function formatDue(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function DdlList({
  projects,
  byId,
  currentId,
  onNewRoot,
  onAddChild,
  onOpen,
}: {
  projects: Project[]
  byId: Map<string, Project>
  currentId: string | null
  onNewRoot: () => void
  onAddChild: (parent: Project) => void
  onOpen: (project: Project) => void
}) {
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-ink-200 bg-paper-50">
      <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2">
        <h2 className="text-sm font-semibold text-ink-800">
          DDL 清单
          <span className="ml-1 text-xs font-normal text-ink-400">按时间排序</span>
        </h2>
        <button
          onClick={onNewRoot}
          className="rounded bg-seal-600 px-2 py-1 text-xs font-medium text-paper-50 transition hover:bg-seal-700"
        >
          + 新建任务
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {projects.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-400">暂无带截止时间的任务</p>
        ) : (
          <div className="space-y-2">
            {projects.map((p) => {
              const depth = depthOf(p, byId)
              const color = colorForRoot(getRootId(p, byId))
              const isCurrent = p.projectId === currentId
              return (
                // 缩进放在外层容器上：paddingLeft = 祖先数 × 12px（内层按钮自己还有一份基础内边距）
                <div key={p.projectId} style={{ paddingLeft: depth * 12 }}>
                  <div
                    className={`flex items-center gap-3 rounded-lg border bg-paper-100 px-3 py-2.5 transition ${
                      isCurrent ? 'border-seal-300 ring-1 ring-seal-200' : 'border-ink-200 hover:border-ink-300'
                    }`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${color.bg}`} />
                    <button onClick={() => onOpen(p)} className="min-w-0 flex-1 text-left">
                      <div className="truncate text-sm font-medium">
                        <span className={color.text}>{p.title || '(未命名任务)'}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-ink-500">截止 {formatDue(p.dueAt)}</div>
                    </button>
                    <button
                      onClick={() => onAddChild(p)}
                      className="shrink-0 rounded border border-ink-200 px-2 py-1 text-xs text-ink-500 transition hover:border-seal-300 hover:text-seal-600"
                    >
                      + 子任务
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
