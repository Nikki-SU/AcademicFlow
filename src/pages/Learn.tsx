import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  GraduationCap,
  Brain,
  Type,
  Languages,
  Plus,
  ChevronLeft,
  ChevronRight,
  Check,
  X,
  BookOpen,
  Volume2,
  Sparkles,
  Settings,
  PenTool,
  MessageSquare,
  FileText,
} from 'lucide-react'
import { toast } from 'sonner'
import { loadWords, saveWords, loadSentences, saveSentences, loadTranslations, saveTranslations } from '../services/learningData'
import { useSettingsStore } from '../stores/settings'
import { useWorkspaceStore } from '../stores/workspace'
import type { WordData, SentenceData, TranslationData } from '../services/learningData'
import { loadProgress, updateProgress } from '../services/learningProgress'
import { runDualEngine } from '../services/ai/dual-engine'
import { loadLiteratures, loadFulltext, type Literature } from '../services/literatureData'

type TabId = 'words' | 'sentences' | 'translation'

/**
 * 单词题型 —— 对齐 CAT 项目 study_service.QUESTION_TYPES：
 * 全部为四选一选择题，按题型分轮次，答错立刻重做。
 */
type WordQuestionType =
  | 'en_select_cn'     // 英文单词 → 选中文释义
  | 'cn_select_en'     // 中文释义 → 选英文单词
  | 'en_select_def'    // 英文单词 → 选（中文）定义
  | 'def_select_en'    // （中文）定义 → 选英文单词
  | 'sent_select_cn'   // 例句挖空 → 选中文释义
  | 'sent_select_def'  // 例句挖空 → 选定义

interface StudyStats {
  todayLearned: string[]
  totalLearned: string[]
  lastStudyDate: string
}

const WORD_QUESTION_TYPES: { key: WordQuestionType; label: string; icon: typeof Brain }[] = [
  { key: 'en_select_cn', label: '英选中', icon: BookOpen },
  { key: 'cn_select_en', label: '中选英', icon: Languages },
  { key: 'en_select_def', label: '英选定义', icon: FileText },
  { key: 'def_select_en', label: '定义选英', icon: PenTool },
  { key: 'sent_select_cn', label: '例句选中', icon: MessageSquare },
  { key: 'sent_select_def', label: '例句选定义', icon: Type },
]

const subTabs = [
  { id: 'words' as TabId, label: '单词', icon: Brain },
  { id: 'sentences' as TabId, label: '长难句', icon: Type },
  { id: 'translation' as TabId, label: '翻译练习', icon: Languages },
]

const DEFAULT_WORDS: WordData[] = []
const DEFAULT_SENTENCES: SentenceData[] = []
const DEFAULT_TRANSLATIONS: TranslationData[] = []

function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

function getTodayString(): string {
  return new Date().toISOString().split('T')[0]
}

// ============================================================
// 单词选择题引擎（移植自 CAT 项目 study_service.QUESTION_TYPES）
// ============================================================

/** 单词的"定义"：复习模式优先英文定义，缺失时回退中文定义/中文释义 */
function wordDefinition(w: WordData, mode: 'learn' | 'review'): string {
  if (mode === 'review') return w.definitionEn || w.definitionCn || w.meaning || ''
  return w.definitionCn || w.meaning || ''
}

/** 例句中挖空目标单词（大小写不敏感，只替换第一次出现） */
function blankSentence(sentence: string, word: string): string {
  if (!word) return sentence
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return sentence.replace(new RegExp(escaped, 'i'), '_____')
}

/** 该单词是否适合出某题型（缺字段的题型直接整轮跳过该词，对齐 CAT 行为） */
function isWordEligible(w: WordData, type: WordQuestionType, mode: 'learn' | 'review'): boolean {
  const hasMeaning = !!w.meaning.trim()
  const hasDef = !!wordDefinition(w, mode).trim()
  const hasSentence =
    !!w.exampleEn.trim() && w.word.length >= 2 &&
    new RegExp(w.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(w.exampleEn)
  switch (type) {
    case 'en_select_cn': return !!w.word.trim() && hasMeaning
    case 'cn_select_en': return hasMeaning && !!w.word.trim()
    case 'en_select_def': return !!w.word.trim() && !!w.definitionCn.trim()
    case 'def_select_en': return hasDef && !!w.word.trim()
    case 'sent_select_cn': return hasSentence && hasMeaning
    case 'sent_select_def': return hasSentence && !!w.definitionCn.trim()
  }
}

interface GeneratedWordQuestion {
  wordId: string
  type: WordQuestionType
  typeLabel: string
  isSentence: boolean
  question: string
  options: string[]
  answer: string
}

/**
 * 生成一道四选一题：1 个正确项 + 最多 3 个干扰项（从同轮可答词池中取，去重去重）。
 * 词池不足时降级为 2~3 个选项。
 */
function buildQuestion(
  word: WordData,
  type: WordQuestionType,
  pool: WordData[],
  mode: 'learn' | 'review',
): GeneratedWordQuestion | null {
  if (!isWordEligible(word, type, mode)) return null
  const typeMeta = WORD_QUESTION_TYPES.find((t) => t.key === type)!

  let question = ''
  let answer = ''
  let isSentence = false
  switch (type) {
    case 'en_select_cn':
      question = word.word; answer = word.meaning; break
    case 'cn_select_en':
      question = word.meaning; answer = word.word; break
    case 'en_select_def':
      question = word.word; answer = wordDefinition(word, mode); break
    case 'def_select_en':
      question = wordDefinition(word, mode); answer = word.word; break
    case 'sent_select_cn':
      question = blankSentence(word.exampleEn, word.word); answer = word.meaning; isSentence = true; break
    case 'sent_select_def':
      question = blankSentence(word.exampleEn, word.word); answer = wordDefinition(word, mode); isSentence = true; break
  }
  if (!question.trim() || !answer.trim()) return null

  // 干扰项按"答案字段"取，保证四个选项语义同类
  const answerOf = (w: WordData): string => {
    switch (type) {
      case 'en_select_cn':
      case 'sent_select_cn': return w.meaning
      case 'cn_select_en':
      case 'def_select_en': return w.word
      case 'en_select_def':
      case 'sent_select_def': return wordDefinition(w, mode)
    }
  }
  const distractors: string[] = []
  for (const w of shuffleArray(pool.filter((x) => x.id !== word.id))) {
    const v = answerOf(w).trim()
    if (v && v !== answer.trim() && !distractors.includes(v)) distractors.push(v)
    if (distractors.length >= 3) break
  }
  const options = shuffleArray([answer, ...distractors.slice(0, 3)])
  return { wordId: word.id, type, typeLabel: typeMeta.label, isSentence, question, options, answer }
}

/** SM-2 风格的复习重排（复习模式答对时调用） */
function rescheduleReview(w: WordData, correct: boolean, now: number): Partial<WordData> {
  if (correct) {
    const interval = Math.max(1, Math.round((w.sm2Interval || 1) * w.sm2Ease))
    return { sm2Interval: interval, lastReview: now, reviewCount: w.reviewCount + 1 }
  }
  return { sm2Interval: 1, lastReview: now }
}

/** 学习模式完成全部适用题型后的新间隔（艾宾浩斯阶梯：1/2/4/7/15/30 天） */
const LEARN_LADDER = [1, 2, 4, 7, 15, 30]
function nextLearnInterval(w: WordData): number {
  return LEARN_LADDER[Math.min(w.reviewCount, LEARN_LADDER.length - 1)]
}

function speakEnglish(text: string) {
  if (!text || typeof speechSynthesis === 'undefined') return
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'en-US'
  u.rate = 0.85
  speechSynthesis.cancel()
  speechSynthesis.speak(u)
}

/** 解析 AI-1 输出的学习内容 JSON（容错：去掉代码块包裹 / 提取首尾花括号） */
interface ParsedLearningJSON {
  words: Array<{ word?: string; phonetic?: string; meaning?: string; exampleEn?: string; exampleZh?: string }>
  sentences: Array<{ sentenceEn?: string; sentenceCn?: string; aiReferenceCn?: string }>
  translations: Array<{ originalText?: string }>
}
function parseLearningJSON(raw: string): ParsedLearningJSON {
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
    return { words: [], sentences: [], translations: [] }
  }
}

export default function LearnPage() {
  const { repo } = useWorkspaceStore()
  const [activeTab, setActiveTab] = useState<TabId>('words')
  const [aiGenOpen, setAiGenOpen] = useState(false)
  const [selectedPaper, setSelectedPaper] = useState('')
  const [genTypes, setGenTypes] = useState({ words: true, sentences: true, translation: true })
  const [literatures, setLiteratures] = useState<Literature[]>([])
  const [isAiGenerating, setIsAiGenerating] = useState(false)

  const [words, setWords] = useState<WordData[]>(DEFAULT_WORDS)
  const [sentences, setSentences] = useState<SentenceData[]>(DEFAULT_SENTENCES)
  const [translations, setTranslations] = useState<TranslationData[]>(DEFAULT_TRANSLATIONS)
  const [studyStats, setStudyStats] = useState<StudyStats>({
    todayLearned: [],
    totalLearned: [],
    lastStudyDate: getTodayString(),
  })
  const [dataLoaded, setDataLoaded] = useState(false)

  // 从 GitHub 私库恢复标签页和学习统计（SPEC §0：用户数据存 GitHub）
  useEffect(() => {
    let cancelled = false
    async function loadLearnProgress() {
      try {
        const saved = await loadProgress()
        if (cancelled) return
        if (saved.activeTab) setActiveTab(saved.activeTab as TabId)
        if (saved.todayLearned || saved.totalLearned) {
          const today = getTodayString()
          setStudyStats({
            todayLearned: saved.lastStudyDate === today ? (saved.todayLearned || []) : [],
            totalLearned: saved.totalLearned || [],
            lastStudyDate: today,
          })
        }
      } catch (err) {
        console.error('[Learn] 恢复标签页/统计失败:', err)
      }
    }
    loadLearnProgress()
    return () => { cancelled = true }
  }, [])

  // 加载文献列表用于"AI 补充生成"下拉选项
  useEffect(() => {
    if (!repo) return
    let cancelled = false
    async function loadLitList() {
      try {
        const list = await loadLiteratures()
        if (cancelled) return
        setLiteratures(list)
        if (list.length > 0 && !selectedPaper) {
          setSelectedPaper(list[0].doi)
        }
      } catch (err) {
        console.warn('[Learn] 加载文献列表失败:', err)
      }
    }
    loadLitList()
    return () => { cancelled = true }
  }, [repo])

  // 从 GitHub 私库加载数据
  useEffect(() => {
    if (!repo) return
    let cancelled = false
    async function loadData() {
      try {
        const [loadedWords, loadedSentences, loadedTranslations] = await Promise.all([
          loadWords(),
          loadSentences(),
          loadTranslations(),
        ])
        if (cancelled) return
        if (loadedWords.length > 0) setWords(loadedWords)
        if (loadedSentences.length > 0) setSentences(loadedSentences)
        if (loadedTranslations.length > 0) setTranslations(loadedTranslations)
        setDataLoaded(true)
      } catch (err) {
        console.warn('[Learn] 从 GitHub 加载学习数据失败，使用默认数据:', err)
        setDataLoaded(true)
      }
    }
    loadData()
    return () => { cancelled = true }
  }, [repo])

  // 防抖保存到 GitHub 私库
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!dataLoaded) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      try {
        await Promise.all([
          saveWords(words),
          saveSentences(sentences),
          saveTranslations(translations),
        ])
      } catch (err) {
        console.error('[Learn] 保存学习数据到 GitHub 失败:', err)
      }
    }, 2000)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [words, sentences, translations, dataLoaded])

  // 持久化标签页和学习统计到 GitHub 私库（防抖写入）
  useEffect(() => {
    updateProgress({ activeTab })
  }, [activeTab])

  useEffect(() => {
    updateProgress({
      todayLearned: studyStats.todayLearned,
      totalLearned: studyStats.totalLearned,
      lastStudyDate: studyStats.lastStudyDate,
    })
  }, [studyStats])

  /** 单词会话里每答对一个词记一次学习统计（掌握/重排由 WordSection 会话引擎处理） */
  const markStudied = useCallback((wordId: string) => {
    setStudyStats((prev) => {
      const today = getTodayString()
      const todayLearned = prev.lastStudyDate === today ? [...prev.todayLearned] : []
      if (!todayLearned.includes(wordId)) {
        todayLearned.push(wordId)
      }
      const totalLearned = prev.totalLearned.includes(wordId)
        ? prev.totalLearned
        : [...prev.totalLearned, wordId]
      return {
        todayLearned,
        totalLearned,
        lastStudyDate: today,
      }
    })
  }, [])


  const handleAIGenerate = async () => {
    if (!selectedPaper) {
      toast.error('请选择要生成学习内容的文献')
      return
    }
    if (!genTypes.words && !genTypes.sentences && !genTypes.translation) {
      toast.error('请至少选择一种生成类型')
      return
    }

    const lit = literatures.find((l) => l.doi === selectedPaper)
    if (!lit) {
      toast.error('未找到选定文献的元数据')
      return
    }

    setIsAiGenerating(true)
    try {
      // 1. 解析双引擎配置（硅基流动 / 自定义端点）
      const { getDualEngineConfig } = useSettingsStore.getState()
      const { ai1, ai2 } = getDualEngineConfig()

      // 2. 加载文献全文作为源材料（唯一 ground truth）
      let fulltext = ''
      try {
        fulltext = await loadFulltext(selectedPaper)
      } catch (err) {
        console.warn('[Learn] 加载文献全文失败:', err)
      }
      if (!fulltext.trim()) {
        // 兜底：用摘要作为源材料
        fulltext = [lit.abstractEn, lit.abstractCn].filter(Boolean).join('\n\n') || '（文献无可用全文）'
      }
      const sourceMaterial = fulltext

      // 3. 构造生成指令：根据勾选的类型组合
      const tasks: string[] = []
      if (genTypes.words) {
        tasks.push('生词卡片：从原文中挑选 5-8 个学术核心单词，每条含 word/phonetic/meaning(中文)/exampleEn(原文中含该词的句子)/exampleZh(中文译文)')
      }
      if (genTypes.sentences) {
        tasks.push('长难句：从原文中挑选 3-5 个有学习价值的长难句，每条含 sentenceEn(原文逐字)/sentenceCn(中文翻译)/aiReferenceCn(参考译文)')
      }
      if (genTypes.translation) {
        tasks.push('翻译练习：从原文中挑选 2-3 段适合做翻译练习的段落，每条含 originalText(原文逐字)')
      }
      const ai1Instruction = [
        `请基于上述源材料生成以下学习内容：`,
        tasks.map((t, i) => `${i + 1}. ${t}`).join('\n'),
        '',
        '【输出格式（严格 JSON，不要 markdown 代码块包裹）】',
        '{',
        '  "words": [{"word":"...","phonetic":"...","meaning":"...","exampleEn":"...","exampleZh":"..."}],',
        '  "sentences": [{"sentenceEn":"...","sentenceCn":"...","aiReferenceCn":"..."}],',
        '  "translations": [{"originalText":"..."}]',
        '}',
        '',
        '【严格要求】',
        '- word/exampleEn/sentenceEn/originalText 等英文片段必须**逐字复制**自源材料，禁止改写或编造',
        '- 不确定的内容（如音标/中文释义）允许基于学术常识给出，但原文片段必须严格逐字对齐',
        '- 源材料未涉及的字段用 [NOT_IN_SOURCE] <字段名> 标注',
        '- 输出语言：英文片段保持原文，中文释义/翻译用中文',
      ].join('\n')

      // 4. 调用双引擎：AI-1 生成 + AI-2 核查 + 引证锚定 + 分层归因重试
      const result = await runDualEngine({
        taskType: 'faithfulness_check',
        sourceMaterial,
        ai1Instruction,
        ai1,
        ai2,
      })

      // 5. 解析 AI-1 输出的 JSON
      const ai1Output = result.ai1Output || ''
      const parsed = parseLearningJSON(ai1Output)

      const now = Date.now()
      let addedCount = 0

      if (genTypes.words && parsed.words.length > 0) {
        const newWords: WordData[] = parsed.words.map((w) => ({
          id: `ai_${now}_${addedCount++}`,
          word: w.word || '',
          phonetic: w.phonetic || '',
          meaning: w.meaning || '',
          // AI 只给一条中文释义：同时作为 word_cn 和 definition_cn，保证"定义"题型可用
          definitionCn: w.meaning || '',
          definitionEn: '',
          exampleEn: w.exampleEn || '',
          exampleZh: w.exampleZh || '',
          sourceDoi: selectedPaper,
          status: 'new',
          addedAt: now,
          lastReview: 0,
          reviewCount: 0,
          sm2Interval: 1,
          sm2Ease: 2.5,
          streak: 0,
          wrongCount: 0,
        }))
        setWords((prev) => [...prev, ...newWords])
      }

      if (genTypes.sentences && parsed.sentences.length > 0) {
        const newSentences: SentenceData[] = parsed.sentences.map((s) => ({
          id: `ai_${now}_${addedCount++}`,
          sentenceEn: s.sentenceEn || '',
          sentenceCn: s.sentenceCn || '',
          aiReferenceCn: s.aiReferenceCn || '',
          sourceDoi: selectedPaper,
          status: 'new',
          addedAt: now,
          lastReview: 0,
          reviewCount: 0,
          sm2Interval: 1,
          sm2Ease: 2.5,
        }))
        setSentences((prev) => [...prev, ...newSentences])
      }

      if (genTypes.translation && parsed.translations.length > 0) {
        const newTranslations: TranslationData[] = parsed.translations.map((t) => ({
          id: `ai_${now}_${addedCount++}`,
          originalText: t.originalText || '',
          sourceDoi: selectedPaper,
          latestUserTranslation: '',
          latestAiFeedback: '',
          latestErrorWords: '',
          status: 'pending',
          addedAt: now,
          lastPractice: 0,
          practiceCount: 0,
        }))
        setTranslations((prev) => [...prev, ...newTranslations])
      }

      const reviewNote = result.finalPassed
        ? 'AI-2 审阅通过'
        : `AI-2 审阅未通过：${result.ai2Feedback.summary || '存在忠实性问题，请人工核对'}`
      toast.success(`AI 生成完成（${addedCount} 条），${reviewNote}`)
      setAiGenOpen(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`AI 生成失败：${msg}`)
    } finally {
      setIsAiGenerating(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <GraduationCap className="w-6 h-6 text-indigo-600" />
            学习
          </h1>
          <p className="text-sm text-slate-500 mt-1">PDF 入库转换为 Markdown 时自动生成学习内容，也可手动添加</p>
        </div>
        <button
          onClick={() => setAiGenOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-lg text-sm font-medium hover:from-indigo-700 hover:to-purple-700 transition shadow-sm"
        >
          <Sparkles className="w-4 h-4" />
          AI 补充生成
        </button>
      </div>

      <div className="flex items-center gap-1 mb-6 bg-white rounded-lg border border-slate-200 p-1 w-fit">
        {subTabs.map((tab) => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition ${
                activeTab === tab.id
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          )
        })}
      </div>

      {aiGenOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6">
            <h3 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-indigo-600" />
              AI 补充生成学习内容
            </h3>
            <p className="text-sm text-slate-500 mb-4">
              从选定文献的 Markdown 内容中自动提取并生成学习卡片
            </p>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-slate-700 mb-1.5 block">选择文献</label>
                <select
                  value={selectedPaper}
                  onChange={(e) => setSelectedPaper(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                  disabled={isAiGenerating}
                >
                  <option value="">请选择...</option>
                  {literatures.map((lit) => (
                    <option key={lit.doi} value={lit.doi}>
                      {lit.title ? lit.title.slice(0, 60) : lit.doi}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700 mb-2 block">生成类型</label>
                <div className="space-y-2">
                  {[
                    { key: 'words', label: '单词卡片', icon: Brain },
                    { key: 'sentences', label: '长难句', icon: Type },
                    { key: 'translation', label: '翻译练习', icon: Languages },
                  ].map((item) => {
                    const Icon = item.icon
                    const checked = genTypes[item.key as keyof typeof genTypes]
                    return (
                      <label key={item.key} className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-50 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => setGenTypes((prev) => ({ ...prev, [item.key]: e.target.checked }))}
                          className="rounded text-indigo-600 focus:ring-indigo-500"
                        />
                        <Icon className="w-4 h-4 text-slate-500" />
                        <span className="text-sm text-slate-700">{item.label}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setAiGenOpen(false)}
                className="flex-1 px-4 py-2 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition"
              >
                取消
              </button>
              <button
                onClick={handleAIGenerate}
                disabled={isAiGenerating}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <Sparkles className={`w-4 h-4 ${isAiGenerating ? 'animate-pulse' : ''}`} />
                {isAiGenerating ? 'AI-1 生成 / AI-2 审阅中…' : '开始生成'}
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'words' && (
        <WordSection
          words={words}
          setWords={setWords}
          studyStats={studyStats}
          onStudied={markStudied}
        />
      )}
      {activeTab === 'sentences' && <SentenceSection sentences={sentences} setSentences={setSentences} />}
      {activeTab === 'translation' && <TranslationSection translations={translations} setTranslations={setTranslations} />}
    </div>
  )
}

interface WordSectionProps {
  words: WordData[]
  setWords: React.Dispatch<React.SetStateAction<WordData[]>>
  studyStats: StudyStats
  onStudied: (wordId: string) => void
}

/** 单词学习设置（对齐 CAT：队列长度 / 题型多选 / 掌握连续正确次数 / 斩词 / 发音） */
interface WordStudySettings {
  queueLength: number
  masterCount: number
  questionTypes: WordQuestionType[]
  allowZhan: boolean
  voiceEnabled: boolean
}

const DEFAULT_WORD_SETTINGS: WordStudySettings = {
  queueLength: 5,
  masterCount: 12,
  questionTypes: ['en_select_cn'],
  allowZhan: true,
  voiceEnabled: true,
}

/**
 * 学习会话状态（移植自 CAT StudySession）
 * - queue：本组单词 id，跨所有题型轮次固定
 * - wrongIds：本轮答错队列，优先重做（is_retry）
 * - correctTypes：每个词已答对的题型，全部适用题型答对 → learned
 */
interface StudySession {
  mode: 'learn' | 'review'
  queue: string[]
  typeIdx: number
  wordIdx: number
  wrongIds: string[]
  correctTypes: Record<string, string[]>
  shownCards: string[]
  correctCount: number
  wrongCount: number
  masteredCount: number
}

const DAY_MS = 86_400_000

function WordSection({ words, setWords, studyStats, onStudied }: WordSectionProps) {
  const [settings, setSettings] = useState<WordStudySettings>(DEFAULT_WORD_SETTINGS)
  const [showSettings, setShowSettings] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)

  const [session, setSession] = useState<StudySession | null>(null)
  const [question, setQuestion] = useState<GeneratedWordQuestion | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [answered, setAnswered] = useState(false)
  const [showCard, setShowCard] = useState(false)
  const [finished, setFinished] = useState<StudySession | null>(null)
  const [nowTick, setNowTick] = useState(Date.now())
  /** 答对后自动跳下一题的定时器（退出会话/卸载时清理） */
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 单词卡滚动时间戳：滚动后 250ms 内的点击视为滚动误触，不触发翻页（借鉴快速刷题流） */
  const cardScrollAtRef = useRef(0)

  useEffect(() => () => {
    if (autoTimer.current) clearTimeout(autoTimer.current)
  }, [])

  // 每分钟刷新一次"待复习"判断
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const byId = useMemo(() => new Map(words.map((w) => [w.id, w])), [words])

  // 统计（对齐 CAT wordStats）
  const stats = useMemo(() => {
    let newC = 0, learning = 0, learned = 0, mastered = 0, errorBook = 0, due = 0
    for (const w of words) {
      if (w.status === 'new') newC++
      else if (w.status === 'learning') learning++
      else if (w.status === 'learned') {
        learned++
        if (w.lastReview > 0 && w.lastReview + (w.sm2Interval || 1) * DAY_MS <= nowTick) due++
      } else if (w.status === 'mastered') mastered++
      if (w.wrongCount >= 3) errorBook++
    }
    return { total: words.length, new: newC, learning, learned, mastered, errorBook, due }
  }, [words, nowTick])

  // ── 设置持久化（learningProgress） ──
  useEffect(() => {
    let cancelled = false
    loadProgress().then((p) => {
      if (cancelled) return
      const savedTypes = Array.isArray(p.wordQuestionTypes)
        ? p.wordQuestionTypes.filter((t): t is WordQuestionType =>
            WORD_QUESTION_TYPES.some((wt) => wt.key === t))
        : []
      const ql = p.wordQueueLength
      const mc = p.wordMasterCount
      setSettings((prev) => ({
        queueLength: ql !== undefined && [5, 7, 9].includes(ql) ? ql : prev.queueLength,
        masterCount: mc !== undefined && [6, 12, 18].includes(mc) ? mc : prev.masterCount,
        questionTypes: savedTypes.length > 0 ? savedTypes : prev.questionTypes,
        allowZhan: typeof p.wordAllowZhan === 'boolean' ? p.wordAllowZhan : prev.allowZhan,
        voiceEnabled: typeof p.wordVoiceEnabled === 'boolean' ? p.wordVoiceEnabled : prev.voiceEnabled,
      }))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    void updateProgress({
      wordQueueLength: settings.queueLength,
      wordMasterCount: settings.masterCount,
      wordQuestionTypes: settings.questionTypes,
      wordAllowZhan: settings.allowZhan,
      wordVoiceEnabled: settings.voiceEnabled,
    })
  }, [settings])

  // ── 出题 / 会话推进 ──

  /** 根据会话当前指针出题（wrongIds 优先），并重置答题 UI */
  const presentQuestion = useCallback((s: StudySession) => {
    const type = settings.questionTypes[s.typeIdx]
    const pool = s.queue.map((id) => byId.get(id)).filter((w): w is WordData => !!w)
    const eligible = pool.filter((w) => isWordEligible(w, type, s.mode))
    let wid = s.wrongIds[0]
    if (!wid) wid = eligible[s.wordIdx]?.id
    if (!wid) {
      // 理论上不该发生：安全收尾
      setFinished(s)
      setSession(null)
      setQuestion(null)
      return
    }
    const w = byId.get(wid)
    const q = w ? buildQuestion(w, type, eligible, s.mode) : null
    if (!q) {
      setFinished(s)
      setSession(null)
      setQuestion(null)
      return
    }
    // CAT 式预展卡：learn 模式下每个词在本会话第一次出题，先展示单词卡
    // （先学再测）；错题重做/复习模式不预展。
    const isFirstEncounter =
      s.mode === 'learn' &&
      !s.shownCards.includes(wid) &&
      !(s.wrongIds[0] === wid)
    if (isFirstEncounter) s = { ...s, shownCards: [...s.shownCards, wid] }
    setSession(s)
    setQuestion(q)
    setSelected(null)
    setAnswered(false)
    setShowCard(isFirstEncounter)
  }, [byId, settings.questionTypes])

  /** 推进到下一题；错题未清先重做题，否则同题型下一词，再否则切下一题型 */
  const advance = useCallback((s: StudySession) => {
    const types = settings.questionTypes
    const pool = s.queue.map((id) => byId.get(id)).filter((w): w is WordData => !!w)

    if (s.wrongIds.length > 0) {
      presentQuestion(s)
      return
    }
    const eligibleNow = pool.filter((w) => isWordEligible(w, types[s.typeIdx], s.mode))
    if (s.wordIdx < eligibleNow.length - 1) {
      presentQuestion({ ...s, wordIdx: s.wordIdx + 1 })
      return
    }
    for (let ni = s.typeIdx + 1; ni < types.length; ni++) {
      const eligibleNext = pool.filter((w) => isWordEligible(w, types[ni], s.mode))
      if (eligibleNext.length > 0) {
        presentQuestion({ ...s, typeIdx: ni, wordIdx: 0 })
        return
      }
    }
    // 全部题型轮完
    setFinished(s)
    setSession(null)
    setQuestion(null)
  }, [byId, settings.questionTypes, presentQuestion])

  const startSession = useCallback((mode: 'learn' | 'review') => {
    let queue: WordData[]
    if (mode === 'learn') {
      // CAT：learning 优先，new 补齐
      const learningWords = words
        .filter((w) => w.status === 'learning')
        .sort((a, b) => a.addedAt - b.addedAt)
      const newWords = words
        .filter((w) => w.status === 'new')
        .sort((a, b) => a.addedAt - b.addedAt)
      queue = [...learningWords, ...newWords].slice(0, settings.queueLength)
    } else {
      queue = words
        .filter((w) => w.status === 'learned' && w.lastReview > 0 && w.lastReview + (w.sm2Interval || 1) * DAY_MS <= Date.now())
        .sort((a, b) => a.lastReview - b.lastReview)
        .slice(0, 20)
    }
    if (queue.length === 0) {
      toast.error(mode === 'learn' ? '暂无可学习的新词' : '暂无到期复习的单词')
      return
    }
    // 选第一个对这组词"有题可出"的题型
    let typeIdx = -1
    settings.questionTypes.some((t, i) => {
      if (queue.some((w) => isWordEligible(w, t, mode))) { typeIdx = i; return true }
      return false
    })
    if (typeIdx < 0) {
      toast.error('所选题型在这批单词上都缺少必要字段（释义/定义/例句），请调整题型或补充单词信息')
      return
    }
    setFinished(null)
    presentQuestion({
      mode,
      queue: queue.map((w) => w.id),
      typeIdx,
      wordIdx: 0,
      wrongIds: [],
      correctTypes: {},
      shownCards: [],
      correctCount: 0,
      wrongCount: 0,
      masteredCount: 0,
    })
  }, [words, settings, presentQuestion])

  /** 选中即判定（无确认按钮）：对 → 短暂高亮后自动下一题；错 → 弹单词卡 */
  const submitAnswer = useCallback((option: string) => {
    if (!session || !question || answered) return
    const isCorrect = option === question.answer
    const wid = question.wordId
    const now = Date.now()
    setSelected(option)
    setAnswered(true)

    if (isCorrect) {
      const wrongIds = session.wrongIds.filter((id) => id !== wid)
      const doneTypes = Array.from(new Set([...(session.correctTypes[wid] || []), question.type]))
      const correctTypes = { ...session.correctTypes, [wid]: doneTypes }
      const masterCount = settings.masterCount
      const mode = session.mode
      const selectedTypes = settings.questionTypes

      // 先用当前词数据算好新状态（避免在 setState 更新器里做计数副作用）
      const cur = byId.get(wid)
      let nextWord: WordData | null = null
      let masteredNow = false
      if (cur) {
        const streak = cur.streak + 1
        let next: WordData = { ...cur, streak }
        const applicable = selectedTypes.filter((t) => isWordEligible(cur, t, mode))
        const allTypesDone = applicable.every((t) => doneTypes.includes(t))
        if (mode === 'learn') {
          if (allTypesDone) {
            if (streak >= masterCount) {
              next = { ...next, status: 'mastered' }
              masteredNow = cur.status !== 'mastered'
            } else {
              next = {
                ...next,
                status: 'learned',
                sm2Interval: nextLearnInterval(cur),
                reviewCount: cur.reviewCount + 1,
              }
            }
            next = { ...next, lastReview: now }
          }
        } else {
          // 复习模式：SM-2 重排；连续正确达标 → 掌握
          const rs = rescheduleReview(cur, true, now)
          if (streak >= masterCount) {
            next = { ...next, ...rs, status: 'mastered' }
            masteredNow = cur.status !== 'mastered'
          } else {
            next = { ...next, ...rs, status: 'learned' }
          }
        }
        nextWord = next
      }
      if (nextWord) {
        const planned = nextWord
        setWords((prev) => prev.map((w) => (w.id === wid ? planned : w)))
      }
      onStudied(wid)
      const nextSession: StudySession = {
        ...session,
        wrongIds,
        correctTypes,
        correctCount: session.correctCount + 1,
        masteredCount: session.masteredCount + (masteredNow ? 1 : 0),
      }
      setSession(nextSession)
      // 答对：绿色反馈 800ms 后自动下一题（无需点击）
      if (autoTimer.current) clearTimeout(autoTimer.current)
      autoTimer.current = setTimeout(() => {
        autoTimer.current = null
        advance(nextSession)
      }, 800)
    } else {
      // 答错：streak 清零、wrong_count+1、进错题队列；弹单词卡（每次答错都展）
      const wrongIds = session.wrongIds.includes(wid) ? session.wrongIds : [...session.wrongIds, wid]

      setWords((prev) => prev.map((w) =>
        w.id === wid
          ? { ...w, streak: 0, wrongCount: w.wrongCount + 1, status: 'learning' }
          : w,
      ))
      setShowCard(true)
      setSession({
        ...session,
        wrongIds,
        wrongCount: session.wrongCount + 1,
      })
    }
  }, [session, question, answered, settings.masterCount, settings.questionTypes, setWords, onStudied, byId, advance])

  /** 看完卡片或点"下一题"后继续（错题优先重做） */
  const handleNext = useCallback(() => {
    if (session) advance(session)
  }, [session, advance])

  /** 斩词：直接标记掌握，移出错题队列 */
  const handleZhan = useCallback(() => {
    if (!question) return
    const wid = question.wordId
    setWords((prev) => prev.map((w) =>
      w.id === wid ? { ...w, status: 'mastered', streak: settings.masterCount } : w,
    ))
    toast.success('已斩词，标记为掌握')
    if (session) {
      const s2 = {
        ...session,
        wrongIds: session.wrongIds.filter((id) => id !== wid),
        masteredCount: session.masteredCount + 1,
      }
      advance(s2)
    }
  }, [question, session, setWords, settings.masterCount, advance])

  const exitSession = useCallback(() => {
    if (autoTimer.current) { clearTimeout(autoTimer.current); autoTimer.current = null }
    setSession(null)
    setQuestion(null)
    setFinished(null)
    setShowCard(false)
    setAnswered(false)
  }, [])

  const handleAddWord = (word: WordData) => {
    setWords((prev) => [...prev, word])
    setShowAddModal(false)
    toast.success('单词已添加')
  }

  // ── 空状态 ──
  if (words.length === 0) {
    return (
      <div className="text-center py-16">
        <Brain className="w-16 h-16 text-slate-300 mx-auto mb-4" />
        <p className="text-slate-500 mb-4">还没有单词，快来添加吧！</p>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition"
        >
          添加单词
        </button>
        {showAddModal && <AddWordModal onClose={() => setShowAddModal(false)} onAdd={handleAddWord} />}
      </div>
    )
  }

  // ── 会话结束总结 ──
  if (finished) {
    return (
      <div className="max-w-md mx-auto pt-10">
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
          <GraduationCap className="w-14 h-14 text-indigo-500 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-slate-800 mb-1">
            {finished.mode === 'learn' ? '本组学习完成' : '本轮复习完成'}
          </h3>
          <p className="text-sm text-slate-500 mb-6">
            共 {finished.queue.length} 词 · 答对 {finished.correctCount} 次 · 答错 {finished.wrongCount} 次
            {finished.masteredCount > 0 ? ` · 新掌握 ${finished.masteredCount} 词` : ''}
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => startSession(finished.mode)}
              className="flex-1 py-3 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition"
            >
              再来一组
            </button>
            <button
              onClick={exitSession}
              className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-200 transition"
            >
              返回单词首页
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── 答题中 ──
  if (session && question) {
    const currentType = settings.questionTypes[session.typeIdx]
    const pool = session.queue.map((id) => byId.get(id)).filter((w): w is WordData => !!w)
    const eligible = pool.filter((w) => isWordEligible(w, currentType, session.mode))
    const isRetry = session.wrongIds.length > 0
    const currentWord = byId.get(question.wordId)
    const progressPct = ((isRetry ? session.wordIdx : session.wordIdx + 1) / Math.max(eligible.length, 1)) * 100

    return (
      <div className="space-y-4">
        {/* 顶部状态 */}
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="flex items-center justify-between text-sm text-slate-500 mb-2">
            <span>
              第 {session.wordIdx + 1}/{eligible.length} 题 · 第 {session.typeIdx + 1}/{settings.questionTypes.length} 轮
            </span>
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 bg-indigo-50 text-indigo-700 rounded text-xs font-medium">
                {question.typeLabel}
              </span>
              {isRetry && <span className="px-2 py-0.5 bg-red-50 text-red-600 rounded text-xs">重做</span>}
              {session.mode === 'review' && (
                <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded text-xs">复习</span>
              )}
            </div>
          </div>
          <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
            <div className="h-2 bg-indigo-600 rounded-full transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        </div>

        {/* 题目卡 */}
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="text-center mb-6 min-h-[64px] flex items-center justify-center">
            {question.isSentence ? (
              <p className="text-lg text-slate-800 leading-relaxed text-left">
                {question.question.split('_____').map((part, i, arr) => (
                  <span key={i}>
                    {part}
                    {i < arr.length - 1 && <span className="font-bold text-indigo-600 mx-0.5">_____</span>}
                  </span>
                ))}
              </p>
            ) : (
              <div className="flex items-center justify-center gap-3">
                <h2 className="text-3xl font-bold text-slate-800 break-all">{question.question}</h2>
                {settings.voiceEnabled && (
                  <button
                    onClick={() => speakEnglish(question.question)}
                    className="p-2 text-slate-400 hover:text-indigo-600 transition"
                    title="朗读"
                  >
                    <Volume2 className="w-5 h-5" />
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 选项（选中即判定，无确认按钮） */}
          <div className="space-y-3">
            {question.options.map((option, idx) => {
              const isSelected = selected === option
              const isCorrectOpt = answered && option === question.answer
              const isWrongPick = answered && isSelected && option !== question.answer
              // 色彩语义（借鉴快速刷题流）：答对→选中项绿；答错→错选红 + 正解橙提示
              const isPickedCorrect = isCorrectOpt && isSelected
              const isMissedCorrect = isCorrectOpt && !isSelected
              let cls = 'w-full p-3.5 text-left rounded-lg border transition flex items-center gap-3 '
              if (answered) {
                if (isPickedCorrect) cls += 'bg-green-50 border-green-500 text-green-800'
                else if (isWrongPick) cls += 'bg-red-50 border-red-500 text-red-800'
                else if (isMissedCorrect) cls += 'bg-amber-50 border-amber-500 text-amber-800'
                else cls += 'bg-slate-50 border-slate-200 text-slate-400'
              } else {
                cls += 'bg-white border-slate-300 text-slate-700 hover:border-indigo-400 hover:bg-indigo-50/40 cursor-pointer'
              }
              return (
                <button
                  key={`${option}-${idx}`}
                  onClick={() => submitAnswer(option)}
                  disabled={answered || showCard}
                  className={cls}
                >
                  <span className={`shrink-0 w-7 h-7 rounded-full text-center leading-7 text-sm font-bold ${
                    isPickedCorrect ? 'bg-green-500 text-white'
                      : isWrongPick ? 'bg-red-500 text-white'
                      : isMissedCorrect ? 'bg-amber-500 text-white'
                      : 'bg-slate-100 text-slate-500'
                  }`}>
                    {String.fromCharCode(65 + idx)}
                  </span>
                  <span className="text-sm leading-snug">{option}</span>
                </button>
              )
            })}
          </div>

          {/* 操作区：只剩斩词 / 退出（答对自动跳、答错展卡） */}
          <div className="mt-6 flex gap-3">
            {answered && !showCard && selected === question.answer && (
              <div className="flex-1 py-3 text-center text-sm font-medium text-green-600">
                回答正确，即将进入下一题…
              </div>
            )}
            {settings.allowZhan && currentWord && currentWord.status !== 'mastered' && (
              <button
                onClick={handleZhan}
                disabled={showCard}
                className="px-4 py-3 bg-red-50 text-red-600 rounded-lg text-sm font-medium hover:bg-red-100 transition disabled:opacity-40"
                title="斩词：直接标记为已掌握"
              >
                斩词
              </button>
            )}
            <button
              onClick={exitSession}
              disabled={showCard}
              className="px-4 py-3 bg-slate-100 text-slate-500 rounded-lg text-sm font-medium hover:bg-slate-200 transition disabled:opacity-40"
            >
              退出
            </button>
          </div>
        </div>

        {/* 单词卡弹层：learn 首次出题预展（先学再测） / 答错展卡。
            借鉴快速刷题流：点击屏幕任意位置即可继续（大热区），滚动后 250ms 内防误触 */}
        {showCard && currentWord && (
          <div
            className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 cursor-pointer"
            onClick={() => {
              if (Date.now() - cardScrollAtRef.current < 250) return
              setShowCard(false)
              // 答错卡：点击任意位置 → 进入下一题（错题优先重做）；预览卡：直接开始本题
              if (answered) handleNext()
            }}
          >
            <div
              className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 max-h-[85vh] overflow-y-auto"
              onScroll={() => { cardScrollAtRef.current = Date.now() }}
            >
              {answered && (
                <div className="mb-3 text-center">
                  <span className="inline-block px-3 py-1 bg-red-50 text-red-600 rounded-full text-xs font-medium">
                    答错了 · 正确答案：{question.answer}
                  </span>
                </div>
              )}
              <div className="text-center mb-4">
                <h2 className="text-3xl font-bold text-slate-800">{currentWord.word}</h2>
                <div className="flex items-center justify-center gap-3 mt-1">
                  {currentWord.phonetic && <span className="text-sm text-slate-400">{currentWord.phonetic}</span>}
                  {settings.voiceEnabled && (
                    <button
                      onClick={(e) => { e.stopPropagation(); speakEnglish(currentWord.word) }}
                      className="text-slate-400 hover:text-indigo-600"
                    >
                      <Volume2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <p className="text-lg text-indigo-600 font-medium mt-2">{currentWord.meaning}</p>
              </div>
              {currentWord.definitionCn && currentWord.definitionCn !== currentWord.meaning && (
                <p className="text-sm text-slate-600 mb-2">
                  <span className="font-medium">定义：</span>{currentWord.definitionCn}
                </p>
              )}
              {currentWord.definitionEn && (
                <p className="text-sm text-slate-500 mb-2">
                  <span className="font-medium">EN：</span>{currentWord.definitionEn}
                </p>
              )}
              {currentWord.exampleEn && (
                <div className="mt-3 p-3 bg-slate-50 rounded-lg">
                  <p className="text-sm text-slate-700 italic leading-relaxed">
                    {currentWord.exampleEn.split(
                      new RegExp(`(${currentWord.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i'),
                    ).map((seg, i) =>
                      seg.toLowerCase() === currentWord.word.toLowerCase()
                        ? <strong key={i} className="text-indigo-600 not-italic">{seg}</strong>
                        : seg,
                    )}
                  </p>
                  {currentWord.exampleZh && <p className="text-sm text-slate-500 mt-1.5">{currentWord.exampleZh}</p>}
                </div>
              )}
              {/* 主按钮仅为视觉焦点：点击冒泡到 overlay 统一处理（防双触发跳两题） */}
              <button
                type="button"
                className="mt-5 w-full py-3 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition"
              >
                {answered ? '继续下一题' : '开始答题'}
              </button>
              <p className="mt-2.5 text-center text-xs text-slate-400">
                👆 点击屏幕任意位置{answered ? '继续' : '开始'}
              </p>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── 开始页 ──
  const statChips: { label: string; value: number; cls: string }[] = [
    { label: '全部', value: stats.total, cls: 'text-slate-700' },
    { label: '未学', value: stats.new, cls: 'text-red-500' },
    { label: '学习中', value: stats.learning, cls: 'text-amber-500' },
    { label: '已学', value: stats.learned, cls: 'text-blue-500' },
    { label: '已掌握', value: stats.mastered, cls: 'text-emerald-600' },
    { label: '错词本', value: stats.errorBook, cls: 'text-red-400' },
  ]

  return (
    <div className="space-y-4">
      {/* 统计条 */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {statChips.map((c) => (
            <div key={c.label} className="text-sm">
              <span className="text-slate-400">{c.label} </span>
              <span className={`font-semibold ${c.cls}`}>{c.value}</span>
            </div>
          ))}
          <div className="text-sm ml-auto">
            <span className="text-slate-400">今日已学 </span>
            <span className="font-semibold text-indigo-600">{studyStats.todayLearned.length}</span>
          </div>
        </div>
      </div>

      {/* 设置面板 */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-slate-800">学习设置</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-1 text-sm text-indigo-600 hover:bg-indigo-50 px-2.5 py-1 rounded-lg transition"
            >
              <Plus className="w-4 h-4" /> 添加单词
            </button>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 px-2.5 py-1 rounded-lg hover:bg-slate-100 transition"
            >
              <Settings className="w-4 h-4" />
              {showSettings ? '收起' : '展开'}
            </button>
          </div>
        </div>

        {showSettings && (
          <div className="mt-4 space-y-5">
            <div>
              <label className="block text-sm text-slate-600 mb-2">每组词数</label>
              <div className="flex gap-2">
                {[5, 7, 9].map((n) => (
                  <button
                    key={n}
                    onClick={() => setSettings((p) => ({ ...p, queueLength: n }))}
                    className={`px-4 py-1.5 rounded-lg text-sm transition ${
                      settings.queueLength === n ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {n} 个/组
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm text-slate-600 mb-2">题型选择（按勾选顺序分轮出题，答错立即重做）</label>
              <div className="flex flex-wrap gap-2">
                {WORD_QUESTION_TYPES.map((t) => {
                  const Icon = t.icon
                  const checked = settings.questionTypes.includes(t.key)
                  return (
                    <label
                      key={t.key}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm cursor-pointer transition ${
                        checked ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'bg-slate-50 border-slate-200 text-slate-500'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="accent-indigo-600"
                        checked={checked}
                        onChange={(e) => {
                          setSettings((p) => {
                            const exists = p.questionTypes.includes(t.key)
                            if (e.target.checked && !exists) return { ...p, questionTypes: [...p.questionTypes, t.key] }
                            if (!exists) return p
                            const next = p.questionTypes.filter((k) => k !== t.key)
                            return { ...p, questionTypes: next.length ? next : ['en_select_cn'] }
                          })
                        }}
                      />
                      <Icon className="w-3.5 h-3.5" />
                      {t.label}
                    </label>
                  )
                })}
              </div>
              <p className="text-xs text-slate-400 mt-1.5">
                定义/例句类题型需要单词含有 definition_cn 或原文例句，缺字段的词会自动跳过该轮
              </p>
            </div>

            <div>
              <label className="block text-sm text-slate-600 mb-2">掌握条件（连续答对次数，中途答错清零）</label>
              <div className="flex gap-2">
                {[6, 12, 18].map((n) => (
                  <button
                    key={n}
                    onClick={() => setSettings((p) => ({ ...p, masterCount: n }))}
                    className={`px-4 py-1.5 rounded-lg text-sm transition ${
                      settings.masterCount === n ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {n} 次
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-6 pt-1">
              <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  className="accent-indigo-600"
                  checked={settings.allowZhan}
                  onChange={(e) => setSettings((p) => ({ ...p, allowZhan: e.target.checked }))}
                />
                允许斩词
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  className="accent-indigo-600"
                  checked={settings.voiceEnabled}
                  onChange={(e) => setSettings((p) => ({ ...p, voiceEnabled: e.target.checked }))}
                />
                朗读发音
              </label>
            </div>
          </div>
        )}
      </div>

      {/* 开始按钮 */}
      <div className="flex gap-4">
        <button
          onClick={() => startSession('learn')}
          disabled={stats.new + stats.learning === 0}
          className="flex-1 py-4 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          <span className="block text-base font-medium">开始学习</span>
          <span className="text-xs opacity-80">
            {stats.new + stats.learning > 0 ? `${stats.learning} 个学习中 + ${stats.new} 个新词` : '暂无新词'}
          </span>
        </button>
        <button
          onClick={() => startSession('review')}
          disabled={stats.due === 0}
          className="flex-1 py-4 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          <span className="block text-base font-medium">开始复习</span>
          <span className="text-xs opacity-80">
            {stats.due > 0 ? `${stats.due} 个词已到期` : '暂无到期复习'}
          </span>
        </button>
      </div>

      {showAddModal && <AddWordModal onClose={() => setShowAddModal(false)} onAdd={handleAddWord} />}
    </div>
  )
}


function SentenceSection({ sentences, setSentences }: { sentences: SentenceData[]; setSentences: React.Dispatch<React.SetStateAction<SentenceData[]>> }) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function loadSentenceProgress() {
      try {
        const saved = await loadProgress()
        if (cancelled) return
        const idx = saved.sentenceCurrentIndex ?? 0
        const safeIdx = sentences.length > 0 ? idx % sentences.length : 0
        setCurrentIndex(safeIdx)
      } catch (err) {
        console.error('[Learn] SentenceSection 加载进度失败:', err)
      }
    }
    loadSentenceProgress()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    updateProgress({ sentenceCurrentIndex: currentIndex })
  }, [currentIndex])

  const currentSentence = sentences.length > 0 ? sentences[currentIndex % sentences.length] : undefined

  const handlePrev = () => {
    setFlipped(false)
    setCurrentIndex((i) => (i - 1 + sentences.length) % sentences.length)
  }

  const handleNext = () => {
    setFlipped(false)
    setCurrentIndex((i) => (i + 1) % sentences.length)
  }

  const toggleMastered = () => {
    setSentences((prev) =>
      prev.map((s, i) =>
        i === currentIndex % sentences.length
          ? { ...s, status: s.status === 'mastered' ? 'learning' : 'mastered' }
          : s
      )
    )
    toast.success(currentSentence?.status === 'mastered' ? '已取消标记' : '已标记为已掌握')
  }

  const handleAddSentence = (sentence: SentenceData) => {
    setSentences((prev) => [...prev, sentence])
    setShowAddModal(false)
    toast.success('长难句已添加')
  }

  if (sentences.length === 0) {
    return (
      <div className="text-center py-16">
        <Type className="w-16 h-16 text-slate-300 mx-auto mb-4" />
        <p className="text-slate-500 mb-4">还没有长难句，快来添加吧！</p>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition"
        >
          添加长难句
        </button>
      </div>
    )
  }

  return (
    <div className="relative">
      <div className="flex justify-between items-center mb-4">
        <div className="text-sm text-slate-500">
          进度：{currentIndex + 1} / {sentences.length}
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-indigo-600 hover:bg-indigo-50 rounded-lg transition"
        >
          <Plus className="w-4 h-4" />
          手动添加
        </button>
      </div>

      <div className="w-full bg-slate-100 rounded-full h-2 mb-6">
        <div
          className="bg-indigo-600 h-2 rounded-full transition-all"
          style={{ width: `${((currentIndex + 1) / sentences.length) * 100}%` }}
        />
      </div>

      <div
        onClick={() => setFlipped(!flipped)}
        className="w-full min-h-[20rem] cursor-pointer perspective-[62.5rem]"
        style={{ perspective: '62.5rem' }}
      >
        <div
          className="relative w-full h-full transition-transform duration-500"
          style={{
            transformStyle: 'preserve-3d',
            transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
            minHeight: '20rem',
          }}
        >
          <div
            className="absolute inset-0 bg-white rounded-2xl shadow-lg border border-slate-200 p-6 flex flex-col justify-center"
            style={{ backfaceVisibility: 'hidden' }}
          >
            <div className="text-xs font-medium text-slate-400 mb-3">英文长难句</div>
            <p className="text-lg text-slate-800 leading-relaxed">{currentSentence?.sentenceEn}</p>
            <div className="mt-6 text-xs text-slate-400 text-center">点击卡片查看答案</div>
          </div>

          <div
            className="absolute inset-0 bg-white rounded-2xl shadow-lg border border-indigo-200 p-6 overflow-y-auto"
            style={{
              backfaceVisibility: 'hidden',
              transform: 'rotateY(180deg)',
            }}
          >
            <div className="text-xs font-medium text-indigo-500 mb-3">中文翻译</div>
            <p className="text-base text-slate-800 leading-relaxed mb-6">{currentSentence?.sentenceCn}</p>

            <div className="mt-4 text-xs text-slate-400 text-center">点击卡片翻回正面</div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center gap-3 mt-6">
        <button
          onClick={handlePrev}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 transition"
        >
          <ChevronLeft className="w-4 h-4" />
          上一张
        </button>
        <button
          onClick={toggleMastered}
          className={`flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-sm font-medium transition ${
            currentSentence?.status === 'mastered'
              ? 'bg-green-100 text-green-700 hover:bg-green-200'
              : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          <Check className="w-4 h-4" />
          {currentSentence?.status === 'mastered' ? '已掌握' : '标记掌握'}
        </button>
        <button
          onClick={handleNext}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition"
        >
          下一张
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {showAddModal && <AddSentenceModal onClose={() => setShowAddModal(false)} onAdd={handleAddSentence} />}
    </div>
  )
}

function TranslationSection({ translations, setTranslations }: { translations: TranslationData[]; setTranslations: React.Dispatch<React.SetStateAction<TranslationData[]>> }) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function loadTranslationProgress() {
      try {
        const saved = await loadProgress()
        if (cancelled) return
        const idx = saved.translationCurrentIndex ?? 0
        const safeIdx = translations.length > 0 ? idx % translations.length : 0
        setCurrentIndex(safeIdx)
      } catch (err) {
        console.error('[Learn] TranslationSection 加载进度失败:', err)
      }
    }
    loadTranslationProgress()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    updateProgress({ translationCurrentIndex: currentIndex })
  }, [currentIndex])

  const currentItem = translations.length > 0 ? translations[currentIndex % translations.length] : undefined

  const handlePrev = () => {
    setFlipped(false)
    setCurrentIndex((i) => (i - 1 + translations.length) % translations.length)
  }

  const handleNext = () => {
    setFlipped(false)
    setCurrentIndex((i) => (i + 1) % translations.length)
  }

  const toggleMastered = () => {
    setTranslations((prev) =>
      prev.map((t, i) =>
        i === currentIndex % translations.length
          ? { ...t, status: t.status === 'completed' ? 'pending' : 'completed' }
          : t
      )
    )
    toast.success(currentItem?.status === 'completed' ? '已取消标记' : '已标记为已完成')
  }

  const handleAddTranslation = (item: TranslationData) => {
    setTranslations((prev) => [...prev, item])
    setShowAddModal(false)
    toast.success('翻译练习已添加')
  }

  if (translations.length === 0) {
    return (
      <div className="text-center py-16">
        <Languages className="w-16 h-16 text-slate-300 mx-auto mb-4" />
        <p className="text-slate-500 mb-4">还没有翻译练习，快来添加吧！</p>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition"
        >
          添加翻译练习
        </button>
      </div>
    )
  }

  return (
    <div className="relative">
      <div className="flex justify-between items-center mb-4">
        <div className="text-sm text-slate-500">
          进度：{currentIndex + 1} / {translations.length}
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-indigo-600 hover:bg-indigo-50 rounded-lg transition"
        >
          <Plus className="w-4 h-4" />
          手动添加
        </button>
      </div>

      <div className="w-full bg-slate-100 rounded-full h-2 mb-6">
        <div
          className="bg-indigo-600 h-2 rounded-full transition-all"
          style={{ width: `${((currentIndex + 1) / translations.length) * 100}%` }}
        />
      </div>

      <div
        onClick={() => setFlipped(!flipped)}
        className="w-full min-h-[17.5rem] cursor-pointer"
        style={{ perspective: '62.5rem' }}
      >
        <div
          className="relative w-full h-full transition-transform duration-500"
          style={{
            transformStyle: 'preserve-3d',
            transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
            minHeight: '17.5rem',
          }}
        >
          <div
            className="absolute inset-0 bg-white rounded-2xl shadow-lg border border-slate-200 p-6 flex flex-col justify-center"
            style={{ backfaceVisibility: 'hidden' }}
          >
            <div className="text-xs font-medium text-slate-400 mb-3">中文句子（请翻译为英文）</div>
            <p className="text-lg text-slate-800 leading-relaxed">{currentItem?.originalText}</p>
            <div className="mt-6 text-xs text-slate-400 text-center">点击卡片查看参考译文</div>
          </div>

          <div
            className="absolute inset-0 bg-white rounded-2xl shadow-lg border border-indigo-200 p-6 flex flex-col justify-center"
            style={{
              backfaceVisibility: 'hidden',
              transform: 'rotateY(180deg)',
            }}
          >
            <div className="text-xs font-medium text-indigo-500 mb-3">参考译文</div>
            <p className="text-base text-slate-800 leading-relaxed">{currentItem?.latestUserTranslation}</p>
            <div className="mt-6 text-xs text-slate-400 text-center">点击卡片翻回正面</div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center gap-3 mt-6">
        <button
          onClick={handlePrev}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 transition"
        >
          <ChevronLeft className="w-4 h-4" />
          上一张
        </button>
        <button
          onClick={toggleMastered}
          className={`flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-sm font-medium transition ${
            currentItem?.status === 'completed'
              ? 'bg-green-100 text-green-700 hover:bg-green-200'
              : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          <Check className="w-4 h-4" />
          {currentItem?.status === 'completed' ? '已完成' : '标记完成'}
        </button>
        <button
          onClick={handleNext}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition"
        >
          下一张
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {showAddModal && <AddTranslationModal onClose={() => setShowAddModal(false)} onAdd={handleAddTranslation} />}
    </div>
  )
}

function ModalBackdrop({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

function AddWordModal({ onClose, onAdd }: { onClose: () => void; onAdd: (word: WordData) => void }) {
  const [word, setWord] = useState('')
  const [phonetic, setPhonetic] = useState('')
  const [meaning, setMeaning] = useState('')
  const [definitionCn, setDefinitionCn] = useState('')
  const [exampleEn, setExampleEn] = useState('')
  const [exampleZh, setExampleZh] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!word.trim() || !meaning.trim()) {
      toast.error('请填写单词和释义')
      return
    }
    const newWord: WordData = {
      id: `w_${Date.now()}`,
      word: word.trim(),
      phonetic: phonetic.trim() || '',
      meaning: meaning.trim(),
      definitionCn: definitionCn.trim() || meaning.trim(),
      definitionEn: '',
      exampleEn: exampleEn.trim() || '',
      exampleZh: exampleZh.trim() || '',
      sourceDoi: '',
      status: 'learning',
      addedAt: Date.now(),
      lastReview: 0,
      reviewCount: 0,
      sm2Interval: 1,
      sm2Ease: 2.5,
      streak: 0,
      wrongCount: 0,
    }
    onAdd(newWord)
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-slate-800">添加单词</h3>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">单词 *</label>
            <input
              type="text"
              value={word}
              onChange={(e) => setWord(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="例如：example"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">音标</label>
            <input
              type="text"
              value={phonetic}
              onChange={(e) => setPhonetic(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="例如：/pəˈrɒvskaɪt/"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">中文释义 *</label>
            <input
              type="text"
              value={meaning}
              onChange={(e) => setMeaning(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="例如：示例单词"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">例句（英文）</label>
            <textarea
              value={exampleEn}
              onChange={(e) => setExampleEn(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
              placeholder="英文例句"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">例句（中文）</label>
            <textarea
              value={exampleZh}
              onChange={(e) => setExampleZh(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
              placeholder="中文翻译"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">中文定义（选填，用于"定义"类题型）</label>
            <input
              type="text"
              value={definitionCn}
              onChange={(e) => setDefinitionCn(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="留空则与中文释义相同"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 transition"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition"
            >
              添加
            </button>
          </div>
        </form>
      </div>
    </ModalBackdrop>
  )
}

function AddSentenceModal({ onClose, onAdd }: { onClose: () => void; onAdd: (sentence: SentenceData) => void }) {
  const [en, setEn] = useState('')
  const [zh, setZh] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!en.trim() || !zh.trim()) {
      toast.error('请填写英文和中文')
      return
    }
    const newSentence: SentenceData = {
      id: `s_${Date.now()}`,
      sentenceEn: en.trim(),
      sentenceCn: zh.trim(),
      aiReferenceCn: '',
      sourceDoi: '',
      status: 'learning',
      addedAt: Date.now(),
      lastReview: 0,
      reviewCount: 0,
      sm2Interval: 0,
      sm2Ease: 2.5,
    }
    onAdd(newSentence)
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-slate-800">添加长难句</h3>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">英文句子 *</label>
            <textarea
              value={en}
              onChange={(e) => setEn(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
              placeholder="英文长难句"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">中文翻译 *</label>
            <textarea
              value={zh}
              onChange={(e) => setZh(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
              placeholder="中文翻译"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 transition"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition"
            >
              添加
            </button>
          </div>
        </form>
      </div>
    </ModalBackdrop>
  )
}

function AddTranslationModal({ onClose, onAdd }: { onClose: () => void; onAdd: (item: TranslationData) => void }) {
  const [source, setSource] = useState('')
  const [reference, setReference] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!source.trim() || !reference.trim()) {
      toast.error('请填写中文和参考译文')
      return
    }
    const newItem: TranslationData = {
      id: `t_${Date.now()}`,
      originalText: source.trim(),
      sourceDoi: '',
      latestUserTranslation: reference.trim(),
      latestAiFeedback: '',
      latestErrorWords: '',
      status: 'pending',
      addedAt: Date.now(),
      lastPractice: 0,
      practiceCount: 0,
    }
    onAdd(newItem)
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-slate-800">添加翻译练习</h3>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">中文句子 *</label>
            <textarea
              value={source}
              onChange={(e) => setSource(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
              placeholder="中文句子"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">参考译文 *</label>
            <textarea
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
              placeholder="英文参考译文"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 transition"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition"
            >
              添加
            </button>
          </div>
        </form>
      </div>
    </ModalBackdrop>
  )
}
