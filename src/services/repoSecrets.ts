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

/** sodium ready Promise —— 确保所有调用前初始化完成 */
let sodiumReady: Promise<void> | null = null
function ensureSodiumReady(): Promise<void> {
  if (!sodiumReady) {
    sodiumReady = Promise.resolve(sodium.ready)
  }
  return sodiumReady
}

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

  await ensureSodiumReady()
  // GitHub 返回的 key 是 base64 编码的 sodium public key
  const publicKeyBytes = sodium.from_base64(data.key, sodium.base64_variants.ORIGINAL)
  const result = { keyId: data.key_id, publicKey: publicKeyBytes }
  publicKeyCache.set(cacheKey, result)
  return result
}

/**
 * 加密 secret 值（async — 内部确保 sodium 已 ready）
 */
async function encryptSecret(plaintext: string, publicKey: Uint8Array): Promise<string> {
  await ensureSodiumReady()
  const messageBytes = sodium.from_string(plaintext)
  const encrypted = sodium.crypto_box_seal(messageBytes, publicKey)
  return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL)
}

/**
 * 写入单个 GitHub Actions Repository Secret
 * 注意：GitHub API 拒绝空字符串（HTTP 422），所以 value.trim() 为空时返回 skipped
 */
export async function putRepoSecret(
  owner: string,
  repo: string,
  token: string,
  name: string,
  value: string,
): Promise<PutSecretResult> {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) {
    // GitHub API 硬限制：secret value 不能为空，跳过（这是 GitHub 限制，不是我们想跳）
    return { ok: true, status: 0, changed: false, name }
  }

  const { keyId, publicKey } = await getPublicKey(owner, repo, token)
  const encryptedValue = await encryptSecret(trimmed, publicKey)

  const res = await githubFetch(
    `/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(name)}`,
    token,
    {
      method: 'PUT',
      body: JSON.stringify({ encrypted_value: encryptedValue, key_id: keyId }),
    },
  )

  return {
    ok: res.ok,
    status: res.status,
    changed: res.status === 201,
    name,
  }
}

/**
 * 批量写入多个 secret
 * GitHub API 限制：secret value 不能为空字符串 → 空值条目自动跳过
 */
export async function putRepoSecrets(
  owner: string,
  repo: string,
  token: string,
  secrets: Record<string, string>,
): Promise<{ results: PutSecretResult[]; errors: string[] }> {
  // 所有 entries 都尝试写——只有空值被 GitHub API 硬限制跳过
  const entries = Object.entries(secrets)
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

  for (const [name, rawValue] of entries) {
    const value = rawValue?.trim() ?? ''
    if (!value) {
      // GitHub API 不允许空 secret 值，跳过
      continue
    }
    try {
      const encryptedValue = await encryptSecret(value, keyInfo.publicKey)
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

export type AiSecretName = typeof AI_SECRET_NAMES[number]

/** GitHub 上查到的单个 secret 元信息（API 不返回值，只返回 exists + 时间戳） */
export interface GitHubSecretMeta {
  name: string
  created_at: string
  updated_at: string
}

/**
 * 列出 repo 上所有 Actions secrets（**不返回值，GitHub API 禁止**）
 * https://docs.github.com/en/rest/actions/secrets?apiVersion=2022-11-28#list-repository-secrets
 */
export async function listRepoSecrets(
  owner: string,
  repo: string,
  token: string,
): Promise<GitHubSecretMeta[]> {
  const res = await githubFetch(
    `/repos/${owner}/${repo}/actions/secrets`,
    token,
  )
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`list secrets 失败 ${res.status}: ${txt.slice(0, 200)}`)
  }
  const data = (await res.json()) as { secrets?: GitHubSecretMeta[] }
  return data.secrets ?? []
}

/** syncAllSecrets 返回的每个 secret 的明细状态 */
export interface SecretItemStatus {
  name: AiSecretName
  /** 前端要写的值（已 trim） */
  valueWanted: string
  /** 是否成功 PUT 到 GitHub */
  putOk: boolean
  /** GitHub HTTP status：201=创建 / 204=更新 / 0=值空跳过 / 4xx/5xx=失败 */
  putStatus: number
  /** PUT 后等 GitHub 索引生效再回查，是否确认存在 */
  verified: boolean
  /** 失败时的错误信息（PUT 失败的 res.text() 或 verify 失败的 reason） */
  error?: string
}

export interface SyncAllSecretsInput {
  aiProviderMode: 'siliconflow' | 'custom'
  siliconflowApiKey: string
  ai1Model: string
  ai2Model: string
  customAi1BaseUrl: string
  customAi1ApiKey: string
  customAi1Model: string
  customAi2BaseUrl: string
  customAi2ApiKey: string
  customAi2Model: string
  mineruToken: string
}

const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1'

/**
 * 前端 Settings → GitHub Actions Secrets
 *
 * 唯一写入入口。写完之后**等 1.5s GitHub 索引生效**再回查一次，
 * 把每个 secret 的最终状态（写入 + verify）返回给调用方，
 * 让前端 UI 可以**把每一条的状态直接亮给用户看**，拒绝黑箱。
 */
export async function syncAllSecrets(
  owner: string,
  repo: string,
  token: string,
  s: SyncAllSecretsInput,
): Promise<SecretItemStatus[]> {
  // 按 provider 模式拼装 —— 7 个全部塞进去
  const secretsMap: Record<AiSecretName, string> = {
    MINERU_API_TOKEN: s.mineruToken,
    AI1_BASE_URL:    s.aiProviderMode === 'custom' ? s.customAi1BaseUrl : SILICONFLOW_BASE_URL,
    AI1_API_KEY:     s.aiProviderMode === 'custom' ? s.customAi1ApiKey  : s.siliconflowApiKey,
    AI1_MODEL:       s.aiProviderMode === 'custom' ? s.customAi1Model    : s.ai1Model,
    AI2_BASE_URL:    s.aiProviderMode === 'custom' ? s.customAi2BaseUrl : SILICONFLOW_BASE_URL,
    AI2_API_KEY:     s.aiProviderMode === 'custom' ? s.customAi2ApiKey  : s.siliconflowApiKey,
    AI2_MODEL:       s.aiProviderMode === 'custom' ? s.customAi2Model    : s.ai2Model,
  }

  // 1. PUT 每一个
  const items: SecretItemStatus[] = AI_SECRET_NAMES.map((name) => {
    const val = secretsMap[name]?.trim() ?? ''
    return { name, valueWanted: val, putOk: false, putStatus: 0, verified: false }
  })

  // 先 GET 一次公钥
  let keyInfo: { keyId: string; publicKey: Uint8Array }
  try {
    keyInfo = await getPublicKey(owner, repo, token)
  } catch (e: any) {
    for (const it of items) { it.error = `获取公钥失败: ${e.message}` }
    return items
  }

  for (const it of items) {
    if (!it.valueWanted) {
      // 空值 —— GitHub API 硬限制：secret value 不能为空，跳过但标记一下
      it.putStatus = 0
      it.error = '未填写'
      continue
    }
    try {
      const enc = await encryptSecret(it.valueWanted, keyInfo.publicKey)
      const res = await githubFetch(
        `/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(it.name)}`,
        token,
        { method: 'PUT', body: JSON.stringify({ encrypted_value: enc, key_id: keyInfo.keyId }) },
      )
      it.putOk = res.ok
      it.putStatus = res.status
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        it.error = `HTTP ${res.status}: ${txt.slice(0, 200)}`
      }
    } catch (e: any) {
      it.error = e.message || String(e)
    }
  }

  // 2. 等 GitHub 索引生效（经验值 ~1-2s）
  await new Promise((r) => setTimeout(r, 1500))

  // 3. 回查 —— GET /repos/{owner}/{repo}/actions/secrets 拿到所有存在的名字
  try {
    const all = await listRepoSecrets(owner, repo, token)
    const existing = new Set(all.map((s) => s.name))
    for (const it of items) {
      if (it.putOk && it.valueWanted && existing.has(it.name)) {
        it.verified = true
      } else if (it.putOk && it.valueWanted && !existing.has(it.name)) {
        // PUT 204 了但 list 里还没——GitHub 索引延迟，给个提示
        it.verified = false
        it.error = (it.error ? it.error + '; ' : '') + 'GitHub 回查未命中（索引延迟？）'
      }
    }
  } catch (e: any) {
    // verify 本身失败不影响 put 结果，但要让用户知道
    const msg = `回查失败: ${e.message || String(e)}`
    for (const it of items) {
      if (it.putOk) it.error = (it.error ? it.error + '; ' : '') + msg
    }
  }

  return items
}
