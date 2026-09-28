/**
 * 待转写音频的本地暂存（IndexedDB）
 * -------------------------------------------------
 * 转写失败的那一片音频**必须能活过页面刷新** —— 音频不入私库（ADJ-48），一旦丢就真没了。
 * 这里只做「临时落脚」：转成功即删（见 stores/recorder.ts），所以不会长期堆积。
 *
 * 记录里存 seq：它决定该片在本节课转写里的**严格顺序**，重开页面后据此归位。
 * 环境不支持 IndexedDB（SSR / 极老浏览器）时全部降级为 no-op，调用方逻辑不变。
 */

const DB_NAME = 'af-recorder'
const STORE = 'pending_audio'
const VERSION = 1

export interface PendingAudioRecord {
  /** `${sessionId}:${seq}` —— 同一课时内唯一 */
  id: string
  taskId: string
  sessionId: string
  /** 片序（单调递增），决定严格顺序 */
  seq: number
  /** 该片产生时刻（Unix ms） */
  at: number
  mime: string
  blob: Blob
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id' })
          os.createIndex('seq', 'seq', { unique: false })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => {
        console.warn('[pendingAudio] 打开 IndexedDB 失败：', req.error)
        resolve(null)
      }
    } catch (e) {
      console.warn('[pendingAudio] IndexedDB 不可用：', e)
      resolve(null)
    }
  })
  return dbPromise
}

/** 写一条（存在即覆盖）。失败不抛，只告警 —— 不能因为暂存失败把转写链带崩。 */
export async function putPending(rec: PendingAudioRecord): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(rec)
      tx.oncomplete = () => resolve()
      tx.onerror = () => {
        console.warn('[pendingAudio] 暂存失败：', tx.error)
        resolve()
      }
      tx.onabort = () => {
        console.warn('[pendingAudio] 暂存事务中断：', tx.error)
        resolve()
      }
    } catch (e) {
      console.warn('[pendingAudio] 暂存异常：', e)
      resolve()
    }
  })
}

/** 转成功后删除这一片（**必须删**，否则连续几轮会把本地存储撑爆）。失败只告警。 */
export async function deletePending(id: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => {
        console.warn('[pendingAudio] 删除失败：', tx.error)
        resolve()
      }
      tx.onabort = () => resolve()
    } catch (e) {
      console.warn('[pendingAudio] 删除异常：', e)
      resolve()
    }
  })
}

/** 取出全部待转写片，按 seq 升序（严格顺序）。失败返回空数组。 */
export async function listPending(): Promise<PendingAudioRecord[]> {
  const db = await openDb()
  if (!db) return []
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).getAll()
      req.onsuccess = () => {
        const rows = (req.result as PendingAudioRecord[]).slice()
        rows.sort((a, b) => a.seq - b.seq)
        resolve(rows)
      }
      req.onerror = () => {
        console.warn('[pendingAudio] 读取失败：', req.error)
        resolve([])
      }
    } catch (e) {
      console.warn('[pendingAudio] 读取异常：', e)
      resolve([])
    }
  })
}

/** 待转写片数（用于 UI 提示）。失败返回 0。 */
export async function countPending(): Promise<number> {
  const db = await openDb()
  if (!db) return 0
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).count()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(0)
    } catch {
      resolve(0)
    }
  })
}
