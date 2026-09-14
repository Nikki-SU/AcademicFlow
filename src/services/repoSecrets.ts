/**
 * repoSecrets —— 前端写入 GitHub Actions Secrets
 *
 * GitHub 不允许明文写 secret，必须用 libsodium sealed box 加密。
 * 流程：GET public key → crypto_box_seal → PUT encrypted_value + key_id
 */
import sodium from 'libsodium-wrappers'
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
 *
 * 显式传 per_page=100（最大值），避免 repo secrets 变多后被分页截断
 * 导致 verify 时 GET list 看不到刚 PUT 的条目。
 */
export async function listRepoSecrets(
  owner: string,
  repo: string,
  token: string,
): Promise<GitHubSecretMeta[]> {
  const res = await githubFetch(
    `/repos/${owner}/${repo}/actions/secrets?per_page=100`,
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
  // ──── 硬保险：secrets 绝对不能写到主仓库（AGPL v3，公开可见） ────
  // 前端必须传私库 academicflow-workspace。如果传错，直接抛异常拒绝写入，
  // 而不是"悄悄跳过"让用户以为写成功了。
  if (!repo || repo !== 'academicflow-workspace') {
    throw new Error(
      `syncAllSecrets 拒绝写入非私库 repo="${repo}"。` +
      `AI/MinerU secrets 只能写到私库 academicflow-workspace，` +
      `主仓库 ${owner}/AcademicFlow 是 AGPL v3 公开的。`
    )
  }

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
      console.log(`[syncAllSecrets] PUT ${it.name} → ${res.status} ${res.ok ? '✓' : '✗ ' + it.error}`)
    } catch (e: any) {
      it.error = e.message || String(e)
      console.log(`[syncAllSecrets] PUT ${it.name} → EXCEPTION: ${it.error}`)
    }
  }

  // 2. 回查 —— GET /repos/{owner}/{repo}/actions/secrets 拿到所有存在的名字
  //    GitHub Actions Secrets 后端是分布式异步的：PUT 204 只代表"请求接收"，
  //    密文写入持久化 + 索引到 secrets 服务需要额外时间。长值 API key / token
  //    加密后体积更大，处理明显比短值 URL / 模型名慢，经验值 2-5s。
  //    用指数退避重试 4 次（1s → 2s → 4s → 8s），总等待 ≤15s 能覆盖 99% 情况。
  const MAX_VERIFY_ATTEMPTS = 4
  const VERIFY_BACKOFF_BASE_MS = 1000 // 第一次等 1s，之前硬编码 1.5s 的起点

  // 先构造需要验证的 Set（只有 putOk + 有值的才需要验证）
  const needVerify = new Set<AiSecretName>()
  for (const it of items) {
    if (it.putOk && it.valueWanted) needVerify.add(it.name)
  }

  let allExisting = new Set<string>()
  let lastListErr: string | null = null

  for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt++) {
    // 退避等待（第一次不等，因为 PUT 循环本身有一定耗时；attempt=1 前的 delay=0）
    if (attempt > 1) {
      const delay = VERIFY_BACKOFF_BASE_MS * Math.pow(2, attempt - 2) // 2s, 4s, 8s
      console.log(`[syncAllSecrets] verify attempt ${attempt}/${MAX_VERIFY_ATTEMPTS}: wait ${delay}ms...`)
      await new Promise((r) => setTimeout(r, delay))
    } else {
      // 第一次也短暂等一下，让 GitHub 有时间处理
      await new Promise((r) => setTimeout(r, 500))
    }

    try {
      const all = await listRepoSecrets(owner, repo, token)
      allExisting = new Set(all.map((s) => s.name))
      lastListErr = null
      console.log(`[syncAllSecrets] verify attempt ${attempt}: GET found [${[...allExisting].join(', ')}]`)

      // 检查每条的状态
      let stillPending = 0
      for (const it of items) {
        if (needVerify.has(it.name) && allExisting.has(it.name)) {
          if (!it.verified) {
            it.verified = true
            it.error = undefined // 之前可能写了"索引延迟"，现在清掉
          }
        } else if (needVerify.has(it.name) && !allExisting.has(it.name)) {
          stillPending++
        }
      }

      if (stillPending === 0) {
        console.log(`[syncAllSecrets] verify: 全部 ${items.length} 条已就绪 ✓`)
        break
      }
      console.log(`[syncAllSecrets] verify: 仍有 ${stillPending} 条待索引，继续重试...`)
    } catch (e: any) {
      lastListErr = e.message || String(e)
      console.warn(`[syncAllSecrets] verify attempt ${attempt}: list 失败 — ${lastListErr}`)
      // list 本身炸了不立即放弃，还有重试机会
    }
  }

  // 收尾：对最终还没命中的条目标错误信息
  for (const it of items) {
    if (needVerify.has(it.name) && !allExisting.has(it.name)) {
      it.verified = false
      it.error = (it.error ? it.error + '; ' : '') +
        `GitHub 回查未命中（已等 ${MAX_VERIFY_ATTEMPTS} 次指数退避约 ${VERIFY_BACKOFF_BASE_MS * (Math.pow(2, MAX_VERIFY_ATTEMPTS - 1) - 1)}s）`
    }
    if (lastListErr && !it.verified && !it.error) {
      it.error = `回查 list 持续失败: ${lastListErr}`
    }
    console.log(`  ${it.name}: put=${it.putOk ? it.putStatus : 'FAIL'} verified=${it.verified} err=${it.error ?? '-'}`)
  }

  return items
}
