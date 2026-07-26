/**
 * 文献管理服务
 * -------------------------------------------------
 * SPEC §3：所有文献数据存储在 GitHub 私库。
 * - literatures/literatures.csv — 文献元数据表
 * - literatures/{doi-slug}/fulltext.md — 正文 Markdown
 * - literatures/{doi-slug}/abstract_en.md — 英文摘要
 * - literatures/{doi-slug}/abstract_cn.md — 中文摘要
 * - literatures/{doi-slug}/annotations/ — 批注目录
 * - literatures/{doi-slug}/notes.md — 阅读笔记
 */

import { readCsvFile, writeCsvFile, readMdFile, writeMdFile } from './userData'

export interface Literature {
  doi: string
  title: string
  journal: string
  year: number
  authors: string
  keywords: string
  abstractEn: string
  abstractCn: string
  tier: number
  hasGraphicalAbstract: boolean
  addedAt: number
  pdfAddedAt: number
  source: string
  trackingGroup: string
}

const LITERATURES_PATH = 'literatures/literatures.csv'
const LITERATURE_HEADERS = [
  'doi', 'title', 'journal', 'year', 'authors', 'keywords',
  'abstract_en', 'abstract_cn', 'tier', 'has_graphical_abstract',
  'added_at', 'pdf_added_at', 'source', 'tracking_group',
]

export function doiToSlug(doi: string): string {
  return encodeURIComponent(doi).replace(/%2F/g, '_').replace(/\./g, '-')
}

export async function loadLiteratures(force = false): Promise<Literature[]> {
  return readCsvFile(
    LITERATURES_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      return rows.slice(1).map((r) => ({
        doi: r[0] || '',
        title: r[1] || '',
        journal: r[2] || '',
        year: parseInt(r[3] || '0', 10),
        authors: r[4] || '',
        keywords: r[5] || '',
        abstractEn: r[6] || '',
        abstractCn: r[7] || '',
        tier: parseInt(r[8] || '0', 10),
        hasGraphicalAbstract: r[9] === 'true',
        addedAt: parseInt(r[10] || '0', 10),
        pdfAddedAt: parseInt(r[11] || '0', 10),
        source: r[12] || '',
        trackingGroup: r[13] || '',
      }))
    },
    force,
  )
}

export async function saveLiteratures(literatures: Literature[]): Promise<void> {
  await writeCsvFile(
    LITERATURES_PATH,
    literatures,
    LITERATURE_HEADERS,
    (lit) => [
      lit.doi,
      lit.title,
      lit.journal,
      String(lit.year),
      lit.authors,
      lit.keywords,
      lit.abstractEn,
      lit.abstractCn,
      String(lit.tier),
      String(lit.hasGraphicalAbstract),
      String(lit.addedAt),
      String(lit.pdfAddedAt),
      lit.source,
      lit.trackingGroup,
    ],
  )
}

export async function loadFulltext(doi: string): Promise<string> {
  const slug = doiToSlug(doi)
  const result = await readMdFile(`literatures/${slug}/fulltext.md`)
  return result?.content || ''
}

export async function saveFulltext(doi: string, content: string): Promise<void> {
  const slug = doiToSlug(doi)
  await writeMdFile(`literatures/${slug}/fulltext.md`, content, 'Update fulltext')
}

export async function loadNotes(doi: string): Promise<string> {
  const slug = doiToSlug(doi)
  const result = await readMdFile(`literatures/${slug}/notes.md`)
  return result?.content || ''
}

export async function saveNotes(doi: string, content: string): Promise<void> {
  const slug = doiToSlug(doi)
  await writeMdFile(`literatures/${slug}/notes.md`, content, 'Update reading notes')
}
