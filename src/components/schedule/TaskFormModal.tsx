/**
 * 任务编辑器（新建 / 编辑一体）
 * -------------------------------------------------
 * 用户拍板：「创建和编辑本就是同一回事 —— 都是改字段的值，只是创建时字段为空。」
 * 所以只留**一个**表单，`mode` 决定标题与空/满，避免出现两套编辑入口。
 *
 * 可编辑任务的全部信息：任务名称、大类、归属任务、开始时间、截止时间、详细描述。
 * - 时间用共用的 `DateTimeField`（日期 + TimeWheel 滚轮），与「加课选时段」同一套控件，
 *   不再用原生 datetime-local —— 一个「选时间」只允许存在一种 UI。
 * - 「详细描述」= 任务的 brief.md，可粘贴大段文本；也是「AI 总结交付物」唯一允许引用的材料。
 * - 附件（格式要求等文件）在**行内展开的详情面板**里管理，一个字段只留一个家。
 * 两种入口：「+ 新建」（列头的大类加号）/「加子任务」 → create；行内「编辑」 → edit。
 */
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Sparkles, Square, Loader2, AlertTriangle, Info } from 'lucide-react'
import { Modal } from './Modal'
import { DateTimeField } from './TimeWheel'
import { TaskPicker, type ParentOption } from './TaskPicker'
import { loadBrief, type Project, type ProjectType } from '../../services/projectData'
import { runDualEngine } from '../../services/ai/dual-engine'
import { isAbortError } from '../../services/ai/abort'
import { useSettingsStore } from '../../stores/settings'
import type { DualEngineResult } from '../../types'

export type { ParentOption }

export interface TaskFormValue {
  title: string
  type: ProjectType
  parentId: string | null
  startAt: number
  dueAt: number
  brief: string
}

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

/** Unix ms → datetime-local 的值（YYYY-MM-DDTHH:MM）；0 或非法 → 空串 */
function msToLocal(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** datetime-local 的值 → Unix ms；空或非法 → 0（表示「未设」） */
function toMs(local: string): number {
  if (!local) return 0
  const t = new Date(local).getTime()
  return Number.isNaN(t) ? 0 : t
}

export function TaskFormModal({
  mode,
  project,
  initialType,
  initialParentId,
  parentOptions,
  onClose,
  onSubmit,
}: {
  mode: 'create' | 'edit'
  /** 编辑时的任务；新建为 null */
  project: Project | null
  /** 新建时预选的大类（列头「+」）：null = 让用户显式选 */
  initialType: ProjectType | null
  /** 新建子任务时的父节点（继承其大类）；顶级任务为 null */
  initialParentId: string | null
  parentOptions: ParentOption[]
  onClose: () => void
  onSubmit: (value: TaskFormValue) => void
}) {
  const [name, setName] = useState(project?.title ?? '')
  const [type, setType] = useState<ProjectType | ''>(project ? project.type : initialType ?? '')
  const [parentId, setParentId] = useState(project ? project.parentId ?? '' : initialParentId ?? '')
  const [start, setStart] = useState(msToLocal(project?.startAt ?? 0))
  const [due, setDue] = useState(msToLocal(project?.dueAt ?? 0))
  const [brief, setBrief] = useState('')
  const [loadingBrief, setLoadingBrief] = useState(!!project)
  const [aiRunning, setAiRunning] = useState(false)
  const [aiStage, setAiStage] = useState('')
  const [aiResult, setAiResult] = useState<DualEngineResult | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // 编辑已有任务：拉取它的详细描述；新建无需拉取
  useEffect(() => {
    if (!project) return
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
  }, [project])

  // 关闭（或卸载）时若 AI 还在跑，顺手取消
  useEffect(() => () => abortRef.current?.abort(), [])

  // 选了归属任务就继承它的大类，避免父子类型打架
  const parent = parentOptions.find((o) => o.id === parentId)
  const effectiveType: ProjectType | '' = parent ? parent.type : type
  // 子任务入口继承父节点大类，不显示选择条；编辑与顶级新建都显示
  const showType = mode === 'edit' ? true : !initialParentId

  const handleSubmit = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.warning('请填写任务名称')
      return
    }
    if (!effectiveType) {
      toast.warning('请选择大类')
      return
    }
    onSubmit({
      title: trimmed,
      type: effectiveType,
      parentId: parentId || null,
      startAt: toMs(start),
      dueAt: toMs(due),
      brief,
    })
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
      title={mode === 'create' ? '新建任务' : '编辑任务'}
      onClose={onClose}
      maxWidth="max-w-2xl"
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-ink-600 transition hover:bg-ink-100"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            className="rounded-lg bg-seal-600 px-4 py-2 text-sm font-medium text-paper-50 transition hover:bg-seal-700"
          >
            {mode === 'create' ? '创建' : '保存'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {showType && (
          <TaskPicker
            parentOptions={parentOptions}
            type={type}
            onTypeChange={setType}
            parentId={parentId}
            onParentChange={setParentId}
          />
        )}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-ink-700">任务名称</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：完成第三章初稿"
            autoFocus
            className="w-full rounded-lg border border-ink-300 px-3 py-2 text-sm focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink-700">
              开始时间 <span className="font-normal text-ink-400">（可留空）</span>
            </label>
            <DateTimeField value={start} onChange={setStart} />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink-700">
              截止时间 / DDL <span className="font-normal text-ink-400">（可留空 = 无截止）</span>
            </label>
            <DateTimeField value={due} onChange={setDue} />
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-ink-700">
            详细描述（材料）
          </label>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={7}
            placeholder={
              loadingBrief
                ? '读取中…'
                : '粘贴这份任务的要求 / 说明（如期刊格式要求原文）；也是 AI 总结交付物的唯一材料'
            }
            disabled={loadingBrief}
            className="w-full resize-y rounded-lg border border-ink-300 px-3 py-2 text-sm leading-relaxed focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
          />
        </div>

        <div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSummarize}
              disabled={aiRunning || loadingBrief}
              className="inline-flex items-center gap-1.5 rounded-lg border border-seal-200 bg-seal-50 px-3 py-2 text-sm text-seal-700 transition hover:bg-seal-100 disabled:opacity-50"
            >
              {aiRunning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              AI 总结交付物
            </button>
            {aiRunning && (
              <button
                onClick={() => abortRef.current?.abort()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-ink-100 px-3 py-2 text-sm text-ink-600 transition hover:bg-ink-200"
              >
                <Square className="h-3.5 w-3.5" />
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
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-seal-600" />
          <p className="text-xs leading-relaxed text-seal-800">
            AI-2 忠实性核查未通过，可能含不忠实 / 编造内容，请以材料为准。
          </p>
        </div>
      )}
      {result.ai2Silent && (
        <div className="flex items-start gap-2 rounded-lg border border-ink-200 bg-paper-100 p-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
          <p className="text-xs leading-relaxed text-ink-600">
            本轮 AI-2 未给出复核结论（可能输出为空），以下内容**未经忠实性核查**，请自行核对材料。
          </p>
        </div>
      )}
      <div className="rounded-lg border border-ink-200 bg-paper-100 p-3">
        <div className="mb-1.5 text-xs font-semibold text-ink-600">AI-1 总结</div>
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink-800">
          {result.ai1Output || '（AI 没有返回内容）'}
        </pre>
      </div>
    </div>
  )
}