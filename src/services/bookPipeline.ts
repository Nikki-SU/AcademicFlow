/**
 * 图书转换入队（公共 helper）
 * ---------------------------------------------------
 * 与 paperPipeline 同构，但**图书只走 MinerU**：
 *   文献那条线的 AI-1 清理 / AI-1 打标 / 编号 / 逐段翻译 / 提词，图书一概不需要。
 *
 * 真实进度链路：
 *   1. 前端上传 PDF → GitHub 私库 textbooks/{书名}/source/
 *   2. 前端 dispatchBookConvert → 触发 GitHub Actions book_convert workflow
 *   3. 同时注册进 taskQueue → 右侧 BackendMonitorPanel 立即可见
 *   4. runner 写 textbooks/{书名}/.progress.json → 前端轮询同步回 taskQueue
 *   5. runner 产出 textbooks/{书名}/content.md + images/，阅读页直接读
 *
 * 关键点：和文献一样，book_convert 由后端 Actions 驱动，前端 taskQueue 只是
 * "状态容器 + 可视化数据源"。
 */
import { toast } from 'sonner'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'
import { useTaskQueueStore, STAGE_META } from '../stores/taskQueue'
import { writeFileBatch, type BatchFileOp } from './github'
import { dispatchBookConvert, getLatestRun } from './workflowClient'

const MAX_PDF_SIZE = 100 * 1024 * 1024

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export interface EnqueueBookResult {
  ok: boolean
  task_id?: string
  pdf_path?: string
  error?: string
}

/**
 * 把一本图书的 PDF 加入后端 Actions 转换队列。
 * bookId 就是书名（= textbooks/ 下的目录名）。
 */
export async function enqueueBookMineruConvert(
  bookId: string,
  file: File,
  title: string,
): Promise<EnqueueBookResult> {
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

  // 只清掉路径分隔符和空白，保留中文文件名（书名本来就可能是中文）
  const safeName = file.name.replace(/[/\\]+/g, '_').replace(/\s+/g, '_')
  const pdfPath = `textbooks/${bookId}/source/${Date.now()}_${safeName}`
  const taskId = `book_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  console.log('[bookPipeline] uploading PDF →', pdfPath, `(${(file.size / 1024 / 1024).toFixed(2)} MB)`)

  try {
    const b64 = await fileToBase64(file)
    const ops: BatchFileOp[] = [{ path: pdfPath, content: b64, encoding: 'base64' }]
    await writeFileBatch(ops, `upload ${safeName} for book ${bookId}`, owner, repo, token)
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
      type: 'book_convert',
      doi: undefined,
      book_id: bookId,
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
        // slug 存书名：进度轮询按它拼 textbooks/{slug}/.progress.json
        slug: bookId,
        source: 'bookPipeline',
      },
    })
  } catch (err: any) {
    console.warn('[bookPipeline] taskQueue.add_task 失败（不阻塞 pipeline）:', err?.message)
  }

  try {
    // 记住 dispatch 前的 run 时间戳，用来识别这次产生的新 run
    const beforeRun = await getLatestRun('book_convert', owner, repo, token)
    const beforeCreatedAt = beforeRun?.created_at ?? new Date(Date.now() - 60_000).toISOString()

    await dispatchBookConvert(bookId, title || bookId, pdfPath, owner, repo, token)

    // 轮询新 run 的 id（GitHub 索引有 1-2s 延迟），存进 metadata 供状态兜底
    let newRunId: number | null = null
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const rs = await getLatestRun('book_convert', owner, repo, token, beforeCreatedAt)
      if (rs) { newRunId = rs.id; break }
    }
    if (newRunId) {
      try {
        await useTaskQueueStore.getState().update_task(taskId, {
          metadata: {
            pdf_github_path: pdfPath,
            file_name: file.name,
            file_size: file.size,
            slug: bookId,
            source: 'bookPipeline',
            id: newRunId,
          },
        })
      } catch { /* 不阻塞 */ }
    } else {
      console.warn('[bookPipeline] 没找到新 run id，后续只能靠 progress.json')
    }

    toast.success(`已提交后端转换：${title || bookId}`, {
      description: '右侧后台监控面板可查看实时进度',
    })
    return { ok: true, pdf_path: pdfPath, task_id: taskId }
  } catch (err: any) {
    const msg = `触发后端 pipeline 失败：${err?.message || String(err)}。请检查私库是否已安装 book_convert workflow（设置页可一键安装）。`
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
