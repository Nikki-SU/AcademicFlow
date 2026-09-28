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
  onNewRoot,
  onAddChild,
  onOpen,
}: {
  projects: Project[]
  byId: Map<string, Project>
  onNewRoot: () => void
  onAddChild: (parent: Project) => void
  onOpen: (project: Project) => void
}) {
  return (
    <section className="rounded-xl border border-ink-200 bg-paper-50 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-ink-800">DDL 清单</h2>
        <button
          onClick={onNewRoot}
          className="text-xs text-paper-50 bg-seal-600 hover:bg-seal-700 px-2.5 py-1 rounded transition font-medium"
        >
          + 新建任务
        </button>
      </div>

      {projects.length === 0 ? (
        <p className="text-sm text-ink-400 py-6 text-center">暂无带截止时间的任务</p>
      ) : (
        <div className="space-y-2">
          {projects.map((p) => {
            const depth = depthOf(p, byId)
            const color = colorForRoot(getRootId(p, byId))
            return (
              // 缩进放在外层容器上：paddingLeft = 祖先数 × 12px（内层按钮自己还有一份基础内边距）
              <div key={p.projectId} style={{ paddingLeft: depth * 12 }}>
                <div className="flex items-center gap-3 py-2.5 px-3 rounded-lg border border-ink-200 bg-paper-100 hover:border-ink-300 transition">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${color.bg}`} />
                  <button
                    onClick={() => onOpen(p)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <div className={`text-sm font-medium truncate ${color.text}`}>
                      {p.title || '(未命名任务)'}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-500">
                      截止 {formatDue(p.dueAt)}
                    </div>
                  </button>
                  <button
                    onClick={() => onAddChild(p)}
                    className="shrink-0 text-xs text-ink-500 hover:text-seal-600 px-2 py-1 rounded border border-ink-200 hover:border-seal-300 transition"
                  >
                    + 子任务
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
