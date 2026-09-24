/**
 * 学习进度服务 — GitHub 私库持久化
 * -------------------------------------------------
 * SPEC §0/§1.2：所有用户数据存 GitHub 私库，只允许 md/csv 落盘。
 * 学习进度（当前题号、学习统计等）存 settings/learning_progress.md。
 *
 * 不经过 localStorage / IndexedDB，直接读写 GitHub 私库。
 * 内存缓存 + 防抖写入，避免频繁 API 调用。
 */
import { readMdFile, writeMdFile } from './userData'

const PROGRESS_PATH = 'settings/learning_progress.md'

export interface LearningProgress {
  activeTab?: string
  wordCurrentIndex?: number
  wordCurrentId?: string | null
  wordCurrentType?: string
  wordRandomMode?: boolean
  wordEnabledTypes?: string[]
  // 新版 CAT 式单词学习设置
  wordQueueLength?: number
  /** 掌握条件：走满多少轮算掌握（旧字段 wordMasterCount 是"连续答对次数"，语义已改） */
  wordMasterRounds?: number
  wordQuestionTypes?: string[]
  wordAllowZhan?: boolean
  wordVoiceEnabled?: boolean
  sentenceCurrentIndex?: number
  translationCurrentIndex?: number
  todayLearned?: string[]
  totalLearned?: string[]
  lastStudyDate?: string
}

// ============================================================
// 内存缓存 + 防抖写入
// ============================================================

let progressCache: LearningProgress = {}
let progressPromise: Promise<LearningProgress> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
const SAVE_DEBOUNCE_MS = 2000

/**
 * 加载学习进度（全局共享单次加载，多次调用返回同一 Promise）。
 * 首次调用从 GitHub 私库读取；后续调用返回缓存。
 */
export function loadProgress(): Promise<LearningProgress> {
  if (!progressPromise) {
    progressPromise = (async () => {
      try {
        const doc = await readMdFile(PROGRESS_PATH)
        if (doc?.content) {
          progressCache = parseProgressMd(doc.content)
        }
      } catch (err) {
        console.warn('[learningProgress] 读取失败，使用空进度:', err)
      }
      return progressCache
    })()
  }
  return progressPromise
}

/**
 * 更新学习进度（合并到缓存，防抖写入 GitHub 私库）。
 */
export function updateProgress(patch: Partial<LearningProgress>): void {
  progressCache = { ...progressCache, ...patch }

  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    saveTimer = null
    try {
      const md = serializeProgressMd(progressCache)
      await writeMdFile(PROGRESS_PATH, md, 'Update learning progress')
    } catch (err) {
      console.error('[learningProgress] 保存失败:', err)
    }
  }, SAVE_DEBOUNCE_MS)
}

// ============================================================
// Markdown 解析 / 序列化
// ============================================================

function parseProgressMd(md: string): LearningProgress {
  const result: LearningProgress = {}
  const lines = md.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('- ')) continue
    const content = trimmed.slice(2)
    const colonIdx = content.indexOf(': ')
    if (colonIdx < 0) continue
    const key = content.slice(0, colonIdx).trim()
    const value = content.slice(colonIdx + 2).trim()

    switch (key) {
      case 'active_tab':
        result.activeTab = value || undefined
        break
      case 'word_current_index':
        result.wordCurrentIndex = parseInt(value, 10) || 0
        break
      case 'word_current_id':
        result.wordCurrentId = value || null
        break
      case 'word_current_type':
        result.wordCurrentType = value || undefined
        break
      case 'word_random_mode':
        result.wordRandomMode = value === 'true'
        break
      case 'word_enabled_types':
        result.wordEnabledTypes = value ? value.split(',').filter(Boolean) : []
        break
      // 新版 CAT 式单词学习设置 —— 以前只写不读回，导致刷新后用户设置丢失，这里补齐解析
      case 'word_queue_length':
        result.wordQueueLength = parseInt(value, 10) || 0
        break
      case 'word_master_rounds':
        result.wordMasterRounds = parseInt(value, 10) || 0
        break
      case 'word_question_types':
        result.wordQuestionTypes = value ? value.split(',').filter(Boolean) : []
        break
      case 'word_allow_zhan':
        result.wordAllowZhan = value === 'true'
        break
      case 'word_voice_enabled':
        result.wordVoiceEnabled = value === 'true'
        break
      case 'sentence_current_index':
        result.sentenceCurrentIndex = parseInt(value, 10) || 0
        break
      case 'translation_current_index':
        result.translationCurrentIndex = parseInt(value, 10) || 0
        break
      case 'today_learned':
        result.todayLearned = value ? value.split(',').filter(Boolean) : []
        break
      case 'total_learned':
        result.totalLearned = value ? value.split(',').filter(Boolean) : []
        break
      case 'last_study_date':
        result.lastStudyDate = value || undefined
        break
    }
  }
  return result
}

function serializeProgressMd(p: LearningProgress): string {
  const lines: string[] = ['# 学习进度', '']
  if (p.activeTab !== undefined) lines.push(`- active_tab: ${p.activeTab}`)
  if (p.wordCurrentIndex !== undefined) lines.push(`- word_current_index: ${p.wordCurrentIndex}`)
  if (p.wordCurrentId !== undefined) lines.push(`- word_current_id: ${p.wordCurrentId ?? ''}`)
  if (p.wordCurrentType !== undefined) lines.push(`- word_current_type: ${p.wordCurrentType}`)
  if (p.wordRandomMode !== undefined) lines.push(`- word_random_mode: ${p.wordRandomMode}`)
  if (p.wordEnabledTypes !== undefined) lines.push(`- word_enabled_types: ${p.wordEnabledTypes.join(',')}`)
  // 新版 CAT 式单词学习设置 —— 之前漏写，导致刷新后 WordSection 的设置在重新加载时丢失
  if (p.wordQueueLength !== undefined) lines.push(`- word_queue_length: ${p.wordQueueLength}`)
  if (p.wordMasterRounds !== undefined) lines.push(`- word_master_rounds: ${p.wordMasterRounds}`)
  if (p.wordQuestionTypes !== undefined) lines.push(`- word_question_types: ${p.wordQuestionTypes.join(',')}`)
  if (p.wordAllowZhan !== undefined) lines.push(`- word_allow_zhan: ${p.wordAllowZhan}`)
  if (p.wordVoiceEnabled !== undefined) lines.push(`- word_voice_enabled: ${p.wordVoiceEnabled}`)
  if (p.sentenceCurrentIndex !== undefined) lines.push(`- sentence_current_index: ${p.sentenceCurrentIndex}`)
  if (p.translationCurrentIndex !== undefined) lines.push(`- translation_current_index: ${p.translationCurrentIndex}`)
  if (p.todayLearned !== undefined) lines.push(`- today_learned: ${p.todayLearned.join(',')}`)
  if (p.totalLearned !== undefined) lines.push(`- total_learned: ${p.totalLearned.join(',')}`)
  if (p.lastStudyDate !== undefined) lines.push(`- last_study_date: ${p.lastStudyDate}`)
  return lines.join('\n') + '\n'
}
