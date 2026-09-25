/**
 * 期刊名缩写
 * -----------
 * 列表里只显示期刊缩写（如 JACS），完整名太长会挤爆横条。
 *
 * 缩写来源分三层，优先级从高到低：
 *   1. 用户手工覆盖（管理页铅笔按钮）—— 落在下面的覆盖表里
 *   2. AI 查询结果（第一次见到某个期刊时批量问一次，结果也写进同一张覆盖表）
 *   3. 本地启发式 `abbreviateJournal`（拿不到 AI 时的兜底，不等于学术惯例）
 *
 * 覆盖表按「全名 → 缩写」存进 settings（key = journal_abbreviations）。
 */
import { getSetting, putSetting } from './db'
import { callAI } from './ai/client'

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

/** 批量并入缩写（AI 查询结果落盘用）；返回并入后的完整覆盖表 */
export async function mergeJournalAbbrevs(
  entries: Record<string, string>,
): Promise<Record<string, string>> {
  const map = await loadJournalAbbrevMap()
  for (const [k, v] of Object.entries(entries)) {
    const name = k.trim()
    const value = (v || '').trim()
    if (name && value) map[name] = value
  }
  try {
    await putSetting(SETTING_KEY, JSON.stringify(map))
  } catch {
    // 落盘失败不影响本次显示
  }
  return map
}

/** 从 AI 输出里抠出「期刊全名 → 缩写」映射，只认我们问过的那些全名 */
function parseAbbrevJSON(raw: string, asked: string[]): Record<string, string> {
  let text = (raw || '').trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last <= first) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(first, last + 1))
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const allowed = new Set(asked)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') continue
    const value = v.trim()
    if (!value || !allowed.has(k.trim())) continue
    out[k.trim()] = value
  }
  return out
}

/**
 * 批量查期刊的「约定俗成」缩写（如 JACS / Angew. Chem. Int. Ed.）。
 *
 * 为什么要 AI 而不是取首字母：机械取首字母得到的 ACIE 不是学术界的通用写法，
 * 用户要在参考文献里用、要一眼认出是哪本刊，必须用惯例缩写。
 *
 * 一次请求把「所有没查过的期刊」都带上，而不是一本一发 —— 后端通道（GitHub
 * Actions）单次往返就要分钟级，逐本查会拖很久。查成功的会写进本地覆盖表，
 * 所以同一本刊一辈子只查一次。整体失败（未登录 / 没配 AI）直接返回空表，
 * 列表退回启发式缩写，不报错、不阻塞。
 */
export async function lookupJournalAbbrevsWithAI(
  names: string[],
  ai: { baseUrl: string; apiKey: string; model: string },
): Promise<Record<string, string>> {
  const list = [...new Set(names.map((n) => (n || '').trim()).filter(Boolean))]
  if (list.length === 0) return {}
  try {
    const resp = await callAI({
      baseUrl: ai.baseUrl,
      apiKey: ai.apiKey,
      model: ai.model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            '你是学术出版领域的文献编辑，熟悉各期刊在参考文献里的通用缩写。只输出 JSON，不要解释。',
        },
        {
          role: 'user',
          content: [
            '下面是若干期刊全名，请给出它们**约定俗成**的标准缩写（学术界参考文献里的通用写法，不是机械取首字母）。',
            '',
            '示例：',
            'Journal of the American Chemical Society → JACS',
            'Angewandte Chemie International Edition → Angew. Chem. Int. Ed.',
            'Chemical Society Reviews → Chem. Soc. Rev.',
            'Nature Communications → Nat. Commun.',
            'Physical Review Letters → Phys. Rev. Lett.',
            '',
            '不确定的期刊，缩写给空字符串 —— 不要编造。',
            '',
            '期刊全名列表：',
            ...list.map((n, i) => `${i + 1}. ${n}`),
            '',
            '只返回如下 JSON（不要 markdown 代码块包裹），键必须与上面给出的期刊全名逐字一致：',
            '{ "期刊全名": "缩写" }',
          ].join('\n'),
        },
      ],
    })
    return parseAbbrevJSON(resp.content || '', list)
  } catch {
    return {}
  }
}
