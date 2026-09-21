/**
 * 用户数据同步服务
 * -------------------------------------------------
 * 所有用户数据（除了 Token 等敏感凭据）都存储在 GitHub 私库。
 * 内存 Map 仅作为进程内缓存，真正的数据源是 GitHub 私库。
 *
 * 数据目录结构（对应骨架 §7.1.1）：
 * - vocabulary/vocabulary.csv — 词汇本 + 学习进度
 * - sentences/sentences.csv — 长难句本
 * - translation_practice/translation_practice.csv — 翻译练习本
 * - keyword_groups/keyword_groups.csv — 追踪用关键词组
 * - settings/global.md — 全局设置（不含 API Key）
 * - notes/ — 阅读笔记（每篇文献一个 .md）
 * - annotations/ — 批注（每篇文献一个 .csv）
 *
 * 设计原则：
 * - Token/API Key 只存 IndexedDB（本机敏感数据）
 * - 业务数据全部存 GitHub 私库，支持跨设备同步
 * - 自动同步：页面加载时拉取，数据变更时推送
 * - 冲突处理：以最新修改时间为准
 */

import { readRepoTextFile, writeRepoTextFile } from './github'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'
import { assertCanWrite } from './authError'

const CACHE_TTL = 5 * 60 * 1000 // 5 分钟缓存

interface CacheEntry<T> {
  data: T
  sha: string
  fetchedAt: number
}

// 使用内存缓存而非 localStorage，避免把用户业务数据落到浏览器持久存储。
// 页面刷新后缓存失效，会从 GitHub 私库重新拉取真实数据。
const memoryCache = new Map<string, CacheEntry<unknown>>()

function getCache<T>(key: string): CacheEntry<T> | null {
  const entry = memoryCache.get(key) as CacheEntry<T> | undefined
  if (!entry) return null
  if (Date.now() - entry.fetchedAt > CACHE_TTL) {
    memoryCache.delete(key)
    return null
  }
  return entry
}

function setCache<T>(key: string, data: T, sha: string) {
  const entry: CacheEntry<T> = { data, sha, fetchedAt: Date.now() }
  memoryCache.set(key, entry as CacheEntry<unknown>)
}

export function getRepoContext(): { owner: string; repo: string; token: string } | null {
  const auth = useAuthStore.getState()
  const ws = useWorkspaceStore.getState()
  if (!auth.token || !auth.user || !ws.repo) return null
  return {
    owner: auth.user.login,
    repo: ws.repo.name,
    token: auth.token,
  }
}

/** 读取 CSV 文件（自动解析） */
export async function readCsvFile<T>(
  path: string,
  parseFn: (rows: string[][]) => T[],
  force = false,
): Promise<T[]> {
  const ctx = getRepoContext()
  const cache = getCache<T[]>(path)

  if (!force && cache) return cache.data

  if (!ctx) {
    return cache?.data ?? []
  }

  try {
    const result = await readRepoTextFile(ctx.owner, ctx.repo, path, ctx.token)
    if (!result) {
      setCache(path, [], '')
      return []
    }
    const rows = parseCsv(result.content)
    const data = parseFn(rows)
    setCache(path, data, result.sha)
    return data
  } catch (err) {
    console.warn('[userData] 读取失败，回退到缓存:', path, err)
    return cache?.data ?? []
  }
}

/** 写入 CSV 文件（自动序列化） */
export async function writeCsvFile<T>(
  path: string,
  data: T[],
  headers: string[],
  serializeFn: (item: T) => string[],
): Promise<void> {
  assertCanWrite()
  const ctx = getRepoContext()
  if (!ctx) {
    // 不再静默丢弃到内存缓存——直接报错让调用方知道持久化失败
    // 之前静默 return 会导致用户以为写成功了（toast "已入库"），但 F5 刷新后数据丢失
    throw new Error(
      '工作区尚未就绪，无法保存数据。请等待页面加载完成后重试，或刷新页面。',
    )
  }

  const rows = [headers, ...data.map(serializeFn)]
  const content = rows.map((r) => r.map(csvEscape).join(',')).join('\n')

  try {
    const sha = await writeRepoTextFile(
      ctx.owner,
      ctx.repo,
      path,
      content,
      ctx.token,
      `Update ${path.split('/').pop()}`,
    )
    setCache(path, data, sha)
  } catch (err) {
    console.error('[userData] 写入失败:', path, err)
    throw err
  }
}

/** 读取 Markdown 文件 */
export async function readMdFile(
  path: string,
  force = false,
): Promise<{ content: string; sha: string } | null> {
  const ctx = getRepoContext()
  const cache = getCache<string>(path)

  if (!force && cache) {
    return { content: cache.data, sha: cache.sha }
  }

  if (!ctx) {
    return cache ? { content: cache.data, sha: cache.sha } : null
  }

  try {
    const result = await readRepoTextFile(ctx.owner, ctx.repo, path, ctx.token)
    if (!result) return null
    setCache(path, result.content, result.sha)
    return result
  } catch (err) {
    console.warn('[userData] 读取 md 失败:', path, err)
    return cache ? { content: cache.data, sha: cache.sha } : null
  }
}

/** 写入 Markdown 文件 */
export async function writeMdFile(
  path: string,
  content: string,
  message?: string,
): Promise<string | null> {
  assertCanWrite()
  const ctx = getRepoContext()
  if (!ctx) {
    throw new Error(
      '工作区尚未就绪，无法保存数据。请等待页面加载完成后重试，或刷新页面。',
    )
  }

  try {
    const sha = await writeRepoTextFile(
      ctx.owner,
      ctx.repo,
      path,
      content,
      ctx.token,
      message || `Update ${path.split('/').pop()}`,
    )
    setCache(path, content, sha)
    return sha
  } catch (err) {
    console.error('[userData] 写入 md 失败:', path, err)
    throw err
  }
}

/**
 * CSV 解析（RFC4180 状态机，**跨行**）。
 *
 * 早期版本是 `content.split('\n')` 逐行解析 —— 那是错的，而且错得很隐蔽：
 * 带换行的字段写出去时被 csvEscape 正确包成了 "a\nb"，但读回来时 split('\n')
 * 把这一条记录劈成两行，引号状态在行与行之间不延续，于是后面的列全部错位。
 * 实测（批注 text 里带一个换行）：
 *   写：  anno-1,highlight,yellow,"first line\nsecond line",...
 *   读：  ["anno-1","highlight","yellow","first line"]
 *         ["second line,my note"]
 *         ["line2,111,222"]
 * 一条记录裂成三条垃圾行。私库里那份 annotations.csv 就是这么烂掉的
 * （text 只剩 "3" / "Cs " / " CO " 碎片，created_at 全 0），而且每读写一轮
 * 就再掉一次行 —— 因为前端又把错位后的数据当真相写回去了。
 *
 * 所以这里必须按字符流解析：引号内的换行是字段内容，不是行分隔符。
 */
function parseCsv(content: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQuotes = false

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(cur)
      cur = ''
    } else if (ch === '\n') {
      row.push(cur)
      cur = ''
      rows.push(row)
      row = []
    } else if (ch !== '\r') {
      cur += ch
    }
  }
  row.push(cur)
  rows.push(row)

  // 文件末尾的换行会多产出一个空行，丢掉
  while (rows.length > 0) {
    const last = rows[rows.length - 1]
    if (last.length === 1 && last[0].trim() === '') rows.pop()
    else break
  }
  return rows
}

function csvEscape(val: string | number | boolean | null | undefined): string {
  const s = String(val ?? '')
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/** 强制刷新所有缓存（手动同步时调用） */
export function clearAllCache() {
  memoryCache.clear()
}

/** 单条缓存失效（写操作成功后主动调用，防止后续 readCsvFile 返回旧数据） */
export function invalidateCache(path: string) {
  memoryCache.delete(path)
}
