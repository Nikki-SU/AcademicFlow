/**
 * 任务行内详情面板（点任务文字展开）
 * -------------------------------------------------
 * 用户要求：「点击每一个任务的文字，就展开它的任务详情」——
 * 详情里能**粘贴文本**（任务的详细描述）、能**添加文件**（如期刊「格式要求」）。
 *
 * 因此这里把任务的「详细描述」与「附件」就地展开：
 * - 详细描述：编辑 brief.md，明确按「保存」落库（不是只弹提示）。
 * - 附件：projects/{id}/attachments/ 下的文件，可添加 / 下载 / 删除。
 * - 结构性字段（名称 / 大类 / 归属 / 时间 / DDL）走「编辑全部信息」→ 统一编辑器。
 *
 * 一个字段只留一个「家」：附件只在这里管理，统一编辑器里不再重复放附件。
 */
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Paperclip, Plus, Download, Trash2, Loader2, Settings2 } from 'lucide-react'
import {
  loadBrief,
  saveBrief,
  loadTaskAttachments,
  uploadTaskAttachment,
  deleteTaskAttachment,
  downloadTaskAttachment,
  type Project,
  type TaskAttachment,
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

export function TaskExpandPanel({
  project,
  parentTitle,
  onEdit,
}: {
  project: Project
  /** 归属任务名；顶级任务为 null */
  parentTitle: string | null
  onEdit: () => void
}) {
  const [brief, setBrief] = useState('')
  const [briefLoading, setBriefLoading] = useState(true)
  const [briefSaving, setBriefSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [attachments, setAttachments] = useState<TaskAttachment[]>([])
  const [attLoading, setAttLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setBriefLoading(true)
    setDirty(false)
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
  }, [project.projectId])

  const reloadAttachments = async () => {
    setAttLoading(true)
    try {
      setAttachments(await loadTaskAttachments(project.projectId))
    } catch (err) {
      console.warn('[Schedule] 读取附件失败:', err)
      toast.error('读取附件失败')
    } finally {
      setAttLoading(false)
    }
  }

  useEffect(() => {
    void reloadAttachments()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.projectId])

  const handleSaveBrief = async () => {
    if (briefSaving) return
    setBriefSaving(true)
    try {
      await saveBrief(project.projectId, brief)
      setDirty(false)
      toast.success('已保存任务详情')
    } catch (err) {
      console.error('[Schedule] 保存任务详情失败:', err)
      toast.error('保存失败，请重试')
    } finally {
      setBriefSaving(false)
    }
  }

  const handleAddFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setBusy('上传中…')
    try {
      for (const f of Array.from(files)) {
        await uploadTaskAttachment(project.projectId, f)
      }
      await reloadAttachments()
      toast.success(files.length > 1 ? `已添加 ${files.length} 个文件` : '已添加文件')
    } catch (err) {
      console.error('[Schedule] 上传附件失败:', err)
      toast.error('上传附件失败，请重试')
    } finally {
      setBusy(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const handleDeleteAttachment = async (a: TaskAttachment) => {
    setBusy(`删除 ${a.name}…`)
    try {
      await deleteTaskAttachment(a.path, a.name)
      await reloadAttachments()
      toast.success('已删除附件')
    } catch (err) {
      console.error('[Schedule] 删除附件失败:', err)
      toast.error('删除附件失败，请重试')
    } finally {
      setBusy(null)
    }
  }

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

  return (
    <div className="mb-1 ml-ui-indent space-y-2 rounded-lg border border-ink-200 bg-paper-50 p-ui-gap-sm">
      {/* 元信息 + 编辑全部信息 */}
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
          title="编辑名称 / 大类 / 归属 / 时间 / DDL"
          className="inline-flex shrink-0 items-center gap-1 rounded border border-ink-200 px-ui-gap-sm py-0.5 text-ui-2xs text-ink-500 transition hover:border-seal-300 hover:text-seal-600"
        >
          <Settings2 className="h-ui-icon-sm w-ui-icon-sm" />
          编辑全部信息
        </button>
      </div>

      {/* 详细描述 */}
      <div>
        <label className="mb-1 block text-ui-2xs font-medium text-ink-600">
          详细描述 <span className="font-normal text-ink-400">（可直接粘贴）</span>
        </label>
        <textarea
          value={brief}
          onChange={(e) => {
            setBrief(e.target.value)
            setDirty(true)
          }}
          rows={4}
          disabled={briefLoading}
          placeholder={briefLoading ? '读取中…' : '粘贴这份任务的详细要求…'}
          className="w-full resize-y rounded border border-ink-300 bg-paper-50 px-2 py-1.5 text-ui-xs leading-relaxed focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100 disabled:text-ink-400"
        />
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleSaveBrief()}
            disabled={briefSaving || briefLoading || !dirty}
            className="rounded bg-seal-600 px-ui-gap-sm py-1 text-ui-2xs font-medium text-paper-50 transition hover:bg-seal-700 disabled:opacity-40"
          >
            {briefSaving ? '保存中…' : '保存详情'}
          </button>
          {dirty && !briefSaving && <span className="text-ui-2xs text-seal-600">未保存</span>}
        </div>
      </div>

      {/* 附件 */}
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1 text-ui-2xs font-medium text-ink-600">
            <Paperclip className="h-ui-icon-sm w-ui-icon-sm" />
            附件
            <span className="font-normal text-ink-400">（{attachments.length}）</span>
          </span>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={!!busy}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-ink-200 px-ui-gap-sm py-0.5 text-ui-2xs text-ink-500 transition hover:border-seal-300 hover:text-seal-600 disabled:opacity-40"
          >
            <Plus className="h-ui-icon-sm w-ui-icon-sm" />
            添加文件
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => void handleAddFiles(e.target.files)}
          />
        </div>
        {attLoading ? (
          <p className="text-ui-2xs text-ink-400">读取附件中…</p>
        ) : attachments.length === 0 ? (
          <p className="text-ui-2xs text-ink-400">还没有附件，可添加格式要求等文件</p>
        ) : (
          <ul className="space-y-1">
            {attachments.map((a) => (
              <li
                key={a.path}
                className="flex items-center gap-1.5 rounded border border-ink-100 bg-paper-100/60 px-1.5 py-1"
              >
                <span className="min-w-0 flex-1 truncate text-ui-2xs text-ink-700" title={a.name}>
                  {a.name}
                </span>
                <span className="shrink-0 text-ui-2xs text-ink-400">{formatSize(a.size)}</span>
                <button
                  type="button"
                  onClick={() => void handleDownload(a)}
                  title="下载"
                  className="shrink-0 rounded p-0.5 text-ink-400 transition hover:text-seal-600"
                >
                  <Download className="h-ui-icon-sm w-ui-icon-sm" />
                </button>
                <button
                  type="button"
                  onClick={() => void handleDeleteAttachment(a)}
                  title="删除附件"
                  className="shrink-0 rounded p-0.5 text-ink-400 transition hover:text-seal-600"
                >
                  <Trash2 className="h-ui-icon-sm w-ui-icon-sm" />
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