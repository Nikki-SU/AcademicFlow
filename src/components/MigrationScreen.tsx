/**
 * 数据格式迁移屏（闸门）
 * -------------------------------------------------
 * 数据格式只前进、不向后兼容（架构.md §1.10 数据类 #5 / ADJ-54）：
 * 工作区就绪后先探测是否有待迁移的旧数据 —— 有则**挡住整个应用**，只给「更新数据」；
 * 升级完自行消失、放行。于是各页面都能假定数据已是新格式，不写任何旧格式兜底。
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { pendingMigrations, type Migration } from '../services/migrations'

function Splash({ text }: { text: string }) {
  return (
    <div className="flex h-screen items-center justify-center bg-paper-100">
      <p className="flex items-center gap-2 text-sm text-ink-500">
        <RefreshCw className="h-4 w-4 animate-spin" />
        {text}
      </p>
    </div>
  )
}

export function MigrationScreen({ onReady }: { onReady: () => void }) {
  // null = 探测中；[] 不该出现（空即 onReady 放行）
  const [pending, setPending] = useState<Migration[] | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    let cancelled = false
    pendingMigrations().then((p) => {
      if (cancelled) return
      if (p.length === 0) onReady()
      else setPending(p)
    })
    return () => {
      cancelled = true
    }
  }, [onReady])

  const run = useCallback(async () => {
    setRunning(true)
    try {
      for (const m of pending ?? []) await m.run()
      const rest = await pendingMigrations()
      toast.success('数据已更新为新格式')
      if (rest.length === 0) onReady()
      else setPending(rest)
    } catch (err) {
      console.error('[migration] 数据升级失败:', err)
      toast.error('数据升级失败，请重试')
    } finally {
      setRunning(false)
    }
  }, [pending, onReady])

  if (pending === null) return <Splash text="正在检查数据格式…" />

  return (
    <div className="flex h-screen items-center justify-center bg-paper-100 p-6">
      <div className="w-full max-w-md rounded-2xl border border-amber-300 bg-paper-50 p-6 shadow-card">
        <div className="flex items-center gap-2 text-amber-700">
          <AlertTriangle className="h-5 w-5" />
          <h1 className="text-base font-semibold">数据需要更新</h1>
        </div>
        <p className="mt-2 text-sm text-ink-600">
          检测到旧版数据格式。升级到新格式后才能继续使用（本应用不做向后兼容）。
        </p>
        <ul className="mt-3 space-y-1.5 text-sm text-ink-600">
          {pending.map((m) => (
            <li key={m.id} className="flex gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
              <span>{m.label}</span>
            </li>
          ))}
        </ul>
        <button
          onClick={run}
          disabled={running}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-paper-50 transition hover:bg-amber-700 disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} />
          {running ? '更新中…' : '更新数据'}
        </button>
      </div>
    </div>
  )
}