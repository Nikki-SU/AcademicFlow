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
  write(LAST_PROJECT_KEY, projectId)
}
