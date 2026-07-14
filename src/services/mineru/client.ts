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
 * 单文件硬约束：≤200MB 且 ≤200 页（官方 2026-07 更新，原 600 页已降为 200 页）
 * 每日优先级额度：1000 页（原 2000 页已降为 1000 页）
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
  MineruDebugCallback,
  MineruDebugEvent,
  MineruFileResult,
  MineruProgressCallback,
} from '../../types'

export const MINERU_API_SUFFIX = '/api/v4'
export const MINERU_PROXY_SUFFIX = '/proxy'

// ============================================================================
// 调试打点 helper（M3.6.3-b）
// ============================================================================
// 独立于业务流，把每个 fetch 的 method/url/status/耗时/错误细节挂出去。
// 上层组件（如 MineruTestPanel）在 debugMode 开启时消费此流并渲染 Debug Console。

function emitDebug(
  cb: MineruDebugCallback | undefined,
  ev: Omit<MineruDebugEvent, 'at'>,
): void {
  cb?.({ ...ev, at: Date.now() })
}

/** 截取 body / 错误消息片段（避免超长 blob 塞爆内存），最多 500 字符 */
function snippet(v: unknown, max = 500): string {
  if (v === undefined || v === null) return ''
  const s = typeof v === 'string' ? v : safeStringify(v)
  return s.length > max ? s.slice(0, max) + `…(${s.length - max} more)` : s
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * 构造 MinerU API 的 baseUrl。
 * MinerU 服务端不返回 CORS 头，浏览器直连会 preflight 405，
 * 因此必须走用户自持的 Deno Deploy 透传代理。
 *
 * @param workerUrl 用户在 Settings 里配置的 deno.net URL（如 https://xxx.deno.net）
 *                  尾斜杠会自动清理
 * @returns 如 `https://xxx.deno.net/api/v4`
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
  /** M3.6.3-b：底层 debug 事件回调（可选，仅在 debugMode 开启时挂上） */
  onDebug?: MineruDebugCallback
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

  const url = `${baseUrl}/file-urls/batch`
  const t0 = Date.now()
  emitDebug(opts.onDebug, {
    kind: 'request',
    phase: 'applying',
    method: 'POST',
    url,
    detail: snippet(body),
  })

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    emitDebug(opts.onDebug, {
      kind: 'error',
      phase: 'applying',
      method: 'POST',
      url,
      durationMs: Date.now() - t0,
      errorName: err instanceof Error ? err.name : 'Unknown',
      detail: msg,
    })
    throw new MineruNetworkError(msg)
  }

  emitDebug(opts.onDebug, {
    kind: 'response',
    phase: 'applying',
    method: 'POST',
    url,
    status: res.status,
    durationMs: Date.now() - t0,
  })

  if (!res.ok) {
    const providerMsg = await parseErrorBody(res)
    emitDebug(opts.onDebug, {
      kind: 'error',
      phase: 'applying',
      method: 'POST',
      url,
      status: res.status,
      detail: providerMsg,
    })
    throwHttpError(res.status, providerMsg)
  }

  const data = (await res.json()) as MineruApplyResponse
  if (data.code !== 0) {
    emitDebug(opts.onDebug, {
      kind: 'error',
      phase: 'applying',
      detail: `code=${data.code} msg=${data.msg}`,
    })
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
  emitDebug(opts.onDebug, {
    kind: 'info',
    phase: 'applying',
    detail: `batch_id=${batchId}  upload_url_host=${new URL(uploadUrl).host}`,
  })
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
  onDebug?: MineruDebugCallback,
): Promise<void> {
  const proxied = buildMineruProxyUrl(workerUrl, uploadUrl)
  const t0 = Date.now()
  emitDebug(onDebug, {
    kind: 'request',
    phase: 'uploading',
    method: 'PUT',
    url: proxied,
    detail: `file size=${(file.size / 1024 / 1024).toFixed(2)}MB  target_host=${new URL(uploadUrl).host}`,
  })

  let res: Response
  try {
    res = await fetch(proxied, {
      method: 'PUT',
      body: file,
      // 官方要求不带任何自定义 header（含 Content-Type）。
      // 但浏览器会自动为 Blob 添加 Content-Type，可能导致 OSS 签名校验失败。
      // Worker 代理侧需要剥离 Content-Type 后再转发到 OSS。
      // 如果仍然失败，可尝试用 ArrayBuffer + 手动覆盖：
      //   new ArrayBuffer(file.size) 不会自动带 Content-Type
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    emitDebug(onDebug, {
      kind: 'error',
      phase: 'uploading',
      method: 'PUT',
      url: proxied,
      durationMs: Date.now() - t0,
      errorName: err instanceof Error ? err.name : 'Unknown',
      detail: msg,
    })
    throw new MineruNetworkError(msg)
  }

  emitDebug(onDebug, {
    kind: 'response',
    phase: 'uploading',
    method: 'PUT',
    url: proxied,
    status: res.status,
    durationMs: Date.now() - t0,
  })
  // v7 增强（M3.7-a）：把 worker 端 4 个 X-AF-Worker-* header 直接打到 Debug Console，
  // 不用 Rosa 去 F12 Network 找。Access-Control-Expose-Headers: * 已设（worker corsHeaders），
  // 浏览器允许前端 JS 读。这层不依赖 fetch 默认行为（v6 推的时候**应该**做这个，漏了）。
  emitDebug(onDebug, {
    kind: 'info',
    phase: 'uploading',
    detail: `af-worker-url-in=${res.headers.get('x-af-worker-url-in') ?? '(missing)'}`,
  })
  emitDebug(onDebug, {
    kind: 'info',
    phase: 'uploading',
    detail: `af-worker-url-out=${res.headers.get('x-af-worker-url-out') ?? '(missing)'}`,
  })
  emitDebug(onDebug, {
    kind: 'info',
    phase: 'uploading',
    detail: `af-worker-status=${res.headers.get('x-af-worker-status') ?? '(missing)'}`,
  })
  emitDebug(onDebug, {
    kind: 'info',
    phase: 'uploading',
    detail: `af-worker-content-type=${res.headers.get('x-af-worker-content-type') ?? '(missing)'}`,
  })

  if (!res.ok) {
    const providerMsg = await parseErrorBody(res)
    emitDebug(onDebug, {
      kind: 'error',
      phase: 'uploading',
      status: res.status,
      detail: providerMsg,
    })
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
  /** M3.6.3-b：底层 debug 事件回调 */
  onDebug?: MineruDebugCallback
}

export async function pollBatch(
  opts: PollOptions,
): Promise<MineruFileResult> {
  const baseUrl = buildMineruBaseUrl(opts.workerUrl)
  const interval = opts.intervalMs ?? 5000
  const timeout = opts.timeoutMs ?? 15 * 60 * 1000
  const t0 = Date.now()
  const pollUrl = `${baseUrl}/extract-results/batch/${opts.batchId}`
  let pollCount = 0

  emitDebug(opts.onDebug, {
    kind: 'info',
    phase: 'polling',
    detail: `start polling  batchId=${opts.batchId}  interval=${interval}ms  timeout=${timeout}ms`,
  })

  while (true) {
    if (opts.signal?.aborted) throw new Error('轮询被用户取消')
    if (Date.now() - t0 > timeout) {
      emitDebug(opts.onDebug, {
        kind: 'error',
        phase: 'polling',
        detail: `polling timeout after ${pollCount} attempts  batchId=${opts.batchId}`,
      })
      throw new MineruNetworkError(
        `轮询超时（${Math.floor(timeout / 60000)} 分钟未 done）`,
      )
    }

    pollCount += 1
    const tReq = Date.now()
    emitDebug(opts.onDebug, {
      kind: 'request',
      phase: 'polling',
      method: 'GET',
      url: pollUrl,
      detail: `poll #${pollCount}`,
    })

    let res: Response
    try {
      res = await fetch(pollUrl, {
        headers: {
          Authorization: `Bearer ${opts.token}`,
          Accept: 'application/json',
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitDebug(opts.onDebug, {
        kind: 'error',
        phase: 'polling',
        method: 'GET',
        url: pollUrl,
        durationMs: Date.now() - tReq,
        errorName: err instanceof Error ? err.name : 'Unknown',
        detail: `poll #${pollCount} fetch rejected: ${msg}`,
      })
      throw new MineruNetworkError(msg)
    }

    emitDebug(opts.onDebug, {
      kind: 'response',
      phase: 'polling',
      method: 'GET',
      url: pollUrl,
      status: res.status,
      durationMs: Date.now() - tReq,
      detail: `poll #${pollCount}`,
    })

    if (!res.ok) {
      const providerMsg = await parseErrorBody(res)
      emitDebug(opts.onDebug, {
        kind: 'error',
        phase: 'polling',
        status: res.status,
        detail: `poll #${pollCount}  ${providerMsg}`,
      })
      throwHttpError(res.status, providerMsg)
    }

    const payload = (await res.json()) as MineruBatchResult
    if (payload.code !== 0) {
      emitDebug(opts.onDebug, {
        kind: 'error',
        phase: 'polling',
        detail: `poll #${pollCount}  code=${payload.code} msg=${payload.msg}`,
      })
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

    emitDebug(opts.onDebug, {
      kind: 'info',
      phase: 'polling',
      detail: `poll #${pollCount}  state=${target.state}${
        target.extract_progress !== undefined
          ? `  progress=${target.extract_progress}%`
          : ''
      }${target.full_zip_url ? `  zip_ready=true` : ''}`,
    })

    if (target.state === 'done') return target
    if (target.state === 'failed' || target.state === 'error') {
      emitDebug(opts.onDebug, {
        kind: 'error',
        phase: 'polling',
        errorName: 'MineruProcessingError',
        detail: `state=${target.state}  err_msg=${target.err_msg ?? '(none)'}`,
      })
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
  onDebug?: MineruDebugCallback,
): Promise<Blob> {
  const proxied = buildMineruProxyUrl(workerUrl, fullZipUrl)
  const t0 = Date.now()
  emitDebug(onDebug, {
    kind: 'request',
    phase: 'downloading',
    method: 'GET',
    url: proxied,
    detail: `target_host=${new URL(fullZipUrl).host}`,
  })

  let res: Response
  try {
    res = await fetch(proxied, { method: 'GET' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    emitDebug(onDebug, {
      kind: 'error',
      phase: 'downloading',
      method: 'GET',
      url: proxied,
      durationMs: Date.now() - t0,
      errorName: err instanceof Error ? err.name : 'Unknown',
      detail: msg,
    })
    throw new MineruNetworkError(msg)
  }

  emitDebug(onDebug, {
    kind: 'response',
    phase: 'downloading',
    method: 'GET',
    url: proxied,
    status: res.status,
    durationMs: Date.now() - t0,
    detail: `content-length=${res.headers.get('content-length') ?? '(unknown)'}`,
  })

  if (!res.ok) {
    const providerMsg = await parseErrorBody(res)
    emitDebug(onDebug, {
      kind: 'error',
      phase: 'downloading',
      status: res.status,
      detail: providerMsg,
    })
    throwHttpError(res.status, providerMsg)
  }
  const blob = await res.blob()
  emitDebug(onDebug, {
    kind: 'info',
    phase: 'downloading',
    detail: `blob size=${(blob.size / 1024 / 1024).toFixed(2)}MB  total_ms=${Date.now() - t0}`,
  })
  return blob
}
