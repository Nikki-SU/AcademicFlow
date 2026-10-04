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
 * - 点任务 → **只读**打开该任务的要求（详细描述 / 要求 / 注意事项 / 附件）；
 *   要编辑走弹层里的「编辑」→ 统一编辑窗（不在列表里直接编辑）。
 * - **过期任务**：有截止时间且已过点的，整块**变灰**、沉到列表底部，仍可点开查看 / 编辑；
 *   可在组头**折叠**，也可用日程页页头的「显示过期」开关**整组隐藏 / 显示**（用户要求）。
 */
import { Fragment, useState } from 'react'
import { CalendarClock, CheckCircle2, ChevronDown, ChevronRight, Circle, Plus, XCircle } from 'lucide-react'
import type { Project, ProjectType } from '../../services/projectData'
import { isOverdue } from '../../services/projectData'
import { colorForRoot, getRootId } from '../../services/taskColors'
import { isDueSoon } from '../../services/highlightColors'

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
  showExpired,
  showCompleted,
  onNewRoot,
  onView,
  onToggleDone,
}: {
  projects: Project[]
  byId: Map<string, Project>
  currentId: string | null
  /** 当前亮起的 DDL 任务 id（课表红线悬停 / 点击联动） */
  highlightId: string | null
  /** 整页「显示过期」开关：关掉则过期段整组隐藏（由日程页统一控制） */
  showExpired: boolean
  /** 整页「显示已完成」开关：关掉则已完成段整组隐藏（由日程页统一控制） */
  showCompleted: boolean
  /** 列头「+」新建：指定大类（研究 / 课程）下的顶级任务 */
  onNewRoot: (type: ProjectType) => void
  /** 点任务 → 只读打开该任务的要求（编辑走弹层里的「编辑」） */
  onView: (project: Project) => void
  /** 勾选 / 取消勾选完成（勾 = 划掉变灰；把过期的叉点一下即变为勾） */
  onToggleDone: (project: Project) => void
}) {
  // 过期组 / 已完成组默认展开（先看到它们、且是灰的）；想清爽就折叠起来（用户要求）
  const [expiredOpen, setExpiredOpen] = useState(true)
  const [doneOpen, setDoneOpen] = useState(true)
  const now = Date.now()
  const active = projects.filter((p) => !p.done && !isOverdue(p, now))
  const expired = projects.filter((p) => !p.done && isOverdue(p, now))
  const finished = projects.filter((p) => p.done)
  // 各段是否真的渲染：开关关掉就整组不出现（连组头一起收掉）
  const showExpiredSection = showExpired && expired.length > 0
  const showDoneSection = showCompleted && finished.length > 0
  // 一个卡片都看不到（活跃为空 + 过期 / 已完成被藏或本就没有）→ 给空态文案
  const nothingToShow = active.length === 0 && !showExpiredSection && !showDoneSection

  /**
   * 一张 DDL 卡片。`gray` = 已完成 / 已过期：整块灰掉（仍可点开查看 / 编辑，顺序不变），
   * 且不再做「一周以内」淡红 —— 都划掉了就不该再喊急。
   */
  const renderCard = (p: Project, gray: boolean) => {
    const color = colorForRoot(getRootId(p, byId))
    const isCurrent = p.projectId === currentId
    const isHighlight = p.projectId === highlightId
    const urgent = !gray && isDueSoon(p.dueAt, now)
    return (
      <div
        className={`flex items-center gap-ui-gap rounded-control border px-ui-gap py-ui-gap-sm transition ${
          gray
            ? 'border-ink-100 bg-paper-100 opacity-60 grayscale'
            : urgent
              ? 'border-hl-red bg-hl-red-soft'
              : 'border-ink-200 bg-paper-100 hover:border-ink-300'
        } ${
          !gray && isHighlight
            ? 'ring-2 ring-hl-red'
            : !gray && isCurrent
              ? 'border-seal-300 ring-1 ring-seal-200'
              : ''
        }`}
      >
        {/* 待办小圈圈：空圈 → 完成打勾 / 过期打叉；点一下在完成 / 未完成间切换 */}
        <button
          type="button"
          onClick={() => onToggleDone(p)}
          title={p.done ? '已完成（点击取消）' : gray ? '已过期：点一下标记为完成' : '标记完成'}
          className="shrink-0 rounded-full p-0.5 transition hover:scale-110"
        >
          {p.done ? (
            <CheckCircle2 className="h-ui-icon-sm w-ui-icon-sm text-emerald-500" />
          ) : gray ? (
            <XCircle className="h-ui-icon-sm w-ui-icon-sm text-red-400" />
          ) : (
            <Circle className={`h-ui-icon-sm w-ui-icon-sm ${color.text} opacity-60 transition hover:opacity-100`} />
          )}
        </button>
        <button onClick={() => onView(p)} className="min-w-0 flex-1 text-left" title="查看任务要求">
          <div className="truncate text-ui-sm font-medium">
            <span className={gray ? 'text-ink-400 line-through' : color.text}>{p.title || '(未命名任务)'}</span>
          </div>
          {/* 第二行只给时间（年月日 + 几点），不写「截止」二字 */}
          <div className="mt-0.5 text-ui-xs text-ink-500">{formatDue(p.dueAt)}</div>
        </button>
      </div>
    )
  }

  /** 两列栅格：左研究、右课程，每行一个任务（纵向 = 紧急度） */
  const renderGrid = (list: Project[], gray: boolean) => (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-ink-100" />
      <div className="grid grid-cols-2 gap-x-ui-gap-sm gap-y-ui-gap-sm">
        {list.map((p) => {
          const isCourse = p.type === 'course'
          const card = renderCard(p, gray)
          return (
            <Fragment key={p.projectId}>
              <div className="min-w-0">{isCourse ? null : card}</div>
              <div className="min-w-0">{isCourse ? card : null}</div>
            </Fragment>
          )
        })}
      </div>
    </div>
  )

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-card border border-ink-200 bg-paper-50">
      <div className="af-line-b flex items-center gap-ui-gap px-ui-gap py-ui-gap-sm">
        <h2 className="flex items-center gap-ui-gap-sm text-ui-sm font-semibold text-ink-800">
          <CalendarClock className="h-ui-icon w-ui-icon text-seal-600" />
          DDL
        </h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-ui-gap">
        {/* 列头：左研究 / 右课程；每列头一个「+」新建该大类下的任务（空列表也保留，新建始终可达） */}
        <div className="af-line-b mb-ui-gap-sm grid grid-cols-2 gap-ui-gap-sm pb-ui-gap-sm">
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
                className="rounded-control-sm p-0.5 text-ink-300 transition hover:bg-seal-50 hover:text-seal-600"
              >
                <Plus className="h-ui-icon-sm w-ui-icon-sm" />
              </button>
            </div>
          ))}
        </div>

        {nothingToShow ? (
          <p className="py-6 text-center text-ui-sm text-ink-400">
            {expired.length > 0 || finished.length > 0
              ? `已隐藏 ${expired.length + finished.length} 个已过期 / 已完成任务`
              : '暂无带截止时间的任务'}
          </p>
        ) : (
          <>
            {active.length > 0 && renderGrid(active, false)}
            {showExpiredSection && (
              <div className={active.length > 0 ? 'mt-ui-gap' : ''}>
                <button
                  type="button"
                  onClick={() => setExpiredOpen((v) => !v)}
                  title={expiredOpen ? '折叠已过期' : '展开已过期'}
                  className="af-line-b flex w-full items-center gap-ui-gap-sm pb-ui-gap-sm text-ui-xs font-medium text-ink-400"
                >
                  {expiredOpen ? (
                    <ChevronDown className="h-ui-icon-sm w-ui-icon-sm" />
                  ) : (
                    <ChevronRight className="h-ui-icon-sm w-ui-icon-sm" />
                  )}
                  已过期
                  <span className="text-ui-2xs font-normal text-ink-300">{expired.length}</span>
                </button>
                {expiredOpen && <div className="mt-ui-gap-sm">{renderGrid(expired, true)}</div>}
              </div>
            )}
            {showDoneSection && (
              <div className={active.length > 0 || showExpiredSection ? 'mt-ui-gap' : ''}>
                <button
                  type="button"
                  onClick={() => setDoneOpen((v) => !v)}
                  title={doneOpen ? '折叠已完成' : '展开已完成'}
                  className="af-line-b flex w-full items-center gap-ui-gap-sm pb-ui-gap-sm text-ui-xs font-medium text-ink-400"
                >
                  {doneOpen ? (
                    <ChevronDown className="h-ui-icon-sm w-ui-icon-sm" />
                  ) : (
                    <ChevronRight className="h-ui-icon-sm w-ui-icon-sm" />
                  )}
                  已完成
                  <span className="text-ui-2xs font-normal text-ink-300">{finished.length}</span>
                </button>
                {doneOpen && <div className="mt-ui-gap-sm">{renderGrid(finished, true)}</div>}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}