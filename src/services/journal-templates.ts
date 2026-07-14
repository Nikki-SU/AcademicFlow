/**
 * 期刊模板管理服务
 * -------------------------------------------------
 * 设计原则：
 * - 不内置任何硬编码期刊模板（避免不准确，用户不敢用）
 * - 用户粘贴投稿须知（网页 / Word / PDF 转的文字）→ AI 提取格式规范 → 生成模板
 * - 投稿须知版本管理（每次更新留历史记录）
 * - 支持从 URL 检测变化（注意 CORS/反爬可能失败）
 */
import { db } from './db'
import type { JournalTemplate, GuidelineVersion } from '../types'

/**
 * 获取所有期刊模板
 */
export async function getAllTemplates(): Promise<JournalTemplate[]> {
  const templates = await db.journal_templates.orderBy('updated_at').reverse().toArray()
  return templates
}

/**
 * 根据 id 获取单个模板
 */
export async function getTemplateById(id: string): Promise<JournalTemplate | undefined> {
  return db.journal_templates.get(id)
}

/**
 * 新建模板
 */
export async function createTemplate(data: {
  name: string
  short_name?: string
  publisher?: string
  journal_url?: string
  guidelines_url?: string
  guidelines_content?: string
}): Promise<JournalTemplate> {
  const now = Date.now()
  const id = data.name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    + '-' + now.toString(36).slice(-4)

  const template: JournalTemplate = {
    id,
    name: data.name,
    short_name: data.short_name,
    publisher: data.publisher,
    journal_url: data.journal_url,
    guidelines_url: data.guidelines_url,
    guidelines_content: data.guidelines_content,
    guidelines_content_hash: data.guidelines_content ? hashContent(data.guidelines_content) : undefined,
    guidelines_last_updated_at: data.guidelines_content ? now : undefined,
    document_class: 'article',
    document_options: '',
    packages: [],
    bibtex_style: 'unsrt',
    two_column: false,
    font_size: 12,
    created_at: now,
    updated_at: now,
  }

  await db.journal_templates.put(template)
  return template
}

/**
 * 更新模板
 */
export async function updateTemplate(
  id: string,
  updates: Partial<JournalTemplate>,
): Promise<JournalTemplate | undefined> {
  const existing = await db.journal_templates.get(id)
  if (!existing) return undefined

  const now = Date.now()
  const updated: JournalTemplate = {
    ...existing,
    ...updates,
    id: existing.id, // id 不可变
    created_at: existing.created_at,
    updated_at: now,
  }

  await db.journal_templates.put(updated)
  return updated
}

/**
 * 删除模板
 */
export async function deleteTemplate(id: string): Promise<void> {
  await db.journal_templates.delete(id)
}

/**
 * 生成内容哈希（用于检测投稿须知变化）
 * 使用简单的字符串哈希，不需要加密安全性
 */
export function hashContent(content: string): string {
  let hash = 0
  if (content.length === 0) return String(hash)
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return String(hash)
}

/**
 * 更新投稿须知，自动创建版本记录
 */
export async function updateGuidelines(
  templateId: string,
  content: string,
  changeNote?: string,
): Promise<JournalTemplate | undefined> {
  const template = await db.journal_templates.get(templateId)
  if (!template) return undefined

  const now = Date.now()
  const newHash = hashContent(content)
  const hasChanged = template.guidelines_content_hash !== newHash

  const history = template.guidelines_history ? [...template.guidelines_history] : []

  if (hasChanged && template.guidelines_content) {
    const version: GuidelineVersion = {
      version: history.length + 1,
      updated_at: template.guidelines_last_updated_at ?? template.updated_at,
      summary: template.guidelines_content.slice(0, 200),
      full_content: template.guidelines_content,
      change_note: changeNote,
    }
    history.push(version)
  }

  const updated: JournalTemplate = {
    ...template,
    guidelines_content: content,
    guidelines_content_hash: newHash,
    guidelines_last_checked_at: now,
    guidelines_last_updated_at: hasChanged ? now : template.guidelines_last_updated_at,
    guidelines_history: history,
    updated_at: now,
  }

  await db.journal_templates.put(updated)
  return updated
}

/**
 * 检测投稿须知网页是否变化（简单 fetch + 哈希对比）
 * 注意：受 CORS 和反爬限制，可能失败，此时返回 null 表示无法检测
 */
export async function checkGuidelinesChanged(url: string, currentHash: string): Promise<{
  changed: boolean | null
  content?: string
  error?: string
}> {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'AcademicFlow/1.0',
        Accept: 'text/html,text/plain',
      },
    })

    if (!resp.ok) {
      return { changed: null, error: `HTTP ${resp.status}` }
    }

    const text = await resp.text()
    const newHash = hashContent(text)

    return {
      changed: newHash !== currentHash,
      content: text,
    }
  } catch (err) {
    return {
      changed: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * 从模板创建一个副本
 */
export async function duplicateTemplate(sourceId: string, newName: string): Promise<JournalTemplate | undefined> {
  const source = await db.journal_templates.get(sourceId)
  if (!source) return undefined

  const now = Date.now()
  const newId = newName.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    + '-' + now.toString(36).slice(-4)

  const copy: JournalTemplate = {
    ...source,
    id: newId,
    name: newName,
    notes: (source.notes ? source.notes + '\n\n' : '') + `复制自 ${source.name} (${source.id})`,
    created_at: now,
    updated_at: now,
    guidelines_history: undefined,
    guidelines_last_checked_at: undefined,
    guidelines_last_updated_at: undefined,
    guidelines_content_hash: source.guidelines_content_hash,
  }

  await db.journal_templates.put(copy)
  return copy
}
