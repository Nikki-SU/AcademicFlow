/**
 * 日程页（跨项目的总页面）
 * -------------------------------------------------
 * 定位：课程表、任务列表、DDL 在这里汇总，不隶属于任何单个项目（见 架构.md §2）。
 * - 左栏：课程表（竖排时间轴，一天一行；课程 / 定时任务都进这里，不因过期归档）。
 * - 中栏：任务列表（保留**层级与系列**，点节点切「当前任务」）。
 * - 右栏：DDL 清单（只展示有截止时间的任务，按 dueAt 升序，**扁平不分层级**）。
 * 三处同根同色（colorForRoot），课程表 / 任务列表 / DDL 全局一致。
 *
 * 「课程 = 课程任务」：加课时按名称复用/新建 type='course' 的根任务，多个时段共享同一任务，
 * 于是同一门课在课表 / 任务 / DDL 里始终同色；定时任务（如每周组会）则是「已有任务 + 时段」，
 * 可挂到「研究」大类下，也能单独改归属。
 *
 * 数据：schedule/courses.csv、schedule/extra_days.csv、projects/projects.csv，
 * 全走 business 数据层（md + csv），写失败一律 toast 提示。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { toast } from 'sonner'
import {
  loadCourses,
  saveCourses,
  loadExtraDays,
  saveExtraDays,
  weekdayOfDate,
  type Course,
  type ExtraDay,
} from '../services/scheduleData'
import {
  loadProjects,
  saveProjects,
  saveBrief,
  type Project,
  type ProjectType,
} from '../services/projectData'
import { CourseTable } from '../components/schedule/CourseTable'
import type { SlotFormValue } from '../components/schedule/CourseFormModal'
import { DdlList } from '../components/schedule/DdlList'
import { TaskTree } from '../components/schedule/TaskTree'
import { TaskFormModal, type TaskFormValue } from '../components/schedule/TaskFormModal'
import { TaskDetailModal } from '../components/schedule/TaskDetailModal'
import { useTaskStore } from '../stores/task'

/** 新建任务表单的上下文：根任务（选大类）或某个父节点的子任务（继承大类） */
interface TaskFormContext {
  title: string
  showType: boolean
  parentId: string | null
  type: ProjectType
}

/** 生成本地唯一 id（同伴随时间戳，避免同毫秒碰撞） */
function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export default function SchedulePage() {
  const [courses, setCourses] = useState<Course[]>([])
  const [extraDays, setExtraDays] = useState<ExtraDay[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [taskForm, setTaskForm] = useState<TaskFormContext | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)

  const currentId = useTaskStore((s) => s.currentProjectId)
  const setCurrentProject = useTaskStore((s) => s.setCurrentProject)

  const loadAll = useCallback(async () => {
    const [cs, eds, ps] = await Promise.all([loadCourses(), loadExtraDays(), loadProjects()])
    setCourses(cs)
    setExtraDays(eds)
    setProjects(ps)
  }, [])

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    ;(async () => {
      try {
        await loadAll()
      } catch (err) {
        console.error('[Schedule] 读取日程数据失败:', err)
        if (!cancelled) toast.error('读取日程数据失败，请刷新重试')
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadAll])

  const byId = useMemo(() => {
    const m = new Map<string, Project>()
    for (const p of projects) m.set(p.projectId, p)
    return m
  }, [projects])

  // 只保留有截止时间的节点，按 dueAt 升序（filter/sort 会新建数组，不改 projects）
  const ddlItems = useMemo(
    () => projects.filter((p) => p.dueAt > 0).sort((a, b) => a.dueAt - b.dueAt),
    [projects],
  )

  const detailProject = detailId ? byId.get(detailId) ?? null : null

  // ---------- 课程 / 定时任务：时段 ----------
  /** 加课时：同名课程复用同一个课程任务（高数周二 / 周四共享），否则新建 */
  const resolveCourseTask = async (name: string): Promise<Project> => {
    const existing = projects.find(
      (p) => p.type === 'course' && !p.parentId && (p.title || '') === name,
    )
    if (existing) return existing
    const now = Date.now()
    const task: Project = {
      projectId: genId('course'),
      title: name,
      targetJournal: '',
      textbookRefs: '',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      type: 'course',
      parentId: null,
      startAt: 0,
      dueAt: 0,
    }
    const next = [...projects, task]
    await saveProjects(next)
    setProjects(next)
    return task
  }

  const handleCreateSlot = async (
    weekday: number,
    variant: 'course' | 'timed',
    value: SlotFormValue,
  ) => {
    try {
      let taskId = value.taskId
      let title = value.title
      if (variant === 'course') {
        const task = await resolveCourseTask(value.title.trim())
        taskId = task.projectId
        title = task.title
      } else {
        const task = byId.get(value.taskId)
        if (!task) {
          toast.error('请选择要加入课表的任务')
          return
        }
        title = task.title || value.title
      }
      const course: Course = {
        courseId: genId('slot'),
        title,
        weekday,
        startTime: value.startTime,
        endTime: value.endTime,
        location: value.location,
        createdAt: Date.now(),
        taskId,
      }
      const next = [...courses, course]
      await saveCourses(next)
      setCourses(next)
      toast.success(variant === 'course' ? '已添加课程' : '已加入课表')
    } catch (err) {
      console.error('[Schedule] 添加时段失败:', err)
      toast.error('添加失败，请重试')
    }
  }

  const handleUpdateSlot = async (courseId: string, value: SlotFormValue) => {
    const slot = courses.find((c) => c.courseId === courseId)
    if (!slot) return
    try {
      // 课程时段：允许改课程名 —— 同步重命名所属课程任务（所有时段跟着变）
      const slotTask = slot.taskId ? byId.get(slot.taskId) : undefined
      const isCourseSlot = !!slotTask && slotTask.type === 'course' && !slotTask.parentId
      if (isCourseSlot && slotTask && value.title.trim() && value.title.trim() !== slotTask.title) {
        const newName = value.title.trim()
        const nextProjects = projects.map((p) =>
          p.projectId === slotTask.projectId ? { ...p, title: newName, updatedAt: Date.now() } : p,
        )
        await saveProjects(nextProjects)
        setProjects(nextProjects)
      }
      const next = courses.map((c) =>
        c.courseId === courseId
          ? {
              ...c,
              title: value.title,
              startTime: value.startTime,
              endTime: value.endTime,
              location: value.location,
              taskId: value.taskId || c.taskId,
            }
          : c,
      )
      await saveCourses(next)
      setCourses(next)
      toast.success('已保存时段')
    } catch (err) {
      console.error('[Schedule] 保存时段失败:', err)
      toast.error('保存失败，请重试')
    }
  }

  const handleDeleteCourse = async (courseId: string) => {
    const next = courses.filter((c) => c.courseId !== courseId)
    try {
      await saveCourses(next)
      setCourses(next)
    } catch (err) {
      console.error('[Schedule] 删除时段失败:', err)
      toast.error('删除失败，请重试')
    }
  }

  const handleAddExtraDay = async (date: string, note: string) => {
    // 调休的语义是「把某个周末日期标为工作日」，非周末日期不接受
    const weekday = weekdayOfDate(date)
    if (weekday !== 6 && weekday !== 7) {
      toast.warning('请选择周末日期（周六或周日）')
      return
    }
    if (extraDays.some((d) => d.date === date)) {
      toast.warning('该调休日已存在')
      return
    }
    const next = [...extraDays, { date, note }].sort((a, b) => a.date.localeCompare(b.date))
    try {
      await saveExtraDays(next)
      setExtraDays(next)
      toast.success('已添加调休日')
    } catch (err) {
      console.error('[Schedule] 添加调休日失败:', err)
      toast.error('添加调休日失败，请重试')
    }
  }

  const handleDeleteExtraDay = async (date: string) => {
    const next = extraDays.filter((d) => d.date !== date)
    try {
      await saveExtraDays(next)
      setExtraDays(next)
    } catch (err) {
      console.error('[Schedule] 删除调休日失败:', err)
      toast.error('删除调休日失败，请重试')
    }
  }

  // ---------- 任务 / DDL ----------
  const handleCreateTask = async (value: TaskFormValue, parentId: string | null) => {
    const now = Date.now()
    const project: Project = {
      projectId: String(now),
      title: value.title,
      targetJournal: '',
      textbookRefs: '',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      type: value.type,
      parentId,
      startAt: 0,
      dueAt: value.dueAt,
    }
    const next = [...projects, project]
    try {
      await saveProjects(next)
      setProjects(next)
      toast.success(parentId ? '已创建子任务' : '已创建任务')
    } catch (err) {
      console.error('[Schedule] 创建任务失败:', err)
      toast.error('创建任务失败，请重试')
    }
  }

  const handleSaveTask = async (projectId: string, title: string, brief: string) => {
    const now = Date.now()
    const next = projects.map((p) =>
      p.projectId === projectId ? { ...p, title, updatedAt: now } : p,
    )
    await saveProjects(next) // 失败会 throw，由详情弹层 toast 提示
    await saveBrief(projectId, brief)
    setProjects(next)
  }

  const openChildForm = (parent: Project) =>
    setTaskForm({
      title: `新建子任务 · ${parent.title || '(未命名任务)'}`,
      showType: false,
      parentId: parent.projectId,
      type: parent.type,
    })

  const columnHeight = 'lg:h-[calc(100vh-7.5rem)]'

  return (
    <div className="page-container py-6">
      <header className="mb-4">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5 text-seal-600" />
          <h1 className="text-lg font-semibold text-ink-800">日程</h1>
        </div>
        <p className="mt-1 text-sm text-ink-500">
          课程表 · 任务列表 · DDL 汇总于此。课程即课程任务，三处同族同色。
        </p>
      </header>

      {isLoading ? (
        <p className="text-sm text-ink-400">加载中…</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className={`min-h-[360px] ${columnHeight}`}>
            <CourseTable
              courses={courses}
              extraDays={extraDays}
              projects={projects}
              byId={byId}
              currentId={currentId}
              onCreateSlot={handleCreateSlot}
              onUpdateSlot={handleUpdateSlot}
              onDeleteCourse={handleDeleteCourse}
              onAddExtraDay={handleAddExtraDay}
              onDeleteExtraDay={handleDeleteExtraDay}
            />
          </div>
          <div className={`min-h-[360px] ${columnHeight}`}>
            <TaskTree
              projects={projects}
              currentId={currentId}
              isLoading={isLoading}
              onSelect={(id) => void setCurrentProject(id)}
              onNewRoot={() =>
                setTaskForm({ title: '新建任务', showType: true, parentId: null, type: 'research' })
              }
              onAddChild={openChildForm}
            />
          </div>
          <div className={`min-h-[360px] ${columnHeight}`}>
            <DdlList
              projects={ddlItems}
              byId={byId}
              currentId={currentId}
              onNewRoot={() =>
                setTaskForm({ title: '新建任务', showType: true, parentId: null, type: 'research' })
              }
              onAddChild={openChildForm}
              onOpen={(p) => setDetailId(p.projectId)}
            />
          </div>
        </div>
      )}

      {taskForm && (
        <TaskFormModal
          title={taskForm.title}
          showType={taskForm.showType}
          initialType={taskForm.type}
          onClose={() => setTaskForm(null)}
          onSubmit={(value) => {
            void handleCreateTask(value, taskForm.parentId)
            setTaskForm(null)
          }}
        />
      )}

      {detailProject && (
        <TaskDetailModal
          project={detailProject}
          onClose={() => setDetailId(null)}
          onSave={(title, brief) => handleSaveTask(detailProject.projectId, title, brief)}
        />
      )}
    </div>
  )
}