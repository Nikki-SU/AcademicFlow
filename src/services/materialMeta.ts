/**
 * 材料元数据（任务归属 + 标签）
 * -------------------------------------------------
 * 背景：旧模型把「分类」当成归档维度，文献 / 图书 / 其他文档各存一份 categories.csv。
 * 但这套分类语义和「任务」高度重叠：一份材料本来就该归属于某个任务，额外的分类
 * 更接近「给这份材料打标签」。于是统一为单一真源：
 *
 *   materials/meta.csv   material_type, material_id, task_id, tags
 *
 * - task_id：归属任务（projects.csv 的 project_id）；空串 = 未归属。
 * - tags：自由标签，用「;」分隔（CSV 里逗号是列分隔符）。
 *   标签要「可被使用、可被检索」：所有标签汇总后参与检索与筛选。
 *
 * 三种材料的主键（material_id）：
 *   paper    文献 DOI（统一小写，与 doi 比对一致）
 *   book     图书 textbook_id
 *   document 其他文档 document_id
 */

import { readCsvFile, writeCsvFile } from './userData'

export type MaterialType = 'paper' | 'book' | 'document'

export interface MaterialMeta {
  type: MaterialType
  id: string
  /** 归属任务 project_id；空串表示未归属任何任务 */
  taskId: string
  tags: string[]
}

export const MATERIAL_META_PATH = 'materials/meta.csv'
export const MATERIAL_META_HEADERS = ['material_type', 'material_id', 'task_id', 'tags']

/** 文献 DOI 统一小写，保证不同来源写法能对上；图书 / 文档主键原样保留 */
export function normalizeMaterialId(type: MaterialType, id: string): string {
  const t = (id || '').trim()
  return type === 'paper' ? t.toLowerCase() : t
}

export function metaKey(type: MaterialType, id: string): string {
  return `${type}:${normalizeMaterialId(type, id)}`
}

export async function loadMaterialMeta(force = false): Promise<MaterialMeta[]> {
  return readCsvFile(
    MATERIAL_META_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      return rows
        .slice(1)
        .map((r) => ({
          type: ((r[0] || '').trim() as MaterialType),
          id: normalizeMaterialId((r[0] || '').trim() as MaterialType, r[1] || ''),
          taskId: (r[2] || '').trim(),
          tags: (r[3] || '')
            .split(';')
            .map((t) => t.trim())
            .filter(Boolean),
        }))
        .filter((m) => m.type && m.id)
    },
    force,
  )
}

export async function saveMaterialMeta(list: MaterialMeta[]): Promise<void> {
  await writeCsvFile(MATERIAL_META_PATH, list, MATERIAL_META_HEADERS, (m) => [
    m.type,
    m.id,
    m.taskId,
    m.tags.join(';'),
  ])
}

function findMeta(list: MaterialMeta[], type: MaterialType, id: string): MaterialMeta | undefined {
  const key = metaKey(type, id)
  return list.find((m) => metaKey(m.type, m.id) === key)
}

export function taskOf(list: MaterialMeta[], type: MaterialType, id: string): string {
  return findMeta(list, type, id)?.taskId || ''
}

export function tagsOf(list: MaterialMeta[], type: MaterialType, id: string): string[] {
  return findMeta(list, type, id)?.tags ?? []
}

/**
 * 更新某份材料的任务 / 标签。二者都可选，只改传进来的那部分。
 * 传入空任务 + 空标签会导致该条无意义 → 直接移除。
 */
export function setMeta(
  list: MaterialMeta[],
  type: MaterialType,
  id: string,
  patch: { taskId?: string; tags?: string[] },
): MaterialMeta[] {
  const key = metaKey(type, id)
  const cur = list.find((m) => metaKey(m.type, m.id) === key)
  const next: MaterialMeta = {
    type,
    id: normalizeMaterialId(type, id),
    taskId: patch.taskId !== undefined ? patch.taskId.trim() : (cur?.taskId ?? ''),
    tags: patch.tags !== undefined ? dedupeTags(patch.tags) : (cur?.tags ?? []),
  }
  const rest = list.filter((m) => metaKey(m.type, m.id) !== key)
  if (!next.taskId && next.tags.length === 0) return rest
  return [...rest, next]
}

/** 删除某份材料的元数据（材料本身被删除时调用） */
export function dropMeta(list: MaterialMeta[], type: MaterialType, id: string): MaterialMeta[] {
  const key = metaKey(type, id)
  return list.filter((m) => metaKey(m.type, m.id) !== key)
}

export function dedupeTags(tags: string[]): string[] {
  const out: string[] = []
  for (const t of tags) {
    const v = t.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/** 该类型下出现过的全部标签（去重，供检索 / 提示用） */
export function collectTags(list: MaterialMeta[], type?: MaterialType): string[] {
  const out: string[] = []
  for (const m of list) {
    if (type && m.type !== type) continue
    for (const t of m.tags) if (!out.includes(t)) out.push(t)
  }
  return out
}

/** 某任务下的材料主键集合 */
export function idsByTask(list: MaterialMeta[], type: MaterialType, taskId: string): Set<string> {
  return new Set(
    list.filter((m) => m.type === type && m.taskId === taskId).map((m) => m.id),
  )
}
