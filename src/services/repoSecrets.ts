/**
 * repoSecrets —— 前端写入 GitHub Actions Secrets
 *
 * GitHub 不允许明文写 secret，必须用 libsodium sealed box 加密。
 * 流程：GET public key → crypto_box_seal → PUT encrypted_value + key_id
 */
import * as sodium from 'libsodium-wrappers'
import { githubFetch } from './github'

/** 公钥缓存 —— 同一个 repo 的 key_id 不会变，缓存一次省得每次 GET */
const publicKeyCache = new Map<string, { keyId: string; publicKey: Uint8Array }>()

interface PutSecretResult {
  ok: boolean
  status: number
  changed: boolean // true=创建，false=更新相同值（GitHub 返回 204 时也是 changed=true 因为我们没法对比旧值）
  name: string
}

/**
 * 获取 repo 的 Actions secrets 公钥（带缓存）
 * https://docs.github.com/en/rest/actions/secrets?apiVersion=2022-11-28#get-an-organization-public-key
 */
async function getPublicKey(owner: string, repo: string, token: string): Promise<{ keyId: string; publicKey: Uint8Array }> {
  const cacheKey = `${owner}/${repo}`
  const cached = publicKeyCache.get(cacheKey)
  if (cached) return cached

  const res = await githubFetch(
    `/repos/${owner}/${repo}/actions/secrets/public-key`,
    token,
  )
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`获取 secrets 公钥失败 ${res.status}: ${txt.slice(0, 200)}`)
  }
  const data = (await res.json()) as { key_id: string; key: string }

  await sodium.ready
  // GitHub 返回的 key 是 base64 编码的 sodium public key
  const publicKeyBytes = sodium.from_base64(data.key, sodium.base64_variants.ORIGINAL)
  const result = { keyId: data.key_id, publicKey: publicKeyBytes }
  publicKeyCache.set(cacheKey, result)
  return result
}

/**
 * 加密 secret 值
 */
function encryptSecret(plaintext: string, publicKey: Uint8Array): string {
  const messageBytes = sodium.from_string(plaintext)
  const encrypted = sodium.crypto_box_seal(messageBytes, publicKey)
  return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL)
}

/**
 * 写入单个 GitHub Actions Repository Secret
 */
export async function putRepoSecret(
  owner: string,
  repo: string,
  token: string,
  name: string,
  value: string,
): Promise<PutSecretResult> {
  if (!value || !value.trim()) {
    // 空值不写——避免覆盖用户可能手动设置的值
    return { ok: true, status: 0, changed: false, name }
  }

  const { keyId, publicKey } = await getPublicKey(owner, repo, token)
  const encryptedValue = encryptSecret(value.trim(), publicKey)

  const res = await githubFetch(
    `/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(name)}`,
    token,
    {
      method: 'PUT',
      body: JSON.stringify({ encrypted_value: encryptedValue, key_id: keyId }),
    },
  )

  // GitHub: 201 = 创建, 204 = 更新, 404 = 没有写权限 / 不是 repo 管理员
  return {
    ok: res.ok,
    status: res.status,
    changed: res.status === 201,
    name,
  }
}

/**
 * 批量写入多个 secret —— 并行，一个失败不影响其他
 */
export async function putRepoSecrets(
  owner: string,
  repo: string,
  token: string,
  secrets: Record<string, string>,
): Promise<{ results: PutSecretResult[]; errors: string[] }> {
  const entries = Object.entries(secrets).filter(([, v]) => v && v.trim())
  const results: PutSecretResult[] = []
  const errors: string[] = []

  // 先 GET 一次公钥（所有 secret 共用同一个）
  let keyInfo: { keyId: string; publicKey: Uint8Array } | null = null
  try {
    keyInfo = await getPublicKey(owner, repo, token)
  } catch (e: any) {
    errors.push(`获取公钥失败: ${e.message}`)
    return { results, errors }
  }

  for (const [name, value] of entries) {
    try {
      const encryptedValue = encryptSecret(value.trim(), keyInfo.publicKey)
      const res = await githubFetch(
        `/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(name)}`,
        token,
        {
          method: 'PUT',
          body: JSON.stringify({ encrypted_value: encryptedValue, key_id: keyInfo.keyId }),
        },
      )
      results.push({ ok: res.ok, status: res.status, changed: res.status === 201, name })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        errors.push(`${name}: ${res.status} ${txt.slice(0, 150)}`)
      }
    } catch (e: any) {
      errors.push(`${name}: ${e.message}`)
    }
  }

  return { results, errors }
}

/** 支持写入的 7 个 AI/MinerU secrets 名字 */
export const AI_SECRET_NAMES = [
  'MINERU_API_TOKEN',
  'AI1_BASE_URL', 'AI1_API_KEY', 'AI1_MODEL',
  'AI2_BASE_URL', 'AI2_API_KEY', 'AI2_MODEL',
] as const
