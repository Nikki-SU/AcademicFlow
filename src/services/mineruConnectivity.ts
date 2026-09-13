/**
 * MinerU 联通性检测
 * -------------------------------------------------
 * 当前架构：MinerU API 由 GitHub Actions runner 直接调用
 *  （.github/scripts/pipeline.mjs 里 const MINERU_API = 'https://mineru.net/api/v4'），
 * 前端不直接发 MinerU 业务请求。但用户在 Settings 页填的 token 要先经过校验，
 * 否则要等到 pipeline 跑到一半才知道 token 过期或写错。
 *
 * 本服务做两件事，组合判定"MinerU 是否联通"：
 *   1. parseMineruJwt：纯本地解析 JWT，提取 iat / exp / uuid / jti，
 *      判断 token 是否过期 / 即将过期。零网络开销，永远可用。
 *   2. checkWorkerHealth：探测用户自部署的 worker 代理（mineruWorkerUrl）
 *      的 /__af_health 端点（install.sh 部署的 Deno worker 自带该路由），
 *      验证代理本身存活。worker 是 MinerU 的转发通道，worker 可达 ≈ 通道通畅。
 *
 * 不直接对 https://mineru.net/api/v4 发请求 —— 浏览器侧有 CORS / Mixed Content
 * 风险（HTTPS 页面调用第三方 API 不稳定），且 GitHub Actions runner 才是真正的
 * MinerU 调用方，前端再探一次意义不大。token 合法性靠 JWT 本地校验保底。
 */
import type { MineruJwtInfo } from '../types'

/** 探活请求超时（ms）—— worker 应该秒回，5s 足够 */
const HEALTH_TIMEOUT_MS = 5000

/** 即将到期阈值（天）：剩余 ≤7 天标记 warning（仍 ok，但 UI 给橙色） */
const WARNING_DAYS = 7

/**
 * 解析 MinerU JWT token
 *
 * MinerU 的 token 是 OpenXLab 签发的 JWT，payload 含 jti / uuid / iat / exp / phone / email 等字段。
 * 这里只解析 header.payload.signature 的中段 payload，不验签（验签需要公钥，前端没必要）。
 * 失败时返回 parseError，UI 据此提示"token 格式不合法"。
 */
export function parseMineruJwt(raw: string): MineruJwtInfo {
  if (!raw || !raw.trim()) {
    return { raw: raw ?? '', isExpired: true, parseError: 'token 为空' }
  }
  const token = raw.trim()

  // JWT 形如 header.payload.signature，三段 base64url
  const parts = token.split('.')
  if (parts.length !== 3) {
    return {
      raw: token,
      isExpired: true,
      parseError: '不是合法 JWT 格式（应为 header.payload.signature 三段式）',
    }
  }

  try {
    // base64url → base64 标准 + 补齐 padding
    const payloadB64 = parts[1]
    const std = payloadB64.replace(/-/g, '+').replace(/_/g, '/')
    const pad = (4 - (std.length % 4)) % 4
    const payloadB64Padded = std + '='.repeat(pad)
    const payloadJson = atob(payloadB64Padded)
    const payload = JSON.parse(payloadJson) as Record<string, unknown>

    const now = Date.now()
    const exp = typeof payload.exp === 'number' ? payload.exp : undefined
    const iat = typeof payload.iat === 'number' ? payload.iat : undefined
    const expiresAt = exp ? new Date(exp * 1000) : undefined
    // 剩余天数向下取整（负数表示已过期多少天）
    const remainingDays =
      exp !== undefined ? Math.floor((exp * 1000 - now) / 86400000) : undefined
    const isExpired = exp !== undefined ? exp * 1000 < now : false

    return {
      raw: token,
      jti: typeof payload.jti === 'string' ? payload.jti : undefined,
      uuid: typeof payload.uuid === 'string' ? payload.uuid : undefined,
      iat,
      exp,
      expiresAt,
      remainingDays,
      isExpired,
    }
  } catch (e: any) {
    return {
      raw: token,
      isExpired: true,
      parseError: `JWT 解析失败：${e?.message || String(e)}`,
    }
  }
}

export interface WorkerHealthResult {
  ok: boolean
  status?: number
  /** worker 返回的 service 字段（如 'academicflow-worker'） */
  service?: string
  /** 人类可读详情：成功时是 'OK / service'；失败时是原因 */
  detail?: string
  /** 是否实际发起过网络请求（false 表示因为没配 workerUrl 直接跳过） */
  attempted: boolean
}

/**
 * 探测 worker 代理的 /__af_health 端点
 *
 * install.sh 部署的 Deno worker 在 /__af_health 返回：
 *   { "ok": true, "service": "academicflow-worker" }
 *
 * 该端点不需要 Authorization，纯探活用。
 */
export async function checkWorkerHealth(
  workerUrl: string | undefined | null,
): Promise<WorkerHealthResult> {
  const url = workerUrl?.trim()
  if (!url) {
    return { ok: false, attempted: false, detail: '未配置 worker 代理 URL' }
  }

  let base: URL
  try {
    base = new URL(url)
  } catch {
    return {
      ok: false,
      attempted: false,
      detail: `worker URL 格式不合法：${url}`,
    }
  }

  // 拼出 /__af_health，原 URL 上的 path 末尾若非 /，追加而非覆盖
  const healthUrl = new URL('__af_health', base).toString()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const res = await fetch(healthUrl, {
      method: 'GET',
      signal: controller.signal,
      // 不带 cookie，避免和登录态串扰
      credentials: 'omit',
      // 缓存控制：探活永远拿最新
      cache: 'no-store',
    })
    clearTimeout(timer)

    if (!res.ok) {
      return {
        ok: false,
        attempted: true,
        status: res.status,
        detail: `HTTP ${res.status} ${res.statusText}`.trim(),
      }
    }

    // 尝试解析 JSON；非 JSON 但 2xx 也算可达
    let service: string | undefined
    try {
      const data = (await res.json()) as { ok?: boolean; service?: string }
      service = data?.service
      if (data?.ok === true) {
        return {
          ok: true,
          attempted: true,
          status: res.status,
          service,
          detail: service ? `worker: ${service}` : 'OK',
        }
      }
      return {
        ok: false,
        attempted: true,
        status: res.status,
        detail: '响应缺少 ok=true 字段',
      }
    } catch {
      return {
        ok: true,
        attempted: true,
        status: res.status,
        detail: 'OK（非 JSON 响应）',
      }
    }
  } catch (e: any) {
    clearTimeout(timer)
    const isAborted = e?.name === 'AbortError'
    return {
      ok: false,
      attempted: true,
      detail: isAborted
        ? `连接超时（${HEALTH_TIMEOUT_MS}ms）`
        : `网络错误：${e?.message || String(e)}`,
    }
  }
}

/** 综合联通报告 —— 供 UI 直接渲染 */
export interface MineruConnectivityReport {
  /** JWT 解析结果 */
  jwt: MineruJwtInfo
  /** worker 探活结果（未配置 workerUrl 时 attempted=false） */
  worker?: WorkerHealthResult
  /** 综合判断：
   *   - token 解析失败 / 已过期 → false
   *   - 未配 workerUrl → 只看 token，未过期即 true
   *   - 配了 workerUrl → token 未过期 且 worker.ok 才 true
   */
  overallOk: boolean
  /** 综合判断的人类可读说明 */
  overallMessage: string
  /** token 剩余天数是否进入 warning 区间（≤WARNING_DAYS） */
  tokenExpiringSoon: boolean
}

/**
 * 综合检测 MinerU 联通性
 *
 * @param opts.token MinerU JWT token（必填）
 * @param opts.workerUrl 用户自部署的 worker 代理 URL（可选；不传或空则只校验 token）
 */
export async function checkMineruConnectivity(opts: {
  token: string
  workerUrl?: string
}): Promise<MineruConnectivityReport> {
  const jwt = parseMineruJwt(opts.token)

  // 1. token 解析失败 / 已过期 → 直接红
  if (jwt.parseError) {
    return {
      jwt,
      overallOk: false,
      overallMessage: `Token 不合法：${jwt.parseError}`,
      tokenExpiringSoon: false,
    }
  }
  if (jwt.isExpired) {
    return {
      jwt,
      overallOk: false,
      overallMessage: jwt.expiresAt
        ? `Token 已过期（${jwt.expiresAt.toLocaleString()}）`
        : 'Token 已过期',
      tokenExpiringSoon: false,
    }
  }

  // 2. 没配 workerUrl → 只校验 token；剩余 ≤WARNING_DAYS 给 warning，但仍算 ok
  if (!opts.workerUrl?.trim()) {
    const days = jwt.remainingDays ?? Number.POSITIVE_INFINITY
    const expiringSoon = days <= WARNING_DAYS
    const msg = expiringSoon
      ? `Token 有效，但将在 ${days} 天后过期（${jwt.expiresAt?.toLocaleDateString()}）`
      : `Token 有效，剩余 ${days} 天`
    return {
      jwt,
      overallOk: true,
      overallMessage: msg + '（未配 worker，未探活代理）',
      tokenExpiringSoon: expiringSoon,
    }
  }

  // 3. 配了 workerUrl → 同时探活 worker
  const worker = await checkWorkerHealth(opts.workerUrl)
  if (worker.ok) {
    const days = jwt.remainingDays ?? 0
    const expiringSoon = days <= WARNING_DAYS
    const tail = expiringSoon
      ? `；token 将在 ${days} 天后过期`
      : `；token 剩余 ${days} 天`
    return {
      jwt,
      worker,
      overallOk: true,
      overallMessage: `Worker 可达（${worker.detail ?? 'OK'}）${tail}`,
      tokenExpiringSoon: expiringSoon,
    }
  }
  return {
    jwt,
    worker,
    overallOk: false,
    overallMessage: worker.attempted
      ? `Token 有效，但 worker 不可达：${worker.detail ?? 'unknown'}`
      : `Token 有效，但 worker URL 未配置或格式不合法`,
    tokenExpiringSoon: false,
  }
}
