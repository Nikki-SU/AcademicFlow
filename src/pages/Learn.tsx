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
  SpellCheck,
  Volume2,
  Shuffle,
  Sparkles,
  Settings,
  CheckCircle,
  XCircle,
  PenTool,
  MessageSquare,
  FileText,
} from 'lucide-react'
import { toast } from 'sonner'
import { loadWords, saveWords, loadSentences, saveSentences, loadTranslations, saveTranslations, calcSm2, estimateRepetitions } from '../services/learningData'
import { useSettingsStore } from '../stores/settings'
import type { WordData, SentenceData, TranslationData } from '../services/learningData'
import { loadProgress, updateProgress } from '../services/learningProgress'
import { runDualEngine } from '../services/ai/dual-engine'
import { loadLiteratures, loadFulltext, type Literature } from '../services/literatureData'

type TabId = 'words' | 'sentences' | 'translation'
type QuestionType = 'word' | 'spelling' | 'listening' | 'zhToEn' | 'enToZh' | 'detail'

interface StudyStats {
  todayLearned: string[]
  totalLearned: string[]
  lastStudyDate: string
}

const questionTypes: { id: QuestionType; label: string; icon: typeof Brain }[] = [
  { id: 'word', label: '单词选择', icon: BookOpen },
  { id: 'spelling', label: '拼写练习', icon: SpellCheck },
  { id: 'listening', label: '听音辨词', icon: Volume2 },
  { id: 'zhToEn', label: '中译英', icon: PenTool },
  { id: 'enToZh', label: '英译中', icon: MessageSquare },
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

function getBlankPosition(sentence: string, word: string): number {
  const lowerSentence = sentence.toLowerCase()
  const lowerWord = word.toLowerCase()
  return lowerSentence.indexOf(lowerWord)
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return '从未学习'
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return '刚刚'
  if (diffMins < 60) return `${diffMins}分钟前`
  if (diffHours < 24) return `${diffHours}小时前`
  if (diffDays < 7) return `${diffDays}天前`
  return date.toLocaleDateString('zh-CN')
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
  }, [])

  // 从 GitHub 私库加载数据
  useEffect(() => {
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
  }, [])

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

  const reviewWord = useCallback((wordId: string, quality: number) => {
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
    setWords((prev) =>
      prev.map((w) => {
        if (w.id !== wordId) return w
        const repetitions = estimateRepetitions(w)
        const result = calcSm2(w.sm2Ease, w.sm2Interval, repetitions, quality)
        return {
          ...w,
          status: result.status,
          lastReview: Date.now(),
          reviewCount: w.reviewCount + 1,
          sm2Interval: result.interval,
          sm2Ease: result.easeFactor,
        }
      })
    )
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
      // 截断保护 token 上限
      const sourceMaterial = fulltext.slice(0, 10000)

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
          exampleEn: w.exampleEn || '',
          exampleZh: w.exampleZh || '',
          root: '',
          sourceDoi: selectedPaper,
          status: 'new',
          addedAt: now,
          lastReview: 0,
          reviewCount: 0,
          sm2Interval: 1,
          sm2Ease: 2.5,
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
          onReview={reviewWord}
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
  onReview: (id: string, quality: number) => void
}

function WordSection({ words, setWords, studyStats, onReview }: WordSectionProps) {
  const BATCH_SIZE = 7
  const [currentIndex, setCurrentIndex] = useState(0)
  const [currentType, setCurrentType] = useState<QuestionType>('word')
  const [randomMode, setRandomMode] = useState<boolean>(false)
  const [enabledTypes, setEnabledTypes] = useState<QuestionType[]>(['word', 'spelling', 'listening', 'zhToEn', 'enToZh'])
  const [randomQuestionMode, setRandomQuestionMode] = useState<boolean>(false)
  const [questionTypeForWord, setQuestionTypeForWord] = useState<QuestionType>('word')
  const [showSettings, setShowSettings] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const autoNextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const studyWords = useMemo(() => {
    const due = words.filter(w => w.status !== 'mastered')
    const pool = due.length > 0 ? due : words
    return pool.slice(0, BATCH_SIZE)
  }, [words])

  const currentWord = studyWords[currentIndex % Math.max(studyWords.length, 1)]

  // 从 GitHub 私库恢复单词学习进度
  useEffect(() => {
    let cancelled = false
    async function loadWordProgress() {
      try {
        const saved = await loadProgress()
        if (cancelled) return
        const idx = saved.wordCurrentIndex ?? 0
        const wordId = saved.wordCurrentId ?? null
        const type = (saved.wordCurrentType as QuestionType) || 'word'
        const random = saved.wordRandomMode ?? false
        const enabled = (saved.wordEnabledTypes as QuestionType[]) || ['word', 'spelling', 'listening', 'zhToEn', 'enToZh']
        // 优先用保存的单词 ID 在词表中定位；找不到再回退到索引
        let restoredIdx = idx
        if (wordId) {
          const foundIdx = studyWords.findIndex((w) => w.id === wordId)
          if (foundIdx >= 0) restoredIdx = foundIdx
        }
        const safeIdx = Math.max(0, Math.min(restoredIdx, Math.max(studyWords.length - 1, 0)))
        setCurrentIndex(safeIdx)
        setCurrentType(type)
        setRandomMode(random)
        setEnabledTypes(enabled)
      } catch (err) {
        console.error('[Learn] WordSection 加载进度失败:', err)
      }
    }
    loadWordProgress()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    updateProgress({ wordCurrentIndex: currentIndex })
    if (currentWord?.id) {
      updateProgress({ wordCurrentId: currentWord.id })
    }
  }, [currentIndex, currentWord?.id])

  useEffect(() => {
    updateProgress({ wordCurrentType: currentType })
  }, [currentType])

  useEffect(() => {
    updateProgress({ wordRandomMode: randomMode })
  }, [randomMode])

  useEffect(() => {
    updateProgress({ wordEnabledTypes: enabledTypes })
  }, [enabledTypes])

  useEffect(() => {
    if (randomQuestionMode && enabledTypes.length > 0) {
      const randomType = enabledTypes[Math.floor(Math.random() * enabledTypes.length)]
      setQuestionTypeForWord(randomType)
    } else {
      setQuestionTypeForWord(enabledTypes.includes(currentType) ? currentType : (enabledTypes[0] || 'word'))
    }
  }, [currentIndex, randomQuestionMode, enabledTypes, currentType])

  useEffect(() => {
    return () => {
      if (autoNextTimerRef.current) {
        clearTimeout(autoNextTimerRef.current)
      }
    }
  }, [])

  const goToNext = useCallback(() => {
    setShowDetail(false)
    if (autoNextTimerRef.current) {
      clearTimeout(autoNextTimerRef.current)
      autoNextTimerRef.current = null
    }
    const len = Math.max(studyWords.length, 1)
    if (randomMode) {
      let nextIndex = Math.floor(Math.random() * len)
      while (nextIndex === currentIndex && len > 1) {
        nextIndex = Math.floor(Math.random() * len)
      }
      setCurrentIndex(nextIndex)
    } else {
      setCurrentIndex((i) => (i + 1) % len)
    }
  }, [randomMode, studyWords.length, currentIndex])

  const handlePrev = () => {
    setShowDetail(false)
    if (autoNextTimerRef.current) {
      clearTimeout(autoNextTimerRef.current)
      autoNextTimerRef.current = null
    }
    const len = Math.max(studyWords.length, 1)
    setCurrentIndex((i) => (i - 1 + len) % len)
  }

  const handleMastered = () => {
    const wordId = currentWord?.id
    if (!wordId) return
    setWords((prev) =>
      prev.map((w) =>
        w.id === wordId ? { ...w, status: w.status === 'mastered' ? 'learning' : 'mastered' } : w
      )
    )
    toast.success(currentWord?.status === 'mastered' ? '已取消掌握标记' : '已标记为已掌握')
  }

  const handleAddWord = (word: WordData) => {
    setWords((prev) => [...prev, word])
    setShowAddModal(false)
    toast.success('单词已添加')
  }

  const handleCorrect = useCallback(() => {
    if (currentWord) {
      onReview(currentWord.id, 4)

      const isFirstTime = currentWord.reviewCount === 0
      if (isFirstTime) {
        setTimeout(() => {
          setShowDetail(true)
        }, 500)
      } else {
        autoNextTimerRef.current = setTimeout(() => {
          goToNext()
        }, 800)
      }
    }
  }, [currentWord, onReview, goToNext])

  const handleWrong = useCallback(() => {
    if (currentWord) {
      onReview(currentWord.id, 1)
      setTimeout(() => {
        setShowDetail(true)
      }, 800)
    }
  }, [currentWord, onReview])

  const toggleType = (type: QuestionType) => {
    setEnabledTypes((prev) => {
      if (prev.includes(type)) {
        if (prev.length === 1) return prev
        return prev.filter((t) => t !== type)
      }
      return [...prev, type]
    })
  }

  const activeQuestionType = useMemo(() => {
    if (showDetail) return 'detail'
    return questionTypeForWord
  }, [showDetail, questionTypeForWord])

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
      </div>
    )
  }

  return (
    <div className="relative">
      <div className="bg-white rounded-xl border border-slate-200 p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-4">
            <div className="text-sm">
              <span className="text-slate-500">今日学习：</span>
              <span className="font-semibold text-indigo-600">{studyStats.todayLearned.length}</span>
              <span className="text-slate-400"> 词</span>
            </div>
            <div className="text-sm">
              <span className="text-slate-500">累计学习：</span>
              <span className="font-semibold text-slate-700">{studyStats.totalLearned.length}</span>
              <span className="text-slate-400"> 词</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-indigo-600 hover:bg-indigo-50 rounded-lg transition"
            >
              <Plus className="w-4 h-4" />
              添加
            </button>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`p-1.5 rounded-lg transition ${
                showSettings ? 'bg-indigo-100 text-indigo-600' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
              }`}
            >
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="w-full bg-slate-100 rounded-full h-2 mb-3">
          <div
            className="bg-indigo-600 h-2 rounded-full transition-all"
            style={{ width: `${((currentIndex + 1) / Math.max(studyWords.length, 1)) * 100}%` }}
          />
        </div>

        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>本批进度：{currentIndex + 1} / {studyWords.length}（共 {words.length} 词）</span>
          <span>当前单词：{currentWord?.word}</span>
        </div>
      </div>

      {showSettings && (
        <div className="bg-white rounded-xl border border-slate-200 p-4 mb-4">
          <div className="text-sm font-medium text-slate-700 mb-3">当前题型</div>
          <div className="flex flex-wrap gap-2 mb-4">
            {questionTypes.map((qt) => {
              const Icon = qt.icon
              const isActive = currentType === qt.id
              const isEnabled = enabledTypes.includes(qt.id)
              return (
                <button
                  key={qt.id}
                  onClick={() => {
                    if (isEnabled) {
                      setCurrentType(qt.id)
                    }
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                    isActive
                      ? 'bg-indigo-100 text-indigo-700 border border-indigo-300'
                      : isEnabled
                      ? 'bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100'
                      : 'bg-slate-50 text-slate-300 border border-slate-100 cursor-not-allowed'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {qt.label}
                </button>
              )
            })}
          </div>
          
          <div className="text-sm font-medium text-slate-700 mb-2">启用题型</div>
          <div className="flex flex-wrap gap-2 mb-4">
            {questionTypes.map((qt) => {
              const Icon = qt.icon
              const isEnabled = enabledTypes.includes(qt.id)
              return (
                <button
                  key={qt.id}
                  onClick={() => toggleType(qt.id)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition ${
                    isEnabled
                      ? 'bg-green-50 text-green-700 border border-green-200'
                      : 'bg-slate-50 text-slate-400 border border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {isEnabled ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                  <Icon className="w-3 h-3" />
                  {qt.label}
                </button>
              )
            })}
          </div>

          <div className="space-y-3 pt-3 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-600">随机题型</span>
              <button
                onClick={() => setRandomQuestionMode(!randomQuestionMode)}
                className={`relative w-11 h-6 rounded-full transition ${
                  randomQuestionMode ? 'bg-indigo-600' : 'bg-slate-300'
                }`}
              >
                <div
                  className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                    randomQuestionMode ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-600">随机单词顺序</span>
              <button
                onClick={() => setRandomMode(!randomMode)}
                className={`relative w-11 h-6 rounded-full transition ${
                  randomMode ? 'bg-indigo-600' : 'bg-slate-300'
                }`}
              >
                <div
                  className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                    randomMode ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          </div>
        </div>
      )}

      {!showDetail && currentWord && (
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden mb-4">
          {activeQuestionType === 'word' && (
            <WordQuestion
              key={currentWord.id + '-word'}
              word={currentWord}
              words={words}
              onCorrect={handleCorrect}
              onWrong={handleWrong}
            />
          )}
          {activeQuestionType === 'spelling' && (
            <SpellingQuestion
              key={currentWord.id + '-spelling'}
              word={currentWord}
              onCorrect={handleCorrect}
              onWrong={handleWrong}
            />
          )}
          {activeQuestionType === 'listening' && (
            <ListeningQuestion
              key={currentWord.id + '-listening'}
              word={currentWord}
              words={words}
              onCorrect={handleCorrect}
              onWrong={handleWrong}
            />
          )}
          {activeQuestionType === 'zhToEn' && (
            <ZhToEnQuestion
              key={currentWord.id + '-zhtoen'}
              word={currentWord}
              onCorrect={handleCorrect}
              onWrong={handleWrong}
            />
          )}
          {activeQuestionType === 'enToZh' && (
            <EnToZhQuestion
              key={currentWord.id + 'entozh'}
              word={currentWord}
              onCorrect={handleCorrect}
              onWrong={handleWrong}
            />
          )}
        </div>
      )}

      {showDetail && currentWord && (
        <WordDetail
          word={currentWord}
          onNext={goToNext}
          onMastered={handleMastered}
        />
      )}

      <div className="flex items-center justify-center gap-3">
        <button
          onClick={handlePrev}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 transition"
        >
          <ChevronLeft className="w-4 h-4" />
          上一题
        </button>
        <button
          onClick={handleMastered}
          className={`flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-sm font-medium transition ${
            currentWord?.status === 'mastered'
              ? 'bg-green-100 text-green-700 hover:bg-green-200'
              : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          <Check className="w-4 h-4" />
          {currentWord?.status === 'mastered' ? '已掌握' : '掌握'}
        </button>
        <button
          onClick={goToNext}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition"
        >
          下一题
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {showAddModal && <AddWordModal onClose={() => setShowAddModal(false)} onAdd={handleAddWord} />}
    </div>
  )
}

interface QuestionProps {
  word: WordData
  words: WordData[]
  onCorrect: () => void
  onWrong: () => void
}

function WordQuestion({ word, words, onCorrect, onWrong }: QuestionProps) {
  const [selectedOption, setSelectedOption] = useState<string | null>(null)
  const [showResult, setShowResult] = useState(false)

  const options = useMemo(() => {
    const otherMeanings = words
      .filter((w) => w.id !== word.id)
      .map((w) => w.meaning)
    const shuffledOthers = shuffleArray(otherMeanings).slice(0, 3)
    return shuffleArray([word.meaning, ...shuffledOthers])
  }, [word, words])

  const handleSelect = (option: string) => {
    if (showResult) return
    setSelectedOption(option)
    setShowResult(true)
    if (option === word.meaning) {
      onCorrect()
      toast.success('回答正确！')
    } else {
      onWrong()
      toast.error('回答错误')
    }
  }

  const isCorrect = selectedOption === word.meaning

  return (
    <div className="p-6">
      <div className="text-xs font-medium text-slate-400 mb-3 flex items-center gap-1.5">
        <BookOpen className="w-3.5 h-3.5" />
        单词选择题
      </div>

      <div className="text-center py-8 mb-6">
        <h2 className="text-4xl font-bold text-slate-800 mb-3">{word.word}</h2>
        <p className="text-base text-slate-400">{word.phonetic}</p>
      </div>

      <p className="text-center text-sm text-slate-600 mb-4">请选择正确的中文释义</p>

      <div className="grid grid-cols-2 gap-3 max-w-md mx-auto">
        {options.map((option) => {
          const isSelected = selectedOption === option
          const isCorrectAnswer = option === word.meaning
          let btnClass = 'bg-white border-slate-200 text-slate-700 hover:border-indigo-400 hover:bg-indigo-50'
          if (showResult) {
            if (isCorrectAnswer) {
              btnClass = 'bg-green-50 border-green-500 text-green-700'
            } else if (isSelected) {
              btnClass = 'bg-red-50 border-red-500 text-red-700'
            } else {
              btnClass = 'bg-slate-50 border-slate-200 text-slate-400'
            }
          }
          return (
            <button
              key={option}
              onClick={() => handleSelect(option)}
              disabled={showResult}
              className={`p-4 rounded-xl border-2 text-sm font-medium transition ${btnClass}`}
            >
              {option}
            </button>
          )
        })}
      </div>

      {showResult && (
        <div className="mt-6 flex flex-col items-center gap-2">
          <div className={`flex items-center gap-2 ${isCorrect ? 'text-green-600' : 'text-red-500'}`}>
            {isCorrect ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
            <span className="font-medium">{isCorrect ? '回答正确！' : '回答错误'}</span>
          </div>
          {!isCorrect && (
            <p className="text-sm text-slate-500">
              正确答案：<span className="font-semibold text-indigo-600">{word.meaning}</span>
            </p>
          )}
        </div>
      )}
    </div>
  )
}

interface SpellingProps {
  word: WordData
  onCorrect: () => void
  onWrong: () => void
}

function SpellingQuestion({ word, onCorrect, onWrong }: SpellingProps) {
  const [spelledLetters, setSpelledLetters] = useState<string[]>([])
  const [shuffledLetters, setShuffledLetters] = useState<string[]>([])
  const [spellingCorrect, setSpellingCorrect] = useState<boolean | null>(null)
  const [hasAnswered, setHasAnswered] = useState(false)

  useEffect(() => {
    setSpelledLetters([])
    setSpellingCorrect(null)
    setHasAnswered(false)
    setShuffledLetters(shuffleArray(word.word.split('')))
  }, [word.id, word.word])

  const handleLetterClick = (letter: string, index: number) => {
    if (spellingCorrect !== null) return
    const newSpelled = [...spelledLetters, letter]
    setSpelledLetters(newSpelled)
    const newShuffled = [...shuffledLetters]
    newShuffled.splice(index, 1)
    setShuffledLetters(newShuffled)

    if (newSpelled.length === word.word.length) {
      const isCorrect = newSpelled.join('').toLowerCase() === word.word.toLowerCase()
      setSpellingCorrect(isCorrect)
      setHasAnswered(true)
      if (isCorrect) {
        onCorrect()
        toast.success('拼写正确！')
      } else {
        onWrong()
        toast.error('拼写错误')
      }
    }
  }

  const handleUndoLetter = () => {
    if (spelledLetters.length === 0 || spellingCorrect !== null) return
    const lastLetter = spelledLetters[spelledLetters.length - 1]
    setSpelledLetters(spelledLetters.slice(0, -1))
    setShuffledLetters([...shuffledLetters, lastLetter])
    setSpellingCorrect(null)
  }

  const handleResetSpelling = () => {
    setSpelledLetters([])
    setShuffledLetters(shuffleArray(word.word.split('')))
    setSpellingCorrect(null)
    setHasAnswered(false)
  }

  return (
    <div className="p-6">
      <div className="text-xs font-medium text-slate-400 mb-3 flex items-center gap-1.5">
        <SpellCheck className="w-3.5 h-3.5" />
        拼写题
      </div>

      <div className="text-center mb-6">
        <p className="text-sm text-slate-400 mb-2">根据释义拼写单词</p>
        <p className="text-2xl text-indigo-600 font-semibold mb-2">{word.meaning}</p>
        <p className="text-sm text-slate-400">{word.phonetic}</p>
      </div>

      <div className="flex justify-center gap-2 mb-6 min-h-[3.5rem]">
        {word.word.split('').map((_, i) => {
          const letter = spelledLetters[i] || ''
          const isCorrectLetter = spellingCorrect === true
          const isWrongLetter = spellingCorrect === false && letter && letter.toLowerCase() !== word.word[i].toLowerCase()
          return (
            <div
              key={i}
              className={`w-11 h-14 flex items-center justify-center text-xl font-bold rounded-lg border-2 transition ${
                letter
                  ? isCorrectLetter
                    ? 'bg-green-50 border-green-400 text-green-700'
                    : isWrongLetter
                    ? 'bg-red-50 border-red-400 text-red-700'
                    : 'bg-indigo-50 border-indigo-400 text-indigo-700'
                  : 'bg-white border-slate-200'
              }`}
            >
              {letter}
            </div>
          )
        })}
      </div>

      <div className="flex justify-center flex-wrap gap-2 mb-6 max-w-md mx-auto">
        {shuffledLetters.map((letter, i) => (
          <button
            key={`${letter}-${i}`}
            onClick={() => handleLetterClick(letter, i)}
            disabled={spellingCorrect !== null}
            className="w-11 h-11 flex items-center justify-center text-lg font-semibold bg-white border-2 border-slate-200 rounded-lg text-slate-700 hover:border-indigo-400 hover:bg-indigo-50 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {letter}
          </button>
        ))}
      </div>

      <div className="flex justify-center gap-3 mb-4">
        <button
          onClick={handleUndoLetter}
          disabled={spelledLetters.length === 0 || spellingCorrect !== null}
          className="flex items-center gap-1.5 px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="w-4 h-4" />
          撤销
        </button>
        <button
          onClick={handleResetSpelling}
          className="flex items-center gap-1.5 px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 transition"
        >
          <Shuffle className="w-4 h-4" />
          重排
        </button>
      </div>

      {hasAnswered && (
        <div className="mt-4 flex flex-col items-center gap-2">
          <div className={`flex items-center gap-2 ${spellingCorrect ? 'text-green-600' : 'text-red-500'}`}>
            {spellingCorrect ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
            <span className="font-medium">
              {spellingCorrect ? '拼写正确！' : `正确答案：${word.word}`}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function ListeningQuestion({ word, words, onCorrect, onWrong }: QuestionProps) {
  const [selectedOption, setSelectedOption] = useState<string | null>(null)
  const [showResult, setShowResult] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)

  const options = useMemo(() => {
    const otherWords = words
      .filter((w) => w.id !== word.id)
      .map((w) => w.word)
    const shuffledOthers = shuffleArray(otherWords).slice(0, 3)
    return shuffleArray([word.word, ...shuffledOthers])
  }, [word, words])

  const playPronunciation = () => {
    setIsPlaying(true)
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(word.word)
      utterance.lang = 'en-US'
      utterance.rate = 0.8
      utterance.onend = () => setIsPlaying(false)
      utterance.onerror = () => setIsPlaying(false)
      speechSynthesis.speak(utterance)
    } else {
      setTimeout(() => setIsPlaying(false), 1000)
    }
  }

  const handleSelect = (option: string) => {
    if (showResult) return
    setSelectedOption(option)
    setShowResult(true)
    if (option === word.word) {
      onCorrect()
      toast.success('回答正确！')
    } else {
      onWrong()
      toast.error('回答错误')
    }
  }

  const isCorrect = selectedOption === word.word

  return (
    <div className="p-6">
      <div className="text-xs font-medium text-slate-400 mb-3 flex items-center gap-1.5">
        <Volume2 className="w-3.5 h-3.5" />
        听音辨词
      </div>

      <div className="flex flex-col items-center py-8 mb-6">
        <button
          onClick={playPronunciation}
          disabled={isPlaying}
          className="w-24 h-24 rounded-full bg-indigo-100 hover:bg-indigo-200 flex items-center justify-center transition disabled:opacity-70"
        >
          <Volume2 className={`w-10 h-10 text-indigo-600 ${isPlaying ? 'animate-pulse' : ''}`} />
        </button>
        <p className="text-sm text-slate-500 mt-4">点击播放发音</p>
        <p className="text-xs text-slate-400 mt-1">选择你听到的单词</p>
      </div>

      <div className="grid grid-cols-2 gap-3 max-w-md mx-auto">
        {options.map((option) => {
          const isSelected = selectedOption === option
          const isCorrectAnswer = option === word.word
          let btnClass = 'bg-white border-slate-200 text-slate-700 hover:border-indigo-400 hover:bg-indigo-50'
          if (showResult) {
            if (isCorrectAnswer) {
              btnClass = 'bg-green-50 border-green-500 text-green-700'
            } else if (isSelected) {
              btnClass = 'bg-red-50 border-red-500 text-red-700'
            } else {
              btnClass = 'bg-slate-50 border-slate-200 text-slate-400'
            }
          }
          return (
            <button
              key={option}
              onClick={() => handleSelect(option)}
              disabled={showResult}
              className={`p-4 rounded-xl border-2 text-sm font-medium transition ${btnClass}`}
            >
              {option}
            </button>
          )
        })}
      </div>

      {showResult && (
        <div className="mt-6 flex flex-col items-center gap-2">
          <div className={`flex items-center gap-2 ${isCorrect ? 'text-green-600' : 'text-red-500'}`}>
            {isCorrect ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
            <span className="font-medium">{isCorrect ? '回答正确！' : '回答错误'}</span>
          </div>
          {!isCorrect && (
            <p className="text-sm text-slate-500">
              正确答案：<span className="font-semibold text-indigo-600">{word.word}</span>
              <span className="text-slate-400 ml-2">{word.meaning}</span>
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ZhToEnQuestion({ word, onCorrect, onWrong }: Omit<QuestionProps, 'words'>) {
  const [inputValue, setInputValue] = useState('')
  const [showResult, setShowResult] = useState(false)
  const [isCorrect, setIsCorrect] = useState(false)

  const blankPos = useMemo(() => getBlankPosition(word.exampleZh, word.meaning), [word])

  const sentenceWithBlank = useMemo(() => {
    if (blankPos === -1) return { before: word.exampleZh, blank: '', after: '' }
    return {
      before: word.exampleZh.slice(0, blankPos),
      blank: word.meaning,
      after: word.exampleZh.slice(blankPos + word.meaning.length),
    }
  }, [word, blankPos])

  const handleSubmit = () => {
    if (!inputValue.trim()) {
      toast.error('请填写答案')
      return
    }
    const correct = inputValue.trim().toLowerCase() === word.word.toLowerCase()
    setIsCorrect(correct)
    setShowResult(true)
    if (correct) {
      onCorrect()
      toast.success('回答正确！')
    } else {
      onWrong()
      toast.error('回答错误')
    }
  }

  return (
    <div className="p-6">
      <div className="text-xs font-medium text-slate-400 mb-3 flex items-center gap-1.5">
        <PenTool className="w-3.5 h-3.5" />
        中译英
      </div>

      <p className="text-sm text-slate-500 mb-4 text-center">根据中文句子，填写正确的英文单词</p>

      <div className="bg-slate-50 rounded-xl p-5 mb-6">
        <p className="text-lg text-slate-700 leading-relaxed text-center">
          {sentenceWithBlank.before}
          <span className="inline-block mx-1 px-3 py-0.5 bg-indigo-100 text-indigo-700 rounded font-medium">
            {sentenceWithBlank.blank || '____'}
          </span>
          {sentenceWithBlank.after}
        </p>
      </div>

      <div className="max-w-md mx-auto">
        <div className="flex gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !showResult && handleSubmit()}
            disabled={showResult}
            placeholder="请输入英文单词..."
            className={`flex-1 px-4 py-3 border-2 rounded-xl text-base focus:outline-none transition ${
              showResult
                ? isCorrect
                  ? 'border-green-500 bg-green-50'
                  : 'border-red-500 bg-red-50'
                : 'border-slate-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100'
            }`}
          />
          {!showResult ? (
            <button
              onClick={handleSubmit}
              className="px-6 py-3 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition"
            >
              提交
            </button>
          ) : null}
        </div>

        {showResult && (
          <div className="mt-4 flex flex-col items-center gap-2">
            <div className={`flex items-center gap-2 ${isCorrect ? 'text-green-600' : 'text-red-500'}`}>
              {isCorrect ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
              <span className="font-medium">{isCorrect ? '回答正确！' : '回答错误'}</span>
            </div>
            {!isCorrect && (
              <p className="text-sm text-slate-500">
                正确答案：<span className="font-semibold text-indigo-600">{word.word}</span>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function EnToZhQuestion({ word, onCorrect, onWrong }: Omit<QuestionProps, 'words'>) {
  const [inputValue, setInputValue] = useState('')
  const [showResult, setShowResult] = useState(false)
  const [isCorrect, setIsCorrect] = useState(false)

  const blankPos = useMemo(() => getBlankPosition(word.exampleEn, word.word), [word])

  const sentenceWithBlank = useMemo(() => {
    if (blankPos === -1) return { before: word.exampleEn, blank: '', after: '' }
    return {
      before: word.exampleEn.slice(0, blankPos),
      blank: word.word,
      after: word.exampleEn.slice(blankPos + word.word.length),
    }
  }, [word, blankPos])

  const handleSubmit = () => {
    if (!inputValue.trim()) {
      toast.error('请填写答案')
      return
    }
    const correct = inputValue.trim() === word.meaning
    setIsCorrect(correct)
    setShowResult(true)
    if (correct) {
      onCorrect()
      toast.success('回答正确！')
    } else {
      onWrong()
      toast.error('回答错误')
    }
  }

  return (
    <div className="p-6">
      <div className="text-xs font-medium text-slate-400 mb-3 flex items-center gap-1.5">
        <MessageSquare className="w-3.5 h-3.5" />
        英译中
      </div>

      <p className="text-sm text-slate-500 mb-4 text-center">根据英文句子，填写划线单词的中文释义</p>

      <div className="bg-slate-50 rounded-xl p-5 mb-6">
        <p className="text-lg text-slate-700 leading-relaxed text-center">
          {sentenceWithBlank.before}
          <span className="inline-block mx-1 px-3 py-0.5 bg-indigo-100 text-indigo-700 rounded font-medium">
            {sentenceWithBlank.blank || '____'}
          </span>
          {sentenceWithBlank.after}
        </p>
      </div>

      <div className="max-w-md mx-auto">
        <div className="flex gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !showResult && handleSubmit()}
            disabled={showResult}
            placeholder="请输入中文释义..."
            className={`flex-1 px-4 py-3 border-2 rounded-xl text-base focus:outline-none transition ${
              showResult
                ? isCorrect
                  ? 'border-green-500 bg-green-50'
                  : 'border-red-500 bg-red-50'
                : 'border-slate-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100'
            }`}
          />
          {!showResult ? (
            <button
              onClick={handleSubmit}
              className="px-6 py-3 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition"
            >
              提交
            </button>
          ) : null}
        </div>

        {showResult && (
          <div className="mt-4 flex flex-col items-center gap-2">
            <div className={`flex items-center gap-2 ${isCorrect ? 'text-green-600' : 'text-red-500'}`}>
              {isCorrect ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
              <span className="font-medium">{isCorrect ? '回答正确！' : '回答错误'}</span>
            </div>
            {!isCorrect && (
              <p className="text-sm text-slate-500">
                正确答案：<span className="font-semibold text-indigo-600">{word.meaning}</span>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface WordDetailProps {
  word: WordData
  onNext: () => void
  onMastered: () => void
}

function WordDetail({ word, onNext, onMastered }: WordDetailProps) {
  const playPronunciation = () => {
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(word.word)
      utterance.lang = 'en-US'
      utterance.rate = 0.8
      speechSynthesis.speak(utterance)
    }
  }

  return (
    <div className="bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden mb-4">
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div className="text-xs font-medium text-indigo-500 flex items-center gap-1.5">
            <BookOpen className="w-3.5 h-3.5" />
            单词详解
          </div>
          <button
            onClick={onMastered}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
              word.status === 'mastered'
                ? 'bg-green-100 text-green-700'
                : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
            }`}
          >
            <Check className="w-3.5 h-3.5" />
            {word.status === 'mastered' ? '已掌握' : '标记掌握'}
          </button>
        </div>

        <div className="text-center mb-8">
          <h2 className="text-4xl font-bold text-slate-800 mb-2">{word.word}</h2>
          <div className="flex items-center justify-center gap-3 mb-3">
            <p className="text-base text-slate-400">{word.phonetic}</p>
            <button
              onClick={playPronunciation}
              className="p-1.5 rounded-full hover:bg-slate-100 transition text-indigo-500"
            >
              <Volume2 className="w-5 h-5" />
            </button>
          </div>
          <p className="text-2xl text-indigo-600 font-semibold">{word.meaning}</p>
        </div>

        <div className="space-y-4 max-w-lg mx-auto">
          <div className="bg-slate-50 rounded-xl p-4">
            <div className="text-xs font-medium text-slate-400 mb-2 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" />
              例句
            </div>
            <p className="text-sm text-slate-700 mb-2">{word.exampleEn}</p>
            <p className="text-sm text-slate-500">{word.exampleZh}</p>
          </div>

          {word.root && (
            <div className="bg-amber-50 rounded-xl p-4">
              <div className="text-xs font-medium text-amber-600 mb-1">词根词缀</div>
              <p className="text-sm text-amber-800">{word.root}</p>
            </div>
          )}

          <div className="bg-blue-50 rounded-xl p-4">
            <div className="text-xs font-medium text-blue-600 mb-2">学习记录</div>
            <div className="flex flex-wrap gap-4 text-sm">
              <div>
                <span className="text-blue-500">复习次数：</span>
                <span className="text-blue-700 font-medium">{word.reviewCount}</span>
              </div>
              <div>
                <span className="text-blue-500">上次学习：</span>
                <span className="text-blue-700 font-medium">{formatTime(word.lastReview)}</span>
              </div>
              <div>
                <span className="text-blue-500">学习状态：</span>
                <span className="text-blue-700 font-medium">{word.status === 'mastered' ? '已掌握' : word.status === 'learning' ? '学习中' : word.status}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="border-t border-slate-100 p-6">
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={onNext}
            className="flex items-center gap-1.5 px-8 py-3 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 transition shadow-sm"
          >
            下一题
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
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
  const [exampleEn, setExampleEn] = useState('')
  const [exampleZh, setExampleZh] = useState('')
  const [root, setRoot] = useState('')

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
      exampleEn: exampleEn.trim() || '',
      exampleZh: exampleZh.trim() || '',
      root: root.trim(),
      sourceDoi: '',
      status: 'learning',
      addedAt: Date.now(),
      lastReview: 0,
      reviewCount: 0,
      sm2Interval: 0,
      sm2Ease: 2.5,
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
            <label className="block text-sm font-medium text-slate-700 mb-1">词根词缀</label>
            <input
              type="text"
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder="例如：photo- (光) + voltaic (电流的)"
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
