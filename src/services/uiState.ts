/**
 * 设备本地的界面状态（localStorage）
 * -------------------------------------------------
 * 只放「上次看到哪儿」这类跟**设备**绑定的状态：上次在读哪本书、上次打开哪个写作项目。
 *
 * 刻意不进 GitHub 私库：这类状态换设备各看各的才对（公司电脑在读文献、家里电脑在写稿，
 * 不该互相顶掉），而且它不需要跨设备同步，走 localStorage 最省事、也不污染私库。
 */

const LAST_READ_KEY = 'af:last-read'
const LAST_PROJECT_KEY = 'af:last-project'
const READING_RATIO_KEY = 'af:reading-right-fr'
const WRITING_RATIO_KEY = 'af:writing-right-fr'
const SESSION_RATIO_KEY = 'af:session-right-fr'

/** 上次在读哪个对象：与 Reading 页的 docRef 同构 */
export interface LastReadRef {
  kind: 'paper' | 'book' | 'document'
  id: string
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    // 隐私模式 / 存储被禁用：当作没有记录，不影响正常使用
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 同上：存不下就算了，只是下次不记得而已
  }
}

export function getLastRead(): LastReadRef | null {
  const raw = read(LAST_READ_KEY)
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as LastReadRef
    if ((p?.kind === 'paper' || p?.kind === 'book' || p?.kind === 'document') && p.id) return p
  } catch {
    // 老格式 / 脏数据：忽略
  }
  return null
}

export function setLastRead(ref: LastReadRef): void {
  write(LAST_READ_KEY, JSON.stringify(ref))
}

export function getLastProjectId(): string | null {
  return read(LAST_PROJECT_KEY)
}

export function setLastProjectId(projectId: string): void {
  write(LAST_PROJECT_KEY, JSON.stringify(projectId))
}

/**
 * 三栏比例偏好（右栏 fr 值）：记住用户上次把中缝拖到哪一档，下次打开自动回到那一档。
 * 各页各记各的；值为 null 或不在允许档位内时由调用方回落默认档（不在这里猜）。
 */
function readRatio(key: string): number | null {
  const raw = read(key)
  if (raw === null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export function getReadingRightFr(): number | null {
  return readRatio(READING_RATIO_KEY)
}
export function setReadingRightFr(v: number): void {
  write(READING_RATIO_KEY, String(v))
}
export function getWritingRightFr(): number | null {
  return readRatio(WRITING_RATIO_KEY)
}
export function setWritingRightFr(v: number): void {
  write(WRITING_RATIO_KEY, String(v))
}
export function getSessionRightFr(): number | null {
  return readRatio(SESSION_RATIO_KEY)
}
export function setSessionRightFr(v: number): void {
  write(SESSION_RATIO_KEY, String(v))
}
