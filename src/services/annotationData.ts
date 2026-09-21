/**
 * 批注服务
 * -------------------------------------------------
 * SPEC §5.4：每条批注一条记录，支持高亮文字、笔记、颜色标签。
 *
 * 存储路径按阅读对象类型分流（见 readingDocData.ts）：
 *   文献 → literatures/{doi-slug}/annotations/annotations.csv
 *   图书 → textbooks/{书名}/annotations/annotations.csv
 *
 * 锚点（anchor）是「语言-段号」，例如 en-12 / cn-12。
 * 中文和英文在 aligned 文件里是两个独立的块（只是段号相同），所以批注必须
 * 分开锚在具体某一种语言的某一段上 —— 两段之间不存在逐字对齐，也不需要对齐。
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
  /** 块锚点：语言-段号（en-12 / cn-12）。历史数据没有 → ''，退化成按文本匹配 */
  anchor: string
}

const ANNOTATION_HEADERS = [
  'id', 'type', 'color', 'text', 'note', 'created_at', 'updated_at', 'anchor',
]

export function annotationPath(ref: DocRef): string {
  return `${docBasePath(ref)}/annotations/annotations.csv`
}

/**
 * 读取批注。
 *
 * 两处防御都是针对已经发生过的数据事故：
 *
 * 1) **按表头名取列**，不按固定下标。以前加一列就会让所有历史行的列整体错位
 *    （anchor 这一列就是新加的），按名字取列以后增删列都不会串。
 *
 * 2) **丢弃结构不完整的行**。私库里那份 annotations.csv 已经烂了：
 *    text 只剩 "3" / "Cs " / " CO " 这种碎片、created_at 全是 0、id 是 "3"。
 *    成因是旧的 CSV 解析器把带换行的字段劈成了多行（已修 parseCsv）。
 *    这些脏行如果继续读进来，会变成一批"锚点极短"的批注，在任意文章的正文里
 *    都能匹配到，于是表现为"批注跨文章乱串、删了又冒出来"。所以这里直接过滤掉，
 *    并且**不再把它们写回去**（读进来的就少，写出去的自然干净）。
 */
export async function loadAnnotations(ref: DocRef): Promise<Annotation[]> {
  return readCsvFile(
    annotationPath(ref),
    (rows) => {
      if (rows.length <= 1) return []
      const header = rows[0].map((h) => h.trim())
      const idx = (name: string) => header.indexOf(name)
      const iId = idx('id')
      const iType = idx('type')
      const iColor = idx('color')
      const iText = idx('text')
      const iNote = idx('note')
      const iCreated = idx('created_at')
      const iUpdated = idx('updated_at')
      const iAnchor = idx('anchor')

      const out: Annotation[] = []
      for (const r of rows.slice(1)) {
        // 列数不足 = 被劈开/截断的行
        if (r.length < header.length) continue
        const id = (r[iId] ?? '').trim()
        const text = r[iText] ?? ''
        const note = r[iNote] ?? ''
        const createdAt = parseInt(r[iCreated] ?? '', 10)
        const updatedAt = parseInt(r[iUpdated] ?? '', 10)
        // 正常写入的行一定满足：id 有前缀、至少有一个内容、时间戳有值。
        // 不满足的一律按脏数据丢弃（历史损坏产物）。
        if (!id.startsWith('anno-')) continue
        if (!text.trim() && !note.trim()) continue
        // 只有"没有锚点的老数据"才按长度过滤：老数据靠全文文本匹配，一个字的
        // 碎片会命中任意文章。带锚点（en-12 / cn-12）的批注只在那一块里找，
        // 再短也不会串，所以不能因为短就丢掉（用户要求随处批注）。
        if (!(iAnchor >= 0 && (r[iAnchor] ?? '').trim()) && text.trim().length > 0 && text.trim().length < 2) continue
        if (!(createdAt > 0)) continue
        out.push({
          id,
          type: (r[iType] as Annotation['type']) || 'highlight',
          color: (r[iColor] as Annotation['color']) || 'yellow',
          text,
          note,
          createdAt,
          updatedAt: updatedAt > 0 ? updatedAt : createdAt,
          anchor: iAnchor >= 0 ? (r[iAnchor] ?? '').trim() : '',
        })
      }
      return out
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
      a.anchor || '',
    ],
  )
}
