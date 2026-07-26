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

export async function saveManuscript(projectId: string, content: string): Promise<void> {
  await writeMdFile(
    `projects/${projectId}/manuscript.md`,
    content,
    'Update manuscript',
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
