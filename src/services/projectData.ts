/**
 * 写作项目数据服务
 * -------------------------------------------------
 * SPEC §3：写作项目存储在 GitHub 私库 projects/ 目录。
 * - projects/projects.csv — 项目索引表
 * - projects/{project-id}/manuscript.md — 手稿正文
 * - projects/{project-id}/references/papers.csv — 文献引用
 * - projects/{project-id}/references/books.csv — 图书引用
 */

import { readCsvFile, writeCsvFile, readMdFile, writeMdFile, getRepoContext } from './userData'
import {
  deleteRepoFiles,
  listRepoPaths,
  listRepoFilesInDir,
  uploadRepoBinaryFile,
  downloadRepoBinaryFile,
} from './github'
import { loadLiteratures, saveLiteratures, doiToSlug } from './literatureData'
import { loadCategories, saveCategories } from './literatureCategoryData'
import { loadTextbooks, saveTextbooks } from './textbookData'

/** 任务大类：研究 / 课程（节点属性，不是独立层级） */
export type ProjectType = 'research' | 'course'

/**
 * 任务（≡ 项目 ≡ DDL）
 * -------------------------------------------------
 * 只有一棵树：节点 = 任务，任务由 DDL 驱动 —— 分层就用 `parentId` 串起来
 * （论文 = 大 DDL，节点 = 子 DDL，每周任务 = 再下一层），`dueAt` 就是它的截止时间。
 * - `type`     大类（研究 / 课程）
 * - `parentId` 父任务；`null` = 根
 * - `startAt`  开始时间（Unix ms）；`0` = 未设（「只有 DDL」时起始即创建时刻）
 * - `dueAt`    截止 / 结束时间（Unix ms）；`0` = 无截止（纯容器 / 无期限任务）
 */
export interface Project {
  projectId: string
  title: string
  targetJournal: string
  textbookRefs: string
  status: 'draft' | 'submitted' | 'accepted' | 'rejected'
  createdAt: number
  updatedAt: number
  type: ProjectType
  parentId: string | null
  startAt: number
  dueAt: number
}

export interface CitationRef {
  id: string
  doi: string
  title: string
  authors: string
  year: number
  journal: string
  type: 'paper' | 'book'
}

const PROJECTS_PATH = 'projects/projects.csv'
// ⚠️ 必须与 src/constants/skeleton.ts 的 CSV_HEADERS.projects 完全一致（顺序也一致）：
//    type/parent_id/start_at/due_at 为本轮新增，一律追加在末尾（守「新列一律追加末尾」）。
const PROJECT_HEADERS = [
  'project_id', 'title', 'target_journal', 'textbook_refs',
  'status', 'created_at', 'updated_at',
  'type', 'parent_id', 'start_at', 'due_at',
]

const CITATION_HEADERS = [
  'id', 'doi', 'title', 'authors', 'year', 'journal', 'type',
]

export async function loadProjects(force = false): Promise<Project[]> {
  return readCsvFile(
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
        // 四列均由迁移（services/migrations.ts）保证存在，这里不做旧格式兜底
        type: r[7] as ProjectType,
        parentId: r[8] || null,
        startAt: parseInt(r[9] || '0', 10),
        dueAt: parseInt(r[10] || '0', 10),
      }))
    },
    force,
  )
}

export async function saveProjects(projects: Project[]): Promise<void> {
  await writeCsvFile(
    PROJECTS_PATH,
    projects,
    PROJECT_HEADERS,
    (p) => [
      p.projectId,
      p.title,
      p.targetJournal,
      p.textbookRefs,
      p.status,
      String(p.createdAt),
      String(p.updatedAt),
      p.type || 'research',
      p.parentId ?? '',
      String(p.startAt || 0),
      String(p.dueAt || 0),
    ],
  )
}

/**
 * 当前任务（跨设备同步）
 * -------------------------------------------------
 * 落私库 `settings/current-task.md`（只一行 project_id），换设备打开即同一个任务。
 */
const CURRENT_TASK_PATH = 'settings/current-task.md'

export async function loadCurrentTaskId(): Promise<string | null> {
  const result = await readMdFile(CURRENT_TASK_PATH)
  const content = result?.content || ''
  const m = content.match(/project_id\s*[:=]\s*(\S+)/)
  return m ? m[1] : null
}

export async function saveCurrentTaskId(projectId: string | null): Promise<void> {
  const content = `# 当前任务\n\nproject_id:${projectId ? ` ${projectId}` : ''}\n\n---\n`
  await writeMdFile(CURRENT_TASK_PATH, content, 'Switch current task')
}

export async function loadManuscript(projectId: string): Promise<string> {
  const result = await readMdFile(`projects/${projectId}/manuscript.md`)
  return result?.content || ''
}

/**
 * AI 记忆（memory.md）
 * -------------------------------------------------
 * "项目即对话"：一个项目 = 一个 AI 对话，对话与 AI 记忆都落在这里。
 * md 格式，人可读、可回查、可手改；AI 忘了就回来读它。
 */
export async function loadMemory(projectId: string): Promise<string> {
  const result = await readMdFile(`projects/${projectId}/memory.md`)
  return result?.content || ''
}

export async function saveMemory(projectId: string, content: string): Promise<void> {
  await writeMdFile(`projects/${projectId}/memory.md`, content, 'Update AI memory')
}

/**
 * 任务简报（brief.md）
 * -------------------------------------------------
 * 任务的「详细描述」原文，日程页详情弹层里可编辑与粘贴。
 * 也是「AI 总结交付物」唯一允许引用的材料 —— 材料为空就不许凭空生成。
 * 单独存文件（而非塞进 projects.csv），因为它是大段自由文本。
 */
export async function loadBrief(projectId: string): Promise<string> {
  const result = await readMdFile(`projects/${projectId}/brief.md`)
  return result?.content || ''
}

export async function saveBrief(projectId: string, content: string): Promise<void> {
  await writeMdFile(`projects/${projectId}/brief.md`, content, 'Update task brief')
}

/**
 * 自定义快捷指令（全局，跨项目复用）
 * -------------------------------------------------
 * 存 settings/quick-actions.md，按 `## 指令名` 分节，正文就是发给 AI 的 prompt。
 * 内置指令（找文献 / 找引用 / 引用检验）写死在代码里，不进这个文件。
 */
export interface QuickAction {
  label: string
  prompt: string
}

const QUICK_ACTIONS_PATH = 'settings/quick-actions.md'

/** 按钮上的名字必须短 —— 超过这个长度的一律不认为是「名称」（见 loadQuickActions） */
const MAX_ACTION_LABEL = 24

/** 名称的形态判据：短、且不是一整句话（句末标点出现即视为描述） */
function looksLikeActionLabel(s: string): boolean {
  return s.length > 0 && s.length <= MAX_ACTION_LABEL && !/[。！？；]/.test(s)
}

export async function loadQuickActions(): Promise<QuickAction[]> {
  const result = await readMdFile(QUICK_ACTIONS_PATH)
  const content = result?.content || ''
  const actions: QuickAction[] = []
  const sections = content.split(/^##\s+/m).slice(1)
  for (const section of sections) {
    const nl = section.indexOf('\n')
    const label = (nl === -1 ? section : section.slice(0, nl)).trim()
    const body = (nl === -1 ? '' : section.slice(nl + 1)).trim()
    if (!label) continue
    // prompt 正文里若出现 `## 小标题`，上面的切分会把它当成一条新指令 ——
    // 那个「名称」是一整句话，按钮上根本显示不下（实测踩过）。
    // 判定不像名称的，当成上一条的续文拼回去（这正是它原来的位置）。
    if (!looksLikeActionLabel(label) && actions.length > 0) {
      const prev = actions[actions.length - 1]
      prev.prompt = `${prev.prompt}\n\n## ${label}${body ? `\n${body}` : ''}`.trim()
      continue
    }
    if (body) actions.push({ label, prompt: body })
  }
  return actions
}

export async function saveQuickActions(actions: QuickAction[]): Promise<void> {
  const body = actions.map((a) => `## ${a.label}\n${a.prompt}`).join('\n\n')
  const content = `# 快捷指令\n\n${body}${body ? '\n' : ''}`
  await writeMdFile(QUICK_ACTIONS_PATH, content, 'Update quick actions')
}

export async function saveManuscript(projectId: string, content: string): Promise<void> {
  await writeMdFile(
    `projects/${projectId}/manuscript.md`,
    content,
    'Update manuscript',
  )
}

/**
 * 项目的 LaTeX 产物
 * -------------------------------------------------
 * 与 manuscript.md 平级落盘，方便人直接翻仓库看 / 手改：
 * - projects/{project-id}/manuscript.tex — LaTeX 代码板里的完整源码
 * - projects/{project-id}/references.bib  — BibTeX 数据库（编译时挂进虚拟文件系统）
 */
export async function loadManuscriptLatex(projectId: string): Promise<string> {
  const result = await readMdFile(`projects/${projectId}/manuscript.tex`)
  return result?.content || ''
}

export async function saveManuscriptLatex(
  projectId: string,
  content: string,
): Promise<void> {
  await writeMdFile(
    `projects/${projectId}/manuscript.tex`,
    content,
    'Update manuscript LaTeX',
  )
}

/**
 * 块映射（sidecar）
 * -------------------------------------------------
 * `projects/{project-id}/latex-map.json` —— 记录「markdown 块 → LaTeX 片段」的对应关系。
 * 单独存文件是为了让 manuscript.tex 保持干净（里面不出现任何我们的内部注释），
 * 用户手改 tex 也不影响。
 */
export async function loadLatexMap(projectId: string): Promise<string> {
  const result = await readMdFile(`projects/${projectId}/latex-map.json`)
  return result?.content || ''
}

export async function saveLatexMap(projectId: string, content: string): Promise<void> {
  await writeMdFile(
    `projects/${projectId}/latex-map.json`,
    content,
    'Update LaTeX block map',
  )
}

export async function loadBibtex(projectId: string): Promise<string> {
  const result = await readMdFile(`projects/${projectId}/references.bib`)
  return result?.content || ''
}

export async function saveBibtex(projectId: string, content: string): Promise<void> {
  await writeMdFile(
    `projects/${projectId}/references.bib`,
    content,
    'Update references BibTeX',
  )
}

export async function loadReferences(projectId: string): Promise<CitationRef[]> {
  const [papers, books] = await Promise.all([
    readCsvFile(
      `projects/${projectId}/references/papers.csv`,
      (rows) => {
        if (rows.length <= 1) return [] as CitationRef[]
        return rows.slice(1).map((r) => ({
          id: r[0] || '',
          doi: r[1] || '',
          title: r[2] || '',
          authors: r[3] || '',
          year: parseInt(r[4] || '0', 10),
          journal: r[5] || '',
          type: 'paper' as const,
        }))
      },
    ),
    readCsvFile(
      `projects/${projectId}/references/books.csv`,
      (rows) => {
        if (rows.length <= 1) return [] as CitationRef[]
        return rows.slice(1).map((r) => ({
          id: r[0] || '',
          doi: r[1] || '',
          title: r[2] || '',
          authors: r[3] || '',
          year: parseInt(r[4] || '0', 10),
          journal: r[5] || '',
          type: 'book' as const,
        }))
      },
    ),
  ])
  return [...papers, ...books]
}

export async function savePaperReferences(projectId: string, refs: CitationRef[]): Promise<void> {
  const papers = refs.filter((r) => r.type === 'paper')
  await writeCsvFile(
    `projects/${projectId}/references/papers.csv`,
    papers,
    CITATION_HEADERS,
    (r) => [r.id, r.doi, r.title, r.authors, String(r.year), r.journal, r.type],
  )
}

export async function saveBookReferences(projectId: string, refs: CitationRef[]): Promise<void> {
  const books = refs.filter((r) => r.type === 'book')
  await writeCsvFile(
    `projects/${projectId}/references/books.csv`,
    books,
    CITATION_HEADERS,
    (r) => [r.id, r.doi, r.title, r.authors, String(r.year), r.journal, r.type],
  )
}

// ═════════════════════════════════════════════════════════════════════════
// 任务 CRUD：改名 / 删除（ADJ-64）
// 「材料」= 任务引用的库文献 / 图书（可被多个任务共享）。删除任务时：
//   detach = 只删任务，材料留在库里；purge = 额外删掉「只被该任务引用」的独占材料。
// 两种模式下，任务的直接子任务都**提升为顶级**（parentId 置空），不连带删除。
// ═════════════════════════════════════════════════════════════════════════

export type ProjectDeleteMode = 'purge' | 'detach'

export interface ExclusiveMaterial {
  kind: 'literature' | 'textbook'
  /** 库条目主键：文献 = doi，图书 = textbook_id */
  key: string
  title: string
}

export interface ProjectDeletePlan {
  project: Project
  /** 会被提升为顶级的直接子任务 */
  promotedChildren: Project[]
  /** 只被该任务引用、会随「连材料一起删」一并删除的库材料 */
  exclusiveMaterials: ExclusiveMaterial[]
}

/** 只改任务名（其余字段一律不动），返回更新后的完整项目表 */
export async function renameProject(projectId: string, title: string): Promise<Project[]> {
  const projects = await loadProjects(true)
  const next = projects.map((p) =>
    p.projectId === projectId ? { ...p, title, updatedAt: Date.now() } : p,
  )
  await saveProjects(next)
  return next
}

/** 收集「除 selfId 外其他任务」引用到的库条目主键（文献按 doi、图书按 id/title，小写归一并集） */
async function collectOtherReferencedKeys(
  selfId: string,
): Promise<{ papers: Set<string>; books: Set<string> }> {
  const papers = new Set<string>()
  const books = new Set<string>()
  const projects = (await loadProjects(true)).filter((p) => p.projectId !== selfId)
  await Promise.all(
    projects.map(async (p) => {
      try {
        for (const r of await loadReferences(p.projectId)) {
          if (r.type === 'book') {
            const key = (r.id || r.title).trim().toLowerCase()
            if (key) books.add(key)
          } else {
            const key = (r.doi || r.id).trim().toLowerCase()
            if (key) papers.add(key)
          }
        }
      } catch (err) {
        // 单个任务引用读失败不影响判断（宁可漏删，不可误删）
        console.warn('[project] 读取其他任务引用失败:', p.projectId, err)
      }
    }),
  )
  return { papers, books }
}

/** 计算删除计划（不落库）：供确认弹窗预览「会连带删掉哪些独占材料」 */
export async function planDeleteProject(projectId: string): Promise<ProjectDeletePlan | null> {
  const projects = await loadProjects(true)
  const project = projects.find((p) => p.projectId === projectId)
  if (!project) return null
  const promotedChildren = projects.filter((p) => p.parentId === projectId)
  const [refs, others] = await Promise.all([
    loadReferences(projectId).catch(() => [] as CitationRef[]),
    collectOtherReferencedKeys(projectId),
  ])
  const exclusiveMaterials: ExclusiveMaterial[] = []
  for (const r of refs) {
    if (r.type === 'book') {
      const key = (r.id || r.title).trim()
      if (!key || others.books.has(key.toLowerCase())) continue
      exclusiveMaterials.push({ kind: 'textbook', key, title: r.title || key })
    } else {
      const key = (r.doi || r.id).trim()
      if (!key || others.papers.has(key.toLowerCase())) continue
      exclusiveMaterials.push({ kind: 'literature', key, title: r.title || key })
    }
  }
  return { project, promotedChildren, exclusiveMaterials }
}

/** 从全仓路径里挑出某个目录（及其子目录）下的所有文件 */
function filesUnder(prefix: string, allPaths: string[]): string[] {
  return allPaths.filter((p) => p === prefix || p.startsWith(`${prefix}/`))
}

/**
 * 删除任务。
 * @param mode 'detach' 只删任务、材料保留；'purge' 额外删掉独占材料（库目录 + 索引 + 分类归属）
 * @returns 更新后的完整项目表
 */
export async function deleteProject(
  projectId: string,
  mode: ProjectDeleteMode,
): Promise<Project[]> {
  const projects = await loadProjects(true)
  const project = projects.find((p) => p.projectId === projectId)
  if (!project) return projects

  const ctx = getRepoContext()
  if (!ctx) throw new Error('工作区尚未就绪，无法删除任务')

  // 一次性取全仓路径，供整目录删除复用（路径是静态的，删除过程中不会变）
  const allPaths = await listRepoPaths(ctx.owner, ctx.repo, ctx.token)

  // purge：先算出独占材料，连同任务目录一起收集成待删文件
  let exclusive: ExclusiveMaterial[] = []
  if (mode === 'purge') {
    const plan = await planDeleteProject(projectId)
    exclusive = plan?.exclusiveMaterials ?? []
  }

  const toDelete: string[] = [...filesUnder(`projects/${projectId}`, allPaths)]
  for (const m of exclusive) {
    const dir = m.kind === 'literature' ? `literatures/${doiToSlug(m.key)}` : `textbooks/${m.key}`
    toDelete.push(...filesUnder(dir, allPaths))
  }
  if (toDelete.length > 0) {
    await deleteRepoFiles(
      [...new Set(toDelete)],
      `chore: delete task ${projectId}${mode === 'purge' ? ' (with exclusive materials)' : ''}`,
      ctx.owner,
      ctx.repo,
      ctx.token,
    )
  }

  // purge：清理独占材料的库索引与分类归属
  if (exclusive.length > 0) {
    const litDrop = new Set(
      exclusive.filter((m) => m.kind === 'literature').map((m) => m.key.toLowerCase()),
    )
    const bookDrop = new Set(exclusive.filter((m) => m.kind === 'textbook').map((m) => m.key))
    if (litDrop.size > 0) {
      const lits = await loadLiteratures(true)
      await saveLiteratures(lits.filter((l) => !litDrop.has((l.doi || '').toLowerCase())))
      const cats = await loadCategories(true)
      await saveCategories(
        cats.map((c) => ({ ...c, dois: c.dois.filter((d) => !litDrop.has(d.toLowerCase())) })),
      )
    }
    if (bookDrop.size > 0) {
      const books = await loadTextbooks(true)
      await saveTextbooks(books.filter((t) => !bookDrop.has(t.textbookId)))
    }
  }

  // 更新项目表：删该任务；直接子任务提升为顶级
  const next = projects
    .filter((p) => p.projectId !== projectId)
    .map((p) => (p.parentId === projectId ? { ...p, parentId: null, updatedAt: Date.now() } : p))
  await saveProjects(next)
  return next
}

/**
 * 某个任务及其全部后代（含自身）的 id 集合。
 * 编辑任务的「归属任务」时用它把自己和后代排除掉，避免把任务挂到自己的子孙下形成环。
 */
export function descendantIds(projects: Project[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>()
  for (const p of projects) {
    if (!p.parentId) continue
    const arr = childrenByParent.get(p.parentId)
    if (arr) arr.push(p.projectId)
    else childrenByParent.set(p.parentId, [p.projectId])
  }
  const out = new Set<string>([rootId])
  const stack = [rootId]
  while (stack.length > 0) {
    const id = stack.pop() as string
    for (const c of childrenByParent.get(id) ?? []) {
      if (!out.has(c)) {
        out.add(c)
        stack.push(c)
      }
    }
  }
  return out
}

// ═════════════════════════════════════════════════════════════════════════
// 任务附件（projects/{id}/attachments/）
// 任务详情里可挂文件（如期刊「格式要求」PDF）。二进制，走 GitHub 私库同目录。
// ═════════════════════════════════════════════════════════════════════════

export interface TaskAttachment {
  name: string
  path: string
  size: number
}

export function attachmentDirOf(projectId: string): string {
  return `projects/${projectId}/attachments`
}

/** 清理文件名：去掉路径分隔符与危险字符，保留可读的中文与扩展名 */
function safeAttachmentName(name: string): string {
  const cleaned = name
    .replace(/[\\/]+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5.\- ()\[\]]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.slice(0, 80) || 'attachment'
}

export async function loadTaskAttachments(projectId: string): Promise<TaskAttachment[]> {
  const ctx = getRepoContext()
  if (!ctx) return []
  const files = await listRepoFilesInDir(ctx.owner, ctx.repo, attachmentDirOf(projectId), ctx.token)
  return files
    .map((f) => ({ name: f.name, path: f.path, size: f.size }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 上传一个附件，返回写入仓库的路径 */
export async function uploadTaskAttachment(projectId: string, file: File): Promise<string> {
  const ctx = getRepoContext()
  if (!ctx) throw new Error('工作区尚未就绪，无法上传附件')
  const name = safeAttachmentName(file.name)
  const path = `${attachmentDirOf(projectId)}/${name}`
  await uploadRepoBinaryFile(ctx.owner, ctx.repo, path, file, ctx.token, `Add attachment ${name}`)
  return path
}

export async function deleteTaskAttachment(path: string, name: string): Promise<void> {
  const ctx = getRepoContext()
  if (!ctx) throw new Error('工作区尚未就绪，无法删除附件')
  await deleteRepoFiles([path], `Remove attachment ${name}`, ctx.owner, ctx.repo, ctx.token)
}

/** 下载附件（拉回 blob 后触发浏览器另存为） */
export async function downloadTaskAttachment(path: string, name: string): Promise<void> {
  const ctx = getRepoContext()
  if (!ctx) throw new Error('工作区尚未就绪，无法下载附件')
  const res = await downloadRepoBinaryFile(ctx.owner, ctx.repo, path, ctx.token)
  if (!res) throw new Error('附件不存在')
  const url = URL.createObjectURL(res.blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
