/**
 * AI 双引擎试运行面板（M3.5 重构 · 忠实性核查语义）
 * -------------------------------------------------
 * 让用户贴一段【源材料】+ 给 AI-1 一条【指令】
 *   → AI-1 基于源材料生成总结
 *   → AI-2 拿 (源材料, 总结) 逐条核查忠实性
 *   → 前端锚定校验 AI-2 的引证是否真的在源材料中
 *
 * 三色徽章：
 *   - 绿 supported（源材料支撑该 claim）
 *   - 黄 added（AI-1 加了源材料没有的信息）
 *   - 红 contradicted（AI-1 曲解了源材料）
 *
 * 引证不实警告：如果 AI-2 给出的 source_span 无法在源材料中 grep 到 → 顶部红条 + 该 claim 标 ❌
 */
import {
  AlertTriangle,
  BookOpenCheck,
  CheckCircle,
  ClipboardList,
  FileText,
  Loader2,
  Play,
  Timer,
  XCircle,
} from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useSettingsStore } from '../../stores/settings'
import type { FaithfulnessClaim } from '../../types'

/** 预填示例源材料（真实、事实正确 · 用于跑通 M3.5） */
const SAMPLE_SOURCE = `2015 年 10 月 5 日，瑞典卡罗琳医学院宣布，中国科学家屠呦呦与另外两位科学家共同获得诺贝尔生理学或医学奖，以表彰她在青蒿素研究方面的成就。屠呦呦是首位获得诺贝尔科学奖的中国大陆科学家。青蒿素是从植物青蒿中提取的一种化合物，可有效治疗疟疾。屠呦呦的研究团队在 20 世纪 70 年代从东晋葛洪所著《肘后备急方》中获得灵感，采用低温乙醚提取法成功分离出青蒿素。世界卫生组织已将青蒿素类药物列为疟疾的一线治疗药物。`

const SAMPLE_INSTRUCTION = '用 2-3 句话简洁忠实地总结上述源材料，保留关键事实。'

/** verdict → 徽章样式 */
const VERDICT_STYLE: Record<
  FaithfulnessClaim['verdict'],
  { label: string; color: string; icon: JSX.Element }
> = {
  supported: {
    label: '有据 supported',
    color: 'bg-green-100 text-green-800 border-green-300',
    icon: <CheckCircle className="w-3.5 h-3.5" />,
  },
  added: {
    label: '加戏 added',
    color: 'bg-amber-100 text-amber-800 border-amber-300',
    icon: <AlertTriangle className="w-3.5 h-3.5" />,
  },
  contradicted: {
    label: '曲解 contradicted',
    color: 'bg-red-100 text-red-800 border-red-300',
    icon: <XCircle className="w-3.5 h-3.5" />,
  },
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

  const [sourceMaterial, setSourceMaterial] = useState(SAMPLE_SOURCE)
  const [ai1Instruction, setAi1Instruction] = useState(SAMPLE_INSTRUCTION)

  const useCustom = aiProviderMode === 'custom' && advancedMode
  const displayAI1Model = useCustom
    ? customAi1Model || '（自定义 AI-1）'
    : ai1Model
  const displayAI2Model = useCustom
    ? customAi2Model || '（自定义 AI-2）'
    : ai2Model

  const handleRun = async () => {
    const source = sourceMaterial.trim()
    const instr = ai1Instruction.trim()
    if (!source) {
      toast.error('请填写源材料')
      return
    }
    if (!instr) {
      toast.error('请填写给 AI-1 的指令')
      return
    }
    try {
      await runFactCheckTest(source, instr)
      toast.success('双引擎忠实性核查完成')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`试运行失败：${msg}`)
    }
  }

  const useSample = () => {
    setSourceMaterial(SAMPLE_SOURCE)
    setAi1Instruction(SAMPLE_INSTRUCTION)
  }

  const result = lastDualEngineResult
  const duration = result
    ? ((result.finishedAt - result.startedAt) / 1000).toFixed(1)
    : null

  const claims = result?.ai2Feedback.claims ?? []
  const evidence = result?.ai2Feedback.evidenceCheck
  const supportedCount = claims.filter((c) => c.verdict === 'supported').length
  const addedCount = claims.filter((c) => c.verdict === 'added').length
  const contradictedCount = claims.filter(
    (c) => c.verdict === 'contradicted',
  ).length

  return (
    <div className="space-y-4">
      {/* 源材料输入 */}
      <div>
        <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700 mb-1.5">
          <FileText className="w-4 h-4 text-indigo-600" />
          源材料（ground truth · AI-1 只能基于这段做总结）
        </label>
        <textarea
          value={sourceMaterial}
          onChange={(e) => setSourceMaterial(e.target.value)}
          disabled={isRunningDualEngine}
          rows={7}
          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md
                     focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent
                     disabled:bg-slate-50 disabled:cursor-not-allowed font-mono leading-relaxed"
          placeholder="粘贴一段源材料（文献段落、教材原文、网页正文等），AI-1 将仅基于这段做总结"
        />
      </div>

      {/* AI-1 指令输入 */}
      <div>
        <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700 mb-1.5">
          <BookOpenCheck className="w-4 h-4 text-indigo-600" />
          给 AI-1 的指令
        </label>
        <textarea
          value={ai1Instruction}
          onChange={(e) => setAi1Instruction(e.target.value)}
          disabled={isRunningDualEngine}
          rows={2}
          className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md
                     focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent
                     disabled:bg-slate-50 disabled:cursor-not-allowed leading-relaxed"
          placeholder="如：用 2-3 句话总结上述材料"
        />
        <div className="flex items-center justify-between mt-1">
          <p className="text-xs text-slate-500">
            AI-1 <span className="font-mono">{displayAI1Model}</span> 生成 → AI-2{' '}
            <span className="font-mono">{displayAI2Model}</span> 核查忠实性
          </p>
          <button
            type="button"
            onClick={useSample}
            disabled={isRunningDualEngine}
            className="text-xs text-indigo-600 hover:text-indigo-800 disabled:text-slate-300"
          >
            使用示例
          </button>
        </div>
      </div>

      {/* 运行按钮 */}
      <button
        type="button"
        onClick={handleRun}
        disabled={
          isRunningDualEngine ||
          !sourceMaterial.trim() ||
          !ai1Instruction.trim()
        }
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
            运行忠实性核查
          </>
        )}
      </button>

      {/* 结果 */}
      {result && (
        <div className="space-y-3 pt-2">
          {/* 概览 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-xs">
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
            {claims.length > 0 && (
              <div className="flex items-center gap-2 text-slate-600">
                <span>断言</span>
                <span className="font-mono text-green-700">
                  ✓{supportedCount}
                </span>
                <span className="font-mono text-amber-700">
                  ⊕{addedCount}
                </span>
                <span className="font-mono text-red-700">
                  ✗{contradictedCount}
                </span>
              </div>
            )}
          </div>

          {/* 引证不实警告 */}
          {evidence && !evidence.ok && (
            <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-md">
              <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-red-800 leading-relaxed">
                <div className="font-semibold mb-0.5">
                  ⚠️ AI-2 引证不实（{evidence.failedIndices.length}/
                  {evidence.checked} 条 source_span 无法在源材料中找到）
                </div>
                AI-2 声称的原文引用在源材料中不存在 —— 可能是 AI-2
                自身幻觉。已强制降级为 passed=false，请人工复核。
              </div>
            </div>
          )}

          {/* AI-1 总结 */}
          <details open className="border border-slate-200 rounded-md overflow-hidden">
            <summary className="cursor-pointer px-3 py-2 bg-slate-50 hover:bg-slate-100 text-sm font-medium text-slate-800 flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-indigo-600" />
              AI-1 总结（{result.ai1Model}）
            </summary>
            <pre className="p-3 text-xs bg-white text-slate-800 whitespace-pre-wrap font-sans leading-relaxed max-h-[400px] overflow-y-auto">
              {result.ai1Output}
            </pre>
          </details>

          {/* AI-2 核查 */}
          <details open className="border border-slate-200 rounded-md overflow-hidden">
            <summary className="cursor-pointer px-3 py-2 bg-slate-50 hover:bg-slate-100 text-sm font-medium text-slate-800 flex items-center gap-2">
              {result.ai2Feedback.passed ? (
                <CheckCircle className="w-4 h-4 text-green-600" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-orange-600" />
              )}
              AI-2 忠实性核查（
              {result.ai2Feedback.passed
                ? '通过 ✅'
                : `发现 ${addedCount + contradictedCount} 个问题`}
              · {result.ai2Model}）
            </summary>
            <div className="p-3 space-y-2 bg-white">
              {result.ai2Feedback.summary && (
                <div className="p-2 bg-slate-50 border-l-2 border-indigo-400 text-xs text-slate-700 leading-relaxed">
                  {result.ai2Feedback.summary}
                </div>
              )}
              {claims.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <AlertTriangle className="w-4 h-4 text-orange-500" />
                  AI-2 未返回可解析的 claims（查看下方原始输出）
                </div>
              ) : (
                <ul className="space-y-2">
                  {claims.map((c, idx) => {
                    const style = VERDICT_STYLE[c.verdict]
                    const evidenceFailed =
                      evidence?.failedIndices.includes(idx) ?? false
                    const needsSpan = c.verdict !== 'added'
                    return (
                      <li
                        key={idx}
                        className="p-2 border border-slate-200 rounded space-y-1.5"
                      >
                        <div className="flex items-start gap-2">
                          <span
                            className={`shrink-0 flex items-center gap-1 px-2 py-0.5 text-xs font-mono border rounded ${style.color}`}
                          >
                            {style.icon}
                            {style.label}
                          </span>
                          <span className="text-xs text-slate-800 leading-relaxed font-medium">
                            {c.claim}
                          </span>
                        </div>
                        {c.explanation && (
                          <div className="text-xs text-slate-600 pl-1 leading-relaxed">
                            {c.explanation}
                          </div>
                        )}
                        {needsSpan && (
                          <div className="flex items-start gap-1.5 text-xs pl-1">
                            {evidenceFailed ? (
                              <span className="shrink-0 px-1.5 py-0.5 bg-red-100 text-red-700 border border-red-300 rounded font-mono">
                                引证 ❌ 不实
                              </span>
                            ) : (
                              <span className="shrink-0 px-1.5 py-0.5 bg-green-50 text-green-700 border border-green-200 rounded font-mono">
                                引证 ✅ 命中
                              </span>
                            )}
                            <span
                              className={`text-slate-600 italic leading-relaxed ${
                                evidenceFailed ? 'line-through' : ''
                              }`}
                            >
                              "{c.source_span || '（AI-2 未提供 span）'}"
                            </span>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
              {/* 原始 JSON */}
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

          {/* 未通过提示 */}
          {!result.ai2Feedback.passed && (
            <div className="flex items-start gap-2 p-3 bg-orange-50 border border-orange-200 rounded-md">
              <XCircle className="w-4 h-4 text-orange-600 mt-0.5 flex-shrink-0" />
              <div className="text-xs text-orange-800 leading-relaxed">
                双引擎未通过审阅。按 SPEC §9.2 设计，M4 起 AI 结果将只放入
                <code className="mx-1 px-1 py-0.5 bg-orange-100 rounded">
                  :::ai-output
                </code>
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
