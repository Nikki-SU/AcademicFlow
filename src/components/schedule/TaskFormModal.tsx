/**
 * 任务编辑器（新建 / 编辑一体）
 * -------------------------------------------------
 * 用户拍板：「创建和编辑本就是同一回事 —— 都是改字段的值，只是创建时字段为空。」
 * 所以只留**一个**表单，`mode` 决定标题与空/满，避免出现两套编辑入口。
 *
 * 可编辑任务的全部信息：任务名称、大类、归属任务、截止时间（DDL）、开始时间、
 * 详细描述（材料）、要求 / 注意事项、附件。
 * - **截止时间与开始时间各自独立折叠**：截止默认展开（它是重点），开始默认折叠（通常就是当下）。
 *   两个 DateTimeField 并排会把「几时几分」挤没，所以一律上下分开放，不并排。
 * - 时间用共用的 `DateTimeField`（日期 + TimeWheel 滚轮），与「加课选时段」同一套控件，
 *   不再用原生 datetime-local —— 一个「选时间」只允许存在一种 UI。
 * - 「详细描述」= 任务的 brief.md，可粘贴大段文本；也是 AI 提炼（交付物 / 要求）唯一允许引用的材料。
 * - **要求 / 注意事项**：蓝点 = 要求、红点 = 注意事项，都是待办条件；可人工增删改，
 *   也可「AI 从材料提炼」（读详细描述 + 文本附件）。保存随表单一起落 requirements.md。
 * - **附件**：job 的格式要求文件、参考资料等，走 `projects/{id}/attachments/`；
 *   一律在**这个编辑窗**里增删（行内只读面板只展示、可下载）。仅编辑已有任务时可用
 *   （新建时还没有 projectId，创建后可进来添加）。
 * 两种入口：「+ 新建」（列头的大类加号）/「加子任务」 → create；行内「编辑」 → edit。
 */
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  Sparkles,
  Square,
  Loader2,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronRight,
  Paperclip,
  FileText,
  Upload,
  Download,
  Trash2,
  X,
} from 'lucide-react'
import { Modal } from './Modal'
import { DateTimeField } from './TimeWheel'
import { TaskPicker, type ParentOption } from './TaskPicker'
import {
  loadBrief,
  loadTaskRequirements,
  loadTaskAttachments,
  uploadTaskAttachment,
  deleteTaskAttachment,
  downloadTaskAttachment,
  collectTaskMaterial,
  type Project,
  type ProjectType,
  type TaskNote,
  type TaskAttachment,
} from '../../services/projectData'
import { runDualEngine } from '../../services/ai/dual-engine'
import { extractTaskRequirementsWithAI } from '../../services/task-requirement-extractor'
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
  /**
   * 要求 / 注意事项：`null` = 本次没动过，父层不要写 requirements.md；
   * 数组（含空数组）= 用户动过，按这个值落库（空数组表示清空）。
   */
  notes: TaskNote[] | null
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

/** datetime-local（YYYY-MM-DDTHH:MM）→ 折叠时的可读摘要（YYYY-MM-DD HH:MM） */
function readable(local: string): string {
  if (!local) return ''
  return `${local.slice(0, 10)} ${local.length >= 16 ? local.slice(11, 16) : ''}`.trim()
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 可折叠的时间字段（开始 / 截止各自独立折叠）。
 * 折叠时标题右侧显示当前值摘要，展开时露出完整的日期 + 时分控件。
 * 之所以要折叠：DateTimeField 是「日期 + 时分滚轮」，两个并排会把几时几分挤没，
 * 且开始时间多数时候没意义 —— 默认折起来，让重要的截止时间独占一行。
 */
function TimeSection({
  label,
  hint,
  open,
  onToggle,
  valueText,
  children,
}: {
  label: string
  hint: string
  open: boolean
  onToggle: () => void
  valueText: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-control border border-ink-200">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-ui-gap-sm px-ui-gap py-2 text-left"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-ink-400" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-ink-400" />
        )}
        <span className="text-ui-sm font-medium text-ink-700">{label}</span>
        <span className="text-ui-xs font-normal text-ink-400">{hint}</span>
        {!open && <span className="ml-auto text-ui-xs text-ink-500">{valueText}</span>}
      </button>
      {open && <div className="af-line-t p-3">{children}</div>}
    </div>
  )
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
  // 截止默认展开（它是重点），开始默认折叠（一般是「当下」，没必要天天填）；
  // 编辑已有值时把对应的那一段展开，免得把已填的时间藏起来。
  const [startOpen, setStartOpen] = useState(!!project?.startAt)
  const [dueOpen, setDueOpen] = useState(true)
  const [brief, setBrief] = useState('')
  const [loadingBrief, setLoadingBrief] = useState(!!project)
  const [aiRunning, setAiRunning] = useState(false)
  const [aiStage, setAiStage] = useState('')
  const [aiResult, setAiResult] = useState<DualEngineResult | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // 要求 / 注意事项：从 requirements.md 读入，随表单保存；AI 从材料提炼可追加。
  const [notes, setNotes] = useState<TaskNote[]>([])
  const [notesLoading, setNotesLoading] = useState(!!project)
  const [reqAiRunning, setReqAiRunning] = useState(false)
  const [reqAiStage, setReqAiStage] = useState('')
  const reqAbortRef = useRef<AbortController | null>(null)
  // 用户是否动过要求列表：没动就不写 requirements.md，免得每次编辑都造一个空文件
  const notesTouchedRef = useRef(false)

  // 附件：只在编辑已有任务时可管理（上传需要 projectId）
  const [attachments, setAttachments] = useState<TaskAttachment[]>([])
  const [attLoading, setAttLoading] = useState(!!project)
  const [attBusy, setAttBusy] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

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

  // 编辑已有任务：拉取要求 / 附件（新建时都是空的）
  useEffect(() => {
    if (!project) {
      setNotesLoading(false)
      setAttLoading(false)
      return
    }
    let cancelled = false
    setNotesLoading(true)
    setAttLoading(true)
    loadTaskRequirements(project.projectId)
      .then((list) => {
        if (!cancelled) setNotes(list)
      })
      .catch((err) => {
        console.warn('[Schedule] 读取任务要求失败:', err)
        if (!cancelled) toast.error('读取任务要求失败')
      })
      .finally(() => {
        if (!cancelled) setNotesLoading(false)
      })
    loadTaskAttachments(project.projectId)
      .then((list) => {
        if (!cancelled) setAttachments(list)
      })
      .catch((err) => {
        console.warn('[Schedule] 读取附件失败:', err)
        if (!cancelled) toast.error('读取附件失败')
      })
      .finally(() => {
        if (!cancelled) setAttLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [project])

  // 关闭（或卸载）时若 AI 还在跑，顺手取消
  useEffect(() => () => {
    abortRef.current?.abort()
    reqAbortRef.current?.abort()
  }, [])

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
    // 落库前去掉空白条目：不把「只敲了空格」的行写进文件
    const cleanNotes = notes
      .map((n) => ({ ...n, text: n.text.trim() }))
      .filter((n) => n.text.length > 0)
    onSubmit({
      title: trimmed,
      type: effectiveType,
      parentId: parentId || null,
      startAt: toMs(start),
      dueAt: toMs(due),
      brief,
      notes: notesTouchedRef.current ? cleanNotes : null,
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
      if (!isAbortError(err)) {
        console.error('[Schedule] AI 总结失败:', err)
        toast.error(`AI 总结失败：${(err as Error).message}`)
      }
    } finally {
      setAiRunning(false)
      setAiStage('')
      abortRef.current = null
    }
  }

  // ---------- 要求 / 注意事项（表单字段）----------
  const addNote = (kind: TaskNote['kind']) => {
    setNotes((prev) => [...prev, { kind, text: '', done: false }])
    notesTouchedRef.current = true
  }

  const updateNoteText = (index: number, text: string) => {
    setNotes((prev) => prev.map((n, i) => (i === index ? { ...n, text } : n)))
    notesTouchedRef.current = true
  }

  const toggleNoteKind = (index: number) => {
    setNotes((prev) =>
      prev.map((n, i) =>
        i === index ? { ...n, kind: n.kind === 'caution' ? 'requirement' : 'caution' } : n,
      ),
    )
    notesTouchedRef.current = true
  }

  const removeNote = (index: number) => {
    setNotes((prev) => prev.filter((_, i) => i !== index))
    notesTouchedRef.current = true
  }

  /** AI 从材料（详细描述草稿 + 文本附件）提炼要求 / 注意事项，追加到现有列表 */
  const handleExtractNotes = async () => {
    if (reqAiRunning) return
    const { ai1, ai2 } = useSettingsStore.getState().getDualEngineConfig()
    const controller = new AbortController()
    reqAbortRef.current = controller
    setReqAiRunning(true)
    setReqAiStage('正在读取任务材料…')
    try {
      // 编辑已有任务：读详细描述（用当前草稿，避免读到旧 brief）+ 文本附件；新建：只有草稿
      const material = project
        ? await collectTaskMaterial(project.projectId, brief)
        : brief.trim()
          ? `【详细描述】\n${brief.trim()}`
          : ''
      if (!material.trim()) {
        toast.warning('没有可提炼的材料，请先填写详细描述或添加文本附件')
        return
      }
      setReqAiStage('已提交 AI 任务，等待后端…')
      const extracted = await extractTaskRequirementsWithAI({
        sourceMaterial: material,
        ai1,
        ai2,
        signal: controller.signal,
        onProgress: (ev) => {
          const round = ev.attempt && ev.maxAttempts ? `（第 ${ev.attempt}/${ev.maxAttempts} 轮）` : ''
          if (ev.stage === 'ai1_running') setReqAiStage(`AI-1 提炼中${round}…`)
          else if (ev.stage === 'ai2_running' || ev.stage === 'ai2_self_correct_running')
            setReqAiStage(`AI-2 忠实性核查中${round}…`)
          else if (ev.stage === 'verifying') setReqAiStage('正在做引证锚定校验…')
          else if (ev.stage === 'attempt_failed_retry') setReqAiStage(`本轮未通过，准备重写${round}…`)
        },
      })
      if (extracted.length === 0) {
        toast.info('AI 没有从材料里提炼出要求')
        return
      }
      setNotes((prev) => {
        const existing = new Set(prev.map((n) => n.text.trim()))
        const additions = extracted.filter((n) => !existing.has(n.text.trim()))
        return [...prev, ...additions]
      })
      notesTouchedRef.current = true
    } catch (err) {
      if (!isAbortError(err)) {
        console.error('[Schedule] AI 提炼要求失败:', err)
        toast.error(`提炼失败：${(err as Error).message}`)
      }
    } finally {
      setReqAiRunning(false)
      setReqAiStage('')
      reqAbortRef.current = null
    }
  }

  // ---------- 附件（即时上传 / 删除）----------
  const handleAddFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (!project || files.length === 0) return
    setAttBusy(`上传 ${files.length} 个文件…`)
    try {
      for (const f of files) {
        await uploadTaskAttachment(project.projectId, f)
      }
      setAttachments(await loadTaskAttachments(project.projectId))
    } catch (err) {
      console.error('[Schedule] 上传附件失败:', err)
      toast.error('上传附件失败，请重试')
    } finally {
      setAttBusy(null)
    }
  }

  const handleRemoveAttachment = async (a: TaskAttachment) => {
    if (!project) return
    if (!confirm(`确定删除附件「${a.name}」吗？`)) return
    setAttBusy(`删除 ${a.name}…`)
    try {
      await deleteTaskAttachment(a.path, a.name)
      setAttachments(await loadTaskAttachments(project.projectId))
    } catch (err) {
      console.error('[Schedule] 删除附件失败:', err)
      toast.error('删除附件失败，请重试')
    } finally {
      setAttBusy(null)
    }
  }

  const handleDownloadAttachment = async (a: TaskAttachment) => {
    try {
      await downloadTaskAttachment(a.path, a.name)
    } catch (err) {
      console.error('[Schedule] 下载附件失败:', err)
      toast.error('下载附件失败，请重试')
    }
  }

  return (
    <Modal
      title={mode === 'create' ? '新建任务' : '编辑任务'}
      onClose={onClose}
      maxWidth="max-w-xl"
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-control px-ui-gap py-2 text-ui-sm text-ink-600 transition hover:bg-ink-100"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            className="rounded-control bg-seal-600 px-ui-gap py-2 text-ui-sm font-medium text-paper-50 transition hover:bg-seal-700"
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
          <label className="mb-1.5 block text-ui-sm font-medium text-ink-700">任务名称</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：完成第三章初稿"
            autoFocus
            className="w-full rounded-control border border-ink-300 px-ui-gap py-2 text-ui-sm focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
          />
        </div>
        <div className="space-y-3">
          <TimeSection
            label="截止时间 / DDL"
            hint="留空 = 不定期任务"
            open={dueOpen}
            onToggle={() => setDueOpen((v) => !v)}
            valueText={readable(due) || '未设置'}
          >
            <DateTimeField value={due} onChange={setDue} />
          </TimeSection>
          <TimeSection
            label="开始时间"
            hint="可留空，通常就是当下"
            open={startOpen}
            onToggle={() => setStartOpen((v) => !v)}
            valueText={readable(start) || '未设置'}
          >
            <DateTimeField value={start} onChange={setStart} />
          </TimeSection>
        </div>

        <div>
          <label className="mb-1.5 block text-ui-sm font-medium text-ink-700">
            详细描述（材料）
          </label>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={7}
            placeholder={
              loadingBrief
                ? '读取中…'
                : '粘贴这份任务的要求 / 说明（如期刊格式要求原文）；也是 AI 总结 / 提炼要求的唯一材料'
            }
            disabled={loadingBrief}
            className="w-full resize-y rounded-control border border-ink-300 px-ui-gap py-2 text-ui-sm leading-relaxed focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
          />
        </div>

        <div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSummarize}
              disabled={aiRunning || reqAiRunning || loadingBrief}
              className="inline-flex items-center gap-1.5 rounded-control border border-seal-200 bg-seal-50 px-ui-gap py-2 text-ui-sm text-seal-700 transition hover:bg-seal-100 disabled:opacity-50"
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
                className="inline-flex items-center gap-1.5 rounded-control bg-ink-100 px-ui-gap py-2 text-ui-sm text-ink-600 transition hover:bg-ink-200"
              >
                <Square className="h-3.5 w-3.5" />
                停止
              </button>
            )}
            {aiRunning && <span className="text-ui-xs text-ink-500">{aiStage}</span>}
          </div>

          {!aiRunning && aiResult && <AiSummaryResult result={aiResult} />}
        </div>

        {/* 要求 / 注意事项：蓝点 = 要求，红点 = 注意事项，都是待办条件 */}
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <label className="text-ui-sm font-medium text-ink-700">要求 / 注意事项</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleExtractNotes}
                disabled={reqAiRunning || aiRunning || loadingBrief}
                className="inline-flex items-center gap-1.5 rounded-control border border-seal-200 bg-seal-50 px-2.5 py-1.5 text-ui-xs text-seal-700 transition hover:bg-seal-100 disabled:opacity-50"
              >
                {reqAiRunning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                AI 从材料提炼
              </button>
              {reqAiRunning && (
                <button
                  type="button"
                  onClick={() => reqAbortRef.current?.abort()}
                  className="inline-flex items-center gap-1 rounded-control bg-ink-100 px-2 py-1.5 text-ui-xs text-ink-600 transition hover:bg-ink-200"
                >
                  <Square className="h-3 w-3" />
                  停止
                </button>
              )}
            </div>
          </div>
          {reqAiRunning && <p className="mb-1.5 text-ui-xs text-ink-500">{reqAiStage}</p>}
          <p className="mb-2 text-ui-xs text-ink-400">
            蓝点 = 要求，红点 = 注意事项；点圆点可切换类型。
          </p>

          {notesLoading ? (
            <p className="text-ui-xs text-ink-400">读取中…</p>
          ) : (
            <>
              {notes.length > 0 && (
                <ul className="space-y-1.5">
                  {notes.map((n, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleNoteKind(i)}
                        title={
                          n.kind === 'caution' ? '注意事项（点击改为要求）' : '要求（点击改为注意事项）'
                        }
                        aria-label="切换要求 / 注意事项"
                        className={`h-3.5 w-3.5 shrink-0 rounded-full transition ${
                          n.kind === 'caution' ? 'bg-rose-500' : 'bg-blue-500'
                        }`}
                      />
                      <input
                        type="text"
                        value={n.text}
                        onChange={(e) => updateNoteText(i, e.target.value)}
                        placeholder={n.kind === 'caution' ? '注意事项' : '要求'}
                        className="min-w-0 flex-1 rounded-control border border-ink-300 px-2.5 py-1.5 text-ui-sm focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
                      />
                      <button
                        type="button"
                        onClick={() => removeNote(i)}
                        title="删除"
                        className="shrink-0 rounded-control-sm p-1 text-ink-400 transition hover:text-rose-600"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => addNote('requirement')}
                  className="inline-flex items-center gap-1.5 rounded-control border border-ink-300 px-2.5 py-1.5 text-ui-xs text-ink-600 transition hover:border-seal-300 hover:text-seal-700"
                >
                  <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
                  要求
                </button>
                <button
                  type="button"
                  onClick={() => addNote('caution')}
                  className="inline-flex items-center gap-1.5 rounded-control border border-ink-300 px-2.5 py-1.5 text-ui-xs text-ink-600 transition hover:border-seal-300 hover:text-seal-700"
                >
                  <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
                  注意事项
                </button>
              </div>
            </>
          )}
        </div>

        {/* 附件：仅编辑已有任务时可增删（新建时还没有 projectId） */}
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <label className="inline-flex items-center gap-1 text-ui-sm font-medium text-ink-700">
              <Paperclip className="h-4 w-4 text-ink-500" />
              附件
              {project && <span className="text-ui-xs font-normal text-ink-400">（{attachments.length}）</span>}
            </label>
            {project && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={attBusy !== null}
                className="inline-flex items-center gap-1.5 rounded-control border border-ink-300 px-2.5 py-1.5 text-ui-xs text-ink-600 transition hover:border-seal-300 hover:text-seal-700 disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                添加文件
              </button>
            )}
          </div>
          {project && (
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleAddFiles} />
          )}

          {!project ? (
            <p className="text-ui-xs text-ink-400">
              附件（格式要求、参考资料等）可在创建任务后，从任务的「编辑」窗里添加。
            </p>
          ) : (
            <>
              <p className="mb-2 text-ui-xs text-ink-400">
                文本类附件（.txt / .md / .tex 等）可被 AI 读取，用于提炼要求。
              </p>
              {attLoading ? (
                <p className="text-ui-xs text-ink-400">读取附件中…</p>
              ) : attachments.length === 0 ? (
                <p className="text-ui-xs text-ink-400">还没有附件</p>
              ) : (
                <ul className="space-y-1.5">
                  {attachments.map((a) => (
                    <li
                      key={a.path}
                      className="flex items-center gap-2 rounded-control border border-ink-200 px-2.5 py-1.5"
                    >
                      <FileText className="h-4 w-4 shrink-0 text-ink-400" />
                      <span className="min-w-0 flex-1 truncate text-ui-sm text-ink-700" title={a.name}>
                        {a.name}
                      </span>
                      <span className="shrink-0 text-ui-xs text-ink-400">{formatSize(a.size)}</span>
                      <button
                        type="button"
                        onClick={() => void handleDownloadAttachment(a)}
                        title="下载"
                        className="shrink-0 rounded-control-sm p-1 text-ink-400 transition hover:text-seal-600"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleRemoveAttachment(a)}
                        title="删除"
                        className="shrink-0 rounded-control-sm p-1 text-ink-400 transition hover:text-rose-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {attBusy && (
                <p className="mt-1 inline-flex items-center gap-1 text-ui-xs text-ink-400">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {attBusy}
                </p>
              )}
            </>
          )}
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
        <div className="flex items-start gap-2 rounded-control border border-seal-300 bg-seal-50 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-seal-600" />
          <p className="text-ui-xs leading-relaxed text-seal-800">
            AI-2 忠实性核查未通过，可能含不忠实 / 编造内容，请以材料为准。
          </p>
        </div>
      )}
      {result.ai2Silent && (
        <div className="flex items-start gap-2 rounded-control border border-ink-200 bg-paper-100 p-3">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
          <p className="text-ui-xs leading-relaxed text-ink-600">
            本轮 AI-2 未给出复核结论（可能输出为空），以下内容**未经忠实性核查**，请自行核对材料。
          </p>
        </div>
      )}
      <div className="rounded-control border border-ink-200 bg-paper-100 p-3">
        <div className="mb-1.5 text-ui-xs font-semibold text-ink-600">AI-1 总结</div>
        <pre className="whitespace-pre-wrap break-words font-sans text-ui-sm leading-relaxed text-ink-800">
          {result.ai1Output || '（AI 没有返回内容）'}
        </pre>
      </div>
    </div>
  )
}
