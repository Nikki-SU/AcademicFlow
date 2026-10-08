/**
 * 阅读页「可信检索」源材料的构造（ADJ-129）
 * -------------------------------------------------
 * 目标：**不再硬编码截断原文**，而是按当前模型真实能吃下的窗口决定送多少；
 * 送不下时走「目录 → AI 选章 → 送选中章节正文」两阶段，保证 AI 至少看到
 * 用户最需要的那部分。
 *
 * 策略：
 *   1. 以 AI-1 / AI-2 里**较小**的窗口为准（同一份源材料要同时喂给两端）；
 *   2. 整份正文（+选中片段）估算 token ≤ 预算 → 全送，一字不截；
 *   3. 超预算 → 把正文按标题切成章节（切到哪一层按预算自适应，见 `splitIntoChapters`），
 *      先送「目录 + 问题」让 AI 挑相关章节，再本地切出这些章节的**完整正文**当源材料；
 *   4. 正文没有任何可用标题（切不出章节）→ 按预算给选中处上下文（无标题就只能这样，
 *      预算仍由模型窗口派生，不是写死的 4000 字）。
 *
 * 契约约束（先约束再容错）：选章那一步是**结构化返回**，prompt 里把 JSON schema
 * 写死并禁止代码块 / 多余文字 / 别名键名 / 字符串数字；解析层只兜「代码块围栏」
 * 这一种等价形态，其余（缺字段 / 序号越界 / 非整数）一律报可读错误让用户重试，
 * 不静默降级成空。
 */
import { callAI } from './client'
import { estimateTokens, outputReserve, resolveContextWindow } from './modelWindow'
import { splitMarkdownIntoChapters } from '../chapterSplit'
import type { AISlotConfig } from '../../types'

/**
 * 除源材料外的固定开销预留（token）。
 * 覆盖：runner 的「【源材料】/【任务指令】」包装、AI-1 系统提示、以及 AI-2 那套较长的
 * 忠实性核查系统提示（同一份源材料 AI-2 也要收）。取一个有余量的近似值。
 */
const PROMPT_OVERHEAD_TOKENS = 4_000

/** 预算下限：兜住极端小的窗口，避免出现 0 或负数预算 */
const MIN_BUDGET_TOKENS = 1_000

export interface ReadingSourceResult {
  /** 交给双引擎当 ground truth 的源材料 */
  material: string
  /** full = 整本塞下（无截断）；chapters = 两阶段选章 */
  mode: 'full' | 'chapters'
  /** 两阶段时实际送入的章节标题（用于给用户提示「依据了哪几章」） */
  pickedTitles: string[]
}

export interface BuildReadingSourceOptions {
  docMarkdown: string
  focusText: string
  question: string
  historyContext: string
  ai1: AISlotConfig
  ai2: AISlotConfig
  signal?: AbortSignal
  /** 两阶段时上报阶段文案（例如「正在定位相关章节…」） */
  onStage?: (stage: string) => void
}

export async function buildReadingSourceMaterial(
  opts: BuildReadingSourceOptions,
): Promise<ReadingSourceResult> {
  const doc = opts.docMarkdown
  const sel = opts.focusText.trim()
  const selBlock = sel ? `【用户选中的正文片段】\n${sel}\n\n` : ''

  if (!doc.trim()) {
    return { material: selBlock.trim(), mode: 'full', pickedTitles: [] }
  }

  // 两端模型里取较小窗口：源材料是共享的，谁先装不下谁说了算
  const window = Math.min(
    resolveContextWindow(opts.ai1.model),
    resolveContextWindow(opts.ai2.model),
  )
  const budget = Math.max(
    MIN_BUDGET_TOKENS,
    window - outputReserve(window) - estimateTokens(opts.question) - estimateTokens(opts.historyContext) - PROMPT_OVERHEAD_TOKENS,
  )

  // ── 整本塞得下 → 全送，不截断 ──
  if (estimateTokens(doc) + estimateTokens(selBlock) <= budget) {
    return { material: `${selBlock}${doc}`, mode: 'full', pickedTitles: [] }
  }

  // ── 塞不下 → 两阶段选章 ──
  opts.onStage?.('材料较长，正在定位相关章节…')
  const chapters = splitIntoChapters(doc, budget)

  if (chapters.length <= 1) {
    // 没有可用标题，切不出章节 → 按预算给选中处上下文
    return {
      material: selBlock + fitAroundSelection(doc, sel, budget),
      mode: 'chapters',
      pickedTitles: [],
    }
  }

  const picked = await selectChapterIndices(chapters, sel, opts)

  // AI 说「没有相关章节」：不静默降级，明确按「选中章 + 顺序章」确定性兜底
  const order = picked.length > 0 ? picked : chapters.map((c) => c.index)

  const { material, titles } = buildChapterMaterial(chapters, order, sel, budget)
  return { material: selBlock + material, mode: 'chapters', pickedTitles: titles }
}

/**
 * 按标题切章，并**按预算挑「切到哪一层」**（ADJ-132）。
 *
 * 旧口径「h1 能切出 >1 块就用 h1」在《注定一战》这类「`#` = 部/卷、`##` = 章/附录」的书上，
 * 会把附录（`## 附录1 …`）挡在目录之外：只切出 4 个「部/卷」级大块，目录里根本没有附录，
 * AI 永远选不到它 → 附录正文永不进模型 → AI 只能老实回 `[NOT_IN_SOURCE]`（书里其实有）。
 *
 * 新口径：h1 若**可作「章」级使用**才用 h1，否则退 h2 ——
 *   - h1 块数 ≥ 2，且
 *   - h1 中**最大块估算 token ≤ 预算的一半**（任一整章就吃掉一半以上预算 = 太粗，是「部/卷」级）。
 * 两条都满足 → h1；否则 h2 块数 ≥ 2 就用 h2；h2 也不成 → 回 h1（与旧行为一致）。
 */
const COARSE_BLOCK_RATIO = 0.5

function splitIntoChapters(doc: string, budget: number) {
  const l1 = splitMarkdownIntoChapters(doc, 1).chapterContents
  const l2 = splitMarkdownIntoChapters(doc, 2).chapterContents
  const usable = (chs: typeof l1) =>
    chs.length >= 2 &&
    Math.max(...chs.map((c) => estimateTokens(c.content))) <= budget * COARSE_BLOCK_RATIO
  if (usable(l1)) return l1
  if (l2.length >= 2) return l2
  return l1
}

const SELECT_SYSTEM = [
  '你是学术材料的章节定位助手。用户给出一本书（或长篇文献）的章节目录和一个问题，',
  '你要从目录里挑出最可能包含答案的章节，按相关度从高到低排序。',
  '',
  '只输出一个 JSON 对象，不要代码块、不要任何多余文字。格式必须严格如下：',
  '{"chapters":[{"index":0,"reason":"用一句话说明这章与问题的关系"}]}',
  '',
  '硬性约束：',
  '- index 必须是目录里真实存在的章节序号（方括号里的那个整数），不得臆造；',
  '- 按相关度从高到低排列，最多 5 个；',
  '- 目录里没有任何相关章节时，输出 {"chapters":[]}。',
].join('\n')

/**
 * 第一步：把「目录 + 问题」交给 AI，拿回相关章节序号。
 * 选章失败（未按契约返回）直接抛可读错误，不返回半个结果。
 */
async function selectChapterIndices(
  chapters: ReturnType<typeof splitIntoChapters>,
  sel: string,
  opts: BuildReadingSourceOptions,
): Promise<number[]> {
  const toc = chapters.map((c) => `[${c.index}] ${c.title}（约 ${c.wordCount} 字）`).join('\n')
  const user = [
    `【目录】\n${toc}`,
    sel ? `【用户选中的文字】\n${sel}` : '',
    opts.historyContext ? `【此前的对话】\n${opts.historyContext}` : '',
    `【问题】\n${opts.question}`,
  ].filter(Boolean).join('\n\n')

  const resp = await callAI({
    baseUrl: opts.ai1.baseUrl,
    apiKey: opts.ai1.apiKey,
    model: opts.ai1.model,
    messages: [
      { role: 'system', content: SELECT_SYSTEM },
      { role: 'user', content: user },
    ],
    thinking: opts.ai1.thinking,
    signal: opts.signal,
  })

  return parseChapterSelection(resp.content || '', chapters.length)
}

/**
 * 解析选章结果。解析层只兜**真正可能出现的等价形态** ——
 * 「代码块围栏」与「前后夹带解释文字」（结果仍是那个 JSON 对象，只是位置变了，
 * 不算违约）；口径与 task-requirement-extractor 的 parseTaskNotes 保持一致。
 * 其余（连 JSON 本体都没有 / 缺字段 / 序号越界 / 非整数）一律报可读错误让用户重试，
 * 不猜别名键、不静默降级成空。
 */
function parseChapterSelection(raw: string, count: number): number[] {
  let text = raw.trim()

  // 去掉可能的代码块围栏（围栏可能在整段文字里的任意位置，不能锚定整串）
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()

  // 截取第一个 { 到最后一个 }（兜 AI 前后夹带的说明文字）
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    // 连 JSON 本体都没有：多为推理过长把输出 token 吃光（正文为空）或模型跑题
    throw new Error(
      text
        ? `章节定位失败：AI 没有按约定返回 JSON（返回开头：${text.slice(0, 60)}…），请重试`
        : '章节定位失败：AI 返回为空（可能是推理过长耗尽了输出预算），请重试',
    )
  }
  text = text.slice(firstBrace, lastBrace + 1)

  let obj: any
  try {
    obj = JSON.parse(text)
  } catch {
    console.warn('[readingSource] 章节定位 JSON 解析失败，原文开头:', raw.slice(0, 300))
    throw new Error('章节定位失败：AI 返回的 JSON 无法解析，请重试')
  }
  if (!obj || !Array.isArray(obj.chapters)) {
    throw new Error('章节定位失败：返回里缺少 chapters 数组，请重试')
  }

  const idxs: number[] = []
  for (const item of obj.chapters) {
    const n = item?.index
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= count) {
      throw new Error(`章节定位失败：返回了无效的章节序号（${JSON.stringify(n)}），请重试`)
    }
    if (!idxs.includes(n)) idxs.push(n)
  }
  return idxs
}

/**
 * 第二步：按顺序把「目录 + 选中章节完整正文」拼进预算。
 * 选中文字所在的章节**必送**（它就是用户最需要的内容）；整章也放不下时按预算截取它的正文。
 */
function buildChapterMaterial(
  chapters: ReturnType<typeof splitIntoChapters>,
  order: number[],
  sel: string,
  budget: number,
): { material: string; titles: string[] } {
  const toc = '【目录】\n' + chapters.map((c) => `[${c.index}] ${c.title}`).join('\n')
  const selIdx = sel ? chapters.find((c) => c.content.includes(sel))?.index : undefined

  const seq: number[] = []
  if (selIdx !== undefined) seq.push(selIdx)
  for (const i of order) if (!seq.includes(i)) seq.push(i)
  for (const c of chapters) if (!seq.includes(c.index)) seq.push(c.index)

  const blocks: string[] = []
  const titles: string[] = []
  let used = estimateTokens(toc)

  for (const idx of seq) {
    const ch = chapters.find((c) => c.index === idx)
    if (!ch) continue
    const head = `【第 ${idx + 1} 章 · ${ch.title}】`
    const block = `${head}\n${ch.content}`
    const t = estimateTokens(block)

    if (used + t > budget) {
      // 选中章且还没送进任何章：即便整章放不下，也要按预算截取它（用户最需要的部分）
      if (idx === selIdx && titles.length === 0) {
        const room = budget - used - estimateTokens(head)
        const trimmed = takeTokens(ch.content, room)
        if (trimmed.trim()) {
          blocks.push(`${head}\n${trimmed}`)
          titles.push(ch.title)
          used += estimateTokens(`${head}\n${trimmed}`)
        }
      }
      continue
    }

    blocks.push(block)
    titles.push(ch.title)
    used += t
    if (used >= budget) break
  }

  // 兜底：一个章节都没塞进去（预算太小或章节都超大）时，强制按预算截取排序第一个章节，
  // 保证 AI 至少看到正文内容，而不是只拿到一份没有正文的目录。
  if (titles.length === 0 && seq.length > 0) {
    const ch = chapters.find((c) => c.index === seq[0])
    if (ch) {
      const head = `【第 ${seq[0] + 1} 章 · ${ch.title}】`
      const trimmed = takeTokens(ch.content, budget - used - estimateTokens(head))
      if (trimmed.trim()) {
        blocks.push(`${head}\n${trimmed}`)
        titles.push(ch.title)
      }
    }
  }

  return { material: [toc, ...blocks].join('\n\n'), titles }
}

/**
 * 无标题正文的兜底：以选中处为中心，按预算向前后各扩一半。
 * 预算由模型窗口派生（estimateTokens 按 1 非 ASCII 字 ≈ 1 token 保守估，
 * 因此「预算字符数」是 token 预算的安全上界）。
 */
function fitAroundSelection(doc: string, sel: string, budget: number): string {
  if (!sel) return takeTokens(doc, budget)
  const at = doc.indexOf(sel)
  if (at < 0) return takeTokens(doc, budget)
  const half = Math.floor(budget / 2)
  const start = Math.max(0, at - half)
  const end = Math.min(doc.length, at + sel.length + half)
  return doc.slice(start, end)
}

/** 取文本前若干 token 的内容（估算口径下，字符数 ≤ token 数，故先按预算切片再收敛） */
function takeTokens(text: string, budget: number): string {
  if (budget <= 0) return ''
  let t = text.slice(0, budget)
  let guard = 0
  let est = estimateTokens(t)
  while (est > budget && t.length > 1 && guard++ < 20) {
    t = t.slice(0, Math.floor((t.length * budget) / est))
    est = estimateTokens(t)
  }
  return t
}
