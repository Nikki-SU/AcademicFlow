/**
 * 写作项目数据服务
 * -------------------------------------------------
 * SPEC §3：写作项目存储在 GitHub 私库 projects/ 目录。
 * - projects/projects.csv — 项目索引表
 * - projects/{project-id}/manuscript.md — 手稿正文
 * - projects/{project-id}/references/papers.csv — 文献引用
 * - projects/{project-id}/references/books.csv — 图书引用
 */

import { readCsvFile, writeCsvFile, readMdFile, writeMdFile } from './userData'

export interface Project {
  projectId: string
  title: string
  targetJournal: string
  textbookRefs: string
  status: 'draft' | 'submitted' | 'accepted' | 'rejected'
  createdAt: number
  updatedAt: number
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
const PROJECT_HEADERS = [
  'project_id', 'title', 'target_journal', 'textbook_refs',
  'status', 'created_at', 'updated_at',
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
    ],
  )
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

export async function loadQuickActions(): Promise<QuickAction[]> {
  const result = await readMdFile(QUICK_ACTIONS_PATH)
  const content = result?.content || ''
  const actions: QuickAction[] = []
  const sections = content.split(/^##\s+/m).slice(1)
  for (const section of sections) {
    const nl = section.indexOf('\n')
    const label = (nl === -1 ? section : section.slice(0, nl)).trim()
    const prompt = (nl === -1 ? '' : section.slice(nl + 1)).trim()
    if (label && prompt) actions.push({ label, prompt })
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
