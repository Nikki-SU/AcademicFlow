/**
 * AcademicFlow 本地存储层（IndexedDB via Dexie）
 * -------------------------------------------------
 * 存储所有用户数据在浏览器 IndexedDB 中，不上传任何服务器。
 *
 * 表结构：
 * - settings: 键值对存储（PAT / 已登录用户缓存 / 用户偏好等）
 */
import Dexie, { type Table } from 'dexie'

/** settings 表行结构 */
export interface SettingRow {
  key: string
  value: string
}

/** IndexedDB 已知 key 白名单（避免拼写错误） */
export const SETTING_KEYS = {
  GITHUB_TOKEN: 'github_token',
  GITHUB_USER_CACHE: 'github_user_cache',
  GITHUB_SCOPES: 'github_scopes',
} as const

class AcademicFlowDB extends Dexie {
  settings!: Table<SettingRow, string>

  constructor() {
    super('academicflow')
    this.version(1).stores({
      // 主键 key，无索引其他字段
      settings: 'key',
    })
  }
}

export const db = new AcademicFlowDB()

/** 读单个 setting */
export async function getSetting(key: string): Promise<string | null> {
  const row = await db.settings.get(key)
  return row?.value ?? null
}

/** 写单个 setting（存在则更新） */
export async function putSetting(key: string, value: string): Promise<void> {
  await db.settings.put({ key, value })
}

/** 删除单个 setting */
export async function deleteSetting(key: string): Promise<void> {
  await db.settings.delete(key)
}

/** 批量删除多个 setting（如登出时清 token + user cache + scopes） */
export async function deleteSettings(keys: string[]): Promise<void> {
  await db.settings.bulkDelete(keys)
}
