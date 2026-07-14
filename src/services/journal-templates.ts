/**
 * 期刊模板管理服务
 * -------------------------------------------------
 * 功能：
 * - 内置 6 个常用期刊模板（Elsevier / Springer / IEEE / Nature / Science / ACM）
 * - 自定义模板 CRUD
 * - 投稿须知版本管理
 * - 投稿须知变化检测（基于内容哈希）
 */
import { db } from './db'
import type { JournalTemplate, GuidelineVersion } from '../types'

/** 内置期刊模板列表 */
const BUILTIN_TEMPLATES: JournalTemplate[] = [
  {
    id: 'elsevier',
    name: 'Elsevier (通用)',
    short_name: 'Elsevier',
    publisher: 'Elsevier',
    journal_url: 'https://www.elsevier.com',
    document_class: 'elsarticle',
    document_options: '3p,twocolumn,12pt',
    packages: ['elsarticle', 'graphicx', 'amsmath', 'amssymb', 'booktabs', 'hyperref'],
    bibtex_style: 'elsarticle-num',
    two_column: true,
    font_size: 12,
    title_format_note: '标题使用 \\title{}，作者用 \\author{} 配合 \\address{}',
    abstract_format_note: '摘要放在 \\begin{abstract}...\\end{abstract} 中，位于 \\maketitle 之前',
    reference_format_note: '数字编号引用，按出现顺序排序',
    notes: 'Elsevier 通用模板，使用 elsarticle 文档类。具体期刊可能有细微差异。',
    created_at: 0,
    updated_at: 0,
  },
  {
    id: 'springer',
    name: 'Springer Nature (通用)',
    short_name: 'Springer',
    publisher: 'Springer Nature',
    journal_url: 'https://www.springer.com',
    document_class: 'svjour3',
    document_options: 'twocolumn,12pt',
    packages: ['svjour3', 'graphicx', 'amsmath', 'amssymb', 'booktabs', 'hyperref'],
    bibtex_style: 'spbasic',
    two_column: true,
    font_size: 12,
    title_format_note: '\\title{} + \\author{} + \\institute{}',
    abstract_format_note: '\\begin{abstract}...\\end{abstract}',
    reference_format_note: 'Springer 基本格式',
    notes: 'Springer svjour3 通用模板',
    created_at: 0,
    updated_at: 0,
  },
  {
    id: 'ieee',
    name: 'IEEE Transactions',
    short_name: 'IEEE',
    publisher: 'IEEE',
    journal_url: 'https://www.ieee.org',
    document_class: 'IEEEtran',
    document_options: 'journal,twocolumn,10pt',
    packages: ['IEEEtran', 'graphicx', 'amsmath', 'amssymb', 'booktabs', 'hyperref'],
    bibtex_style: 'IEEEtran',
    two_column: true,
    font_size: 10,
    title_format_note: '使用 \\title{}，作者块用 \\IEEEauthorblockN 和 \\IEEEauthorblockA',
    abstract_format_note: '\\begin{abstract}...\\end{abstract}，\\begin{IEEEkeywords}...\\end{IEEEkeywords}',
    reference_format_note: 'IEEE 数字编号格式，按出现顺序',
    notes: 'IEEE 期刊模板，双栏 10pt。注意作者格式需使用 IEEEtran 专用命令。',
    created_at: 0,
    updated_at: 0,
  },
  {
    id: 'nature',
    name: 'Nature / Nature 子刊',
    short_name: 'Nature',
    publisher: 'Springer Nature',
    journal_url: 'https://www.nature.com',
    document_class: 'article',
    document_options: 'twocolumn,12pt',
    packages: ['nature', 'graphicx', 'amsmath', 'amssymb', 'booktabs', 'hyperref'],
    bibtex_style: 'nature',
    two_column: true,
    font_size: 12,
    title_format_note: '\\title{} + \\author{}',
    abstract_format_note: '\\begin{abstract}...\\end{abstract}',
    reference_format_note: 'Nature 引用格式，按出现顺序编号',
    notes: 'Nature 系列通用模板。注意：Nature 官方模板需从官网下载 nature.cls。',
    created_at: 0,
    updated_at: 0,
  },
  {
    id: 'science',
    name: 'Science / AAAS',
    short_name: 'Science',
    publisher: 'AAAS',
    journal_url: 'https://www.science.org',
    document_class: 'article',
    document_options: 'twocolumn,12pt',
    packages: ['graphicx', 'amsmath', 'amssymb', 'booktabs', 'hyperref'],
    bibtex_style: 'unsrt',
    two_column: true,
    font_size: 12,
    title_format_note: '标准 article 类格式',
    abstract_format_note: '\\begin{abstract}...\\end{abstract}',
    reference_format_note: '按出现顺序编号',
    notes: 'Science 通用参考模板。Science 投稿通常用 Word，但 LaTeX 模板可用于预印本。',
    created_at: 0,
    updated_at: 0,
  },
  {
    id: 'acm',
    name: 'ACM 期刊 / 会议',
    short_name: 'ACM',
    publisher: 'ACM',
    journal_url: 'https://www.acm.org',
    document_class: 'acmart',
    document_options: 'twocolumn,10pt,sigconf',
    packages: ['acmart', 'graphicx', 'amsmath', 'amssymb', 'booktabs', 'hyperref'],
    bibtex_style: 'ACM-Reference-Format',
    two_column: true,
    font_size: 10,
    title_format_note: '\\title{} + \\author{} + \\affiliation{}',
    abstract_format_note: '\\begin{abstract}...\\end{abstract}',
    reference_format_note: 'ACM 引用格式，按出现顺序编号',
    notes: 'ACM 会议/期刊模板，使用 acmart 文档类。sigconf 是会议常用选项。',
    created_at: 0,
    updated_at: 0,
  },
]

/** 已初始化标记（避免重复初始化） */
let initialized = false

/**
 * 初始化内置模板（首次使用时写入 DB）
 */
export async function initBuiltinTemplates(): Promise<void> {
  if (initialized) return

  const existing = await db.journal_templates.count()
  if (existing === 0) {
    const now = Date.now()
    const templatesWithTimestamps = BUILTIN_TEMPLATES.map((t) => ({
      ...t,
      created_at: now,
      updated_at: now,
    }))
    await db.journal_templates.bulkPut(templatesWithTimestamps)
  }

  initialized = true
}

/**
 * 获取所有期刊模板
 */
export async function getAllTemplates(): Promise<JournalTemplate[]> {
  await initBuiltinTemplates()
  const templates = await db.journal_templates.orderBy('updated_at').reverse().toArray()
  return templates
}

/**
 * 根据 id 获取单个模板
 */
export async function getTemplateById(id: string): Promise<JournalTemplate | undefined> {
  await initBuiltinTemplates()
  return db.journal_templates.get(id)
}

/**
 * 新建/更新模板
 */
export async function upsertTemplate(template: Omit<JournalTemplate, 'created_at' | 'updated_at'> & { created_at?: number; updated_at?: number }): Promise<JournalTemplate> {
  const now = Date.now()
  const existing = await db.journal_templates.get(template.id)

  const toSave: JournalTemplate = {
    ...template,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  } as JournalTemplate

  await db.journal_templates.put(toSave)
  return toSave
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
    hash = hash & hash // 转换为 32 位整数
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
    // 旧版本入历史
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
    // 可能是 CORS 或网络问题
    return {
      changed: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * 从模板创建一个副本（用于自定义修改）
 */
export async function duplicateTemplate(sourceId: string, newName: string): Promise<JournalTemplate | undefined> {
  const source = await db.journal_templates.get(sourceId)
  if (!source) return undefined

  const now = Date.now()
  const newId = `${sourceId}-copy-${now.toString(36)}`

  const copy: JournalTemplate = {
    ...source,
    id: newId,
    name: newName,
    notes: (source.notes ? source.notes + '\n\n' : '') + `复制自 ${source.name} (${sourceId})`,
    created_at: now,
    updated_at: now,
    // 清空投稿须知历史
    guidelines_history: undefined,
    guidelines_last_checked_at: undefined,
    guidelines_last_updated_at: undefined,
    guidelines_content_hash: undefined,
  }

  await db.journal_templates.put(copy)
  return copy
}
