/**
 * 后台数据格式迁移（非阻塞）
 * -------------------------------------------------
 * 数据格式只前进、不向后兼容（架构.md §1.10 数据类 #5 / ADJ-54 / ADJ-57 / ADJ-60 / ADJ-62）。
 * 迁移**不再挡在应用前面**：工作区就绪后，应用照常进入，迁移在后台跑 ——
 *   · 右下角一张小小的悬浮卡展示**只进不退的进度条**（不遮内容、不挡操作）；
 *   · 用 toast 弹窗告知「开始更新 / 更新完成 / 更新失败（可重试）」。
 * 这样即使探测或某个请求慢 / 卡住，用户也**能正常使用其他功能**，不会「进不了页面」。
 *
 * 取舍（ADJ-62）：迁移期间未受影响的功能立即可用；受影响的数据（被迁移改写的字段）要等迁移完成
 * 再刷新页面才会是最新值 —— 换取「永远不被卡死」。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  pendingMigrations,
  markMigrationsApplied,
  markDataVersionCurrent,
  type Migration,
} from '../services/migrations'
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
  const [running, setRunning] = useState(false)
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

  /** 探测 + 迁移。无待迁移则静默记版本号；有则 toast 告知并在后台跑。 */
  const run = useCallback(async () => {
    setRunning(true)
    let toastId: string | number | undefined
    try {
      const p = await pendingMigrations()
      if (p.length === 0) {
        // 已是最新格式 → 静默记版本号，下次启动走秒开快路径，不打扰用户
        await markDataVersionCurrent()
        return
      }
      toastId = toast.loading(`正在后台更新数据格式（0/${p.length}）…`, {
        description: '不影响你继续使用，可稍后刷新查看最新数据',
      })
      const ok = await runAll(p)
      if (!ok) throw new Error('仍有未完成的迁移')
      toast.success('数据已更新为新格式', { id: toastId })
    } catch (err) {
      console.error('[migration] 后台更新失败:', err)
      toast.error('数据更新失败', {
        id: toastId,
        description: '可继续使用；受影响的数据可能显示异常，建议稍后重试。',
        duration: 20000,
        action: { label: '重试', onClick: () => void run() },
      })
    } finally {
      setRunning(false)
    }
  }, [runAll])

  useEffect(() => {
    if (startedRef.current) return
    if (!isChecked || !repo || !token) return
    startedRef.current = true
    void run()
  }, [isChecked, repo, token, run])

  if (!running) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 rounded-xl border border-ink-200 bg-paper-50 p-3 shadow-card">
      <div className="mb-2 flex items-center justify-between text-xs text-ink-500">
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
      {current && <p className="mt-2 truncate text-[11px] text-ink-400">{current}</p>}
      <p className="mt-1 text-[11px] text-ink-400">后台进行，可继续使用。</p>
    </div>
  )
}
