/**
 * 数据格式滚动迁移
 * -------------------------------------------------
 * 策略（Rosa 定，见 架构.md §1.10 数据类 / ADJ-54）：**数据格式只前进，不向后兼容**。
 * 旧数据一律用一次性迁移升级到新格式；迁移完成后入口（按钮 / 提示文字）自行消失，
 * 旧数据不允许变成永久技术债。**禁止**为旧格式写渲染兜底 / 兼容分支 ——
 * 需要适配时，写一个迁移，而不是写 if (old)。 
 *
 * 用法：页面挂载时 `pendingMigrations()` 探测；有则显示「更新数据」入口，点一下跑完即消失。
 */
import { loadCourses, saveCourses, type Course } from './scheduleData'
import { loadProjects, saveProjects, type Project } from './projectData'

export interface Migration {
  /** 稳定 id，便于日后排查「哪些迁移跑过」 */
  id: string
  /** 展示给用户的说明（迁移入口上的文字） */
  label: string
  /** 探测：当前私库数据是否仍是旧格式、需要迁移 */
  detect: () => Promise<boolean>
  /** 执行迁移：把旧格式数据就地升级为新格式 */
  run: () => Promise<void>
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * v1 → v2：课程时段挂到「课程任务」
 * 旧 courses.csv 没有 task_id（那时课程还不是任务）。给每个缺 task_id 的时段按**标题复用/新建**
 * 一个 type='course' 的根任务，补上 task_id —— 老课程于是自动变成课程任务：三处同色、到点自动进任务。
 */
const coursesTaskLink: Migration = {
  id: 'courses-task-link-v1',
  label: '把旧课程表时段升级为「课程任务」',
  detect: async () => (await loadCourses()).some((c) => !c.taskId),
  run: async () => {
    const [courses, projects] = await Promise.all([loadCourses(), loadProjects()])

    let nextProjects = projects
    const byTitle = new Map<string, Project>()
    for (const p of nextProjects) {
      if (p.type === 'course' && !p.parentId) byTitle.set(p.title || '', p)
    }

    const nextCourses: Course[] = courses.map((c) => {
      if (c.taskId) return c
      const name = c.title || '未命名课程'
      let task = byTitle.get(name)
      if (!task) {
        const now = Date.now()
        task = {
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
        nextProjects = [...nextProjects, task]
        byTitle.set(name, task)
      }
      return { ...c, taskId: task.projectId }
    })

    await saveProjects(nextProjects)
    await saveCourses(nextCourses)
  },
}

/** 全部迁移（新格式变更就追加一条，只增不改；跑过的会因 detect 为 false 而自动隐身） */
export const MIGRATIONS: Migration[] = [coursesTaskLink]

/** 探测当前仍待执行的迁移 */
export async function pendingMigrations(): Promise<Migration[]> {
  const pending: Migration[] = []
  for (const m of MIGRATIONS) {
    try {
      if (await m.detect()) pending.push(m)
    } catch (err) {
      console.warn(`[migration] 探测 ${m.id} 失败:`, err)
    }
  }
  return pending
}