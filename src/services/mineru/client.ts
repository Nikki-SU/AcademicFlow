/**
 * MinerU v4 API 客户端（纯浏览器端，M3.7）
 * -------------------------------------------------
 * 官方文档：https://mineru.net/apiManage/docs
 *
 * 4 步流程：
 *   1) applyUploadUrls: POST /api/v4/file-urls/batch → batch_id + presigned_url
 *   2) uploadFile: PUT <presigned_url> body=binary
 *   3) pollBatch: GET /api/v4/extract-results/batch/{batch_id} 轮询到 state=done
 *   4) downloadZip: GET <full_zip_url> → Blob → 交给 extractZip 用 jszip 解
 *
 * 单文件硬约束：≤200MB 且 ≤600 页（Rosa 一手实测 200 页更稳，产品侧锁 180 页/片）
 *
 * 错误分类（对齐 services/ai/client.ts 风格）：
 *   - 401 → MineruAuthError（token 过期/无效）
 *   - 429 → MineruRateLimitError
 *   - 5xx / 网络错误 → MineruNetworkError
 *   - 其他 4xx / code != 0 → MineruClientError（携带 status + providerMessage）
 *   - state=failed/error → MineruProcessingError（解析失败，非请求失败）
 */
import type {
  MineruApplyRequest,
  MineruApplyResponse,
  MineruBatchResult,
  MineruFileResult,
  MineruProgressCallback,
} from '../../types'

export const MINERU_API_SUFFIX = '/api/v4'
export const MINERU_PROXY_SUFFIX = '/proxy'

/**
 * 构造 MinerU API 的 baseUrl。
 * MinerU 服务端不返回 CORS 头，浏览器直连会 preflight 405，
 * 因此必须走用户自持的 Cloudflare Worker 透传代理。
 *
 * @param workerUrl 用户在 Settings 里配置的 workers.dev URL（如 https://xxx.workers.dev）
 *                  尾斜杠会自动清理
 * @returns 如 `https://xxx.workers.dev/api/v4`
 * @throws 当 workerUrl 为空时抛错，提醒调用方去 Settings 配置
 */
export function buildMineruBaseUrl(workerUrl: string | null | undefined): string {
  const trimmed = (workerUrl ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) {
    throw new MineruError(
      'MinerU 代理未配置。请前往 Settings → MinerU 代理，选择方案并部署你自己的透传代理（免费）。',
    )
  }
  return trimmed + MINERU_API_SUFFIX
}

/**
 * 构造走 Worker /proxy 白名单透传的 URL，用于 MinerU 返回的 OSS 预签名 URL。
 * OSS 域名（如 mineru-pdf.oss-cn-shanghai.aliyuncs.com）不会返回 CORS 头，
 * 浏览器 PUT/GET 触发 preflight 会挂，必须让 Worker 服务端到服务端转发一次。
 *
 * @param workerUrl 用户 Worker URL（如 https://xxx.workers.dev）
 * @param targetUrl MinerU 返回的预签名 URL
 * @returns 如 `https://xxx.workers.dev/proxy?url=<encoded>`
 * @throws 当 workerUrl 为空时抛错
 */
export function buildMineruProxyUrl(
  workerUrl: string | null | undefined,
  targetUrl: string,
): string {
  const trimmed = (workerUrl ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) {
    throw new MineruError(
      'MinerU 代理未配置。请前往 Settings → MinerU 代理，选择方案并部署你自己的透传代理（免费）。',
    )
  }
  return `${trimmed}${MINERU_PROXY_SUFFIX}?url=${encodeURIComponent(targetUrl)}`
}

// ============================================================================
// 错误类型
// ============================================================================

export class MineruError extends Error {
  providerMessage?: string
  constructor(message: string, providerMessage?: string) {
    super(message)
    this.name = 'MineruError'
    this.providerMessage = providerMessage
  }
}

export class MineruAuthError extends MineruError {
  constructor(providerMessage?: string) {
    super(
      'MinerU token 无效或已过期（HTTP 401）—— 请到 mineru.net/apiManage/token 重新生成',
      providerMessage,
    )
    this.name = 'MineruAuthError'
  }
}

export class MineruRateLimitError extends MineruError {
  constructor(providerMessage?: string) {
    super('MinerU 请求过于频繁（HTTP 429）—— 稍等后重试', providerMessage)
    this.name = 'MineruRateLimitError'
  }
}

export class MineruNetworkError extends MineruError {
  constructor(providerMessage?: string) {
    super('MinerU 网络错误 —— 检查网络或稍后重试', providerMessage)
    this.name = 'MineruNetworkError'
  }
}

export class MineruClientError extends MineruError {
  status: number
  constructor(status: number, providerMessage?: string) {
    super(`MinerU 请求失败 (HTTP ${status})`, providerMessage)
    this.status = status
    this.name = 'MineruClientError'
  }
}

/** 业务侧解析失败（不是请求失败）：state=failed/error */
export class MineruProcessingError extends MineruError {
  fileName: string
  state: string
  constructor(fileName: string, state: string, errMsg?: string) {
    super(
      `MinerU 解析失败：${fileName} (state=${state})${errMsg ? ` — ${errMsg}` : ''}`,
      errMsg,
    )
    this.fileName = fileName
    this.state = state
    this.name = 'MineruProcessingError'
  }
}

// ============================================================================
// 工具：错误分派
// ============================================================================

async function parseErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return `HTTP ${res.status}`
  try {
    const json = JSON.parse(text)
    const msg = json?.msg || json?.message || JSON.stringify(json)
    return typeof msg === 'string' ? msg : JSON.stringify(msg)
  } catch {
    return text.slice(0, 500)
  }
}

function throwHttpError(status: number, providerMsg: string): never {
  if (status === 401) throw new MineruAuthError(providerMsg)
  if (status === 429) throw new MineruRateLimitError(providerMsg)
  if (status >= 500) throw new MineruNetworkError(providerMsg)
  throw new MineruClientError(status, providerMsg)
}

// ============================================================================
// 步骤 1：申请上传 URL
// ============================================================================

export interface ApplyOptions {
  token: string
  /** 用户配置的 Worker URL（如 https://xxx.workers.dev），无尾斜杠 */
  workerUrl: string
  fileName: string
  isOcr?: boolean
  enableFormula?: boolean
  enableTable?: boolean
  language?: string
  pageRanges?: string
  modelVersion?: 'pipeline' | 'vlm'
}

export async function applyUploadUrls(opts: ApplyOptions): Promise<{
  batchId: string
  uploadUrl: string
}> {
  const baseUrl = buildMineruBaseUrl(opts.workerUrl)
  const body: MineruApplyRequest = {
    files: [
      {
        name: opts.fileName,
        is_ocr: opts.isOcr ?? false,
        ...(opts.pageRanges ? { page_ranges: opts.pageRanges } : {}),
      },
    ],
    model_version: opts.modelVersion ?? 'pipeline',
    enable_formula: opts.enableFormula ?? true,
    enable_table: opts.enableTable ?? true,
    language: opts.language ?? 'auto',
  }

  let res: Response
  try {
    res = await fetch(`${baseUrl}/file-urls/batch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new MineruNetworkError(err instanceof Error ? err.message : String(err))
  }

  if (!res.ok) {
    const providerMsg = await parseErrorBody(res)
    throwHttpError(res.status, providerMsg)
  }

  const data = (await res.json()) as MineruApplyResponse
  if (data.code !== 0) {
    throw new MineruClientError(res.status, `code=${data.code} msg=${data.msg}`)
  }
  const batchId = data.data?.batch_id
  const uploadUrl = data.data?.file_urls?.[0]
  if (!batchId || !uploadUrl) {
    throw new MineruClientError(
      res.status,
      `响应结构异常：batch_id=${batchId} file_urls[0]=${uploadUrl ? 'present' : 'missing'}`,
    )
  }
  return { batchId, uploadUrl }
}

// ============================================================================
// 步骤 2：上传文件到预签名 URL
// ============================================================================

/**
 * PUT 到 MinerU 提供的 OSS 预签名 URL（通过 Worker /proxy 白名单转发）。
 *
 * 官方要求**不带任何自定义 header**（含 Content-Type / Authorization），否则签名校验失败。
 * OSS 域名（*.aliyuncs.com）不返回 CORS 头，浏览器直连 PUT 会 preflight 挂，
 * 因此必须通过用户自持的 Worker /proxy 转发一次。
 */
export async function uploadFile(
  uploadUrl: string,
  file: Blob,
  workerUrl: string,
): Promise<void> {
  const proxied = buildMineruProxyUrl(workerUrl, uploadUrl)
  let res: Response
  try {
    res = await fetch(proxied, {
      method: 'PUT',
      body: file,
      // 关键：不加 headers；浏览器默认会带 Content-Type: application/octet-stream 或 blob 的 type
    })
  } catch (err) {
    throw new MineruNetworkError(err instanceof Error ? err.message : String(err))
  }
  if (!res.ok) {
    const providerMsg = await parseErrorBody(res)
    throwHttpError(res.status, providerMsg)
  }
}

// ============================================================================
// 步骤 3：轮询解析状态
// ============================================================================

export interface PollOptions {
  token: string
  /** 用户配置的 Worker URL（如 https://xxx.workers.dev），无尾斜杠 */
  workerUrl: string
  batchId: string
  /** 单个文件（本项目只跑 1 个） */
  fileName: string
  /** 轮询间隔（ms），默认 5s */
  intervalMs?: number
  /** 最大等待时间（ms），默认 15min（180 页大约 60-90s，留足冗余） */
  timeoutMs?: number
  /** 进度回调 */
  onProgress?: MineruProgressCallback
  /** 主动取消信号 */
  signal?: AbortSignal
}

export async function pollBatch(
  opts: PollOptions,
): Promise<MineruFileResult> {
  const baseUrl = buildMineruBaseUrl(opts.workerUrl)
  const interval = opts.intervalMs ?? 5000
  const timeout = opts.timeoutMs ?? 15 * 60 * 1000
  const t0 = Date.now()

  while (true) {
    if (opts.signal?.aborted) throw new Error('轮询被用户取消')
    if (Date.now() - t0 > timeout) {
      throw new MineruNetworkError(
        `轮询超时（${Math.floor(timeout / 60000)} 分钟未 done）`,
      )
    }

    let res: Response
    try {
      res = await fetch(
        `${baseUrl}/extract-results/batch/${opts.batchId}`,
        {
          headers: {
            Authorization: `Bearer ${opts.token}`,
            Accept: 'application/json',
          },
        },
      )
    } catch (err) {
      throw new MineruNetworkError(
        err instanceof Error ? err.message : String(err),
      )
    }

    if (!res.ok) {
      const providerMsg = await parseErrorBody(res)
      throwHttpError(res.status, providerMsg)
    }

    const payload = (await res.json()) as MineruBatchResult
    if (payload.code !== 0) {
      throw new MineruClientError(
        res.status,
        `code=${payload.code} msg=${payload.msg}`,
      )
    }

    const target =
      payload.data?.extract_result?.find(
        (r) => r.file_name === opts.fileName,
      ) ?? payload.data?.extract_result?.[0]

    if (!target) {
      throw new MineruClientError(res.status, '未找到目标文件的 extract_result')
    }

    // 进度回调
    opts.onProgress?.({
      stage: 'polling',
      message: `解析状态：${target.state}${
        target.extract_progress !== undefined
          ? `（${target.extract_progress}%）`
          : ''
      }`,
      at: Date.now(),
      batchId: opts.batchId,
      fileName: opts.fileName,
    })

    if (target.state === 'done') return target
    if (target.state === 'failed' || target.state === 'error') {
      throw new MineruProcessingError(
        target.file_name,
        target.state,
        target.err_msg,
      )
    }

    await new Promise((r) => setTimeout(r, interval))
  }
}

// ============================================================================
// 步骤 4：下载解析产物 zip
// ============================================================================

/**
 * 通过 Worker /proxy 白名单转发下载 MinerU 返回的 full_zip_url（OSS/CDN）。
 *
 * 直连也可能成功（简单 GET 请求不触发 preflight），但如果响应缺 CORS 头，
 * 浏览器仍会拒绝把 body 暴露给 JS。走 Worker 稳一点。
 */
export async function downloadZip(
  fullZipUrl: string,
  workerUrl: string,
): Promise<Blob> {
  const proxied = buildMineruProxyUrl(workerUrl, fullZipUrl)
  let res: Response
  try {
    res = await fetch(proxied, { method: 'GET' })
  } catch (err) {
    throw new MineruNetworkError(err instanceof Error ? err.message : String(err))
  }
  if (!res.ok) {
    const providerMsg = await parseErrorBody(res)
    throwHttpError(res.status, providerMsg)
  }
  return await res.blob()
}
