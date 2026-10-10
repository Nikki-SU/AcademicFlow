/**
 * 本地工作区面板
 * -------------------------------------------------
 * 顶栏「工作区」按钮打开。功能：
 * - 展示浏览器支持情况 / 已授权文件夹 / 当前权限；
 * - 选择（或更换）工作区根文件夹；
 * - 手动「立即扫描」：补齐目录结构 → 遍历全树 → 按分类走各自管线入库；
 * - 展示本次扫描的逐条结果（路径 / 类型 / 任务 / 状态 / 说明）。
 *
 * 交互遵循 UX_DETAILS.md「只有失败才弹窗」：成功与普通进度一律静默，
 * 结果全部落在这个面板里；仅失败用 toast.error。
 */
import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, FolderPlus, RefreshCw, AlertTriangle, Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from './schedule/Modal'
import Button from './ui/Button'
import {
  getWorkspaceInfo,
  pickWorkspace,
  runManualScan,
  forgetWorkspace,
  WORKSPACE_INDEX_FILE,
  RESEARCH_DIR,
  COURSE_DIR,
  PAPER_DIR,
  BOOK_DIR,
  DOC_DIR,
  IMAGE_DIR,
  type WorkspaceInfo,
  type ScanResult,
  type LedgerStatus,
} from '../services/localWorkspace'

const STATUS_STYLE: Record<LedgerStatus, string> = {
  已入库: 'bg-green-100 text-green-700',
  处理中: 'bg-blue-100 text-blue-700',
  失败: 'bg-red-100 text-red-700',
  跳过: 'bg-ink-100 text-ink-500',
  重复跳过: 'bg-ink-100 text-ink-500',
}

function StatusBadge({ status }: { status: LedgerStatus }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-control-sm text-ui-2xs font-medium shrink-0 ${STATUS_STYLE[status]}`}>
      {status}
    </span>
  )
}

export default function WorkspacePanel({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [result, setResult] = useState<ScanResult | null>(null)

  const refresh = useCallback(async () => {
    setInfo(await getWorkspaceInfo())
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handlePick = async () => {
    setPicking(true)
    try {
      const r = await pickWorkspace()
      if (!r.ok && !r.canceled) toast.error(r.error || '选择工作区失败')
      await refresh()
    } finally {
      setPicking(false)
    }
  }

  const handleScan = async () => {
    setBusy(true)
    try {
      const r = await runManualScan()
      if (r) setResult(r)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const handleForget = async () => {
    await forgetWorkspace()
    setResult(null)
    await refresh()
  }

  const supported = info?.supported ?? true
  const hasWorkspace = !!info?.name
  const granted = info?.permission === 'granted'

  return (
    <Modal
      title="本地工作区"
      onClose={onClose}
      maxWidth="max-w-2xl"
      footer={
        <>
          {hasWorkspace && (
            <Button variant="ghost" onClick={handleForget} disabled={busy || picking}>
              忘记工作区
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {!supported ? (
          <div className="flex items-start gap-2 p-3 bg-red-50 rounded-control text-ui-sm text-red-700">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>当前浏览器不支持本地文件夹授权（File System Access API）。请使用 Chrome / Edge 等桌面浏览器。</span>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 p-3 bg-paper-100 rounded-control">
            <div className="flex items-center gap-2 min-w-0">
              <FolderOpen className="w-4 h-4 text-seal-600 shrink-0" />
              {hasWorkspace ? (
                <div className="min-w-0">
                  <div className="text-ui-sm text-ink-800 truncate">{info?.name}</div>
                  <div className="text-ui-2xs text-ink-500">
                    权限：{granted ? '已授权（读写）' : '待授权，扫描时会请求'}
                  </div>
                </div>
              ) : (
                <span className="text-ui-sm text-ink-500">尚未选择工作区文件夹</span>
              )}
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={picking ? <Loader2 className="animate-spin" /> : <FolderPlus />}
              onClick={handlePick}
              disabled={busy || picking}
            >
              {hasWorkspace ? '更换文件夹' : '选择文件夹'}
            </Button>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-ui-sm text-ink-600">
            把 PDF / Word / Markdown 放进工作区里对应的分类文件夹，点「立即扫描」即可自动
            建结构、识别分类、走管线转换并入库。
          </p>
          <pre className="p-3 bg-paper-100 rounded-control text-ui-2xs text-ink-500 leading-relaxed overflow-x-auto">{`${WORKSPACE_INDEX_FILE}
${RESEARCH_DIR}/
  <任务>/
    ${PAPER_DIR}/  ${BOOK_DIR}/  ${DOC_DIR}/  ${DOC_DIR}/${IMAGE_DIR}/
    <子任务>/ …
${COURSE_DIR}/
  <任务>/ …`}</pre>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            icon={busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            onClick={handleScan}
            disabled={busy || picking || !supported}
          >
            {busy ? '扫描中…' : '立即扫描'}
          </Button>
          {busy && <span className="text-ui-xs text-ink-500">正在遍历工作区并入库，请稍候…</span>}
        </div>

        {result && (
          <div className="space-y-2">
            {!result.ok ? (
              <div className="flex items-start gap-2 p-3 bg-red-50 rounded-control text-ui-sm text-red-700">
                <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{result.error || '扫描失败'}</span>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-ui-sm text-ink-700">
                  <CheckCircle2 className="w-4 h-4 text-green-600" />
                  <span>
                    扫描 {result.scanned} 个 · 入库 {result.ingested} · 跳过 {result.skipped} · 失败 {result.failed}
                  </span>
                </div>
                {result.items.length === 0 ? (
                  <p className="text-ui-xs text-ink-500">没有发现可处理的新文件。</p>
                ) : (
                  <div className="border border-ink-200 rounded-control overflow-hidden">
                    {result.items.map((item) => (
                      <div
                        key={item.path}
                        className="flex items-center gap-3 px-3 py-2 border-b border-ink-100 last:border-b-0"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-ui-xs text-ink-800 truncate" title={item.path}>
                            {item.path}
                          </div>
                          <div className="text-ui-2xs text-ink-500 truncate">
                            {item.category}
                            {item.task ? ` · ${item.task}` : ''}
                            {item.note ? ` · ${item.note}` : ''}
                          </div>
                        </div>
                        <StatusBadge status={item.status} />
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
