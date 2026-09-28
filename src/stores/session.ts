/**
 * 当前「课时」状态（一节课 / 一场会 = 一个 session）
 * -------------------------------------------------
 * 一节课最终落成**两个 markdown**（见架构 ADJ-45 系列）：
 *   projects/{taskId}/sessions/{sessionId}/transcript.md   录音转写
 *   projects/{taskId}/sessions/{sessionId}/board.md        照片经 MinerU 识别合并
 * 所以「录音」和「拍照」必须挂在**同一个 sessionId** 下，否则两者对不上号。
 *
 * 谁持有 sessionId：
 *   - 录音开始 → session.ensure(taskId) 取当前课时 id（没有就新建）
 *   - 拍照上传 → 同一份 ensure，落到该课时的 images/
 *   - 照片识别 → 把该课时的 images/ 交给 MinerU，产出该课时的 board.md
 *
 * 每个任务各自记住「当前课时」，存 localStorage，刷新页面不换课时；
 * 用户想开新的一节课时，调 startNew(taskId) 显式换一个 id。
 */
import { create } from 'zustand'

/** localStorage：{ [taskId]: sessionId } —— 每个任务各自记住当前课时 */
const LS_KEY = 'af:current-sessions'

function loadMap(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function saveMap(map: Record<string, string>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(map))
  } catch {
    /* 隐私模式 / 配额满：内存态照常工作，只是刷新后可能换课时 */
  }
}

interface SessionState {
  taskId: string | null
  sessionId: string | null
  /** 取当前任务的课时 id；没有就新建一个并记住 */
  ensure: (taskId: string) => string
  /** 显式开一节新课（换新的 sessionId） */
  startNew: (taskId: string) => string
  reset: () => void
}

export const useSessionStore = create<SessionState>((set, get) => ({
  taskId: null,
  sessionId: null,

  ensure: (taskId) => {
    // 已经指向该任务的某个课时 → 直接用
    if (get().taskId === taskId && get().sessionId) return get().sessionId as string
    const map = loadMap()
    const existing = map[taskId]
    const id = existing || String(Date.now())
    if (!existing) {
      map[taskId] = id
      saveMap(map)
    }
    set({ taskId, sessionId: id })
    return id
  },

  startNew: (taskId) => {
    const id = String(Date.now())
    const map = loadMap()
    map[taskId] = id
    saveMap(map)
    set({ taskId, sessionId: id })
    return id
  },

  reset: () => set({ taskId: null, sessionId: null }),
}))
