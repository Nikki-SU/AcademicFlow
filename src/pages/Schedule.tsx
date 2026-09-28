/**
 * 日程页（跨项目的总页面）
 * -------------------------------------------------
 * 定位：DDL 与课程表在这里汇总，不隶属于任何单个项目（见 架构.md §2）。
 * - 左栏：课程表（定时任务式条目，不因过期而归档）。
 * - 右栏：DDL 清单（只展示有截止时间的任务，按 dueAt 升序，不按层级堆叠）。
 *
 * 数据：schedule/courses.csv、schedule/extra_days.csv、projects/projects.csv，
 * 全走 business 数据层（md + csv），写失败一律 toast 提示。
 */
import { useEffect, useMemo, useState } from 'react'
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
import type { CourseFormValue } from '../components/schedule/CourseFormModal'
import { DdlList } from '../components/schedule/DdlList'
import { TaskFormModal, type TaskFormValue } from '../components/schedule/TaskFormModal'
import { TaskDetailModal } from '../components/schedule/TaskDetailModal'

/** 新建任务表单的上下文：根任务（选大类）或某个父节点的子任务（继承大类） */
interface TaskFormContext {
  title: string
  showType: boolean
  parentId: string | null
  type: ProjectType
}

export default function SchedulePage() {
  const [courses, setCourses] = useState<Course[]>([])
  const [extraDays, setExtraDays] = useState<ExtraDay[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [taskForm, setTaskForm] = useState<TaskFormContext | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    Promise.all([loadCourses(), loadExtraDays(), loadProjects()])
      .then(([cs, eds, ps]) => {
        if (cancelled) return
        setCourses(cs)
        setExtraDays(eds)
        setProjects(ps)
      })
      .catch((err) => {
        console.error('[Schedule] 读取日程数据失败:', err)
        if (!cancelled) toast.error('读取日程数据失败，请刷新重试')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

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

  // ---------- 课程表 ----------
  const handleAddCourse = async (weekday: number, value: CourseFormValue) => {
    const course: Course = {
      courseId: `course_${Date.now()}`,
      title: value.title,
      weekday,
      startTime: value.startTime,
      endTime: value.endTime,
      location: value.location,
      createdAt: Date.now(),
    }
    const next = [...courses, course]
    try {
      await saveCourses(next)
      setCourses(next)
      toast.success('已添加课程')
    } catch (err) {
      console.error('[Schedule] 添加课程失败:', err)
      toast.error('添加课程失败，请重试')
    }
  }

  const handleDeleteCourse = async (courseId: string) => {
    const next = courses.filter((c) => c.courseId !== courseId)
    try {
      await saveCourses(next)
      setCourses(next)
    } catch (err) {
      console.error('[Schedule] 删除课程失败:', err)
      toast.error('删除课程失败，请重试')
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

  // ---------- DDL 清单 ----------
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

  return (
    <div className="page-container py-6">
      <header className="mb-6">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5 text-seal-600" />
          <h1 className="text-lg font-semibold text-ink-800">日程</h1>
        </div>
        <p className="mt-1 text-sm text-ink-500">
          跨项目的总页面：课程表与 DDL 汇总于此，与具体项目解耦。
        </p>
      </header>

      {isLoading ? (
        <p className="text-sm text-ink-400">加载中…</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
          <CourseTable
            courses={courses}
            extraDays={extraDays}
            onAddCourse={handleAddCourse}
            onDeleteCourse={handleDeleteCourse}
            onAddExtraDay={handleAddExtraDay}
            onDeleteExtraDay={handleDeleteExtraDay}
          />
          <DdlList
            projects={ddlItems}
            byId={byId}
            onNewRoot={() =>
              setTaskForm({ title: '新建任务', showType: true, parentId: null, type: 'research' })
            }
            onAddChild={(parent) =>
              setTaskForm({
                title: `新建子任务 · ${parent.title || '(未命名任务)'}`,
                showType: false,
                parentId: parent.projectId,
                type: parent.type,
              })
            }
            onOpen={(p) => setDetailId(p.projectId)}
          />
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
