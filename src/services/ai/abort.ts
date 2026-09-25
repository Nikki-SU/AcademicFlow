/**
 * 问 AI 的「停止」
 * -------------------------------------------------
 * 一个 AI 任务在后端是一个 GitHub Actions job（最长 25 分钟）。用户点「停止」时要做两件事：
 *
 *   1. 前端立刻停止轮询 —— 这才是用户要的「不接收后端的输出」；
 *   2. 顺手把后端那个 run 也取消掉 —— 前端不收了，job 还在烧额度，
 *      不取消等于每次「停止」都白跑一份钱。
 *
 * 第 2 步是**尽力而为**：GitHub 的 run 列表有延迟、run 可能刚好已经结束，
 * 找不到就只是没省下这一次的额度，绝不能因此报错或卡住用户。
 */
import { cancelLatestRun } from '../workflowClient'

/** 统一的取消异常：UI 靠它区分「用户主动停止」与「真的失败」 */
export function abortError(): DOMException {
  return new DOMException('已停止', 'AbortError')
}

export function isAbortError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError'
}

/**
 * 取消后端 run（不阻塞调用方、不抛错）。
 * `sinceIso` 是 dispatch 的时刻 —— 只认这之后新建的 run，避免误伤上一次任务。
 */
export function cancelRemoteAiRun(
  owner: string,
  repo: string,
  token: string,
  sinceIso?: string,
): void {
  void cancelLatestRun('ai_call', owner, repo, token, sinceIso).catch((e) => {
    console.warn('[ai] 取消后端 run 失败（不影响前端停止）:', e)
  })
}
