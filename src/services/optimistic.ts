/**
 * 统一「乐观更新 + 回滚」执行器（ADJ-142）
 *
 * 痛点：此前各处的「确认按钮」动作写法不一 —— 多数是**悲观更新**（先 `await`
 * 网络落库成功、才改本地 state），点一下要等网络往返，界面显得很慢；另有少数
 * 是「乐观但无回滚」（先改 UI，落库失败只 toast、UI 停在假成功状态）。
 *
 * 统一口径：**先改本地 state（即时反馈）→ 再后台落库 → 失败回滚 state + 报可读错误**。
 * 所有显式动作（确认删除 / 保存 / 入库 / 移动…）一律走本执行器，禁止再各写一套
 * try/catch 顺序不一的逻辑。
 *
 * 用法（备份旧值 → apply 落 UI → commit 落库 → 失败 rollback）：
 * ```ts
 * const prevPapers = papers
 * const updated = papers.filter((p) => p.id !== id)
 * await runOptimistic({
 *   apply: () => { setPapers(updated); setShowModal(false) },
 *   commit: () => savePapers(updated),
 *   rollback: () => setPapers(prevPapers),
 *   errorMessage: (err) => `删除失败：${errText(err)}`,
 * })
 * ```
 */
import { toast } from 'sonner'

/** 把任意错误折叠成可读文案（Error.message / 其它 String()） */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface OptimisticOptions {
  /**
   * 立即落 UI（乐观）：改本地 state、关弹窗、清选择等 —— 必须**同步**执行，
   * 保证点击瞬间界面就更新。异步前置清理（如删任务台账）请在调用前 `await` 完。
   */
  apply: () => void
  /** 落库提交（网络）：失败必须 `throw`，由本执行器统一回滚 + 报错 */
  commit: () => Promise<unknown>
  /** 失败回滚：把 apply() 改过的本地 state 全部恢复成旧值 */
  rollback: () => void
  /** 失败提示文案；支持按错误生成。缺省 `操作失败：{err}` */
  errorMessage?: string | ((err: unknown) => string)
  /** toast 停留时长（毫秒），默认 5000 */
  duration?: number
}

/**
 * 先 apply() 落 UI（即时反馈），再 await commit() 落库。
 * - 成功：返回 true
 * - 失败：调用 rollback() 恢复本地 state + `toast.error` 报可读错误，返回 false
 *
 * 调用方可用返回值决定后续（如失败时提前 return，不再执行收尾副作用）。
 */
export async function runOptimistic(opts: OptimisticOptions): Promise<boolean> {
  opts.apply()
  try {
    await opts.commit()
    return true
  } catch (err) {
    opts.rollback()
    const text = opts.errorMessage
      ? typeof opts.errorMessage === 'function'
        ? opts.errorMessage(err)
        : opts.errorMessage
      : `操作失败：${errText(err)}`
    toast.error(text, { duration: opts.duration ?? 5000 })
    return false
  }
}
