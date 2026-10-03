/**
 * 笔记附件转换入队（公共 helper）
 * ---------------------------------------------------
 * Word / PDF 附件 → 云端 note_convert 管线 → 一篇命名笔记（markdown）。
 * 与 bookPipeline 同构，差别只在进度/产物位置：
 *   - 进度落盘在 {base_path}/.progress.json（阅读对象目录下）
 *   - 产物是 {base_path}/notes/{note_name}.md + {base_path}/notes/images/
 *   - Word 先在 runner 里用 LibreOffice 转 PDF，再进 MinerU（PDF 直通）
 *
 * 真实进度链路：
 *   1. 前端上传源文件 → GitHub 私库 {base_path}/attachments/
 *   2. 前端 dispatchNoteConvert → 触发 GitHub Actions note_convert workflow
 *   3. 同时注册进 taskQueue → 后台监控面板立即可见
 *   4. runner 写 {base_path}/.progress.json → 前端轮询同步回 taskQueue
 *   5. runner 产出笔记 md + images，阅读页直接读
 *
 * 关键点：note_convert 由后端 Actions 驱动，前端 taskQueue 只是
 * "状态容器 + 可视化数据源"。
 */
import { toast } from 'sonner'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'
import { useTaskQueueStore, STAGE_META } from '../stores/taskQueue'
import { writeFileBatch, type BatchFileOp } from './github'
import { dispatchNoteConvert, getLatestRun } from './workflowClient'
import { docBasePath, attachmentsDir, type DocRef } from './readingDocData'

const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export interface EnqueueNoteResult {
  ok: boolean
  task_id?: string
  source_path?: string
  error?: string
}

/**
 * 把一个 Word / PDF 附件加入后端 note_convert 转换队列。
 * docRef 决定产物落在哪个阅读对象目录下；noteName 由调用方保证不与已有笔记重名。
 */
export async function enqueueNoteConvert(
  docRef: DocRef,
  file: File,
  noteName: string,
): Promise<EnqueueNoteResult> {
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

  if (file.size > MAX_ATTACHMENT_SIZE) {
    const msg = `附件过大：${(file.size / 1024 / 1024).toFixed(1)} MB > 100 MB GitHub 硬限。请裁剪后重试。`
    toast.error(msg)
    return { ok: false, error: msg }
  }

  const basePath = docBasePath(docRef)
  // 只清掉路径分隔符和空白，保留中文文件名
  const safeName = file.name.replace(/[/\\]+/g, '_').replace(/\s+/g, '_')
  const sourcePath = `${attachmentsDir(docRef)}/${Date.now()}_${safeName}`
  const taskId = `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const title = `${docRef.id} · ${noteName}`
  console.log('[notePipeline] uploading attachment →', sourcePath, `(${(file.size / 1024 / 1024).toFixed(2)} MB)`)

  try {
    const b64 = await fileToBase64(file)
    const ops: BatchFileOp[] = [{ path: sourcePath, content: b64, encoding: 'base64' }]
    await writeFileBatch(ops, `upload ${safeName} for note ${noteName}`, owner, repo, token)
  } catch (err: any) {
    const msg = `附件上传失败：${err?.message || String(err)}`
    toast.error(msg)
    return { ok: false, error: msg }
  }

  // ──── 注册进 taskQueue（后台监控面板立即出现 pending 任务） ────
  try {
    const tq = useTaskQueueStore.getState()
    const now = Date.now()
    await tq.add_task({
      id: taskId,
      type: 'note_convert',
      title,
      stage: 'queued',
      node_index: STAGE_META.queued.node,
      progress: 0,
      status: 'pending',
      message: '附件已上传，等待后端转换...',
      created_at: now,
      updated_at: now,
      metadata: {
        source_path: sourcePath,
        file_name: file.name,
        file_size: file.size,
        // slug 存 base_path：进度轮询按它拼 {base_path}/.progress.json
        slug: basePath,
        base_path: basePath,
        note_name: noteName,
        source: 'notePipeline',
      },
    })
  } catch (err: any) {
    console.warn('[notePipeline] taskQueue.add_task 失败（不阻塞 pipeline）:', err?.message)
  }

  try {
    // 记住 dispatch 前的 run 时间戳，用来识别这次产生的新 run
    const beforeRun = await getLatestRun('note_convert', owner, repo, token)
    const beforeCreatedAt = beforeRun?.created_at ?? new Date(Date.now() - 60_000).toISOString()

    await dispatchNoteConvert(basePath, noteName, sourcePath, owner, repo, token)

    // 轮询新 run 的 id（GitHub 索引有 1-2s 延迟），存进 metadata 供状态兜底
    let newRunId: number | null = null
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const rs = await getLatestRun('note_convert', owner, repo, token, beforeCreatedAt)
      if (rs) { newRunId = rs.id; break }
    }
    if (newRunId) {
      try {
        await useTaskQueueStore.getState().update_task(taskId, {
          metadata: {
            source_path: sourcePath,
            file_name: file.name,
            file_size: file.size,
            slug: basePath,
            base_path: basePath,
            note_name: noteName,
            source: 'notePipeline',
            id: newRunId,
          },
        })
      } catch { /* 不阻塞 */ }
    } else {
      console.warn('[notePipeline] 没找到新 run id，后续只能靠 progress.json / 产物兜底')
    }

    toast.success(`已提交后端转换：${noteName}`, {
      description: 'Word / PDF 正在转成 markdown 笔记，可在笔记面板看到进度',
    })
    return { ok: true, source_path: sourcePath, task_id: taskId }
  } catch (err: any) {
    const msg = `触发后端 pipeline 失败：${err?.message || String(err)}。请检查私库是否已安装 note_convert workflow（设置页可一键安装）。`
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
