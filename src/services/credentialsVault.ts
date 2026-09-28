/**
 * 凭据保险箱（跨设备恢复 API Key）
 * -------------------------------------------------
 * 问题：GitHub Actions Secrets **只写不可读**，所以把 Key 写进 secrets 不能
 * 让新设备自动回填；而 IndexedDB 又是每台设备各存一份，换设备就得重配。
 *
 * 解法：换设备时用户**必然要重新登录**，而同一账号下的 PAT 是一致的。
 * 于是把敏感凭据用「PAT 派生的密钥」加密后，存进私库的一个文件里：
 *   settings/credentials.vault.json  （密文，不是明文）
 *   - KDF：PBKDF2-SHA256(token) → AES-GCM-256
 *   - 新设备登录后自动拉取 → 解密 → 回填本机空缺的字段，无需再手填
 *   - 只有仓库读权限、拿不到 PAT 的人解不开；PAT 本就等于仓库全权限，
 *     所以把密文放私库并不额外扩大暴露面
 *
 * 刻意不做的事：
 *   - 不存明文 Key（SPEC §2.3 禁止 Key 落到 md/明文文件）
 *   - 不覆盖本机已有的值（只在字段为空时回填），避免旧密文盖掉新 Key
 */
import { readRepoTextFile, writeRepoTextFile } from './github'
import { useSettingsStore, SENSITIVE_FIELDS } from '../stores/settings'
import type { SettingsData } from '../types'

/** 私库里的保险箱文件路径 */
const VAULT_PATH = 'settings/credentials.vault.json'
const PBKDF2_ITERATIONS = 200_000
const VAULT_VERSION = 1

interface VaultFile {
  v: number
  kdf: 'PBKDF2-SHA256'
  iterations: number
  /** base64 盐（复用已有盐，保证同一 PAT 每次派生同一把密钥，便于比对 sig） */
  salt: string
  /** base64 GCM IV（每次随机） */
  iv: string
  /** base64 密文（含 GCM tag） */
  data: string
  /** 明文的 SHA-256（base64），仅用于「内容没变就别再提交」的去重判断 */
  sig: string
  updatedAt: string
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function deriveKey(
  token: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function sha256B64(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return bytesToB64(new Uint8Array(digest))
}

/** 从设置里取出所有敏感字段（明文对象） */
function collectCreds(): Record<string, string> {
  const s = useSettingsStore.getState() as unknown as Record<string, unknown>
  const creds: Record<string, string> = {}
  for (const field of SENSITIVE_FIELDS) {
    creds[field as string] = String(s[field as string] ?? '')
  }
  return creds
}

function hasAnyValue(creds: Record<string, string>): boolean {
  return Object.values(creds).some((v) => v.trim().length > 0)
}

/**
 * 把当前所有敏感凭据加密写进私库保险箱。
 * - 内容与私库里已有的完全一致（sig 相同）→ 直接跳过，不再产生空提交
 * - 无任何凭据 → 跳过
 * 返回是否真的写了。
 */
export async function saveCredentialsVault(
  owner: string,
  repo: string,
  token: string,
): Promise<boolean> {
  const creds = collectCreds()
  if (!hasAnyValue(creds)) return false

  const plaintextBytes = new TextEncoder().encode(JSON.stringify(creds))
  const sig = await sha256B64(plaintextBytes)

  // 读一下已有保险箱：复用盐，并比对 sig 去重
  let existing: VaultFile | null = null
  try {
    const r = await readRepoTextFile(owner, repo, VAULT_PATH, token)
    if (r) existing = JSON.parse(r.content) as VaultFile
  } catch (e) {
    console.warn('[credentialsVault] 读取已有保险箱失败（按新增处理）：', e)
  }

  if (existing && existing.sig === sig) return false // 内容没变，别提交

  const salt = existing?.salt ? b64ToBytes(existing.salt) : crypto.getRandomValues(new Uint8Array(16))
  const iterations = existing?.iterations ?? PBKDF2_ITERATIONS
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(token, salt, iterations)
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintextBytes)

  const file: VaultFile = {
    v: VAULT_VERSION,
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    data: bytesToB64(new Uint8Array(cipher)),
    sig,
    updatedAt: new Date().toISOString(),
  }

  await writeRepoTextFile(owner, repo, VAULT_PATH, JSON.stringify(file), token, 'chore: sync credentials vault')
  return true
}

/** 读取并解密保险箱；不存在 / 解密失败（如换了 PAT）返回 null，不抛 */
export async function loadCredentialsVault(
  owner: string,
  repo: string,
  token: string,
): Promise<Record<string, string> | null> {
  try {
    const r = await readRepoTextFile(owner, repo, VAULT_PATH, token)
    if (!r) return null
    const file = JSON.parse(r.content) as VaultFile
    const key = await deriveKey(token, b64ToBytes(file.salt), file.iterations || PBKDF2_ITERATIONS)
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(file.iv) },
      key,
      b64ToBytes(file.data),
    )
    return JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>
  } catch (e) {
    console.warn('[credentialsVault] 保险箱不存在或解密失败（可能换了 PAT）：', e)
    return null
  }
}

/**
 * 启动时调用：把私库保险箱里、而本机为空的敏感字段回填进来。
 * **只填空缺，不覆盖本机已有值**。返回被回填的字段名列表。
 */
export async function restoreCredentialsFromVault(
  owner: string,
  repo: string,
  token: string,
): Promise<string[]> {
  const vault = await loadCredentialsVault(owner, repo, token)
  if (!vault) return []

  const s = useSettingsStore.getState() as unknown as Record<string, unknown>
  const patch: Partial<SettingsData> = {}
  const filled: string[] = []
  for (const field of SENSITIVE_FIELDS) {
    const key = field as string
    const local = String(s[key] ?? '').trim()
    const remote = String(vault[key] ?? '').trim()
    if (!local && remote) {
      ;(patch as Record<string, string>)[key] = remote
      filled.push(key)
    }
  }
  if (filled.length > 0) {
    await useSettingsStore.getState().updateSettings(patch)
  }
  return filled
}
