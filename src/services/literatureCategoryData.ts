/**
 * 文献分类服务
 * -------------------------------------------------
 * 为什么单独一个文件：分类以前借用了「追踪页的关键词组」文件
 * （keyword_groups/keyword_groups.csv），结果两边互相覆盖 ——
 * 关键词组是给追踪用的检索表达式，文献分类是给人用的归档维度，语义不同。
 *
 * 存储：literatures/categories.csv —— category_id, name, dois
 *   dois 用「;」分隔（CSV 里逗号是列分隔符），所以一篇文献可以同时属于多个分类。
 */

import { readCsvFile, writeCsvFile } from './userData'

export interface LiteratureCategory {
  id: string
  name: string
  /** 该分类下的文献 DOI 列表 */
  dois: string[]
}

const CATEGORIES_PATH = 'literatures/categories.csv'
const CATEGORY_HEADERS = ['category_id', 'name', 'dois']

export async function loadCategories(force = false): Promise<LiteratureCategory[]> {
  return readCsvFile(
    CATEGORIES_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      return rows
        .slice(1)
        .map((r) => ({
          id: (r[0] || '').trim(),
          name: (r[1] || '').trim(),
          dois: (r[2] || '')
            .split(';')
            .map((d) => d.trim())
            .filter(Boolean),
        }))
        .filter((c) => c.id && c.name)
    },
    force,
  )
}

export async function saveCategories(categories: LiteratureCategory[]): Promise<void> {
  await writeCsvFile(
    CATEGORIES_PATH,
    categories,
    CATEGORY_HEADERS,
    (c) => [c.id, c.name, c.dois.join(';')],
  )
}
