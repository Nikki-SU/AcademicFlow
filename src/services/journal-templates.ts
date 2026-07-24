/**
 * 期刊模板管理服务
 * -------------------------------------------------
 * 数据存储严格遵循 SPEC §1.2/§3：
 * - 不存 JSON，每个模板落盘为 `templates/journals/{slug}/` 目录：
 *   - meta.md          : YAML frontmatter 形式的人类可读元信息
 *   - template.tex     : LaTeX 模板骨架
 *   - cover-letter.md.tpl : 投稿信模板
 * - IndexedDB 仅作为本地缓存，写操作总是同步到 GitHub 私库。
 */
import { db } from './db'
import { readRepoTextFile, writeRepoTextFile } from './github'
import { DEFAULT_WORKSPACE_REPO_NAME } from '../constants/skeleton'
import { useAuthStore } from '../stores/auth'
import type { JournalTemplate, GuidelineVersion } from '../types'

const TEMPLATES_DIR = 'templates/journals'

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

/** 把模板 id 转成目录名（已假定 id 仅含小写/数字/连字符） */
function templateDir(id: string): string {
  return `${TEMPLATES_DIR}/${id}`
}

/** 简单 YAML frontmatter 解析（仅支持一层 key: value，value 为字符串/数字/布尔） */
function parseFrontmatter(md: string): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  const match = md.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return obj
  const lines = match[1].split('\n')
  for (const line of lines) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let val = line.slice(idx + 1).trim()
    if (val === 'true') obj[key] = true
    else if (val === 'false') obj[key] = false
    else if (/^-?\d+$/.test(val)) obj[key] = parseInt(val, 10)
    else if (/^-?\d+\.\d+$/.test(val)) obj[key] = parseFloat(val)
    else obj[key] = val
  }
  return obj
}

/** 简单 YAML frontmatter 序列化 */
function stringifyFrontmatter(obj: Record<string, unknown>): string {
  const lines = ['---']
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined || val === null) {
      lines.push(`${key}: `)
    } else if (typeof val === 'string' && /[\n:]/.test(val)) {
      // 含换行或冒号的字符串用双引号包裹并转义
      const escaped = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
      lines.push(`${key}: "${escaped}"`)
    } else {
      lines.push(`${key}: ${String(val)}`)
    }
  }
  lines.push('---')
  return lines.join('\n')
}

/** Guidelines 历史序列化为 md 正文（因为 frontmatter 不适合存大数组） */
function stringifyGuidelinesHistory(history: GuidelineVersion[] | undefined): string {
  if (!history || history.length === 0) return ''
  const lines = ['\n# 投稿须知版本历史\n']
  for (const v of history) {
    lines.push(`## v${v.version} (${new Date(v.updated_at).toISOString()})`)
    if (v.change_note) lines.push(`**变更说明**：${v.change_note}`)
    lines.push(`> 摘要：${v.summary}`)
    if (v.full_content) {
      lines.push('\n```text')
      lines.push(v.full_content)
      lines.push('```')
    }
    lines.push('')
  }
  return lines.join('\n')
}

function parseGuidelinesHistory(md: string): GuidelineVersion[] | undefined {
  const history: GuidelineVersion[] = []
  const blockRegex = /## v(\d+) \(([\s\S]*?)\)\n([\s\S]*?)(?=\n## v\d+ \(|$)/g
  let match
  while ((match = blockRegex.exec(md)) !== null) {
    const version = parseInt(match[1], 10)
    const updated_at = new Date(match[2]).getTime() || Date.now()
    const body = match[3].trim()
    const changeMatch = body.match(/\*\*变更说明\*\*：([\s\S]*?)(?=\n>|$)/)
    const summaryMatch = body.match(/> 摘要：([\s\S]*?)(?=\n```|$)/)
    const fullMatch = body.match(/```text\n([\s\S]*?)\n```/)
    history.push({
      version,
      updated_at,
      summary: summaryMatch ? summaryMatch[1].trim() : '',
      full_content: fullMatch ? fullMatch[1].trim() : undefined,
      change_note: changeMatch ? changeMatch[1].trim() : undefined,
    })
  }
  return history.length ? history : undefined
}

/** 从 frontmatter + 文件内容构造 JournalTemplate */
function filesToTemplate(
  id: string,
  metaMd: string,
  tex: string,
  coverLetter: string,
): JournalTemplate {
  const fm = parseFrontmatter(metaMd)
  const body = metaMd.replace(/^---\n[\s\S]*?\n---/, '').trim()
  const history = parseGuidelinesHistory(body)

  const parseString = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined
  const parseNumber = (v: unknown): number | undefined =>
    typeof v === 'number' ? v : undefined

  return {
    id,
    name: String(fm.name || id),
    short_name: parseString(fm.short_name),
    publisher: parseString(fm.publisher),
    journal_url: parseString(fm.journal_url),
    guidelines_url: parseString(fm.guidelines_url),
    guidelines_content: parseString(fm.guidelines_content),
    guidelines_content_hash: parseString(fm.guidelines_content_hash),
    guidelines_last_checked_at: parseNumber(fm.guidelines_last_checked_at),
    guidelines_last_updated_at: parseNumber(fm.guidelines_last_updated_at),
    guidelines_history: history,
    document_class: String(fm.document_class || 'article'),
    document_options: parseString(fm.document_options),
    packages: parseString(fm.packages)
      ? String(fm.packages)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    bibtex_style: String(fm.bibtex_style || 'unsrt'),
    two_column: fm.two_column === true,
    font_size: parseNumber(fm.font_size),
    title_format_note: parseString(fm.title_format_note),
    abstract_format_note: parseString(fm.abstract_format_note),
    reference_format_note: parseString(fm.reference_format_note),
    custom_preamble: parseString(fm.custom_preamble),
    template_tex: tex || parseString(fm.template_tex),
    cover_letter: coverLetter || parseString(fm.cover_letter),
    notes: parseString(fm.notes),
    created_at: parseNumber(fm.created_at) || Date.now(),
    updated_at: parseNumber(fm.updated_at) || Date.now(),
  }
}

/** 把 JournalTemplate 拆成目录下三个文件内容 */
function templateToFiles(template: JournalTemplate): {
  meta: string
  tex: string
  coverLetter: string
} {
  const fm: Record<string, unknown> = {
    id: template.id,
    name: template.name,
    short_name: template.short_name || '',
    publisher: template.publisher || '',
    journal_url: template.journal_url || '',
    guidelines_url: template.guidelines_url || '',
    guidelines_content: template.guidelines_content || '',
    guidelines_content_hash: template.guidelines_content_hash || '',
    guidelines_last_checked_at: template.guidelines_last_checked_at || '',
    guidelines_last_updated_at: template.guidelines_last_updated_at || '',
    document_class: template.document_class,
    document_options: template.document_options || '',
    packages: template.packages.join(', '),
    bibtex_style: template.bibtex_style,
    two_column: template.two_column,
    font_size: template.font_size || '',
    title_format_note: template.title_format_note || '',
    abstract_format_note: template.abstract_format_note || '',
    reference_format_note: template.reference_format_note || '',
    custom_preamble: template.custom_preamble || '',
    notes: template.notes || '',
    created_at: template.created_at,
    updated_at: template.updated_at,
  }

  const historyBody = stringifyGuidelinesHistory(template.guidelines_history)
  const meta =
    stringifyFrontmatter(fm) +
    '\n\n# 期刊元信息\n\n可在此处写备注。' +
    historyBody

  return {
    meta,
    tex: template.template_tex || template.custom_preamble || '',
    coverLetter: template.cover_letter || '',
  }
}

/**
 * 列出 GitHub 私库中 `templates/journals/` 下的所有模板目录
 */
async function listTemplateDirs(
  owner: string,
  repo: string,
  token: string,
): Promise<string[]> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${TEMPLATES_DIR}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  )
  if (res.status === 404) return []
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`列出模板目录失败：${err}`)
  }
  const items = (await res.json()) as Array<{ type: string; name: string }>
  return items.filter((i) => i.type === 'dir').map((i) => i.name)
}

/**
 * 从 GitHub 私库读取所有模板
 * 失败时回退到本地 IndexedDB 缓存
 */
export async function getAllTemplates(): Promise<JournalTemplate[]> {
  const ctx = getUserContext()
  if (ctx) {
    try {
      const dirs = await listTemplateDirs(ctx.owner, ctx.repo, ctx.token)
      const templates: JournalTemplate[] = []
      for (const id of dirs) {
        const dir = templateDir(id)
        const meta = await readRepoTextFile(ctx.owner, ctx.repo, `${dir}/meta.md`, ctx.token)
        const tex = await readRepoTextFile(ctx.owner, ctx.repo, `${dir}/template.tex`, ctx.token)
        const cover = await readRepoTextFile(
          ctx.owner,
          ctx.repo,
          `${dir}/cover-letter.md.tpl`,
          ctx.token,
        )
        if (!meta) continue
        templates.push(filesToTemplate(id, meta.content, tex?.content || '', cover?.content || ''))
      }
      templates.sort((a, b) => b.updated_at - a.updated_at)
      await db.journal_templates.clear()
      await db.journal_templates.bulkPut(templates)
      return templates
    } catch (err) {
      console.warn('[journal-templates] 从 GitHub 读取失败，回退到本地缓存:', err)
    }
  }
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
 * 向 GitHub 私库写入单个模板目录
 */
async function writeTemplate(template: JournalTemplate): Promise<void> {
  const ctx = getUserContext()
  if (!ctx) return
  const dir = templateDir(template.id)
  const files = templateToFiles(template)
  await writeRepoTextFile(ctx.owner, ctx.repo, `${dir}/meta.md`, files.meta, ctx.token)
  await writeRepoTextFile(ctx.owner, ctx.repo, `${dir}/template.tex`, files.tex, ctx.token)
  await writeRepoTextFile(
    ctx.owner,
    ctx.repo,
    `${dir}/cover-letter.md.tpl`,
    files.coverLetter,
    ctx.token,
  )
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
  const id =
    data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') +
    '-' +
    now.toString(36).slice(-4)

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

  await writeTemplate(template)
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
  const templates = await getAllTemplates()
  const idx = templates.findIndex((t) => t.id === id)
  if (idx === -1) return undefined

  const now = Date.now()
  const updated: JournalTemplate = {
    ...templates[idx],
    ...updates,
    id,
    created_at: templates[idx].created_at,
    updated_at: now,
  }

  await writeTemplate(updated)
  await db.journal_templates.put(updated)
  return updated
}

/**
 * 删除模板（从 GitHub 私库删除目录下所有文件）
 */
export async function deleteTemplate(id: string): Promise<void> {
  const ctx = getUserContext()
  const dir = templateDir(id)
  const files = ['meta.md', 'template.tex', 'cover-letter.md.tpl']
  if (ctx) {
    for (const name of files) {
      try {
        const file = await readRepoTextFile(ctx.owner, ctx.repo, `${dir}/${name}`, ctx.token)
        if (file) {
          await fetch(
            `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/contents/${encodeURIComponent(
              `${dir}/${name}`,
            )}`,
            {
              method: 'DELETE',
              headers: {
                Authorization: `Bearer ${ctx.token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                message: `chore: remove journal template ${id}/${name}`,
                sha: file.sha,
                branch: 'main',
              }),
            },
          )
        }
      } catch (err) {
        console.warn(`[journal-templates] 删除 ${dir}/${name} 失败:`, err)
      }
    }
  }
  await db.journal_templates.delete(id)
}

/**
 * 生成内容哈希（用于检测投稿须知变化）
 */
export function hashContent(content: string): string {
  let hash = 0
  if (content.length === 0) return String(hash)
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i)
    hash = (hash << 5) - hash + char
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
  const template = await getTemplateById(templateId)
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

  await writeTemplate(updated)
  await db.journal_templates.put(updated)
  return updated
}

/**
 * 检测投稿须知网页是否变化（简单 fetch + 哈希对比）
 * 注意：受 CORS 和反爬限制，可能失败，此时返回 null 表示无法检测
 */
export async function checkGuidelinesChanged(
  url: string,
  currentHash: string,
): Promise<{
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
export async function duplicateTemplate(
  sourceId: string,
  newName: string,
): Promise<JournalTemplate | undefined> {
  const source = await getTemplateById(sourceId)
  if (!source) return undefined

  const now = Date.now()
  const newId =
    newName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') +
    '-' +
    now.toString(36).slice(-4)

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

  await writeTemplate(copy)
  await db.journal_templates.put(copy)
  return copy
}
