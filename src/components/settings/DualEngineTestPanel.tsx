/**
 * AI 双引擎试运行面板（M3.5 忠实性核查 · M3.5.1 分阶段进度 · M3.6 分层归因重试）
 * -------------------------------------------------
 * 语义：
 *   - M3.5: 源材料 + AI-1 指令 → AI-1 总结 → AI-2 忠实性核查 → 前端引证锚定
 *   - M3.5.1: 分阶段进度、余额预检、错误分类、90s 硬超时
 *   - M3.6: 分层归因重试
 *     · passed=false & 引证 ok=true → AI-1 加戏 → 打回 AI-1 重写
 *     · 引证 ok=false → AI-2 编造引用 → AI-2 自我纠错
 *     · 两个都错 → 优先 AI-2 自纠（引证都错，AI-2 verdict 也不可信）
 *     · 最多 5 轮，仍失败则输出最后一版 + 显著红标
 *
 * UI 组成：
 *   - 顶部：账户余额条 (BalanceBar)
 *   - 输入：源材料 textarea + AI-1 指令 textarea + "使用示例"
 *   - 时间线 (StageTimeline)：含 M3.6 轮次徽章
 *   - AI-1 总结（最新一轮）+ AI-2 核查结果（最新一轮）
 *   - 重试历史 (AttemptHistory)：仅在 attempts.length > 1 时展示
 *   - 5 轮全失败红色横幅（finalPassed=false）
 */
import {
  AlertTriangle,
  BookOpenCheck,
  CheckCircle,
  ClipboardList,
  ExternalLink,
  FileText,
  Loader2,
  Play,
  XCircle,
} from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AIAuthError,
  AIQuotaError,
  AIRateLimitError,
  AITimeoutError,
} from '../../services/ai/client'
import { fetchSiliconflowUserInfo } from '../../services/ai/models'
import { useSettingsStore } from '../../stores/settings'
import type {
  AttemptReason,
  DualEngineStage,
  FaithfulnessClaim,
  UserAccountInfo,
} from '../../types'
import AttemptHistory from './AttemptHistory'
import BalanceBar from './BalanceBar'
import StageTimeline from './StageTimeline'

// M3.6: 默认样例改成光催化英文文献 + 中文总结指令
//   来源：Xi et al., Molecules 2026, 31(13), 2216（open access）
//   本地存档：/app/data/所有对话/主对话/AcademicFlow测试用例2_光催化论文.md
const SAMPLE_SOURCE = `We report a visible-light-mediated photoreduction strategy for the three-component 1,2-arylpyridylation of alkenes with arylboronic acids and 4-cyanopyridines. The reaction mechanism was verified via radical trapping experiments and DFT calculations. This reaction proceeds under mild conditions, features broad substrate compatibility and is readily scalable to the gram scale.

Pyridine derivatives are ubiquitous in natural products, pharmaceutical molecules, and functional materials, serving as core heterocyclic structures with great research value. Coupling reactions represent modular and efficient strategies for constructing Csp2-Csp3 bonds between pyridines and functionalized carbon-containing groups. A diverse array of synthetic routes is available to access pyridine derivatives, ranging from Minisci-type reactions and transition-metal-catalyzed C–H activation to photochemical synthetic protocols. In recent years, radical-mediated synthetic strategies represented by photochemistry and electrochemistry have emerged as promising alternatives. These protocols feature mild conditions, low cost, no need for pre-functionalization of substrates, and excellent functional group compatibility. Among them, visible-light-driven photoredox catalysis for alkene difunctionalization exhibits great application potential. It enables the activation of alkenes via single electron transfer (SET), introduces two functional groups in a single step and rapidly constructs diverse molecular frameworks, thus becoming an efficient new approach to alkene difunctionalization.

We used 4-cyanopyridine, 4-methylphenylboronic acid, and styrene as model substrates. After an extensive screening of the reaction conditions, we found that using Ir[dF(Me)ppy]2(dtbbpy)PF6 (1.2 mol %) as the photocatalyst and NaHCO3 as the base, the reaction in acetonitrile (MeCN) proceeded under blue LED irradiation at room temperature for 24 h to afford product 4a in 73% yield. Control experiments showed that both the light and photocatalyst were essential for the reaction, which established the photochemical character of the reaction. Furthermore, the yield decreased significantly when the reaction was carried out under an air atmosphere, demonstrating the necessity of an argon protective environment. Green light failed to drive the reaction; violet light accelerated the reaction rate but did not improve the product yield.

To investigate the mechanism of the reaction, free radical trapping experiments were conducted. When the radical scavenger 2,2,6,6-tetramethylpiperidine (TEMPO) was added to the model reaction, the reaction was completely inhibited and no product 4a was detected. The reaction was also found to be effectively quenched by the addition of another radical scavenger 2,6-di-tert-butyl-4-methylphenol (BHT). Furthermore, the corresponding trapped radical adducts were unambiguously detected by HRMS. These facts strongly suggest that the reactions proceed via a radical pathway. To further examine the proposed reaction mechanism, we performed density functional theory (DFT) calculations on the energy profile of the reaction sequence for the reaction of 4-cyanopyridine, 4-methylphenylboronic acid, and styrene, using Gaussian 09 program.`

const SAMPLE_INSTRUCTION =
  '用 4-6 句中文简洁忠实地总结上述文献，保留关键的实验条件、催化剂、产率和机理证据。'

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

interface ClassifiedError {
  title: string
  detail: string
  color: string
  cta?: { text: string; href: string }
}

function classifyError(err: unknown): ClassifiedError {
  if (err instanceof AIQuotaError) {
    return {
      title: '⛔ 硅基流动余额不足或权限受限',
      detail:
        '服务商返回 402/403，说明账户余额不足、订单异常或该模型无访问权限。请前往硅基流动控制台核实。',
      color: 'bg-red-50 border-red-300 text-red-800',
      cta: {
        text: '前往充值 →',
        href: 'https://cloud.siliconflow.cn/account/balance',
      },
    }
  }
  if (err instanceof AIAuthError) {
    return {
      title: '🔑 API Key 无效或已过期',
      detail: '服务商返回 401。请在上方设置页更新 API Key。',
      color: 'bg-red-50 border-red-300 text-red-800',
      cta: {
        text: '生成新 Key →',
        href: 'https://cloud.siliconflow.cn/account/ak',
      },
    }
  }
  if (err instanceof AIRateLimitError) {
    return {
      title: '⏱ 触发限流（429）',
      detail:
        '当前模型 QPS 达上限。建议：稍后重试 · 或换用非 Pro 版模型 · 或降低并发。',
      color: 'bg-amber-50 border-amber-300 text-amber-800',
    }
  }
  if (err instanceof AITimeoutError) {
    return {
      title: '⏳ 请求超时（90s 未响应）',
      detail:
        '硬性超时熔断。可能是网络阻塞、模型排队、账户异常或推理链过长。建议：① 换更快模型（DeepSeek-V3.2 替代 R1） ② 检查网络 ③ 稍后重试。',
      color: 'bg-orange-50 border-orange-300 text-orange-800',
    }
  }
  const msg = err instanceof Error ? err.message : String(err)
  return {
    title: '⚠️ 试运行失败',
    detail: msg,
    color: 'bg-slate-50 border-slate-300 text-slate-800',
  }
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
    siliconflowApiKey,
  } = useSettingsStore()

  const [sourceMaterial, setSourceMaterial] = useState(SAMPLE_SOURCE)
  const [ai1Instruction, setAi1Instruction] = useState(SAMPLE_INSTRUCTION)

  // M3.5.1 进度 state
  const [stage, setStage] = useState<DualEngineStage>('idle')
  const [ai1Ms, setAi1Ms] = useState<number | null>(null)
  const [ai2Ms, setAi2Ms] = useState<number | null>(null)
  const [partialAi1Output, setPartialAi1Output] = useState<string | null>(null)
  const [partialAi1Model, setPartialAi1Model] = useState<string | null>(null)
  const [ai1StartedAt, setAi1StartedAt] = useState<number | null>(null)
  const [ai2StartedAt, setAi2StartedAt] = useState<number | null>(null)
  const [hasRunOnce, setHasRunOnce] = useState(false)
  const [lastError, setLastError] = useState<ClassifiedError | null>(null)
  const [errorAtStage, setErrorAtStage] = useState<DualEngineStage | null>(null)
  const stageRef = useRef<DualEngineStage>('idle')
  const [, setTick] = useState(0)

  // M3.6 轮次 state
  const [attempt, setAttempt] = useState<number>(0)
  const [maxAttempts, setMaxAttempts] = useState<number>(5)
  const [reason, setReason] = useState<AttemptReason | undefined>(undefined)

  // M3.5.1 账户余额
  const [account, setAccount] = useState<UserAccountInfo | null>(null)
  const [isLoadingAccount, setIsLoadingAccount] = useState(false)
  const [accountError, setAccountError] = useState<string | null>(null)
  const accountFetchedOnce = useRef(false)

  const useCustom = aiProviderMode === 'custom' && advancedMode
  const displayAI1Model = useCustom
    ? customAi1Model || '（自定义 AI-1）'
    : ai1Model
  const displayAI2Model = useCustom
    ? customAi2Model || '（自定义 AI-2）'
    : ai2Model
  const canFetchBalance = !useCustom && !!siliconflowApiKey.trim()

  // 秒表：running 状态下每 250ms 刷新 UI
  useEffect(() => {
    if (
      stage === 'ai1_running' ||
      stage === 'ai2_running' ||
      stage === 'ai2_self_correct_running' ||
      stage === 'verifying'
    ) {
      const id = setInterval(() => setTick((t) => t + 1), 250)
      return () => clearInterval(id)
    }
  }, [stage])

  // 首次挂载：已配置 Key 就自动拉一次余额
  const refreshBalance = async () => {
    if (!canFetchBalance) return
    setIsLoadingAccount(true)
    setAccountError(null)
    try {
      const info = await fetchSiliconflowUserInfo(siliconflowApiKey.trim())
      setAccount({
        totalBalance: info.totalBalance,
        chargeBalance: info.chargeBalance,
        status: info.status,
        name: info.name,
        fetchedAt: Date.now(),
      })
    } catch (err) {
      setAccount(null)
      setAccountError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoadingAccount(false)
    }
  }
  useEffect(() => {
    if (!accountFetchedOnce.current && canFetchBalance) {
      accountFetchedOnce.current = true
      refreshBalance()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canFetchBalance])

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

    // 重置进度
    setStage('idle')
    stageRef.current = 'idle'
    setAi1Ms(null)
    setAi2Ms(null)
    setPartialAi1Output(null)
    setPartialAi1Model(null)
    setAi1StartedAt(null)
    setAi2StartedAt(null)
    setLastError(null)
    setErrorAtStage(null)
    setAttempt(0)
    setMaxAttempts(5)
    setReason(undefined)
    setHasRunOnce(true)

    // 跑之前后台顺手刷余额（不阻塞主流程）
    if (canFetchBalance) refreshBalance()

    try {
      const result = await runFactCheckTest(source, instr, (event) => {
        setStage(event.stage)
        stageRef.current = event.stage
        // M3.6: 每个事件都可能带轮次信息
        if (event.attempt) setAttempt(event.attempt)
        if (event.maxAttempts) setMaxAttempts(event.maxAttempts)
        if (event.reason) setReason(event.reason)

        if (event.stage === 'attempt_start') {
          // 新一轮开始：清理秒表 + 早期显示占位
          setAi1Ms(null)
          setAi2Ms(null)
          setPartialAi1Output(null)
          setAi1StartedAt(null)
          setAi2StartedAt(null)
        } else if (event.stage === 'ai1_running') {
          setAi1StartedAt(Date.now())
        } else if (event.stage === 'ai1_done') {
          setAi1Ms(event.ai1Ms ?? null)
          setPartialAi1Output(event.ai1Output ?? null)
          setPartialAi1Model(event.ai1Model ?? null)
          setAi2StartedAt(Date.now())
        } else if (
          event.stage === 'ai2_running' ||
          event.stage === 'ai2_self_correct_running'
        ) {
          setAi2StartedAt(Date.now())
        } else if (event.stage === 'ai2_done') {
          setAi2Ms(event.ai2Ms ?? null)
        }
      })
      // 根据 finalPassed 决定 toast 语气
      if (result.finalPassed) {
        toast.success(
          result.attempts.length > 1
            ? `双引擎第 ${result.attempts.length}/${result.maxAttempts} 轮通过 ✅`
            : '双引擎忠实性核查通过 ✅',
        )
      } else {
        toast.error(
          `双引擎 ${result.attempts.length}/${result.maxAttempts} 轮反复纠错后仍未通过`,
        )
      }
    } catch (err) {
      const cls = classifyError(err)
      setLastError(cls)
      setErrorAtStage(stageRef.current)
      setStage('error')
      toast.error(cls.title)
      if (err instanceof AIQuotaError && canFetchBalance) refreshBalance()
    }
  }

  const useSample = () => {
    setSourceMaterial(SAMPLE_SOURCE)
    setAi1Instruction(SAMPLE_INSTRUCTION)
  }

  const result = lastDualEngineResult
  const claims = result?.ai2Feedback.claims ?? []
  const evidence = result?.ai2Feedback.evidenceCheck
  const supportedCount = claims.filter((c) => c.verdict === 'supported').length
  const addedCount = claims.filter((c) => c.verdict === 'added').length
  const contradictedCount = claims.filter(
    (c) => c.verdict === 'contradicted',
  ).length

  // 秒表格式化
  const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`
  const now = Date.now()
  const ai1Text: string | null =
    stage === 'ai1_running' && ai1StartedAt
      ? `已 ${fmt(now - ai1StartedAt)}`
      : ai1Ms !== null
        ? fmt(ai1Ms)
        : null
  const ai2Text: string | null =
    (stage === 'ai2_running' || stage === 'ai2_self_correct_running') &&
    ai2StartedAt
      ? `已 ${fmt(now - ai2StartedAt)}`
      : ai2Ms !== null
        ? fmt(ai2Ms)
        : null
  const totalMs = ai1Ms !== null && ai2Ms !== null ? ai1Ms + ai2Ms : null
  const totalText: string | null =
    stage === 'finished' && totalMs !== null ? `${fmt(totalMs)} 本轮` : null

  // AI-1 输出：早期用 partial，最终用 result
  const ai1OutputToShow = partialAi1Output ?? result?.ai1Output ?? ''
  const ai1ModelToShow = partialAi1Model ?? result?.ai1Model ?? ''

  const showResult = result && stage === 'finished'
  // M3.6: 5 轮全失败标识
  const showFinalFailureBanner =
    showResult && !result.finalPassed && result.attempts.length >= 1

  return (
    <div className="space-y-4">
      {/* 顶部：账户余额条（仅硅基流动模式） */}
      {!useCustom && (
        <BalanceBar
          account={account}
          isLoading={isLoadingAccount}
          error={accountError}
          canFetch={canFetchBalance}
          onRefresh={refreshBalance}
        />
      )}

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
            <span className="font-mono">{displayAI2Model}</span> 核查忠实性（最多 5 轮）
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

      {/* 时间线 —— 只要跑过至少一次就一直显示 */}
      {hasRunOnce && (
        <StageTimeline
          stage={stage}
          ai1Text={ai1Text}
          ai2Text={ai2Text}
          totalText={totalText}
          errorAtStage={errorAtStage}
          attempt={attempt || undefined}
          maxAttempts={maxAttempts}
          reason={reason}
        />
      )}

      {/* 错误分类顶部条（真·异常，非"5 轮未通过"） */}
      {lastError && (
        <div className={`p-3 rounded-md border ${lastError.color}`}>
          <div className="font-semibold text-sm mb-1">{lastError.title}</div>
          <div className="text-xs leading-relaxed break-words">
            {lastError.detail}
          </div>
          {lastError.cta && (
            <a
              href={lastError.cta.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 mt-2 text-xs font-medium underline hover:no-underline"
            >
              {lastError.cta.text}
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      )}

      {/* M3.6: 5 轮反复纠错仍未通过 —— 红色显著横幅 */}
      {showFinalFailureBanner && result.attempts.length >= result.maxAttempts && (
        <div className="p-3 rounded-md border-2 border-red-400 bg-red-50">
          <div className="flex items-start gap-2">
            <XCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
            <div className="text-sm text-red-900 leading-relaxed">
              <div className="font-semibold mb-1">
                ❌ 双引擎 {result.attempts.length}/{result.maxAttempts} 轮反复纠错后仍未通过
              </div>
              <div className="text-xs leading-relaxed">
                AI-1 和 AI-2 都参与了纠错但收敛不到"忠实性通过"。可能原因：源材料存在歧义、AI-1
                持续加戏、AI-2 引证能力受模型能力限制。<b>下面展示的是第 {result.attempts.length} 轮（最后一版）结果</b>，请人工复核，或换更强的模型重试。
              </div>
            </div>
          </div>
        </div>
      )}

      {/* AI-1 总结 —— 从 ai1_done 起就展示（不等 AI-2） */}
      {ai1OutputToShow && (
        <details
          open
          className="border border-slate-200 rounded-md overflow-hidden"
        >
          <summary className="cursor-pointer px-3 py-2 bg-slate-50 hover:bg-slate-100 text-sm font-medium text-slate-800 flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-indigo-600" />
            AI-1 总结（{ai1ModelToShow}
            {result && result.attempts.length > 1 && showResult
              ? ` · 第 ${result.attempts.length}/${result.maxAttempts} 轮`
              : ''}
            ）
            {(stage === 'ai2_running' ||
              stage === 'ai2_self_correct_running') && (
              <span className="ml-auto flex items-center gap-1 text-xs font-normal text-indigo-600">
                <Loader2 className="w-3 h-3 animate-spin" />
                {stage === 'ai2_self_correct_running'
                  ? 'AI-2 自纠中…'
                  : 'AI-2 核查中…'}
              </span>
            )}
          </summary>
          <pre className="p-3 text-xs bg-white text-slate-800 whitespace-pre-wrap font-sans leading-relaxed max-h-[400px] overflow-y-auto">
            {ai1OutputToShow}
          </pre>
        </details>
      )}

      {/* 结果概览 + AI-2 核查 —— 仅在 finished 时展示 */}
      {showResult && (
        <div className="space-y-3">
          {/* 概览条 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2 bg-slate-50 border border-slate-200 rounded-md text-xs">
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
                <span className="font-mono text-amber-700">⊕{addedCount}</span>
                <span className="font-mono text-red-700">
                  ✗{contradictedCount}
                </span>
              </div>
            )}
            {result.attempts.length > 1 && (
              <div className="ml-auto flex items-center gap-1 text-slate-600">
                <span>共</span>
                <span className="font-mono">
                  {result.attempts.length}/{result.maxAttempts}
                </span>
                <span>轮</span>
              </div>
            )}
          </div>

          {/* 引证不实警告（仅当最新一轮引证仍失败） */}
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

          {/* AI-2 核查（最新一轮） */}
          <details
            open
            className="border border-slate-200 rounded-md overflow-hidden"
          >
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
              · {result.ai2Model}
              {result.attempts.length > 1
                ? ` · 第 ${result.attempts.length}/${result.maxAttempts} 轮`
                : ''}
              ）
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

          {/* M3.6 重试历史（多轮才展示） */}
          <AttemptHistory
            attempts={result.attempts}
            maxAttempts={result.maxAttempts}
            finalPassed={result.finalPassed}
          />

          {/* 未通过提示（非 5 轮全失败场景 —— 5 轮场景由上方红色横幅覆盖） */}
          {!result.finalPassed &&
            result.attempts.length < result.maxAttempts && (
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
