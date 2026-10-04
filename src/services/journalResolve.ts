/**
 * 期刊解析（模糊输入 → 可追踪的期刊）
 * -------------------------------------------------
 * 用户往往不知道「一本期刊可以被追踪的真实名字」是什么 —— 他可能输入中文名
 * （美国化学会志）、口语化简称（JACS）、甚至记错的一小段（angew chem）。
 * 后端「每日追踪」按 **ISSN** 精确检索 OpenAlex，所以这里的目标是把模糊输入
 * 落到「正式英文刊名 + 权威 ISSN + 出版社」上，供用户点选即填。
 *
 * 分层依据（谁负责什么，别越界）：
 *   - OpenAlex 是**权威源**：ISSN / 出版社 / 刊名一律以它返回的元数据为准，
 *     AI 只负责把模糊输入「翻译」成 OpenAlex 能命中的英文全名，**绝不采用 AI 给的 ISSN**
 *     （AI 给的 ISSN 可能是编的，一个像模像样的错 ISSN 比查不到更危险）。
 *   - 若输入本身就是 ISSN，直接按 ISSN 查 OpenAlex，跳过 AI。
 *   - 先直连 OpenAlex 搜一次原始输入（快、无需 AI，英文名/常见缩写多能直接命中）；
 *     没命中才动用 AI 归一化，再逐名回查 OpenAlex。
 *
 * 查不到就是查不到：返回空数组，由 UI 提示用户手动填写，不猜、不编。
 */
import { callAI } from './ai/client'

/** OpenAlex sources 端点（免费、无需 key；CORS 为 *，浏览器可直连） */
const OPENALEX_SOURCES = 'https://api.openalex.org/sources'

/** 标准 ISSN 形态：4 位数字 - 3 位数字 + 校验位（数字或 X） */
const ISSN_RE = /^\d{4}-\d{3}[\dXx]$/

/** 一个可追踪的期刊候选（元数据全部来自 OpenAlex） */
export interface JournalCandidate {
  /** 正式刊名（OpenAlex display_name） */
  name: string
  /** 权威 ISSN（优先 issn_l；无则取 issn[0]；仍无为空串） */
  issn: string
  /** 出版社（OpenAlex host_organization_name） */
  publisher: string
  /** 收录作品数，用于排序与展示「是否冷门」 */
  worksCount: number
}

interface OpenAlexSource {
  display_name?: string
  issn_l?: string | null
  issn?: string[] | null
  host_organization_name?: string | null
  works_count?: number
}

/** OpenAlex source → 候选；缺刊名的记录直接丢弃（拿不到名字就没法展示/填表） */
function toCandidate(s: OpenAlexSource): JournalCandidate | null {
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

async function fetchSources(url: string): Promise<JournalCandidate[]> {
  try {
    const resp = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!resp.ok) return []
    const data = (await resp.json()) as { results?: OpenAlexSource[] }
    return (data.results || [])
      .map(toCandidate)
      .filter((c): c is JournalCandidate => c !== null)
  } catch {
    // 网络失败当作「没查到」，由下拉框给用户「手动填写」的余地，不把异常抛到 UI
    return []
  }
}

/** 按刊名搜期刊（限定 type:journal，避免命中 book/数据集等 source） */
function searchSourceByName(name: string): Promise<JournalCandidate[]> {
  const url = `${OPENALEX_SOURCES}?search=${encodeURIComponent(name)}&filter=type:journal&per-page=5`
  return fetchSources(url)
}

/** 按 ISSN 精确查期刊 */
function fetchSourceByIssn(issn: string): Promise<JournalCandidate[]> {
  const url = `${OPENALEX_SOURCES}?filter=issn:${encodeURIComponent(issn)}&per-page=3`
  return fetchSources(url)
}

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

/** 用 AI 把模糊输入归一化成 OpenAlex 能命中的英文全名（失败/未配 AI → 空表） */
async function normalizeToEnglishNames(
  query: string,
  ai: { baseUrl: string; apiKey: string; model: string },
): Promise<string[]> {
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
            '你是学术出版领域的文献编辑，熟悉各学科主流期刊的正式英文全名。只输出 JSON，不要解释。',
        },
        {
          role: 'user',
          content: [
            '用户想追踪一本期刊，但他输入的可能是中文名、口语化简称或记错的模糊片段。',
            '请把它归一化成 1~5 个最可能的期刊**正式英文全名**（与 OpenAlex / 出版社官方写法一致）。',
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
    // AI 不可用（未登录 / 未配置 / 超时）不阻塞：退回「直连 OpenAlex 搜原始输入」这条已试过的路
    return []
  }
}

/**
 * 把用户的模糊输入解析成期刊候选列表（按收录量降序，最多 8 条）。
 *
 * ai 传 `getDualEngineConfig()` 的 ai1 槽位；调用方需自行处理「AI 未配置」的异常。
 */
export async function resolveJournals(
  query: string,
  ai: { baseUrl: string; apiKey: string; model: string },
): Promise<JournalCandidate[]> {
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
    push(await fetchSourceByIssn(q))
    if (out.length > 0) return out.slice(0, 8)
  }

  // 2) 直连 OpenAlex 搜原始输入（快路；英文名与不少常见缩写可命中）
  push(await searchSourceByName(q))
  if (out.length > 0) return out.sort((a, b) => b.worksCount - a.worksCount).slice(0, 8)

  // 3) 没命中（多半是中文 / 模糊）→ AI 归一化成英文全名，再逐名回查权威元数据
  const names = await normalizeToEnglishNames(q, ai)
  for (const name of names) {
    push(await searchSourceByName(name))
  }

  return out.sort((a, b) => b.worksCount - a.worksCount).slice(0, 8)
}
