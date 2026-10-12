/**
 * 学习内容「历史批量补提」—— services 层实现（ADJ-126 版本更新管线的一环）。
 * -------------------------------------------------
 * 此前这是学习页里两个「批量补提历史文献」按钮的手动逻辑。用户要求：更新应**自动走版本更新管线**，
 * 不再让用户手动点按钮（「自动更新包括但不限于学习的数据」）。故把两段补提逻辑搬到 services 层，
 * 由 migrations.ts 的新迁移在数据段升级时调用 —— 页面里不再保留任何手动入口。
 *
 * 补提两类内容（与原先两个按钮完全一致的口径）：
 *   1. 长难句：只处理「已转换出 md」且尚未提取过的文献（正文逐字抽取，依赖 md）。
 *   2. 摘要翻译：处理「有摘要」且尚未出过题的文献（题面/参考答案来自文献元数据，不需要 md）。
 * 生词不在此补提范围内 —— 生词由后端 paper_convert 管线在文献转换时生成（见 version.ts 的 data 段说明）。
 *
 * 严格语义（用户拍板「失败锁页重试」）：AI / 双引擎**未配置**时 `getDualEngineConfig()` 抛可读错误，
 * 迁移随之失败 → 学习页被 MigrationLock 暂时锁定并给出「重试」；用户配置好 AI 后点重试即可续跑
 * （已补提的文献按 sourceDoi 去重跳过，不重复）。
 * 单篇**内容级**失败（AI 未返回可用内容 / 某篇读不到正文）只记警告、不中断整批 ——
 * 否则一篇抽不出内容的文献会把整页永久锁死。
 *
 * prompt / 解析一律复用 learnGeneration 的真源，保证「交互式 AI 生成」与「迁移自动补提」口径逐字一致。
 */

import { loadSentences, saveSentences, loadTranslations, saveTranslations } from './learningData'
import type { SentenceData, TranslationData, TranslationDirection } from './learningData'
import { loadLiteratures, loadAiSourceText } from './literatureData'
import type { Literature } from './literatureData'
import { runDualEngine } from './ai/dual-engine'
import { useSettingsStore } from '../stores/settings'
import {
  buildLearningInstruction,
  parseLearningJSON,
  toStringArray,
  buildTranslationItems,
} from './learnGeneration'

/**
 * 是否还有需要补提的历史文献 —— 供迁移的 detect()（版本号未知时兜底）调用。
 * 只做「数据层面」判断，**不依赖 AI 配置**：探测阶段不该因未配置 AI 就报错，
 * 真正的「未配置 → 迁移失败锁页」发生在 run() 里的 getDualEngineConfig()。
 */
export async function hasLearnBackfillWork(): Promise<boolean> {
  const [literatures, sentences, translations] = await Promise.all([
    loadLiteratures(),
    loadSentences(),
    loadTranslations(),
  ])
  const sentenceDois = new Set(sentences.map((s) => s.sourceDoi).filter(Boolean))
  const translationDois = new Set(translations.map((t) => t.sourceDoi).filter(Boolean))
  const needSentence = literatures.some((l) => l.mdStatus === 'done' && !sentenceDois.has(l.doi))
  const needTranslation = literatures.some(
    (l) => ((l.abstractEn || '').trim() || (l.abstractCn || '').trim()) && !translationDois.has(l.doi),
  )
  return needSentence || needTranslation
}

/** 取双引擎配置 + 生成长难句条数；AI 未配置时抛可读错误（迁移据此失败锁页） */
function resolveGenContext() {
  const s = useSettingsStore.getState()
  const { ai1, ai2 } = s.getDualEngineConfig()
  return { ai1, ai2, sentenceCount: s.sentenceGenCount || 8 }
}

/**
 * 执行历史文献学习内容补提（长难句 + 摘要翻译）。
 * `onProgress(fraction)` 汇报本条迁移内部子进度（0..1），供迁移屏拼总进度条（ADJ-61）。
 */
export async function backfillLearnContent(onProgress?: (fraction: number) => void): Promise<void> {
  const [literatures, sentences, translations] = await Promise.all([
    loadLiteratures(),
    loadSentences(),
    loadTranslations(),
  ])

  const sentenceDois = new Set(sentences.map((s) => s.sourceDoi).filter(Boolean))
  const translationDois = new Set(translations.map((t) => t.sourceDoi).filter(Boolean))
  const sentenceCandidates = literatures.filter((l) => l.mdStatus === 'done' && !sentenceDois.has(l.doi))
  const translationCandidates = literatures.filter(
    (l) => ((l.abstractEn || '').trim() || (l.abstractCn || '').trim()) && !translationDois.has(l.doi),
  )

  const total = sentenceCandidates.length + translationCandidates.length
  if (total === 0) {
    onProgress?.(1)
    return
  }

  let done = 0
  const step = () => {
    done += 1
    onProgress?.(done / total)
  }

  if (sentenceCandidates.length > 0) {
    await backfillSentences(sentenceCandidates, sentences, step)
  }
  if (translationCandidates.length > 0) {
    await backfillTranslations(translationCandidates, translations, step)
  }
}

/** 长难句补提：逐篇读 md 正文 → 双引擎抽取 → 增量落盘（重试时已补提的文献会被去重跳过） */
async function backfillSentences(
  candidates: Literature[],
  existing: SentenceData[],
  step: () => void,
): Promise<void> {
  // AI 未配置 → 抛可读错误 → 迁移失败锁页（严格语义，用户拍板）
  const { ai1, ai2, sentenceCount } = resolveGenContext()
  const instruction = buildLearningInstruction(
    { words: false, sentences: true, translation: false, wordCount: 0, sentenceCount },
    { en: '', cn: '' },
  )

  const all = [...existing]
  for (const lit of candidates) {
    try {
      const sourceMaterial = await loadAiSourceText(lit.doi)
      if (!sourceMaterial.trim()) {
        console.warn(`[learnBackfill] ${lit.doi} 未读到 md 正文，跳过长难句补提`)
        step()
        continue
      }
      const result = await runDualEngine({
        taskType: 'faithfulness_check',
        sourceMaterial,
        ai1Instruction: instruction,
        ai1,
        ai2,
      })
      const parsed = parseLearningJSON(result.ai1Output || '')
      const now = Date.now()
      const newItems: SentenceData[] = parsed.sentences
        .filter((s) => (s.sentenceEn || '').trim())
        .slice(0, sentenceCount)
        .map((s, i) => ({
          id: `ai_${now}_${i}_${Math.random().toString(36).slice(2, 6)}`,
          sentenceEn: s.sentenceEn || '',
          sentenceCn: s.sentenceCn || '',
          aiReferenceCn: s.aiReferenceCn || '',
          sourceDoi: lit.doi,
          status: 'new',
          addedAt: now,
          lastReview: 0,
          reviewCount: 0,
          sm2Interval: 1,
          sm2Ease: 2.5,
          scoringPoints: toStringArray(s.scoring_points),
          difficultyNote: (s.difficulty_note || '').trim() || undefined,
          latestUserTranslation: '',
          latestAiFeedback: '',
          latestErrorWords: '',
          practiceCount: 0,
          lastPractice: 0,
        }))
      if (newItems.length === 0) {
        console.warn(`[learnBackfill] ${lit.doi} AI 未返回可用长难句，跳过`)
      } else {
        all.push(...newItems)
        await saveSentences(all)
      }
    } catch (err) {
      // 单篇失败不中断整批（内容级失败重试也救不回，锁整页代价过大）
      console.warn(`[learnBackfill] ${lit.doi} 长难句补提失败:`, err)
    }
    step()
  }
}

/** 摘要翻译补提：题面/参考答案来自文献元数据（不需要 md），AI 只产踩分点（缺一边时补参考译文） */
async function backfillTranslations(
  candidates: Literature[],
  existing: TranslationData[],
  step: () => void,
): Promise<void> {
  const { ai1, ai2 } = resolveGenContext()

  const all = [...existing]
  for (const lit of candidates) {
    try {
      const en = (lit.abstractEn || '').trim()
      const cn = (lit.abstractCn || '').trim()
      if (!en && !cn) {
        step()
        continue
      }
      const sourceMaterial = [`【英文摘要】${en}`, `【中文摘要】${cn}`].join('\n\n')
      const instruction = buildLearningInstruction(
        { words: false, sentences: false, translation: true, wordCount: 0, sentenceCount: 0 },
        { en, cn },
      )
      const result = await runDualEngine({
        taskType: 'faithfulness_check',
        sourceMaterial,
        ai1Instruction: instruction,
        ai1,
        ai2,
      })
      const parsed = parseLearningJSON(result.ai1Output || '')
      const pointsByDirection: Partial<Record<TranslationDirection, string[]>> = {}
      const referenceOverride: Partial<Record<TranslationDirection, string>> = {}
      for (const t of parsed.translations) {
        const dir: TranslationDirection | null =
          t.direction === 'cn2en' ? 'cn2en' : t.direction === 'en2cn' ? 'en2cn' : null
        if (dir) pointsByDirection[dir] = toStringArray(t.scoring_points)
        const ref = (t.reference_translation || '').trim()
        if (dir && ref) referenceOverride[dir] = ref
      }
      const items = buildTranslationItems(lit, pointsByDirection, Date.now(), `ai_${lit.doi}_`, referenceOverride)
      if (items.length === 0) {
        console.warn(`[learnBackfill] ${lit.doi} 未能生成任何翻译题，跳过`)
      } else {
        all.push(...items)
        await saveTranslations(all)
      }
    } catch (err) {
      console.warn(`[learnBackfill] ${lit.doi} 摘要翻译补提失败:`, err)
    }
    step()
  }
}
