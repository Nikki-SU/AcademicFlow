/**
 * 分类服务（图书 / 其他文档）
 * -------------------------------------------------
 * 文献分类早就有了（literatureCategoryData.ts → literatures/categories.csv），
 * 但图书分类一直只存在管理页的内存里，刷新就没了；其他文档是新加的，也需要分类。
 * 这里用同一个存储形状给两者落地：
 *
 *   textbooks/categories.csv  category_id, name, textbook_ids
 *   documents/categories.csv  category_id, name, document_ids
 *
 * 成员列用「;」分隔（CSV 里逗号是列分隔符），所以一个对象可以同时属于多个分类。
 * 与文献侧保持同一套形状，将来要合并成一个文件也不会打架。
 */

import { readCsvFile, writeCsvFile } from './userData'

export interface Category {
  id: string
  name: string
  /** 该分类下的成员主键：图书 = 书名；其他文档 = documents/ 下的目录名 */
  members: string[]
}

function createCategoryStore(path: string, memberField: string) {
  const headers = ['category_id', 'name', memberField]
  return {
    async load(force = false): Promise<Category[]> {
      return readCsvFile(
        path,
        (rows) => {
          if (rows.length <= 1) return []
          return rows
            .slice(1)
            .map((r) => ({
              id: (r[0] || '').trim(),
              name: (r[1] || '').trim(),
              members: (r[2] || '')
                .split(';')
                .map((m) => m.trim())
                .filter(Boolean),
            }))
            .filter((c) => c.id && c.name)
        },
        force,
      )
    },
    async save(categories: Category[]): Promise<void> {
      await writeCsvFile(path, categories, headers, (c) => [c.id, c.name, c.members.join(';')])
    },
  }
}

const bookStore = createCategoryStore('textbooks/categories.csv', 'textbook_ids')
const documentStore = createCategoryStore('documents/categories.csv', 'document_ids')

export const loadBookCategories = bookStore.load
export const saveBookCategories = bookStore.save
export const loadDocumentCategories = documentStore.load
export const saveDocumentCategories = documentStore.save

/** 某个对象当前属于哪些分类 */
export function categoriesOfMember(categories: Category[], memberId: string): string[] {
  return categories.filter((c) => c.members.includes(memberId)).map((c) => c.id)
}

/** 把某个对象的分类整体改为 categoryIds（分类列表本身不动） */
export function setMemberCategories(
  categories: Category[],
  memberId: string,
  categoryIds: string[],
): Category[] {
  return categories.map((c) => {
    const has = c.members.includes(memberId)
    const want = categoryIds.includes(c.id)
    if (want && !has) return { ...c, members: [...c.members, memberId] }
    if (!want && has) return { ...c, members: c.members.filter((m) => m !== memberId) }
    return c
  })
}
