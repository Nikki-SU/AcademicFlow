/**
 * 删除任务确认弹层（ADJ-64）
 * -------------------------------------------------
 * 删除是危险动作，必须「看清影响 + 输入任务名」两重确认才放行：
 * - 影响预览：直接子任务会**提升为顶级**（不删），独占材料会随「连材料一起删」清掉。
 * - 两种模式（用户拍板）：detach 只删任务、材料留在库里；purge 额外删独占材料。
 * - 二次确认：逐字输入任务名才能点「确认删除」，防误删。
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Modal } from './Modal'
import {
  planDeleteProject,
  type Project,
  type ProjectDeleteMode,
  type ProjectDeletePlan,
} from '../../services/projectData'

export function TaskDeleteModal({
  project,
  onClose,
  onConfirm,
}: {
  project: Project
  onClose: () => void
  onConfirm: (mode: ProjectDeleteMode) => Promise<void>
}) {
  const expected = project.title.trim() || '(未命名任务)'
  const [plan, setPlan] = useState<ProjectDeletePlan | null>(null)
  const [loading, setLoading] = useState(true)
  // 不预选：两种模式必须由用户主动选一种，避免默认值造成「以为删干净了 / 以为材料还在」的误解
  const [mode, setMode] = useState<ProjectDeleteMode | null>(null)
  const [typed, setTyped] = useState('')
  const [working, setWorking] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    planDeleteProject(project.projectId)
      .then((p) => {
        if (!cancelled) setPlan(p)
      })
      .catch((err) => {
        console.warn('[Schedule] 计算删除影响失败:', err)
        if (!cancelled) setPlan(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [project.projectId])

  const exclusive = plan?.exclusiveMaterials ?? []
  const children = plan?.promotedChildren ?? []
  // 仅「连材料一起删」需要逐字输入任务名；「仅删任务」只需普通确认
  const needsTyping = mode === 'purge'
  const canConfirm = mode !== null && !loading && !working && (!needsTyping || typed === expected)

  const handleConfirm = async () => {
    if (!canConfirm || mode === null) return
    setWorking(true)
    try {
      await onConfirm(mode)
    } finally {
      setWorking(false)
    }
  }

  return (
    <Modal
      title="删除任务"
      onClose={onClose}
      maxWidth="max-w-lg"
      footer={
        <>
          <button
            onClick={onClose}
            disabled={working}
            className="rounded-lg px-4 py-2 text-sm text-ink-600 transition hover:bg-ink-100 disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="rounded-lg bg-seal-600 px-4 py-2 text-sm font-medium text-paper-50 transition hover:bg-seal-700 disabled:opacity-40"
          >
            {working ? '删除中…' : '确认删除'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-lg border border-seal-300 bg-seal-50 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-seal-600" />
          <p className="text-xs leading-relaxed text-seal-800">
            删除后不可撤销。将删除任务「<span className="font-medium">{expected}</span>」。
          </p>
        </div>

        {/* 删除模式：不预选，必须主动选一种 */}
        <div className="space-y-2">
          <div className="text-sm font-medium text-ink-700">
            请选择材料处理方式 <span className="font-normal text-ink-500">（必选）</span>
          </div>
          <label
            className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 transition hover:bg-paper-100 ${
              mode === 'detach' ? 'border-seal-400 bg-seal-50' : 'border-ink-200'
            }`}
          >
            <input
              type="radio"
              name="delete-mode"
              checked={mode === 'detach'}
              onChange={() => {
                setMode('detach')
                setTyped('')
              }}
              className="mt-0.5"
            />
            <span className="text-sm text-ink-700">
              仅删除任务本身
              <span className="mt-0.5 block text-xs text-ink-500">
                任务引用的文献 / 图书全部保留在库里，可能仍被其他任务共享。
              </span>
            </span>
          </label>
          <label
            className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 transition hover:bg-paper-100 ${
              mode === 'purge' ? 'border-seal-400 bg-seal-50' : 'border-ink-200'
            }`}
          >
            <input
              type="radio"
              name="delete-mode"
              checked={mode === 'purge'}
              onChange={() => setMode('purge')}
              className="mt-0.5"
            />
            <span className="text-sm text-ink-700">
              删除任务及其独占材料
              <span className="mt-0.5 block text-xs text-ink-500">
                仅删掉「只被本任务引用」的文献 / 图书，被其他任务共享的材料不受影响。
              </span>
            </span>
          </label>
        </div>

        {loading ? (
          <p className="flex items-center gap-2 text-xs text-ink-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在计算删除影响…
          </p>
        ) : (
          <>
            {/* 子任务去留 */}
            {children.length > 0 && (
              <div className="rounded-lg border border-ink-200 bg-paper-100 p-3">
                <div className="mb-1 text-xs font-semibold text-ink-600">
                  将提升为顶级的子任务（{children.length}）
                </div>
                <ul className="space-y-0.5 text-xs text-ink-600">
                  {children.map((c) => (
                    <li key={c.projectId} className="truncate">
                      · {c.title || '(未命名任务)'}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 独占材料预览（仅 purge 相关） */}
            {mode === 'purge' && (
              <div className="rounded-lg border border-ink-200 bg-paper-100 p-3">
                <div className="mb-1 text-xs font-semibold text-ink-600">
                  将一并删除的独占材料（{exclusive.length}）
                </div>
                {exclusive.length === 0 ? (
                  <p className="text-xs text-ink-500">没有独占材料，本任务引用的材料都被其他任务共享。</p>
                ) : (
                  <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-ink-600">
                    {exclusive.map((m) => (
                      <li key={`${m.kind}:${m.key}`} className="truncate">
                        · [{m.kind === 'literature' ? '文献' : '图书'}] {m.title}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}

        {/* 二次确认：仅「连材料一起删」需逐字输入任务名 */}
        {needsTyping && (
          <div>
            <label className="mb-1.5 block text-sm font-medium text-ink-700">
              请输入任务名以确认：<span className="font-normal text-ink-500">{expected}</span>
            </label>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={expected}
              className="w-full rounded-lg border border-ink-300 px-3 py-2 text-sm focus:border-seal-400 focus:outline-none focus:ring-2 focus:ring-seal-100"
            />
          </div>
        )}
      </div>
    </Modal>
  )
}
