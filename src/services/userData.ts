/**
 * 用户数据同步服务
 * -------------------------------------------------
 * 所有用户数据（除了 Token 等敏感凭据）都存储在 GitHub 私库。
 * localStorage 仅作为内存缓存，真正的数据源是 GitHub 私库。
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

const CACHE_PREFIX = 'af_cache_'
const CACHE_TTL = 5 * 60 * 1000 // 5 分钟缓存

interface CacheEntry<T> {
  data: T
  sha: string
  fetchedAt: number
}

function getCache<T>(key: string): CacheEntry<T> | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key)
    if (!raw) return null
    const entry = JSON.parse(raw) as CacheEntry<T>
    if (Date.now() - entry.fetchedAt > CACHE_TTL) return null
    return entry
  } catch {
    return null
  }
}

function setCache<T>(key: string, data: T, sha: string) {
  const entry: CacheEntry<T> = { data, sha, fetchedAt: Date.now() }
  localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry))
}

function getRepoContext(): { owner: string; repo: string; token: string } | null {
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
  const ctx = getRepoContext()
  if (!ctx) {
    setCache(path, data, '')
    return
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
    setCache(path, data, '')
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
  const ctx = getRepoContext()
  if (!ctx) {
    setCache(path, content, '')
    return null
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
    setCache(path, content, '')
    throw err
  }
}

/** 简易 CSV 解析 */
function parseCsv(content: string): string[][] {
  const lines = content.trim().split('\n')
  return lines.map((line) => {
    const result: string[] = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = !inQuotes
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current)
        current = ''
      } else {
        current += ch
      }
    }
    result.push(current)
    return result
  })
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
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k?.startsWith(CACHE_PREFIX)) keys.push(k)
  }
  keys.forEach((k) => localStorage.removeItem(k))
}
