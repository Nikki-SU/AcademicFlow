/**
 * 后台数据格式迁移（非阻塞）+ 失败重试
 * -------------------------------------------------
 * 数据格式只前进、不向后兼容（架构.md §1.10 数据类 #5 / ADJ-54 / ADJ-57 / ADJ-60 / ADJ-62 / ADJ-63）。
 * 迁移**不挡在应用前面**：工作区就绪后应用照常进入，迁移在后台跑 ——
 *   · 迁移期间把「受影响的功能域」写进 migration store → 对应页面被 MigrationLock 暂时锁住，
 *     避免用户读到 / 写到半迁移的旧值；未受影响的页面照常可用；
 *   · 右下角悬浮卡展示**只进不退的进度条**（不遮内容、不拦操作）；
 *   · toast 弹窗告知「开始 / 完成 / 失败（可重试）」；失败时受影响功能域保持锁定，直到重试成功。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  pendingMigrations,
  markMigrationsApplied,
  markDataVersionCurrent,
  type Migration,
} from '../services/migrations'
import { useMigrationStore } from '../stores/migration'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'

/** 探测阶段的起点占比：探测总量未知，先给一小段，进入迁移后再在这之上继续推进 */
const CHECK_RATIO = 0.08

/** 进度条（只进不退由外部的 bumpRatio 保证） */
function ProgressBar({ fraction }: { fraction: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)))
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
      <div
        className="h-full rounded-full bg-seal-600 transition-[width] duration-500 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export function MigrationStatus() {
  const token = useAuthStore((s) => s.token)
  const { isChecked, repo } = useWorkspaceStore()
  const setRunning = useMigrationStore((s) => s.setRunning)
  const setFailed = useMigrationStore((s) => s.setFailed)
  const setLockedDomains = useMigrationStore((s) => s.setLockedDomains)
  const setRetry = useMigrationStore((s) => s.setRetry)
  const running = useMigrationStore((s) => s.running)
  const failed = useMigrationStore((s) => s.failed)

  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [current, setCurrent] = useState('')
  const [ratio, setRatio] = useState(CHECK_RATIO)
  // 进度占比只增不减：用 ref 兜住，任何回调都不可能把它拉回去（ADJ-61 硬要求）
  const ratioRef = useRef(CHECK_RATIO)
  // 自动迁移只在启动时发起一次
  const startedRef = useRef(false)

  const bumpRatio = useCallback((r: number) => {
    const next = Math.min(r, 1)
    if (next > ratioRef.current) {
      ratioRef.current = next
      setRatio(next)
    }
  }, [])

  /**
   * 逐条执行迁移并记账：每条跑完立刻写台账，中途失败时已完成的不会重跑。
   * 进度 = (已完成条数 + 本条子进度) / 总条数，映射进本次尝试的 [起点, 1] 区间（重试也不倒退）。
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
      return false
    },
    [bumpRatio],
  )

  /** 探测 + 迁移。无待迁移则静默记版本号；有则锁受影响域、toast 告知并在后台跑。 */
  const run = useCallback(async () => {
    setFailed(false)
    setRunning(true)
    try {
      const p = await pendingMigrations()
      if (p.length === 0) {
        // 已是最新格式 → 静默记版本号，下次启动走秒开快路径，不打扰用户
        await markDataVersionCurrent()
        return
      }
      // 迁移期间锁住受影响的功能域，避免读到 / 写到半迁移的旧值
      setLockedDomains([...new Set(p.flatMap((m) => m.affects))])
      const ok = await runAll(p)
      if (!ok) throw new Error('仍有未完成的迁移')
      setLockedDomains([])
    } catch (err) {
      console.error('[migration] 后台更新失败:', err)
      // 失败时不清锁：受影响功能继续不可用，直到重试成功，避免用户看到半迁移数据
      setFailed(true)
      toast.error('数据更新失败', {
        id: undefined,
        description: '相关功能已暂时锁定；点右下角卡片或此处「重试」继续。',
        duration: 20000,
        action: { label: '重试', onClick: () => void run() },
      })
    } finally {
      setRunning(false)
    }
  }, [runAll, setFailed, setLockedDomains, setRunning])

  // 把重试入口注入 store，供被锁页面里的「重试」按钮调用
  useEffect(() => {
    setRetry(run)
    return () => setRetry(null)
  }, [run, setRetry])

  useEffect(() => {
    if (startedRef.current) return
    if (!isChecked || !repo || !token) return
    startedRef.current = true
    void run()
  }, [isChecked, repo, token, run])

  if (!running && !failed) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 rounded-card border border-ink-200 bg-paper-50 p-3 shadow-card">
      {running ? (
        <>
          <div className="mb-2 flex items-center justify-between text-ui-xs text-ink-500">
            <span className="flex items-center gap-1.5">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              正在更新数据格式…
            </span>
            {total > 0 && (
              <span className="tabular-nums text-ink-400">
                {done}/{total}
              </span>
            )}
          </div>
          <ProgressBar fraction={ratio} />
          {current && <p className="mt-2 truncate text-ui-xs text-ink-400">{current}</p>}
          <p className="mt-1 text-ui-xs text-ink-400">后台进行，可继续使用其他功能。</p>
        </>
      ) : (
        <>
          <div className="flex items-center gap-1.5 text-ui-xs text-amber-700">
            <AlertTriangle className="h-3.5 w-3.5" />
            数据更新失败
          </div>
          <p className="mt-1.5 text-ui-xs text-ink-400">
            受影响的功能暂不可用，重试成功即恢复。
          </p>
          <button
            onClick={() => void run()}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-control bg-amber-600 px-ui-gap py-1.5 text-ui-xs font-medium text-paper-50 transition hover:bg-amber-700"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            重试
          </button>
        </>
      )}
    </div>
  )
}
