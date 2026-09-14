/**
 * MinerU 联通性检测
 * -------------------------------------------------
 * 当前架构（v0.3 M3.7 后端改造后）：
 *   MinerU API 由 GitHub Actions runner 直接调用
 *   （.github/scripts/pipeline.mjs → https://mineru.net/api/v4），
 *   前端不直接发 MinerU 业务请求，只把 MINERU_API_TOKEN 写入 GitHub Secrets。
 *
 * 所以"MinerU 是否联通"的核心判据只有一个：**你填的 JWT 是否有效**。
 * 老架构中的 worker 代理（mineruWorkerUrl）已在架构切换中废弃
 * （Deno Deploy 50s 超时 + GitHub Pages HTTPS → HTTP Mixed Content 双重阻塞）。
 *
 * 本服务只做一件事：parseMineruJwt 本地解析 JWT，零网络开销。
 *   - 提取 iat / exp / uuid / jti
 *   - 判断 token 是否过期 / 即将过期（≤7 天给 warning）
 */
import type { MineruJwtInfo } from '../types'

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

/** 综合联通报告 —— 供 UI 直接渲染（token-only，无 worker 探活） */
export interface MineruConnectivityReport {
  /** JWT 解析结果 */
  jwt: MineruJwtInfo
  /** 综合判断：token 解析失败 / 已过期 → false；token 合法 → true */
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
 * 当前架构下前端不发 MinerU 业务请求，零网络开销。
 */
export function checkMineruConnectivity(token: string): MineruConnectivityReport {
  const jwt = parseMineruJwt(token)

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
        ? `Token 已过期（${jwt.expiresAt.toLocaleString()}），MinerU 无法调用`
        : 'Token 已过期',
      tokenExpiringSoon: false,
    }
  }

  // 2. token 合法 —— 核心判据满足
  const days = jwt.remainingDays ?? Number.POSITIVE_INFINITY
  const expiringSoon = days <= WARNING_DAYS
  const overallMessage = expiringSoon
    ? `Token 有效，但将在 ${days} 天后过期（${jwt.expiresAt?.toLocaleDateString()}）`
    : `Token 有效，剩余 ${days} 天`

  return {
    jwt,
    overallOk: true,
    overallMessage,
    tokenExpiringSoon: expiringSoon,
  }
}
