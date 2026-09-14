/**
 * 文献转换入队（公共 helper）
 * ---------------------------------------------------
 * 真实进度链路：
 *   1. 前端上传 PDF → GitHub 仓库 literatures/{slug}/source/
 *   2. 前端 dispatchPipeline → 触发 GitHub Actions
 *   3. **同时注册进 taskQueue** → 右侧 BackendMonitorPanel 立即可见
 *   4. GitHub Actions 写 .progress.json → 前端轮询同步回 taskQueue
 *   5. 右侧面板随 taskQueue 实时更新（四节点进度条 + stage + 耗时）
 *
 * 关键点：paper_convert 任务由后端 Actions 驱动，不是前端 executor 驱动。
 * taskQueue 在这里只是"状态容器 + 可视化数据源"，后端 Actions 才是真正的执行者。
 */
import { toast } from 'sonner'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'
import { useTaskQueueStore, STAGE_META } from '../stores/taskQueue'
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

/** 生成唯一 task id（供 taskQueue 使用） */
function makeTaskId(doi: string): string {
  const slug = doiToSlug(doi)
  return `paper_${slug}_${Date.now()}`
}

export interface EnqueuePaperResult {
  task_id?: string
  ok: boolean
  pdf_path?: string
  error?: string
}

/**
 * 把某篇 paper 的 PDF 加入后端 Actions 转换队列
 *
 * 同时把任务注册进 taskQueue（不传 File —— PDF 已由本函数自己上传过，
 * 路径写进 metadata.pdf_github_path，避免 taskQueue 重复上传）。
 */
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
  const taskId = makeTaskId(paperDoi)
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

  // ──── 注册进 taskQueue（右侧面板立即出现 pending 任务） ────
  try {
    const tq = useTaskQueueStore.getState()
    const now = Date.now()
    await tq.add_task({
      id: taskId,
      type: 'paper_convert',
      doi: paperDoi,
      book_id: undefined,
      title,
      stage: 'queued',
      node_index: STAGE_META.queued.node,
      progress: 0,
      status: 'pending',
      message: 'PDF 已上传，等待后端处理...',
      created_at: now,
      updated_at: now,
      error: undefined,
      metadata: {
        pdf_github_path: pdfPath,
        file_name: file.name,
        file_size: file.size,
        slug,
        source: 'paperPipeline',
      },
    })
    console.log('[paperPipeline] taskQueue 已注册:', taskId)
  } catch (err: any) {
    console.warn('[paperPipeline] taskQueue.add_task 失败（不阻塞 pipeline）:', err?.message)
  }

  try {
    await dispatchPipeline(paperDoi, title || slug, pdfPath, owner, repo, token)
    toast.success('已提交后端处理', {
      description: '右侧后台监控面板可查看实时进度',
    })
    return { ok: true, pdf_path: pdfPath, task_id: taskId }
  } catch (err: any) {
    const msg = `触发后端 pipeline 失败：${err?.message || String(err)}。请检查 GitHub Actions 是否启用。`
    toast.error(msg)
    // 任务已在 taskQueue 里注册了，但后端没触发 —— 标记 failed 让用户看到
    try {
      await useTaskQueueStore.getState().update_task(taskId, {
        status: 'failed',
        stage: 'failed',
        node_index: STAGE_META.failed.node,
        message: `触发后端失败：${msg}`,
        error: msg,
      })
    } catch {}
    return { ok: false, error: msg, task_id: taskId }
  }
}
