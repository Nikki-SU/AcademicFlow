/**
 * 期刊名缩写
 * -----------
 * 列表里只显示期刊缩写（如 JACS），完整名太长会挤爆横条。
 * 默认用启发式规则取首字母，用户在管理页可以用铅笔按钮手工覆盖，
 * 覆盖表按「全名 → 缩写」存进 settings（key = journal_abbreviations）。
 */
import { getSetting, putSetting } from './db'

/** settings 里的存储 key */
const SETTING_KEY = 'journal_abbreviations'

/** 缩写时丢弃的虚词（大小写不敏感）。注意不要丢 Review / Journal —— 它们是缩写首字母。 */
const STOP_WORDS = new Set([
  'of', 'the', 'and', 'in', 'on', 'for', 'a', 'an', 'to', 'at', 'by', 'with', 'from',
  'de', 'la', 'le', '&',
])

/** 纯函数启发式缩写 */
export function abbreviateJournal(name: string): string {
  const trimmed = (name || '').trim()
  if (!trimmed) return ''

  // 只有一个词，或长度 ≤ 12 且不含空格：原样返回
  const spaced = trimmed.split(/\s+/).filter(Boolean)
  if (spaced.length <= 1 || (trimmed.length <= 12 && !trimmed.includes(' '))) return trimmed

  // 按空白 / - / & 切词，丢虚词，取首字母大写
  const abbrev = trimmed
    .split(/[\s\-&]+/)
    .map((w) => w.trim())
    .filter((w) => w && !STOP_WORDS.has(w.toLowerCase()))
    .map((w) => w[0].toUpperCase())
    .join('')

  // 全被过滤掉：回退为原名前若干字符
  if (!abbrev) return trimmed.slice(0, 12)
  return abbrev
}

/** 读取本地覆盖表；读失败返回空对象 */
export async function loadJournalAbbrevMap(): Promise<Record<string, string>> {
  try {
    const raw = await getSetting(SETTING_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** 保存/删除某个期刊的缩写；写失败静默忽略 */
export async function saveJournalAbbrev(fullName: string, abbrev: string): Promise<void> {
  const name = fullName.trim()
  if (!name) return
  try {
    const map = await loadJournalAbbrevMap()
    const value = abbrev.trim()
    if (!value) {
      delete map[name]
    } else {
      map[name] = value
    }
    await putSetting(SETTING_KEY, JSON.stringify(map))
  } catch {
    // 静默忽略
  }
}
