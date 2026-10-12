/**
 * 数据格式滚动迁移
 * -------------------------------------------------
 * 策略（Rosa 定，见 架构.md §1.10 数据类 / ADJ-54 / ADJ-57）：**数据格式只前进，不向后兼容**。
 * 旧数据一律用一次性迁移升级到新格式；迁移完成后入口（按钮 / 提示文字）自行消失，
 * 旧数据不允许变成永久技术债。**禁止**为旧格式写渲染兜底 / 兼容分支 ——
 * 需要适配时，写一个迁移，而不是写 if (old)。
 *
 * 版本号闸门（ADJ-57）：私库里存一份 `{DATA_VERSION}` 副本。启动时先比对 ——
 *   **一致 → 直接放行**（一轮探测都不跑，秒开；旧实现每次启动都要拉文件树 + 读表头）；
 *   **不一致 → 按版本区间直迁**，迁完把新版本号写回私库。
 * 直迁（ADJ-60）：只要「已记录世代」与「应用版本」**都存在**，升级路径就是确定的 ——
 *   直接执行 `since ∈ (已记录世代, DATA_VERSION]` 的迁移即可（增量闸门 ADJ-59 由此自然得出），
 *   **一轮探测都不跑**。探测（`detect()`）只在版本号**未知**（`stored === null`：全新设备 /
 *   版本号机制之前的老设备）时兜底，用来「猜」数据是不是旧格式。
 * 维护规则：**每新增一条迁移，必须把 `DATA_VERSION` +1，并给该迁移填 `since = 新版本号`**
 *   —— 否则老设备比对「一致」会跳过新迁移。
 *
 * 用法：页面挂载时 `pendingMigrations()` 探测；有则显示「更新数据」入口，点一下跑完即消失。
 */
import { loadCourses, saveCourses, type Course } from './scheduleData'
import { loadProjects, saveProjects, type Project, type ProjectType } from './projectData'
import { loadCategories } from './literatureCategoryData'
import { loadBookCategories, loadDocumentCategories } from './categoryData'
import {
  loadMaterialMeta,
  saveMaterialMeta,
  metaKey,
  normalizeMaterialId,
  type MaterialMeta,
  type MaterialType,
} from './materialMeta'
import { readCsvFile, writeCsvFile, writeMdFile, getRepoContext } from './userData'
import {
  readRepoTextFile,
  deleteRepoFiles,
  downloadRepoBinaryFile,
  uploadRepoBinaryFile,
  githubFetch,
} from './github'
import { migrateBase64Images } from './editorImages'
import { readAnyDocument } from './blocks.mjs'
import { splitMarkdownIntoParagraphs, alignParagraphs, alignedParagraphsToBlockDoc } from './translation'
import { STAGE_META, CSV_HEADERS_V2, type PipelineStage } from '../stores/taskQueue'
import { TRACKING_PLANS_PATH } from './trackingPlanData'
import { loadLiteratures, saveLiteratures, loadAiSourceText } from './literatureData'
import {
  loadWords,
  saveWords,
  hasDuplicatedMeaningDef,
  repairWordByRules,
  loadSentences,
  saveSentences,
  loadTranslations,
  saveTranslations,
  type SentenceData,
  type TranslationData,
  type TranslationDirection,
} from './learningData'
import {
  buildLearningInstruction,
  parseLearningJSON,
  buildTranslationItems,
  toStringArray,
} from './learningGen'
import { runDualEngine } from './ai/dual-engine'
import { useSettingsStore } from '../stores/settings'
import { APP_VERSION } from '../constants/version'

/**
 * 迁移影响的功能域（对应主导航页面）。
 * 迁移期间这些页面会**暂时锁定**（显示占位提示），避免用户读到 / 写到迁移中途的旧值，
 * 其他页面照常可用（ADJ-63）。
 */
export type MigrationDomain =
  | 'schedule'
  | 'tracking'
  | 'reading'
  | 'session'
  | 'learn'
  | 'writing'
  | 'management'

export interface Migration {
  /** 稳定 id，便于日后排查「哪些迁移跑过」 */
  id: string
  /** 本条迁移会改写哪些功能域的数据 —— 迁移期间这些页面锁定（ADJ-63） */
  affects: MigrationDomain[]
  /**
   * 引入世代：这条迁移是哪个 `DATA_VERSION` 加进来的。
   * 直迁（ADJ-60）：本设备记录在 `stored` 世代，则需要执行的就是 `since ∈ (stored, DATA_VERSION]`
   * 这一段 —— 版本号已知即可直接定出要跑哪些，无需探测。新增迁移时写当前 `DATA_VERSION`（与 +1 规则同步）。
   */
  since: number
  /** 展示给用户的说明（迁移入口上的文字） */
  label: string
  /**
   * **仅在版本号未知时**（`stored === null` 的兜底探测）有意义：设 true 的迁移跑过一次就记台账、
   * 之后直接跳过探测（内容级探测要逐个读仓库文件，不设此项会重复读）。
   */
  ledger?: boolean
  /**
   * 探测：当前私库数据是否仍是旧格式、需要迁移。
   * **仅在版本号未知时兜底使用** —— 版本号已知时直接按 `since` 区间直迁，不调用它（ADJ-60）。
   */
  detect: () => Promise<boolean>
  /**
   * 执行迁移：把旧格式数据就地升级为新格式。
   * 重量级迁移（要逐个读 / 挪仓库文件）应接收 `onProgress` 并汇报本条迁移内部的子进度
   * （0..1）；轻量迁移忽略它即可（函数少传参是合法的）。迁移屏据此拼出总进度条（ADJ-61）。
   */
  run: (onProgress?: (fraction: number) => void) => Promise<void>
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
  affects: ['schedule', 'tracking'],
  since: 2,
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
          done: false,
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
  affects: ['schedule'],
  since: 2,
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
  affects: ['tracking'],
  since: 2,
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
          // done 列由后续的 projectsDoneField 迁移补齐，这里先给默认值
          done: false,
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
  affects: ['management'],
  since: 2,
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

/**
 * v2 → v3：调休表补 follow_weekday
 * 旧 extra_days.csv 只有 date + note（那时「调休」只让周末多出一列，不指定上哪天的课）。
 * 补班日真正要按某一周几的课表上课，故新增 follow_weekday 列；老行一律补 0（未指定 → 不排课），
 * 由用户在界面里按需指定。之后 loadExtraDays 便可直接假定三列。
 */
const EXTRA_DAYS_PATH = 'schedule/extra_days.csv'
const extraDaysFollowWeekday: Migration = {
  id: 'extra-days-follow-weekday-v1',
  affects: ['schedule'],
  since: 3,
  label: '升级调休表（新增 follow_weekday：指定补班按周几的课表）',
  detect: async () => {
    const header = await readCsvHeader(EXTRA_DAYS_PATH)
    return !!header && !header.includes('follow_weekday')
  },
  run: async () => {
    const rows = await readCsvFile<string[]>(EXTRA_DAYS_PATH, (r) => r.slice(1), true)
    // 直迁（ADJ-60）下 run 会无条件执行：没有调休数据（文件不存在 / 空表）就什么都不做，不凭空建表
    if (rows.length === 0) return
    const out = rows.map((r) => [r[0] || '', r[1] || '', '0'])
    await writeCsvFile(EXTRA_DAYS_PATH, out, ['date', 'note', 'follow_weekday'], (r) => r)
  },
}

/**
 * v4 → v5：课程表补 repeat / date 列
 * 新增「单次定时任务」——定时任务可以只是某一天的一次性事项（考试等），而非每周重复。
 * 旧表只有每周时段，故一律补 repeat='weekly'、date=''。之后 loadCourses 便可直接假定这两列存在。
 */
const coursesRepeatField: Migration = {
  id: 'courses-repeat-field-v1',
  affects: ['schedule'],
  since: 5,
  label: '升级课程表（新增 repeat / date：支持单次定时任务）',
  detect: async () => {
    const header = await readCsvHeader('schedule/courses.csv')
    return !!header && !header.includes('repeat')
  },
  run: async () => {
    const courses = await loadCourses(true)
    // 直迁（ADJ-60）下 run 会无条件执行：没有课程数据就什么都不做，不凭空建表
    if (courses.length === 0) return
    await saveCourses(courses.map((c) => ({ ...c, repeat: 'weekly', date: '' })))
  },
}

/**
 * v7 → v8：期刊表补 issn / publisher 列
 * 期刊追踪已改为「按 ISSN 精确检索」（后端 daily_tracking.py 用 ISSN 拉 OpenAlex），
 * 但旧 journals/journal_tracking.csv 只有 id/name/rss_url/enabled 四列，ISSN 无处可存 ——
 * 前端即使填了也会在写回时被丢弃。这里就地补两列（老行补空），之后前端便可直接假定六列。
 */
const JOURNALS_PATH = 'journals/journal_tracking.csv'
const journalsIssnField: Migration = {
  id: 'journals-issn-field-v1',
  affects: ['tracking'],
  since: 8,
  label: '升级期刊表（新增 issn / publisher：按 ISSN 精确追踪）',
  detect: async () => {
    const header = await readCsvHeader(JOURNALS_PATH)
    return !!header && !header.includes('issn')
  },
  run: async () => {
    const rows = await readCsvFile<string[]>(JOURNALS_PATH, (r) => r.slice(1), true)
    // 直迁（ADJ-60）下 run 会无条件执行：没有期刊数据（文件不存在 / 空表）就什么都不做，不凭空建表
    if (rows.length === 0) return
    const out = rows.map((r) => [r[0] || '', r[1] || '', r[2] || '', r[3] || '', '', ''])
    await writeCsvFile(
      JOURNALS_PATH,
      out,
      ['id', 'name', 'rss_url', 'enabled', 'issn', 'publisher'],
      (r) => r,
    )
  },
}

/**
 * v8 → v9：定时计划「每两周」→「每半个月」
 * 旧的「每两周·固定星期几」需要锚点（首次命中的星期几）才能算下一次，锚点缺失时会「算不出下次时间」；
 * 且间隔跨月对不齐。改为固定的「月初 1 日 + 月中 15 日」两个自然日（恰好 14 天），无需锚点、永远算得出。
 * 就地改写 plans.csv 里 interval=biweekly 的行：interval → semimonthly，weekdays 清空（semimonthly 不用）。
 */
const trackingPlanSemimonthly: Migration = {
  id: 'tracking-plan-semimonthly-v1',
  affects: ['tracking'],
  since: 9,
  label: '升级定时计划（每两周 → 每半个月：月初 1 日 + 月中 15 日）',
  detect: async () => {
    const rows = await readCsvFile<string[]>(TRACKING_PLANS_PATH, (r) => r, true)
    if (rows.length <= 1) return false
    const idx = rows[0].indexOf('interval')
    if (idx < 0) return false
    return rows.slice(1).some((r) => (r[idx] || '').trim() === 'biweekly')
  },
  run: async () => {
    const rows = await readCsvFile<string[]>(TRACKING_PLANS_PATH, (r) => r, true)
    // 直迁（ADJ-60）下 run 会无条件执行：没有计划数据（文件不存在 / 空表）就什么都不做
    if (rows.length <= 1) return
    const headers = rows[0]
    const iInterval = headers.indexOf('interval')
    const iWeekdays = headers.indexOf('weekdays')
    if (iInterval < 0) return
    const out = rows.slice(1).map((r) => {
      const row = r.slice()
      if ((row[iInterval] || '').trim() === 'biweekly') {
        row[iInterval] = 'semimonthly'
        if (iWeekdays >= 0) row[iWeekdays] = ''
      }
      return row
    })
    await writeCsvFile(TRACKING_PLANS_PATH, out, headers, (r) => r)
  },
}

/**
 * v9 → v10：重建存量文献作者串为「名 姓」
 * 旧库 authors 是 Crossref 口径的「姓, 名」（如 `Qian, Huijun; Li, Lei`），全站展示要「名 姓」
 * （如 `Huijun Qian; Lei Li`）。写入端已统一（新入库即「名 姓」），存量按 DOI 走 OpenAlex
 * 批量重拉**权威显示名**重建：OpenAlex 的 `author.display_name` 本身就是「名 姓」，
 * 而 Crossref 每个作者是分开的 family / given 两段、各出版社写法不一，故以 OpenAlex 为准。
 * OpenAlex 里查不到的条目**保留原作者串**，绝不猜、不置空。
 */
const OPENALEX_API_BASE = 'https://api.openalex.org'

/** 取裸 DOI（去 https://doi.org/ 前缀并小写），用于 OpenAlex 结果与本地记录对齐 */
function bareDoi(s: string): string {
  return (s || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase()
}

/**
 * 按 DOI 批量取 OpenAlex 作者显示名（「名 姓」，`; ` 连接），返回 map 的 key 是裸 DOI。
 * 依据 OpenAlex 官方约束：OR 过滤最多 100 个值且需 `per-page=100`，故按 100 分片请求；
 * 单片失败（网络 / 解析）不中断整批 —— 该片覆盖的文献保留原作者名。
 */
async function fetchOpenAlexAuthors(dois: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const CHUNK = 100
  for (let i = 0; i < dois.length; i += CHUNK) {
    const slice = dois.slice(i, i + CHUNK)
    const filter = 'doi:' + slice.map((d) => encodeURIComponent(bareDoi(d))).join('|')
    const url = `${OPENALEX_API_BASE}/works?filter=${filter}&per-page=100&select=doi,authorships`
    try {
      const resp = await fetch(url, { headers: { Accept: 'application/json' } })
      if (!resp.ok) continue
      const data = (await resp.json()) as {
        results?: Array<{
          doi?: string
          authorships?: Array<{ author?: { display_name?: string } }>
        }>
      }
      for (const r of data.results || []) {
        const doi = bareDoi(r.doi || '')
        const names = (r.authorships || [])
          .map((a) => (a.author?.display_name || '').trim())
          .filter(Boolean)
        if (doi && names.length > 0) out.set(doi, names.join('; '))
      }
    } catch {
      // 跳过该片，其余照常
    }
  }
  return out
}

const literatureAuthorsNormalize: Migration = {
  id: 'literature-authors-normalize-v1',
  affects: ['management', 'reading', 'writing', 'tracking'],
  since: 10,
  label: '重建文献作者名（统一为「名 姓」）',
  detect: async () => {
    // 兜底探测（仅版本号未知时用）：旧串是「姓, 名」，含逗号；新串「名 姓」不含
    const lits = await loadLiteratures(true)
    return lits.some((l) => l.authors.includes(','))
  },
  run: async () => {
    const lits = await loadLiteratures(true)
    if (lits.length === 0) return
    const authorsByDoi = await fetchOpenAlexAuthors(lits.map((l) => l.doi))
    // 一条都查不到 → 说明网络不通或全是 OpenAlex 未收录，保持原样不写（避免无意义的整表重写）
    if (authorsByDoi.size === 0) return
    const updated = lits.map((l) => {
      const authors = authorsByDoi.get(bareDoi(l.doi))
      return authors ? { ...l, authors } : l
    })
    // 复用 saveLiteratures 写入漏斗：保留 Bot 写的状态字段 / 通讯 / 共一，并按 isSameDoi 去重
    await saveLiteratures(updated)
  },
}

/**
 * 清洗历史脏数据：单词的「中文释义」与「中文定义」被写成同一个值。
 *
 * 根因在后端抽词管线（旧 WORDS_EXTRACT_PROMPT 把 definition_cn/en 定义成"释义"、且没有
 * word_cn 字段），写库时 `word_cn ← w.definition_cn` 与 `definition_cn ← w.definition_cn`
 * 同值复制，于是 vocabulary.csv 里大量词出现 `word_cn === definition_cn`。释义（翻译，短词）
 * 与定义（学术解释，一句话）本是两回事，同值即脏数据（已修后端，见 backend 14→15）。
 *
 * 本迁移只做「清洗」：按内容判断同一份值更符合哪个字段的角色，保对的一侧、清掉错的一侧；
 * **空出来的字段不凭空造**（语义字段规则造不出来），交由学习页「一键修复」（AI）补。
 * 「一键修复」/ 规则补丁保留作安全网（本迁移只处理存量，不替代它们）。
 */
const vocabMeaningDefCleanup: Migration = {
  id: 'vocab-meaning-def-cleanup-v1',
  affects: ['learn'],
  since: 11,
  label: '修单词「释义 = 定义」脏数据',
  detect: async () => {
    const words = await loadWords(true)
    return words.some(hasDuplicatedMeaningDef)
  },
  run: async () => {
    const words = await loadWords(true)
    if (words.length === 0) return
    let changed = false
    const next = words.map((w) => {
      // 只动「释义与定义同值」的脏词，其余原样保留（迁移只负责清洗，不顺手改别的）
      if (!hasDuplicatedMeaningDef(w)) return w
      const r = repairWordByRules(w, { resolveDuplicates: true })
      if (r.changed) changed = true
      return r.word
    })
    if (changed) await saveWords(next)
  },
}

/**
 * 为历史文献自动补提学习内容（长难句 + 摘要翻译）。
 *
 * 背景：过去补提历史文献要靠学习页两个手动按钮「批量补提历史文献」，用户不点就永远没有内容。
 * 现改为**版本更新管线自动执行**（ADJ-126）——新增学习内容不需要「兼容旧版」分支，直接作为
 * 一次数据迁移：迁移期间 `MigrationLock` 按 `affects` 自动锁住学习页并显示进度，迁完自动消失。
 *
 * 范围（与旧手动补提口径完全一致，共用 learningGen.ts 的同一套 prompt / 解析器）：
 *   - 长难句：只补「已转换出 md（mdStatus==='done'）且尚未提取过长难句」的文献（读 md 正文 → AI 提取）。
 *   - 摘要翻译：只补「有摘要（英/中至少一边非空）且尚未出过翻译题」的文献（题面/参考答案来自元数据）。
 *   - 单词不补（历史单词来自后端抽词管线，不属于这里的补提范畴）。
 *
 * 约束（ADJ-68 / ADJ-70）：prompt 早已把 JSON schema 约束死（见 buildLearningInstruction），解析失败
 * **不静默降级成空**；这里逐篇容错是为了「单篇失败不拖垮整批」，但**不掩盖失败** —— 收齐失败清单后
 * 抛出可读错误，由迁移屏保留锁域 + 提供重试（重试为增量：已增量落盘的文献会被跳过，只补失败的）。
 */
const learnAutoBackfill: Migration = {
  id: 'learn-auto-backfill-v1',
  affects: ['learn'],
  since: 12,
  label: '为历史文献自动补提学习内容',
  detect: async () => {
    const [lits, sentences, translations] = await Promise.all([
      loadLiteratures(true),
      loadSentences(),
      loadTranslations(),
    ])
    const sentenceDois = new Set(sentences.map((s) => s.sourceDoi).filter(Boolean))
    const translationDois = new Set(translations.map((t) => t.sourceDoi).filter(Boolean))
    return lits.some(
      (l) =>
        (l.mdStatus === 'done' && !sentenceDois.has(l.doi)) ||
        (((l.abstractEn || '').trim() || (l.abstractCn || '').trim()) &&
          !translationDois.has(l.doi)),
    )
  },
  run: async (onProgress) => {
    const settings = useSettingsStore.getState()
    const { ai1, ai2 } = settings.getDualEngineConfig()
    const sentenceCount = settings.sentenceGenCount || 8

    const [literatures, sentences, translations] = await Promise.all([
      loadLiteratures(true),
      loadSentences(),
      loadTranslations(),
    ])

    const sentenceDois = new Set(sentences.map((s) => s.sourceDoi).filter(Boolean))
    const translationDois = new Set(translations.map((t) => t.sourceDoi).filter(Boolean))
    const sentenceCandidates = literatures.filter(
      (l) => l.mdStatus === 'done' && !sentenceDois.has(l.doi),
    )
    const translationCandidates = literatures.filter(
      (l) =>
        (((l.abstractEn || '').trim() || (l.abstractCn || '').trim()) &&
          !translationDois.has(l.doi)),
    )

    const total = sentenceCandidates.length + translationCandidates.length
    if (total === 0) return

    let done = 0
    const report = () => onProgress?.(done / total)
    const failures: string[] = []

    // ── 长难句补提（串行逐篇；单篇失败不中断整批） ──
    if (sentenceCandidates.length > 0) {
      const instruction = buildLearningInstruction(
        { words: false, sentences: true, translation: false, wordCount: 0, sentenceCount },
        { en: '', cn: '' },
      )
      let next = [...sentences]
      for (const lit of sentenceCandidates) {
        try {
          const sourceMaterial = await loadAiSourceText(lit.doi)
          if (!sourceMaterial.trim()) {
            failures.push(`${lit.title || lit.doi}：未读到 md 正文（loadAiSourceText 为空）`)
          } else {
            const result = await runDualEngine({
              taskType: 'faithfulness_check',
              sourceMaterial,
              ai1Instruction: instruction,
              ai1,
              ai2,
            })
            const parsed = parseLearningJSON(result.ai1Output || '')
            const now = Date.now()
            const newItems: SentenceData[] = parsed.sentences
              .filter((s) => (s.sentenceEn || '').trim())
              .slice(0, sentenceCount)
              .map((s, i) => ({
                id: `ai_${now}_${i}_${Math.random().toString(36).slice(2, 6)}`,
                sentenceEn: s.sentenceEn || '',
                sentenceCn: s.sentenceCn || '',
                aiReferenceCn: s.aiReferenceCn || '',
                sourceDoi: lit.doi,
                status: 'new',
                addedAt: now,
                lastReview: 0,
                reviewCount: 0,
                sm2Interval: 1,
                sm2Ease: 2.5,
                scoringPoints: toStringArray(s.scoring_points),
                difficultyNote: (s.difficulty_note || '').trim() || undefined,
                latestUserTranslation: '',
                latestAiFeedback: '',
                latestErrorWords: '',
                practiceCount: 0,
                lastPractice: 0,
              }))
            if (newItems.length === 0) {
              // AI 没给出可用长难句：记为失败，绝不误报「已补提」
              failures.push(`${lit.title || lit.doi}：AI 未返回可用长难句`)
            } else {
              // 增量落盘：每篇完成立刻写回，失败重试时已完成的会被跳过
              next = [...next, ...newItems]
              await saveSentences(next)
            }
          }
        } catch (err) {
          failures.push(`${lit.title || lit.doi}：${err instanceof Error ? err.message : String(err)}`)
        }
        done++
        report()
      }
    }

    // ── 摘要翻译补提（串行逐篇；单篇失败不中断整批） ──
    if (translationCandidates.length > 0) {
      let next: TranslationData[] = [...translations]
      for (const lit of translationCandidates) {
        try {
          const en = (lit.abstractEn || '').trim()
          const cn = (lit.abstractCn || '').trim()
          if (!en && !cn) {
            failures.push(`${lit.title || lit.doi}：该文献没有摘要，无法出题`)
          } else {
            const sourceMaterial = [`【英文摘要】${en}`, `【中文摘要】${cn}`].join('\n\n')
            const instruction = buildLearningInstruction(
              { words: false, sentences: false, translation: true, wordCount: 0, sentenceCount: 0 },
              { en, cn },
            )
            const result = await runDualEngine({
              taskType: 'faithfulness_check',
              sourceMaterial,
              ai1Instruction: instruction,
              ai1,
              ai2,
            })
            const parsed = parseLearningJSON(result.ai1Output || '')
            const pointsByDirection: Partial<Record<TranslationDirection, string[]>> = {}
            const referenceOverride: Partial<Record<TranslationDirection, string>> = {}
            for (const t of parsed.translations) {
              const dir: TranslationDirection | null =
                t.direction === 'cn2en' ? 'cn2en' : t.direction === 'en2cn' ? 'en2cn' : null
              if (dir) pointsByDirection[dir] = toStringArray(t.scoring_points)
              const ref = (t.reference_translation || '').trim()
              if (dir && ref) referenceOverride[dir] = ref
            }
            // 题面 / 参考答案由元数据注入（缺一边时用 AI 补的参考译文）
            const items = buildTranslationItems(
              lit,
              pointsByDirection,
              Date.now(),
              `ai_${lit.doi}_`,
              referenceOverride,
            )
            if (items.length === 0) {
              failures.push(`${lit.title || lit.doi}：未能生成任何翻译题`)
            } else {
              next = [...next, ...items]
              await saveTranslations(next)
            }
          }
        } catch (err) {
          failures.push(`${lit.title || lit.doi}：${err instanceof Error ? err.message : String(err)}`)
        }
        done++
        report()
      }
    }

    report()
    // 收齐失败清单后如实报错（不静默降级）：迁移屏保留锁域并提示重试，重试为增量补漏。
    if (failures.length > 0) {
      const shown = failures.slice(0, 5).join('；')
      const more = failures.length > 5 ? ` 等 ${failures.length} 篇` : ''
      throw new Error(`历史文献补提有 ${failures.length} 篇未完成：${shown}${more}`)
    }
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
async function moveRepoFiles(
  moves: Array<{ from: string; to: string }>,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const ctx = getRepoContext()
  if (!ctx || moves.length === 0) return
  const movedFrom: string[] = []
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i]
    try {
      const res = await downloadRepoBinaryFile(ctx.owner, ctx.repo, m.from, ctx.token)
      if (!res) continue
      await uploadRepoBinaryFile(ctx.owner, ctx.repo, m.to, res.blob, ctx.token, `chore: migrate ${m.from}`)
      movedFrom.push(m.from)
    } catch (err) {
      // 单个失败不影响其余：宁可这条留着下次再迁，也不丢内容
      console.warn(`[migration] 迁移文件失败 ${m.from}:`, err)
    }
    // 文件搬运是这类迁移的大头，按「已搬运/总数」汇报子进度（留出尾部删除的余量）
    onProgress?.((i + 1) / moves.length * 0.9)
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
  affects: ['reading'],
  since: 2,
  label: '规整文献 md 文件名（fulltext / index → full.md，aligned → {slug}.md）',
  detect: async () => {
    const blobs = await listRepoBlobs()
    if (!blobs) return false
    for (const [, files] of topLevelFiles(blobs, LITERATURES_DIR)) {
      if (files.has('fulltext.md') || files.has('index.md') || files.has('aligned.md')) return true
    }
    return false
  },
  run: async (onProgress) => {
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
    await moveRepoFiles(moves, onProgress)
    await removeRepoFiles(redundant)
  },
}

/**
 * v1 → v2：旧译文献（full.md + translation.md，没有块文档）→ 块文档 {slug}.md
 *
 * 旧管线把译文单独存 translation.md，靠阅读页的启发式对齐渲染；现在阅读页只认块文档，
 * 而 loadAlignedMd 在 {slug}.md 缺失时会兜底到 full.md —— 结果这类文献的译文被英文原文顶掉、
 * 直接看不到。这里用「段落顺序对齐」把 full.md + translation.md 就地组装成 {slug}.md。
 *
 * {slug}.md 已有有效块文档时（多半是 literatureMdNames 刚由 aligned.md 迁来的双语稿），
 * translation.md 只是冗余旧文件，直接删掉 —— 旧格式一律不保留。
 */
const literatureTranslationV1: Migration = {
  id: 'literature-translation-v1',
  affects: ['reading'],
  since: 2,
  label: '把旧译文献的 full.md + translation.md 合并为块文档',
  ledger: true,
  detect: async () => {
    const blobs = await listRepoBlobs()
    if (!blobs) return false
    for (const [slug, files] of topLevelFiles(blobs, LITERATURES_DIR)) {
      if (!files.has('translation.md')) continue
      const hasCanonical = (files.get(`${slug}.md`) ?? 0) >= MIN_VALID_ALIGNED_BYTES
      if (hasCanonical || files.has('full.md')) return true
    }
    return false
  },
  run: async (onProgress) => {
    const blobs = await listRepoBlobs()
    if (!blobs) return
    const entries = [...topLevelFiles(blobs, LITERATURES_DIR)]
    for (let i = 0; i < entries.length; i++) {
      onProgress?.(i / Math.max(entries.length, 1))
      const [slug, files] = entries[i]
      if (!files.has('translation.md')) continue
      const dir = `${LITERATURES_DIR}/${slug}`
      const hasCanonical = (files.get(`${slug}.md`) ?? 0) >= MIN_VALID_ALIGNED_BYTES

      // 没有有效块文档 → 用 full.md + translation.md 现组一份
      if (!hasCanonical) {
        if (!files.has('full.md')) continue // 无原文可对齐，留着下次再说（绝不丢内容）
        const full = await readDocText(`${dir}/full.md`)
        const trans = await readDocText(`${dir}/translation.md`)
        if (!full || !trans) continue
        const aligned = alignParagraphs(
          splitMarkdownIntoParagraphs(full),
          splitMarkdownIntoParagraphs(trans),
        )
        const doc = alignedParagraphsToBlockDoc(aligned)
        await writeMdFile(`${dir}/${slug}.md`, doc, 'Merge legacy translation into canonical block doc')
      }

      // 已有（或刚生成）块文档 → translation.md 属旧格式冗余人，删掉
      await removeRepoFiles([`${dir}/translation.md`])
    }
  },
}

const TEXTBOOKS_DIR = 'textbooks'
const DOCUMENTS_DIR = 'documents'

/**
 * 「正文只有一个标准名」的目录（图书 / 其他文档）通用的文件名规整迁移：
 * 历史命名 full.md / index.md 一律收敛到 content.md；目标已存在时旧名视为冗余副本删除。
 * 规整后 loadBookContent / loadDocumentContent 只读 content.md，不再有候选名兜底。
 */
function makeContentRenameMigration(opts: {
  id: string
  since: number
  dir: string
  label: string
  aliases: string[]
  affects: MigrationDomain[]
}): Migration {
  return {
    id: opts.id,
    affects: opts.affects,
    since: opts.since,
    label: opts.label,
    detect: async () => {
      const blobs = await listRepoBlobs()
      if (!blobs) return false
      for (const [, files] of topLevelFiles(blobs, opts.dir)) {
        if (opts.aliases.some((n) => files.has(n))) return true
      }
      return false
    },
    run: async (onProgress) => {
      const blobs = await listRepoBlobs()
      if (!blobs) return
      const moves: Array<{ from: string; to: string }> = []
      const redundant: string[] = []
      for (const [sub, files] of topLevelFiles(blobs, opts.dir)) {
        const dir = `${opts.dir}/${sub}`
        const aliases = opts.aliases.filter((n) => files.has(n))
        if (aliases.length === 0) continue
        if (!files.has('content.md')) {
          moves.push({ from: `${dir}/${aliases[0]}`, to: `${dir}/content.md` })
          redundant.push(...aliases.slice(1).map((n) => `${dir}/${n}`))
        } else {
          redundant.push(...aliases.map((n) => `${dir}/${n}`))
        }
      }
      await moveRepoFiles(moves, onProgress)
      await removeRepoFiles(redundant)
    },
  }
}

const textbookMdNames = makeContentRenameMigration({
  id: 'textbook-md-names-v1',
  since: 2,
  dir: TEXTBOOKS_DIR,
  label: '规整图书正文文件名（full / index → content.md）',
  aliases: ['full.md', 'index.md'],
  affects: ['learn'],
})

const documentMdNames = makeContentRenameMigration({
  id: 'document-md-names-v1',
  since: 2,
  dir: DOCUMENTS_DIR,
  label: '规整文档正文文件名（full / index → content.md）',
  aliases: ['full.md', 'index.md'],
  affects: ['writing'],
})

/** 逐文件读正文（文本 md 走 Contents API，足够） */
async function readDocText(path: string): Promise<string | null> {
  const ctx = getRepoContext()
  if (!ctx) return null
  const r = await readRepoTextFile(ctx.owner, ctx.repo, path, ctx.token)
  return r?.content ?? null
}

/**
 * 会经 VditorEditor 编辑、因此可能残留 base64 内嵌图的 md：
 *   - projects 目录下的各类 md（manuscript / memory / brief）
 *   - 各阅读对象（文献 / 图书）的 notes.md
 * 其余 md（文献 full.md、图书 content.md 等）由阅读页渲染，图片本就独立成文件，不在此列。
 */
function isEditableDocPath(p: string): boolean {
  if (!p.endsWith('.md')) return false
  // 笔记已是多笔记结构：notes/{名称}.md（旧结构 notes.md 由 readingNotesMulti 迁移）
  return p.startsWith('projects/') || /\/notes\/[^/]+\.md$/.test(p)
}

async function editableDocPaths(): Promise<string[]> {
  const blobs = await listRepoBlobs()
  if (!blobs) return []
  return [...blobs.keys()].filter(isEditableDocPath)
}

/**
 * v1 → v2：正文内嵌 base64 图 → 仓库文件 + 语义路径。
 * md 里只该存仓库内路径（链接短、Git 友好、LaTeX 按路径挂载）；老数据是把图 base64 内嵌在正文里。
 * 逐张上传、成功一张换一张，任何一张失败就原样留着 —— 迁移绝不因一次网络抖动把图弄丢。
 */
const docImagesV1: Migration = {
  id: 'doc-images-v1',
  affects: ['tracking', 'reading', 'learn', 'writing'],
  since: 2,
  label: '把正文里内嵌的 base64 图片搬到仓库并改成语义路径',
  ledger: true,
  detect: async () => {
    for (const path of await editableDocPaths()) {
      const md = await readDocText(path)
      if (md && md.includes('data:image/')) return true
    }
    return false
  },
  run: async (onProgress) => {
    const paths = await editableDocPaths()
    for (let i = 0; i < paths.length; i++) {
      onProgress?.(i / Math.max(paths.length, 1))
      const path = paths[i]
      const md = await readDocText(path)
      if (!md || !md.includes('data:image/')) continue
      const { md: next, migrated } = await migrateBase64Images(md, path)
      if (migrated > 0 && next !== md) {
        await writeMdFile(path, next, 'Migrate embedded images to repo paths')
      }
    }
  },
}

const ANNOTATION_HEADERS = [
  'id', 'type', 'color', 'text', 'note', 'created_at', 'updated_at', 'anchor',
]

/** 所有批注文件路径：{literatures|textbooks|documents}/{id}/annotations/annotations.csv */
function annotationPaths(blobs: Map<string, number>): string[] {
  return [...blobs.keys()].filter((p) =>
    /^(literatures|textbooks|documents)\/[^/]+\/annotations\/annotations\.csv$/.test(p),
  )
}

/**
 * 在正文里找出该批注文字所属的块，返回块锚点（en-12 / cn-12）。
 * 命中**唯一**一块才返回，命中多处或一处都没有则返回空串（保持现状，交给按文本匹配兜底）。
 */
function anchorForText(md: string, text: string): string {
  const needle = text.trim()
  if (!needle) return ''
  const { items } = readAnyDocument(md)
  const hits: string[] = []
  for (const it of items) {
    if (it.t !== 'block' || !it.id) continue
    if (it.content.includes(needle)) hits.push(`en-${it.id}`)
    else if (it.cn && it.cn.includes(needle)) hits.push(`cn-${it.id}`)
  }
  return hits.length === 1 ? hits[0] : ''
}

/**
 * v1 → v2：升级旧批注表。
 *   1) 补齐 **anchor 列**（早期表没有这一列）——所有阅读对象（文献 / 图书 / 其他文档）统一；
 *   2) 文献批注额外**离线补块锚点**（en-12 / cn-12）：命中唯一块才补，否则留空。
 *
 * 锚点是「某一语言的某一段」，原文与译文是两个独立块、段号相同；补锚点后同一处批注在各显示模式
 * 之间切换都还落在同一段上，不再依赖「全篇文本匹配」这种会串文章的兜底。图书/文档批注的块锚点
 * 依赖渲染结果、无法离线确定，本迁移只保证列结构一致，值留空（运行时按文本匹配兜底）。
 */
const annotationAnchorsV2: Migration = {
  id: 'annotation-anchors-v2',
  affects: ['reading'],
  since: 2,
  label: '升级旧批注表（补齐 anchor 列；文献批注补块锚点）',
  ledger: true,
  detect: async () => {
    const blobs = await listRepoBlobs()
    if (!blobs) return false
    for (const path of annotationPaths(blobs)) {
      const rows = await readCsvFile<string[]>(path, (r) => r, true)
      if (rows.length <= 1) continue
      const header = rows[0].map((h) => h.trim())
      const iAnchor = header.indexOf('anchor')
      if (iAnchor < 0) return true // 缺列 → 任何对象都要补
      // 文献批注还要把「有列但空值」的补上
      if (path.startsWith('literatures/') && rows.slice(1).some((r) => !(r[iAnchor] ?? '').trim())) {
        return true
      }
    }
    return false
  },
  run: async (onProgress) => {
    const blobs = await listRepoBlobs()
    if (!blobs) return
    const paths = annotationPaths(blobs)
    for (let pi = 0; pi < paths.length; pi++) {
      onProgress?.(pi / Math.max(paths.length, 1))
      const path = paths[pi]
      const raw = await readCsvFile<string[]>(path, (r) => r, true)
      if (raw.length <= 1) continue
      const header = raw[0].map((h) => h.trim())
      const col = (n: string) => header.indexOf(n)
      const iAnchor = col('anchor')
      const iId = col('id')
      const iText = col('text')
      // 列名认不全就不动这个文件（宁可留着，也不要把 id / 正文写丢）
      if (iId < 0 || iText < 0) continue

      const isLiterature = path.startsWith('literatures/')
      const rows = raw.slice(1)
      if (iAnchor >= 0 && !(isLiterature && rows.some((r) => !(r[iAnchor] ?? '').trim()))) {
        continue // 已有 anchor 列，且无需补值的非文献批注 → 不必重写
      }

      // 文献：拿正文离线确定块锚点；图书/文档：仅补齐列结构
      let md = ''
      if (isLiterature) {
        const slug = path.split('/')[1]
        md =
          (await readDocText(`literatures/${slug}/${slug}.md`)) ??
          (await readDocText(`literatures/${slug}/full.md`)) ??
          ''
      }

      const out = rows.map((r) => {
        const anchor = iAnchor >= 0 ? (r[iAnchor] ?? '').trim() : ''
        const filled = anchor || (md ? anchorForText(md, r[iText] ?? '') : '')
        return [
          r[iId] ?? '',
          r[col('type')] ?? 'highlight',
          r[col('color')] ?? 'yellow',
          r[iText] ?? '',
          r[col('note')] ?? '',
          r[col('created_at')] ?? '0',
          r[col('updated_at')] ?? r[col('created_at')] ?? '0',
          filled,
        ]
      })
      await writeCsvFile(path, out, ANNOTATION_HEADERS, (r) => r)
    }
  },
}

/**
 * v3 → v4：任务表补 done 列
 * 新增「任务完成状态」——每个任务左边一个小圈圈，勾上 = 完成（划掉、变灰）；
 * 忘记勾而自动过期的，把圈里的叉点一下也能变勾。旧表没有 done 列，一律补 false（未完成）。
 * 之后 loadProjects 便直接假定该列存在，不再写旧格式分支。
 */
const projectsDoneField: Migration = {
  id: 'projects-done-field-v1',
  affects: ['schedule', 'tracking', 'session', 'writing'],
  since: 4,
  label: '升级项目表（补 done 列：任务完成状态）',
  detect: async () => {
    const header = await readCsvHeader(PROJECTS_PATH)
    return !!header && !header.includes('done')
  },
  run: async () => {
    const projects = await loadProjects(true)
    await saveProjects(projects.map((p) => ({ ...p, done: false })))
  },
}

/**
 * v5 → v6：阅读笔记从单文件 notes.md 升级为多笔记目录 notes/{名称}.md
 * 一篇文档（尤其图书）现在可以有多篇命名笔记。旧的单篇笔记挪到 notes/笔记.md；
 * 旧的笔记图片目录 notes-images/ 一并挪进 notes/images/。
 * 目标已存在时，旧文件视为冗余副本直接删除（避免探测永远为真、迁移反复出现）。
 */
const readingNotesMulti: Migration = {
  id: 'reading-notes-multi-v1',
  affects: ['reading', 'management', 'learn', 'writing'],
  since: 6,
  label: '把阅读笔记升级为「多笔记」（notes.md → notes/笔记.md，图片目录并入 notes/images）',
  detect: async () => {
    const blobs = await listRepoBlobs()
    if (!blobs) return false
    for (const root of [LITERATURES_DIR, TEXTBOOKS_DIR, DOCUMENTS_DIR]) {
      for (const [, files] of topLevelFiles(blobs, root)) {
        if (files.has('notes.md')) return true
      }
    }
    // 旧笔记图片目录 notes-images/ 下还有文件 → 需要挪进 notes/images/
    for (const p of blobs.keys()) {
      if (/^(literatures|textbooks|documents)\/.+\/notes-images\//.test(p)) return true
    }
    return false
  },
  run: async (onProgress) => {
    const blobs = await listRepoBlobs()
    if (!blobs) return
    const moves: Array<{ from: string; to: string }> = []
    const redundant: string[] = []
    for (const root of [LITERATURES_DIR, TEXTBOOKS_DIR, DOCUMENTS_DIR]) {
      for (const [id, files] of topLevelFiles(blobs, root)) {
        if (!files.has('notes.md')) continue
        const dir = `${root}/${id}`
        const target = `${dir}/notes/笔记.md`
        if (blobs.has(target)) redundant.push(`${dir}/notes.md`)
        else moves.push({ from: `${dir}/notes.md`, to: target })
      }
    }
    for (const p of blobs.keys()) {
      const m = /^(literatures|textbooks|documents)\/(.+)\/notes-images\/(.+)$/.exec(p)
      if (!m) continue
      const to = `${m[1]}/${m[2]}/notes/images/${m[3]}`
      if (blobs.has(to)) redundant.push(p)
      else moves.push({ from: p, to })
    }
    await moveRepoFiles(moves, onProgress)
    await removeRepoFiles(redundant)
  },
}

const OLD_CATEGORY_PATHS = [
  'literatures/categories.csv',
  'textbooks/categories.csv',
  'documents/categories.csv',
]

/**
 * v6 → v7：分类体系统一为「任务 + 标签」
 * 旧的三种分类（文献 / 图书 / 其他文档各一份 categories.csv）语义重叠：既当归档维度、
 * 又当任务归属，还和项目侧 references 打架。现在收敛为单一真源 materials/meta.csv：
 * 每份材料记 { 归属任务 task_id, 自由标签 tags }。
 * 旧分类名一律折叠成「标签」（分类本就更接近打标签），任务归属留空、由用户在界面里指定。
 * 迁完删除旧文件 —— 数据格式只前进，不留旧格式分支。
 */
const materialsTaskTags: Migration = {
  id: 'materials-task-tags-v1',
  affects: ['management', 'reading'],
  since: 7,
  label: '把旧的「分类」升级为「任务 + 标签」',
  detect: async () => {
    for (const p of OLD_CATEGORY_PATHS) {
      if ((await readDocText(p)) !== null) return true
    }
    return false
  },
  run: async () => {
    const [litCats, bookCats, docCats, existing] = await Promise.all([
      loadCategories(true),
      loadBookCategories(true),
      loadDocumentCategories(true),
      loadMaterialMeta(true),
    ])
    const map = new Map<string, MaterialMeta>()
    for (const m of existing) map.set(metaKey(m.type, m.id), { ...m, tags: [...m.tags] })
    const addTag = (type: MaterialType, id: string, tag: string) => {
      const name = (tag || '').trim()
      if (!name || !id) return
      const key = metaKey(type, id)
      const cur = map.get(key) ?? { type, id: normalizeMaterialId(type, id), taskId: '', tags: [] }
      if (!cur.tags.includes(name)) cur.tags.push(name)
      map.set(key, cur)
    }
    for (const c of litCats) for (const doi of c.dois) addTag('paper', doi, c.name)
    for (const c of bookCats) for (const b of c.members) addTag('book', b, c.name)
    for (const c of docCats) for (const d of c.members) addTag('document', d, c.name)
    if (map.size > 0) await saveMaterialMeta([...map.values()])
    const toDelete: string[] = []
    for (const p of OLD_CATEGORY_PATHS) {
      if ((await readDocText(p)) !== null) toDelete.push(p)
    }
    await removeRepoFiles(toDelete)
  },
}

// 顺序即执行顺序：先补全 projects 表结构，再修正 courses 脏值，最后挂课程任务（依赖前两者保证的列与合法值）。
export const MIGRATIONS: Migration[] = [
  projectsSchemaLink,
  coursesWeekdayFix,
  coursesTaskLink,
  backgroundTasksV2,
  extraDaysFollowWeekday,
  literatureMdNames,
  literatureTranslationV1,
  textbookMdNames,
  documentMdNames,
  docImagesV1,
  annotationAnchorsV2,
  projectsDoneField,
  coursesRepeatField,
  readingNotesMulti,
  materialsTaskTags,
  journalsIssnField,
  trackingPlanSemimonthly,
  literatureAuthorsNormalize,
  vocabMeaningDefCleanup,
  learnAutoBackfill,
]

const APPLIED_MIGRATIONS_PATH = 'settings/applied-migrations.csv'
const APPLIED_HEADERS = ['id', 'applied_at']

/**
 * 已执行迁移台账。
 * 文件名级迁移探测很便宜（拉一次文件树），但**内容级**迁移必须逐个读文件——每次启动都重跑探测
 * 无法接受。台账把「这条已经跑过」持久化下来：跑完记一行，之后直接跳过探测。
 */
async function loadAppliedMigrationIds(): Promise<Set<string>> {
  try {
    const rows = await readCsvFile<string[]>(APPLIED_MIGRATIONS_PATH, (r) => r.slice(1), true)
    return new Set(rows.map((r) => (r[0] || '').trim()).filter(Boolean))
  } catch (err) {
    console.warn('[migration] 读取迁移台账失败，按「未记录」处理:', err)
    return new Set()
  }
}

/** 记下一批已成功执行的迁移（失败不抛，不影响本次迁移结果） */
export async function markMigrationsApplied(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  try {
    const rows = await readCsvFile<string[]>(APPLIED_MIGRATIONS_PATH, (r) => r.slice(1), true)
    const known = new Set(rows.map((r) => (r[0] || '').trim()))
    let changed = false
    for (const id of ids) {
      if (known.has(id)) continue
      rows.push([id, String(Date.now())])
      known.add(id)
      changed = true
    }
    if (changed) await writeCsvFile(APPLIED_MIGRATIONS_PATH, rows, APPLIED_HEADERS, (r) => r)
  } catch (err) {
    console.warn('[migration] 写入迁移台账失败:', err)
  }
}

/**
 * 应用当前的数据格式版本号（多段版本号体系的 data 段，见 constants/version.ts）。
 * **每新增一条迁移就 +1**（比较用严格相等）。
 * 用户私库里存一份副本，启动时比对：一致 → 秒开放行；不一致 → 才逐条探测 / 迁移。
 */
export const DATA_VERSION = APP_VERSION.data

const DATA_VERSION_PATH = 'settings/data-version.csv'
const DATA_VERSION_HEADERS = ['version', 'updated_at']

/**
 * 读私库里记录的「数据格式版本」。读不到 / 非法 → null（当作未知，走探测）。
 * force=true 走网络拿最新，避免别的设备刚迁完、本机还拿旧缓存。
 */
async function loadStoredDataVersion(force = true): Promise<number | null> {
  const rows = await readCsvFile<string[]>(DATA_VERSION_PATH, (r) => r.slice(1), force)
  const v = (rows[0]?.[0] ?? '').trim()
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 取出当前仍待执行的迁移。
 *
 * 版本号已知（`stored !== null`）→ **直迁，不做任何探测**（ADJ-60）：
 *   版本走势是确定的，从 `stored` 到 `DATA_VERSION` 需要跑的就是 `since ∈ (stored, DATA_VERSION]`
 *   这一段，按序执行即可 —— 没必要逐条读文件去「猜」数据是不是旧格式。已记入台账的跳过，
 *   兜住「上一轮迁移跑完但版本号没来得及写回」的中断场景（避免非幂等迁移被重跑）。
 * 版本号未知（`stored === null`：全新设备 / 版本号机制之前的老设备）→ 只能逐条 `detect()` 兜底。
 */
export async function pendingMigrations(): Promise<Migration[]> {
  // 快路径：私库版本号与应用一致 → 直接放行，一轮探测都不跑
  const stored = await loadStoredDataVersion()
  if (stored === DATA_VERSION) return []

  const applied = await loadAppliedMigrationIds()

  if (stored !== null) {
    return MIGRATIONS.filter(
      (m) => m.since > stored && m.since <= DATA_VERSION && !applied.has(m.id),
    )
  }

  // 版本号未知 → 逐条探测兜底（仅全新设备 / 老设备首次升级会走到这里）
  const pending: Migration[] = []
  for (const m of MIGRATIONS) {
    if (m.ledger && applied.has(m.id)) continue
    try {
      if (await m.detect()) pending.push(m)
    } catch (err) {
      console.warn(`[migration] 探测 ${m.id} 失败:`, err)
    }
  }
  return pending
}

/**
 * 数据已确认是最新格式 → 把当前版本号写进私库，下次启动即可走秒开快路径。
 * 已一致则不重复写（避免每次启动都产生一个空提交）。
 */
export async function markDataVersionCurrent(): Promise<void> {
  try {
    if ((await loadStoredDataVersion(false)) === DATA_VERSION) return
    await writeCsvFile(
      DATA_VERSION_PATH,
      [[String(DATA_VERSION), String(Date.now())]],
      DATA_VERSION_HEADERS,
      (r) => r,
    )
  } catch (err) {
    console.warn('[migration] 写入数据版本失败:', err)
  }
}