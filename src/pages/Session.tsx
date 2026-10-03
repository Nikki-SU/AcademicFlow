/**
 * 会议 / 课程页（IDE 式三栏）
 * -------------------------------------------------
 * 一个页签、两种名：
 *   - 当前任务 type = 研究 → 显示「会议」
 *   - 当前任务 type = 课程 → 显示「课程」
 * 两者本质是同一种东西：实时记录一场「正在发生的事」（会议 / 一节课）。
 *
 * 三栏（见 架构.md §2.4 / ADJ-30；比例默认 1:3:1，可拖成 1:2:2 / 1:1:3）：
 *   最左 任务层级树（点一下切换「当前任务」）
 *   中间 AI 录音 / 转写（绑 stores/recorder.ts，全局悬浮球同一个 store）
 *   右侧 传图片 · 材料采集（挂当前任务分支下）
 *
 * 录音 / 转写不绑架用户：真正的录音入口是挂在 Layout 顶层的**全局悬浮录音球**，
 * 切页面、切任务都不中断（ADJ-46）。本页中栏只是同一份状态的另一种呈现。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { GripVertical, Mic } from 'lucide-react'
import { toast } from 'sonner'
import { loadProjects, type Project } from '../services/projectData'
import { useTaskStore } from '../stores/task'
import SessionTaskTree from '../components/session/SessionTaskTree'
import SessionTranscript from '../components/session/SessionTranscript'
import SessionImages from '../components/session/SessionImages'

/** 三档整页比例对应的「右栏 fr」：1→1:3:1、2→1:2:2、3→1:1:3（左栏恒 1fr，总量恒 5fr） */
const RIGHT_FR_SNAPS = [1, 2, 3]

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

  /**
   * 三栏比例：左 : 中 : 右 = 1 : (4 − rightFr) : rightFr（总量恒 5fr）。
   *   rightFr = 1 → 1:3:1（默认，与阅读页默认一致）
   *   rightFr = 2 → 1:2:2
   *   rightFr = 3 → 1:1:3
   * 拖中缝改比例，松手吸附到这三档（与阅读页同一套交互）。
   */
  const [rightFr, setRightFr] = useState(1)
  const [isDragging, setIsDragging] = useState(false)
  const sessionGridRef = useRef<HTMLDivElement>(null)
  const dragStartX = useRef(0)
  const dragStartFr = useRef(1)

  const handleDividerDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    dragStartX.current = e.clientX
    dragStartFr.current = rightFr
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  useEffect(() => {
    if (!isDragging) return
    const handleMouseMove = (e: MouseEvent) => {
      const el = sessionGridRef.current
      if (!el) return
      // 三栏总量恒为 5fr，1fr ≈ 容器宽 / 5；右栏每移动 1fr 就吃掉中栏 1fr
      const fr = el.clientWidth / 5
      const deltaFr = (e.clientX - dragStartX.current) / fr
      const next = Math.max(1, Math.min(3, dragStartFr.current + deltaFr))
      setRightFr(next)
    }
    const handleMouseUp = () => {
      setIsDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setRightFr((cur) =>
        RIGHT_FR_SNAPS.reduce((best, v) => (Math.abs(v - cur) < Math.abs(best - cur) ? v : best)),
      )
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

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

      {/* 三栏默认 1:3:1，拖中缝可在 1:3:1 / 1:2:2 / 1:1:3 间切换；窄屏塌成三行堆叠 */}
      <div
        ref={sessionGridRef}
        className="min-h-0 flex-1 grid grid-cols-[var(--session-cols)] grid-rows-[minmax(0,1fr)] gap-3 p-3 overflow-hidden max-[1100px]:grid-cols-1 max-[1100px]:grid-rows-[repeat(3,minmax(0,1fr))]"
        style={{
          '--session-cols': `minmax(0, 1fr) minmax(0, ${4 - rightFr}fr) 0.375rem minmax(0, ${rightFr}fr)`,
        } as CSSProperties}
      >
        <div className="min-w-0">
          <SessionTaskTree
            projects={projects}
            currentId={currentProjectId}
            isLoading={isLoading}
            onSelect={(id) => void setCurrentProject(id)}
          />
        </div>

        <div className="min-w-0">
          <SessionTranscript taskId={currentProjectId} />
        </div>

        {/* 中缝拖动柄：宽屏专用；左右拉在中、右两栏之间切换比例 */}
        <div
          className={`hidden min-[1101px]:flex items-center justify-center cursor-col-resize bg-ink-100 hover:bg-seal-100 transition-colors z-10 ${
            isDragging ? 'bg-seal-200' : ''
          }`}
          onMouseDown={handleDividerDown}
        >
          <GripVertical className="h-3 w-3 text-ink-400" />
        </div>

        <div className="min-w-0">
          <SessionImages taskId={currentProjectId} />
        </div>
      </div>
    </div>
  )
}
