/**
 * MinerU 全流程编排（M3.7 单文件测试用例）
 * -------------------------------------------------
 * 组合 client.ts 的 4 步 + extract.ts 解压，暴露一个 runMineruSingleFile 高阶函数
 * 供 MineruTestPanel 直接调用。
 *
 * 本模块只做单文件（≤180 页）流程。多文件分片/合并留到 Import 阶段。
 */
import type {
  MineruProgressCallback,
  MineruStage,
  MineruTestResult,
} from '../../types'
import {
  applyUploadUrls,
  downloadZip,
  pollBatch,
  uploadFile,
} from './client'
import { extractZip } from './extract'

export interface RunMineruSingleFileOptions {
  token: string
  /**
   * 用户配置的 Cloudflare Worker URL（如 https://xxx.workers.dev）
   * MinerU 官方 API 无 CORS，浏览器直连不通，必须走用户自持的透传代理。
   */
  workerUrl: string
  file: File
  /** 组件订阅进度事件 */
  onProgress?: MineruProgressCallback
  /** 主动取消 */
  signal?: AbortSignal
  /** 是否强制 OCR（默认 false，正常 PDF 不用） */
  isOcr?: boolean
  /** 是否解析公式 / 表格（默认都 true） */
  enableFormula?: boolean
  enableTable?: boolean
  /** 语言提示 auto / ch / en */
  language?: string
  /** 模型版本，默认 pipeline */
  modelVersion?: 'pipeline' | 'vlm'
}

/** 内部：发进度事件 + 记时间戳（用于结果里的 timing 分布） */
function emitStage(
  cb: MineruProgressCallback | undefined,
  stage: MineruStage,
  message: string,
  extra?: { batchId?: string; fileName?: string },
): number {
  const at = Date.now()
  cb?.({ stage, message, at, ...extra })
  return at
}

export async function runMineruSingleFile(
  opts: RunMineruSingleFileOptions,
): Promise<MineruTestResult> {
  const { token, file, workerUrl, onProgress, signal } = opts
  if (!token.trim()) throw new Error('MinerU token 为空')
  if (!workerUrl.trim()) {
    throw new Error(
      'MinerU 代理未配置，请到 Settings → MinerU 代理，选择方案并部署你自己的透传代理（免费）',
    )
  }
  if (!file) throw new Error('未选择 PDF 文件')
  if (!/\.pdf$/i.test(file.name)) {
    throw new Error(`只支持 PDF 输入，收到：${file.name}`)
  }

  const timing: Partial<Record<MineruStage, number>> = {}
  const t0 = Date.now()

  // ---- Stage 1: 申请上传 URL ----
  const t1 = emitStage(
    onProgress,
    'applying',
    `申请上传 URL：${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB)`,
  )
  const { batchId, uploadUrl } = await applyUploadUrls({
    token,
    workerUrl,
    fileName: file.name,
    isOcr: opts.isOcr,
    enableFormula: opts.enableFormula,
    enableTable: opts.enableTable,
    language: opts.language,
    modelVersion: opts.modelVersion,
  })
  timing.applying = Date.now() - t1
  if (signal?.aborted) throw new Error('已取消')

  // ---- Stage 2: 上传文件 ----
  const t2 = emitStage(
    onProgress,
    'uploading',
    `上传 PDF 到 OSS...`,
    { batchId, fileName: file.name },
  )
  await uploadFile(uploadUrl, file, workerUrl)
  timing.uploading = Date.now() - t2
  if (signal?.aborted) throw new Error('已取消')

  // ---- Stage 3: 轮询解析状态 ----
  const t3 = emitStage(
    onProgress,
    'polling',
    '等待 MinerU 解析队列...',
    { batchId, fileName: file.name },
  )
  const fileResult = await pollBatch({
    token,
    workerUrl,
    batchId,
    fileName: file.name,
    onProgress,
    signal,
  })
  timing.polling = Date.now() - t3
  if (!fileResult.full_zip_url) {
    throw new Error('解析已 done 但未返回 full_zip_url')
  }

  // ---- Stage 4: 下载 zip ----
  const t4 = emitStage(
    onProgress,
    'downloading',
    '下载解析产物 zip...',
    { batchId, fileName: file.name },
  )
  const zipBlob = await downloadZip(fileResult.full_zip_url, workerUrl)
  timing.downloading = Date.now() - t4

  // ---- Stage 5: 解压 & 交叉验证 ----
  const t5 = emitStage(
    onProgress,
    'extracting',
    `解压 ${(zipBlob.size / 1024 / 1024).toFixed(2)}MB zip...`,
    { batchId, fileName: file.name },
  )
  const extracted = await extractZip(zipBlob)
  timing.extracting = Date.now() - t5

  const totalMs = Date.now() - t0
  emitStage(
    onProgress,
    'done',
    `全流程完成：markdown ${(extracted.markdown.length / 1024).toFixed(1)}KB，` +
      `图片 ${Object.keys(extracted.images).length} 张，` +
      `总耗时 ${(totalMs / 1000).toFixed(1)}s`,
    { batchId, fileName: file.name },
  )

  return {
    batchId,
    fileName: file.name,
    timing,
    markdown: extracted.markdown,
    images: extracted.images,
    missingImages: extracted.missingImages,
    orphanImages: extracted.orphanImages,
  }
}
