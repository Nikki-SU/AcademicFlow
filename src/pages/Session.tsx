/**
 * 会议 / 课程页（IDE 式三栏）
 * -------------------------------------------------
 * 同一页承载两种任务（见 架构.md ADJ-44）：
 *   - 当前任务 type = 研究 → 会议：灵活、非周期，随时可开
 *   - 当前任务 type = 课程 → 课程：刚性，每节课是一个定时任务
 * 两者本质是同一种东西：实时记录一场「正在发生的事」（会议 / 一节课）。
 *
 * 三栏（见 架构.md §2.4 / ADJ-30；比例默认 1:3:1，可拖成 1:2:2 / 1:1:3）：
 *   最左 会话归属（全部 / 所属大类 / 当前任务及其分支；选分支不改全局当前任务，只把会话落到该分支）
 *   中间 AI 录音 / 转写（绑 stores/recorder.ts，全局悬浮球同一个 store）
 *   右侧 传图片 · 材料采集（挂本页所选分支任务下）
 *
 * 录音 / 转写不绑架用户：真正的录音入口是挂在 Layout 顶层的**全局悬浮录音球**，
 * 切页面、切任务都不中断（ADJ-46）。本页中栏只是同一份状态的另一种呈现。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { GripVertical } from 'lucide-react'
import { toast } from 'sonner'
import { loadProjects, type Project } from '../services/projectData'
import { useTaskStore } from '../stores/task'
import SessionTaskTree from '../components/session/SessionTaskTree'
import SessionTranscript from '../components/session/SessionTranscript'
import SessionImages from '../components/session/SessionImages'
import { getSessionRightFr, setSessionRightFr } from '../services/uiState'

/**
 * 整页比例对应的「右栏 fr」五档：中:右 = 3:1 / 2:1 / 1:1 / 1:2 / 1:3
 * （右栏 = 1 / 4/3 / 2 / 8/3 / 3，左栏恒 1fr，总量恒 5fr）。
 * 松手吸附到最近一档；选中的档位存本机，下次打开自动回到这一档。
 */
const RIGHT_FR_SNAPS = [1, 4 / 3, 2, 8 / 3, 3]

export default function SessionPage() {
  const currentProjectId = useTaskStore((s) => s.currentProjectId)
  const loadCurrent = useTaskStore((s) => s.loadCurrent)

  // 本页会话归属：默认 = 全局当前任务。在这里选分支**不改全局当前任务**，
  // 只把本页会话（转写 / 图片）真实落到所选分支任务层级里。
  const [sessionScope, setSessionScope] = useState<string>(
    currentProjectId ? `node:${currentProjectId}` : 'all',
  )
  useEffect(() => {
    setSessionScope(currentProjectId ? `node:${currentProjectId}` : 'all')
  }, [currentProjectId])
  // 大类 / 全部这些非具体任务的归属，锚定到全局当前任务（一条会话必须落到某个真实任务下）
  const sessionTaskId = sessionScope.startsWith('node:') ? sessionScope.slice(5) : currentProjectId

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

  /**
   * 三栏比例：左 : 中 : 右 = 1 : (4 − rightFr) : rightFr（总量恒 5fr）。
   *   rightFr = 1 → 中:右 = 3:1（默认，与阅读页默认一致）
   *   4/3 → 2:1、2 → 1:1、8/3 → 1:2、3 → 1:3
   * 拖中缝改比例，松手吸附到最近一档（与阅读页同一套交互）；档位存本机，下次打开自动恢复。
   */
  const [rightFr, setRightFr] = useState(() => {
    const saved = getSessionRightFr()
    return saved !== null && RIGHT_FR_SNAPS.includes(saved) ? saved : 1
  })
  // 只在吸附到某一档（拖动松手后）才落盘，拖动过程中的中间值不记
  useEffect(() => {
    if (RIGHT_FR_SNAPS.includes(rightFr)) setSessionRightFr(rightFr)
  }, [rightFr])
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
      // 光标右移 = 中缝右移 = 中栏变宽、右栏变窄 → 右栏 fr 减少（分隔条始终跟手）
      const fr = el.clientWidth / 5
      const deltaFr = (dragStartX.current - e.clientX) / fr
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
      {/* 三栏默认 1:3:1，拖中缝可切换五档（中:右 = 3:1 / 2:1 / 1:1 / 1:2 / 1:3）；窄屏塌成三行堆叠。
          栅格**只有三列、等 gap**——拖动柄是叠加在缝隙上的绝对定位层（不占栏位），
          所以左↔中、中↔右的留白严格相等，最左栏与最右栏视觉对称。 */}
      <div
        ref={sessionGridRef}
        className="page-container py-ui-page relative min-h-0 flex-1 grid grid-cols-[var(--session-cols)] grid-rows-[minmax(0,1fr)] gap-ui-gap overflow-hidden max-[1100px]:grid-cols-1 max-[1100px]:grid-rows-[repeat(3,minmax(0,1fr))]"
        style={{
          '--session-cols': `minmax(0, 1fr) minmax(0, ${4 - rightFr}fr) minmax(0, ${rightFr}fr)`,
        } as CSSProperties}
      >
        <div className="min-w-0">
          <SessionTaskTree
            projects={projects}
            currentId={currentProjectId}
            selectedScope={sessionScope}
            isLoading={isLoading}
            onSelect={setSessionScope}
          />
        </div>

        <div className="relative min-w-0">
          <SessionTranscript taskId={sessionTaskId} />

          {/* 中缝拖动柄：**叠加**在「中↔右」的缝隙上（不再单独占一条栅格轨），
              全高可拖（按住从上到下任意位置都能拖），圆心落在缝正中 → 左右留白对称。
              宽屏专用，窄屏抽屉模式隐藏。 */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整中右两栏比例"
            onMouseDown={handleDividerDown}
            className={`absolute inset-y-0 z-10 hidden w-2 translate-x-1/2 cursor-col-resize touch-none items-center justify-center transition-colors min-[1101px]:flex ${
              isDragging ? 'bg-seal-200/60' : 'hover:bg-seal-200/50'
            }`}
            style={{ right: 'calc(var(--ui-gap) / -2)' }}
          >
            <span className="h-full w-px bg-ink-200" />
            <GripVertical className="absolute h-3 w-3 text-ink-400" />
          </div>
        </div>

        <div className="min-w-0">
          <SessionImages taskId={sessionTaskId} />
        </div>
      </div>
    </div>
  )
}
