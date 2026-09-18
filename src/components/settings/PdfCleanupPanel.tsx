/**
 * PDF 清理面板
 * ------------------------------------------------------------
 * PDF 体积大且无法检索，转换成功后就没用了（正文已落成 full.md，图片在 images/）。
 * 这里只列出「转换成功（mdStatus=done）」的文献，支持全选 / 部分选择。
 *
 * 只删 literatures/{slug}/source/ 下的 .pdf —— 绝不碰 MinerU 原始 md、images、词汇表。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { HardDrive, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { loadLiteratures, fetchLiteratureFiles, doiToSlug } from '../../services/literatureData'
import { deleteRepoFiles } from '../../services/github'
import { useAuthStore } from '../../stores/auth'
import { useWorkspaceStore } from '../../stores/workspace'

interface PdfFile { path: string; size: number }
interface PdfGroup { doi: string; title: string; files: PdfFile[]; totalBytes: number }

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export default function PdfCleanupPanel() {
  const auth = useAuthStore()
  const ws = useWorkspaceStore()
  const owner = auth.user?.login
  const repoName = ws.repo?.name
  const token = auth.token

  const [loading, setLoading] = useState(false)
  const [groups, setGroups] = useState<PdfGroup[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    if (!owner || !repoName || !token) return
    setLoading(true)
    try {
      const [lits, fileMap] = await Promise.all([loadLiteratures(true), fetchLiteratureFiles()])
      if (!fileMap) {
        toast.error('读取仓库文件列表失败')
        return
      }
      const next: PdfGroup[] = []
      for (const lit of lits) {
        // 只有转换成功的才可以被选中：转换中的还需要 PDF 才能续跑
        if (lit.mdStatus !== 'done') continue
        const prefix = `literatures/${doiToSlug(lit.doi)}/source/`
        const files = [...fileMap.entries()]
          .filter(([p]) => p.startsWith(prefix) && /\.pdf$/i.test(p))
          .map(([path, size]) => ({ path, size }))
        if (files.length === 0) continue
        next.push({
          doi: lit.doi,
          title: lit.title || lit.doi,
          files,
          totalBytes: files.reduce((s, f) => s + f.size, 0),
        })
      }
      next.sort((a, b) => b.totalBytes - a.totalBytes)
      setGroups(next)
      setSelected(new Set())
    } catch (e) {
      toast.error(`加载失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [owner, repoName, token])

  useEffect(() => { void load() }, [load])

  const allSelected = groups.length > 0 && selected.size === groups.length
  const selectedGroups = useMemo(() => groups.filter((g) => selected.has(g.doi)), [groups, selected])
  const selectedBytes = selectedGroups.reduce((s, g) => s + g.totalBytes, 0)
  const totalBytes = groups.reduce((s, g) => s + g.totalBytes, 0)

  const toggle = (doi: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(doi)) next.delete(doi)
      else next.add(doi)
      return next
    })
  }

  const handleDelete = async () => {
    if (!owner || !repoName || !token) return
    const paths = selectedGroups.flatMap((g) => g.files.map((f) => f.path))
    if (paths.length === 0) return
    setDeleting(true)
    try {
      await deleteRepoFiles(
        paths,
        `chore: 清理已转换文献的 PDF（${selectedGroups.length} 篇 / ${paths.length} 个文件）`,
        owner, repoName, token,
      )
      toast.success(`已清理 ${paths.length} 个 PDF（${formatBytes(selectedBytes)}）`, {
        description: '正文 md、图片、词汇表都保留；重新转换需要重新上传 PDF',
      })
      await load()
    } catch (e) {
      toast.error(`清理失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500 flex items-center gap-1">
          <HardDrive className="w-3 h-3" />
          {groups.length} 篇已转换文献的 PDF · 共 {formatBytes(totalBytes)}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || deleting}
          className="flex items-center gap-1 px-2 py-1 border border-slate-300 rounded bg-white hover:bg-slate-50 disabled:text-slate-400"
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          刷新
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="text-xs text-slate-400 border border-dashed border-slate-200 rounded-md px-3 py-4 text-center">
          {loading ? '读取中…' : '没有可清理的 PDF（只有转换成功的文献才可清理）'}
        </div>
      ) : (
        <>
          <div className="border border-slate-200 rounded-md overflow-hidden">
            <label className="flex items-center gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(groups.map((g) => g.doi)))}
                className="accent-red-600"
              />
              全选（{groups.length} 篇）
            </label>
            <div className="max-h-64 overflow-y-auto divide-y divide-slate-100">
              {groups.map((g) => (
                <label key={g.doi} className="flex items-start gap-2 px-3 py-2 text-xs hover:bg-slate-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(g.doi)}
                    onChange={() => toggle(g.doi)}
                    className="mt-0.5 accent-red-600"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-slate-800 truncate" title={g.title}>{g.title}</span>
                    <span className="block text-slate-400 font-mono text-[11px] truncate">{g.doi}</span>
                  </span>
                  <span className="text-slate-500 whitespace-nowrap">
                    {g.files.length} 个 · {formatBytes(g.totalBytes)}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">
              已选 {selectedGroups.length} 篇 · {formatBytes(selectedBytes)}
            </span>
            <button
              type="button"
              onClick={handleDelete}
              disabled={selectedGroups.length === 0 || deleting}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:bg-slate-300 disabled:cursor-not-allowed"
            >
              {deleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
              清理选中 PDF
            </button>
          </div>
        </>
      )}

      <p className="text-[11px] text-slate-400 leading-relaxed">
        只删除 <code className="font-mono">literatures/{'{slug}'}/source/*.pdf</code>。
        MinerU 原始 md（<code className="font-mono">full.md</code>）、图片（<code className="font-mono">images/</code>）、
        词汇表都不会被删除。清理后如需重新转换，需要重新上传 PDF。
      </p>
    </div>
  )
}
