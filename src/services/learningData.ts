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
  word: string
  phonetic: string
  meaning: string
  exampleEn: string
  exampleZh: string
  root: string
  sourceDoi: string
  status: WordStatus
  addedAt: number
  lastReview: number
  reviewCount: number
  sm2Interval: number
  sm2Ease: number
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
  'review_count', 'sm2_interval', 'sm2_ease',
]

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
      return rows.slice(1).map((r, i) => ({
        id: String(i + 1),
        word: r[0] || '',
        phonetic: r[2] || '',
        meaning: r[3] || '',
        exampleEn: r[5] || '',
        exampleZh: r[1] || '',
        root: r[6] || '',
        sourceDoi: r[7] || '',
        status: (r[8] as WordStatus) || 'new',
        addedAt: parseInt(r[9] || '0', 10),
        lastReview: parseInt(r[10] || '0', 10),
        reviewCount: parseInt(r[11] || '0', 10),
        sm2Interval: parseFloat(r[12] || '0'),
        sm2Ease: parseFloat(r[13] || '2.5'),
      }))
    },
    force,
  )
}

export async function saveWords(words: WordData[]): Promise<void> {
  await writeCsvFile(
    VOCAB_PATH,
    words,
    VOCAB_HEADERS,
    (w) => [
      w.word,
      w.exampleZh,
      w.phonetic,
      w.meaning,
      '',
      w.exampleEn,
      w.root,
      w.sourceDoi,
      w.status,
      String(w.addedAt),
      String(w.lastReview),
      String(w.reviewCount),
      String(w.sm2Interval),
      String(w.sm2Ease),
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
