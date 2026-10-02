/**
 * 数据格式迁移的全局状态（ADJ-62 / ADJ-63）
 * -------------------------------------------------
 * MigrationStatus 组件是唯一的写入方：它在后台跑迁移，并把「正在迁移 / 失败 / 受影响的功能域」
 * 写进这里；各页面（MigrationLock）只读它来决定自己是否暂时不可用。
 */
import { create } from 'zustand'
import type { MigrationDomain } from '../services/migrations'

interface MigrationState {
  /** 是否正在后台迁移 */
  running: boolean
  /** 迁移失败（需重试）；失败时受影响的功能域保持锁定，避免读到 / 写到半迁移的数据 */
  failed: boolean
  /** 正在迁移、因而暂不可用的功能域 */
  lockedDomains: MigrationDomain[]
  /** 失败后的重试入口（由 MigrationStatus 注入） */
  retry: (() => void) | null
  setRunning: (running: boolean) => void
  setFailed: (failed: boolean) => void
  setLockedDomains: (domains: MigrationDomain[]) => void
  setRetry: (retry: (() => void) | null) => void
}

export const useMigrationStore = create<MigrationState>((set) => ({
  running: false,
  failed: false,
  lockedDomains: [],
  retry: null,
  setRunning: (running) => set({ running }),
  setFailed: (failed) => set({ failed }),
  setLockedDomains: (lockedDomains) => set({ lockedDomains }),
  setRetry: (retry) => set({ retry }),
}))
