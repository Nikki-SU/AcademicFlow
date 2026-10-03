/**
 * 任务要求（只读视图，全库共用）
 * -------------------------------------------------
 * 用户要求：点任务弹出的**就是且只是任务要求**（只读展示），
 * 编辑一律走「笔」→ 统一编辑窗。任务栏行内面板与 DDL 弹层共用这一份，
 * 保证两处「点开看到的东西」完全一致（同类控件全库一致）。
 *
 * 三块只读内容：
 * - 详细描述：任务材料原文（brief.md）
 * - 要求 / 注意事项：从材料提炼的待办条件，蓝点 = 要求、红点 = 注意事项；
 *   点圆点即标记完成（变绿勾），与任务条目「点圈完成」一致（ADJ-77）
 * - 附件：projects/{id}/attachments/ 下的文件，仅可下载
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Paperclip, Download, Loader2, Pencil, CheckCircle2 } from 'lucide-react'
import {
  loadBrief,
  loadTaskAttachments,
  downloadTaskAttachment,
  loadTaskRequirements,
  saveTaskRequirements,
  type Project,
  type TaskAttachment,
  type TaskNote,
} from '../../services/projectData'

/** Unix ms → YYYY-MM-DD HH:MM；0 → 未设 */
function formatTime(ms: number): string {
  if (!ms) return '未设'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function TaskRequirementsView({
  project,
  parentTitle,
  onEdit,
}: {
  project: Project
  /** 归属任务名；顶级任务为 null */
  parentTitle: string | null
  /** 「笔」的同一个入口：打开统一编辑窗 */
  onEdit: () => void
}) {
  const [brief, setBrief] = useState('')
  const [briefLoading, setBriefLoading] = useState(true)
  const [notes, setNotes] = useState<TaskNote[]>([])
  const [notesLoading, setNotesLoading] = useState(true)
  const [attachments, setAttachments] = useState<TaskAttachment[]>([])
  const [attLoading, setAttLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  // 依赖 project.updatedAt：在编辑窗保存后父层会刷新 project，这里随之重读，
  // 保证展示的不是「打开时那一份」的过期数据。
  useEffect(() => {
    let cancelled = false
    setBriefLoading(true)
    loadBrief(project.projectId)
      .then((text) => {
        if (!cancelled) setBrief(text)
      })
      .catch((err) => {
        console.warn('[Schedule] 读取任务描述失败:', err)
        if (!cancelled) toast.error('读取任务描述失败')
      })
      .finally(() => {
        if (!cancelled) setBriefLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [project.projectId, project.updatedAt])

  useEffect(() => {
    let cancelled = false
    setNotesLoading(true)
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
    return () => {
      cancelled = true
    }
  }, [project.projectId, project.updatedAt])

  useEffect(() => {
    let cancelled = false
    setAttLoading(true)
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
  }, [project.projectId, project.updatedAt])

  const handleDownload = async (a: TaskAttachment) => {
    setBusy(`下载 ${a.name}…`)
    try {
      await downloadTaskAttachment(a.path, a.name)
    } catch (err) {
      console.error('[Schedule] 下载附件失败:', err)
      toast.error('下载附件失败，请重试')
    } finally {
      setBusy(null)
    }
  }

  // 点圆点即切换完成：先乐观更新，落库失败则回滚并报错。
  const handleToggleDone = async (index: number) => {
    const prev = notes
    const next = notes.map((n, i) => (i === index ? { ...n, done: !n.done } : n))
    setNotes(next)
    try {
      await saveTaskRequirements(project.projectId, next)
    } catch (err) {
      console.error('[Schedule] 保存任务要求失败:', err)
      toast.error('保存失败，请重试')
      setNotes(prev)
    }
  }

  const doneCount = notes.filter((n) => n.done).length

  return (
    <div className="space-y-3">
      {/* 元信息 + 编辑入口（打开编辑窗，不是就地编辑） */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5 text-ui-2xs text-ink-500">
          <div className="truncate">归属：{parentTitle || '（顶级任务）'}</div>
          <div className="truncate">
            开始 {formatTime(project.startAt)} · 截止 {formatTime(project.dueAt)}
          </div>
        </div>
        <button
          type="button"
          onClick={onEdit}
          title="在编辑窗里修改名称 / 归属 / 时间 / 描述 / 要求 / 附件"
          className="inline-flex shrink-0 items-center gap-1 rounded-control-sm border border-ink-200 px-ui-gap-sm py-0.5 text-ui-2xs text-ink-500 transition hover:border-seal-300 hover:text-seal-600"
        >
          <Pencil className="h-ui-icon-sm w-ui-icon-sm" />
          编辑
        </button>
      </div>

      {/* 详细描述（只读） */}
      <div>
        <div className="mb-1 text-ui-2xs font-medium text-ink-600">详细描述</div>
        {briefLoading ? (
          <p className="text-ui-2xs text-ink-400">读取中…</p>
        ) : brief.trim() ? (
          <p className="whitespace-pre-wrap break-words rounded-control-sm border border-ink-100 bg-paper-100/60 px-2 py-1.5 text-ui-xs leading-relaxed text-ink-700">
            {brief}
          </p>
        ) : (
          <p className="text-ui-2xs text-ink-400">未填写</p>
        )}
      </div>

      {/* 要求 / 注意事项（只读待办；蓝点 = 要求，红点 = 注意事项） */}
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-ui-2xs font-medium text-ink-600">要求 / 注意事项</span>
          {notes.length > 0 && (
            <span className="shrink-0 text-ui-2xs text-ink-400">
              {doneCount}/{notes.length}
            </span>
          )}
        </div>
        {notesLoading ? (
          <p className="text-ui-2xs text-ink-400">读取中…</p>
        ) : notes.length === 0 ? (
          <p className="text-ui-2xs text-ink-400">还没有要求，去编辑窗里用 AI 从材料提炼或手动添加</p>
        ) : (
          <ul className="space-y-1">
            {notes.map((n, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleToggleDone(i)}
                  title={n.done ? '标记为未完成' : '标记为已完成'}
                  className="grid h-ui-icon-sm w-ui-icon-sm shrink-0 place-items-center rounded-full transition hover:scale-110"
                >
                  {n.done ? (
                    <CheckCircle2 className="h-ui-icon-sm w-ui-icon-sm text-emerald-500" />
                  ) : (
                    <span
                      className={`h-ui-dot w-ui-dot rounded-full ${
                        n.kind === 'caution' ? 'bg-rose-500' : 'bg-blue-500'
                      }`}
                    />
                  )}
                </button>
                <span
                  className={`min-w-0 flex-1 break-words text-ui-2xs ${
                    n.done ? 'text-ink-400 line-through' : 'text-ink-700'
                  }`}
                >
                  {n.text}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 附件（只读，仅可下载） */}
      <div>
        <div className="mb-1 flex items-center gap-1 text-ui-2xs font-medium text-ink-600">
          <Paperclip className="h-ui-icon-sm w-ui-icon-sm" />
          附件
          <span className="font-normal text-ink-400">（{attachments.length}）</span>
        </div>
        {attLoading ? (
          <p className="text-ui-2xs text-ink-400">读取附件中…</p>
        ) : attachments.length === 0 ? (
          <p className="text-ui-2xs text-ink-400">还没有附件</p>
        ) : (
          <ul className="space-y-1">
            {attachments.map((a) => (
              <li
                key={a.path}
                className="flex items-center gap-1.5 rounded-control-sm border border-ink-100 bg-paper-100/60 px-1.5 py-1"
              >
                <span className="min-w-0 flex-1 truncate text-ui-2xs text-ink-700" title={a.name}>
                  {a.name}
                </span>
                <span className="shrink-0 text-ui-2xs text-ink-400">{formatSize(a.size)}</span>
                <button
                  type="button"
                  onClick={() => void handleDownload(a)}
                  title="下载"
                  className="shrink-0 rounded-control-sm p-0.5 text-ink-400 transition hover:text-seal-600"
                >
                  <Download className="h-ui-icon-sm w-ui-icon-sm" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {busy && (
          <p className="mt-1 inline-flex items-center gap-1 text-ui-2xs text-ink-400">
            <Loader2 className="h-ui-icon-sm w-ui-icon-sm animate-spin" />
            {busy}
          </p>
        )}
      </div>
    </div>
  )
}
