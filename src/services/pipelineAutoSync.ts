/**
 * 后端 workflow 自动同步 —— 用多段版本号（backend 段）驱动，随版本更新自动落地私库
 *
 * 背景：用户环境通过「引导部署」实现（前端用 Contents API 把 workflow 写到私库，
 * 用户 PAT 本来就为此而设）。之前需要用户在设置页手动点「重写后端」，新版不落地
 * 私库就一直跑旧行为（比如课程材料不进管线的旧 session_images）。
 *
 * 机制（ADJ-126，与数据迁移的版本闸门同构）：
 *   - 私库存一份 `settings/backend-version.csv`（writePipelineFiles 成功时写入
 *     `APP_VERSION.backend`，见 repoBootstrap）。
 *   - 应用启动后（登录 → 私库就绪）读它比对：
 *       一致 → 直接放行（1 次 API 读，不做全量内容比对）；
 *       缺失 / 落后 → 强制重写 workflow + 写回新版本（不兼容旧版一律更新）。
 *   - 每次后端 workflow 有改动，`APP_VERSION.backend` +1（constants/version.ts），
 *     前端部署新版后第一次启动即自动同步，用户零操作。
 */
import { loadStoredBackendVersion, writePipelineFiles } from './repoBootstrap'
import { APP_VERSION } from '../constants/version'

/** 模块级 in-flight 锁：同一启动流程内并发触发只跑一次（应用启动 + 设置页可能同时来） */
let inFlight: Promise<AutoSyncResult> | null = null

export type AutoSyncResult =
  | { status: 'up-to-date' }            // 私库版本副本与 backend 段一致，无需同步
  | { status: 'synced' }                // 版本落后 / 缺失，已强制重写为新版
  | { status: 'failed'; error: string } // 写入失败（可重试）

export async function ensurePipelineSynced(
  owner: string,
  repo: string,
  token: string,
): Promise<AutoSyncResult> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const stored = await loadStoredBackendVersion(owner, repo, token)
      if (stored === APP_VERSION.backend) return { status: 'up-to-date' }

      const res = await writePipelineFiles(owner, repo, token)
      if (!res.ok) {
        const detail =
          res.details?.filter((d) => !d.ok).map((d) => `${d.path}: ${d.error}`).join('; ') ||
          'unknown'
        return { status: 'failed', error: `自动同步失败：${detail}` }
      }
      return { status: 'synced' }
    } catch (e) {
      return { status: 'failed', error: e instanceof Error ? e.message : String(e) }
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}
