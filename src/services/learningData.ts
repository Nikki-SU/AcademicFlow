/**
 * 学习数据服务（单词/长难句/翻译练习）
 * -------------------------------------------------
 * SPEC §4.2 / §4.3 / §4.4：所有学习数据存 GitHub 私库 CSV。
 * - vocabulary/vocabulary.csv
 * - sentences/sentences.csv
 * - translation_practice/translation_practice.csv
 *
 * 间隔重复算法：SM-2（SPEC §4.2 / §5.6.1）
 */

import { readCsvFile, writeCsvFile } from './userData'

export type WordStatus = 'new' | 'learning' | 'learned' | 'mastered' | 'error_book'

/** 词素类型：前缀 / 词根 / 后缀 / 连接成分（如 photocatalysis 里的 o、i） */
export type MorphemeType = 'prefix' | 'root' | 'suffix' | 'connective'

/** 展示用的词素类型中文名 */
export const MORPHEME_TYPE_LABELS: Record<MorphemeType, string> = {
  prefix: '前缀',
  root: '词根',
  suffix: '后缀',
  connective: '连接',
}

/**
 * 一个词素片段 —— 单词按词根词缀切分后的最小单位。
 * 约束：同一单词的 morphemes 按顺序把 text 拼起来必须正好等于该单词（大小写不敏感）。
 */
export interface Morpheme {
  /** 原词中连续的一段 */
  text: string
  type: MorphemeType
  /** 中文含义，如 "光" / "合成" */
  meaning: string
}

/**
 * 词素表（vocabulary/affixes.csv）的一行 —— 全词库词素的去重汇总。
 * 用途：拼写题的干扰块池（不限于本组词），以及单词自身没带含义时的兜底。
 * 它是**派生索引**：含义以单词切分为准，人工修改请改单词那一侧。
 */
export interface AffixData {
  affix: string
  type: MorphemeType
  meaning: string
}

export type SentenceStatus = 'new' | 'learning' | 'mastered'
export type TranslationStatus = 'pending' | 'completed'
/** 翻译方向：en2cn = 英译中；cn2en = 中译英 */
export type TranslationDirection = 'en2cn' | 'cn2en'
/** 题面来源：abstract = 文献摘要；text = 正文/任意文本 */
export type TranslationSourceKind = 'abstract' | 'text'

export interface WordData {
  id: string
  /** word_en：英文单词 */
  word: string
  /** word_cn：中文释义（短词，选择题答案用） */
  meaning: string
  phonetic: string
  /** definition_cn：中文详细定义（"定义"类题型用） */
  definitionCn: string
  /** definition_en：英文定义（复习模式的定义题用，缺失时回退中文定义） */
  definitionEn: string
  /** example_context：原文例句（例句挖空题用） */
  exampleEn: string
  /** example_zh：例句的中文译文（单词卡上跟英文例句成对显示） */
  exampleZh?: string
  /**
   * morphemes：词根词缀切分。空数组 = 拆不出值得学的词缀（或用户清空）——
   * 此时展示卡片不拆、拼写题退化成**单字母块**。**不要硬拆**。
   */
  morphemes: Morpheme[]
  sourceDoi: string
  status: WordStatus
  addedAt: number
  lastReview: number
  /** 已走完的轮数（一轮 = 把选中的题型各答对一遍）；走满设置的轮数即 mastered */
  reviewCount: number
  sm2Interval: number
  sm2Ease: number
  /** 连续答对次数（答错清零）。只作统计用 —— 是否掌握看 reviewCount 走满了几轮 */
  streak: number
  /** 累计答错次数（>=3 进错词本） */
  wrongCount: number
}

export interface SentenceData {
  id: string
  sentenceEn: string
  sentenceCn: string
  aiReferenceCn: string
  sourceDoi: string
  status: SentenceStatus
  addedAt: number
  lastReview: number
  reviewCount: number
  sm2Interval: number
  sm2Ease: number
  /** 踩分点（判分标准，主要是逻辑关系与词汇）；AI 提取时生成，用户可事后编辑 */
  scoringPoints: string[]
  /** AI 说明这句"难"在哪（可选，仅用于展示） */
  difficultyNote?: string
  /** 以下练习记录字段与 TranslationData 对称：让长难句也能作答 + 判分 */
  latestUserTranslation: string
  latestAiFeedback: string
  latestErrorWords: string
  practiceCount: number
  lastPractice: number
}

export interface TranslationData {
  id: string
  /** 题面原文：按方向是英文（en2cn）或中文（cn2en） */
  originalText: string
  /** 翻译方向（必须落库） */
  direction: TranslationDirection
  /** 预置参考答案 */
  referenceTranslation: string
  /** 踩分点（判分标准） */
  scoringPoints: string[]
  /** 题面来自摘要还是正文 */
  sourceKind: TranslationSourceKind
  sourceDoi: string
  /** 用户最近一次作答（语义已从"人工参考译文"拆出来） */
  latestUserTranslation: string
  latestAiFeedback: string
  latestErrorWords: string
  status: TranslationStatus
  addedAt: number
  lastPractice: number
  practiceCount: number
}

const VOCAB_PATH = 'vocabulary/vocabulary.csv'
const AFFIX_PATH = 'vocabulary/affixes.csv'
const SENTENCES_PATH = 'sentences/sentences.csv'
const TRANSLATION_PATH = 'translation_practice/translation_practice.csv'

const VOCAB_HEADERS = [
  'word_en', 'word_cn', 'phonetic', 'definition_cn', 'definition_en',
  'example_context', 'source_doi', 'status', 'added_at', 'last_review',
  'review_count', 'sm2_interval', 'sm2_ease', 'wrong_count', 'streak',
  // 新增列一律追加在末尾（旧行缺列给安全默认）：
  //   example_zh —— 例句的中文译文。单词卡要「英文例句 + 中文例句」成对，
  //   只放内存里的话一刷新就没了。
  'example_zh',
  //   morphemes —— 词根词缀切分（JSON 数组，元素 {text,type,meaning}）。
  //   必须与 .github/scripts/paper_convert.mjs 的 VOCAB_HEADERS 完全一致、顺序也一致。
  'morphemes',
]

const VALID_WORD_STATUS = new Set(['new', 'learning', 'learned', 'mastered', 'error_book'])

const SENTENCE_HEADERS = [
  'id', 'sentence_en', 'sentence_cn', 'ai_reference_cn', 'source_doi',
  'status', 'added_at', 'last_review', 'review_count', 'sm2_interval', 'sm2_ease',
  // 以下为新增列，一律追加在末尾，保证旧行按列索引读取不错位（缺列给安全默认）
  'scoring_points', 'difficulty_note',
  'latest_user_translation', 'latest_ai_feedback', 'latest_error_words',
  'practice_count', 'last_practice',
]

const TRANSLATION_HEADERS = [
  'id', 'original_text', 'source_doi', 'latest_user_translation',
  'latest_ai_feedback', 'latest_error_words', 'status', 'added_at',
  'last_practice', 'practice_count',
  // 新增列一律追加在末尾：direction / reference_translation / scoring_points / source_kind
  'direction', 'reference_translation', 'scoring_points', 'source_kind',
]

/**
 * 解析踩分点列（CSV 里是 JSON 数组字符串）。
 * 容错：空值 / 坏 JSON / 非数组一律返回 []，绝不抛错（旧行没有该列）。
 */
function parseScoringPoints(raw: string | undefined): string[] {
  const t = (raw || '').trim()
  if (!t) return []
  try {
    const arr = JSON.parse(t)
    if (Array.isArray(arr)) {
      return arr.map((x) => String(x).trim()).filter(Boolean)
    }
  } catch {
    // 坏 JSON：当作没有踩分点
  }
  return []
}

/** 序列化踩分点 → JSON 数组字符串（保证与 parseScoringPoints 往返一致） */
function serializeScoringPoints(points: string[] | undefined): string {
  const list = (points || []).map((s) => String(s)).filter((s) => s.trim())
  return JSON.stringify(list)
}

const VALID_MORPHEME_TYPES = new Set<MorphemeType>(['prefix', 'root', 'suffix', 'connective'])

function normalizeMorphemeType(raw: unknown): MorphemeType {
  const t = String(raw ?? '').trim().toLowerCase()
  return VALID_MORPHEME_TYPES.has(t as MorphemeType) ? (t as MorphemeType) : 'root'
}

/**
 * 解析 morphemes 列（CSV 里是 JSON 数组字符串）。
 * 容错：空值 / 坏 JSON / 非数组一律返回 []（旧行没有该列），绝不抛错。
 * 只做形状清洗，不校验"拼起来是否等于单词" —— 那是写入侧（AI/人工）的责任，
 * 读取侧一旦发现对不上就整组丢弃（见 isValidMorphemeSplit）。
 */
export function parseMorphemes(raw: string | undefined): Morpheme[] {
  const t = (raw || '').trim()
  if (!t) return []
  try {
    const arr = JSON.parse(t)
    if (!Array.isArray(arr)) return []
    return arr
      .map((x) => {
        if (typeof x === 'string') {
          const text = x.trim()
          return text ? { text, type: 'root' as MorphemeType, meaning: '' } : null
        }
        if (!x || typeof x !== 'object') return null
        const o = x as Record<string, unknown>
        const text = String(o.text ?? o.m ?? '').trim()
        if (!text) return null
        return {
          text,
          type: normalizeMorphemeType(o.type),
          meaning: String(o.meaning ?? '').trim(),
        }
      })
      .filter((m): m is Morpheme => m !== null)
  } catch {
    return []
  }
}

/** 序列化词素切分 → JSON 数组字符串（空数组写空串，与 parseMorphemes 往返一致） */
export function serializeMorphemes(morphemes: Morpheme[] | undefined): string {
  const list = (morphemes || [])
    .map((m) => ({
      text: String(m?.text ?? '').trim(),
      type: normalizeMorphemeType(m?.type),
      meaning: String(m?.meaning ?? '').trim(),
    }))
    .filter((m) => m.text)
  return list.length ? JSON.stringify(list) : ''
}

/**
 * 校验一组切分是否真的能把单词拼回来。
 * 拼不回来的切分是脏数据：展示会缺字母、拼写题会永远答不对，一律当作"没切分"。
 */
export function isValidMorphemeSplit(word: string, morphemes: Morpheme[] | undefined): boolean {
  const list = morphemes || []
  if (list.length < 2) return false
  return list.map((m) => m.text).join('').toLowerCase() === String(word || '').trim().toLowerCase()
}

/**
 * SM-2 间隔重复算法（简化版）
 * -------------------------------------------------
 * SPEC §4.2 / §5.6.1：基于 SM-2 的间隔重复。
 *
 * 参数：
 * - easeFactor: 简易因子，默认 2.5，下限 1.3
 * - interval: 距下次复习的间隔（天）
 * - repetitions: 连续答对次数（内部状态，由 review_count 和 status 推导）
 * - quality: 答题质量 0-5 分
 *
 * 返回：{ easeFactor, interval, repetitions, status }
 */
export interface Sm2Result {
  easeFactor: number
  interval: number
  repetitions: number
  status: WordStatus
}

export function calcSm2(
  prevEase: number,
  prevInterval: number,
  prevRepetitions: number,
  quality: number,
): Sm2Result {
  const DEFAULT_EASE = 2.5
  const MIN_EASE = 1.3
  const ease = prevEase || DEFAULT_EASE

  if (quality < 3) {
    // 答错：重置间隔，easy factor 也会略微下降
    const newEase = Math.max(MIN_EASE, ease - 0.2)
    return {
      easeFactor: newEase,
      interval: 1,
      repetitions: 0,
      status: 'learning',
    }
  }

  // 答对
  let newRepetitions = prevRepetitions + 1
  let newInterval: number

  if (newRepetitions === 1) {
    newInterval = 1
  } else if (newRepetitions === 2) {
    newInterval = 6
  } else {
    newInterval = Math.round(prevInterval * ease)
  }

  // 更新 ease factor
  const newEase = Math.max(
    MIN_EASE,
    ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)),
  )

  let status: WordStatus = 'learning'
  if (newRepetitions >= 5) {
    status = 'mastered'
  } else if (newRepetitions >= 2) {
    status = 'learned'
  }

  return {
    easeFactor: newEase,
    interval: newInterval,
    repetitions: newRepetitions,
    status,
  }
}

/** 从 word 的 reviewCount 和 status 估算连续答对次数 */
export function estimateRepetitions(word: WordData): number {
  if (word.status === 'mastered') return 5
  if (word.status === 'learned') return 2
  if (word.status === 'learning') return 1
  return 0
}

// ============================================================
// 词汇
// ============================================================

export async function loadWords(force = false): Promise<WordData[]> {
  return readCsvFile(
    VOCAB_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      // 表头感知：新格式 15 列（含 wrong_count/streak）；
      // 旧格式 13 列表头，但历史行可能带 14 个值（尾部多一个重复 ease）
      const header = rows[0].map((h) => (h || '').trim())
      const hasNewCols = header.includes('wrong_count')
      return rows.slice(1)
        .filter((r) => (r[0] || '').trim())
        .map((r, i) => {
          const num = (s: string | undefined, d = 0) => {
            const n = parseInt(s || '', 10)
            return Number.isFinite(n) ? n : d
          }
          const base = {
            id: String(i + 1),
            word: r[0] || '',
            phonetic: r[2] || '',
            exampleZh: (r[15] || '').trim() || undefined,
            // 词素切分只认正常行（历史脏数据行列位整体错位，读出来必然对不上）
            morphemes: [] as Morpheme[],
          }
          const s7 = (r[7] || '').trim()
          const s8 = (r[8] || '').trim()

          // 历史脏数据 A：双 status 行 —— r7、r8 都是合法 status（如 new,learning）。
          // 某旧版写入时多塞了一个 status，r8 是较新状态，其后各列整体左移一位。
          if (!hasNewCols && VALID_WORD_STATUS.has(s7) && VALID_WORD_STATUS.has(s8)) {
            return {
              ...base,
              meaning: r[1] || '',
              definitionCn: r[3] || '',
              definitionEn: r[4] || '',
              exampleEn: r[5] || '',
              sourceDoi: r[6] || '',
              status: s8 as WordStatus,
              addedAt: num(r[9]) || num(r[10]),
              lastReview: num(r[10]),
              reviewCount: num(r[11]),
              sm2Interval: parseFloat(r[12] || '1') || 1,
              sm2Ease: parseFloat(r[13] || '2.5') || 2.5,
              streak: 0,
              wrongCount: 0,
            }
          }

          // 历史脏数据 B：b6c2768 版 saveWords 多写了 exampleZh/root 两列，
          // 导致 source_doi 落在 r7、status 落在 r8（整行右移）。
          if (!hasNewCols && !VALID_WORD_STATUS.has(s7) && VALID_WORD_STATUS.has(s8)) {
            return {
              ...base,
              meaning: r[1] || r[3] || '',
              definitionCn: r[3] || '',
              definitionEn: r[4] || '',
              exampleEn: r[5] || '',
              sourceDoi: r[7] || r[6] || '',
              status: (s8 || 'new') as WordStatus,
              addedAt: num(r[9]) || num(r[10]),
              lastReview: num(r[10]),
              reviewCount: num(r[11]),
              sm2Interval: parseFloat(r[12] || '1') || 1,
              sm2Ease: parseFloat(r[13] || '2.5') || 2.5,
              streak: 0,
              wrongCount: 0,
            }
          }

          // 正常行：新 15 列；或旧 13 列表头 + 13/14 值行
          // （旧 14 值行 r13 是重复的 sm2_ease，不是 wrong_count，必须忽略）
          return {
            ...base,
            meaning: r[1] || '',
            definitionCn: r[3] || '',
            definitionEn: r[4] || '',
            exampleEn: r[5] || '',
            sourceDoi: r[6] || '',
            status: (s7 || 'new') as WordStatus,
            addedAt: num(r[8]),
            lastReview: num(r[9]),
            reviewCount: num(r[10]),
            sm2Interval: parseFloat(r[11] || '1') || 1,
            sm2Ease: parseFloat(r[12] || '2.5') || 2.5,
            wrongCount: hasNewCols ? num(r[13]) : 0,
            streak: hasNewCols ? num(r[14]) : 0,
            morphemes: parseMorphemes(r[16]),
          }
        })
    },
    force,
  )
}

export async function saveWords(words: WordData[]): Promise<void> {
  await writeCsvFile(
    VOCAB_PATH,
    words,
    VOCAB_HEADERS,
    // 严格 17 列、按表头顺序
    (w) => [
      w.word,
      w.meaning,
      w.phonetic,
      w.definitionCn,
      w.definitionEn,
      w.exampleEn,
      w.sourceDoi,
      w.status,
      String(w.addedAt),
      String(w.lastReview),
      String(w.reviewCount),
      String(w.sm2Interval),
      String(w.sm2Ease),
      String(w.wrongCount),
      String(w.streak),
      w.exampleZh || '',
      serializeMorphemes(w.morphemes),
    ],
  )
}

// ============================================================
// 词素表（词根词缀）
// ============================================================

/**
 * 读词素表。文件不存在（老仓库还没生成过）时返回 []，不抛错 ——
 * 词素表只是拼写题的干扰块池，缺了不影响主流程。
 *
 * 写入方只有后端 runner（.github/scripts/paper_convert.mjs）：它按词库切分去重汇总，
 * 已存在的行一律不动（人工改过的含义不会被下次跑批覆盖）。前端只读、不写，
 * 免得把表重算成"只有当前这批词"的子集。
 */
export async function loadAffixes(force = false): Promise<AffixData[]> {
  return readCsvFile(
    AFFIX_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      return rows.slice(1)
        .map((r) => ({
          affix: (r[0] || '').trim(),
          type: normalizeMorphemeType(r[1]),
          meaning: (r[2] || '').trim(),
        }))
        .filter((a) => a.affix)
    },
    force,
  )
}

// ============================================================
// 长难句
// ============================================================

export async function loadSentences(force = false): Promise<SentenceData[]> {
  return readCsvFile(
    SENTENCES_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      // 表头感知：旧格式无 scoring_points 列，新列一律在末尾，缺列时 r[n] 为 undefined → 安全默认
      return rows.slice(1).map((r) => ({
        id: r[0] || '',
        sentenceEn: r[1] || '',
        sentenceCn: r[2] || '',
        aiReferenceCn: r[3] || '',
        sourceDoi: r[4] || '',
        status: (r[5] as SentenceStatus) || 'new',
        addedAt: parseInt(r[6] || '0', 10) || 0,
        lastReview: parseInt(r[7] || '0', 10) || 0,
        reviewCount: parseInt(r[8] || '0', 10) || 0,
        sm2Interval: parseFloat(r[9] || '0') || 0,
        sm2Ease: parseFloat(r[10] || '2.5') || 2.5,
        scoringPoints: parseScoringPoints(r[11]),
        difficultyNote: (r[12] || '').trim() || undefined,
        latestUserTranslation: r[13] || '',
        latestAiFeedback: r[14] || '',
        latestErrorWords: r[15] || '',
        practiceCount: parseInt(r[16] || '0', 10) || 0,
        lastPractice: parseInt(r[17] || '0', 10) || 0,
      }))
    },
    force,
  )
}

export async function saveSentences(sentences: SentenceData[]): Promise<void> {
  await writeCsvFile(
    SENTENCES_PATH,
    sentences,
    SENTENCE_HEADERS,
    (s) => [
      s.id,
      s.sentenceEn,
      s.sentenceCn,
      s.aiReferenceCn,
      s.sourceDoi,
      s.status,
      String(s.addedAt),
      String(s.lastReview),
      String(s.reviewCount),
      String(s.sm2Interval),
      String(s.sm2Ease),
      serializeScoringPoints(s.scoringPoints),
      s.difficultyNote || '',
      s.latestUserTranslation || '',
      s.latestAiFeedback || '',
      s.latestErrorWords || '',
      String(s.practiceCount || 0),
      String(s.lastPractice || 0),
    ],
  )
}

// ============================================================
// 翻译练习
// ============================================================

export async function loadTranslations(force = false): Promise<TranslationData[]> {
  return readCsvFile(
    TRANSLATION_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      const header = rows[0].map((h) => (h || '').trim())
      // 表头感知：新格式已含 reference_translation 列；旧格式没有（新列在末尾，缺列 r[n]=undefined）
      const hasNewCols = header.includes('reference_translation')
      return rows.slice(1).map((r) => {
        let latestUserTranslation = r[3] || ''
        let referenceTranslation = r[11] || ''

        // 历史包袱迁移：旧版 AddTranslationModal 把用户手填的"参考译文"直接写进了
        // latest_user_translation（当时既没有 reference_translation 列，也没有"用户作答"语义）。
        // 遇旧行（无新增列）且 reference_translation 为空而 latest_user_translation 非空时，
        // 把这份人工答案搬回 referenceTranslation 并清空 latestUserTranslation；
        // 下次保存会把迁移结果写回新列，从而完成一次性迁移。
        if (!hasNewCols && !referenceTranslation.trim() && latestUserTranslation.trim()) {
          referenceTranslation = latestUserTranslation
          latestUserTranslation = ''
        }

        const rawDir = (r[10] || '').trim()
        const rawKind = (r[13] || '').trim()
        return {
          id: r[0] || '',
          originalText: r[1] || '',
          sourceDoi: r[2] || '',
          latestUserTranslation,
          latestAiFeedback: r[4] || '',
          latestErrorWords: r[5] || '',
          status: (r[6] as TranslationStatus) || 'pending',
          addedAt: parseInt(r[7] || '0', 10) || 0,
          lastPractice: parseInt(r[8] || '0', 10) || 0,
          practiceCount: parseInt(r[9] || '0', 10) || 0,
          direction: (rawDir === 'cn2en' ? 'cn2en' : 'en2cn') as TranslationDirection,
          referenceTranslation,
          scoringPoints: parseScoringPoints(r[12]),
          sourceKind: (rawKind === 'text' ? 'text' : 'abstract') as TranslationSourceKind,
        }
      })
    },
    force,
  )
}

export async function saveTranslations(translations: TranslationData[]): Promise<void> {
  await writeCsvFile(
    TRANSLATION_PATH,
    translations,
    TRANSLATION_HEADERS,
    (t) => [
      t.id,
      t.originalText,
      t.sourceDoi,
      t.latestUserTranslation || '',
      t.latestAiFeedback || '',
      t.latestErrorWords || '',
      t.status,
      String(t.addedAt),
      String(t.lastPractice),
      String(t.practiceCount),
      t.direction,
      t.referenceTranslation || '',
      serializeScoringPoints(t.scoringPoints),
      t.sourceKind,
    ],
  )
}
