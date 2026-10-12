/**
 * 学习内容生成 —— 学习页「AI 补充生成」与版本更新「历史文献自动补提」共用的纯函数。
 *
 * 抽到这里的唯一目的：**两处口径必须完全一致**（同一套 prompt、同一个解析器）。
 * 交互式生成写在页面里、自动补提写在迁移里，若各写一份 prompt，日子一长必然走样。
 * 本模块不含任何 React / 副作用，只做「拼指令 → 解析 JSON → 组装数据」。
 */
import type { TranslationDirection, TranslationData } from './learningData'
import type { Literature } from './literatureData'

/**
 * 解析 AI-1 输出的学习内容 JSON。
 * prompt 已把格式约束死（严格 JSON、逐字字段名、禁代码块，见 buildLearningInstruction）。
 * 这里只做一层**格式级安全网**：容忍模型多包一层代码块 / 前后带一句话。
 * **绝不把「解析失败」静默降级成空数组** —— 那会把失败伪装成「AI 生成完成（0 条）」，
 * 违反「先约束再容错」原则（见 架构.md §1.10 / ADJ-70）。
 */
export interface ParsedLearningJSON {
  words: Array<{
    word?: string
    phonetic?: string
    meaning?: string
    definitionCn?: string
    definitionEn?: string
    exampleEn?: string
    exampleZh?: string
    morphemes?: unknown
  }>
  sentences: Array<{
    sentenceEn?: string
    sentenceCn?: string
    aiReferenceCn?: string
    scoring_points?: unknown
    difficulty_note?: string
  }>
  translations: Array<{ direction?: string; originalText?: string; scoring_points?: unknown; reference_translation?: string }>
}

export function parseLearningJSON(raw: string): ParsedLearningJSON {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) text = fenceMatch[1].trim()
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1)
  }
  try {
    const parsed = JSON.parse(text) as Partial<ParsedLearningJSON>
    return {
      words: Array.isArray(parsed.words) ? parsed.words : [],
      sentences: Array.isArray(parsed.sentences) ? parsed.sentences : [],
      translations: Array.isArray(parsed.translations) ? parsed.translations : [],
    }
  } catch {
    // 约束已在 prompt 里写死，解析失败就是模型没照约定输出 —— 报错让用户重试，不静默当空。
    throw new Error('AI-1 输出的学习内容不是合法 JSON（已要求严格 JSON、禁代码块），请重试')
  }
}

/** AI 返回的数组字段归一：string[] / 分隔符字符串 / 其它 → 干净的 string[] */
export function toStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => (x == null ? '' : String(x)).trim()).filter(Boolean)
  }
  if (typeof raw === 'string') {
    return raw.split(/[\n;；]+/).map((s) => s.trim()).filter(Boolean)
  }
  return []
}

export interface LearningGenOptions {
  words: boolean
  sentences: boolean
  translation: boolean
  /** 生词条数（来自设置 wordGenCount） */
  wordCount: number
  /** 长难句条数（来自设置 sentenceGenCount） */
  sentenceCount: number
}

/**
 * 拼装 AI-1 的学习内容提取指令。
 * 交互式「AI 补充生成」与版本更新「历史文献自动补提」共用同一套 prompt，保证口径一致。
 *
 * 摘要翻译的题面/参考答案直接来自文献元数据（abstractEn/abstractCn），
 * AI 既不翻译也不产出译文，只需给两个方向的**踩分点** —— 这点必须在 prompt 里说死，
 * 否则模型很容易自作主张去翻译。
 */
export function buildLearningInstruction(
  o: LearningGenOptions,
  abstracts: { en: string; cn: string },
): string {
  // 摘要常常只有一边（只靠 DOI 元数据入库的文献通常只有英文摘要）。
  // 有哪边就出哪个方向：英译中要英文题面、中译英要中文题面；
  // 而参考答案缺的一边（如英译中却没有中文摘要）由 AI 在 reference_translation 里补。
  const hasEn = !!abstracts.en.trim()
  const hasCn = !!abstracts.cn.trim()
  const translationDirs: Array<{ dir: TranslationDirection; needRef: boolean }> = []
  if (hasEn) translationDirs.push({ dir: 'en2cn', needRef: !hasCn })
  if (hasCn) translationDirs.push({ dir: 'cn2en', needRef: !hasEn })

  const tasks: string[] = []
  if (o.words) {
    tasks.push(
      `生词卡片：从原文中挑选 ${o.wordCount} 个学术核心单词，每条含 ` +
        `word / phonetic / meaning(中文释义，答题用的简短短词) / definitionCn(中文定义，一句话，与 definitionEn 相对) / ` +
        `definitionEn(英文定义，一句话) / exampleEn(原文中含该词的那句，逐字) / exampleZh(该例句的中文译文) / ` +
        `morphemes(词根词缀切分，见下方规则)。注意 meaning 是释义、definitionCn 是定义，两者内容不同，都要单独给`,
    )
  }
  if (o.sentences) {
    tasks.push(
      `长难句：从原文中挑选 ${o.sentenceCount} 个有学习价值的长难句，每条含 sentenceEn(原文逐字)/sentenceCn(中文翻译)/aiReferenceCn(参考译文)/scoring_points(踩分点数组)/difficulty_note(说明这句"难"在哪里)`,
    )
  }
  if (o.translation) {
    tasks.push('摘要翻译踩分点：为下面可用摘要的每个翻译方向各生成一组踩分点（写入 JSON 的 translations 字段）')
  }

  const lines: string[] = [
    '请基于上述源材料生成以下学习内容：',
    tasks.map((t, i) => `${i + 1}. ${t}`).join('\n'),
    '',
  ]

  if (o.translation) {
    lines.push(
      '【翻译题（题面与参考答案优先由系统直接从文献元数据注入）】',
      '- en2cn（英译中）：题面 = 英文摘要原文，参考答案 = 中文摘要',
      '- cn2en（中译英）：题面 = 中文摘要原文，参考答案 = 英文摘要',
    )
    if (translationDirs.some((d) => d.needRef)) {
      lines.push(
        '本摘要只有一边语言，题面方向照常出，但缺失的那一边请你在该方向的 reference_translation 字段里补出一份**参考译文**（这就是参考答案，系统会直接采用）。',
      )
    } else {
      lines.push('两个方向的参考答案都已给出，你不需要翻译，也不得输出任何译文。')
    }
    lines.push(
      '你另需为可用方向给出**踩分点**（判分标准，主要覆盖逻辑关系与关键术语/词汇）。',
      '',
      `【英文摘要】${abstracts.en || '[NOT_IN_SOURCE] abstract_en'}`,
      `【中文摘要】${abstracts.cn || '[NOT_IN_SOURCE] abstract_cn'}`,
      '',
    )
  }

  const schema: string[] = []
  if (o.words) {
    schema.push(
      '  "words": [{"word":"...","phonetic":"...","meaning":"...","definitionCn":"...","definitionEn":"...","exampleEn":"...","exampleZh":"...","morphemes":[{"text":"...","type":"prefix|root|suffix|connective","meaning":"..."}]}]',
    )
  }
  if (o.sentences) {
    schema.push('  "sentences": [{"sentenceEn":"...","sentenceCn":"...","aiReferenceCn":"...","scoring_points":["..."],"difficulty_note":"..."}]')
  }
  if (o.translation) {
    const dirSchemas = translationDirs.map(
      (d) =>
        `{"direction":"${d.dir}","scoring_points":["..."]${d.needRef ? ',"reference_translation":"..."' : ''}}`,
    )
    schema.push(`  "translations": [${dirSchemas.join(',')}]`)
  }

  const translationRules: string[] = []
  if (o.translation) {
    const needRefList = translationDirs.filter((d) => d.needRef).map((d) => d.dir).join(' / ')
    translationRules.push(
      translationDirs.some((d) => d.needRef)
        ? `- translations 只在 ${needRefList} 里输出 reference_translation（那份参考译文），其余方向不得输出任何译文，也不得输出 originalText`
        : '- translations **只输出 scoring_points**，不得输出 originalText / reference_translation / 任何译文',
    )
  }

  lines.push(
    '【输出格式（严格 JSON，不要 markdown 代码块包裹）】',
    '{',
    schema.join(',\n'),
    '}',
    '',
    '【严格要求】',
    '- word/exampleEn/sentenceEn 等英文片段必须**逐字复制**自源材料，禁止改写或编造',
    '- sentenceCn/aiReferenceCn 为中文翻译，可基于学术常识给出',
    '- scoring_points 是判分用的踩分点清单，每条一句话，聚焦逻辑关系（因果/转折/递进/让步等）与关键术语词汇，不要泛泛而谈',
    ...translationRules,
    '- 源材料未涉及的字段用 [NOT_IN_SOURCE] <字段名> 标注',
    '- 输出语言：word / definitionEn / exampleEn 这些字段用英文（exampleEn 必须逐字来自原文），meaning / definitionCn / exampleZh / 译文 / 踩分点用中文',
    '- morphemes 是词根词缀切分：各段 text 按顺序拼起来必须正好等于 word（一个字母都不能差）；拆不出就给空数组 []，**不要硬拆**；type 取 prefix/root/suffix/connective（connective = 连接元音，如 photocatalysis 里的 o、i）',
  )
  return lines.join('\n')
}

/**
 * 依据文献摘要元数据构造翻译题。
 * 题面与参考答案优先取自 abstractEn/abstractCn，AI 只提供踩分点。
 *
 * 只靠 DOI 元数据入库的文献通常**只有英文摘要**（Crossref / OpenAlex 都不给中文），
 * 这种时候不能让整道题消失 —— 用户要的是"有摘要就有摘要题"。
 * 所以缺失的那一边由 AI 在 reference_translation 里补一份参考译文（referenceOverride），
 * 该方向照常出题；题面缺失的方向（比如没有中文摘要就出不了中译英）直接跳过。
 */
export function buildTranslationItems(
  lit: Literature,
  pointsByDirection: Partial<Record<TranslationDirection, string[]>>,
  now: number,
  idPrefix: string,
  referenceOverride?: Partial<Record<TranslationDirection, string>>,
): TranslationData[] {
  const en = (lit.abstractEn || '').trim()
  const cn = (lit.abstractCn || '').trim()
  const make = (direction: TranslationDirection, originalText: string, referenceTranslation: string, seq: number): TranslationData => ({
    id: `${idPrefix}${now}_${seq}_${Math.random().toString(36).slice(2, 6)}`,
    originalText,
    direction,
    referenceTranslation,
    scoringPoints: pointsByDirection[direction] || [],
    sourceKind: 'abstract',
    sourceDoi: lit.doi,
    latestUserTranslation: '',
    latestAiFeedback: '',
    latestErrorWords: '',
    status: 'pending',
    addedAt: now,
    lastPractice: 0,
    practiceCount: 0,
  })
  const out: TranslationData[] = []
  let seq = 0
  // 英译中：题面必须英文；参考答案优先中文摘要，缺了就用 AI 补的参考译文
  if (en) {
    const ref = cn || (referenceOverride?.en2cn || '').trim()
    if (ref) out.push(make('en2cn', en, ref, seq++))
  }
  // 中译英：题面必须中文；参考答案优先英文摘要，缺了就用 AI 补的参考译文
  if (cn) {
    const ref = en || (referenceOverride?.cn2en || '').trim()
    if (ref) out.push(make('cn2en', cn, ref, seq++))
  }
  return out
}
