/**
 * 会议 / 课程页（空壳 · 占位）
 * -------------------------------------------------
 * 一个页签、两种名：
 *   - 当前项目 type = 研究  → 显示「会议」
 *   - 当前项目 type = 课程  → 显示「课程」
 * 两者本质是**同一种东西**：实时记录一场「正在发生的事」（会议 / 一节课），
 * 结构也相似（录音分支 + 转写/笔记分支）。
 *
 * 与阅读页的区别：
 *   阅读页 = 打开一个已存在的东西，认真读它；
 *   本页   = 事情正在发生，边发生边记录，并持续看到实时生成的信息。
 *
 * TODO(架构调整 · 见 架构.md §2)：本页目前只占位。
 *   - 当前项目体系（type 属性、任务切换）尚未落地，故此处暂用静态文案；
 *     落地后应改为「跟随当前项目的 type」动态切换标题与文案。
 *   - 待落地能力：录音（后端 runner 转写，分片节奏待定）、实时转写片段展示、
 *     逐条笔记、以及「每 N 分钟一次转写心跳」的异常提示。
 *
 * 规格来源：架构.md §2 目标调整（项目制统一 / 日程页 / 会议·课程页）
 */
import { Mic, FileText, StickyNote } from 'lucide-react'

/** 空壳占位区块 */
function ShellBlock({
  icon: Icon,
  title,
  desc,
}: {
  icon: typeof Mic
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

export default function SessionPage() {
  // 当前项目体系未落地 —— 暂时固定为「研究」口径（显示「会议」）。
  // TODO(架构调整): 改为读取当前项目的 type（研究 → 会议 / 课程 → 课程）。
  const mode = 'research' as 'research' | 'course'
  const label = mode === 'course' ? '课程' : '会议'
  const kindText = mode === 'course' ? '课程型项目' : '研究型项目'

  return (
    <div className="page-container py-6">
      <header className="mb-6">
        <div className="flex items-center gap-2">
          <Mic className="h-5 w-5 text-seal-600" />
          <h1 className="text-lg font-semibold text-ink-800">{label}</h1>
          <span className="rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-500">
            {kindText}
          </span>
        </div>
        <p className="mt-1 text-sm text-ink-500">
          同一页两种名：研究型项目显示「会议」，课程型项目显示「课程」。这里是实时记录的地方。
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <ShellBlock
          icon={Mic}
          title="录音"
          desc="实时采集音频（浏览器麦克风），分层上传到私库；转写由后端 runner 承担。录音异常要能当场发现。"
        />
        <ShellBlock
          icon={FileText}
          title="转写"
          desc="转写片段按节奏回落到本页，边发生边可读；节奏与容错策略待定（见 架构.md §2）。"
        />
        <ShellBlock
          icon={StickyNote}
          title="笔记"
          desc="实时记录 + 逐条整理；与阅读页的「打开再学」不同，这里强调「边发生边记」。"
        />
      </div>

      <p className="mt-6 text-xs text-ink-400">
        TODO：本页为架构调整的空壳，尚未接入数据与交互；设计细节见 <code className="font-mono">架构.md</code> §2。
      </p>
    </div>
  )
}
