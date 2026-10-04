/**
 * 期刊解析（模糊 / 大小写不敏感输入 → 可追踪的期刊 + 权威 ISSN + RSS）
 * -------------------------------------------------
 * 用户往往不知道「一本期刊可以被追踪的真实名字」是什么 —— 他可能输入中文名
 * （美国化学会志）、口语化简称（JACS）、大小写随意的英文（nature / NATURE）、
 * 甚至记错的一小段（angew chem）。后端「每日追踪」按 **ISSN** 精确检索 OpenAlex，
 * 所以这里的目标是把模糊输入落到「正式刊名 + 权威 ISSN + 出版社」上，供点选即填。
 *
 * 权威源分工（谁负责什么，别越界）：
 *   - Crossref 是**刊名 / ISSN / 出版社的权威源**：`/journals` 的检索天然大小写不敏感、
 *     容错强，直接给出正式刊名 + 印刷/电子 ISSN + 出版社。（CORS 为 *，浏览器可直连）
 *   - OpenAlex 是**「能不能追踪」的验证源**：后端按 ISSN 在 OpenAlex 检索，所以这里
 *     用 OpenAlex 回验候选 ISSN —— 命中了才算「验证跑通」，后端才跑得通。
 *   - AI 只负责把中文名 / 简称 / 记错的模糊输入「翻译」成 Crossref 能命中的英文全名，
 *     **绝不采用 AI 给的 ISSN**（AI 编的像模像样的错 ISSN 比查不到更危险）。
 *   - RSS：期刊 feed 普遍不带 CORS 头，浏览器无法直连校验，故交给**后端 AI 联网检索**
 *     （callWebSearch）；结果由用户确认后再保存，不盲目信任。
 *
 * 查不到就是查不到：返回空数组，由 UI 提示用户手动填写，不猜、不编。
 */
import { callAI } from './ai/client'
import { callWebSearch } from './ai/web-search'

/** Crossref journals 端点（免费、无需 key；CORS 为 *，浏览器可直连） */
const CROSSREF_JOURNALS = 'https://api.crossref.org/journals'
/** OpenAlex sources 端点（免费、无需 key；CORS 为 *，浏览器可直连） */
const OPENALEX_SOURCES = 'https://api.openalex.org/sources'
/** 带上 mailto 进入 Crossref / OpenAlex 的礼貌池，拿更稳的配额 */
const MAILTO = 'academicflow@users.noreply.github.com'

/** 标准 ISSN 形态：4 位数字 - 3 位数字 + 校验位（数字或 X） */
const ISSN_RE = /^\d{4}-\d{3}[\dXx]$/

/** 一个可追踪的期刊候选（刊名/ISSN/出版社来自 Crossref，收录量用于排序） */
export interface JournalCandidate {
  /** 正式刊名（Crossref title） */
  name: string
  /** 用于追踪的权威 ISSN（优先印刷版，无则电子版，仍无为空串） */
  issn: string
  /** 印刷版 ISSN（Crossref issn-type.print） */
  issnPrint?: string
  /** 电子版 ISSN（Crossref issn-type.electronic） */
  issnElectronic?: string
  /** 出版社（Crossref publisher） */
  publisher: string
  /** 收录 DOI 数（Crossref counts.total-dois），用于排序与「是否冷门」 */
  worksCount: number
  /**
   * 后端追踪所用库（OpenAlex）是否收录该 ISSN：
   *   true  = 已验证，后端按 ISSN 追踪能跑通
   *   false = 已查但未收录（很可能是新刊/冷门刊），后端可能查不到
   *   undefined = 未校验或校验请求失败（网络问题），不据此下结论
   */
  trackable?: boolean
}

// ============================================================
// Crossref：刊名 / ISSN / 出版社的权威源
// ============================================================

interface CrossrefJournal {
  title?: string
  ISSN?: string[]
  'issn-type'?: { type?: string | null; value?: string }[]
  publisher?: string
  counts?: { 'total-dois'?: number }
}

/** 从 Crossref journal 记录里挑出 ISSN（印刷优先，兼顾电子） */
function pickIssns(item: CrossrefJournal): { issn: string; print?: string; electronic?: string } {
  const list = Array.isArray(item['issn-type']) ? item['issn-type'] : []
  const print = (list.find((t) => t.type === 'print' && t.value)?.value || '').trim()
  const electronic = (list.find((t) => t.type === 'electronic' && t.value)?.value || '').trim()
  const all = (item.ISSN || []).map((v) => (v || '').trim()).filter(Boolean)
  const issn = print || electronic || all[0] || ''
  return { issn, print: print || undefined, electronic: electronic || undefined }
}

/** Crossref journal 记录 → 候选；缺刊名的记录直接丢弃（拿不到名字就没法展示/填表） */
function toCandidate(item: CrossrefJournal): JournalCandidate | null {
  const name = (item.title || '').trim()
  if (!name) return null
  const { issn, print, electronic } = pickIssns(item)
  return {
    name,
    issn,
    issnPrint: print,
    issnElectronic: electronic,
    publisher: (item.publisher || '').trim(),
    worksCount: item.counts?.['total-dois'] || 0,
  }
}

/** 按刊名搜 Crossref 期刊（Crossref 检索天然大小写不敏感） */
async function crossrefSearchByName(name: string): Promise<JournalCandidate[]> {
  const url = `${CROSSREF_JOURNALS}?query=${encodeURIComponent(name)}&rows=5&mailto=${MAILTO}`
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!resp.ok) return []
    const data = (await resp.json()) as { message?: { items?: CrossrefJournal[] } }
    return (data.message?.items || [])
      .map(toCandidate)
      .filter((c): c is JournalCandidate => c !== null)
  } catch {
    // 网络失败当作「没查到」，由下拉框给用户「手动填写」的余地，不把异常抛到 UI
    return []
  }
}

/** 按 ISSN 精确查 Crossref 期刊（用于「输入就是 ISSN」的直查） */
async function crossrefFetchByIssn(issn: string): Promise<JournalCandidate[]> {
  const url = `${CROSSREF_JOURNALS}/${encodeURIComponent(issn)}?mailto=${MAILTO}`
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!resp.ok) return []
    const data = (await resp.json()) as { message?: CrossrefJournal }
    const c = data.message ? toCandidate(data.message) : null
    return c ? [c] : []
  } catch {
    return []
  }
}

// ============================================================
// OpenAlex：名称兜底 + 「能否追踪」验证
// ============================================================

interface OpenAlexSource {
  display_name?: string
  issn_l?: string | null
  issn?: string[] | null
  host_organization_name?: string | null
  works_count?: number
}

/** OpenAlex source → 候选（仅作 Crossref 无果时的兜底） */
function openalexToCandidate(s: OpenAlexSource): JournalCandidate | null {
  const name = (s.display_name || '').trim()
  if (!name) return null
  const issn = (s.issn_l || (s.issn && s.issn[0]) || '').trim()
  return {
    name,
    issn,
    publisher: (s.host_organization_name || '').trim(),
    worksCount: s.works_count || 0,
  }
}

/** 按刊名搜 OpenAlex 期刊（限定 type:journal，避免命中 book/数据集等 source） */
async function openalexSearchByName(name: string): Promise<JournalCandidate[]> {
  const url = `${OPENALEX_SOURCES}?search=${encodeURIComponent(name)}&filter=type:journal&per-page=5&mailto=${MAILTO}`
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!resp.ok) return []
    const data = (await resp.json()) as { results?: OpenAlexSource[] }
    return (data.results || [])
      .map(openalexToCandidate)
      .filter((c): c is JournalCandidate => c !== null)
  } catch {
    return []
  }
}

/** 按 ISSN 精确查 OpenAlex（Crossref 未收录的少数刊兜底） */
async function openalexFetchByIssn(issn: string): Promise<JournalCandidate[]> {
  const url = `${OPENALEX_SOURCES}?filter=issn:${encodeURIComponent(issn)}&per-page=3&mailto=${MAILTO}`
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!resp.ok) return []
    const data = (await resp.json()) as { results?: OpenAlexSource[] }
    return (data.results || [])
      .map(openalexToCandidate)
      .filter((c): c is JournalCandidate => c !== null)
  } catch {
    return []
  }
}

/**
 * 「验证跑通」：用 OpenAlex 回验候选的 ISSN 是否被收录（后端按 ISSN 在 OpenAlex 检索）。
 * 一次请求批量校验（filter 支持 `|` 或），命中即 trackable=true；请求失败则保持 undefined，
 * 不把网络问题误报成「不可追踪」。
 */
async function verifyTrackable(cands: JournalCandidate[]): Promise<void> {
  const issns = [
    ...new Set(
      cands
        .flatMap((c) => [c.issn, c.issnPrint, c.issnElectronic])
        .filter((v): v is string => !!v),
    ),
  ]
  if (issns.length === 0) return
  const filter = issns.map((v) => encodeURIComponent(v)).join('|')
  const url = `${OPENALEX_SOURCES}?filter=issn:${filter}&per-page=50&mailto=${MAILTO}`
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!resp.ok) return
    const data = (await resp.json()) as { results?: OpenAlexSource[] }
    const known = new Set<string>()
    for (const s of data.results || []) {
      for (const v of [s.issn_l, ...(s.issn || [])]) {
        if (v) known.add(v.trim().toLowerCase())
      }
    }
    for (const c of cands) {
      const keys = [c.issn, c.issnPrint, c.issnElectronic]
        .filter((v): v is string => !!v)
        .map((v) => v.toLowerCase())
      c.trackable = keys.some((k) => known.has(k))
    }
  } catch {
    // 校验请求失败 → 保持 undefined，不误报
  }
}

// ============================================================
// AI：把模糊输入归一化成英文全名（唯一职责；不采信 AI 给的 ISSN）
// ============================================================

/**
 * 从 AI 输出里抠出候选英文刊名。
 * prompt 已把契约约束死（只输出 { "candidates": [...] }），这里只做「围栏 / 解释文字包裹」
 * 的解包 —— 真正可能出现的等价形态；字段名 / 类型不合契约即视为失败返回空，不猜别名。
 */
function parseCandidateNames(raw: string): string[] {
  let text = (raw || '').trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last <= first) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(first, last + 1))
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const arr = (parsed as { candidates?: unknown }).candidates
  if (!Array.isArray(arr)) return []
  const names = arr
    .filter((v): v is string => typeof v === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
  return [...new Set(names)].slice(0, 5)
}

/** 用 AI 把模糊输入归一化成 Crossref 能命中的英文全名（失败/未登录 → 空表） */
async function normalizeToEnglishNames(query: string): Promise<string[]> {
  try {
    // 凭据留空：后端 chat handler 从 GitHub Actions Secrets 取 AI1_*，前端传了也被忽略
    const resp = await callAI({
      baseUrl: '',
      apiKey: '',
      model: '',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            '你是学术出版领域的文献编辑，熟悉各学科主流期刊的正式英文全名。只输出 JSON，不要解释。',
        },
        {
          role: 'user',
          content: [
            '用户想追踪一本期刊，但他输入的可能是中文名、口语化简称、大小写随意的英文或记错的模糊片段。',
            '请把它归一化成 1~5 个最可能的期刊**正式英文全名**（与 Crossref / 出版社官方写法一致）。',
            '',
            '示例：',
            '输入：美国化学会志 → { "candidates": ["Journal of the American Chemical Society"] }',
            '输入：JACS → { "candidates": ["Journal of the American Chemical Society"] }',
            '输入：nature → { "candidates": ["Nature"] }',
            '输入：angew chem → { "candidates": ["Angewandte Chemie International Edition", "Angewandte Chemie"] }',
            '',
            '规则：',
            '- 只给期刊正式英文全名；不要给 ISSN、不要给中文名、不要给缩写。',
            '- 不确定就少给，禁止编造不存在的期刊。',
            '',
            `输入：${query}`,
            '',
            '只返回如下 JSON（不要 markdown 代码块包裹，candidates 必须是字符串数组）：',
            '{ "candidates": ["英文全名1", "英文全名2"] }',
          ].join('\n'),
        },
      ],
    })
    return parseCandidateNames(resp.content || '')
  } catch {
    // AI 不可用（未登录 / 未配置 / 超时）不阻塞：退回「直连数据源搜原始输入」这条已试过的路
    return []
  }
}

// ============================================================
// RSS：交给后端 AI 联网检索（浏览器直连期刊 feed 受 CORS 限制）
// ============================================================

/** 从 AI 输出里抠出 RSS 地址（严格契约 { "rss": "https://..." }；不合法即视为失败） */
function parseRssUrl(raw: string): string | null {
  let text = (raw || '').trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(first, last + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const rss = (parsed as { rss?: unknown }).rss
  if (typeof rss !== 'string') return null
  const url = rss.trim()
  return /^https?:\/\//i.test(url) ? url : null
}

/**
 * 用后端 AI 联网检索期刊的官方 RSS/Atom 订阅地址。
 * 期刊 feed 普遍不带 CORS 头，浏览器无法直连校验，所以这一步只能靠联网检索；结果由用户确认。
 * 查不到 / 不确定 → 返回 null（不编造地址）。
 */
export async function findJournalRss(name: string, issn?: string): Promise<string | null> {
  const q = name.trim()
  if (!q) return null
  try {
    const res = await callWebSearch({
      system: '你是学术期刊订阅助手，只输出 JSON，不要解释。',
      user: [
        '请联网查找下面这本期刊的**官方 RSS / Atom 订阅地址**（订阅最新文章用的 feed）。',
        `期刊：${q}`,
        issn ? `ISSN：${issn}` : '',
        '',
        '要求：',
        '- 只给一个最可信的官方 feed 地址；第三方聚合站的地址不要给。',
        '- 不确定就直接留空，禁止编造或拼凑地址。',
        '',
        '只返回如下 JSON（不要 markdown 代码块包裹）：',
        '{ "rss": "https://..." }',
        '查不到时返回：{ "rss": "" }',
      ]
        .filter((line) => line !== '')
        .join('\n'),
      maxUses: 3,
    })
    return parseRssUrl(res.content || '')
  } catch {
    return null
  }
}

// ============================================================
// 主入口
// ============================================================

/**
 * 把用户的模糊输入解析成期刊候选列表（按收录量降序，最多 8 条）。
 * 每批候选都会用 OpenAlex 回验 ISSN（trackable），保证「点选即用、后端能追踪」。
 */
export async function resolveJournals(query: string): Promise<JournalCandidate[]> {
  const q = query.trim()
  if (!q) return []

  const seen = new Set<string>()
  const out: JournalCandidate[] = []
  const push = (cands: JournalCandidate[]) => {
    for (const c of cands) {
      // 有 ISSN 用 ISSN 去重（同刊不同写法归一）；无 ISSN 退回用刊名
      const key = (c.issn || c.name).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(c)
    }
  }

  // 1) 输入本身就是 ISSN → 权威直查，不需要 AI
  if (ISSN_RE.test(q)) {
    push(await crossrefFetchByIssn(q))
    if (out.length === 0) push(await openalexFetchByIssn(q))
    if (out.length > 0) {
      const top = out.slice(0, 8)
      await verifyTrackable(top)
      return top
    }
  }

  // 2) Crossref 直搜原始输入（快路；大小写不敏感，英文名与不少常见缩写可命中）
  push(await crossrefSearchByName(q))

  // 3) 没命中（多半是中文 / 模糊）→ AI 归一化成英文全名，再逐名回查
  if (out.length === 0) {
    const names = await normalizeToEnglishNames(q)
    for (const name of names) push(await crossrefSearchByName(name))
    // 4) Crossref 仍无 → OpenAlex 名称兜底（Crossref 偶有未收录）
    if (out.length === 0) {
      for (const name of [q, ...names]) push(await openalexSearchByName(name))
    }
  }

  const top = out.sort((a, b) => b.worksCount - a.worksCount).slice(0, 8)
  await verifyTrackable(top)
  return top
}
