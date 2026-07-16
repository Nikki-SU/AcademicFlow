/**
 * AcademicFlow 本地存储层（IndexedDB via Dexie）
 * -------------------------------------------------
 * 存储所有用户数据在浏览器 IndexedDB 中，不上传任何服务器。
 *
 * 表结构：
 * - settings: 键值对存储（PAT / 已登录用户缓存 / 用户偏好等）
 * - journal_templates: 期刊模板
 * - citation_cache: 引用元数据缓存（DOI 为 key）
 */
import Dexie, { type Table } from 'dexie'
import type { JournalTemplate, CitationEntry } from '../types'

/** settings 表行结构 */
export interface SettingRow {
  key: string
  value: string
}

/** journal_templates 表行结构 = JournalTemplate */
export type JournalTemplateRow = JournalTemplate

/** citation_cache 表行结构 = CitationEntry */
export type CitationCacheRow = CitationEntry

/** IndexedDB 已知 key 白名单（避免拼写错误） */
export const SETTING_KEYS = {
  // 认证（M1）
  GITHUB_TOKEN: 'github_token',
  GITHUB_USER_CACHE: 'github_user_cache',
  GITHUB_SCOPES: 'github_scopes',
  // 设置（M3，SPEC v0.3 §7.3）
  ADVANCED_MODE: 'advanced_mode',
  AI_PROVIDER_MODE: 'ai_provider_mode',
  SILICONFLOW_API_KEY: 'siliconflow_api_key',
  AI_1_MODEL: 'ai_1_model',
  AI_2_MODEL: 'ai_2_model',
  CUSTOM_AI_1_BASE_URL: 'custom_ai_1_base_url',
  CUSTOM_AI_1_API_KEY: 'custom_ai_1_api_key',
  CUSTOM_AI_1_MODEL: 'custom_ai_1_model',
  CUSTOM_AI_2_BASE_URL: 'custom_ai_2_base_url',
  CUSTOM_AI_2_API_KEY: 'custom_ai_2_api_key',
  CUSTOM_AI_2_MODEL: 'custom_ai_2_model',
  // AI 模型清单缓存（M3，TTL 24h）
  AI_MODELS_CACHE_SILICONFLOW: 'ai_models_cache_siliconflow',
  AI_MODELS_CACHE_AT: 'ai_models_cache_at',
  // MinerU 相关（M3.7）
  MINERU_TOKEN: 'mineru_token',
  MINERU_WORKER_URL: 'mineru_worker_url',
  EXTRACT_COVER_IMAGE: 'extract_cover_image',
  MINERU_DEBUG_MODE: 'mineru_debug_mode',
} as const

class AcademicFlowDB extends Dexie {
  settings!: Table<SettingRow, string>
  journal_templates!: Table<JournalTemplateRow, string>
  citation_cache!: Table<CitationCacheRow, string>

  constructor() {
    super('academicflow')
    this.version(1).stores({
      settings: 'key',
    })
    this.version(2).stores({
      settings: 'key',
      journal_templates: 'id, name, publisher, created_at, updated_at',
      citation_cache: 'doi, title, year, journal, fetched_at',
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
