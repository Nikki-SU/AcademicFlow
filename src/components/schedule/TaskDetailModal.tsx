/**
 * 任务详情弹层
 * -------------------------------------------------
 * - 可编辑：简明名称（title）+ 详细描述（brief.md 原文，可粘贴）。
 * - 「AI 总结交付物」：把 brief 作为**唯一材料**交给双引擎做忠实性总结，
 *   严禁编造（材料没写的一律「材料未说明」）；AI-2 未过必须显式警示。
 */
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Sparkles, Square, Loader2, AlertTriangle, Info } from 'lucide-react'
import { Modal } from './Modal'
import { loadBrief, type Project } from '../../services/projectData'
import { runDualEngine } from '../../services/ai/dual-engine'
import { isAbortError } from '../../services/ai/abort'
import { useSettingsStore } from '../../stores/settings'
import type { DualEngineResult } from '../../types'

/**
 * AI-1 指令：只总结「要交付什么」，绝不编造。
 * 与后端 faithfulness_check 语义配套（AI-2 会逐条核查是否忠实）。
 */
const AI1_INSTRUCTION = [
  '你是「忠实性总结」助手。请**只根据下面的【任务材料】**，用简洁的中文要点总结「这份任务需要交付什么」（交付物、范围、硬性要求）。',
  '',
  '硬性规则：',
  '1. 只允许使用【任务材料】里明确写到的信息，**严禁编造、补全、推测**任何材料中没有出现的内容。',
  '2. 材料里没有写到的地方，一律写「材料未说明」，不要用常识或个人经验填充。',
  '3. 只输出要点本身，不要复述这条指令，不要添加额外解释或客套话。',
].join('\n')

export function TaskDetailModal({
  project,
  onClose,
  onSave,
}: {
  project: Project
  onClose: () => void
  /** 保存 title（更新 projects）与 brief；持久化逻辑在页面里 */
  onSave: (title: string, brief: string) => Promise<void>
}) {
  const [title, setTitle] = useState(project.title)
  const [brief, setBrief] = useState('')
  const [loadingBrief, setLoadingBrief] = useState(true)
  const [saving, setSaving] = useState(false)
  const [aiRunning, setAiRunning] = useState(false)
  const [aiStage, setAiStage] = useState('')
  const [aiResult, setAiResult] = useState<DualEngineResult | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoadingBrief(true)
    loadBrief(project.projectId)
      .then((text) => {
        if (!cancelled) setBrief(text)
      })
      .catch((err) => {
        console.warn('[Schedule] 读取任务描述失败:', err)
        if (!cancelled) toast.error('读取任务描述失败')
      })
      .finally(() => {
        if (!cancelled) setLoadingBrief(false)
      })
    return () => {
      cancelled = true
    }
  }, [project.projectId])

  // 弹层关闭（或卸载）时，若 AI 还在跑，顺手取消，避免前端继续轮询
  useEffect(() => () => abortRef.current?.abort(), [])

  const handleSave = async () => {
    if (saving) return
    setSaving(true)
    try {
      await onSave(title.trim() || project.title, brief)
      toast.success('已保存')
    } catch (err) {
      console.error('[Schedule] 保存任务失败:', err)
      toast.error('保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const handleSummarize = async () => {
    if (aiRunning) return
    if (!brief.trim()) {
      // 材料为空绝不允许凭空生成 —— 直接提示，不触发任何 AI 调用
      toast.warning('没有可总结的材料，请先填写任务描述')
      return
    }
    const { ai1, ai2 } = useSettingsStore.getState().getDualEngineConfig()
    const controller = new AbortController()
    abortRef.current = controller
    setAiRunning(true)
    setAiResult(null)
    setAiStage('已提交 AI 任务，等待后端…')
    try {
      const result = await runDualEngine({
        taskType: 'faithfulness_check',
        sourceMaterial: brief,
        ai1Instruction: AI1_INSTRUCTION,
        ai1,
        ai2,
        signal: controller.signal,
        onProgress: (ev) => {
          const round = ev.attempt && ev.maxAttempts ? `（第 ${ev.attempt}/${ev.maxAttempts} 轮）` : ''
          if (ev.stage === 'ai1_running') setAiStage(`AI-1 生成中${round}…`)
          else if (ev.stage === 'ai2_running' || ev.stage === 'ai2_self_correct_running')
            setAiStage(`AI-2 忠实性核查中${round}…`)
          else if (ev.stage === 'verifying') setAiStage('正在做引证锚定校验…')
          else if (ev.stage === 'attempt_failed_retry') setAiStage(`本轮未通过，准备重写${round}…`)
        },
      })
      setAiResult(result)
    } catch (err) {
      if (isAbortError(err)) {
        toast.info('已停止 AI 总结')
      } else {
        console.error('[Schedule] AI 总结失败:', err)
        toast.error(`AI 总结失败：${(err as Error).message}`)
      }
    } finally {
      setAiRunning(false)
      setAiStage('')
      abortRef.current = null
    }
  }

  return (
    <Modal
      title="任务详情"
      onClose={onClose}
      maxWidth="max-w-2xl"
      footer={
        <>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-ink-600 hover:bg-ink-100 rounded-lg transition"
          >
            关闭
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-sm text-paper-50 bg-seal-600 hover:bg-seal-700 rounded-lg transition font-medium disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-ink-700 mb-1.5">简明名称</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-ink-700 mb-1.5">
            详细描述（材料）
          </label>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={8}
            placeholder={loadingBrief ? '读取中…' : '粘贴或输入这份任务要交付什么（作为 AI 总结的唯一材料）'}
            disabled={loadingBrief}
            className="w-full px-3 py-2 border border-ink-300 rounded-lg text-sm leading-relaxed focus:outline-none focus:border-seal-400 focus:ring-2 focus:ring-seal-100 resize-y"
          />
        </div>

        <div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSummarize}
              disabled={aiRunning || loadingBrief}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-seal-700 bg-seal-50 hover:bg-seal-100 border border-seal-200 rounded-lg transition disabled:opacity-50"
            >
              {aiRunning ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4" />
              )}
              AI 总结交付物
            </button>
            {aiRunning && (
              <button
                onClick={() => abortRef.current?.abort()}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-ink-600 bg-ink-100 hover:bg-ink-200 rounded-lg transition"
              >
                <Square className="w-3.5 h-3.5" />
                停止
              </button>
            )}
            {aiRunning && <span className="text-xs text-ink-500">{aiStage}</span>}
          </div>

          {!aiRunning && aiResult && <AiSummaryResult result={aiResult} />}
        </div>
      </div>
    </Modal>
  )
}

/** AI 总结结果展示：如实呈现，绝不伪造 —— 未通过 / 未复核都要显式说明 */
function AiSummaryResult({ result }: { result: DualEngineResult }) {
  const failed = result.finalPassed === false
  return (
    <div className="mt-3 space-y-2">
      {failed && (
        <div className="flex items-start gap-2 rounded-lg border border-seal-300 bg-seal-50 p-3">
          <AlertTriangle className="w-4 h-4 text-seal-600 shrink-0 mt-0.5" />
          <p className="text-xs leading-relaxed text-seal-800">
            AI-2 忠实性核查未通过，可能含不忠实 / 编造内容，请以材料为准。
          </p>
        </div>
      )}
      {result.ai2Silent && (
        <div className="flex items-start gap-2 rounded-lg border border-ink-200 bg-paper-100 p-3">
          <Info className="w-4 h-4 text-ink-500 shrink-0 mt-0.5" />
          <p className="text-xs leading-relaxed text-ink-600">
            本轮 AI-2 未给出复核结论（可能输出为空），以下内容**未经忠实性核查**，请自行核对材料。
          </p>
        </div>
      )}
      <div className="rounded-lg border border-ink-200 bg-paper-100 p-3">
        <div className="text-xs font-semibold text-ink-600 mb-1.5">AI-1 总结</div>
        <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-800 font-sans">
          {result.ai1Output || '（AI 没有返回内容）'}
        </pre>
      </div>
    </div>
  )
}
