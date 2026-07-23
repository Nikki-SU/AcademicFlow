/**
 * 全局认证错误状态（解耦 github.ts 与 UI）
 * -------------------------------------------------
 * github.ts 在收到 401/403 时调用 setGlobalAuthError，
 * Layout.tsx 订阅该状态并显示全局 modal，所有写操作先检查 hasGlobalAuthError。
 */

type Listener = (message: string | null) => void

let currentError: string | null = null
const listeners = new Set<Listener>()

export function setGlobalAuthError(message: string) {
  currentError = message
  listeners.forEach((fn) => fn(message))
}

export function clearGlobalAuthError() {
  currentError = null
  listeners.forEach((fn) => fn(null))
}

export function getGlobalAuthError(): string | null {
  return currentError
}

export function subscribeGlobalAuthError(listener: Listener): () => void {
  listeners.add(listener)
  listener(currentError)
  return () => {
    listeners.delete(listener)
  }
}

/** 写操作前置检查：若存在全局认证错误则抛出，冻结写操作 */
export function assertCanWrite() {
  const err = getGlobalAuthError()
  if (err) {
    throw new Error(`写操作已冻结：${err}`)
  }
}
