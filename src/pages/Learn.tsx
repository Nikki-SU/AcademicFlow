/**
 * 学习页面（占位）
 * 功能：单词翻卡 + 长难句 + 翻译练习
 */
import { GraduationCap, Brain, Languages, Type } from 'lucide-react'
import { useState } from 'react'

const subTabs = [
  { id: 'words', label: '单词翻卡', icon: Brain },
  { id: 'sentences', label: '长难句', icon: Type },
  { id: 'translation', label: '翻译练习', icon: Languages },
]

export default function LearnPage() {
  const [activeTab, setActiveTab] = useState('words')

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-800">学习</h1>
        <p className="text-sm text-slate-500 mt-1">SM-2 间隔重复 + 6 种题型</p>
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

      <div className="bg-white rounded-xl border border-slate-200 p-8">
        <div className="text-center py-12 text-slate-400">
          <GraduationCap className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">学习模块开发中</p>
          <p className="text-xs mt-1">通过 PDF→MD 提取生词后自动入库</p>
        </div>
      </div>
    </div>
  )
}
