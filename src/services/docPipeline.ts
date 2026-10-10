/**
 * 「其他文档」转换入队（公共 helper）
 * ---------------------------------------------------
 * 与 bookPipeline 同构，但跑的是 doc_convert 后端管线：
 *   支持 Word(.doc/.docx) 与 PDF —— Word 先由后端 LibreOffice headless 转 PDF，
 *   PDF 直通，再经 MinerU（超 200 页按 180 页 qpdf 切段）产出
 *   documents/{doc_id}/content.md + images/。前端不做任何转换。
 *
 * 真实进度链路：
 *   1. 前端上传源文件 → GitHub 私库 documents/{doc_id}/source/
 *   2. 前端 dispatchDocConvert → 触发 doc_convert workflow
 *   3. 同时注册进 taskQueue → 右侧 BackendMonitorPanel 立即可见
 *   4. runner 写 documents/{doc_id}/.progress.json → 前端轮询同步回 taskQueue
 *
 * 关键点：与文献 / 图书一致，doc_convert 由后端 Actions 驱动，前端 taskQueue
 * 只是「状态容器 + 可视化数据源」。
 */
import { toast } from 'sonner'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'
import { useTaskQueueStore, STAGE_META } from '../stores/taskQueue'
import { writeFileBatch, type BatchFileOp } from './github'
import { dispatchDocConvert, getLatestRun } from './workflowClient'

/** doc_convert 单文件硬限：与 book/paper 的 GitHub 上线保持一致 */
const MAX_SOURCE_SIZE = 100 * 1024 * 1024

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export interface EnqueueDocResult {
  ok: boolean
  task_id?: string
  source_path?: string
  error?: string
}

/**
 * 把一份「其他文档」的源文件加入后端 doc_convert 队列。
 * docId 就是 documents/ 下的目录名（= documentSlug(title)）。
 */
export async function enqueueDocConvert(
  docId: string,
  file: File,
  title: string,
): Promise<EnqueueDocResult> {
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

  if (file.size > MAX_SOURCE_SIZE) {
    const msg = `文件过大：${(file.size / 1024 / 1024).toFixed(1)} MB > 100 MB GitHub 硬限。请裁剪后重试。`
    toast.error(msg)
    return { ok: false, error: msg }
  }

  // 只清掉路径分隔符和空白，保留中文文件名
  const safeName = file.name.replace(/[/\\]+/g, '_').replace(/\s+/g, '_')
  const sourcePath = `documents/${docId}/source/${Date.now()}_${safeName}`
  const taskId = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  console.log('[docPipeline] uploading source →', sourcePath, `(${(file.size / 1024 / 1024).toFixed(2)} MB)`)

  try {
    const b64 = await fileToBase64(file)
    const ops: BatchFileOp[] = [{ path: sourcePath, content: b64, encoding: 'base64' }]
    await writeFileBatch(ops, `upload ${safeName} for document ${docId}`, owner, repo, token)
  } catch (err: any) {
    const msg = `源文件上传失败：${err?.message || String(err)}`
    toast.error(msg)
    return { ok: false, error: msg }
  }

  // ──── 注册进 taskQueue（右侧面板立即出现 pending 任务） ────
  try {
    const tq = useTaskQueueStore.getState()
    const now = Date.now()
    await tq.add_task({
      id: taskId,
      type: 'doc_convert',
      doi: undefined,
      book_id: undefined,
      title,
      stage: 'queued',
      node_index: STAGE_META.queued.node,
      progress: 0,
      status: 'pending',
      message: '源文件已上传，等待后端处理...',
      created_at: now,
      updated_at: now,
      error: undefined,
      metadata: {
        // slug 存 docId：进度轮询按它拼 documents/{slug}/.progress.json
        slug: docId,
        source_github_path: sourcePath,
        file_name: file.name,
        file_size: file.size,
        source: 'docPipeline',
      },
    })
  } catch (err: any) {
    console.warn('[docPipeline] taskQueue.add_task 失败（不阻塞 pipeline）:', err?.message)
  }

  try {
    const beforeRun = await getLatestRun('doc_convert', owner, repo, token)
    const beforeCreatedAt = beforeRun?.created_at ?? new Date(Date.now() - 60_000).toISOString()

    await dispatchDocConvert(docId, title || docId, sourcePath, owner, repo, token)

    let newRunId: number | null = null
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const rs = await getLatestRun('doc_convert', owner, repo, token, beforeCreatedAt)
      if (rs) { newRunId = rs.id; break }
    }
    if (newRunId) {
      try {
        await useTaskQueueStore.getState().update_task(taskId, { metadata: { id: newRunId } })
      } catch { /* 不阻塞 */ }
    } else {
      console.warn('[docPipeline] 没找到新 run id，后续只能靠 progress.json')
    }

    return { ok: true, source_path: sourcePath, task_id: taskId }
  } catch (err: any) {
    const msg = `触发后端 pipeline 失败：${err?.message || String(err)}。请检查私库是否已安装 doc_convert workflow。`
    toast.error(msg)
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
