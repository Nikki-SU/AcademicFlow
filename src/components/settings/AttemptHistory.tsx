/**
 * 双引擎重试历史（M3.6）
 * -------------------------------------------------
 * 展示 5 轮 (或 attempts.length 轮) 的历史记录：
 *   - 每轮一个可折叠 details
 *   - summary：第 N/M 轮 · 归因原因 · 通过/未通过 · AI-1 / AI-2 耗时
 *   - 展开：本轮 AI-1 输出（ai2_self_correct 时说明"AI-1 输出保留自上一轮"）+ AI-2 反馈摘要
 *
 * 只在 attempts.length > 1 时才显示（首次单轮通过不需要看历史）
 */
import {
  AlertTriangle,
  CheckCircle,
  ChevronRight,
  RotateCcw,
} from 'lucide-react'
import type { AttemptReason, DualEngineAttempt } from '../../types'

interface AttemptHistoryProps {
  attempts: DualEngineAttempt[]
  maxAttempts: number
  finalPassed: boolean
}

function reasonLabel(reason: AttemptReason): string {
  if (reason === 'first_run') return '首次运行'
  if (reason === 'ai1_rewrite') return 'AI-1 重写'
  return 'AI-2 自纠'
}

function reasonColor(reason: AttemptReason): string {
  if (reason === 'ai1_rewrite')
    return 'bg-amber-100 text-amber-800 border-amber-300'
  if (reason === 'ai2_self_correct')
    return 'bg-purple-100 text-purple-800 border-purple-300'
  return 'bg-slate-100 text-slate-700 border-slate-300'
}

function fmtMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

function AttemptHistory({
  attempts,
  maxAttempts,
  finalPassed,
}: AttemptHistoryProps) {
  if (attempts.length <= 1) return null

  return (
    <details
      open={!finalPassed}
      className="border border-slate-200 rounded-md overflow-hidden"
    >
      <summary className="cursor-pointer px-3 py-2 bg-slate-50 hover:bg-slate-100 text-sm font-medium text-slate-800 flex items-center gap-2">
        <RotateCcw className="w-4 h-4 text-indigo-600" />
        重试历史（共 {attempts.length}/{maxAttempts} 轮
        {finalPassed ? '，最终通过 ✅' : '，最终未通过 ❌'}）
      </summary>
      <div className="p-2 space-y-1.5 bg-white">
        {attempts.map((a) => {
          const claims = a.ai2Feedback.claims
          const added = claims.filter((c) => c.verdict === 'added').length
          const contradicted = claims.filter(
            (c) => c.verdict === 'contradicted',
          ).length
          const ec = a.ai2Feedback.evidenceCheck
          const evidenceLine = ec.checked
            ? `引证 ${ec.matched}/${ec.checked}`
            : '无需引证'

          return (
            <details
              key={a.attempt}
              open={a.attempt === attempts.length && !a.passed}
              className="border border-slate-200 rounded overflow-hidden"
            >
              <summary className="cursor-pointer px-2 py-1.5 bg-slate-50 hover:bg-slate-100 text-xs flex items-center gap-2 flex-wrap">
                <ChevronRight className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
                <span
                  className={`shrink-0 px-1.5 py-0.5 font-mono border rounded ${reasonColor(a.reason)}`}
                >
                  第 {a.attempt} 轮 · {reasonLabel(a.reason)}
                </span>
                {a.passed ? (
                  <span className="flex items-center gap-1 shrink-0 px-1.5 py-0.5 bg-green-50 text-green-700 border border-green-200 rounded">
                    <CheckCircle className="w-3 h-3" />
                    通过
                  </span>
                ) : (
                  <span className="flex items-center gap-1 shrink-0 px-1.5 py-0.5 bg-red-50 text-red-700 border border-red-200 rounded">
                    <AlertTriangle className="w-3 h-3" />
                    未通过
                  </span>
                )}
                <span className="font-mono text-slate-500">
                  AI-1 {a.ai1Invoked ? fmtMs(a.ai1Ms) : '（沿用）'} · AI-2{' '}
                  {fmtMs(a.ai2Ms)}
                </span>
                <span className="font-mono text-slate-500">
                  ⊕{added} ✗{contradicted} · {evidenceLine}
                </span>
              </summary>
              <div className="p-2 space-y-2 bg-white text-xs">
                {/* AI-1 输出（本轮版本） */}
                <div>
                  <div className="font-medium text-slate-700 mb-1">
                    AI-1 输出
                    {!a.ai1Invoked && (
                      <span className="ml-1 text-[11px] font-normal text-slate-500">
                        （本轮 AI-2 自纠，AI-1 输出沿用上一轮）
                      </span>
                    )}
                  </div>
                  <pre className="p-2 bg-slate-50 border border-slate-200 rounded whitespace-pre-wrap font-sans leading-relaxed max-h-[160px] overflow-y-auto">
                    {a.ai1Output}
                  </pre>
                </div>

                {/* AI-2 反馈摘要 */}
                {a.ai2Feedback.summary && (
                  <div className="p-2 bg-slate-50 border-l-2 border-indigo-400 text-slate-700 leading-relaxed">
                    <span className="font-medium">AI-2 评价：</span>
                    {a.ai2Feedback.summary}
                  </div>
                )}

                {/* claims 简表 */}
                {claims.length > 0 && (
                  <div>
                    <div className="font-medium text-slate-700 mb-1">
                      claims 明细（{claims.length} 条）
                    </div>
                    <ul className="space-y-1">
                      {claims.map((c, idx) => {
                        const evidenceFailed =
                          ec.failedIndices.includes(idx)
                        const tag =
                          c.verdict === 'supported'
                            ? '✓'
                            : c.verdict === 'added'
                              ? '⊕'
                              : '✗'
                        const tagColor =
                          c.verdict === 'supported'
                            ? 'text-green-700'
                            : c.verdict === 'added'
                              ? 'text-amber-700'
                              : 'text-red-700'
                        return (
                          <li
                            key={idx}
                            className="flex items-start gap-1.5 leading-relaxed"
                          >
                            <span
                              className={`shrink-0 font-mono font-semibold ${tagColor}`}
                            >
                              {tag}
                            </span>
                            <span className="text-slate-800 break-words">
                              {c.claim}
                              {evidenceFailed && (
                                <span className="ml-1 text-red-700 font-mono">
                                  【引证失败】
                                </span>
                              )}
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </div>
            </details>
          )
        })}
      </div>
    </details>
  )
}

export default AttemptHistory
