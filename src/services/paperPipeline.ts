/**
 * 文献转换入队（公共 helper）
 * ---------------------------------------------------
 * 后端架构改造后：前端只做 blob 上传 + dispatch，后端 Actions pipeline 处理。
 *
 * 流程：
 *   1. 校验 PDF size ≤ 100MB
 *   2. PDF 转 base64 → writeFileBatch blob 上传到 literatures/{slug}/source/{ts}_{name}
 *   3. dispatchPipeline 触发 GitHub Actions
 *   4. 前端轮询 progress.json（调用方自己做）
 */
import { toast } from 'sonner'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'
import { doiToSlug } from './literatureData'
import { writeFileBatch, type BatchFileOp } from './github'
import { dispatchPipeline } from './workflowClient'

const MAX_PDF_SIZE = 100 * 1024 * 1024

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export interface EnqueuePaperResult {
  ok: boolean
  pdf_path?: string
  error?: string
}

/** 把某篇 paper 的 PDF 加入后端 Actions 转换队列 */
export async function enqueuePaperMineruConvert(
  paperDoi: string,
  file: File,
  title: string,
): Promise<EnqueuePaperResult> {
  const auth = useAuthStore.getState()
  const ws = useWorkspaceStore.getState()
  const owner = auth.user?.login
  const repo = ws.repo?.name
  const token = auth.token
  if (!owner || !repo || !token) {
    const msg = '未登录或私库未配置，请先完成设置'
    toast.error(msg)
    return { ok: false, error: msg }
  }

  if (file.size > MAX_PDF_SIZE) {
    const msg = `PDF 过大：${(file.size / 1024 / 1024).toFixed(1)} MB > 100 MB GitHub 硬限。请裁剪后重试。`
    toast.error(msg)
    return { ok: false, error: msg }
  }

  const slug = doiToSlug(paperDoi)
  const ts = Date.now()
  const safeName = file.name.replace(/[^\w.\-]+/g, '_')
  const pdfPath = `literatures/${slug}/source/${ts}_${safeName}`
  console.log('[paperPipeline] uploading PDF →', pdfPath, `(${(file.size / 1024 / 1024).toFixed(2)} MB)`)

  try {
    const b64 = await fileToBase64(file)
    const ops: BatchFileOp[] = [{ path: pdfPath, content: b64, encoding: 'base64' }]
    await writeFileBatch(ops, `upload ${safeName} for ${slug}`, owner, repo, token)
  } catch (err: any) {
    const msg = `PDF 上传失败：${err?.message || String(err)}`
    toast.error(msg)
    return { ok: false, error: msg }
  }

  try {
    await dispatchPipeline(paperDoi, title || slug, pdfPath, owner, repo, token)
  } catch (err: any) {
    const msg = `触发后端 pipeline 失败：${err?.message || String(err)}。请检查 GitHub Actions 是否启用。`
    toast.error(msg)
    return { ok: false, error: msg }
  }

  toast.success('已提交后端处理', { description: 'GitHub Actions 正在运行，进度将自动更新...' })
  return { ok: true, pdf_path: pdfPath }
}
