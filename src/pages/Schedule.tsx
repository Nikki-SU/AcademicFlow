/**
 * 日程页（空壳 · 占位）
 * -------------------------------------------------
 * 定位：**跨项目的「总页面」** —— DDL 与课程表在这里汇总，不隶属于任何单个项目。
 *      它排在所有页面最前面（见 Layout 的 tabs）。
 *
 * TODO(架构调整 · 见 架构.md §2)：本页目前只占位，待落地的能力（由 Rosa 后续细化）：
 *   - DDL：加入时间 → DDL 时刻 为「持续时间」；过了持续时间即归档；
 *         可隶属于某个项目；跨项目提醒（切换任何页面都要能看到）；
 *         点击 → 跳转到该 DDL 所属项目。
 *   - 课程表：定时任务式的条目（**不因过期而归档**，其它时间也可查看）。
 *   - 任务切换器：一天多线并行（研究任务 + 课程任务）。
 *   - 提示阈值：设置里可选「1 / 3 / 7 天内常态悬置」，也可对单条 DDL 单独设。
 *
 * 规格来源：架构.md §2 目标调整（项目制统一 / 日程页 / 会议·课程页）
 */
import { CalendarDays, Clock, ListTodo, RefreshCw } from 'lucide-react'

/** 空壳占位区块：只说明「将来放什么」，不做任何数据读写 */
function ShellBlock({
  icon: Icon,
  title,
  desc,
}: {
  icon: typeof CalendarDays
  title: string
  desc: string
}) {
  return (
    <div className="rounded-xl border border-dashed border-ink-200 bg-paper-50 p-5">
      <div className="flex items-center gap-2 text-ink-700">
        <Icon className="h-4 w-4 text-seal-600" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-ink-500">{desc}</p>
      <p className="mt-3 text-xs text-ink-400">空壳占位 · 待实现</p>
    </div>
  )
}

export default function SchedulePage() {
  return (
    <div className="page-container py-6">
      <header className="mb-6">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5 text-seal-600" />
          <h1 className="text-lg font-semibold text-ink-800">日程</h1>
        </div>
        <p className="mt-1 text-sm text-ink-500">
          跨项目的总页面：DDL 与课程表汇总于此，与具体项目解耦。
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <ShellBlock
          icon={ListTodo}
          title="DDL"
          desc="某天加入的截止项；从加入时刻到 DDL 为持续时间，过期即归档。可隶属于某个项目，跨项目提醒，点击跳转到所属项目。"
        />
        <ShellBlock
          icon={Clock}
          title="课程表"
          desc="定时任务式条目（如每周某节课）；不因时间过去而归档，其它时间同样可以查看。"
        />
        <ShellBlock
          icon={RefreshCw}
          title="任务切换"
          desc="一天多线并行（研究任务 / 课程任务）的快速切换入口。项目带 type 属性：研究 · 课程。"
        />
      </div>

      <p className="mt-6 text-xs text-ink-400">
        TODO：本页为架构调整的空壳，尚未接入数据与交互；设计细节见 <code className="font-mono">架构.md</code> §2。
      </p>
    </div>
  )
}
