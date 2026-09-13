/**
 * MinerU 联通性检测
 * -------------------------------------------------
 * 当前架构（v0.3 M3 后端改造后）：
 *   MinerU API 由 GitHub Actions runner 直接调用
 *   （.github/scripts/pipeline.mjs → https://mineru.net/api/v4），
 *   前端不直接发 MinerU 业务请求，只把 MINERU_API_TOKEN 写入 GitHub Secrets。
 *
 * 所以"MinerU 是否联通"的核心判据只有一个：**你填的 JWT 是否有效**。
 * worker 代理（mineruWorkerUrl）是老架构遗留 —— 当时前端直连 MinerU
 * 需要绕过 CORS / Mixed Content；现在 GitHub Pages（HTTPS）上它根本跑不通
 * （HTTPS 页面无法请求 HTTP 代理，浏览器直接拦截 = Mixed Content）。
 *
 * 本服务做三件事：
 *   1. parseMineruJwt：本地解析 JWT，提取 iat / exp / uuid / jti，
 *      判断 token 是否过期 / 即将过期。零网络开销，永远可用。
 *   2. detectMixedContent：检测当前页面协议 vs worker URL 协议，
 *      提前识别 Mixed Content 拦截场景（这是 GitHub Pages 用户
 *      "Failed to fetch" 的根因，不是 worker 真挂了）。
 *   3. checkWorkerHealth：仅在协议兼容时才探活 worker /__af_health。
 *      即使 worker 不可达，也不把 MinerU 整体判为失败 ——
 *      token 才是 Actions runner 调用 MinerU 的凭据。
 */
import type { MineruJwtInfo } from '../types'

/** 探活请求超时（ms）—— worker 应该秒回，5s 足够 */
const HEALTH_TIMEOUT_MS = 5000

/** 即将到期阈值（天）：剩余 ≤7 天给 warning（仍 ok，但 UI 给橙色） */
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
  /** worker 不可达的原因分类 —— UI 可据此给不同颜色 / 提示 */
  reason?: 'mixed_content' | 'not_configured' | 'bad_url' | 'timeout' | 'network' | 'http_error'
  /** 是否实际发起过网络请求 */
  attempted: boolean
}

/**
 * 探测 worker 代理的 /__af_health 端点
 *
 * install.sh 部署的 Deno worker 在 /__af_health 返回：
 *   { "ok": true, "service": "academicflow-worker" }
 *
 * 该端点不需要 Authorization，纯探活用。
 *
 * ⚠️ Mixed Content 是 GitHub Pages 用户的头号杀手：
 *   HTTPS 页面 → HTTP worker，浏览器直接静默拦截，表现为 "Failed to fetch"。
 *   这里提前检测协议匹配，命中则直接返回 reason=mixed_content，
 *   不发起无意义的 fetch，也不让用户误以为 worker 真挂了。
 */
export async function checkWorkerHealth(
  workerUrl: string | undefined | null,
): Promise<WorkerHealthResult> {
  const url = workerUrl?.trim()
  if (!url) {
    return {
      ok: false,
      attempted: false,
      reason: 'not_configured',
      detail: '未配置 worker 代理 URL（当前架构前端不直连 MinerU，worker 已非必需）',
    }
  }

  let base: URL
  try {
    base = new URL(url)
  } catch {
    return {
      ok: false,
      attempted: false,
      reason: 'bad_url',
      detail: `worker URL 格式不合法：${url}`,
    }
  }

  // 检测 Mixed Content：HTTPS 页面请求 HTTP worker
  if (typeof window !== 'undefined'
    && window.location.protocol === 'https:'
    && base.protocol === 'http:') {
    return {
      ok: false,
      attempted: false,
      reason: 'mixed_content',
      detail: 'HTTPS 页面无法请求 HTTP worker（浏览器 Mixed Content 策略拦截）。'
            + 'GitHub Pages 上请忽略此检测，或为 worker 配 HTTPS / Caddy 反代。',
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
        reason: 'http_error',
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
        reason: 'http_error',
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
      reason: isAborted ? 'timeout' : 'network',
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
  /** worker 探活结果（含 reason 分类） */
  worker?: WorkerHealthResult
  /** worker 探活是否被跳过（Mixed Content / 未配置 / 格式错） */
  workerSkipped: boolean
  /** 综合判断：
   *   - token 解析失败 / 已过期 → false
   *   - token 合法 → true（worker 不可达不再拉低整体状态）
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
 * 核心逻辑：token 是 GitHub Actions 调用 MinerU 的凭据 → 有效即 OK。
 * worker 探活是补充信息，不可达不影响整体判断（Mixed Content 是常态）。
 *
 * @param opts.token MinerU JWT token（必填）
 * @param opts.workerUrl 用户自部署的 worker 代理 URL（可选；不传或协议不兼容则跳过探活）
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
      workerSkipped: true,
      overallOk: false,
      overallMessage: `Token 不合法：${jwt.parseError}`,
      tokenExpiringSoon: false,
    }
  }
  if (jwt.isExpired) {
    return {
      jwt,
      workerSkipped: true,
      overallOk: false,
      overallMessage: jwt.expiresAt
        ? `Token 已过期（${jwt.expiresAt.toLocaleString()}），MinerU 无法调用`
        : 'Token 已过期',
      tokenExpiringSoon: false,
    }
  }

  // 2. token 合法 —— 核心判据满足，整体 OK
  //    worker 探活做补充信息，不影响 overallOk
  const days = jwt.remainingDays ?? Number.POSITIVE_INFINITY
  const expiringSoon = days <= WARNING_DAYS

  let worker: WorkerHealthResult | undefined
  if (opts.workerUrl?.trim()) {
    worker = await checkWorkerHealth(opts.workerUrl)
  } else {
    worker = {
      ok: false,
      attempted: false,
      reason: 'not_configured',
      detail: '未配置 worker 代理 URL',
    }
  }

  // 拼 overallMessage
  const jwtMsg = expiringSoon
    ? `Token 有效，但将在 ${days} 天后过期（${jwt.expiresAt?.toLocaleDateString()}）`
    : `Token 有效，剩余 ${days} 天`

  let workerMsg = ''
  if (worker.reason === 'mixed_content') {
    workerMsg = '；worker 探活跳过（HTTPS → HTTP Mixed Content，GitHub Pages 上属于正常现象）'
  } else if (worker.reason === 'not_configured') {
    workerMsg = '；未配置 worker'
  } else if (worker.ok) {
    workerMsg = `；worker 可达（${worker.detail ?? 'OK'}）`
  } else if (worker.attempted) {
    workerMsg = `；worker 不可达（${worker.detail ?? 'unknown'}）`
  } else {
    workerMsg = `；${worker.detail ?? 'worker 未探活'}`
  }

  return {
    jwt,
    worker,
    workerSkipped: !worker.attempted,
    overallOk: true, // token 有效就 OK
    overallMessage: jwtMsg + workerMsg,
    tokenExpiringSoon: expiringSoon,
  }
}
