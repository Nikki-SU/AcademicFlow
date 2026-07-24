/**
 * 学习数据服务（单词/长难句/翻译练习）
 * -------------------------------------------------
 * 所有学习数据存储在 GitHub 私库的对应 CSV 文件中：
 * - vocabulary/vocabulary.csv
 * - sentences/sentences.csv
 * - translation_practice/translation_practice.csv
 *
 * 不经过 localStorage，直接读写 GitHub 私库 CSV。
 */

import { readCsvFile, writeCsvFile } from './userData'

export interface WordData {
  id: string
  word: string
  phonetic: string
  meaning: string
  exampleEn: string
  exampleZh: string
  root: string
  mastered: boolean
  proficiency: number
  errorCount: number
  lastStudyTime: number
  seenCount: number
}

export interface SentenceData {
  id: string
  en: string
  zh: string
  structure: string
  mastered: boolean
}

export interface TranslationData {
  id: string
  source: string
  reference: string
  mastered: boolean
}

const VOCAB_PATH = 'vocabulary/vocabulary.csv'
const SENTENCES_PATH = 'sentences/sentences.csv'
const TRANSLATION_PATH = 'translation_practice/translation_practice.csv'

const VOCAB_HEADERS = [
  'id', 'word', 'phonetic', 'meaning', 'example_en', 'example_zh',
  'root', 'mastered', 'proficiency', 'error_count', 'last_study_time', 'seen_count',
]

const SENTENCE_HEADERS = ['id', 'en', 'zh', 'structure', 'mastered']
const TRANSLATION_HEADERS = ['id', 'source', 'reference', 'mastered']

export async function loadWords(force = false): Promise<WordData[]> {
  return readCsvFile(
    VOCAB_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      return rows.slice(1).map((r) => ({
        id: r[0] || '',
        word: r[1] || '',
        phonetic: r[2] || '',
        meaning: r[3] || '',
        exampleEn: r[4] || '',
        exampleZh: r[5] || '',
        root: r[6] || '',
        mastered: r[7] === '1',
        proficiency: parseInt(r[8] || '0', 10),
        errorCount: parseInt(r[9] || '0', 10),
        lastStudyTime: parseInt(r[10] || '0', 10),
        seenCount: parseInt(r[11] || '0', 10),
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
      w.id,
      w.word,
      w.phonetic,
      w.meaning,
      w.exampleEn,
      w.exampleZh,
      w.root,
      w.mastered ? '1' : '0',
      String(w.proficiency),
      String(w.errorCount),
      String(w.lastStudyTime),
      String(w.seenCount),
    ],
  )
}

export async function loadSentences(force = false): Promise<SentenceData[]> {
  return readCsvFile(
    SENTENCES_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      return rows.slice(1).map((r) => ({
        id: r[0] || '',
        en: r[1] || '',
        zh: r[2] || '',
        structure: r[3] || '',
        mastered: r[4] === '1',
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
    (s) => [s.id, s.en, s.zh, s.structure, s.mastered ? '1' : '0'],
  )
}

export async function loadTranslations(force = false): Promise<TranslationData[]> {
  return readCsvFile(
    TRANSLATION_PATH,
    (rows) => {
      if (rows.length <= 1) return []
      return rows.slice(1).map((r) => ({
        id: r[0] || '',
        source: r[1] || '',
        reference: r[2] || '',
        mastered: r[3] === '1',
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
    (t) => [t.id, t.source, t.reference, t.mastered ? '1' : '0'],
  )
}
