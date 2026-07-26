/**
 * 批注服务
 * -------------------------------------------------
 * SPEC §5.4：每篇文献的批注存储在
 *   literatures/{doi-slug}/annotations/annotations.csv
 *
 * 每条批注一条记录，支持高亮文字、笔记、颜色标签。
 */

import { readCsvFile, writeCsvFile } from './userData'
import { doiToSlug } from './literatureData'

export interface Annotation {
  id: string
  type: 'highlight' | 'note'
  color: 'yellow' | 'green' | 'blue' | 'pink' | 'purple'
  text: string
  note: string
  createdAt: number
  updatedAt: number
}

const ANNOTATION_HEADERS = [
  'id', 'type', 'color', 'text', 'note', 'created_at', 'updated_at',
]

export function annotationPath(doi: string): string {
  const slug = doiToSlug(doi)
  return `literatures/${slug}/annotations/annotations.csv`
}

export async function loadAnnotations(doi: string): Promise<Annotation[]> {
  return readCsvFile(
    annotationPath(doi),
    (rows) => {
      if (rows.length <= 1) return []
      return rows.slice(1).map((r) => ({
        id: r[0] || '',
        type: (r[1] as Annotation['type']) || 'highlight',
        color: (r[2] as Annotation['color']) || 'yellow',
        text: r[3] || '',
        note: r[4] || '',
        createdAt: parseInt(r[5] || '0', 10),
        updatedAt: parseInt(r[6] || '0', 10),
      }))
    },
  )
}

export async function saveAnnotations(doi: string, annotations: Annotation[]): Promise<void> {
  await writeCsvFile(
    annotationPath(doi),
    annotations,
    ANNOTATION_HEADERS,
    (a) => [
      a.id,
      a.type,
      a.color,
      a.text,
      a.note,
      String(a.createdAt),
      String(a.updatedAt),
    ],
  )
}
