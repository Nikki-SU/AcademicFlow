import { useState, useEffect, useMemo } from 'react'
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
  Image,
  BookOpen,
  SpellCheck,
  ArrowRight,
  XCircle,
  CheckCircle,
  Shuffle,
  Sparkles,
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'

type TabId = 'words' | 'sentences' | 'translation'

interface Word {
  id: string
  word: string
  phonetic: string
  meaning: string
  imagePrompt: string
  exampleEn: string
  exampleZh: string
  root?: string
  mastered?: boolean
}

interface Sentence {
  id: string
  en: string
  zh: string
  structure?: {
    subject: string
    predicate: string
    object?: string
  }
  mastered?: boolean
}

interface TranslationItem {
  id: string
  source: string
  reference: string
  mastered?: boolean
}

type WordStep = 'image' | 'detail' | 'spelling'

const subTabs = [
  { id: 'words' as TabId, label: '单词', icon: Brain },
  { id: 'sentences' as TabId, label: '长难句', icon: Type },
  { id: 'translation' as TabId, label: '翻译练习', icon: Languages },
]

const DEFAULT_WORDS: Word[] = [
  {
    id: 'w1',
    word: 'perovskite',
    phonetic: '/pəˈrɒvskaɪt/',
    meaning: '钙钛矿',
    imagePrompt: 'perovskite crystal structure scientific illustration',
    exampleEn: 'Perovskite solar cells have achieved remarkable efficiency improvements in recent years.',
    exampleZh: '钙钛矿太阳能电池近年来在效率上取得了显著的提升。',
    root: 'perov- (钙钛矿结构) + -skite (矿)',
  },
  {
    id: 'w2',
    word: 'catalysis',
    phonetic: '/kəˈtælɪsɪs/',
    meaning: '催化',
    imagePrompt: 'catalysis chemical reaction laboratory illustration',
    exampleEn: 'Heterogeneous catalysis plays a vital role in industrial chemical processes.',
    exampleZh: '多相催化在工业化学过程中起着至关重要的作用。',
    root: 'cata- (完全) + lysis (分解)',
  },
  {
    id: 'w3',
    word: 'electrolyte',
    phonetic: '/ɪˈlektrəlaɪt/',
    meaning: '电解质',
    imagePrompt: 'electrolyte solution battery chemistry illustration',
    exampleEn: 'Solid-state electrolytes offer improved safety compared to liquid electrolytes.',
    exampleZh: '与液态电解质相比，固态电解质具有更高的安全性。',
    root: 'electro- (电) + -lyte (溶解物)',
  },
  {
    id: 'w4',
    word: 'photovoltaic',
    phonetic: '/ˌfəʊtəʊvɒlˈteɪɪk/',
    meaning: '光伏的',
    imagePrompt: 'photovoltaic solar panel energy illustration',
    exampleEn: 'Photovoltaic technology converts sunlight directly into electricity.',
    exampleZh: '光伏技术将太阳光直接转化为电能。',
    root: 'photo- (光) + voltaic (电流的)',
  },
  {
    id: 'w5',
    word: 'semiconductor',
    phonetic: '/ˌsemikənˈdʌktə/',
    meaning: '半导体',
    imagePrompt: 'semiconductor wafer chip technology illustration',
    exampleEn: 'Silicon is the most widely used semiconductor material in electronic devices.',
    exampleZh: '硅是电子设备中使用最广泛的半导体材料。',
    root: 'semi- (半) + conductor (导体)',
  },
]

const DEFAULT_SENTENCES: Sentence[] = [
  {
    id: 's1',
    en: 'The synergistic effect between the metal nanoparticles and the metal-organic framework support plays a crucial role in determining the overall catalytic activity and stability of the heterogeneous catalyst.',
    zh: '金属纳米颗粒与金属有机框架载体之间的协同效应对决定多相催化剂的整体催化活性和稳定性起着至关重要的作用。',
    structure: {
      subject: 'The synergistic effect between the metal nanoparticles and the metal-organic framework support',
      predicate: 'plays a crucial role',
      object: 'in determining the overall catalytic activity and stability of the heterogeneous catalyst',
    },
  },
  {
    id: 's2',
    en: 'Despite extensive research efforts over the past three decades, the underlying mechanism by which single-atom catalysts achieve their remarkable selectivity remains elusive and continues to be a subject of intense debate.',
    zh: '尽管过去三十年进行了广泛的研究，单原子催化剂实现其卓越选择性的潜在机制仍然难以捉摸，并继续成为激烈争论的主题。',
    structure: {
      subject: 'the underlying mechanism',
      predicate: 'remains elusive and continues to be a subject of intense debate',
      object: 'by which single-atom catalysts achieve their remarkable selectivity',
    },
  },
  {
    id: 's3',
    en: 'By carefully controlling the synthesis parameters, researchers were able to fabricate a hybrid material that exhibits both high electrical conductivity and excellent electrochemical performance.',
    zh: '通过仔细控制合成参数，研究人员成功制备了一种兼具高导电性和优异电化学性能的杂化材料。',
    structure: {
      subject: 'researchers',
      predicate: 'were able to fabricate',
      object: 'a hybrid material that exhibits both high electrical conductivity and excellent electrochemical performance',
    },
  },
]

const DEFAULT_TRANSLATIONS: TranslationItem[] = [
  {
    id: 't1',
    source: '我们报道了一种新型纳米催化剂，其在室温下表现出优异的 CO2 还原性能和长期稳定性。',
    reference: 'We report a novel nanocatalyst that exhibits excellent CO2 reduction performance and long-term stability at room temperature.',
  },
  {
    id: 't2',
    source: '该研究结果为设计高效、低成本的能量转换装置提供了新的思路和理论指导。',
    reference: 'The research results provide new insights and theoretical guidance for the design of efficient and low-cost energy conversion devices.',
  },
  {
    id: 't3',
    source: '实验结果表明，这种复合电极材料的比容量是纯碳材料的三倍以上。',
    reference: 'Experimental results show that the specific capacity of this composite electrode material is more than three times that of pure carbon material.',
  },
]

const STORAGE_KEYS = {
  words: 'learn_words',
  sentences: 'learn_sentences',
  translations: 'learn_translations',
}

function loadFromStorage<T>(key: string, defaultValue: T[]): T[] {
  try {
    const data = localStorage.getItem(key)
    if (data) {
      return JSON.parse(data)
    }
  } catch {
    // ignore
  }
  return defaultValue
}

function saveToStorage<T>(key: string, data: T[]) {
  try {
    localStorage.setItem(key, JSON.stringify(data))
  } catch {
    // ignore
  }
}

function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

function generateImageUrl(prompt: string): string {
  const encoded = encodeURIComponent(prompt)
  return `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${encoded}&image_size=square_hd`
}

const AI_GENERATE_OPTIONS = [
  { value: '10.1038/s41560-024-01432-1', label: '钙钛矿太阳能电池综述 (Nature Energy)' },
  { value: '10.1021/jacs.3c04567', label: 'CO2 还原电催化剂设计 (JACS)' },
]

export default function LearnPage() {
  const [activeTab, setActiveTab] = useState<TabId>('words')
  const [aiGenOpen, setAiGenOpen] = useState(false)
  const [aiGenLoading, setAiGenLoading] = useState(false)
  const [selectedPaper, setSelectedPaper] = useState('')
  const [genTypes, setGenTypes] = useState({ words: true, sentences: true, translation: true })

  const [words, setWords] = useState<Word[]>(() => loadFromStorage(STORAGE_KEYS.words, DEFAULT_WORDS))
  const [sentences, setSentences] = useState<Sentence[]>(() => loadFromStorage(STORAGE_KEYS.sentences, DEFAULT_SENTENCES))
  const [translations, setTranslations] = useState<TranslationItem[]>(() => loadFromStorage(STORAGE_KEYS.translations, DEFAULT_TRANSLATIONS))

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.words, words)
  }, [words])

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.sentences, sentences)
  }, [sentences])

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.translations, translations)
  }, [translations])

  const handleAIGenerate = async () => {
    if (!selectedPaper) {
      toast.error('请选择要生成学习内容的文献')
      return
    }
    if (!genTypes.words && !genTypes.sentences && !genTypes.translation) {
      toast.error('请至少选择一种生成类型')
      return
    }
    setAiGenLoading(true)
    try {
      await new Promise((r) => setTimeout(r, 2000))
      if (genTypes.words) {
        const newWords: Word[] = [
          { id: `ai-${Date.now()}-1`, word: 'photovoltaic', phonetic: '/ˌfəʊtəʊvɒlˈteɪɪk/', meaning: '光伏的', imagePrompt: 'solar panel photovoltaic cell blue technology', exampleEn: 'Photovoltaic technology converts sunlight directly into electricity.', exampleZh: '光伏技术将阳光直接转化为电能。', root: 'photo-光 + voltaic-电的' },
          { id: `ai-${Date.now()}-2`, word: 'efficiency', phonetic: '/ɪˈfɪʃənsi/', meaning: '效率', imagePrompt: 'energy efficiency chart graph green', exampleEn: 'The power conversion efficiency reached a record 26%.', exampleZh: '功率转换效率达到了创纪录的26%。', root: 'ef-出 + fic-做 + -iency' },
        ]
        setWords((prev) => [...newWords, ...prev])
      }
      if (genTypes.sentences) {
        const newSents: Sentence[] = [
          { id: `ai-${Date.now()}-s1`, en: 'The power conversion efficiency of perovskite solar cells has increased dramatically over the past decade.', zh: '钙钛矿太阳能电池的功率转换效率在过去十年中大幅提升。', structure: { subject: 'The power conversion efficiency', predicate: 'has increased', object: '' } },
        ]
        setSentences((prev) => [...newSents, ...prev])
      }
      if (genTypes.translation) {
        const newTrans: TranslationItem[] = [
          { id: `ai-${Date.now()}-t1`, source: '该研究揭示了钙钛矿材料中载流子输运的微观机制。', reference: 'This study reveals the microscopic mechanism of carrier transport in perovskite materials.' },
        ]
        setTranslations((prev) => [...newTrans, ...prev])
      }
      toast.success('学习内容生成成功！')
      setAiGenOpen(false)
    } catch {
      toast.error('生成失败，请重试')
    } finally {
      setAiGenLoading(false)
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
          <p className="text-sm text-slate-500 mt-1">AI 从文献 Markdown 自动生成学习内容：单词、长难句、翻译练习</p>
        </div>
        <button
          onClick={() => setAiGenOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-lg text-sm font-medium hover:from-indigo-700 hover:to-purple-700 transition shadow-sm"
        >
          <Sparkles className="w-4 h-4" />
          AI 生成学习内容
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
              AI 生成学习内容
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
                >
                  <option value="">请选择...</option>
                  {AI_GENERATE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
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
                disabled={aiGenLoading}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {aiGenLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    生成中...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    开始生成
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'words' && <WordSection words={words} setWords={setWords} />}
      {activeTab === 'sentences' && <SentenceSection sentences={sentences} setSentences={setSentences} />}
      {activeTab === 'translation' && <TranslationSection translations={translations} setTranslations={setTranslations} />}
    </div>
  )
}

function WordSection({ words, setWords }: { words: Word[]; setWords: React.Dispatch<React.SetStateAction<Word[]>> }) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [step, setStep] = useState<WordStep>('image')
  const [selectedOption, setSelectedOption] = useState<string | null>(null)
  const [showResult, setShowResult] = useState(false)
  const [spelledLetters, setSpelledLetters] = useState<string[]>([])
  const [shuffledLetters, setShuffledLetters] = useState<string[]>([])
  const [spellingCorrect, setSpellingCorrect] = useState<boolean | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)

  const currentWord = words[currentIndex % words.length]

  const options = useMemo(() => {
    if (!currentWord) return []
    const otherMeanings = words
      .filter((w) => w.id !== currentWord.id)
      .map((w) => w.meaning)
    const shuffledOthers = shuffleArray(otherMeanings).slice(0, 3)
    return shuffleArray([currentWord.meaning, ...shuffledOthers])
  }, [currentWord, words])

  useEffect(() => {
    setStep('image')
    setSelectedOption(null)
    setShowResult(false)
    setSpelledLetters([])
    setSpellingCorrect(null)
    if (currentWord) {
      setShuffledLetters(shuffleArray(currentWord.word.split('')))
    }
  }, [currentIndex, currentWord])

  const handleSelectOption = (option: string) => {
    if (showResult) return
    setSelectedOption(option)
    setShowResult(true)
  }

  const handleNextStep = () => {
    if (step === 'image') {
      setStep('detail')
    } else if (step === 'detail') {
      setStep('spelling')
    } else if (step === 'spelling') {
      setCurrentIndex((i) => (i + 1) % words.length)
    }
  }

  const handlePrevStep = () => {
    if (step === 'detail') {
      setStep('image')
    } else if (step === 'spelling') {
      setStep('detail')
    }
  }

  const handleLetterClick = (letter: string, index: number) => {
    if (spellingCorrect !== null) return
    const newSpelled = [...spelledLetters, letter]
    setSpelledLetters(newSpelled)
    const newShuffled = [...shuffledLetters]
    newShuffled.splice(index, 1)
    setShuffledLetters(newShuffled)

    if (newSpelled.length === currentWord.word.length) {
      const isCorrect = newSpelled.join('') === currentWord.word
      setSpellingCorrect(isCorrect)
      if (isCorrect) {
        toast.success('拼写正确！')
      } else {
        toast.error('拼写错误，请重试')
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
    setShuffledLetters(shuffleArray(currentWord.word.split('')))
    setSpellingCorrect(null)
  }

  const handleAddWord = (word: Word) => {
    setWords((prev) => [...prev, word])
    setShowAddModal(false)
    toast.success('单词已添加')
  }

  const isCorrect = selectedOption === currentWord?.meaning

  return (
    <div className="relative">
      <div className="flex justify-between items-center mb-4">
        <div className="text-sm text-slate-500">
          进度：{currentIndex + 1} / {words.length}
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-indigo-600 hover:bg-indigo-50 rounded-lg transition"
        >
          <Plus className="w-4 h-4" />
          手动添加单词
        </button>
      </div>

      <div className="w-full bg-slate-100 rounded-full h-2 mb-6">
        <div
          className="bg-indigo-600 h-2 rounded-full transition-all"
          style={{ width: `${((currentIndex + 1) / words.length) * 100}%` }}
        />
      </div>

      <div className="flex justify-center gap-2 mb-6">
        {['image', 'detail', 'spelling'].map((s, i) => {
          const Icon = s === 'image' ? Image : s === 'detail' ? BookOpen : SpellCheck
          const isActive = step === s
          const isPast = (step === 'detail' && s === 'image') || (step === 'spelling' && s !== 'spelling')
          return (
            <div
              key={s}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${
                isActive
                  ? 'bg-indigo-100 text-indigo-700'
                  : isPast
                  ? 'bg-green-100 text-green-700'
                  : 'bg-slate-100 text-slate-500'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {['图片选择', '单词详解', '拼写练习'][i]}
            </div>
          )
        })}
      </div>

      <div className="bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden">
        {step === 'image' && currentWord && (
          <div className="p-6">
            <div className="aspect-square w-full max-w-md mx-auto rounded-xl overflow-hidden bg-slate-100 mb-6">
              <img
                src={generateImageUrl(currentWord.imagePrompt)}
                alt={currentWord.word}
                className="w-full h-full object-cover"
              />
            </div>

            <div className="text-center mb-6">
              <h2 className="text-3xl font-bold text-slate-800 mb-2">{currentWord.word}</h2>
              <p className="text-sm text-slate-400">{currentWord.phonetic}</p>
            </div>

            <div className="grid grid-cols-2 gap-3 max-w-md mx-auto">
              {options.map((option) => {
                const isSelected = selectedOption === option
                const isCorrectAnswer = option === currentWord.meaning
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
                    onClick={() => handleSelectOption(option)}
                    disabled={showResult}
                    className={`p-4 rounded-xl border-2 text-sm font-medium transition ${btnClass}`}
                  >
                    {option}
                  </button>
                )
              })}
            </div>

            {showResult && (
              <div className="mt-6 flex flex-col items-center">
                <div className={`flex items-center gap-2 mb-4 ${isCorrect ? 'text-green-600' : 'text-red-500'}`}>
                  {isCorrect ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
                  <span className="font-medium">{isCorrect ? '回答正确！' : '回答错误'}</span>
                </div>
                <button
                  onClick={handleNextStep}
                  className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition"
                >
                  继续学习
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        )}

        {step === 'detail' && currentWord && (
          <div className="p-6">
            <div className="text-center mb-6">
              <h2 className="text-3xl font-bold text-slate-800 mb-2">{currentWord.word}</h2>
              <p className="text-sm text-slate-400 mb-3">{currentWord.phonetic}</p>
              <p className="text-xl text-indigo-600 font-semibold">{currentWord.meaning}</p>
            </div>

            <div className="space-y-4 max-w-md mx-auto">
              <div className="bg-slate-50 rounded-xl p-4">
                <div className="text-xs font-medium text-slate-400 mb-2">例句</div>
                <p className="text-sm text-slate-700 mb-2">{currentWord.exampleEn}</p>
                <p className="text-sm text-slate-500">{currentWord.exampleZh}</p>
              </div>

              {currentWord.root && (
                <div className="bg-amber-50 rounded-xl p-4">
                  <div className="text-xs font-medium text-amber-600 mb-1">词根词缀</div>
                  <p className="text-sm text-amber-800">{currentWord.root}</p>
                </div>
              )}
            </div>

            <div className="flex justify-center gap-3 mt-8">
              <button
                onClick={handlePrevStep}
                className="flex items-center gap-2 px-5 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 transition"
              >
                <ChevronLeft className="w-4 h-4" />
                上一步
              </button>
              <button
                onClick={handleNextStep}
                className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition"
              >
                拼写练习
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {step === 'spelling' && currentWord && (
          <div className="p-6">
            <div className="text-center mb-6">
              <p className="text-sm text-slate-400 mb-2">根据释义拼写单词</p>
              <p className="text-xl text-indigo-600 font-semibold mb-2">{currentWord.meaning}</p>
              <p className="text-sm text-slate-400">{currentWord.phonetic}</p>
            </div>

            <div className="flex justify-center gap-2 mb-6 min-h-[48px]">
              {currentWord.word.split('').map((_, i) => {
                const letter = spelledLetters[i] || ''
                const isCorrectLetter = spellingCorrect !== null && letter === currentWord.word[i]
                const isWrongLetter = spellingCorrect === false && letter && letter !== currentWord.word[i]
                return (
                  <div
                    key={i}
                    className={`w-10 h-12 flex items-center justify-center text-xl font-bold rounded-lg border-2 transition ${
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
                  className="w-10 h-10 flex items-center justify-center text-lg font-semibold bg-white border-2 border-slate-200 rounded-lg text-slate-700 hover:border-indigo-400 hover:bg-indigo-50 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {letter}
                </button>
              ))}
            </div>

            <div className="flex justify-center gap-3">
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

            <div className="flex justify-center gap-3 mt-8">
              <button
                onClick={handlePrevStep}
                className="flex items-center gap-2 px-5 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 transition"
              >
                <ChevronLeft className="w-4 h-4" />
                上一步
              </button>
              <button
                onClick={handleNextStep}
                disabled={!spellingCorrect}
                className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                下一个单词
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {showAddModal && <AddWordModal onClose={() => setShowAddModal(false)} onAdd={handleAddWord} />}
    </div>
  )
}

function SentenceSection({ sentences, setSentences }: { sentences: Sentence[]; setSentences: React.Dispatch<React.SetStateAction<Sentence[]>> }) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)

  const currentSentence = sentences[currentIndex % sentences.length]

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
        i === currentIndex % sentences.length ? { ...s, mastered: !s.mastered } : s
      )
    )
    toast.success(currentSentence?.mastered ? '已取消标记' : '已标记为已掌握')
  }

  const handleAddSentence = (sentence: Sentence) => {
    setSentences((prev) => [...prev, sentence])
    setShowAddModal(false)
    toast.success('长难句已添加')
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
        className="w-full min-h-[320px] cursor-pointer perspective-1000"
        style={{ perspective: '1000px' }}
      >
        <div
          className="relative w-full h-full transition-transform duration-500"
          style={{
            transformStyle: 'preserve-3d',
            transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
            minHeight: '320px',
          }}
        >
          <div
            className="absolute inset-0 bg-white rounded-2xl shadow-lg border border-slate-200 p-6 flex flex-col justify-center"
            style={{ backfaceVisibility: 'hidden' }}
          >
            <div className="text-xs font-medium text-slate-400 mb-3">英文长难句</div>
            <p className="text-lg text-slate-800 leading-relaxed">{currentSentence?.en}</p>
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
            <p className="text-base text-slate-800 leading-relaxed mb-6">{currentSentence?.zh}</p>

            {currentSentence?.structure && (
              <div className="space-y-3">
                <div className="text-xs font-medium text-slate-400">结构分析</div>
                <div className="bg-blue-50 rounded-lg p-3">
                  <div className="text-xs font-medium text-blue-600 mb-1">主语</div>
                  <p className="text-sm text-blue-800">{currentSentence.structure.subject}</p>
                </div>
                <div className="bg-green-50 rounded-lg p-3">
                  <div className="text-xs font-medium text-green-600 mb-1">谓语</div>
                  <p className="text-sm text-green-800">{currentSentence.structure.predicate}</p>
                </div>
                {currentSentence.structure.object && (
                  <div className="bg-amber-50 rounded-lg p-3">
                    <div className="text-xs font-medium text-amber-600 mb-1">宾语/状语</div>
                    <p className="text-sm text-amber-800">{currentSentence.structure.object}</p>
                  </div>
                )}
              </div>
            )}

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
            currentSentence?.mastered
              ? 'bg-green-100 text-green-700 hover:bg-green-200'
              : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          <Check className="w-4 h-4" />
          {currentSentence?.mastered ? '已掌握' : '标记掌握'}
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

function TranslationSection({ translations, setTranslations }: { translations: TranslationItem[]; setTranslations: React.Dispatch<React.SetStateAction<TranslationItem[]>> }) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)

  const currentItem = translations[currentIndex % translations.length]

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
        i === currentIndex % translations.length ? { ...t, mastered: !t.mastered } : t
      )
    )
    toast.success(currentItem?.mastered ? '已取消标记' : '已标记为已掌握')
  }

  const handleAddTranslation = (item: TranslationItem) => {
    setTranslations((prev) => [...prev, item])
    setShowAddModal(false)
    toast.success('翻译练习已添加')
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
        className="w-full min-h-[280px] cursor-pointer"
        style={{ perspective: '1000px' }}
      >
        <div
          className="relative w-full h-full transition-transform duration-500"
          style={{
            transformStyle: 'preserve-3d',
            transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
            minHeight: '280px',
          }}
        >
          <div
            className="absolute inset-0 bg-white rounded-2xl shadow-lg border border-slate-200 p-6 flex flex-col justify-center"
            style={{ backfaceVisibility: 'hidden' }}
          >
            <div className="text-xs font-medium text-slate-400 mb-3">中文句子（请翻译为英文）</div>
            <p className="text-lg text-slate-800 leading-relaxed">{currentItem?.source}</p>
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
            <p className="text-base text-slate-800 leading-relaxed">{currentItem?.reference}</p>
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
            currentItem?.mastered
              ? 'bg-green-100 text-green-700 hover:bg-green-200'
              : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          <Check className="w-4 h-4" />
          {currentItem?.mastered ? '已掌握' : '标记掌握'}
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

function AddWordModal({ onClose, onAdd }: { onClose: () => void; onAdd: (word: Word) => void }) {
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
    const newWord: Word = {
      id: `w_${Date.now()}`,
      word: word.trim(),
      phonetic: phonetic.trim() || '',
      meaning: meaning.trim(),
      imagePrompt: word.trim(),
      exampleEn: exampleEn.trim() || '',
      exampleZh: exampleZh.trim() || '',
      root: root.trim() || undefined,
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
              placeholder="例如：perovskite"
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
              placeholder="例如：钙钛矿"
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

function AddSentenceModal({ onClose, onAdd }: { onClose: () => void; onAdd: (sentence: Sentence) => void }) {
  const [en, setEn] = useState('')
  const [zh, setZh] = useState('')
  const [subject, setSubject] = useState('')
  const [predicate, setPredicate] = useState('')
  const [object, setObject] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!en.trim() || !zh.trim()) {
      toast.error('请填写英文和中文')
      return
    }
    const newSentence: Sentence = {
      id: `s_${Date.now()}`,
      en: en.trim(),
      zh: zh.trim(),
      structure:
        subject.trim() || predicate.trim()
          ? {
              subject: subject.trim(),
              predicate: predicate.trim(),
              object: object.trim() || undefined,
            }
          : undefined,
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

          <div className="pt-2 border-t border-slate-100">
            <div className="text-sm font-medium text-slate-700 mb-3">结构分析（可选）</div>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">主语</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  placeholder="主语部分"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">谓语</label>
                <input
                  type="text"
                  value={predicate}
                  onChange={(e) => setPredicate(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  placeholder="谓语部分"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">宾语/状语</label>
                <input
                  type="text"
                  value={object}
                  onChange={(e) => setObject(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  placeholder="宾语或状语部分"
                />
              </div>
            </div>
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

function AddTranslationModal({ onClose, onAdd }: { onClose: () => void; onAdd: (item: TranslationItem) => void }) {
  const [source, setSource] = useState('')
  const [reference, setReference] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!source.trim() || !reference.trim()) {
      toast.error('请填写中文和参考译文')
      return
    }
    const newItem: TranslationItem = {
      id: `t_${Date.now()}`,
      source: source.trim(),
      reference: reference.trim(),
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
