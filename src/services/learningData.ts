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
export type SentenceStatus = 'new' | 'learning' | 'mastered'
export type TranslationStatus = 'pending' | 'completed'

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
  /**
   * 例句中文译文（仅内存/AI 生成时携带；vocabulary.csv 无此列，不落盘，
   * 仅用于单词卡展示）
   */
  exampleZh?: string
  sourceDoi: string
  status: WordStatus
  addedAt: number
  lastReview: number
  reviewCount: number
  sm2Interval: number
  sm2Ease: number
  /** 连续答对次数（CAT 掌握条件：达到 master_count 即 mastered） */
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
}

export interface TranslationData {
  id: string
  originalText: string
  sourceDoi: string
  latestUserTranslation: string
  latestAiFeedback: string
  latestErrorWords: string
  status: TranslationStatus
  addedAt: number
  lastPractice: number
  practiceCount: number
}

const VOCAB_PATH = 'vocabulary/vocabulary.csv'
const SENTENCES_PATH = 'sentences/sentences.csv'
const TRANSLATION_PATH = 'translation_practice/translation_practice.csv'

const VOCAB_HEADERS = [
  'word_en', 'word_cn', 'phonetic', 'definition_cn', 'definition_en',
  'example_context', 'source_doi', 'status', 'added_at', 'last_review',
  'review_count', 'sm2_interval', 'sm2_ease', 'wrong_count', 'streak',
]

const VALID_WORD_STATUS = new Set(['new', 'learning', 'learned', 'mastered', 'error_book'])

const SENTENCE_HEADERS = [
  'id', 'sentence_en', 'sentence_cn', 'ai_reference_cn', 'source_doi',
  'status', 'added_at', 'last_review', 'review_count', 'sm2_interval', 'sm2_ease',
]

const TRANSLATION_HEADERS = [
  'id', 'original_text', 'source_doi', 'latest_user_translation',
  'latest_ai_feedback', 'latest_error_words', 'status', 'added_at',
  'last_practice', 'practice_count',
]

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
            exampleZh: undefined as string | undefined,
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
    // 严格 15 列、按表头顺序；exampleZh 是纯内存字段不落盘
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
    ],
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
      return rows.slice(1).map((r) => ({
        id: r[0] || '',
        sentenceEn: r[1] || '',
        sentenceCn: r[2] || '',
        aiReferenceCn: r[3] || '',
        sourceDoi: r[4] || '',
        status: (r[5] as SentenceStatus) || 'new',
        addedAt: parseInt(r[6] || '0', 10),
        lastReview: parseInt(r[7] || '0', 10),
        reviewCount: parseInt(r[8] || '0', 10),
        sm2Interval: parseFloat(r[9] || '0'),
        sm2Ease: parseFloat(r[10] || '2.5'),
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
      return rows.slice(1).map((r) => ({
        id: r[0] || '',
        originalText: r[1] || '',
        sourceDoi: r[2] || '',
        latestUserTranslation: r[3] || '',
        latestAiFeedback: r[4] || '',
        latestErrorWords: r[5] || '',
        status: (r[6] as TranslationStatus) || 'pending',
        addedAt: parseInt(r[7] || '0', 10),
        lastPractice: parseInt(r[8] || '0', 10),
        practiceCount: parseInt(r[9] || '0', 10),
      }))
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
      t.latestUserTranslation,
      t.latestAiFeedback,
      t.latestErrorWords,
      t.status,
      String(t.addedAt),
      String(t.lastPractice),
      String(t.practiceCount),
    ],
  )
}
