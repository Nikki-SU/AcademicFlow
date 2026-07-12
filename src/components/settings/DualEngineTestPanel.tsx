/**
 * AI 双引擎试运行面板
 * -------------------------------------------------
 * 让用户贴一段含事实性声明的文本 → AI-1 生成 fact_check 报告 → AI-2 审阅 → UI 展示两侧结果。
 * M3 阶段作为设置页底部的"跑通一次"入口，验证双引擎端到端。
 */
import {
  AlertTriangle,
  CheckCircle,
  ClipboardList,
  Loader2,
  Play,
  Timer,
  XCircle,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useSettingsStore } from '../../stores/settings'
import type { DualEngineIssue } from '../../types'

/** 一段预填的中文事实核查示例（含刻意植入的几个可疑点） */
const SAMPLE_TEXT = `2023 年，屠呦呦因发现青蒿素获得诺贝尔化学奖，成为中国大陆首位诺贝尔科学奖得主。
她提取青蒿素的关键突破，来自《肘后备急方》中"青蒿一握，以水二升渍，绞取汁，尽服之"的记载，
这段文字最早出现在东汉张仲景的著作中。青蒿素及其衍生物是目前世界卫生组织推荐的疟疾一线治疗药物。`

/** 事实核查任务的 issue 类型徽章配色 */
const ISSUE_TYPE_STYLE: Record<DualEngineIssue['type'], { label: string; color: string }> = {
  divergence: { label: '偏题', color: 'bg-amber-100 text-amber-800 border-amber-300' },
  omission: { label: '遗漏', color: 'bg-orange-100 text-orange-800 border-orange-300' },
  mistranslation: { label: '误译', color: 'bg-red-100 text-red-800 border-red-300' },
  unverified_link: { label: '未核实链接', color: 'bg-purple-100 text-purple-800 border-purple-300' },
  other: { label: '其他', color: 'bg-slate-100 text-slate-700 border-slate-300' },
}

function DualEngineTestPanel() {
  const {
    isRunningDualEngine,
    lastDualEngineResult,
    runFactCheckTest,
    ai1Model,
    ai2Model,
    aiProviderMode,
    advancedMode,
    customAi1Model,
    customAi2Model,
  } = useSettingsStore()

  const [input, setInput] = useState(SAMPLE_TEXT)

  const useCustom = aiProviderMode === 'custom' && advancedMode
  const displayAI1Model = useCustom
    ? customAi1Model || '（自定义 AI-1）'
    : ai1Model
  const displayAI2Model = useCustom
    ? customAi2Model || '（自定义 AI-2）'
    : ai2Model

  const handleRun = async () => {
    const trimmed = input.trim()
    if (!trimmed) {
      toast.error('请填写待核查文本')
      return
    }
    try {
      await runFactCheckTest(trimmed)
      toast.success('双引擎试运行完成')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`试运行失败：${msg}`)
    }
  }

  const result = lastDualEngineResult
  const duration = result
    ? ((result.finishedAt - result.startedAt) / 1000).toFixed(1)
    : null

  return (
    <div className="space-y-4">
      {/* 输入区 */}
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1.5">
          待核查文本
        </label>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={isRunningDualEngine}
          rows={6}
          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md
                     focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent
                     disabled:bg-slate-50 disabled:cursor-not-allowed font-mono leading-relaxed"
          placeholder="粘贴一段含事实性声明的文本（如文献段落、新闻、笔记草稿等）"
        />
        <div className="flex items-center justify-between mt-1">
          <p className="text-xs text-slate-500">
            AI-1 <span className="font-mono">{displayAI1Model}</span> 生成 →
            AI-2 <span className="font-mono">{displayAI2Model}</span> 审阅
          </p>
          <button
            type="button"
            onClick={() => setInput(SAMPLE_TEXT)}
            disabled={isRunningDualEngine}
            className="text-xs text-indigo-600 hover:text-indigo-800 disabled:text-slate-300"
          >
            使用示例文本
          </button>
        </div>
      </div>

      {/* 运行按钮 */}
      <button
        type="button"
        onClick={handleRun}
        disabled={isRunningDualEngine || !input.trim()}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-indigo-600 text-white
                   text-sm font-semibold rounded-md hover:bg-indigo-700 transition
                   disabled:bg-slate-300 disabled:cursor-not-allowed"
      >
        {isRunningDualEngine ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            正在跑双引擎…
          </>
        ) : (
          <>
            <Play className="w-4 h-4" />
            运行 fact_check
          </>
        )}
      </button>

      {/* 结果展示 */}
      {result && (
        <div className="space-y-3 pt-2">
          {/* 概览 */}
          <div className="flex items-center gap-4 px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-xs">
            <div className="flex items-center gap-1">
              <Timer className="w-3.5 h-3.5 text-slate-500" />
              <span className="text-slate-600">耗时</span>
              <span className="font-mono text-slate-800">{duration}s</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-slate-600">AI-1</span>
              <span className="font-mono text-slate-800">
                {result.ai1Usage.total_tokens} tokens
              </span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-slate-600">AI-2</span>
              <span className="font-mono text-slate-800">
                {result.ai2Usage.total_tokens} tokens
              </span>
            </div>
          </div>

          {/* AI-1 输出 */}
          <details open className="border border-slate-200 rounded-md overflow-hidden">
            <summary className="cursor-pointer px-3 py-2 bg-slate-50 hover:bg-slate-100 text-sm font-medium text-slate-800 flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-indigo-600" />
              AI-1 输出（生成位 · {result.ai1Model}）
            </summary>
            <pre className="p-3 text-xs bg-white text-slate-800 whitespace-pre-wrap font-sans leading-relaxed max-h-[400px] overflow-y-auto">
              {result.ai1Output}
            </pre>
          </details>

          {/* AI-2 反馈 */}
          <details open className="border border-slate-200 rounded-md overflow-hidden">
            <summary className="cursor-pointer px-3 py-2 bg-slate-50 hover:bg-slate-100 text-sm font-medium text-slate-800 flex items-center gap-2">
              {result.ai2Feedback.passed ? (
                <CheckCircle className="w-4 h-4 text-green-600" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-orange-600" />
              )}
              AI-2 审阅（{result.ai2Feedback.passed ? '通过 ✅' : `发现 ${result.ai2Feedback.issues.length} 个问题`} · {result.ai2Model}）
            </summary>
            <div className="p-3 space-y-2 bg-white">
              {result.ai2Feedback.summary && (
                <div className="p-2 bg-slate-50 border-l-2 border-indigo-400 text-xs text-slate-700 leading-relaxed">
                  {result.ai2Feedback.summary}
                </div>
              )}
              {result.ai2Feedback.issues.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-green-700">
                  <CheckCircle className="w-4 h-4" />
                  AI-2 未发现问题
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {result.ai2Feedback.issues.map((issue, idx) => {
                    const style = ISSUE_TYPE_STYLE[issue.type]
                    return (
                      <li
                        key={idx}
                        className="flex items-start gap-2 p-2 border border-slate-200 rounded"
                      >
                        <span
                          className={`shrink-0 px-2 py-0.5 text-xs font-mono border rounded ${style.color}`}
                        >
                          {style.label}
                        </span>
                        <span className="text-xs text-slate-700 leading-relaxed">
                          {issue.detail}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
              {/* 原始输出（折叠） */}
              <details className="text-xs text-slate-500">
                <summary className="cursor-pointer hover:text-slate-700">
                  查看 AI-2 原始输出（JSON）
                </summary>
                <pre className="mt-1 p-2 bg-slate-50 border border-slate-200 rounded whitespace-pre-wrap font-mono max-h-[200px] overflow-y-auto">
                  {result.ai2RawOutput}
                </pre>
              </details>
            </div>
          </details>

          {/* 未通过时提示 */}
          {!result.ai2Feedback.passed && (
            <div className="flex items-start gap-2 p-3 bg-orange-50 border border-orange-200 rounded-md">
              <XCircle className="w-4 h-4 text-orange-600 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-orange-800 leading-relaxed">
                双引擎未通过审阅。按 SPEC §9.2 设计，M4 起 AI 结果将只放入
                <code className="mx-1 px-1 py-0.5 bg-orange-100 rounded">:::ai-output</code>
                折叠块由用户 review，不自动合并到笔记正文。
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default DualEngineTestPanel
