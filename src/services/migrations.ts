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
import { loadProjects, saveProjects, type Project, type ProjectType } from './projectData'
import { readCsvFile, writeCsvFile, getRepoContext } from './userData'
import {
  readRepoTextFile,
  deleteRepoFiles,
  downloadRepoBinaryFile,
  uploadRepoBinaryFile,
  githubFetch,
} from './github'
import { STAGE_META, CSV_HEADERS_V2, type PipelineStage } from '../stores/taskQueue'

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

/**
 * v1 → v2：课程时段 weekday 归一化
 * 旧 courses.csv 的 weekday 可能是空 / 非数字（早期脏数据或手改文件），旧代码在渲染时兜底成 1。
 * 这里把非法值就地写成 1（与旧兜底行为一致），之后 loadCourses 便可直接假定 weekday 落在 1..7。
 */
const coursesWeekdayFix: Migration = {
  id: 'courses-weekday-v1',
  label: '修正课程表里非法的 weekday（旧值统一归到周一）',
  detect: async () => (await loadCourses()).some((c) => !(c.weekday >= 1 && c.weekday <= 7)),
  run: async () => {
    const courses = await loadCourses()
    await saveCourses(
      courses.map((c) => (c.weekday >= 1 && c.weekday <= 7 ? c : { ...c, weekday: 1 })),
    )
  },
}

const PROJECTS_PATH = 'projects/projects.csv'

/** 读某 CSV 的原始表头（只探测，不解析正文；文件不存在 / 读不到返回 null） */
async function readCsvHeader(path: string): Promise<string[] | null> {
  const ctx = getRepoContext()
  if (!ctx) return null
  try {
    const r = await readRepoTextFile(ctx.owner, ctx.repo, path, ctx.token)
    if (!r) return null
    return (r.content.split(/\r?\n/, 1)[0] ?? '').split(',').map((s) => s.trim())
  } catch (err) {
    console.warn(`[migration] 读取 ${path} 表头失败:`, err)
    return null
  }
}

/**
 * v1 → v2：项目表补 type / parent_id / start_at / due_at
 * 旧 projects.csv 只有前 7 列。升级时**冻结旧表结构**、就地补全：老项目一律作**研究类根任务**
 * （type='research'、无父、无起止），再按新表头整表重写。之后 loadProjects 便可直接假定新格式。
 */
const projectsSchemaLink: Migration = {
  id: 'projects-schema-v1',
  label: '升级项目表（补 type / parent_id / start_at / due_at 四列）',
  detect: async () => {
    const header = await readCsvHeader(PROJECTS_PATH)
    if (!header) return false
    return !header.includes('type')
  },
  run: async () => {
    const projects = await readCsvFile<Project>(
      PROJECTS_PATH,
      (rows) => {
        if (rows.length <= 1) return []
        return rows.slice(1).map((r) => ({
          projectId: r[0] || '',
          title: r[1] || '',
          targetJournal: r[2] || '',
          textbookRefs: r[3] || '',
          status: (r[4] as Project['status']) || 'draft',
          createdAt: parseInt(r[5] || '0', 10),
          updatedAt: parseInt(r[6] || '0', 10),
          // 旧表缺这四列 → 迁移时补默认值（这是迁移，不是运行时兼容）
          type: (r[7] as ProjectType) || 'research',
          parentId: r[8] || null,
          startAt: parseInt(r[9] || '0', 10),
          dueAt: parseInt(r[10] || '0', 10),
        }))
      },
      true,
    )
    await saveProjects(projects)
  },
}

/** 全部迁移（新格式变更就追加一条，只增不改；跑过的会因 detect 为 false 而自动隐身） */
const BACKGROUND_TASKS_PATH = 'settings/background_tasks.csv'

/**
 * v1 → v2：后台任务表头升级
 * 旧表用 current_step + step_index + total_steps 三列描述进度；v2 收敛为 stage + node_index。
 * 这里就地重写为 v2 表头：stage 取旧 step 名（认不出则 'queued'）、node_index 由 step_index 粗推。
 * 之后 taskQueue 的 parseTask 便可只认 v2，不写旧格式分支。
 */
const backgroundTasksV2: Migration = {
  id: 'background-tasks-v2',
  label: '升级后台任务表（current_step / step_index → stage / node_index）',
  detect: async () => {
    const header = await readCsvHeader(BACKGROUND_TASKS_PATH)
    return !!header && header.includes('current_step')
  },
  run: async () => {
    const v1Rows = await readCsvFile<string[]>(BACKGROUND_TASKS_PATH, (rows) => rows.slice(1), true)
    if (v1Rows.length === 0) return
    const v2Rows = v1Rows.map((r) => {
      const oldStep = (r[5] || '') as PipelineStage
      const stepIdx = Number(r[6]) || 0
      const node = stepIdx <= 0 ? 0 : stepIdx === 1 ? 1 : stepIdx === 2 ? 2 : 3
      const stage: PipelineStage = oldStep in STAGE_META ? oldStep : 'queued'
      return [
        r[0] || '', r[1] || '', r[2] || '', r[3] || '', r[4] || '',
        stage, String(node), r[8] || '0',
        r[9] || '', r[10] || '', r[11] || '0', r[12] || '0', r[13] || '', r[14] || '',
      ]
    })
    await writeCsvFile(BACKGROUND_TASKS_PATH, v2Rows, CSV_HEADERS_V2, (r) => r)
  },
}

// ============================================================
// 文档级迁移工具（遍历仓库文件 → 探测 → 就地改名 / 重写）
// ============================================================

/** 列出全仓库 blob → 字节数（递归；失败返回 null） */
async function listRepoBlobs(): Promise<Map<string, number> | null> {
  const ctx = getRepoContext()
  if (!ctx) return null
  try {
    const res = await githubFetch(
      `/repos/${ctx.owner}/${ctx.repo}/git/trees/main?recursive=1`,
      ctx.token,
    )
    if (!res.ok) return null
    const data = (await res.json()) as { tree?: Array<{ path: string; type: string; size?: number }> }
    const out = new Map<string, number>()
    for (const e of data.tree ?? []) {
      if (e.type === 'blob') out.set(e.path, e.size ?? 0)
    }
    return out
  } catch (err) {
    console.warn('[migration] 拉取仓库文件树失败:', err)
    return null
  }
}

/** 取某目录下的「一级条目」：key=子目录名，value=该子目录根下 文件名 → 字节数 */
function topLevelFiles(blobs: Map<string, number>, dir: string): Map<string, Map<string, number>> {
  const prefix = `${dir}/`
  const out = new Map<string, Map<string, number>>()
  for (const [p, size] of blobs) {
    if (!p.startsWith(prefix)) continue
    const rest = p.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash <= 0) continue // 目录根下的文件本身（无子目录）跳过
    const sub = rest.slice(0, slash)
    const file = rest.slice(slash + 1)
    if (file.includes('/')) continue // 只关心该子目录**根下**的文件
    if (!out.has(sub)) out.set(sub, new Map())
    out.get(sub)!.set(file, size)
  }
  return out
}

/** 小于该字节数的 {slug}.md 视为空壳（沿用 literatureData 的判定，历史 bug 留下的假成功文件） */
const MIN_VALID_ALIGNED_BYTES = 50

/**
 * 把一批文件挪到新路径（走二进制 API，兼容 >1MB 的 md，避免 Contents API 读成空串丢数据）：
 * 逐个 下载原文 → 写新路径；最后统一删掉旧路径。
 */
async function moveRepoFiles(moves: Array<{ from: string; to: string }>): Promise<void> {
  const ctx = getRepoContext()
  if (!ctx || moves.length === 0) return
  const movedFrom: string[] = []
  for (const m of moves) {
    try {
      const res = await downloadRepoBinaryFile(ctx.owner, ctx.repo, m.from, ctx.token)
      if (!res) continue
      await uploadRepoBinaryFile(ctx.owner, ctx.repo, m.to, res.blob, ctx.token, `chore: migrate ${m.from}`)
      movedFrom.push(m.from)
    } catch (err) {
      // 单个失败不影响其余：宁可这条留着下次再迁，也不丢内容
      console.warn(`[migration] 迁移文件失败 ${m.from}:`, err)
    }
  }
  if (movedFrom.length > 0) {
    await deleteRepoFiles(movedFrom, 'chore: drop migrated legacy files', ctx.owner, ctx.repo, ctx.token)
  }
}

/** 删掉一批冗余的旧路径文件（目标新路径已存在时用） */
async function removeRepoFiles(paths: string[]): Promise<void> {
  const ctx = getRepoContext()
  if (!ctx || paths.length === 0) return
  await deleteRepoFiles(paths, 'chore: drop redundant legacy files', ctx.owner, ctx.repo, ctx.token)
}

const LITERATURES_DIR = 'literatures'

/**
 * v1 → v2：规整文献 md 文件名
 * 旧名一律收敛到标准名，之后 loadFulltext / loadAlignedMd 直接读标准路径，不写兼容分支：
 *   - MinerU 原始产物：fulltext.md / index.md → full.md
 *   - 对译稿：aligned.md → {slug}.md
 * 目标文件已存在时，旧名视为冗余副本直接删除（否则探测永远为真、迁移反复出现）。
 */
const literatureMdNames: Migration = {
  id: 'literature-md-names-v1',
  label: '规整文献 md 文件名（fulltext / index → full.md，aligned → {slug}.md）',
  detect: async () => {
    const blobs = await listRepoBlobs()
    if (!blobs) return false
    for (const [, files] of topLevelFiles(blobs, LITERATURES_DIR)) {
      if (files.has('fulltext.md') || files.has('index.md') || files.has('aligned.md')) return true
    }
    return false
  },
  run: async () => {
    const blobs = await listRepoBlobs()
    if (!blobs) return
    const moves: Array<{ from: string; to: string }> = []
    const redundant: string[] = []
    for (const [slug, files] of topLevelFiles(blobs, LITERATURES_DIR)) {
      const dir = `${LITERATURES_DIR}/${slug}`
      // MinerU 原始产物 → full.md
      const fullAliases = ['fulltext.md', 'index.md'].filter((n) => files.has(n))
      if (fullAliases.length > 0) {
        const canonicalFull = `${dir}/full.md`
        if (!files.has('full.md')) {
          moves.push({ from: `${dir}/${fullAliases[0]}`, to: canonicalFull })
          redundant.push(...fullAliases.slice(1).map((n) => `${dir}/${n}`))
        } else {
          redundant.push(...fullAliases.map((n) => `${dir}/${n}`))
        }
      }
      // 对译稿 → {slug}.md（标准名已有非空内容时，旧 aligned.md 视为冗余副本删除）
      if (files.has('aligned.md')) {
        const from = `${dir}/aligned.md`
        const canonical = `${dir}/${slug}.md`
        const canonicalSize = files.get(`${slug}.md`) ?? 0
        if (canonicalSize < MIN_VALID_ALIGNED_BYTES) {
          moves.push({ from, to: canonical })
        } else {
          redundant.push(from)
        }
      }
    }
    await moveRepoFiles(moves)
    await removeRepoFiles(redundant)
  },
}

const TEXTBOOKS_DIR = 'textbooks'

/**
 * v1 → v2：规整图书正文文件名
 * 历史命名 full.md / index.md 一律收敛到 SPEC 约定的 content.md；
 * 目标已存在时旧名视为冗余副本删除。之后 loadBookContent 只读 content.md。
 */
const textbookMdNames: Migration = {
  id: 'textbook-md-names-v1',
  label: '规整图书正文文件名（full / index → content.md）',
  detect: async () => {
    const blobs = await listRepoBlobs()
    if (!blobs) return false
    for (const [, files] of topLevelFiles(blobs, TEXTBOOKS_DIR)) {
      if (files.has('full.md') || files.has('index.md')) return true
    }
    return false
  },
  run: async () => {
    const blobs = await listRepoBlobs()
    if (!blobs) return
    const moves: Array<{ from: string; to: string }> = []
    const redundant: string[] = []
    for (const [book, files] of topLevelFiles(blobs, TEXTBOOKS_DIR)) {
      const dir = `${TEXTBOOKS_DIR}/${book}`
      const aliases = ['full.md', 'index.md'].filter((n) => files.has(n))
      if (aliases.length === 0) continue
      if (!files.has('content.md')) {
        moves.push({ from: `${dir}/${aliases[0]}`, to: `${dir}/content.md` })
        redundant.push(...aliases.slice(1).map((n) => `${dir}/${n}`))
      } else {
        redundant.push(...aliases.map((n) => `${dir}/${n}`))
      }
    }
    await moveRepoFiles(moves)
    await removeRepoFiles(redundant)
  },
}

// 顺序即执行顺序：先补全 projects 表结构，再修正 courses 脏值，最后挂课程任务（依赖前两者保证的列与合法值）。
export const MIGRATIONS: Migration[] = [
  projectsSchemaLink,
  coursesWeekdayFix,
  coursesTaskLink,
  backgroundTasksV2,
  literatureMdNames,
  textbookMdNames,
]

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