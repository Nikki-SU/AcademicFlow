/**
 * 数据格式迁移屏（闸门）
 * -------------------------------------------------
 * 数据格式只前进、不向后兼容（架构.md §1.10 数据类 #5 / ADJ-54 / ADJ-57 / ADJ-60）：
 * 工作区就绪后先比对版本号 —— 一致直接放行（秒开）；不一致才按版本区间直迁。
 * 直迁到待迁移的旧格式就**自动升级**（用户无需手动点按钮），升级期间展示**只进不退的进度条**，
 * 让用户知道「大概还要多久」，绝不不声不响地卡着（ADJ-61）。升完写回版本号并放行。
 * 只有自动升级**失败**时才退回手动「重试」入口。
 * 于是各页面都能假定数据已是新格式，不写任何旧格式兜底；用户也只在万不得已时才需要动手。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { pendingMigrations, markMigrationsApplied, markDataVersionCurrent, type Migration } from '../services/migrations'

/**
 * 进度条。`fraction` ∈ [0,1]；`checking=true`（探测阶段，总量未知）时固定在起点脉冲，
 * 表示「正在进行、尚未可估」。
 */
function ProgressBar({ fraction, checking }: { fraction: number; checking?: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)))
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-ink-100">
      <div
        className={`h-full rounded-full bg-seal-600 transition-[width] duration-500 ease-out ${
          checking ? 'animate-pulse' : ''
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

/** 探测阶段的起点占比：探测本身总量未知，先给一小段，进入迁移后再在这之上继续推进 */
const CHECK_RATIO = 0.08

export function MigrationScreen({ onReady }: { onReady: () => void }) {
  // null = 还没探测出结果
  const [pending, setPending] = useState<Migration[] | null>(null)
  const [running, setRunning] = useState(false)
  // 自动升级失败 → 退回手动重试入口（这是唯一的「手动挡」，正常路径不会出现）
  const [failed, setFailed] = useState(false)
  // 进度：done/total（本次尝试的步数）+ 单调递增的进度占比 ratio
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [current, setCurrent] = useState('')
  const [ratio, setRatio] = useState(CHECK_RATIO)
  // 进度占比只增不减：用 ref 兜住，任何回调都不可能把它拉回去（ADJ-61 硬要求）
  const ratioRef = useRef(CHECK_RATIO)
  // 自动升级只发起一次，避免 React 严格模式 / 依赖变化导致重复跑
  const startedRef = useRef(false)

  /** 只前进：低于当前占比的更新一律忽略 */
  const bumpRatio = useCallback((r: number) => {
    const next = Math.min(r, 1)
    if (next > ratioRef.current) {
      ratioRef.current = next
      setRatio(next)
    }
  }, [])

  /**
   * 逐条执行迁移并记账：每条跑完立刻写台账，中途失败时已完成的不会重跑。
   * 进度条按「已完成/总数」推进；本次尝试覆盖 [起始占比, 1] 区间，故重试时也不会倒退。
   * 全部跑完且确无剩余 → 写回版本号；成功返回 true。
   */
  const runAll = useCallback(
    async (list: Migration[]): Promise<boolean> => {
      const n = list.length
      const start = ratioRef.current
      const step = (d: number, label: string) => {
        setDone(d)
        setTotal(n)
        setCurrent(label)
        bumpRatio(n > 0 ? start + (1 - start) * (d / n) : 1)
      }
      for (let i = 0; i < n; i++) {
        step(i, list[i].label)
        // 总进度 = (已完成条数 + 本条子进度) / 总条数，再映射进本次尝试的 [start, 1] 区间
        const onProgress = (f: number) => {
          const inner = Math.max(0, Math.min(f, 1))
          bumpRatio(n > 0 ? start + (1 - start) * ((i + inner) / n) : 1)
        }
        await list[i].run(onProgress)
        await markMigrationsApplied([list[i].id])
        step(i + 1, i + 1 < n ? list[i + 1].label : list[i].label)
      }
      const rest = await pendingMigrations()
      if (rest.length === 0) {
        bumpRatio(1)
        setCurrent('')
        await markDataVersionCurrent()
        return true
      }
      // 理论不可达（迁移是幂等的），但兜住：还有剩余就让用户看到
      setPending(rest)
      return false
    },
    [bumpRatio],
  )

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

  // 手动重试（仅自动升级失败后才出现）—— 进度条从当前位置继续，不倒退
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

  // 探测 / 升级中：展示只进不退的进度条，不暴露任何手动操作
  if (pending === null || (running && !failed)) {
    const checking = pending === null
    return (
      <div className="flex h-screen items-center justify-center bg-paper-100 p-6">
        <div className="w-full max-w-md">
          <div className="mb-3 flex items-center justify-between text-sm text-ink-500">
            <span className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 animate-spin" />
              {checking ? '正在检查数据格式…' : '正在更新数据格式…'}
            </span>
            {!checking && total > 0 && (
              <span className="tabular-nums text-ink-400">
                {done}/{total}
              </span>
            )}
          </div>
          <ProgressBar fraction={ratio} checking={checking} />
          {!checking && current && (
            <p className="mt-3 truncate text-xs text-ink-400">{current}</p>
          )}
          {!checking && (
            <p className="mt-1 text-xs text-ink-400">请保持页面打开，完成后会自动进入。</p>
          )}
        </div>
      </div>
    )
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
