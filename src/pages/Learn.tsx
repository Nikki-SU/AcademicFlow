/**
 * 学习页
 * -------------------------------------------------
 * 参考 Cat 库：闪卡学习
 * 子 Tab：单词翻卡 / 长难句 / 翻译练习
 */
import { useState } from 'react'
import { GraduationCap, Brain, Type, Languages, RotateCcw } from 'lucide-react'

const subTabs = [
  { id: 'words', label: '单词翻卡', icon: Brain },
  { id: 'sentences', label: '长难句', icon: Type },
  { id: 'translation', label: '翻译练习', icon: Languages },
]

const DEMO_CARDS = [
  { front: 'perovskite', back: '钙钛矿', context: 'perovskite solar cells' },
  { front: 'catalysis', back: '催化', context: 'heterogeneous catalysis' },
  { front: 'electrolyte', back: '电解质', context: 'solid-state electrolyte' },
]

const DEMO_SENTENCES = [
  { en: 'The synergistic effect between the metal and the support plays a crucial role in determining the catalytic activity.', zh: '金属与载体之间的协同效应对决定催化活性起着至关重要的作用。' },
  { en: 'Despite extensive research, the underlying mechanism remains elusive.', zh: '尽管进行了广泛研究，其潜在机制仍然难以捉摸。' },
]

const DEMO_TRANSLATIONS = [
  { source: '我们报道了一种新型纳米催化剂，其在室温下表现出优异的 CO2 还原性能。', reference: 'We report a novel nanocatalyst that exhibits excellent CO2 reduction performance at room temperature.' },
]

export default function LearnPage() {
  const [activeTab, setActiveTab] = useState('words')
  const [cardIndex, setCardIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)

  const currentCard = DEMO_CARDS[cardIndex % DEMO_CARDS.length]

  const nextCard = () => {
    setFlipped(false)
    setCardIndex((i) => i + 1)
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
          <GraduationCap className="w-6 h-6 text-indigo-600" />
          学习
        </h1>
        <p className="text-sm text-slate-500 mt-1">SM-2 间隔重复，基于阅读笔记自动生成记忆卡片</p>
      </div>

      {/* 子 Tab */}
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

      {/* 单词翻卡 */}
      {activeTab === 'words' && (
        <div className="flex flex-col items-center">
          <div
            onClick={() => setFlipped(!flipped)}
            className="w-full max-w-md h-64 bg-white rounded-xl border-2 border-slate-200 hover:border-indigo-300 cursor-pointer flex flex-col items-center justify-center transition shadow-sm"
          >
            <div className="text-sm text-slate-400 mb-2">{flipped ? '答案' : '单词'}</div>
            <div className={`text-2xl font-bold ${flipped ? 'text-indigo-600' : 'text-slate-800'}`}>
              {flipped ? currentCard.back : currentCard.front}
            </div>
            {flipped && (
              <div className="mt-3 text-sm text-slate-500">{currentCard.context}</div>
            )}
          </div>
          <div className="flex items-center gap-3 mt-6">
            <button
              onClick={nextCard}
              className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition"
            >
              <RotateCcw className="w-4 h-4" />
              下一张
            </button>
          </div>
          <div className="text-xs text-slate-400 mt-3">
            点击卡片翻转 · 共 {DEMO_CARDS.length} 张卡片
          </div>
        </div>
      )}

      {/* 长难句 */}
      {activeTab === 'sentences' && (
        <div className="space-y-4">
          {DEMO_SENTENCES.map((s, i) => (
            <div key={i} className="bg-white rounded-xl border border-slate-200 p-5">
              <div className="text-sm font-medium text-slate-800 mb-2">{s.en}</div>
              <div className="text-sm text-slate-500">{s.zh}</div>
            </div>
          ))}
        </div>
      )}

      {/* 翻译练习 */}
      {activeTab === 'translation' && (
        <div className="space-y-4">
          {DEMO_TRANSLATIONS.map((t, i) => (
            <div key={i} className="bg-white rounded-xl border border-slate-200 p-5">
              <div className="text-sm text-slate-500 mb-1">原文</div>
              <div className="text-sm font-medium text-slate-800 mb-3">{t.source}</div>
              <div className="text-sm text-slate-500 mb-1">参考译文</div>
              <div className="text-sm text-indigo-700">{t.reference}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
