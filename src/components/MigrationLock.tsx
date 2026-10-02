/**
 * 迁移期间的页面锁（ADJ-63）
 * -------------------------------------------------
 * 包住某个页面的路由元素：当该页面对应功能域正在被迁移时，用占位提示替换页面本体，
 * 避免用户读到 / 写到半迁移的旧值；其他功能域不受影响。迁移完成（或重试成功）自动恢复。
 */
import { AlertTriangle, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import type { MigrationDomain } from '../services/migrations'
import { useMigrationStore } from '../stores/migration'

const DOMAIN_LABELS: Record<MigrationDomain, string> = {
  schedule: '日程',
  tracking: '追踪',
  reading: '阅读',
  session: '会议·课程',
  learn: '学习',
  writing: '写作',
  management: '管理',
}

export function MigrationLock({ domain, children }: { domain: MigrationDomain; children: ReactNode }) {
  const locked = useMigrationStore((s) => s.lockedDomains.includes(domain))
  const failed = useMigrationStore((s) => s.failed)
  const retry = useMigrationStore((s) => s.retry)

  if (!locked) return <>{children}</>

  const label = DOMAIN_LABELS[domain]
  return (
    <div className="flex h-full min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-ink-200 bg-paper-50 p-6 text-center shadow-card">
        {failed ? (
          <AlertTriangle className="mx-auto h-6 w-6 text-amber-600" />
        ) : (
          <RefreshCw className="mx-auto h-6 w-6 animate-spin text-seal-600" />
        )}
        <h2 className="mt-3 text-base font-semibold text-ink-700">
          {failed ? `${label}的数据更新失败` : `${label}的数据正在更新`}
        </h2>
        <p className="mt-2 text-sm text-ink-500">
          为避免显示或编辑到旧数据，「{label}」暂时不可用；其他功能不受影响
          {failed ? '，请重试。' : '，更新完成后会自动恢复。'}
        </p>
        {failed && retry && (
          <button
            onClick={() => retry()}
            className="mt-4 inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-paper-50 transition hover:bg-amber-700"
          >
            <RefreshCw className="h-4 w-4" />
            重试
          </button>
        )}
      </div>
    </div>
  )
}
