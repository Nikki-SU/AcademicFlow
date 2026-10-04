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
import { toast } from 'sonner'
import {
  loadCourses,
  saveCourses,
  loadExtraDays,
  saveExtraDays,
  loadCalendar,
  saveCalendar,
  effectiveDueAtAll,
  resolveToday,
  weekdayOfDate,
  msOfDate,
  timeToMinutes,
  EMPTY_CALENDAR,
  type Course,
  type ExtraDay,
  type SchoolCalendar,
} from '../services/scheduleData'
import { loadYearHolidays, todayDateStr, type HolidayMap } from '../services/holidays'
import {
  loadProjects,
  saveProjects,
  saveBrief,
  saveTaskRequirements,
  renameProject,
  deleteProject,
  descendantIds,
  isOverdue,
  type Project,
  type ProjectDeleteMode,
  type ProjectType,
} from '../services/projectData'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { CourseTable } from '../components/schedule/CourseTable'
import type { SlotFormValue } from '../components/schedule/CourseFormModal'
import { DdlList } from '../components/schedule/DdlList'
import { TaskTree } from '../components/schedule/TaskTree'
import { TaskFormModal, type TaskFormValue, type ParentOption } from '../components/schedule/TaskFormModal'
import { buildParentOptions } from '../components/schedule/TaskPicker'
import { TaskDeleteModal } from '../components/schedule/TaskDeleteModal'
import { TaskRequirementsModal } from '../components/schedule/TaskRequirementsModal'
import { useTaskStore } from '../stores/task'
import { useWorkspaceStore } from '../stores/workspace'

/**
 * 统一任务编辑器的上下文：新建（指定大类 / 归属）或编辑已有任务。
 * 「创建 = 编辑的空字段特例」，故只用一个状态、一个弹层。
 */
type EditorState =
  | { mode: 'create'; type: ProjectType | null; parentId: string | null }
  | { mode: 'edit'; projectId: string }

/** 生成本地唯一 id（同伴随时间戳，避免同毫秒碰撞） */
function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** DDL 清单只看「未来一个月内」的交付项（≈30 天）；更远的完全不紧急，不必让用户平添恐慌 */
const MONTH_MS = 30 * 24 * 60 * 60 * 1000

export default function SchedulePage() {
  const [courses, setCourses] = useState<Course[]>([])
  const [extraDays, setExtraDays] = useState<ExtraDay[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [calendar, setCalendar] = useState<SchoolCalendar>(EMPTY_CALENDAR)
  const [savingCalendar, setSavingCalendar] = useState(false)
  const [holidays, setHolidays] = useState<HolidayMap>(new Map())
  const [isLoading, setIsLoading] = useState(true)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  // DDL 点任务 → 只读任务要求弹层（编辑从弹层里的「编辑」进编辑窗）
  const [viewTarget, setViewTarget] = useState<Project | null>(null)
  // DDL 联动高亮：悬停课表红线是瞬时的，点击是钉住的；二者任一即点亮对应条目
  const [hoverDdlId, setHoverDdlId] = useState<string | null>(null)
  const [pinnedDdlId, setPinnedDdlId] = useState<string | null>(null)
  const highlightDdlId = pinnedDdlId ?? hoverDdlId
  // 「显示过期」：收起 / 展示**任务栏**里的过期任务。DDL 栏已不再展示过期项（用户要求），
  // 故这个开关只作用于任务栏。
  const [showExpired, setShowExpired] = useState(true)
  // 「显示已完成」是**整页**开关：同时管 DDL 栏与任务栏里的已完成任务（隐藏 / 显示）
  const [showCompleted, setShowCompleted] = useState(true)

  const currentId = useTaskStore((s) => s.currentProjectId)
  const setCurrentProject = useTaskStore((s) => s.setCurrentProject)
  // 私库就绪后才读数据：刷新后落在此页时，workspace 检测是异步的，
  // 早读会拿到空表（getRepoContext 为空）且不再重试 —— 用户就以为任务丢了。
  const repo = useWorkspaceStore((s) => s.repo)

  const loadAll = useCallback(async () => {
    const [cs, eds, ps, cal, hs] = await Promise.all([
      loadCourses(),
      loadExtraDays(),
      loadProjects(),
      loadCalendar(),
      loadYearHolidays(new Date().getFullYear()),
    ])
    setCourses(cs)
    setExtraDays(eds)
    setProjects(ps)
    setCalendar(cal)
    setHolidays(hs)
  }, [])

  useEffect(() => {
    if (!repo) return
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
  }, [repo, loadAll])

  const byId = useMemo(() => {
    const m = new Map<string, Project>()
    for (const p of projects) m.set(p.projectId, p)
    return m
  }, [projects])

  /**
   * 展示用的任务表：把「有效结束时间」写进 dueAt 的**副本**（不改库里的 projects）。
   * 判定「有没有结束时间」只有一条标准 —— effectiveDueAtAll（自底向上汇总）：
   * - 叶子任务：显式设了截止时间 → 用它；课程没设 → 取校历「学期结束（放假）」。
   * - 父任务：取**子树里最晚的子 DDL** 与自身结束时间的较晚者；课程再与校历放假取较晚。
   * 这样「课程在期末周到期、而考试子任务还没到期」的矛盾不再出现。
   * 注意：有结束时间 ≠ 进右栏 DDL —— 课程 / 每周定时这类周期任务会被 ddlItems 再滤掉。
   */
  const displayProjects = useMemo(() => {
    const effMap = effectiveDueAtAll(projects, calendar)
    return projects.map((p) => {
      const eff = effMap.get(p.projectId) ?? p.dueAt
      return eff === p.dueAt ? p : { ...p, dueAt: eff }
    })
  }, [projects, calendar])

  /**
   * 「周期任务」= 挂了每周重复时段的任务（加课生成的课程、每周定时的组会等）。
   * 它们的 DDL 没有交付意义（一门课要上到期末周、组会周周都有），展示只会平添紧张，
   * 因此一律不进 DDL 清单，让它顺利过期即可（用户要求）。
   * 判据用「是否挂有每周重复时段」而不是 type==='course'：考试 / 课程论文这类一次性
   * 任务同样可能落在课程大类下，但它们没有每周时段，应当照常显示。
   */
  const periodicTaskIds = useMemo(
    () => new Set(courses.filter((c) => c.repeat === 'weekly' && c.taskId).map((c) => c.taskId)),
    [courses],
  )

  /**
   * DDL 清单：有结束时间、且不是周期任务。
   * 未完成的只保留「未来一个月内」（已过期 / 一个月以外都不展示 —— 用户要求）；
   * 已完成的仍交给页头「显示已完成」开关处理。按 dueAt 升序。
   */
  const ddlItems = useMemo(() => {
    const now = Date.now()
    return displayProjects
      .filter((p) => p.dueAt > 0 && !periodicTaskIds.has(p.projectId))
      .filter((p) => p.done || (p.dueAt > now && p.dueAt <= now + MONTH_MS))
      .sort((a, b) => a.dueAt - b.dueAt)
  }, [displayProjects, periodicTaskIds])

  // 页面里是否存在过期任务（未完成且已过点）—— 决定页头「显示过期」开关要不要出现
  const hasExpired = useMemo(() => displayProjects.some((p) => !p.done && isOverdue(p)), [displayProjects])
  // 页面里是否存在已完成任务 —— 决定页头「显示已完成」开关要不要出现
  const hasDone = useMemo(() => displayProjects.some((p) => p.done), [displayProjects])

  // 「新建任务」时可指定归属父任务（与大类一起构成两层选择）；不选归属即该大类下的顶级任务
  const parentOptions = useMemo<ParentOption[]>(() => buildParentOptions(projects), [projects])

  const editorProject = editor?.mode === 'edit' ? byId.get(editor.projectId) ?? null : null

  // 编辑目标若从数据里消失（重载 / 被删 / 迁移中间态），主动关掉编辑窗，
  // 避免渲染出「mode='edit' + project=null」的空壳（看起来像弹窗坏掉 / 闪退）
  useEffect(() => {
    if (editor?.mode === 'edit' && !byId.has(editor.projectId)) setEditor(null)
  }, [editor, byId])

  // 编辑时不能把任务挂到自己或自己的子孙下（会成环）——从归属候选里剔除
  const editorParentOptions = useMemo<ParentOption[]>(() => {
    if (!editorProject) return parentOptions
    const blocked = descendantIds(projects, editorProject.projectId)
    return parentOptions.filter((o) => !blocked.has(o.id))
  }, [parentOptions, projects, editorProject])

  // 今天该怎么排课：假期不上课 / 调休按指定周几 / 周末无课（见 services/scheduleData.resolveToday）
  const todayPlan = useMemo(
    () => resolveToday(todayDateStr(), extraDays, holidays),
    [extraDays, holidays],
  )

  // 校历改一项即落库（课程表顶栏就地编辑，不另设保存按钮）
  const updateCalendar = async (patch: Partial<SchoolCalendar>) => {
    const next = { ...calendar, ...patch }
    setCalendar(next)
    setSavingCalendar(true)
    try {
      await saveCalendar(next)
    } catch (err) {
      console.error('[Schedule] 保存校历失败:', err)
      toast.error('保存校历失败，请重试')
    } finally {
      setSavingCalendar(false)
    }
  }

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
      done: false,
    }
    const next = [...projects, task]
    await saveProjects(next)
    setProjects(next)
    return task
  }

  /** 单次时段的结束时刻 = 该任务的截止时间（DDL）；非单次 → null（保持 dueAt 不变） */
  const onceDueAt = (value: SlotFormValue): number | null => {
    if (value.repeat !== 'once') return null
    const s = value.slots[0]
    if (!s || !s.date) return null
    return msOfDate(s.date) + timeToMinutes(s.endTime) * 60_000
  }

  const handleCreateSlot = async (
    variant: 'course' | 'timed',
    value: SlotFormValue,
  ) => {
    try {
      let taskId = value.taskId
      let title = value.title
      // 单次（如考试）自带结束时间 → 同步为该任务的截止时间，于是也进 DDL 清单
      const due = onceDueAt(value)
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
          // 归属已有任务：单次日期同样要落盘，否则刷新后该任务的 DDL 会「变回去」
          if (due !== null && due !== task.dueAt) {
            const next = projects.map((p) =>
              p.projectId === task.projectId ? { ...p, dueAt: due, updatedAt: Date.now() } : p,
            )
            await saveProjects(next)
            setProjects(next)
          }
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
            dueAt: due ?? 0,
            done: false,
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
        repeat: value.repeat,
        date: value.repeat === 'once' ? s.date : '',
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
      const now = Date.now()
      // 本次编辑后时段归属的任务：整门课 = slot.taskId；单时段可改归属为 value.taskId
      const targetTaskId = all ? slot.taskId : value.taskId || slot.taskId
      // 把「重命名课程任务」「单次日期 → DDL」合并进同一次 saveProjects，
      // 否则两次串行 setProjects 会各自基于旧 projects 互相覆盖
      let nextProjects = projects
      let projectsChanged = false
      const patchTask = (taskId: string, patch: Partial<Project>) => {
        nextProjects = nextProjects.map((p) =>
          p.projectId === taskId ? { ...p, ...patch, updatedAt: now } : p,
        )
        projectsChanged = true
      }
      // 课程时段：允许改课程名 —— 同步重命名所属课程任务（所有时段跟着变）
      const slotTask = slot.taskId ? byId.get(slot.taskId) : undefined
      const isCourseSlot = !!slotTask && slotTask.type === 'course' && !slotTask.parentId
      if (isCourseSlot && slotTask && value.title.trim() && value.title.trim() !== slotTask.title) {
        patchTask(slotTask.projectId, { title: value.title.trim() })
      }
      // 单次时段的日期 → 该任务的截止时间；不落盘的话刷新后 DDL 会「变回去」
      const due = onceDueAt(value)
      if (due !== null && targetTaskId && byId.get(targetTaskId)?.dueAt !== due) {
        patchTask(targetTaskId, { dueAt: due })
      }
      if (projectsChanged) {
        await saveProjects(nextProjects)
        setProjects(nextProjects)
      }
      if (all) {
        // 编辑整门课全部时段：用新列表替换该任务名下的所有时段
        const rest = courses.filter((c) => c.taskId !== slot.taskId)
        const rebuilt: Course[] = value.slots.map((s) => ({
          courseId: genId('slot'),
          title: value.title,
          weekday: s.weekday,
          startTime: s.startTime,
          endTime: s.endTime,
          location: s.location,
          createdAt: now,
          taskId: slot.taskId,
          repeat: value.repeat,
          date: value.repeat === 'once' ? s.date : '',
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
                repeat: value.repeat,
                date: value.repeat === 'once' ? s0.date : '',
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
  /** 新建任务 / 子任务：字段全走统一编辑器，创建与编辑同一套字段 */
  const handleCreateTask = async (value: TaskFormValue) => {
    const now = Date.now()
    const project: Project = {
      projectId: genId('task'),
      title: value.title,
      targetJournal: '',
      textbookRefs: '',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      type: value.type,
      parentId: value.parentId,
      startAt: value.startAt,
      dueAt: value.dueAt,
      done: false,
    }
    const next = [...projects, project]
    try {
      await saveProjects(next)
      if (value.brief.trim()) await saveBrief(project.projectId, value.brief)
      if (value.notes !== null) await saveTaskRequirements(project.projectId, value.notes)
      setProjects(next)
      // 成功不弹提示：弹窗关闭本身就是成功的信号（用户嫌「成功弹窗」冗余）
    } catch (err) {
      console.error('[Schedule] 创建任务失败:', err)
      toast.error('创建任务失败，请重试')
      throw err
    }
  }

  /** 编辑任务：名称 / 大类 / 归属 / 开始 / 截止 / 详细描述 一次性落库 */
  const handleUpdateTask = async (projectId: string, value: TaskFormValue) => {
    const now = Date.now()
    const next = projects.map((p) =>
      p.projectId === projectId
        ? {
            ...p,
            title: value.title,
            type: value.type,
            parentId: value.parentId,
            startAt: value.startAt,
            dueAt: value.dueAt,
            updatedAt: now,
          }
        : p,
    )
    try {
      await saveProjects(next)
      await saveBrief(projectId, value.brief)
      if (value.notes !== null) await saveTaskRequirements(projectId, value.notes)
      setProjects(next)
      // 成功不弹提示：弹窗关闭本身就是成功的信号
    } catch (err) {
      console.error('[Schedule] 保存任务失败:', err)
      toast.error('保存失败，请重试')
      throw err
    }
  }

  const openCreateRoot = (type: ProjectType) =>
    setEditor({ mode: 'create', type, parentId: null })

  const openChildForm = (parent: Project) =>
    setEditor({ mode: 'create', type: parent.type, parentId: parent.projectId })

  const openEdit = (project: Project) =>
    setEditor({ mode: 'edit', projectId: project.projectId })

  // 点击课表红线：钉住 / 取消钉住对应 DDL 的高亮
  const togglePickDdl = (id: string) => setPinnedDdlId((prev) => (prev === id ? null : id))

  // ---------- 任务完成（打勾 / 划掉）----------
  /**
   * 切换任务完成状态：勾 = 划掉变灰；把过期的叉点一下即变为勾。
   * 不动 `updatedAt` —— 打勾不该让任务在「按修改顺序」里跳位。
   */
  const handleToggleDone = async (project: Project) => {
    const next = projects.map((p) =>
      p.projectId === project.projectId ? { ...p, done: !p.done } : p,
    )
    try {
      await saveProjects(next)
      setProjects(next)
    } catch (err) {
      console.error('[Schedule] 切换任务完成状态失败:', err)
      toast.error('操作失败，请重试')
    }
  }

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
      setEditor((prev) =>
        prev?.mode === 'edit' && prev.projectId === target.projectId ? null : prev,
      )
      toast.success(mode === 'purge' ? '已删除任务及独占材料' : '已删除任务')
    } catch (err) {
      console.error('[Schedule] 删除任务失败:', err)
      toast.error('删除失败，请重试')
      throw err
    }
  }

  // 三栏等高：外壳（Layout）已给 main 确定高度，页面本身用 flex 撑满「剩余高度」，
  // 三栏再据此等高。不再写 calc(100svh - 7.5rem) 这种魔法扣减——导航 / 页头 /
  // 内边距任何一处对不上，整页就会多出一条几像素的滚动条（ADJ-84）。
  const columnBox = 'min-h-ui-lane lg:min-h-0'

  return (
    <div className="page-container flex h-full flex-col py-ui-page">
      <header className="mb-ui-gap flex shrink-0 items-center justify-end gap-ui-gap">
        {/* 整页开关：一次隐藏 / 显示 DDL 栏与任务栏里的全部已过期 / 已完成任务 */}
        <div className="flex items-center gap-ui-gap">
            {hasExpired && (
              <button
                type="button"
                role="switch"
                aria-checked={showExpired}
                onClick={() => setShowExpired((v) => !v)}
                title={showExpired ? '隐藏已过期任务' : '显示已过期任务'}
                className="inline-flex items-center gap-ui-gap-sm text-ui-sm text-ink-500 transition hover:text-ink-700"
              >
                显示过期
                <span
                  className={`relative h-4 w-7 shrink-0 rounded-full transition ${
                    showExpired ? 'bg-seal-500' : 'bg-ink-200'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-3 w-3 rounded-full bg-paper-50 shadow-sm transition-all ${
                      showExpired ? 'left-3.5' : 'left-0.5'
                    }`}
                  />
                </span>
              </button>
            )}
            {hasDone && (
              <button
                type="button"
                role="switch"
                aria-checked={showCompleted}
                onClick={() => setShowCompleted((v) => !v)}
                title={showCompleted ? '隐藏已完成任务' : '显示已完成任务'}
                className="inline-flex items-center gap-ui-gap-sm text-ui-sm text-ink-500 transition hover:text-ink-700"
              >
                显示已完成
                <span
                  className={`relative h-4 w-7 shrink-0 rounded-full transition ${
                    showCompleted ? 'bg-seal-500' : 'bg-ink-200'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-3 w-3 rounded-full bg-paper-50 shadow-sm transition-all ${
                      showCompleted ? 'left-3.5' : 'left-0.5'
                    }`}
                  />
                </span>
              </button>
            )}
        </div>
      </header>

      {isLoading ? (
        <div className="flex min-h-ui-lane items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-200 border-t-seal-500" />
        </div>
      ) : (
        <div className="grid gap-ui-gap-lg lg:min-h-0 lg:flex-1 lg:grid-cols-ratio-111">
          <div className={columnBox}>
            <CourseTable
              courses={courses}
              extraDays={extraDays}
              projects={displayProjects}
              byId={byId}
              currentId={currentId}
              todayPlan={todayPlan}
              ddls={ddlItems}
              examWeekStartMs={msOfDate(calendar.examWeekStart)}
              calendar={calendar}
              savingCalendar={savingCalendar}
              onChangeCalendar={updateCalendar}
              highlightId={highlightDdlId}
              onHighlight={setHoverDdlId}
              onPickDdl={togglePickDdl}
              onCreateSlot={handleCreateSlot}
              onUpdateSlot={handleUpdateSlot}
              onDeleteCourse={handleDeleteCourse}
              onAddExtraDay={handleAddExtraDay}
              onDeleteExtraDay={handleDeleteExtraDay}
            />
          </div>
          <div className={columnBox}>
            <TaskTree
              projects={displayProjects}
              courses={courses}
              currentId={currentId}
              isLoading={isLoading}
              highlightId={highlightDdlId}
              showExpired={showExpired}
              showCompleted={showCompleted}
              onSelect={(id) => void setCurrentProject(id)}
              onNewRoot={openCreateRoot}
              onAddChild={openChildForm}
              onEdit={openEdit}
              onRename={handleRenameTask}
              onDelete={setDeleteTarget}
              onToggleDone={(p) => void handleToggleDone(p)}
            />
          </div>
          <div className={columnBox}>
            <DdlList
              projects={ddlItems}
              byId={byId}
              currentId={currentId}
              highlightId={highlightDdlId}
              showCompleted={showCompleted}
              onNewRoot={openCreateRoot}
              onView={setViewTarget}
              onToggleDone={(p) => void handleToggleDone(p)}
            />
          </div>
        </div>
      )}

      {editor && (editor.mode === 'create' || editorProject) && (
        <ErrorBoundary
          key={editor.mode === 'edit' ? `edit-${editor.projectId}` : 'create'}
          onClose={() => setEditor(null)}
        >
          <TaskFormModal
            mode={editor.mode}
            project={editorProject}
            initialType={editor.mode === 'create' ? editor.type : null}
            initialParentId={editor.mode === 'create' ? editor.parentId : null}
            parentOptions={editorParentOptions}
            onClose={() => setEditor(null)}
            onSubmit={(value) => {
              const done =
                editor.mode === 'edit'
                  ? handleUpdateTask(editor.projectId, value)
                  : handleCreateTask(value)
              void done
                .then(() => setEditor(null))
                .catch((err) => console.error('[Schedule] 保存任务失败:', err))
            }}
          />
        </ErrorBoundary>
      )}

      {deleteTarget && (
        <TaskDeleteModal
          project={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleDeleteTask}
        />
      )}

      {viewTarget && (
        <TaskRequirementsModal
          project={viewTarget}
          parentTitle={
            viewTarget.parentId ? byId.get(viewTarget.parentId)?.title || '(未命名任务)' : null
          }
          onClose={() => setViewTarget(null)}
          onEdit={() => {
            setViewTarget(null)
            openEdit(viewTarget)
          }}
        />
      )}
    </div>
  )
}