/**
 * 教材/图书数据服务
 * -------------------------------------------------
 * SPEC §4.6 / §3：教材数据存储在 GitHub 私库 textbooks/textbooks.csv
 */

import { readCsvFile, writeCsvFile } from './userData'

export interface Textbook {
  textbookId: string
  title: string
  author: string
  edition: string
  pages: number
  addedAt: number
  scope: string
  chapters: string
  includedChapters: string
}

const TEXTBOOKS_PATH = 'textbooks/textbooks.csv'
const TEXTBOOK_HEADERS = [
  'textbook_id', 'title', 'author', 'edition', 'pages',
  'added_at', 'scope', 'chapters', 'included_chapters',
]

export async function loadTextbooks(force = false): Promise<Textbook[]> {
  return readCsvFile(
    TEXTBOOKS_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      return rows.slice(1).map((r) => ({
        textbookId: r[0] || '',
        title: r[1] || '',
        author: r[2] || '',
        edition: r[3] || '',
        pages: parseInt(r[4] || '0', 10),
        addedAt: parseInt(r[5] || '0', 10),
        scope: r[6] || '',
        chapters: r[7] || '',
        includedChapters: r[8] || '',
      }))
    },
    force,
  )
}

export async function saveTextbooks(textbooks: Textbook[]): Promise<void> {
  await writeCsvFile(
    TEXTBOOKS_PATH,
    textbooks,
    TEXTBOOK_HEADERS,
    (t) => [
      t.textbookId,
      t.title,
      t.author,
      t.edition,
      String(t.pages),
      String(t.addedAt),
      t.scope,
      t.chapters,
      t.includedChapters,
    ],
  )
}
