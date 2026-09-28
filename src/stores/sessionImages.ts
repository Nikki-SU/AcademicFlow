/**
 * 课时照片识别（照片 → MinerU → board.md）的全局状态
 * -------------------------------------------------
 * 拍照/传图后，无论从悬浮采集球还是课程页右栏触发，都走这里唯一的 start()：
 * 右栏据此显示「识别中…」并在完成后自动刷新 board.md。
 *
 * 并发策略：MinerU 一轮要跑几分钟，期间用户很可能又拍了新照片。**同一课时**
 * 重复触发不叠加 dispatch（后端 workflow 全局串行，叠起来只会排长队），改为
 * 「跑完若期间又传了新图，再补跑一轮」—— 最终一致，不丢图。
 */
import { create } from 'zustand'
import { recognizeSessionImages } from '../services/sessionData'

const keyOf = (taskId: string, sessionId: string) => `${taskId}/${sessionId}`

interface SessionImagesState {
  /** 正在识别的课时 key（`${taskId}/${sessionId}`）；与当前课时不符则不显示 */
  key: string | null
  running: boolean
  message: string
  error: string | null
  /** 触发（或排队补跑）一次识别；相同课时运行中只记一笔「稍后补跑」 */
  start: (taskId: string, sessionId: string) => void
  reset: () => void
}

/** 正在跑的课时 key 集合；pending = 跑完还要补跑的课时集合 */
const inFlight = new Set<string>()
const pending = new Set<string>()

export const useSessionImagesStore = create<SessionImagesState>((set, get) => ({
  key: null,
  running: false,
  message: '',
  error: null,

  start: (taskId, sessionId) => {
    const key = keyOf(taskId, sessionId)
    if (inFlight.has(key)) {
      pending.add(key)
      return
    }
    inFlight.add(key)
    set({ key, running: true, message: '已提交识别…', error: null })
    void (async () => {
      try {
        do {
          pending.delete(key)
          await recognizeSessionImages(taskId, sessionId, (m) => {
            if (get().key === key) set({ message: m })
          })
        } while (pending.has(key))
        if (get().key === key) set({ running: false, message: '识别完成' })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (get().key === key) set({ running: false, message: '', error: msg })
      } finally {
        inFlight.delete(key)
      }
    })()
  },

  reset: () => {
    inFlight.clear()
    pending.clear()
    set({ key: null, running: false, message: '', error: null })
  },
}))
