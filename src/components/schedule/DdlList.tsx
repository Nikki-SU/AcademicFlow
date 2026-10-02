/**
 * DDL 清单（右栏）
 * -------------------------------------------------
 * - 只展示有截止时间的节点（dueAt > 0），**按 dueAt 升序**（最近的排最上、最不急的排最下）。
 * - **不按时间间隔的远近**留白 —— 每行等距，只保证「近的在前、远的在后」。
 * - 布局：**两列分列** —— 左「研究」、右「课程」；**每一行只放一个任务**，
 *   按大类落在左半或右半。于是**纵向顺序 = 紧急度**，横向位置 = 大类。
 * - 同一棵子树用「根任务颜色」着色，同根同色，方便在一堆 DDL 里归堆。
 * - 每行**只展示**：第一行任务名、第二行时间（年月日 + 几点，不写「截止」二字）。
 * - **加子任务只在任务栏**（TaskTree），DDL 这边不放子任务入口。
 * - **联动高亮**：课表红线悬停 / 点击时，对应行亮起（`highlightId`）。
 * - 新建走**列头「+」**（点哪个大类，就在哪个大类下建顶级任务）。
 * - 点任务 → 打开统一编辑器（改名称 / 归属 / 时间 / DDL / 详情）。
 */
import { Fragment } from 'react'
import { Plus } from 'lucide-react'
import type { Project, ProjectType } from '../../services/projectData'
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
  highlightId,
  onNewRoot,
  onEdit,
}: {
  projects: Project[]
  byId: Map<string, Project>
  currentId: string | null
  /** 当前亮起的 DDL 任务 id（课表红线悬停 / 点击联动） */
  highlightId: string | null
  /** 列头「+」新建：指定大类（研究 / 课程）下的顶级任务 */
  onNewRoot: (type: ProjectType) => void
  /** 打开统一编辑器（改名称 / 归属 / 时间 / DDL / 详情） */
  onEdit: (project: Project) => void
}) {
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-ink-200 bg-paper-50">
      <div className="flex items-center gap-ui-gap border-b border-ink-100 px-ui-gap py-ui-gap-sm">
        <h2 className="text-ui-sm font-semibold text-ink-800">
          DDL 清单
          <span className="ml-1 text-ui-xs font-normal text-ink-400">急 → 不急</span>
        </h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-ui-gap">
        {/* 列头：左研究 / 右课程；每列头一个「+」新建该大类下的任务（空列表也保留，新建始终可达） */}
        <div className="mb-ui-gap-sm grid grid-cols-2 gap-ui-gap-sm border-b border-ink-100 pb-ui-gap-sm">
          {(['research', 'course'] as const).map((t) => (
            <div
              key={t}
              className="flex items-center justify-center gap-1 text-ui-xs font-medium text-ink-400"
            >
              {t === 'research' ? '研究' : '课程'}
              <button
                type="button"
                onClick={() => onNewRoot(t)}
                title={`新建${t === 'research' ? '研究' : '课程'}任务`}
                className="rounded p-0.5 text-ink-300 transition hover:bg-seal-50 hover:text-seal-600"
              >
                <Plus className="h-ui-icon-sm w-ui-icon-sm" />
              </button>
            </div>
          ))}
        </div>

        {projects.length === 0 ? (
          <p className="py-6 text-center text-ui-sm text-ink-400">暂无带截止时间的任务</p>
        ) : (
          <>
            {/* 每行一个任务，落在左或右；纵向 = 紧急度 */}
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-ink-100" />
              <div className="grid grid-cols-2 gap-x-ui-gap-sm gap-y-ui-gap-sm">
                {projects.map((p) => {
                  const isCourse = p.type === 'course'
                  const color = colorForRoot(getRootId(p, byId))
                  const isCurrent = p.projectId === currentId
                  const isHighlight = p.projectId === highlightId
                  const card = (
                    <div
                      className={`flex items-center gap-ui-gap rounded-lg border bg-paper-100 px-ui-gap py-ui-gap-sm transition ${
                        isHighlight
                          ? 'border-red-400 ring-2 ring-red-200'
                          : isCurrent
                            ? 'border-seal-300 ring-1 ring-seal-200'
                            : 'border-ink-200 hover:border-ink-300'
                      }`}
                    >
                      <span className={`h-ui-dot w-ui-dot shrink-0 rounded-full ${color.bg}`} />
                      <button onClick={() => onEdit(p)} className="min-w-0 flex-1 text-left" title="打开任务详情 / 编辑">
                        <div className="truncate text-ui-sm font-medium">
                          <span className={color.text}>{p.title || '(未命名任务)'}</span>
                        </div>
                        {/* 第二行只给时间（年月日 + 几点），不写「截止」二字 */}
                        <div className="mt-0.5 text-ui-xs text-ink-500">{formatDue(p.dueAt)}</div>
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