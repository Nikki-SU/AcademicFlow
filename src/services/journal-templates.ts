/**
 * 期刊模板管理服务
 * -------------------------------------------------
 * 数据存储在用户的 GitHub 私库（academicflow-workspace/data/journal-templates.json）
 * 多设备/多用户自动同步：每个用户的数据独立存储在自己的私库中
 * 本地 IndexedDB 作为缓存（离线可用，同步后自动更新）
 */
import { db } from './db'
import { readRepoJsonFile, writeRepoJsonFile } from './github'
import { DEFAULT_WORKSPACE_REPO_NAME } from '../constants/skeleton'
import { useAuthStore } from '../stores/auth'
import type { JournalTemplate, GuidelineVersion } from '../types'

const TEMPLATES_FILE_PATH = 'data/journal-templates.json'

/** 获取当前用户的 owner/repo/token */
function getUserContext(): { owner: string; repo: string; token: string } | null {
  const { user, token } = useAuthStore.getState()
  if (!user || !token) return null
  return {
    owner: user.login,
    repo: DEFAULT_WORKSPACE_REPO_NAME,
    token,
  }
}

/**
 * 从 GitHub 私库读取所有模板
 * 失败时回退到本地 IndexedDB
 */
export async function getAllTemplates(): Promise<JournalTemplate[]> {
  const ctx = getUserContext()
  if (ctx) {
    try {
      const templates = await readRepoJsonFile<JournalTemplate[]>(
        ctx.owner,
        ctx.repo,
        TEMPLATES_FILE_PATH,
        ctx.token,
      )
      if (templates) {
        // 同步到本地缓存
        await db.journal_templates.clear()
        await db.journal_templates.bulkPut(templates)
        return templates.sort((a, b) => b.updated_at - a.updated_at)
      }
    } catch (err) {
      console.warn('[journal-templates] 从 GitHub 读取失败，回退到本地缓存:', err)
    }
  }
  // 回退到本地 IndexedDB
  return db.journal_templates.orderBy('updated_at').reverse().toArray()
}

/**
 * 根据 id 获取单个模板
 */
export async function getTemplateById(id: string): Promise<JournalTemplate | undefined> {
  const list = await getAllTemplates()
  return list.find((t) => t.id === id)
}

/**
 * 向 GitHub 私库写入模板列表
 */
async function saveTemplates(templates: JournalTemplate[]): Promise<void> {
  // 始终更新本地缓存
  await db.journal_templates.clear()
  await db.journal_templates.bulkPut(templates)

  // 如果已登录，同步到 GitHub 私库
  const ctx = getUserContext()
  if (ctx) {
    await writeRepoJsonFile(
      ctx.owner,
      ctx.repo,
      TEMPLATES_FILE_PATH,
      templates,
      ctx.token,
      'Update journal templates',
    )
  }
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

  const templates = await getAllTemplates()
  templates.push(template)
  await saveTemplates(templates)
  return template
}

/**
 * 更新模板
 */
export async function updateTemplate(
  id: string,
  updates: Partial<JournalTemplate>,
): Promise<JournalTemplate | undefined> {
  const templates = await getAllTemplates()
  const idx = templates.findIndex((t) => t.id === id)
  if (idx === -1) return undefined

  const now = Date.now()
  templates[idx] = {
    ...templates[idx],
    ...updates,
    id: templates[idx].id,
    created_at: templates[idx].created_at,
    updated_at: now,
  }

  await saveTemplates(templates)
  return templates[idx]
}

/**
 * 删除模板
 */
export async function deleteTemplate(id: string): Promise<void> {
  const templates = await getAllTemplates()
  const filtered = templates.filter((t) => t.id !== id)
  await saveTemplates(filtered)
}

/**
 * 生成内容哈希（用于检测投稿须知变化）
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
  const templates = await getAllTemplates()
  const idx = templates.findIndex((t) => t.id === templateId)
  if (idx === -1) return undefined

  const template = templates[idx]
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

  templates[idx] = {
    ...template,
    guidelines_content: content,
    guidelines_content_hash: newHash,
    guidelines_last_checked_at: now,
    guidelines_last_updated_at: hasChanged ? now : template.guidelines_last_updated_at,
    guidelines_history: history,
    updated_at: now,
  }

  await saveTemplates(templates)
  return templates[idx]
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
  const templates = await getAllTemplates()
  const source = templates.find((t) => t.id === sourceId)
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

  templates.push(copy)
  await saveTemplates(templates)
  return copy
}
