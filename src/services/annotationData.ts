/**
 * 批注服务
 * -------------------------------------------------
 * SPEC §5.4：每条批注一条记录，支持高亮文字、笔记、颜色标签。
 *
 * 存储路径按阅读对象类型分流（见 readingDocData.ts）：
 *   文献 → literatures/{doi-slug}/annotations/annotations.csv
 *   图书 → textbooks/{书名}/annotations/annotations.csv
 */

import { readCsvFile, writeCsvFile } from './userData'
import { docBasePath, type DocRef } from './readingDocData'

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

export function annotationPath(ref: DocRef): string {
  return `${docBasePath(ref)}/annotations/annotations.csv`
}

export async function loadAnnotations(ref: DocRef): Promise<Annotation[]> {
  return readCsvFile(
    annotationPath(ref),
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

export async function saveAnnotations(ref: DocRef, annotations: Annotation[]): Promise<void> {
  await writeCsvFile(
    annotationPath(ref),
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
