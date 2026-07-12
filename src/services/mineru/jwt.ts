/**
 * MinerU JWT token 解析（纯浏览器端，M3.7）
 * -------------------------------------------------
 * MinerU 官方 token 是标准 JWT（HS512 签名），header.payload.signature 三段。
 * 前端只解 payload 段拿 exp/iat/uuid/jti 展示（不做签名校验，那是服务端的事）。
 *
 * 典型 payload（脱敏）：
 *   { jti:'97600059', rol:'ROLE_REGISTER', iss:'OpenXLab',
 *     iat:1782812092, clientId:'...', uuid:'5e82cc5b-...', exp:1790588092 }
 */
import type { MineruJwtInfo } from '../../types'

/** base64url → base64（还原 URL-safe 编码） + 补 padding */
function base64UrlToBase64(input: string): string {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4)
  return padded.replace(/-/g, '+').replace(/_/g, '/')
}

/**
 * 解析 MinerU JWT token，返回 exp/iat/uuid/jti + 剩余天数
 * 只要 token 三段结构完整，即使字段缺失也返回 {isExpired:false, parseError:undefined}
 * token 结构错误时返回 {isExpired:true, parseError:'reason'}（视为无效凭据）
 */
export function parseMineruJwt(raw: string): MineruJwtInfo {
  const trimmed = raw.trim()
  if (!trimmed) {
    return { raw: '', isExpired: true, parseError: 'token 为空' }
  }

  const parts = trimmed.split('.')
  if (parts.length !== 3) {
    return {
      raw: trimmed,
      isExpired: true,
      parseError: `token 格式无效（期望 3 段，得到 ${parts.length} 段）`,
    }
  }

  let payload: Record<string, unknown>
  try {
    const b64 = base64UrlToBase64(parts[1])
    // decodeURIComponent + escape 组合处理 UTF-8（虽然 payload 一般都是 ASCII）
    const json = decodeURIComponent(
      Array.from(atob(b64), (c) =>
        '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2),
      ).join(''),
    )
    payload = JSON.parse(json) as Record<string, unknown>
  } catch (err) {
    return {
      raw: trimmed,
      isExpired: true,
      parseError: `payload 解析失败: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const exp = typeof payload.exp === 'number' ? payload.exp : undefined
  const iat = typeof payload.iat === 'number' ? payload.iat : undefined
  const jti = typeof payload.jti === 'string' ? payload.jti : undefined
  const uuid = typeof payload.uuid === 'string' ? payload.uuid : undefined

  const nowSec = Math.floor(Date.now() / 1000)
  const isExpired = exp !== undefined ? nowSec >= exp : false
  const remainingDays =
    exp !== undefined ? Math.floor((exp - nowSec) / 86400) : undefined
  const expiresAt = exp !== undefined ? new Date(exp * 1000) : undefined

  return {
    raw: trimmed,
    jti,
    uuid,
    iat,
    exp,
    expiresAt,
    remainingDays,
    isExpired,
  }
}

/**
 * 剩余天数分级：用于 UI 颜色 & 文案
 *   - fresh  ≥ 7 天：绿色
 *   - warn   2-6 天：橙色（提醒续期）
 *   - danger 0-1 天：红色（明天就过期）
 *   - expired < 0：深红（已失效）
 */
export type MineruJwtSeverity = 'fresh' | 'warn' | 'danger' | 'expired' | 'invalid'

export function severity(info: MineruJwtInfo): MineruJwtSeverity {
  if (info.parseError) return 'invalid'
  if (info.isExpired) return 'expired'
  if (info.remainingDays === undefined) return 'invalid'
  if (info.remainingDays < 2) return 'danger'
  if (info.remainingDays < 7) return 'warn'
  return 'fresh'
}
