/**
 * DDL 清单（右栏）
 * -------------------------------------------------
 * - 只展示有截止时间的节点（dueAt > 0），**按 dueAt 升序**（最近的排最上、最不急的排最下）。
 * - **不按时间间隔的远近**留白 —— 每行等距，只保证「近的在前、远的在后」。
 * - 布局：**两列分列** —— 左「研究」、右「课程」；**每一行只放一个任务**，
 *   按大类落在左半或右半。于是**纵向顺序 = 紧急度**，横向位置 = 大类。
 * - 同一棵子树用「根任务颜色」着色，同根同色，方便在一堆 DDL 里归堆。
 * - 每行可「+ 子任务」，顶部可「+ 新建任务」（根任务）。
 */
import { Fragment } from 'react'
import type { Project } from '../../services/projectData'
import { colorForRoot, getRootId } from '../../services/taskColors'

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
      <div className="flex items-center justify-between gap-ui-gap border-b border-ink-100 px-ui-gap py-ui-gap-sm">
        <h2 className="text-ui-sm font-semibold text-ink-800">
          DDL 清单
          <span className="ml-1 text-ui-xs font-normal text-ink-400">急 → 不急</span>
        </h2>
        <button
          onClick={onNewRoot}
          className="rounded bg-seal-600 px-ui-gap-sm py-ui-gap-sm text-ui-xs font-medium text-paper-50 transition hover:bg-seal-700"
        >
          + 新建任务
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-ui-gap">
        {projects.length === 0 ? (
          <p className="py-6 text-center text-ui-sm text-ink-400">暂无带截止时间的任务</p>
        ) : (
          <>
            {/* 列头：左研究 / 右课程 */}
            <div className="mb-ui-gap-sm grid grid-cols-2 gap-ui-gap-sm border-b border-ink-100 pb-ui-gap-sm">
              <div className="text-center text-ui-xs font-medium text-ink-400">研究</div>
              <div className="text-center text-ui-xs font-medium text-ink-400">课程</div>
            </div>

            {/* 每行一个任务，落在左或右；纵向 = 紧急度 */}
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-ink-100" />
              <div className="grid grid-cols-2 gap-x-ui-gap-sm gap-y-ui-gap-sm">
                {projects.map((p) => {
                  const isCourse = p.type === 'course'
                  const color = colorForRoot(getRootId(p, byId))
                  const isCurrent = p.projectId === currentId
                  const card = (
                    <div
                      className={`flex items-center gap-ui-gap rounded-lg border bg-paper-100 px-ui-gap py-ui-gap-sm transition ${
                        isCurrent
                          ? 'border-seal-300 ring-1 ring-seal-200'
                          : 'border-ink-200 hover:border-ink-300'
                      }`}
                    >
                      <span className={`h-ui-dot w-ui-dot shrink-0 rounded-full ${color.bg}`} />
                      <button onClick={() => onOpen(p)} className="min-w-0 flex-1 text-left">
                        <div className="truncate text-ui-sm font-medium">
                          <span className={color.text}>{p.title || '(未命名任务)'}</span>
                        </div>
                        <div className="mt-0.5 text-ui-xs text-ink-500">截止 {formatDue(p.dueAt)}</div>
                      </button>
                      <button
                        onClick={() => onAddChild(p)}
                        className="shrink-0 rounded border border-ink-200 px-ui-gap-sm py-ui-gap-sm text-ui-xs text-ink-500 transition hover:border-seal-300 hover:text-seal-600"
                      >
                        + 子任务
                      </button>
                    </div>
                  )
                  return (
                    <Fragment key={p.projectId}>
                      <div className="min-w-0">{isCourse ? null : card}</div>
                      <div className="min-w-0">{isCourse ? card : null}</div>
                    </Fragment>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}