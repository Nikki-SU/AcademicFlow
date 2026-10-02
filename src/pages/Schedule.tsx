/**
 * 日程页（跨项目的总页面）
 * -------------------------------------------------
 * 定位：课程表、任务列表、DDL 在这里汇总，不隶属于任何单个项目（见 架构.md §2）。
 * - 左栏：课程表（竖排时间轴，一天一行；课程 / 定时任务都进这里，不因过期归档）。
 * - 中栏：任务列表（保留**层级与系列**，点节点切「当前任务」；**研究 / 课程左右分列**，各一竖列）。
 * - 右栏：DDL 清单（只展示有截止时间的任务，按 dueAt 升序；**研究在左、课程在右，每行一个任务**，
 *   纵向顺序 = 紧急度，**近的在前、远的在后**，不按时间间隔留白）。
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
  resolveToday,
  weekdayOfDate,
  type Course,
  type ExtraDay,
} from '../services/scheduleData'
import { loadYearHolidays, todayDateStr, type HolidayMap } from '../services/holidays'
import {
  loadProjects,
  saveProjects,
  saveBrief,
  renameProject,
  deleteProject,
  type Project,
  type ProjectDeleteMode,
  type ProjectType,
} from '../services/projectData'
import { CourseTable } from '../components/schedule/CourseTable'
import type { SlotFormValue } from '../components/schedule/CourseFormModal'
import { DdlList } from '../components/schedule/DdlList'
import { TaskTree } from '../components/schedule/TaskTree'
import { TaskFormModal, type TaskFormValue, type ParentOption } from '../components/schedule/TaskFormModal'
import { buildParentOptions } from '../components/schedule/TaskPicker'
import { TaskDetailModal } from '../components/schedule/TaskDetailModal'
import { TaskDeleteModal } from '../components/schedule/TaskDeleteModal'
import { useTaskStore } from '../stores/task'

/** 新建任务表单的上下文：根任务（选大类）或某个父节点的子任务（继承大类） */
interface TaskFormContext {
  title: string
  showType: boolean
  parentId: string | null
  /** null = 不预选大类 */
  type: ProjectType | null
}

/** 生成本地唯一 id（同伴随时间戳，避免同毫秒碰撞） */
function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export default function SchedulePage() {
  const [courses, setCourses] = useState<Course[]>([])
  const [extraDays, setExtraDays] = useState<ExtraDay[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [holidays, setHolidays] = useState<HolidayMap>(new Map())
  const [isLoading, setIsLoading] = useState(true)
  const [taskForm, setTaskForm] = useState<TaskFormContext | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)

  const currentId = useTaskStore((s) => s.currentProjectId)
  const setCurrentProject = useTaskStore((s) => s.setCurrentProject)

  const loadAll = useCallback(async () => {
    const [cs, eds, ps, hs] = await Promise.all([
      loadCourses(),
      loadExtraDays(),
      loadProjects(),
      loadYearHolidays(new Date().getFullYear()),
    ])
    setCourses(cs)
    setExtraDays(eds)
    setProjects(ps)
    setHolidays(hs)
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

  // 「新建任务」时可指定归属父任务（与大类一起构成两层选择）；不选归属即该大类下的顶级任务
  const parentOptions = useMemo<ParentOption[]>(() => buildParentOptions(projects), [projects])

  const detailProject = detailId ? byId.get(detailId) ?? null : null

  // 今天该怎么排课：假期不上课 / 调休按指定周几 / 周末无课（见 services/scheduleData.resolveToday）
  const todayPlan = useMemo(
    () => resolveToday(todayDateStr(), extraDays, holidays),
    [extraDays, holidays],
  )

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
        if (value.taskId) {
          const task = byId.get(value.taskId)
          if (!task) {
            toast.error('请选择要加入课表的任务')
            return
          }
          title = task.title || value.title
        } else {
          // 归属留空 → 用「任务名称」在所选大类下新建一个顶级任务，时段挂在它下面
          const now = Date.now()
          const task: Project = {
            projectId: genId('task'),
            title: value.title.trim(),
            targetJournal: '',
            textbookRefs: '',
            status: 'draft',
            createdAt: now,
            updatedAt: now,
            type: value.type,
            parentId: null,
            startAt: 0,
            dueAt: 0,
          }
          const next = [...projects, task]
          await saveProjects(next)
          setProjects(next)
          taskId = task.projectId
          title = task.title
        }
      }
      // 一次可加多个时段，共用一个任务（同名课程共享同一个课程任务）
      const now = Date.now()
      const newCourses: Course[] = value.slots.map((s) => ({
        courseId: genId('slot'),
        title,
        weekday: s.weekday,
        startTime: s.startTime,
        endTime: s.endTime,
        location: s.location,
        createdAt: now,
        taskId,
      }))
      const next = [...courses, ...newCourses]
      await saveCourses(next)
      setCourses(next)
      toast.success(variant === 'course' ? '已添加课程' : '已加入课表')
    } catch (err) {
      console.error('[Schedule] 添加时段失败:', err)
      toast.error('添加失败，请重试')
    }
  }

  const handleUpdateSlot = async (courseId: string, value: SlotFormValue, all: boolean) => {
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
      if (all) {
        // 编辑整门课全部时段：用新列表替换该任务名下的所有时段
        const rest = courses.filter((c) => c.taskId !== slot.taskId)
        const now = Date.now()
        const rebuilt: Course[] = value.slots.map((s) => ({
          courseId: genId('slot'),
          title: value.title,
          weekday: s.weekday,
          startTime: s.startTime,
          endTime: s.endTime,
          location: s.location,
          createdAt: now,
          taskId: slot.taskId,
        }))
        const next = [...rest, ...rebuilt]
        await saveCourses(next)
        setCourses(next)
      } else {
        const s0 = value.slots[0]
        const next = courses.map((c) =>
          c.courseId === courseId
            ? {
                ...c,
                title: value.title,
                weekday: s0.weekday,
                startTime: s0.startTime,
                endTime: s0.endTime,
                location: s0.location,
                taskId: value.taskId || c.taskId,
              }
            : c,
        )
        await saveCourses(next)
        setCourses(next)
      }
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

  const handleAddExtraDay = async (date: string, note: string, followWeekday: number) => {
    // 调休的语义是「把某个周末日期标为工作日，并按指定周几的课表上课」，非周末日期不接受
    const weekday = weekdayOfDate(date)
    if (weekday !== 6 && weekday !== 7) {
      toast.warning('请选择周末日期（周六或周日）')
      return
    }
    if (extraDays.some((d) => d.date === date)) {
      toast.warning('该调休日已存在')
      return
    }
    const next = [...extraDays, { date, note, followWeekday }].sort((a, b) =>
      a.date.localeCompare(b.date),
    )
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

  // ---------- 任务改名 / 删除（ADJ-64）----------
  const handleRenameTask = async (project: Project, title: string) => {
    try {
      const next = await renameProject(project.projectId, title)
      setProjects(next)
      toast.success('已改名')
    } catch (err) {
      console.error('[Schedule] 任务改名失败:', err)
      toast.error('改名失败，请重试')
    }
  }

  const handleDeleteTask = async (mode: ProjectDeleteMode) => {
    const target = deleteTarget
    if (!target) return
    try {
      const next = await deleteProject(target.projectId, mode)
      setProjects(next)
      if (currentId === target.projectId) await setCurrentProject(null)
      setDeleteTarget(null)
      setDetailId(null)
      toast.success(mode === 'purge' ? '已删除任务及独占材料' : '已删除任务')
    } catch (err) {
      console.error('[Schedule] 删除任务失败:', err)
      toast.error('删除失败，请重试')
      throw err
    }
  }

  // 三栏等高：外壳（Layout）已给 main 确定高度，直接按视口算可用高度（svh 兼容移动端）
  const columnHeight = 'lg:h-[calc(100svh-7.5rem)]'
  const columnBox = `min-h-ui-lane ${columnHeight}`

  return (
    <div className="page-container py-ui-gap-lg">
      <header className="mb-ui-gap">
        <div className="flex items-center gap-ui-gap-sm">
          <CalendarDays className="h-ui-icon w-ui-icon text-seal-600" />
          <h1 className="text-lg font-semibold text-ink-800">日程</h1>
        </div>
        <p className="mt-1 text-ui-sm text-ink-500">
          课程表 · 任务列表 · DDL 汇总于此。课程即课程任务，三处同族同色。
        </p>
      </header>

      {isLoading ? (
        <p className="text-ui-sm text-ink-400">加载中…</p>
      ) : (
        <div className="grid gap-ui-gap-lg lg:grid-cols-ratio-111">
          <div className={columnBox}>
            <CourseTable
              courses={courses}
              extraDays={extraDays}
              projects={projects}
              byId={byId}
              currentId={currentId}
              todayPlan={todayPlan}
              onCreateSlot={handleCreateSlot}
              onUpdateSlot={handleUpdateSlot}
              onDeleteCourse={handleDeleteCourse}
              onAddExtraDay={handleAddExtraDay}
              onDeleteExtraDay={handleDeleteExtraDay}
            />
          </div>
          <div className={columnBox}>
            <TaskTree
              projects={projects}
              currentId={currentId}
              isLoading={isLoading}
              onSelect={(id) => void setCurrentProject(id)}
              onNewRoot={() =>
                setTaskForm({ title: '新建任务', showType: true, parentId: null, type: null })
              }
              onAddChild={openChildForm}
              onRename={handleRenameTask}
              onDelete={setDeleteTarget}
            />
          </div>
          <div className={columnBox}>
            <DdlList
              projects={ddlItems}
              byId={byId}
              currentId={currentId}
              onNewRoot={() =>
                setTaskForm({ title: '新建任务', showType: true, parentId: null, type: null })
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
          initialParentId={taskForm.parentId}
          parentOptions={parentOptions}
          onClose={() => setTaskForm(null)}
          onSubmit={(value) => {
            void handleCreateTask(value, value.parentId)
            setTaskForm(null)
          }}
        />
      )}

      {detailProject && (
        <TaskDetailModal
          project={detailProject}
          onClose={() => setDetailId(null)}
          onSave={(title, brief) => handleSaveTask(detailProject.projectId, title, brief)}
          onDelete={() => setDeleteTarget(detailProject)}
        />
      )}

      {deleteTarget && (
        <TaskDeleteModal
          project={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleDeleteTask}
        />
      )}
    </div>
  )
}