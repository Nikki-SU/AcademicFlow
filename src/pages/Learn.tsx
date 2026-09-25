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
  Headphones,
  Sparkles,
  Settings,
  PenTool,
  MessageSquare,
  FileText,
  Loader2,
  Square,
  Pencil,
  History,
  AlertCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { loadWords, saveWords, loadSentences, saveSentences, loadTranslations, saveTranslations, loadAffixes, parseMorphemes, isValidMorphemeSplit, MORPHEME_TYPE_LABELS } from '../services/learningData'
import { useSettingsStore } from '../stores/settings'
import { useWorkspaceStore } from '../stores/workspace'
import type { WordData, SentenceData, TranslationData, TranslationDirection, AffixData, Morpheme } from '../services/learningData'
import { loadProgress, updateProgress } from '../services/learningProgress'
import { runDualEngine } from '../services/ai/dual-engine'
import { callAI } from '../services/ai/client'
import { isAbortError } from '../services/ai/abort'
import { loadLiteratures, loadAiSourceText, type Literature } from '../services/literatureData'

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
  | 'listen_select_cn' // 听音（只放音，不显示单词）→ 选中文释义（需语音模式）
  | 'cn_select_sound'  // 中文释义 → 选读音（每个选项挂小喇叭逐个试听，需语音模式）
  | 'spell_block'      // 拼写：给中文，按词素块拼出英文（拆不出词素时退化成单字母块）

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
  { key: 'listen_select_cn', label: '听音选中', icon: Volume2 },
  { key: 'cn_select_sound', label: '中选读音', icon: Headphones },
  { key: 'spell_block', label: '拼写', icon: Pencil },
]

const ALL_QUESTION_TYPES: WordQuestionType[] = WORD_QUESTION_TYPES.map((t) => t.key)

/**
 * 依赖发音的题型 —— 静音模式下**不可用**：
 * 听音选中要先把单词放出来，中选读音要逐个试听选项。
 */
const VOICE_ONLY_TYPES: WordQuestionType[] = ['listen_select_cn', 'cn_select_sound']

/** 后面才加的题型：以前存下的设置列表里不可能有它们，读回时补上 */
const NEW_QUESTION_TYPES: WordQuestionType[] = ['listen_select_cn', 'cn_select_sound', 'spell_block']

/**
 * 题面就是**英文单词本身**的题型才配"读题面"的喇叭。
 * 中文题面（中选英 / 定义选英 / 中选读音）拿英文音库去读只会读出乱音；
 * 中选读音更是靠"逐个试听选项"作答，题面再挂喇叭只会误导。
 */
const QUESTION_SPEAKABLE_TYPES: WordQuestionType[] = ['en_select_cn', 'en_select_def']

/**
 * 当前语音模式下真正可用的题型。
 * 静音时把听音类剔掉，但**设置里仍保留勾选** —— 切回语音模式即恢复，
 * 不让用户为了"临时静音"重勾一遍。
 */
function availableTypes(selected: WordQuestionType[], voiceOn: boolean): WordQuestionType[] {
  return voiceOn ? selected : selected.filter((t) => !VOICE_ONLY_TYPES.includes(t))
}

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
    // 听音/读音题只要求"有单词 + 有中文释义"：释义是选项或题面
    case 'listen_select_cn': return !!w.word.trim() && hasMeaning
    case 'cn_select_sound': return !!w.word.trim() && hasMeaning
    // 拼写题：单个字母的词没有拼写价值
    case 'spell_block': return !!w.word.trim() && hasMeaning && w.word.trim().length >= 2
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
  /** 拼写题：答案按词素切分成的块（顺序即正确顺序） */
  answerBlocks?: string[]
  /** 拼写题：可点击的块池（答案块 + 干扰块，已打乱） */
  blockPool?: string[]
  /** 中文选读音题：每个选项外面挂一个小喇叭，供逐个试听 */
  optionAudio?: boolean
}

/**
 * 拼写题的"块"：有合法词素切分就按词素切，否则退化成单字母块（整词全拼）。
 * 切分合法 = 各段按顺序拼回来正好等于原词。
 */
function spellBlocksOf(w: WordData): string[] {
  if (isValidMorphemeSplit(w.word, w.morphemes)) return w.morphemes.map((m) => m.text)
  return w.word.trim().split('')
}

/**
 * 拼写题的块池 = 答案块 + 干扰块（打乱后一起给）。
 *
 * 干扰块的来源，按可用性依次取：
 *   1. 同组其它单词的词素 —— 用户说的"这个词库里其他单词的词根词缀"
 *   2. 全库词素表 —— 本组只有几个词时块池会太瘦
 *   3. 随机字母 —— 只对"退化成单字母块"的词生效，否则答案的字母就是全部选项
 * 干扰块一律排除与答案块同形的，免得同一块出现两次造成歧义。
 */
function buildBlockPool(
  answerBlocks: string[],
  word: WordData,
  pool: WordData[],
  affixes: AffixData[],
): string[] {
  const used = new Set(answerBlocks.map((b) => b.toLowerCase()))
  const letters = new Set(word.word.toLowerCase().split(''))
  const distractors: string[] = []
  const push = (v: string) => {
    const t = (v || '').trim()
    if (!t || used.has(t.toLowerCase()) || distractors.includes(t)) return
    distractors.push(t)
  }

  for (const w of shuffleArray(pool.filter((x) => x.id !== word.id))) {
    if (isValidMorphemeSplit(w.word, w.morphemes)) w.morphemes.forEach((m) => push(m.text))
  }
  for (const a of shuffleArray(affixes)) push(a.affix)

  const picked = distractors.slice(0, 6)
  if (answerBlocks.length > 1 && answerBlocks.every((b) => b.length === 1)) {
    for (const ch of shuffleArray('abcdefghijklmnopqrstuvwxyz'.split(''))) {
      if (picked.length >= 6) break
      if (!letters.has(ch)) picked.push(ch)
    }
  }
  return shuffleArray([...answerBlocks, ...picked])
}

/**
 * 生成一道四选一题：1 个正确项 + 最多 3 个干扰项（从同轮可答词池中取，去重去重）。
 * 词池不足时降级为 2~3 个选项。
 * 拼写题不用 options，改用 answerBlocks/blockPool（见 buildBlockPool）。
 */
function buildQuestion(
  word: WordData,
  type: WordQuestionType,
  pool: WordData[],
  mode: 'learn' | 'review',
  affixes: AffixData[] = [],
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
    // 题面只显示"听发音"按钮，单词藏在 question 里给播放用（不渲染出来）
    case 'listen_select_cn':
      question = word.word; answer = word.meaning; break
    case 'cn_select_sound':
      question = word.meaning; answer = word.word; break
    case 'spell_block':
      question = word.meaning; answer = word.word; break
  }
  if (!question.trim() || !answer.trim()) return null

  // 干扰项按"答案字段"取，保证四个选项语义同类
  const answerOf = (w: WordData): string => {
    switch (type) {
      case 'en_select_cn':
      case 'sent_select_cn':
      case 'listen_select_cn': return w.meaning
      case 'cn_select_en':
      case 'def_select_en':
      case 'cn_select_sound':
      case 'spell_block': return w.word
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

  const base: GeneratedWordQuestion = {
    wordId: word.id,
    type,
    typeLabel: typeMeta.label,
    isSentence,
    question,
    options,
    answer,
  }

  if (type === 'spell_block') {
    const answerBlocks = spellBlocksOf(word)
    if (answerBlocks.length < 2) return null
    return { ...base, answerBlocks, blockPool: buildBlockPool(answerBlocks, word, pool, affixes) }
  }
  if (type === 'cn_select_sound') return { ...base, optionAudio: true }
  return base
}

/** SM-2 风格的下次复习间隔：答对一次，间隔按难度系数放大（复习模式用） */
function nextSm2Interval(w: WordData): number {
  return Math.max(1, Math.round((w.sm2Interval || 1) * w.sm2Ease))
}

/** 学习模式完成全部适用题型后的新间隔（艾宾浩斯阶梯：1/2/4/7/15/30 天） */
const LEARN_LADDER = [1, 2, 4, 7, 15, 30]
function nextLearnInterval(w: WordData): number {
  return LEARN_LADDER[Math.min(w.reviewCount, LEARN_LADDER.length - 1)]
}

/** 语音模式：展示卡片时「单词 → 停顿 → 例句」的间隔 */
const SPEECH_GAP_MS = 380

/**
 * 正在朗读的 utterance 必须留引用 —— 部分浏览器会在 GC 时把没引用的
 * utterance 掐断，表现为"读一半停了"。
 */
let liveUtterances: SpeechSynthesisUtterance[] = []

/** 掐掉当前朗读（换题 / 退出会话 / 离开页面时都要调） */
function stopSpeaking() {
  if (typeof speechSynthesis === 'undefined') return
  liveUtterances = []
  speechSynthesis.cancel()
}

/**
 * 顺序连读（如「英文单词 → 停顿 → 英文例句」）。
 *
 * 用 onend 串起来，而不是一口气 speak 多段 —— 浏览器对多段排队的语义并不一致，
 * 后一段的 cancel 把前一段掐掉是常见现象（而且没有 onend 就没法插入停顿）。
 */
function speakSequence(texts: string[]) {
  if (typeof speechSynthesis === 'undefined') return
  const items = texts.map((t) => (t || '').trim()).filter(Boolean)
  if (!items.length) return
  stopSpeaking()
  let i = 0
  const next = () => {
    if (i >= items.length) return
    const u = new SpeechSynthesisUtterance(items[i])
    // 第一段是单词：慢一点，给"记这个词"留时间；后面是例句，按正常语速
    u.lang = 'en-US'
    u.rate = i === 0 ? 0.8 : 0.9
    const advance = () => {
      i += 1
      setTimeout(next, SPEECH_GAP_MS)
    }
    u.onend = advance
    u.onerror = advance
    liveUtterances.push(u)
    speechSynthesis.speak(u)
  }
  next()
}

function speakEnglish(text: string) {
  const t = (text || '').trim()
  if (!t) return
  speakSequence([t])
}

/** 解析 AI-1 输出的学习内容 JSON（容错：去掉代码块包裹 / 提取首尾花括号） */
interface ParsedLearningJSON {
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

// ============================================================
// 长难句 / 翻译练习 共享工具（提取指令、判分、踩分点序列化）
// ============================================================

/**
 * AI 给的词素切分归一 —— 跟后端 runner 同一口径：形状交给 parseMorphemes 清洗，
 * 再要求各段按顺序拼回来正好等于原词，拼不回来就整组丢弃。
 */
function normalizeAiMorphemes(raw: unknown, word: string): Morpheme[] {
  const list = parseMorphemes(Array.isArray(raw) ? JSON.stringify(raw) : undefined)
  return isValidMorphemeSplit(word, list) ? list : []
}

/** AI 返回的数组字段归一：string[] / 分隔符字符串 / 其它 → 干净的 string[] */
function toStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => (x == null ? '' : String(x)).trim()).filter(Boolean)
  }
  if (typeof raw === 'string') {
    return raw.split(/[\n;；]+/).map((s) => s.trim()).filter(Boolean)
  }
  return []
}

/** 字符串数组 → CSV 单元字符串（JSON 数组；空则空串，与 learningData 的解析对齐） */
function listToCsv(list: string[]): string {
  const clean = (list || []).map((s) => s.trim()).filter(Boolean)
  return clean.length ? JSON.stringify(clean) : ''
}

/** CSV 里存回的列表字符串 → string[]（容错 JSON / 旧的分隔符写法） */
function csvToList(raw: string): string[] {
  const t = (raw || '').trim()
  if (!t) return []
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t)
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean)
    } catch {
      // 坏 JSON：退化成按分隔符切
    }
  }
  return t.split(/[\n;；、]+/).map((s) => s.trim()).filter(Boolean)
}

/** 翻译题方向 → 界面标签 */
function directionLabelOf(dir: TranslationDirection | undefined): string {
  return dir === 'cn2en' ? '中译英' : '英译中'
}

interface LearningGenOptions {
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
 * 交互式「AI 补充生成」与「历史批量补提」共用同一套 prompt，保证口径一致。
 *
 * 摘要翻译的题面/参考答案直接来自文献元数据（abstractEn/abstractCn），
 * AI 既不翻译也不产出译文，只需给两个方向的**踩分点** —— 这点必须在 prompt 里说死，
 * 否则模型很容易自作主张去翻译。
 */
function buildLearningInstruction(
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
        `word / phonetic / meaning(中文释义，简短短语) / definitionCn(中文解释，一句话) / ` +
        `definitionEn(英文解释，一句话) / exampleEn(原文中含该词的那句，逐字) / exampleZh(该例句的中文译文) / ` +
        `morphemes(词根词缀切分，见下方规则)`,
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

/** 判分结果（AI 只判分，不参与出标准） */
interface GradeResult {
  score: number
  hitPoints: string[]
  missedPoints: string[]
  /** 每个漏掉的踩分点扣了多少分（AI 给；键 = 踩分点原文） */
  pointDeductions: Record<string, number>
  feedback: string
}

/** 把 AI 回的 point_deductions 归一化成「踩分点 → 扣分」映射（兼容对象/数组两种写法） */
function parsePointDeductions(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  const put = (point: unknown, deduction: unknown) => {
    const key = typeof point === 'string' ? point.trim() : ''
    const num = Number(deduction)
    if (key && Number.isFinite(num) && num > 0) out[key] = Math.round(num)
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>
        put(o.point ?? o.scoring_point ?? o.name, o.deduction ?? o.deduct ?? o.score)
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) put(k, v)
  }
  return out
}

/** 解析判分 JSON（容错去 ```json 包裹 / 截首尾花括号），失败抛可读错误 */
function parseGradeJSON(raw: string): GradeResult {
  let text = (raw || '').trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) text = text.slice(first, last + 1)

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error('AI 判分结果不是合法 JSON，请重试')
  }
  const scoreNum = Number(parsed.score)
  return {
    score: Number.isFinite(scoreNum) ? Math.max(0, Math.min(100, Math.round(scoreNum))) : 0,
    hitPoints: toStringArray(parsed.hit_points),
    missedPoints: toStringArray(parsed.missed_points),
    pointDeductions: parsePointDeductions(parsed.point_deductions),
    feedback: typeof parsed.feedback === 'string' ? parsed.feedback.trim() : '',
  }
}

/**
 * 调用 AI 判分 —— 单次调用即可（不走双引擎）。
 * AI 负责按给定的踩分点清单打分，返回命中/漏掉的踩分点，
 * 并对**每个漏掉的点单独给出扣了多少分**（不同踩分点权重本就不一样，
 * 关键术语漏了比修饰成分漏了严重得多，所以扣分不能一律等权）。
 */
async function gradeTranslationWithAI(params: {
  question: string
  directionLabel: string
  userTranslation: string
  referenceTranslation: string
  scoringPoints: string[]
}): Promise<GradeResult> {
  const { ai1 } = useSettingsStore.getState().getDualEngineConfig()
  const pointList = params.scoringPoints.length
    ? params.scoringPoints.map((p, i) => `${i + 1}. ${p}`).join('\n')
    : '（本题未设置踩分点，请按整体忠实度与表达给分）'

  const resp = await callAI({
    baseUrl: ai1.baseUrl,
    apiKey: ai1.apiKey,
    model: ai1.model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          '你是学术翻译阅卷老师。你的职责只有判分：严格按给定的「踩分点」核对学生的译文，' +
          '指出命中了哪些、漏掉了哪些，对每个漏掉的点给出具体扣分（各点权重可以不同），' +
          '并给出 0-100 的综合得分和简短中文反馈。' +
          '不得自行新增或改写踩分点，也不得重写学生译文。只输出 JSON。',
      },
      {
        role: 'user',
        content: [
          `【翻译方向】${params.directionLabel}`,
          '',
          '【题面原文】',
          params.question,
          '',
          '【参考答案】',
          params.referenceTranslation || '（无）',
          '',
          '【评分标准（踩分点）】',
          pointList,
          '',
          '【学生译文】',
          params.userTranslation,
          '',
          '请严格按上述踩分点核对，并只返回如下 JSON（不要 markdown 代码块包裹）：',
          '{',
          '  "score": 0-100 的整数（= 100 减去所有扣分之和，四舍五入）,',
          '  "hit_points": ["命中的踩分点，逐字取自上面的清单"],',
          '  "missed_points": ["漏掉或表达不到位的踩分点，同样取自清单"],',
          '  "point_deductions": [{"point": "漏掉的踩分点原文（逐字取自清单）", "deduction": 扣的分数（整数，>0）}],',
          '  "feedback": "一段中文反馈，说明扣分原因与改进建议"',
          '}',
          '',
          '扣分要求：每个漏掉的踩分点都要出现在 point_deductions 里；关键术语/逻辑关系的缺失扣得多，',
          '修饰成分、表述不够地道扣得少；各点扣分之和应等于 100 - score。命中的点不要出现在 point_deductions 里。',
        ].join('\n'),
      },
    ],
  })
  return parseGradeJSON(resp.content)
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
function buildTranslationItems(
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

/**
 * 批量补提的串行执行器：逐篇处理、可中断、单篇失败不中断整批。
 * 每篇处理结果由 processOne 决定（内部负责增量落盘）。
 */
async function runBatchExtraction(
  candidates: Literature[],
  processOne: (lit: Literature) => Promise<{ ok: boolean; reason?: string }>,
  ctl: {
    onProgress: (done: number, total: number, title: string) => void
    shouldStop: () => boolean
    onFailure: (title: string, reason: string) => void
  },
): Promise<{ processed: number; failed: number; stopped: boolean }> {
  let processed = 0
  let failed = 0
  for (const lit of candidates) {
    if (ctl.shouldStop()) return { processed, failed, stopped: true }
    ctl.onProgress(processed, candidates.length, lit.title || lit.doi)
    try {
      const r = await processOne(lit)
      if (!r.ok) {
        failed++
        ctl.onFailure(lit.title || lit.doi, r.reason || '未知失败')
      }
    } catch (err) {
      // 用户点了「停止」→ 我们 abort 了这篇正在跑的 AI 任务。这不是这篇文献失败，
      // 整轮就此收尾（已完成的部分已经增量落盘）。
      if (ctl.shouldStop()) return { processed, failed, stopped: true }
      failed++
      ctl.onFailure(lit.title || lit.doi, err instanceof Error ? err.message : String(err))
    }
    processed++
    ctl.onProgress(processed, candidates.length, '')
  }
  return { processed, failed, stopped: false }
}

export default function LearnPage() {
  const { repo } = useWorkspaceStore()
  const [activeTab, setActiveTab] = useState<TabId>('words')
  const [aiGenOpen, setAiGenOpen] = useState(false)
  const [selectedPaper, setSelectedPaper] = useState('')
  const [genTypes, setGenTypes] = useState({ words: true, sentences: true, translation: true })
  const [literatures, setLiteratures] = useState<Literature[]>([])
  const [isAiGenerating, setIsAiGenerating] = useState(false)
  /** 「AI 补充生成」的取消句柄 */
  const aiGenAbortRef = useRef<AbortController | null>(null)

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

    const settingsState = useSettingsStore.getState()
    const wordCount = settingsState.wordGenCount || 15
    const sentenceCount = settingsState.sentenceGenCount || 8
    const abstractEn = (lit.abstractEn || '').trim()
    const abstractCn = (lit.abstractCn || '').trim()
    // 摘要翻译题面/参考答案来自文献元数据的摘要（不需要 md）。
    // 只靠 DOI 元数据入库的文献通常只有英文摘要：这种时候英译中照样出题
    // （中文参考答案由 AI 补），中译英因为缺中文题面而出不了 —— 有哪边出哪边。
    const canTranslate = !!abstractEn || !!abstractCn
    if (genTypes.translation && !canTranslate) {
      toast.error('该文献没有摘要，无法生成摘要翻译题（摘要翻译来自文献元数据，不需要 md）')
      return
    }

    setIsAiGenerating(true)
    // 「停止」用它断掉正在进行的两段式生成，不再接收后端输出
    const controller = new AbortController()
    aiGenAbortRef.current = controller
    try {
      // 1. 解析双引擎配置
      const { ai1, ai2 } = settingsState.getDualEngineConfig()

      // 2. 加载文献正文作为源材料（长难句/单词依赖正文）。
      //    取清洗后的原文块，不用 MinerU 的脏 full.md —— 句子是从这里逐字抽的。
      //    纯摘要翻译不需要 md，此时不强制要求正文。
      let fulltext = ''
      try {
        fulltext = await loadAiSourceText(selectedPaper)
      } catch (err) {
        console.warn('[Learn] 加载文献正文失败:', err)
      }
      const needsFulltext = genTypes.words || genTypes.sentences
      if (!fulltext.trim() && needsFulltext) {
        // 兜底：用摘要作为源材料
        fulltext = [abstractEn, abstractCn].filter(Boolean).join('\n\n')
      }
      const sourceMaterial =
        fulltext.trim() || [abstractEn, abstractCn].filter(Boolean).join('\n\n') || '（文献无可用全文）'

      // 3. 构造生成指令（与历史批量补提共用同一套 prompt）
      const ai1Instruction = buildLearningInstruction(
        {
          words: genTypes.words,
          sentences: genTypes.sentences,
          translation: genTypes.translation,
          wordCount,
          sentenceCount,
        },
        { en: abstractEn, cn: abstractCn },
      )

      // 4. 调用双引擎：AI-1 生成 + AI-2 核查 + 引证锚定 + 分层归因重试
      const result = await runDualEngine({
        taskType: 'faithfulness_check',
        sourceMaterial,
        ai1Instruction,
        ai1,
        ai2,
        signal: controller.signal,
      })

      // 5. 解析 AI-1 输出的 JSON
      const ai1Output = result.ai1Output || ''
      const parsed = parseLearningJSON(ai1Output)

      const now = Date.now()
      let addedCount = 0

      if (genTypes.words && parsed.words.length > 0) {
        const newWords: WordData[] = parsed.words.slice(0, wordCount).map((w) => ({
          id: `ai_${now}_${addedCount++}`,
          word: w.word || '',
          phonetic: w.phonetic || '',
          meaning: w.meaning || '',
          // 中文解释与中文释义是两回事：释义是答题用的短词，解释是一句话。
          // AI 没给解释时退回释义 —— 至少不让「定义」类题型缺字段。
          definitionCn: w.definitionCn || w.meaning || '',
          definitionEn: w.definitionEn || '',
          exampleEn: w.exampleEn || '',
          exampleZh: w.exampleZh || '',
          morphemes: normalizeAiMorphemes(w.morphemes, w.word || ''),
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
        const newSentences: SentenceData[] = parsed.sentences
          .filter((s) => (s.sentenceEn || '').trim())
          .slice(0, sentenceCount)
          .map((s) => ({
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
            scoringPoints: toStringArray(s.scoring_points),
            difficultyNote: (s.difficulty_note || '').trim() || undefined,
            latestUserTranslation: '',
            latestAiFeedback: '',
            latestErrorWords: '',
            practiceCount: 0,
            lastPractice: 0,
          }))
        setSentences((prev) => [...prev, ...newSentences])
      }

      if (genTypes.translation && canTranslate) {
        // AI 只产出踩分点；若摘要缺一边，还会在 reference_translation 里补该方向的参考译文
        const pointsByDirection: Partial<Record<TranslationDirection, string[]>> = {}
        const referenceOverride: Partial<Record<TranslationDirection, string>> = {}
        for (const t of parsed.translations) {
          const dir: TranslationDirection | null =
            t.direction === 'cn2en' ? 'cn2en' : t.direction === 'en2cn' ? 'en2cn' : null
          if (dir) pointsByDirection[dir] = toStringArray(t.scoring_points)
          const ref = (t.reference_translation || '').trim()
          if (dir && ref) referenceOverride[dir] = ref
        }
        const newTranslations = buildTranslationItems(lit, pointsByDirection, now, `ai_${now}_`, referenceOverride)
        setTranslations((prev) => [...prev, ...newTranslations])
        addedCount += newTranslations.length
      }

      // AI-2 什么都不返回 ≠ AI-2 判定不忠实 —— 前者多半是输出预算被推理烧穿，
      // 报成"未通过"会把用户引去怀疑材料，其实是模型自己哑了。分开说。
      const lastAttempt = result.attempts[result.attempts.length - 1]
      const ai2Silent = lastAttempt?.ai2Silent ?? !(lastAttempt?.ai2RawOutput || '').trim()
      const reviewNote = result.finalPassed
        ? 'AI-2 审阅通过'
        : ai2Silent
          ? `AI-2 这一轮没有任何输出（第 ${result.attempts.length} 轮），内容按 AI-1 原样收下了，建议人工扫一眼`
          : `AI-2 审阅未通过：${result.ai2Feedback.summary || '存在忠实性问题，请人工核对'}`
      toast.success(`AI 生成完成（${addedCount} 条），${reviewNote}`)
      setAiGenOpen(false)
    } catch (err) {
      if (isAbortError(err)) {
        toast.info('已停止 AI 生成')
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`AI 生成失败：${msg}`)
    } finally {
      aiGenAbortRef.current = null
      setIsAiGenerating(false)
    }
  }

  return (
    <div className="page-container py-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-ink-800 flex items-center gap-2">
            <GraduationCap className="w-6 h-6 text-seal-600" />
            学习
          </h1>
          <p className="text-sm text-ink-500 mt-1">PDF 入库转换为 Markdown 时自动生成学习内容，也可手动添加</p>
        </div>
        <button
          onClick={() => setAiGenOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-seal-600 to-purple-600 text-paper-50 rounded-lg text-sm font-medium hover:from-seal-700 hover:to-purple-700 transition shadow-sm"
        >
          <Sparkles className="w-4 h-4" />
          AI 补充生成
        </button>
      </div>

      <div className="flex items-center gap-1 mb-6 bg-paper-50 rounded-lg border border-ink-200 p-1 w-fit">
        {subTabs.map((tab) => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-medium transition ${
                activeTab === tab.id
                  ? 'bg-seal-50 text-seal-700'
                  : 'text-ink-500 hover:text-ink-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          )
        })}
      </div>

      {aiGenOpen && (
        <div className="fixed inset-0 bg-ink-900/40 flex items-center justify-center z-50 p-4">
          <div className="bg-paper-50 rounded-xl shadow-2xl w-full max-w-md p-6">
            <h3 className="text-lg font-semibold text-ink-800 mb-4 flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-seal-600" />
              AI 补充生成学习内容
            </h3>
            <p className="text-sm text-ink-500 mb-4">
              从选定文献的 Markdown 内容中自动提取并生成学习卡片
            </p>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium text-ink-700 mb-1.5 block">选择文献</label>
                <select
                  value={selectedPaper}
                  onChange={(e) => setSelectedPaper(e.target.value)}
                  className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
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
                <label className="text-sm font-medium text-ink-700 mb-2 block">生成类型</label>
                <div className="space-y-2">
                  {[
                    { key: 'words', label: '单词卡片', icon: Brain },
                    { key: 'sentences', label: '长难句', icon: Type },
                    { key: 'translation', label: '翻译练习', icon: Languages },
                  ].map((item) => {
                    const Icon = item.icon
                    const checked = genTypes[item.key as keyof typeof genTypes]
                    return (
                      <label key={item.key} className="flex items-center gap-3 p-2 rounded-lg hover:bg-paper-100 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => setGenTypes((prev) => ({ ...prev, [item.key]: e.target.checked }))}
                          className="rounded text-seal-600 focus:ring-seal-500"
                        />
                        <Icon className="w-4 h-4 text-ink-500" />
                        <span className="text-sm text-ink-700">{item.label}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => { if (isAiGenerating) { aiGenAbortRef.current?.abort(); return } setAiGenOpen(false) }}
                className="flex-1 px-4 py-2 text-sm font-medium text-ink-600 bg-ink-100 hover:bg-ink-200 rounded-lg transition"
              >
                {isAiGenerating ? '停止' : '取消'}
              </button>
              <button
                onClick={handleAIGenerate}
                disabled={isAiGenerating}
                className="flex-1 px-4 py-2 text-sm font-medium text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-lg transition flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
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
      {activeTab === 'sentences' && <SentenceSection sentences={sentences} setSentences={setSentences} literatures={literatures} />}
      {activeTab === 'translation' && <TranslationSection translations={translations} setTranslations={setTranslations} literatures={literatures} />}
    </div>
  )
}

/**
 * 挑出下一组要学的单词。
 *
 * 抽成纯函数是为了「一组学完自动进下一组」：推进到下一组时必须拿**最新**的
 * 单词状态来挑（刚学完的那批已从 learning 变成 learned），否则会反复挑到同一批词。
 */
function pickStudyQueue(all: WordData[], mode: 'learn' | 'review', queueLength: number): WordData[] {
  if (mode === 'learn') {
    // CAT：learning 优先，new 补齐
    const learningWords = all.filter((w) => w.status === 'learning').sort((a, b) => a.addedAt - b.addedAt)
    const newWords = all.filter((w) => w.status === 'new').sort((a, b) => a.addedAt - b.addedAt)
    return [...learningWords, ...newWords].slice(0, queueLength)
  }
  return all
    .filter((w) => w.status === 'learned' && w.lastReview > 0 && w.lastReview + (w.sm2Interval || 1) * DAY_MS <= Date.now())
    .sort((a, b) => a.lastReview - b.lastReview)
    .slice(0, 20)
}

interface WordSectionProps {
  words: WordData[]
  setWords: React.Dispatch<React.SetStateAction<WordData[]>>
  studyStats: StudyStats
  onStudied: (wordId: string) => void
}

/** 单词学习设置（对齐 CAT：队列长度 / 题型多选 / 掌握所需轮数 / 斩词 / 发音） */
interface WordStudySettings {
  queueLength: number
  /** 走满多少轮算掌握 —— 一轮 = 把选中的题型各答对一遍 */
  masterRounds: number
  questionTypes: WordQuestionType[]
  allowZhan: boolean
  voiceEnabled: boolean
  /** 每日目标（词数）：学满就收尾，当天不再自动续组 */
  dailyGoal: number
}

const DEFAULT_WORD_SETTINGS: WordStudySettings = {
  queueLength: 5,
  masterRounds: 3,
  // 默认全选 —— 新加的听音/拼写题型若不进默认值，用户根本见不到它们
  questionTypes: [...ALL_QUESTION_TYPES],
  allowZhan: true,
  voiceEnabled: true,
  dailyGoal: 20,
}

/** 「每日目标」可选的词数 */
const DAILY_GOAL_OPTIONS = [10, 20, 30, 50]

/** 「掌握条件」可选的轮数（走满这么多轮才算掌握） */
const MASTER_ROUND_OPTIONS = [3, 5, 7]

/** 开始页把两种模式说清楚：语音模式下卡片会连读，听音类题型也才可选 */
const VOICE_MODE_OPTIONS: { on: boolean; label: string; hint: string }[] = [
  { on: true, label: '语音模式', hint: '卡片自动连读「单词 → 例句」' },
  { on: false, label: '静音模式', hint: '不出声，听音类题型不可用' },
]

/**
 * 学习会话状态（移植自 CAT StudySession）
 * - queue：本组单词 id，跨所有题型轮次固定
 * - retryId：**待重做的错题**。答错就把这个词记在这里，卡片关掉后立刻重出同一道题
 *            （同一个词、同一个题型）；答对才清掉继续往下走。
 * - askedOnce：本会话已经出过题的词。learn 模式下第一次出题的词，答完要把卡片亮出来。
 * - correctTypes：每个词**本轮**已答对的题型；全部适用题型答对 = 走完一轮
 */
interface StudySession {
  mode: 'learn' | 'review'
  queue: string[]
  typeIdx: number
  wordIdx: number
  retryId: string | null
  correctTypes: Record<string, string[]>
  askedOnce: string[]
  correctCount: number
  wrongCount: number
  masteredCount: number
}

const DAY_MS = 86_400_000

function WordSection({ words, setWords, studyStats, onStudied }: WordSectionProps) {
  const [settings, setSettings] = useState<WordStudySettings>(DEFAULT_WORD_SETTINGS)
  /** 设置是否已从私库读回来 —— 读完之前不许回写，免得用默认值盖掉用户的偏好 */
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)

  const [session, setSession] = useState<StudySession | null>(null)
  const [question, setQuestion] = useState<GeneratedWordQuestion | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [answered, setAnswered] = useState(false)
  const [showCard, setShowCard] = useState(false)
  /** 拼写题：已点选的字块在 blockPool 里的下标（按位置，可含重复值） */
  const [spellPicked, setSpellPicked] = useState<number[]>([])
  /** 当前这道题是不是"本会话第一次遇到这个词" —— 是的话答完要亮卡片（先测后看） */
  const [firstAsk, setFirstAsk] = useState(false)
  const [finished, setFinished] = useState<StudySession | null>(null)
  const [nowTick, setNowTick] = useState(Date.now())
  /** 词素表：拼写题的干扰块池（词库大了，本组词素不够用） */
  const [affixes, setAffixes] = useState<AffixData[]>([])
  /** 答对后自动跳下一题的定时器（退出会话/卸载时清理） */
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 单词卡滚动时间戳：滚动后 250ms 内的点击视为滚动误触，不触发翻页（借鉴快速刷题流） */
  const cardScrollAtRef = useRef(0)
  /**
   * 「本组最后一个题型也轮完了」→ 记下下一组要用哪个模式，等这次渲染提交后
   * 再挑下一组（那时 words 才是最新的；在推进回调里直接挑会拿到旧状态）。
   * 期间渲染一个占位，避免闪一下首页。
   */
  const [pendingAuto, setPendingAuto] = useState<'learn' | 'review' | null>(null)
  /** 最近一组的学习统计 —— 只在"今天真的学完了"时才拿去渲染完成页 */
  const lastSessionRef = useRef<StudySession | null>(null)

  useEffect(() => () => {
    if (autoTimer.current) clearTimeout(autoTimer.current)
    // 离开学习页时别让朗读继续念（组件卸载 / 切走路由）
    stopSpeaking()
  }, [])

  // 词素表：只在拼写题需要干扰块时才有用，读失败不影响主流程
  useEffect(() => {
    let cancelled = false
    loadAffixes()
      .then((list) => { if (!cancelled) setAffixes(list) })
      .catch(() => { /* 没有词素表也能出拼写题，只是块池小一点 */ })
    return () => { cancelled = true }
  }, [])

  // 每分钟刷新一次"待复习"判断
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const byId = useMemo(() => new Map(words.map((w) => [w.id, w])), [words])

  /**
   * 本轮实际可用的题型。
   * 会话里的 typeIdx 全部以它为基准（出题 / 推进 / 轮次显示 / 掌握判定），
   * 这样静音模式剔掉听音类之后，下标不会错位。
   */
  const activeTypes = useMemo(
    () => availableTypes(settings.questionTypes, settings.voiceEnabled),
    [settings.questionTypes, settings.voiceEnabled],
  )

  // ── 语音：卡片展开时连读「英文单词 → 停顿 → 英文例句」 ──
  // 只在卡片上读、不在答题前读：答题前读例句等于把挖空题的答案念出来。
  useEffect(() => {
    if (!settings.voiceEnabled || !showCard || !question) return
    const w = byId.get(question.wordId)
    if (w) speakSequence([w.word, w.exampleEn])
    // 只认"卡片是否展开 + 当前是哪道题"：byId 会随答题写回而换身份，
    // 进了依赖会导致同一张卡反复朗读。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCard, question?.wordId, settings.voiceEnabled])

  // ── 语音：听音选中文要靠"放音"出题，题目一换就自动放一次 ──
  useEffect(() => {
    if (!settings.voiceEnabled || showCard || !question) return
    if (question.type === 'listen_select_cn') speakEnglish(question.question)
  }, [question, showCard, settings.voiceEnabled])

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
  // 先读回用户上次的选择，读完才把 settingsLoaded 置真。下面的回写 effect 必须等它 ——
  // 否则组件一挂载就拿**默认值**回写一次，而首次从私库读取一旦慢过 2s 的防抖窗口，
  // 这次回写就会把用户存好的偏好覆盖掉（之后再靠读回的值自愈，但中间是真丢过）。
  useEffect(() => {
    let cancelled = false
    loadProgress().then((p) => {
      if (cancelled) return
      const savedTypes = Array.isArray(p.wordQuestionTypes)
        ? p.wordQuestionTypes.filter((t): t is WordQuestionType =>
            WORD_QUESTION_TYPES.some((wt) => wt.key === t))
        : []
      // 新加的题型对"以前存下的列表"无从表态：不补进去，老用户永远看不到它们
      const mergedTypes = savedTypes.length
        ? [...savedTypes, ...NEW_QUESTION_TYPES.filter((t) => !savedTypes.includes(t))]
        : []
      const ql = p.wordQueueLength
      const mr = p.wordMasterRounds
      const dg = p.wordDailyGoal
      setSettings((prev) => ({
        queueLength: ql !== undefined && [5, 7, 9].includes(ql) ? ql : prev.queueLength,
        masterRounds: mr !== undefined && MASTER_ROUND_OPTIONS.includes(mr) ? mr : prev.masterRounds,
        questionTypes: mergedTypes.length > 0 ? mergedTypes : prev.questionTypes,
        allowZhan: typeof p.wordAllowZhan === 'boolean' ? p.wordAllowZhan : prev.allowZhan,
        voiceEnabled: typeof p.wordVoiceEnabled === 'boolean' ? p.wordVoiceEnabled : prev.voiceEnabled,
        dailyGoal: dg !== undefined && dg > 0 ? dg : prev.dailyGoal,
      }))
      setSettingsLoaded(true)
    }).catch(() => setSettingsLoaded(true))
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!settingsLoaded) return
    void updateProgress({
      wordQueueLength: settings.queueLength,
      wordMasterRounds: settings.masterRounds,
      wordQuestionTypes: settings.questionTypes,
      wordAllowZhan: settings.allowZhan,
      wordVoiceEnabled: settings.voiceEnabled,
      wordDailyGoal: settings.dailyGoal,
    })
  }, [settings, settingsLoaded])

  // ── 出题 / 会话推进 ──

  /**
   * 根据会话当前指针出题，并重置答题 UI。
   *
   * 一轮（一个题型轮）的顺序 = 把这组词按顺序各出一题。某道题答错，卡片关掉后**立刻重做**
   * 同一个词、同一个题型（见 retryId），做对了才继续往下；答对就按 wordIdx 走下一个词。
   * 本轮全部走完才换下一个题型。
   * 卡片改为"答完才亮"：不再有开头的预展卡（先测后看），见 submitAnswer。
   */
  const presentQuestion = useCallback((s: StudySession) => {
    // 换题先掐掉上一题的朗读，免得听音题的发音跟下一题叠在一起
    stopSpeaking()
    const type = activeTypes[s.typeIdx]
    if (!type) {
      // 静音模式可能把当前这一轮题型整轮剔掉（设置变了之类的边角情形）：安全收尾
      setFinished(s)
      setSession(null)
      setQuestion(null)
      return
    }
    const pool = s.queue.map((id) => byId.get(id)).filter((w): w is WordData => !!w)
    const eligible = pool.filter((w) => isWordEligible(w, type, s.mode))
    // 有待重做的错题时优先它；否则按 wordIdx 走第一遍
    const wid = s.retryId ?? eligible[s.wordIdx]?.id
    if (!wid) {
      // 理论上不该发生：安全收尾
      setFinished(s)
      setSession(null)
      setQuestion(null)
      return
    }
    const w = byId.get(wid)
    const q = w ? buildQuestion(w, type, eligible, s.mode, affixes) : null
    if (!q) {
      setFinished(s)
      setSession(null)
      setQuestion(null)
      return
    }
    // 本会话第一次见这个词（仅 learn 模式）→ 答完之后要把卡片亮出来给用户看
    const isFirst = s.mode === 'learn' && !s.askedOnce.includes(wid)
    if (isFirst) s = { ...s, askedOnce: [...s.askedOnce, wid] }
    setSession(s)
    setQuestion(q)
    setSelected(null)
    setAnswered(false)
    setSpellPicked([])
    setFirstAsk(isFirst)
    setShowCard(false)
  }, [byId, activeTypes, affixes])

  /**
   * 起一组（不弹提示）。成功返回 true。
   * 「一组学完自动进下一组」和用户手点「开始学习」共用它 —— 前者不该弹任何提示。
   */
  const beginSession = useCallback((mode: 'learn' | 'review', allWords: WordData[]): boolean => {
    const queue = pickStudyQueue(allWords, mode, settings.queueLength)
    if (queue.length === 0) return false
    // 选第一个对这组词"有题可出"的题型
    let typeIdx = -1
    activeTypes.some((t, i) => {
      if (queue.some((w) => isWordEligible(w, t, mode))) { typeIdx = i; return true }
      return false
    })
    if (typeIdx < 0) return false
    setFinished(null)
    presentQuestion({
      mode,
      queue: queue.map((w) => w.id),
      typeIdx,
      wordIdx: 0,
      retryId: null,
      correctTypes: {},
      askedOnce: [],
      correctCount: 0,
      wrongCount: 0,
      masteredCount: 0,
    })
    return true
  }, [settings.queueLength, activeTypes, presentQuestion])

  /** 推进到下一题：本轮还有下一个词就走，走完则切下一个"有题可出"的题型 */
  const advance = useCallback((s: StudySession) => {
    const types = activeTypes
    const pool = s.queue.map((id) => byId.get(id)).filter((w): w is WordData => !!w)
    const eligibleNow = pool.filter((w) => isWordEligible(w, types[s.typeIdx], s.mode))

    // 本轮还没走完 → 下一词（错题已在 handleNext 里就地重做过，这里不会漏题）
    if (s.wordIdx < eligibleNow.length - 1) {
      presentQuestion({ ...s, wordIdx: s.wordIdx + 1, retryId: null })
      return
    }
    // 本轮清空 → 切下一个"有题可出"的题型
    for (let ni = s.typeIdx + 1; ni < types.length; ni++) {
      const eligibleNext = pool.filter((w) => isWordEligible(w, types[ni], s.mode))
      if (eligibleNext.length > 0) {
        presentQuestion({ ...s, typeIdx: ni, wordIdx: 0, retryId: null })
        return
      }
    }
    // 全部题型轮完 → **直接进下一组**，不弹"本组学习完成"总结页（那会打断心流）。
    // 这里只登记"该起下一组了"，真正的挑选放到提交后的 effect 里（那时 words 才是最新的）。
    lastSessionRef.current = s
    setSession(null)
    setQuestion(null)
    setPendingAuto(s.mode)
  }, [byId, activeTypes, presentQuestion])

  const startSession = useCallback((mode: 'learn' | 'review') => {
    if (!beginSession(mode, words)) {
      toast.error(mode === 'learn' ? '暂无可学习的新词' : '暂无到期复习的单词')
    }
  }, [beginSession, words])

  /**
   * 一组学完 → 自动起下一组；起不来（今天确实没有可学的词了）才落到完成页。
   * 放在 effect 里是为了拿到这次提交后的最新 words。
   *
   * 今日目标（dailyGoal）达成也在这里收尾 —— 学满目标就不再自动续组，
   * 但用户仍可在完成页手动「再来一组」多学。
   */
  useEffect(() => {
    if (!pendingAuto) return
    const mode = pendingAuto
    setPendingAuto(null)
    if (studyStats.todayLearned.length >= settings.dailyGoal) {
      setFinished(lastSessionRef.current)
      return
    }
    if (!beginSession(mode, words)) setFinished(lastSessionRef.current)
  }, [pendingAuto, words, beginSession, studyStats.todayLearned.length, settings.dailyGoal])

  /** 选中即判定（无确认按钮）：对 → 短暂高亮后自动下一题；错 → 弹单词卡 */
  const submitAnswer = useCallback((option: string) => {
    if (!session || !question || answered) return
    const isCorrect = option === question.answer
    const wid = question.wordId
    const now = Date.now()
    setSelected(option)
    setAnswered(true)

    if (isCorrect) {
      const doneTypes = Array.from(new Set([...(session.correctTypes[wid] || []), question.type]))
      const correctTypes = { ...session.correctTypes, [wid]: doneTypes }
      const masterRounds = settings.masterRounds
      const mode = session.mode
      const selectedTypes = activeTypes

      // 先用当前词数据算好新状态（避免在 setState 更新器里做计数副作用）
      const cur = byId.get(wid)
      let nextWord: WordData | null = null
      let masteredNow = false
      if (cur) {
        let next: WordData = { ...cur, streak: cur.streak + 1 }
        // 走完一轮 = 这个词把本轮选中的、且它适用的题型各答对了一遍。
        // 掌握以「轮次」计量：走满 masterRounds 轮才算掌握，单个题型答得再顺也不算。
        const applicable = selectedTypes.filter((t) => isWordEligible(cur, t, mode))
        if (applicable.every((t) => doneTypes.includes(t))) {
          const rounds = cur.reviewCount + 1
          masteredNow = rounds >= masterRounds && cur.status !== 'mastered'
          next = {
            ...next,
            reviewCount: rounds,
            lastReview: now,
            status: rounds >= masterRounds ? 'mastered' : 'learned',
            // 下一次该隔多久再复习：复习模式按 SM-2 放大，学习模式走艾宾浩斯阶梯
            sm2Interval: mode === 'review' ? nextSm2Interval(cur) : nextLearnInterval(cur),
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
        // 答对就清掉重做标记，回到正常推进
        retryId: null,
        correctTypes,
        correctCount: session.correctCount + 1,
        masteredCount: session.masteredCount + (masteredNow ? 1 : 0),
      }
      setSession(nextSession)
      if (firstAsk) {
        // 本会话第一次遇到这个词：答完把卡片亮出来（先测后看），点一下再继续
        setShowCard(true)
      } else {
        // 答对：绿色反馈 800ms 后自动下一题（无需点击）
        if (autoTimer.current) clearTimeout(autoTimer.current)
        autoTimer.current = setTimeout(() => {
          autoTimer.current = null
          advance(nextSession)
        }, 800)
      }
    } else {
      // 答错：streak 清零、wrong_count+1，并把这个词挂成"待重做" ——
      // 卡片关掉后立刻重出同一个词、同一个题型，做对才继续往下
      setWords((prev) => prev.map((w) =>
        w.id === wid
          ? { ...w, streak: 0, wrongCount: w.wrongCount + 1, status: 'learning' }
          : w,
      ))
      setShowCard(true)
      setSession({
        ...session,
        retryId: wid,
        wrongCount: session.wrongCount + 1,
      })
    }
  }, [session, question, answered, firstAsk, settings.masterRounds, activeTypes, setWords, onStudied, byId, advance])

  /** 看完卡片后继续：答错的那道题就地重做，其余按正常顺序推进 */
  const handleNext = useCallback(() => {
    if (!session) return
    if (session.retryId) {
      presentQuestion(session)
      return
    }
    advance(session)
  }, [session, advance, presentQuestion])

  /** 斩词：直接标记掌握，清掉待重做标记 */
  const handleZhan = useCallback(() => {
    if (!question) return
    const wid = question.wordId
    setWords((prev) => prev.map((w) =>
      w.id === wid
        // 斩词 = 用户说"这个词我会了"：轮次直接记满，跟正常走满轮次掌握保持一致
        ? { ...w, status: 'mastered', reviewCount: Math.max(w.reviewCount, settings.masterRounds) }
        : w,
    ))
    toast.success('已斩词，标记为掌握')
    if (session) {
      advance({
        ...session,
        retryId: session.retryId === wid ? null : session.retryId,
        masteredCount: session.masteredCount + 1,
      })
    }
  }, [question, session, setWords, settings.masterRounds, advance])

  const exitSession = useCallback(() => {
    if (autoTimer.current) { clearTimeout(autoTimer.current); autoTimer.current = null }
    stopSpeaking()
    setSession(null)
    setQuestion(null)
    setFinished(null)
    setPendingAuto(null)
    lastSessionRef.current = null
    setShowCard(false)
    setAnswered(false)
    setSpellPicked([])
  }, [])

  // ── 拼写题：点击字块拼词（凑满答案块数即自动判定） ──
  /** 点一个字块 → 追加到答案槽；槽填满就提交 */
  const pickBlock = useCallback((blockIdx: number) => {
    if (!question?.answerBlocks || !question.blockPool) return
    if (answered || showCard) return
    if (spellPicked.includes(blockIdx)) return
    const next = [...spellPicked, blockIdx]
    setSpellPicked(next)
    if (next.length === question.answerBlocks.length) {
      submitAnswer(next.map((i) => question.blockPool![i]).join(''))
    }
  }, [question, answered, showCard, spellPicked, submitAnswer])

  /** 点已填的槽 → 把它取下来（后面的槽依次前移，保持"填满即判定"的语义） */
  const removeBlockAt = useCallback((slot: number) => {
    if (answered || showCard) return
    setSpellPicked((prev) => prev.filter((_, i) => i !== slot))
  }, [answered, showCard])

  const undoBlock = useCallback(() => {
    if (answered || showCard) return
    setSpellPicked((prev) => prev.slice(0, -1))
  }, [answered, showCard])

  const handleAddWord = (word: WordData) => {
    setWords((prev) => [...prev, word])
    setShowAddModal(false)
    toast.success('单词已添加')
  }

  // ── 空状态 ──
  if (words.length === 0) {
    return (
      <div className="text-center py-16">
        <Brain className="w-16 h-16 text-ink-300 mx-auto mb-4" />
        <p className="text-ink-500 mb-4">还没有单词，快来添加吧！</p>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2 bg-seal-600 text-paper-50 rounded-lg text-sm font-medium hover:bg-seal-700 transition"
        >
          添加单词
        </button>
        {showAddModal && <AddWordModal onClose={() => setShowAddModal(false)} onAdd={handleAddWord} />}
      </div>
    )
  }

  // ── 换组过渡：一组刚学完、正在起下一组的空档（别闪首页） ──
  if (pendingAuto && !session) {
    return (
      <div className="text-center py-16 text-ink-400 text-sm">继续下一组…</div>
    )
  }

  // ── 会话结束总结 ──
  if (finished) {
    return (
      <div className="max-w-md mx-auto pt-10">
        <div className="bg-paper-50 rounded-xl border border-ink-200 p-8 text-center">
          <GraduationCap className="w-14 h-14 text-seal-500 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-ink-800 mb-1">
            {finished.mode === 'learn' ? '今日学习完成' : '今日复习完成'}
          </h3>
          <p className="text-sm text-ink-500 mb-2">
            {studyStats.todayLearned.length >= settings.dailyGoal
              ? `今日目标达成：已学 ${studyStats.todayLearned.length} / ${settings.dailyGoal} 词`
              : `今天可学的词已学完（今日已学 ${studyStats.todayLearned.length} 词）`}
          </p>
          <p className="text-xs text-ink-400 mb-6">
            最后一组 {finished.queue.length} 词：答对 {finished.correctCount} 次 · 答错 {finished.wrongCount} 次
            {finished.masteredCount > 0 ? ` · 新掌握 ${finished.masteredCount} 词` : ''}
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => startSession(finished.mode)}
              className="flex-1 py-3 bg-seal-600 text-paper-50 rounded-lg text-sm font-medium hover:bg-seal-700 transition"
            >
              再来一组
            </button>
            <button
              onClick={exitSession}
              className="flex-1 py-3 bg-ink-100 text-ink-600 rounded-lg text-sm font-medium hover:bg-ink-200 transition"
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
    const currentType = activeTypes[session.typeIdx]
    const pool = session.queue.map((id) => byId.get(id)).filter((w): w is WordData => !!w)
    const eligible = pool.filter((w) => isWordEligible(w, currentType, session.mode))
    const isRetry = session.retryId !== null
    const currentWord = byId.get(question.wordId)
    const progressPct = ((isRetry ? session.wordIdx : session.wordIdx + 1) / Math.max(eligible.length, 1)) * 100

    return (
      <div className="space-y-4">
        {/* 顶部状态 */}
        <div className="bg-paper-50 rounded-xl border border-ink-200 p-4">
          <div className="flex items-center justify-between text-sm text-ink-500 mb-2">
            <span>
              第 {session.wordIdx + 1}/{eligible.length} 题 · 第 {session.typeIdx + 1}/{activeTypes.length} 轮
            </span>
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 bg-seal-50 text-seal-700 rounded text-xs font-medium">
                {question.typeLabel}
              </span>
              {isRetry && <span className="px-2 py-0.5 bg-red-50 text-red-600 rounded text-xs">重做</span>}
              {session.mode === 'review' && (
                <span className="px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded text-xs">复习</span>
              )}
            </div>
          </div>
          <div className="w-full h-2 bg-ink-100 rounded-full overflow-hidden">
            <div className="h-2 bg-seal-600 rounded-full transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        </div>

        {/* 题目卡 */}
        <div className="bg-paper-50 rounded-xl border border-ink-200 p-6">
          <div className="text-center mb-6 min-h-[4rem] flex items-center justify-center">
            {question.isSentence ? (
              <p className="text-lg text-ink-800 leading-relaxed text-left">
                {question.question.split('_____').map((part, i, arr) => (
                  <span key={i}>
                    {part}
                    {i < arr.length - 1 && <span className="font-bold text-seal-600 mx-0.5">_____</span>}
                  </span>
                ))}
              </p>
            ) : question.type === 'listen_select_cn' ? (
              /* 听音题：题面不写单词，只给"放音"按钮 —— 写了就等于把答案给人看 */
              <div className="text-center">
                <button
                  type="button"
                  onClick={() => speakEnglish(question.question)}
                  disabled={showCard}
                  className="w-20 h-20 rounded-full bg-seal-50 text-seal-600 hover:bg-seal-100 transition flex items-center justify-center mx-auto disabled:opacity-40"
                  title="再听一遍"
                >
                  <Volume2 className="w-9 h-9" />
                </button>
                <p className="mt-3 text-xs text-ink-400">听发音，选出正确的中文释义（点喇叭可重听）</p>
              </div>
            ) : question.type === 'spell_block' ? (
              /* 拼写题：题面是中文，读英文就等于报答案，所以这里没有喇叭 */
              <div className="text-center">
                <h2 className="text-2xl font-bold text-ink-800">{question.question}</h2>
                <p className="mt-2 text-xs text-ink-400">按顺序点字块，拼出对应的英文单词</p>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-3">
                <h2 className="text-3xl font-bold text-ink-800 break-all">{question.question}</h2>
                {settings.voiceEnabled && QUESTION_SPEAKABLE_TYPES.includes(question.type) && (
                  <button
                    onClick={() => speakEnglish(question.question)}
                    className="p-2 text-ink-400 hover:text-seal-600 transition"
                    title="朗读"
                  >
                    <Volume2 className="w-5 h-5" />
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 作答区：拼写题点字块，其余是四选一（选中即判定，无确认按钮） */}
          {question.type === 'spell_block' && question.answerBlocks && question.blockPool ? (
            <div className="space-y-4">
              {/* 答案槽：一个词素一个槽，块数即槽数 */}
              <div className="flex flex-wrap justify-center gap-2">
                {question.answerBlocks.map((_, slot) => {
                  const bi = spellPicked[slot]
                  const filled = bi !== undefined
                  let slotCls = 'min-w-[2.75rem] h-11 px-2 rounded-lg border-2 flex items-center justify-center text-base font-semibold transition '
                  if (answered) {
                    slotCls += selected === question.answer
                      ? 'border-green-500 bg-green-50 text-green-800'
                      : 'border-red-500 bg-red-50 text-red-800'
                  } else if (filled) {
                    slotCls += 'border-seal-400 bg-seal-50 text-seal-700 cursor-pointer'
                  } else {
                    slotCls += 'border-dashed border-ink-300 bg-paper-50 text-ink-300'
                  }
                  return (
                    <button
                      key={slot}
                      type="button"
                      onClick={() => removeBlockAt(slot)}
                      disabled={answered || showCard || !filled}
                      className={slotCls}
                      title={filled ? '点一下取下来' : undefined}
                    >
                      {filled ? question.blockPool![bi] : '·'}
                    </button>
                  )
                })}
              </div>

              {/* 块池：点一块填一个槽 */}
              <div className="flex flex-wrap justify-center gap-2 pt-3 border-t border-ink-100">
                {question.blockPool.map((block, j) => {
                  const used = spellPicked.includes(j)
                  return (
                    <button
                      key={`${block}-${j}`}
                      type="button"
                      onClick={() => pickBlock(j)}
                      disabled={used || answered || showCard}
                      className={`px-3 py-2 rounded-lg border text-sm font-medium transition ${
                        used
                          ? 'border-ink-200 bg-paper-100 text-ink-300 cursor-default'
                          : 'border-ink-300 bg-paper-50 text-ink-700 hover:border-seal-400 hover:bg-seal-50/40'
                      } disabled:cursor-not-allowed`}
                    >
                      {block}
                    </button>
                  )
                })}
              </div>

              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={undoBlock}
                  disabled={answered || showCard || spellPicked.length === 0}
                  className="px-4 py-1.5 text-xs text-ink-500 bg-ink-100 hover:bg-ink-200 rounded-lg transition disabled:opacity-40"
                >
                  撤销上一个
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {question.options.map((option, idx) => {
                const isSelected = selected === option
                const isCorrectOpt = answered && option === question.answer
                const isWrongPick = answered && isSelected && option !== question.answer
                // 色彩语义（借鉴快速刷题流）：答对→选中项绿；答错→错选红 + 正解橙提示
                const isPickedCorrect = isCorrectOpt && isSelected
                const isMissedCorrect = isCorrectOpt && !isSelected
                let cls = 'flex-1 min-w-0 p-3.5 text-left rounded-lg border transition flex items-center gap-3 '
                if (answered) {
                  if (isPickedCorrect) cls += 'bg-green-50 border-green-500 text-green-800'
                  else if (isWrongPick) cls += 'bg-red-50 border-red-500 text-red-800'
                  else if (isMissedCorrect) cls += 'bg-amber-50 border-amber-500 text-amber-800'
                  else cls += 'bg-paper-100 border-ink-200 text-ink-400'
                } else {
                  cls += 'bg-paper-50 border-ink-300 text-ink-700 hover:border-seal-400 hover:bg-seal-50/40 cursor-pointer'
                }
                return (
                  // 中选读音题要在**每个选项外面**挂小喇叭：喇叭不能压在选项按钮里，
                  // 否则点喇叭会被当成"选了这一项"直接提交。
                  <div key={`${option}-${idx}`} className="flex items-stretch gap-2">
                    {question.optionAudio && (
                      <button
                        type="button"
                        onClick={() => speakEnglish(option)}
                        className="shrink-0 w-11 rounded-lg border border-ink-200 bg-paper-50 text-ink-400 hover:text-seal-600 hover:border-seal-300 transition flex items-center justify-center"
                        title="试听这个读音"
                      >
                        <Volume2 className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => submitAnswer(option)}
                      disabled={answered || showCard}
                      className={cls}
                    >
                      <span className={`shrink-0 w-7 h-7 rounded-full text-center leading-7 text-sm font-bold ${
                        isPickedCorrect ? 'bg-green-500 text-paper-50'
                          : isWrongPick ? 'bg-red-500 text-paper-50'
                          : isMissedCorrect ? 'bg-amber-500 text-paper-50'
                          : 'bg-ink-100 text-ink-500'
                      }`}>
                        {String.fromCharCode(65 + idx)}
                      </span>
                      <span className="text-sm leading-snug">{option}</span>
                    </button>
                  </div>
                )
              })}
            </div>
          )}

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
              className="px-4 py-3 bg-ink-100 text-ink-500 rounded-lg text-sm font-medium hover:bg-ink-200 transition disabled:opacity-40"
            >
              退出
            </button>
          </div>
        </div>

        {/* 单词卡弹层：只在"答完之后"出现 —— 先测后看。
            首次遇到这个词时对错都亮卡（第一次要认词），之后就只在答错时亮。
            借鉴快速刷题流：点击屏幕任意位置即可继续（大热区），滚动后 250ms 内防误触 */}
        {showCard && currentWord && (
          <div
            className="fixed inset-0 bg-ink-900/40 flex items-center justify-center z-50 p-4 cursor-pointer"
            onClick={() => {
              if (Date.now() - cardScrollAtRef.current < 250) return
              setShowCard(false)
              handleNext()
            }}
          >
            <div
              className="bg-paper-50 rounded-xl shadow-2xl max-w-md w-full p-6 max-h-[85vh] overflow-y-auto"
              onScroll={() => { cardScrollAtRef.current = Date.now() }}
            >
              <div className="mb-3 text-center">
                <span
                  className={`inline-block px-3 py-1 rounded-full text-xs font-medium ${
                    selected === question.answer
                      ? 'bg-emerald-50 text-emerald-600'
                      : 'bg-red-50 text-red-600'
                  }`}
                >
                  {selected === question.answer
                    ? '答对了 · 看一眼这个词'
                    : `答错了 · 正确答案：${question.answer}`}
                </span>
              </div>
              <div className="text-center mb-4">
                <h2 className="text-3xl font-bold text-ink-800">{currentWord.word}</h2>
                <div className="flex items-center justify-center gap-3 mt-1">
                  {currentWord.phonetic && <span className="text-sm text-ink-400">{currentWord.phonetic}</span>}
                  {settings.voiceEnabled && (
                    <button
                      // 卡片上的喇叭跟"语音模式自动连读"保持一致：单词 → 例句
                      onClick={(e) => { e.stopPropagation(); speakSequence([currentWord.word, currentWord.exampleEn]) }}
                      className="text-ink-400 hover:text-seal-600"
                      title="连读单词与例句"
                    >
                      <Volume2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
                <p className="text-lg text-seal-600 font-medium mt-2">{currentWord.meaning}</p>
              </div>
              {/*
                词根词缀：拆得开才拆（各段按顺序拼回来必须正好等于原词）。
                拆不开就整块不显示 —— 硬拆出来的碎片比不拆更误导人。
              */}
              {isValidMorphemeSplit(currentWord.word, currentWord.morphemes) && (
                <div className="mt-3 p-3 bg-paper-100 rounded-lg">
                  <div className="text-[0.6875rem] font-medium text-ink-400 mb-2">词根词缀</div>
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
                    {currentWord.morphemes.map((m, i) => (
                      <span key={i} className="inline-flex items-center gap-1.5">
                        <span className="inline-flex flex-col items-center px-2 py-1 rounded-md bg-seal-50">
                          <span className="text-sm font-semibold text-seal-700">{m.text}</span>
                          <span className="text-[0.625rem] text-ink-400">
                            {MORPHEME_TYPE_LABELS[m.type]}{m.meaning ? ` · ${m.meaning}` : ''}
                          </span>
                        </span>
                        {i < currentWord.morphemes.length - 1 && (
                          <span className="text-ink-300 font-bold">+</span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {/*
                卡片上「英文的都要配中文」—— 一开始学的人看不懂英文例句/英文解释，
                只给英文等于没给。所以四个字段成对出现：
                  英文解释 definitionEn / 中文解释 definitionCn
                  英文例句 exampleEn   / 中文例句 exampleZh
                中文那边缺了就明确写出来（而不是静默不显示），用户才知道要补。
              */}
              {(currentWord.definitionEn || currentWord.definitionCn) && (
                <div className="mt-3 p-3 bg-paper-100 rounded-lg space-y-1">
                  <div className="text-[0.6875rem] font-medium text-ink-400">解释</div>
                  <p className="text-sm text-ink-700 leading-relaxed">
                    {currentWord.definitionEn || <span className="text-ink-400">（缺英文解释）</span>}
                  </p>
                  <p className="text-sm text-ink-500 leading-relaxed">
                    {currentWord.definitionCn || <span className="text-ink-400">（缺中文解释）</span>}
                  </p>
                </div>
              )}
              {currentWord.exampleEn && (
                <div className="mt-3 p-3 bg-paper-100 rounded-lg space-y-1">
                  <div className="text-[0.6875rem] font-medium text-ink-400">例句</div>
                  <p className="text-sm text-ink-700 italic leading-relaxed">
                    {currentWord.exampleEn.split(
                      new RegExp(`(${currentWord.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i'),
                    ).map((seg, i) =>
                      seg.toLowerCase() === currentWord.word.toLowerCase()
                        ? <strong key={i} className="text-seal-600 not-italic">{seg}</strong>
                        : seg,
                    )}
                  </p>
                  <p className="text-sm text-ink-500 leading-relaxed">
                    {currentWord.exampleZh || <span className="text-ink-400">（缺中文译文）</span>}
                  </p>
                </div>
              )}
              {/* 主按钮仅为视觉焦点：点击冒泡到 overlay 统一处理（防双触发跳两题） */}
              <button
                type="button"
                className="mt-5 w-full py-3 bg-seal-600 text-paper-50 rounded-lg text-sm font-medium hover:bg-seal-700 transition"
              >
                继续下一题
              </button>
              <p className="mt-2.5 text-center text-xs text-ink-400">
                👆 点击屏幕任意位置继续
              </p>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── 开始页 ──
  const statChips: { label: string; value: number; cls: string }[] = [
    { label: '全部', value: stats.total, cls: 'text-ink-700' },
    { label: '未学', value: stats.new, cls: 'text-red-500' },
    { label: '学习中', value: stats.learning, cls: 'text-amber-500' },
    { label: '已学', value: stats.learned, cls: 'text-blue-500' },
    { label: '已掌握', value: stats.mastered, cls: 'text-emerald-600' },
    { label: '错词本', value: stats.errorBook, cls: 'text-red-400' },
  ]

  return (
    <div className="space-y-4">
      {/* 统计条 */}
      <div className="bg-paper-50 rounded-xl border border-ink-200 p-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {statChips.map((c) => (
            <div key={c.label} className="text-sm">
              <span className="text-ink-400">{c.label} </span>
              <span className={`font-semibold ${c.cls}`}>{c.value}</span>
            </div>
          ))}
          <div className="text-sm ml-auto">
            <span className="text-ink-400">今日已学 </span>
            <span className="font-semibold text-seal-600">{studyStats.todayLearned.length}</span>
            <span className="text-ink-400"> / {settings.dailyGoal}</span>
          </div>
        </div>
      </div>

      {/* 设置面板 */}
      <div className="bg-paper-50 rounded-xl border border-ink-200 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-ink-800">学习设置</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-1 text-sm text-seal-600 hover:bg-seal-50 px-2.5 py-1 rounded-lg transition"
            >
              <Plus className="w-4 h-4" /> 添加单词
            </button>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="flex items-center gap-1 text-sm text-ink-500 hover:text-ink-700 px-2.5 py-1 rounded-lg hover:bg-ink-100 transition"
            >
              <Settings className="w-4 h-4" />
              {showSettings ? '收起' : '展开'}
            </button>
          </div>
        </div>

        {showSettings && (
          <div className="mt-4 space-y-5">
            <div>
              <label className="block text-sm text-ink-600 mb-1">每组词数</label>
              <p className="text-xs text-ink-400 mb-2">
                一次学一组，不是每日上限。组内按下面的题型顺序分轮过完，才会换下一组（A-D 全部过完，才轮到 E-H）。
              </p>
              <div className="flex gap-2">
                {[5, 7, 9].map((n) => (
                  <button
                    key={n}
                    onClick={() => setSettings((p) => ({ ...p, queueLength: n }))}
                    className={`px-4 py-1.5 rounded-lg text-sm transition ${
                      settings.queueLength === n ? 'bg-seal-600 text-paper-50' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'
                    }`}
                  >
                    {n} 个/组
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm text-ink-600 mb-1">每日目标</label>
              <p className="text-xs text-ink-400 mb-2">
                学满这个词数就收尾（一组接一组自动往下学，不会中途停下来问你），当天不再自动续组；
                想多学可以自己在完成页点「再来一组」。
              </p>
              <div className="flex gap-2">
                {DAILY_GOAL_OPTIONS.map((n) => (
                  <button
                    key={n}
                    onClick={() => setSettings((p) => ({ ...p, dailyGoal: n }))}
                    className={`px-4 py-1.5 rounded-lg text-sm transition ${
                      settings.dailyGoal === n ? 'bg-seal-600 text-paper-50' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'
                    }`}
                  >
                    {n} 词/天
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm text-ink-600 mb-2">题型选择（按勾选顺序分轮出题，答错就地重做这道题）</label>
              <div className="flex flex-wrap gap-2">
                {WORD_QUESTION_TYPES.map((t) => {
                  const Icon = t.icon
                  const checked = settings.questionTypes.includes(t.key)
                  // 听音类题型在静音模式下用不了：灰掉但保留勾选，切回语音模式即恢复
                  const needsVoice = !settings.voiceEnabled && VOICE_ONLY_TYPES.includes(t.key)
                  return (
                    <label
                      key={t.key}
                      title={needsVoice ? '该题型需要语音模式' : undefined}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition ${
                        needsVoice
                          ? 'bg-paper-100 border-ink-200 text-ink-300 cursor-not-allowed'
                          : checked
                            ? 'bg-seal-50 border-seal-300 text-seal-700 cursor-pointer'
                            : 'bg-paper-100 border-ink-200 text-ink-500 cursor-pointer'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="accent-seal-600"
                        disabled={needsVoice}
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
                      {needsVoice && <span className="text-[0.625rem]">需语音</span>}
                    </label>
                  )
                })}
              </div>
              <p className="text-xs text-ink-400 mt-1.5">
                定义/例句类题型需要单词含有 definition_cn 或原文例句，缺字段的词会自动跳过该轮；
                拼写题按词根词缀切块，切不出来的词退化成逐字母拼写
              </p>
            </div>

            <div>
              <label className="block text-sm text-ink-600 mb-2">掌握条件（走满多少轮算掌握）</label>
              <div className="flex gap-2">
                {MASTER_ROUND_OPTIONS.map((n) => (
                  <button
                    key={n}
                    onClick={() => setSettings((p) => ({ ...p, masterRounds: n }))}
                    className={`px-4 py-1.5 rounded-lg text-sm transition ${
                      settings.masterRounds === n ? 'bg-seal-600 text-paper-50' : 'bg-ink-100 text-ink-600 hover:bg-ink-200'
                    }`}
                  >
                    {n} 轮
                  </button>
                ))}
              </div>
              <p className="text-xs text-ink-400 mt-1.5">
                一轮 = 把选中的题型各答对一遍；答错会立刻重做这道题，不计入下一轮
              </p>
            </div>

            <div>
              <label className="block text-sm text-ink-600 mb-2">学习模式</label>
              <div className="flex flex-wrap gap-2">
                {VOICE_MODE_OPTIONS.map((o) => (
                  <button
                    key={o.label}
                    onClick={() => setSettings((p) => ({ ...p, voiceEnabled: o.on }))}
                    className={`px-4 py-1.5 rounded-lg text-sm transition ${
                      settings.voiceEnabled === o.on
                        ? 'bg-seal-600 text-paper-50'
                        : 'bg-ink-100 text-ink-600 hover:bg-ink-200'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-ink-400 mt-1.5">
                {VOICE_MODE_OPTIONS.find((o) => o.on === settings.voiceEnabled)?.hint}
                ；语音模式下答完题展开单词卡会先读单词、停顿后再读例句
              </p>
            </div>

            <div className="flex items-center gap-6 pt-1">
              <label className="flex items-center gap-2 text-sm text-ink-600 cursor-pointer">
                <input
                  type="checkbox"
                  className="accent-seal-600"
                  checked={settings.allowZhan}
                  onChange={(e) => setSettings((p) => ({ ...p, allowZhan: e.target.checked }))}
                />
                允许斩词
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
          className="flex-1 py-4 bg-seal-600 text-paper-50 rounded-xl hover:bg-seal-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          <span className="block text-base font-medium">开始学习</span>
          <span className="text-xs opacity-80">
            {stats.new + stats.learning > 0 ? `${stats.learning} 个学习中 + ${stats.new} 个新词` : '暂无新词'}
          </span>
        </button>
        <button
          onClick={() => startSession('review')}
          disabled={stats.due === 0}
          className="flex-1 py-4 bg-emerald-600 text-paper-50 rounded-xl hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
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


/**
 * 练习面板（长难句 / 翻译练习共用）：题面 → 作答 → 提交判分 → 结果展示。
 *
 * 形态保持一致，差异只在外面包一层（长难句题面是英文，翻译题面按方向是英/中并带方向标签）。
 * AI 只判分：按踩分点清单核对用户译文，返回 命中/漏掉 的踩分点与分数。
 */
function PracticePanel({
  itemKey,
  question,
  directionLabel,
  note,
  referenceTranslation,
  referenceLabel,
  scoringPoints,
  answerPlaceholder,
  storedAnswer,
  storedFeedback,
  storedMissed,
  lowScore,
  onSavePoints,
  onSubmitResult,
  voiceOn,
}: {
  /** 题目唯一键：切换题目时重置作答/结果 */
  itemKey: string
  question: string
  /** 翻译方向标签（长难句不传） */
  directionLabel?: string
  /** 难点说明（长难句的 difficultyNote）—— 只在低分卡片里出现，做题前不给 */
  note?: string
  referenceTranslation: string
  referenceLabel: string
  scoringPoints: string[]
  answerPlaceholder: string
  storedAnswer: string
  storedFeedback: string
  storedMissed: string
  /** 低分线：得分低于它才弹学习卡片（设置里的「翻译判分标准」） */
  lowScore: number
  onSavePoints: (points: string[]) => void
  onSubmitResult: (answer: string, result: GradeResult) => void
  /** 语音模式：题面旁给一个朗读按钮（长难句用；翻译练习不传） */
  voiceOn?: boolean
}) {
  const [answer, setAnswer] = useState(storedAnswer)
  const [grading, setGrading] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [result, setResult] = useState<GradeResult | null>(null)
  /** 学习卡片（参考译文 / 难点 / 踩分点 / 每点扣分）—— 低分时自动弹出，也可手动查看 */
  const [cardOpen, setCardOpen] = useState(false)
  const [editingPoints, setEditingPoints] = useState(false)
  const [pointsDraft, setPointsDraft] = useState('')

  // 切换题目：重置作答/结果/卡片。做题前不展示参考译文与踩分点 —— 先自己做。
  useEffect(() => {
    setAnswer(storedAnswer)
    setResult(null)
    setError('')
    setCardOpen(false)
    setEditingPoints(false)
    // 只在换题时重置，storedAnswer 随题目一起变，不单独依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKey])

  // 判分耗时计时（对应后端排队跑 GitHub Actions 的等待）
  useEffect(() => {
    if (!grading) return
    const t = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(t)
  }, [grading])

  const handleSubmit = async () => {
    const text = answer.trim()
    if (!text) {
      toast.error('请先输入你的译文')
      return
    }
    if (grading) return
    setGrading(true)
    setError('')
    setElapsed(0)
    setResult(null)
    try {
      const r = await gradeTranslationWithAI({
        question,
        directionLabel: directionLabel || '英译中',
        userTranslation: text,
        referenceTranslation,
        scoringPoints,
      })
      setResult(r)
      onSubmitResult(text, r)
      toast.success(`判分完成：${r.score} 分`)
      // 低分才弹卡片复盘；分数够了就直接过，不打断节奏
      if (r.score < lowScore) setCardOpen(true)
    } catch (err) {
      // 不静默吞错：把可读原因显示出来，用户可重试
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGrading(false)
    }
  }

  const storedMissedList = csvToList(storedMissed)
  const pointCount = scoringPoints.length
  /** 等权兜底：AI 没给这一点扣分时用（漏一个即扣这么多） */
  const perPointScore = pointCount > 0 ? Math.round(100 / pointCount) : 0
  const missedSet = new Set(result?.missedPoints || [])
  const hitSet = new Set(result?.hitPoints || [])
  /** AI 是否给出过逐点扣分 —— 有就按它显示，没有才退回等权 */
  const hasAiDeductions = Object.keys(result?.pointDeductions || {}).length > 0
  /** 单个踩分点的扣分：优先 AI 的逐点扣分 */
  const deductionOf = (point: string): number => {
    const ai = result?.pointDeductions?.[point]
    return typeof ai === 'number' && ai > 0 ? ai : perPointScore
  }
  /** 卡片里的「应该怎么做」：方向性方法论 + 这次漏掉的点 */
  const methodHint = (() => {
    const base = directionLabel === '中译英'
      ? '先定下英文主干与时态，再补从句和逻辑连接；学术术语用词要统一，别漏掉限定语（数量/程度/时间）。'
      : '先抓主干（主谓宾），再把定语、状语等修饰逐层挂上去；逻辑连接词（因果/转折/递进/让步）一定要译出来。'
    const missed = result?.missedPoints || []
    return missed.length > 0 ? `${base}\n这次漏掉的是：${missed.join('；')}。下次对着踩分点逐条自检。` : base
  })()

  return (
    <div className="bg-paper-50 rounded-xl border border-ink-200 p-6 space-y-5">
      {/* 题面 */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          {directionLabel && (
            <span className="px-2 py-0.5 bg-seal-50 text-seal-700 rounded text-xs font-medium">{directionLabel}</span>
          )}
          <span className="text-xs font-medium text-ink-400">{directionLabel ? '原文（请翻译）' : '英文长难句'}</span>
        </div>
        <div className="flex items-start gap-3">
          <p className="text-lg text-ink-800 leading-relaxed flex-1">{question}</p>
          {voiceOn && (
            <button
              type="button"
              onClick={() => speakEnglish(question)}
              className="shrink-0 p-2 text-ink-400 hover:text-seal-600 transition"
              title="朗读这句"
            >
              <Volume2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* 作答 */}
      <div>
        <label className="block text-sm font-medium text-ink-700 mb-1.5">你的译文</label>
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              void handleSubmit()
            }
          }}
          rows={4}
          disabled={grading}
          placeholder={answerPlaceholder}
          className="w-full px-3 py-2 border border-ink-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-seal-500 focus:border-transparent resize-none disabled:bg-paper-100"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={handleSubmit}
            disabled={grading || !answer.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-seal-600 text-paper-50 rounded-lg text-sm font-medium hover:bg-seal-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {grading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                判分中…（已等 {elapsed}s）
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                提交判分
              </>
            )}
          </button>
          <span className="text-xs text-ink-400">Ctrl/Cmd + Enter 快捷提交</span>
        </div>
        {grading && (
          <p className="text-xs text-ink-400 mt-1.5">
            后端需排队跑 GitHub Actions，通常要 1-3 分钟，请耐心等待（界面不会卡住）。
          </p>
        )}
        {error && (
          <div className="mt-2 flex items-start gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p>判分失败：{error}</p>
              <button onClick={handleSubmit} className="mt-1 text-xs text-red-700 underline">
                重试
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 本次判分结果：只给分数、命中/漏掉的点和反馈；细节留给学习卡片 */}
      {result && (
        <div className="rounded-lg border border-seal-100 bg-seal-50/40 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-bold text-seal-600">{result.score}</span>
              <span className="text-sm text-ink-500">/ 100</span>
            </div>
            <span className="text-xs text-ink-400">
              {pointCount === 0
                ? '本题未设踩分点'
                : hasAiDeductions
                  ? `${pointCount} 个踩分点，按各点权重扣分`
                  : `${pointCount} 个踩分点，漏一个扣 ${perPointScore} 分`}
            </span>
          </div>
          {result.hitPoints.length > 0 && (
            <ul className="space-y-0.5">
              {result.hitPoints.map((p, i) => (
                <li key={i} className="text-sm text-ink-700 flex gap-1.5">
                  <Check className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          )}
          {result.missedPoints.length > 0 && (
            <ul className="space-y-0.5">
              {result.missedPoints.map((p, i) => (
                <li key={i} className="text-sm text-ink-700 flex gap-1.5">
                  <X className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          )}
          {result.feedback && <p className="text-sm text-ink-600 whitespace-pre-wrap">{result.feedback}</p>}
          {result.score < lowScore && (
            <p className="text-xs text-amber-600">
              低于低分线 {lowScore} 分，已弹出学习卡片，对照参考译文与踩分点逐条复盘。
            </p>
          )}
        </div>
      )}

      {/* 学习卡片入口：做完题才能看（参考译文 / 难点 / 踩分点 / 每点扣分） */}
      <div>
        <button
          onClick={() => setCardOpen(true)}
          className="flex items-center gap-1.5 text-sm text-seal-600 hover:text-seal-700"
        >
          <BookOpen className="w-4 h-4" />
          学习卡片（参考译文 · 难点 · 踩分点）
        </button>
      </div>

      {cardOpen && (
        <div className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-50 p-4" onClick={() => setCardOpen(false)}>
          <div
            className="bg-paper-50 rounded-2xl shadow-xl w-full max-w-2xl max-h-[88vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-ink-200 sticky top-0 bg-paper-50">
              <h3 className="font-semibold text-ink-800">学习卡片</h3>
              <button
                onClick={() => setCardOpen(false)}
                className="p-1 text-ink-400 hover:text-ink-600 hover:bg-ink-100 rounded-lg transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-5">
              {/* 原文 */}
              <div>
                <p className="text-xs font-medium text-ink-400 mb-1.5">原文</p>
                <p className="text-sm text-ink-800 leading-relaxed whitespace-pre-wrap">{question}</p>
              </div>

              {/* 参考译文 */}
              <div>
                <p className="text-xs font-medium text-ink-400 mb-1.5">参考译文（{referenceLabel}）</p>
                <p className="text-sm text-ink-700 leading-relaxed bg-paper-100 rounded-lg p-3 whitespace-pre-wrap">
                  {referenceTranslation || '（暂无参考译文）'}
                </p>
              </div>

              {/* 难点 */}
              {note && (
                <div>
                  <p className="text-xs font-medium text-ink-400 mb-1.5">难点</p>
                  <p className="text-sm text-amber-700 leading-relaxed">{note}</p>
                </div>
              )}

              {/* 踩分点：标出命中/漏掉 + 每点扣分 */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-xs font-medium text-ink-400">
                    踩分点
                    {pointCount > 0 &&
                      (hasAiDeductions
                        ? `（${pointCount} 个 · 扣分由 AI 按各点权重判定）`
                        : `（${pointCount} 个 · 漏一个扣 ${perPointScore} 分）`)}
                  </p>
                  <button
                    onClick={() => {
                      setPointsDraft(scoringPoints.join('\n'))
                      setEditingPoints(true)
                    }}
                    className="flex items-center gap-1 text-xs text-seal-600 hover:text-seal-700"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    编辑
                  </button>
                </div>
                {editingPoints ? (
                  <div className="space-y-2">
                    <textarea
                      value={pointsDraft}
                      onChange={(e) => setPointsDraft(e.target.value)}
                      rows={4}
                      placeholder="一行一条踩分点"
                      className="w-full px-3 py-2 border border-ink-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-seal-500 focus:border-transparent resize-none"
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => setEditingPoints(false)}
                        className="px-3 py-1.5 text-xs text-ink-500 bg-ink-100 hover:bg-ink-200 rounded-lg transition"
                      >
                        取消
                      </button>
                      <button
                        onClick={() => {
                          onSavePoints(pointsDraft.split('\n').map((s) => s.trim()).filter(Boolean))
                          setEditingPoints(false)
                          toast.success('踩分点已保存')
                        }}
                        className="px-3 py-1.5 text-xs text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-lg transition"
                      >
                        保存
                      </button>
                    </div>
                  </div>
                ) : (
                  <ul className="space-y-1">
                    {pointCount === 0 && (
                      <li className="text-xs text-ink-400">暂无踩分点，点「编辑」补充，AI 将据此判分</li>
                    )}
                    {scoringPoints.map((p, i) => {
                      const missed = missedSet.has(p)
                      const hit = hitSet.has(p)
                      const deduction = deductionOf(p)
                      return (
                        <li key={i} className="text-sm flex gap-2 items-start">
                          {missed ? (
                            <X className="w-3.5 h-3.5 text-red-400 mt-1 shrink-0" />
                          ) : hit ? (
                            <Check className="w-3.5 h-3.5 text-emerald-500 mt-1 shrink-0" />
                          ) : (
                            <span className="w-3.5 text-ink-300 text-center mt-0.5 shrink-0">{i + 1}</span>
                          )}
                          <span className={missed ? 'text-red-600' : 'text-ink-700'}>
                            {p}
                            {missed && deduction > 0 && <span className="text-xs text-red-400 ml-1">-{deduction}</span>}
                          </span>
                        </li>
                      )
                    })}
                    {hasAiDeductions && result && (
                      <li className="text-xs text-ink-400 pt-1">
                        本次各点扣分合计 {100 - result.score} 分
                      </li>
                    )}
                  </ul>
                )}
              </div>

              {/* 应该怎么做 */}
              <div>
                <p className="text-xs font-medium text-ink-400 mb-1.5">应该怎么做</p>
                <p className="text-sm text-ink-700 leading-relaxed whitespace-pre-wrap">{methodHint}</p>
              </div>

              {/* 上次判分记录 */}
              {(storedFeedback || storedMissedList.length > 0) && (
                <div>
                  <p className="text-xs font-medium text-ink-400 mb-1.5">上次判分记录</p>
                  {storedMissedList.length > 0 && (
                    <p className="text-sm text-ink-600 leading-relaxed">漏掉的踩分点：{storedMissedList.join('；')}</p>
                  )}
                  {storedFeedback && (
                    <p className="text-sm text-ink-600 leading-relaxed whitespace-pre-wrap">{storedFeedback}</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 批量补提的进度 / 失败汇总面板（长难句 / 翻译练习共用） */
function BatchProgressPanel({
  running,
  done,
  total,
  title,
  failures,
  onStop,
}: {
  running: boolean
  done: number
  total: number
  title: string
  failures: string[]
  onStop: () => void
}) {
  if (!running && failures.length === 0) return null
  return (
    <div className="space-y-2">
      {running && (
        <div className="bg-paper-50 rounded-xl border border-ink-200 p-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-ink-600">
              批量补提中：已完成 {done} / {total} 篇
            </span>
            <button
              onClick={onStop}
              className="flex items-center gap-1 px-3 py-1 text-red-600 hover:bg-red-50 rounded-lg transition"
            >
              <Square className="w-3.5 h-3.5" />
              停止
            </button>
          </div>
          {title && <p className="text-xs text-ink-400 truncate">正在处理：{title}</p>}
          <div className="w-full h-2 bg-ink-100 rounded-full overflow-hidden">
            <div
              className="h-2 bg-seal-600 rounded-full transition-all"
              style={{ width: `${total ? (done / total) * 100 : 0}%` }}
            />
          </div>
          <p className="text-xs text-ink-400">
            逐篇串行调用后端（GitHub Actions），每篇完成后立即增量落盘；点「停止」不会丢失已完成的部分。
          </p>
        </div>
      )}
      {!running && failures.length > 0 && (
        <div className="bg-red-50 border border-red-100 rounded-xl p-4">
          <p className="text-sm font-medium text-red-600 mb-1">以下文献补提失败（{failures.length} 篇）</p>
          <ul className="space-y-0.5 max-h-44 overflow-y-auto">
            {failures.map((f, i) => (
              <li key={i} className="text-xs text-red-500">{f}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function SentenceSection({
  sentences,
  setSentences,
  literatures,
}: {
  sentences: SentenceData[]
  setSentences: React.Dispatch<React.SetStateAction<SentenceData[]>>
  literatures: Literature[]
}) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [showAddModal, setShowAddModal] = useState(false)
  /**
   * 长难句也有"语音 / 静音"两个模式，跟单词页共用同一个偏好
   * （settings/learning_progress.md 的 word_voice_enabled）。
   * 两个页签是互斥渲染的，切过来会重新 loadProgress（命中缓存），所以能拿到最新值。
   */
  const [voiceOn, setVoiceOn] = useState(false)
  /** 低分线（设置里的「翻译判分标准」）：低于它才弹学习卡片 */
  const lowScore = useSettingsStore((s) => s.translationLowScore ?? 70)

  // 批量补提状态
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchDone, setBatchDone] = useState(0)
  const [batchTotal, setBatchTotal] = useState(0)
  const [batchTitle, setBatchTitle] = useState('')
  const [batchFailures, setBatchFailures] = useState<string[]>([])
  const stopRef = useRef(false)
  /** 正在跑的那一篇的取消句柄：点「停止」要能立刻断掉它，而不是等它跑完 */
  const batchAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let cancelled = false
    async function loadSentenceProgress() {
      try {
        const saved = await loadProgress()
        if (cancelled) return
        const idx = saved.sentenceCurrentIndex ?? 0
        const safeIdx = sentences.length > 0 ? idx % sentences.length : 0
        setCurrentIndex(safeIdx)
        setVoiceOn(saved.wordVoiceEnabled === true)
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

  // 切走/卸载时掐掉朗读，别让上一页的句子在这里继续念
  useEffect(() => () => stopSpeaking(), [])

  const safeIndex = sentences.length > 0 ? currentIndex % sentences.length : 0
  const currentSentence = sentences.length > 0 ? sentences[safeIndex] : undefined

  // 语音模式：换句就自动读一遍英文原句（读的是原文，不是译文 —— 译文是答案）
  useEffect(() => {
    if (!voiceOn || !currentSentence) return
    speakEnglish(currentSentence.sentenceEn)
    // 只认"换到哪一句"，句子实体每次渲染都是新对象，不能进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceOn, safeIndex, currentSentence?.id])

  const handlePrev = () => {
    setCurrentIndex((i) => (i - 1 + sentences.length) % sentences.length)
  }

  const handleNext = () => {
    setCurrentIndex((i) => (i + 1) % sentences.length)
  }

  /** 按数组下标精确更新当前句（踩分点编辑 / 判分结果落库） */
  const patchCurrent = useCallback((patch: Partial<SentenceData>) => {
    setSentences((prev) => prev.map((s, i) => (i === safeIndex ? { ...s, ...patch } : s)))
  }, [safeIndex, setSentences])

  const handleAddSentence = (sentence: SentenceData) => {
    setSentences((prev) => [...prev, sentence])
    setShowAddModal(false)
    toast.success('长难句已添加')
  }

  /**
   * 历史批量补提：只处理「已转换出 md」且尚未提取过长难句的文献。
   * 串行逐篇 loadAiSourceText → runDualEngine 提取，每篇完成立刻增量落盘。
   */
  const handleBatchBackfill = async () => {
    if (batchRunning) return
    const existing = new Set(sentences.map((s) => s.sourceDoi).filter(Boolean))
    const candidates = literatures.filter((l) => l.mdStatus === 'done' && !existing.has(l.doi))
    if (candidates.length === 0) {
      toast.info('没有需要补提的文献（仅处理已转换出 md 且尚未提取过的文献）')
      return
    }
    const { ai1, ai2 } = useSettingsStore.getState().getDualEngineConfig()
    const sentenceCount = useSettingsStore.getState().sentenceGenCount || 8
    const instruction = buildLearningInstruction(
      { words: false, sentences: true, translation: false, wordCount: 0, sentenceCount },
      { en: '', cn: '' },
    )

    stopRef.current = false
    setBatchRunning(true)
    setBatchFailures([])
    setBatchDone(0)
    setBatchTotal(candidates.length)
    setBatchTitle('')

    const failures: string[] = []
    let addedTotal = 0
    const res = await runBatchExtraction(
      candidates,
      async (lit) => {
        const sourceMaterial = await loadAiSourceText(lit.doi)
        if (!sourceMaterial.trim()) {
          return { ok: false, reason: '未读到 md 正文（loadAiSourceText 为空）' }
        }
        // 这一篇的取消句柄：点「停止」立刻断掉正在跑的这篇，而不是等它跑完
        const controller = new AbortController()
        batchAbortRef.current = controller
        const result = await runDualEngine({
          taskType: 'faithfulness_check',
          sourceMaterial,
          ai1Instruction: instruction,
          ai1,
          ai2,
          signal: controller.signal,
        })
        batchAbortRef.current = null
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
          // AI 没给出可用长难句：记为失败，绝不误报"已完成"
          return { ok: false, reason: 'AI 未返回可用长难句' }
        }
        // 增量落盘：追加进 state，父组件的防抖副作用会写回 CSV
        setSentences((prev) => [...prev, ...newItems])
        existing.add(lit.doi)
        addedTotal += newItems.length
        return { ok: true }
      },
      {
        onProgress: (done, total, title) => {
          setBatchDone(done)
          setBatchTotal(total)
          if (title) setBatchTitle(title)
        },
        shouldStop: () => stopRef.current,
        onFailure: (title, reason) => failures.push(`${title}：${reason}`),
      },
    )

    setBatchTitle('')
    setBatchFailures([...failures])
    setBatchRunning(false)

    if (res.stopped) {
      toast.info(`已停止补提：新增 ${addedTotal} 条长难句，${failures.length} 篇失败`)
    } else if (failures.length > 0) {
      toast.warning(`补提完成（新增 ${addedTotal} 条长难句），${failures.length} 篇失败，详见下方清单`)
    } else {
      toast.success(`补提完成，新增 ${addedTotal} 条长难句`)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <div className="flex items-center gap-3">
          <div className="text-sm text-ink-500">
            进度：{sentences.length > 0 ? `${safeIndex + 1} / ${sentences.length}` : '0 / 0'}
          </div>
          {/* 长难句的两个模式：开语音时换句自动朗读英文原句 */}
          <div className="flex items-center gap-1 bg-paper-50 border border-ink-200 rounded-lg p-0.5">
            {VOICE_MODE_OPTIONS.map((o) => (
              <button
                key={o.label}
                onClick={() => { setVoiceOn(o.on); updateProgress({ wordVoiceEnabled: o.on }) }}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
                  voiceOn === o.on ? 'bg-seal-50 text-seal-700' : 'text-ink-500 hover:text-ink-700'
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleBatchBackfill}
            disabled={batchRunning}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-seal-600 hover:bg-seal-50 rounded-lg transition disabled:opacity-50"
          >
            <History className="w-4 h-4" />
            批量补提历史文献
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-seal-600 hover:bg-seal-50 rounded-lg transition"
          >
            <Plus className="w-4 h-4" />
            手动添加
          </button>
        </div>
      </div>

      <BatchProgressPanel
        running={batchRunning}
        done={batchDone}
        total={batchTotal}
        title={batchTitle}
        failures={batchFailures}
        onStop={() => { stopRef.current = true; batchAbortRef.current?.abort() }}
      />

      {sentences.length === 0 || !currentSentence ? (
        <div className="text-center py-16">
          <Type className="w-16 h-16 text-ink-300 mx-auto mb-4" />
          <p className="text-ink-500 mb-4">
            还没有长难句。可点上方「批量补提历史文献」（仅对有 md 的文献生效），或手动添加。
          </p>
        </div>
      ) : (
        <>
          <PracticePanel
            itemKey={currentSentence.id || `idx-${safeIndex}`}
            question={currentSentence.sentenceEn}
            note={currentSentence.difficultyNote}
            referenceTranslation={currentSentence.sentenceCn || currentSentence.aiReferenceCn}
            referenceLabel="中文翻译"
            scoringPoints={currentSentence.scoringPoints || []}
            answerPlaceholder="用中文翻译上面的英文句子"
            storedAnswer={currentSentence.latestUserTranslation}
            storedFeedback={currentSentence.latestAiFeedback}
            storedMissed={currentSentence.latestErrorWords}
            voiceOn={voiceOn}
            lowScore={lowScore}
            onSavePoints={(points) => patchCurrent({ scoringPoints: points })}
            onSubmitResult={(ans, r) => patchCurrent({
              latestUserTranslation: ans,
              latestAiFeedback: r.feedback,
              latestErrorWords: listToCsv(r.missedPoints),
              practiceCount: (currentSentence.practiceCount || 0) + 1,
              lastPractice: Date.now(),
            })}
          />

          <div className="flex items-center justify-center gap-3">
            <button
              onClick={handlePrev}
              className="flex items-center gap-1.5 px-4 py-2.5 bg-paper-50 border border-ink-200 text-ink-600 rounded-lg text-sm font-medium hover:bg-paper-100 transition"
            >
              <ChevronLeft className="w-4 h-4" />
              上一张
            </button>
            <button
              onClick={handleNext}
              className="flex items-center gap-1.5 px-4 py-2.5 bg-seal-600 text-paper-50 rounded-lg text-sm font-medium hover:bg-seal-700 transition"
            >
              下一张
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </>
      )}

      {showAddModal && <AddSentenceModal onClose={() => setShowAddModal(false)} onAdd={handleAddSentence} />}
    </div>
  )
}

function TranslationSection({
  translations,
  setTranslations,
  literatures,
}: {
  translations: TranslationData[]
  setTranslations: React.Dispatch<React.SetStateAction<TranslationData[]>>
  literatures: Literature[]
}) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [showAddModal, setShowAddModal] = useState(false)
  /** 低分线（设置里的「翻译判分标准」）：低于它才弹学习卡片 */
  const lowScore = useSettingsStore((s) => s.translationLowScore ?? 70)

  // 批量补提状态
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchDone, setBatchDone] = useState(0)
  const [batchTotal, setBatchTotal] = useState(0)
  const [batchTitle, setBatchTitle] = useState('')
  const [batchFailures, setBatchFailures] = useState<string[]>([])
  const stopRef = useRef(false)
  /** 正在跑的那一篇的取消句柄：点「停止」要能立刻断掉它，而不是等它跑完 */
  const batchAbortRef = useRef<AbortController | null>(null)

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

  const safeIndex = translations.length > 0 ? currentIndex % translations.length : 0
  const currentItem = translations.length > 0 ? translations[safeIndex] : undefined

  const handlePrev = () => {
    setCurrentIndex((i) => (i - 1 + translations.length) % translations.length)
  }

  const handleNext = () => {
    setCurrentIndex((i) => (i + 1) % translations.length)
  }

  const patchCurrent = useCallback((patch: Partial<TranslationData>) => {
    setTranslations((prev) => prev.map((t, i) => (i === safeIndex ? { ...t, ...patch } : t)))
  }, [safeIndex, setTranslations])

  const handleAddTranslation = (item: TranslationData) => {
    setTranslations((prev) => [...prev, item])
    setShowAddModal(false)
    toast.success('翻译练习已添加')
  }

  /**
   * 历史批量补提（摘要翻译）：处理所有有摘要（至少英/中一边非空）且尚未出过题的文献。
   * 不需要 md —— 题面与参考答案直接来自文献元数据。
   */
  const handleBatchBackfill = async () => {
    if (batchRunning) return
    const existing = new Set(translations.map((t) => t.sourceDoi).filter(Boolean))
    const candidates = literatures.filter(
      (l) => (((l.abstractEn || '').trim() || (l.abstractCn || '').trim()) && !existing.has(l.doi)),
    )
    if (candidates.length === 0) {
      toast.info('没有需要补提的文献（需要有摘要且尚未出过题）')
      return
    }
    const { ai1, ai2 } = useSettingsStore.getState().getDualEngineConfig()

    stopRef.current = false
    setBatchRunning(true)
    setBatchFailures([])
    setBatchDone(0)
    setBatchTotal(candidates.length)
    setBatchTitle('')

    const failures: string[] = []
    let addedTotal = 0
    const res = await runBatchExtraction(
      candidates,
      async (lit) => {
        const en = (lit.abstractEn || '').trim()
        const cn = (lit.abstractCn || '').trim()
        if (!en && !cn) {
          return { ok: false, reason: '该文献没有摘要，无法出题' }
        }
        const sourceMaterial = [`【英文摘要】${en}`, `【中文摘要】${cn}`].join('\n\n')
        const instruction = buildLearningInstruction(
          { words: false, sentences: false, translation: true, wordCount: 0, sentenceCount: 0 },
          { en, cn },
        )
        // 这一篇的取消句柄：点「停止」立刻断掉正在跑的这篇，而不是等它跑完
        const controller = new AbortController()
        batchAbortRef.current = controller
        const result = await runDualEngine({
          taskType: 'faithfulness_check',
          sourceMaterial,
          ai1Instruction: instruction,
          ai1,
          ai2,
          signal: controller.signal,
        })
        batchAbortRef.current = null
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
        // 题面/参考答案由元数据注入（缺一边时用 AI 补的参考译文）
        const items = buildTranslationItems(lit, pointsByDirection, Date.now(), `ai_${lit.doi}_`, referenceOverride)
        if (items.length === 0) {
          return { ok: false, reason: '未能生成任何翻译题' }
        }
        setTranslations((prev) => [...prev, ...items])
        existing.add(lit.doi)
        addedTotal += items.length
        return { ok: true }
      },
      {
        onProgress: (done, total, title) => {
          setBatchDone(done)
          setBatchTotal(total)
          if (title) setBatchTitle(title)
        },
        shouldStop: () => stopRef.current,
        onFailure: (title, reason) => failures.push(`${title}：${reason}`),
      },
    )

    setBatchTitle('')
    setBatchFailures([...failures])
    setBatchRunning(false)

    if (res.stopped) {
      toast.info(`已停止补提：新增 ${addedTotal} 条翻译题，${failures.length} 篇失败`)
    } else if (failures.length > 0) {
      toast.warning(`补提完成（新增 ${addedTotal} 条翻译题），${failures.length} 篇失败，详见下方清单`)
    } else {
      toast.success(`补提完成，新增 ${addedTotal} 条翻译题（每篇按方向各一条）`)
    }
  }

  const directionLabel = directionLabelOf(currentItem?.direction)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between items-center gap-3">
        <div className="text-sm text-ink-500">
          进度：{translations.length > 0 ? `${safeIndex + 1} / ${translations.length}` : '0 / 0'}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleBatchBackfill}
            disabled={batchRunning}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-seal-600 hover:bg-seal-50 rounded-lg transition disabled:opacity-50"
          >
            <History className="w-4 h-4" />
            批量补提历史文献
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-seal-600 hover:bg-seal-50 rounded-lg transition"
          >
            <Plus className="w-4 h-4" />
            手动添加
          </button>
        </div>
      </div>

      <BatchProgressPanel
        running={batchRunning}
        done={batchDone}
        total={batchTotal}
        title={batchTitle}
        failures={batchFailures}
        onStop={() => { stopRef.current = true; batchAbortRef.current?.abort() }}
      />

      {translations.length === 0 || !currentItem ? (
        <div className="text-center py-16">
          <Languages className="w-16 h-16 text-ink-300 mx-auto mb-4" />
          <p className="text-ink-500 mb-4">
            还没有翻译练习。可点上方「批量补提历史文献」（只需文献有摘要，不需要 md），或手动添加。
          </p>
        </div>
      ) : (
        <>
          <PracticePanel
            itemKey={currentItem.id || `idx-${safeIndex}`}
            question={currentItem.originalText}
            directionLabel={directionLabel}
            referenceTranslation={currentItem.referenceTranslation}
            referenceLabel={directionLabel === '中译英' ? '英文参考译文' : '中文参考译文'}
            scoringPoints={currentItem.scoringPoints || []}
            answerPlaceholder={directionLabel === '中译英' ? '用英文翻译上面的中文摘要/句子' : '用中文翻译上面的英文摘要/句子'}
            storedAnswer={currentItem.latestUserTranslation}
            storedFeedback={currentItem.latestAiFeedback}
            storedMissed={currentItem.latestErrorWords}
            lowScore={lowScore}
            onSavePoints={(points) => patchCurrent({ scoringPoints: points })}
            onSubmitResult={(ans, r) => patchCurrent({
              latestUserTranslation: ans,
              latestAiFeedback: r.feedback,
              latestErrorWords: listToCsv(r.missedPoints),
              practiceCount: (currentItem.practiceCount || 0) + 1,
              lastPractice: Date.now(),
            })}
          />

          <div className="flex items-center justify-center gap-3">
            <button
              onClick={handlePrev}
              className="flex items-center gap-1.5 px-4 py-2.5 bg-paper-50 border border-ink-200 text-ink-600 rounded-lg text-sm font-medium hover:bg-paper-100 transition"
            >
              <ChevronLeft className="w-4 h-4" />
              上一张
            </button>
            <button
              onClick={handleNext}
              className="flex items-center gap-1.5 px-4 py-2.5 bg-seal-600 text-paper-50 rounded-lg text-sm font-medium hover:bg-seal-700 transition"
            >
              下一张
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </>
      )}

      {showAddModal && <AddTranslationModal onClose={() => setShowAddModal(false)} onAdd={handleAddTranslation} />}
    </div>
  )
}

function ModalBackdrop({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 bg-ink-900/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-paper-50 rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto"
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
  const [definitionEn, setDefinitionEn] = useState('')
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
      definitionEn: definitionEn.trim() || '',
      exampleEn: exampleEn.trim() || '',
      exampleZh: exampleZh.trim() || '',
      // 手动添加不给切分入口（改切分是"额外事件"，在文献编辑里做）
      morphemes: [],
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
          <h3 className="text-lg font-bold text-ink-800">添加单词</h3>
          <button
            onClick={onClose}
            className="p-1 text-ink-400 hover:text-ink-600 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">单词 *</label>
            <input
              type="text"
              value={word}
              onChange={(e) => setWord(e.target.value)}
              className="w-full px-3 py-2 border border-ink-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-seal-500 focus:border-transparent"
              placeholder="例如：example"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">音标</label>
            <input
              type="text"
              value={phonetic}
              onChange={(e) => setPhonetic(e.target.value)}
              className="w-full px-3 py-2 border border-ink-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-seal-500 focus:border-transparent"
              placeholder="例如：/pəˈrɒvskaɪt/"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">中文释义 *</label>
            <input
              type="text"
              value={meaning}
              onChange={(e) => setMeaning(e.target.value)}
              className="w-full px-3 py-2 border border-ink-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-seal-500 focus:border-transparent"
              placeholder="例如：示例单词"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">例句（英文）</label>
            <textarea
              value={exampleEn}
              onChange={(e) => setExampleEn(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-ink-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-seal-500 focus:border-transparent resize-none"
              placeholder="英文例句"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">例句（中文）</label>
            <textarea
              value={exampleZh}
              onChange={(e) => setExampleZh(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-ink-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-seal-500 focus:border-transparent resize-none"
              placeholder="中文翻译"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">中文解释（选填，用于"定义"类题型）</label>
            <input
              type="text"
              value={definitionCn}
              onChange={(e) => setDefinitionCn(e.target.value)}
              className="w-full px-3 py-2 border border-ink-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-seal-500 focus:border-transparent"
              placeholder="留空则与中文释义相同"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">英文解释（选填）</label>
            <input
              type="text"
              value={definitionEn}
              onChange={(e) => setDefinitionEn(e.target.value)}
              className="w-full px-3 py-2 border border-ink-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-seal-500 focus:border-transparent"
              placeholder="英文释义，例如：a substance that speeds up a reaction"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-paper-50 border border-ink-200 text-ink-600 rounded-lg text-sm font-medium hover:bg-paper-100 transition"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-2.5 bg-seal-600 text-paper-50 rounded-lg text-sm font-medium hover:bg-seal-700 transition"
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
  const [points, setPoints] = useState('')
  const [difficulty, setDifficulty] = useState('')

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
      scoringPoints: points.split('\n').map((s) => s.trim()).filter(Boolean),
      difficultyNote: difficulty.trim() || undefined,
      latestUserTranslation: '',
      latestAiFeedback: '',
      latestErrorWords: '',
      practiceCount: 0,
      lastPractice: 0,
    }
    onAdd(newSentence)
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-ink-800">添加长难句</h3>
          <button
            onClick={onClose}
            className="p-1 text-ink-400 hover:text-ink-600 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">英文句子 *</label>
            <textarea
              value={en}
              onChange={(e) => setEn(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-ink-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-seal-500 focus:border-transparent resize-none"
              placeholder="英文长难句"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">中文翻译 *</label>
            <textarea
              value={zh}
              onChange={(e) => setZh(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-ink-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-seal-500 focus:border-transparent resize-none"
              placeholder="中文翻译"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">踩分点（选填，一行一条）</label>
            <textarea
              value={points}
              onChange={(e) => setPoints(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-ink-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-seal-500 focus:border-transparent resize-none"
              placeholder="判分标准，主要写逻辑关系与关键术语"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">难点说明（选填）</label>
            <input
              type="text"
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value)}
              className="w-full px-3 py-2 border border-ink-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-seal-500 focus:border-transparent"
              placeholder="这句难在哪里"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-paper-50 border border-ink-200 text-ink-600 rounded-lg text-sm font-medium hover:bg-paper-100 transition"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-2.5 bg-seal-600 text-paper-50 rounded-lg text-sm font-medium hover:bg-seal-700 transition"
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
  const [direction, setDirection] = useState<TranslationDirection>('cn2en')
  const [source, setSource] = useState('')
  const [reference, setReference] = useState('')
  const [points, setPoints] = useState('')

  const sourceLabel = direction === 'cn2en' ? '中文原文' : '英文原文'
  const referenceLabel = direction === 'cn2en' ? '英文参考译文' : '中文参考译文'

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!source.trim() || !reference.trim()) {
      toast.error('请填写原文和参考译文')
      return
    }
    const newItem: TranslationData = {
      id: `t_${Date.now()}`,
      originalText: source.trim(),
      direction,
      referenceTranslation: reference.trim(),
      scoringPoints: points.split('\n').map((s) => s.trim()).filter(Boolean),
      // 手动添加来自任意文本，不是文献摘要
      sourceKind: 'text',
      sourceDoi: '',
      // 这里是"用户作答"语义，手动添加时为空（参考译文进 referenceTranslation）
      latestUserTranslation: '',
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
          <h3 className="text-lg font-bold text-ink-800">添加翻译练习</h3>
          <button
            onClick={onClose}
            className="p-1 text-ink-400 hover:text-ink-600 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">翻译方向 *</label>
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as TranslationDirection)}
              className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
            >
              <option value="cn2en">中译英（题面中文 → 译文英文）</option>
              <option value="en2cn">英译中（题面英文 → 译文中文）</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">{sourceLabel} *</label>
            <textarea
              value={source}
              onChange={(e) => setSource(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-ink-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-seal-500 focus:border-transparent resize-none"
              placeholder={direction === 'cn2en' ? '中文句子' : 'English sentence'}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">{referenceLabel} *</label>
            <textarea
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-ink-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-seal-500 focus:border-transparent resize-none"
              placeholder={direction === 'cn2en' ? 'English reference translation' : '中文参考译文'}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-700 mb-1">踩分点（选填，一行一条）</label>
            <textarea
              value={points}
              onChange={(e) => setPoints(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-ink-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-seal-500 focus:border-transparent resize-none"
              placeholder="判分标准，主要写逻辑关系与关键术语"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-paper-50 border border-ink-200 text-ink-600 rounded-lg text-sm font-medium hover:bg-paper-100 transition"
            >
              取消
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-2.5 bg-seal-600 text-paper-50 rounded-lg text-sm font-medium hover:bg-seal-700 transition"
            >
              添加
            </button>
          </div>
        </form>
      </div>
    </ModalBackdrop>
  )
}
