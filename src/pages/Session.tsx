/**
 * 会议 / 课程页（IDE 式三栏）
 * -------------------------------------------------
 * 一个页签、两种名：
 *   - 当前任务 type = 研究 → 显示「会议」
 *   - 当前任务 type = 课程 → 显示「课程」
 * 两者本质是同一种东西：实时记录一场「正在发生的事」（会议 / 一节课）。
 *
 * 三栏（见 架构.md §2.4 / ADJ-30）：
 *   最左 固定列 · 任务层级树（点一下切换「当前任务」）
 *   中间 AI 录音 / 转写（绑 stores/recorder.ts，全局悬浮球同一个 store）
 *   右侧 传图片 · 材料采集（挂当前任务分支下）
 *
 * 录音 / 转写不绑架用户：真正的录音入口是挂在 Layout 顶层的**全局悬浮录音球**，
 * 切页面、切任务都不中断（ADJ-46）。本页中栏只是同一份状态的另一种呈现。
 */
import { useEffect, useMemo, useState } from 'react'
import { Mic } from 'lucide-react'
import { toast } from 'sonner'
import { loadProjects, type Project } from '../services/projectData'
import { useTaskStore } from '../stores/task'
import SessionTaskTree from '../components/session/SessionTaskTree'
import SessionTranscript from '../components/session/SessionTranscript'
import SessionImages from '../components/session/SessionImages'

export default function SessionPage() {
  const currentProjectId = useTaskStore((s) => s.currentProjectId)
  const setCurrentProject = useTaskStore((s) => s.setCurrentProject)
  const loadCurrent = useTaskStore((s) => s.loadCurrent)

  const [projects, setProjects] = useState<Project[]>([])
  const [isLoading, setIsLoading] = useState(true)

  // 当前任务跨设备同步：进页面先拉一次（loadCurrent 自带去重，重复调用无副作用）
  useEffect(() => {
    void loadCurrent()
  }, [loadCurrent])

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    loadProjects()
      .then((ps) => {
        if (!cancelled) setProjects(ps)
      })
      .catch((err) => {
        console.error('[Session] 读取任务失败:', err)
        if (!cancelled) toast.error('读取任务失败，请刷新重试')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const current = useMemo(
    () => (currentProjectId ? projects.find((p) => p.projectId === currentProjectId) ?? null : null),
    [projects, currentProjectId],
  )

  // 课程 / 会议是同一页两种名，但结构不同（见 架构.md ADJ-44）：
  //   课程 —— 刚性：每节课是一个定时任务，结课必为「论文」或「考试」；
  //   会议 —— 灵活、非周期，随时可开；转写要判语种、必要时译中。
  const isCourse = current?.type === 'course'
  const label = isCourse ? '课程' : '会议'
  const kindText = isCourse ? '课时 = 定时任务' : '非周期 · 随时开'
  const hint = isCourse ? '结课：论文 / 考试' : '转写自动判语种，非中文自动译中'

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper-100">
      {/* 页头：命名随当前任务 type 走 */}
      <header className="flex shrink-0 items-center gap-2 border-b border-ink-200 bg-paper-50 px-4 py-2.5">
        <Mic className="h-4 w-4 text-seal-600" />
        <h1 className="text-sm font-semibold text-ink-800">{label}</h1>
        <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] text-ink-500">{kindText}</span>
        {current && (
          <span className="ml-2 min-w-0 truncate text-xs text-ink-500">{current.title || '(未命名任务)'}</span>
        )}
        <span className="ml-auto shrink-0 text-xs text-ink-400">{hint}</span>
      </header>

      {/* 三栏：侧栏固定宽、中栏自适应；窄屏横向滚动，功能不隐藏 */}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        <div className="w-56 shrink-0 lg:w-64">
          <SessionTaskTree
            projects={projects}
            currentId={currentProjectId}
            isLoading={isLoading}
            onSelect={(id) => void setCurrentProject(id)}
          />
        </div>

        <div className="min-w-[22rem] flex-1">
          <SessionTranscript taskId={currentProjectId} />
        </div>

        <div className="w-64 shrink-0 lg:w-72">
          <SessionImages taskId={currentProjectId} />
        </div>
      </div>
    </div>
  )
}
