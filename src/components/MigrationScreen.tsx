/**
 * 数据格式迁移屏（闸门）
 * -------------------------------------------------
 * 数据格式只前进、不向后兼容（架构.md §1.10 数据类 #5 / ADJ-54 / ADJ-57）：
 * 工作区就绪后先比对版本号 —— 一致直接放行（秒开）；不一致才探测。
 * 探测到待迁移的旧格式就**自动升级**（用户无需手动点按钮），升级期间展示进度，
 * 升完写回版本号并放行。只有自动升级**失败**时才退回手动「重试」入口。
 * 于是各页面都能假定数据已是新格式，不写任何旧格式兜底；用户也只在万不得已时才需要动手。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { pendingMigrations, markMigrationsApplied, markDataVersionCurrent, type Migration } from '../services/migrations'

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
  // null = 探测/升级中；[] 不该出现（空即 onReady 放行）
  const [pending, setPending] = useState<Migration[] | null>(null)
  const [running, setRunning] = useState(false)
  // 自动升级失败 → 退回手动重试入口（这是唯一的「手动挡」，正常路径不会出现）
  const [failed, setFailed] = useState(false)
  // 自动升级只发起一次，避免 React 严格模式 / 依赖变化导致重复跑
  const startedRef = useRef(false)

  /**
   * 逐条执行迁移并记账：每条跑完立刻写台账，中途失败时已完成的不会重跑。
   * 全部跑完且确无剩余 → 写回版本号；成功返回 true。
   */
  const runAll = useCallback(async (list: Migration[]): Promise<boolean> => {
    for (const m of list) {
      await m.run()
      await markMigrationsApplied([m.id])
    }
    const rest = await pendingMigrations()
    if (rest.length === 0) {
      await markDataVersionCurrent()
      return true
    }
    // 理论不可达（迁移是幂等的），但兜住：还有剩余就让用户看到
    setPending(rest)
    return false
  }, [])

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    let cancelled = false
    void (async () => {
      try {
        const p = await pendingMigrations()
        if (cancelled) return
        if (p.length === 0) {
          // 确认已是最新格式 → 记下版本号，下次启动即可走秒开快路径
          await markDataVersionCurrent()
          if (cancelled) return
          onReady()
          return
        }
        // 有旧数据 → 自动升级，不让用户手动点
        setPending(p)
        setRunning(true)
        const ok = await runAll(p)
        if (cancelled) return
        if (ok) {
          toast.success('数据已自动更新为新格式')
          onReady()
        }
      } catch (err) {
        console.error('[migration] 数据自动升级失败:', err)
        if (cancelled) return
        setFailed(true)
        toast.error('数据升级失败，可点「重试」再试一次')
      } finally {
        if (!cancelled) setRunning(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [onReady, runAll])

  // 手动重试（仅自动升级失败后才出现）
  const retry = useCallback(async () => {
    setRunning(true)
    setFailed(false)
    try {
      const rest = await pendingMigrations()
      if (rest.length === 0) {
        await markDataVersionCurrent()
        onReady()
        return
      }
      setPending(rest)
      const ok = await runAll(rest)
      if (ok) {
        toast.success('数据已更新为新格式')
        onReady()
      }
    } catch (err) {
      console.error('[migration] 数据升级重试失败:', err)
      setFailed(true)
      toast.error('数据升级失败，请重试')
    } finally {
      setRunning(false)
    }
  }, [onReady, runAll])

  // 升级中：只展示进度，不需要用户操作
  if (pending === null || (running && !failed)) {
    return <Splash text={pending === null ? '正在检查数据格式…' : '正在更新数据格式…'} />
  }

  // 自动升级失败 → 才给手动重试入口
  return (
    <div className="flex h-screen items-center justify-center bg-paper-100 p-6">
      <div className="w-full max-w-md rounded-2xl border border-amber-300 bg-paper-50 p-6 shadow-card">
        <div className="flex items-center gap-2 text-amber-700">
          <AlertTriangle className="h-5 w-5" />
          <h1 className="text-base font-semibold">数据升级未完成</h1>
        </div>
        <p className="mt-2 text-sm text-ink-600">
          自动升级未成功（多为网络抖动），重试即可。升级到新格式后才能继续使用（本应用不做向后兼容）。
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
          onClick={retry}
          disabled={running}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-paper-50 transition hover:bg-amber-700 disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} />
          {running ? '更新中…' : '重试'}
        </button>
      </div>
    </div>
  )
}