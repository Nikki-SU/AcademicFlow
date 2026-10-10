/**
 * 文献转换入队（公共 helper）
 * ---------------------------------------------------
 * 真实进度链路：
 *   1. 前端上传 PDF → GitHub 仓库 literatures/{slug}/source/
 *   2. 前端 dispatchPaperConvert → 触发 GitHub Actions
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
import { dispatchPaperConvert, dispatchPaperConvertBatch, getLatestRun } from './workflowClient'

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
    // 先记住 dispatch 前 Paper Pipeline 最新 run 的时间戳，用来识别这次 dispatch 产生的新 run
    const beforeRun = await getLatestRun('paper_convert', owner, repo, token)
    const beforeCreatedAt = beforeRun?.created_at ?? new Date(Date.now() - 60_000).toISOString()

    await dispatchPaperConvert(paperDoi, title || slug, pdfPath, owner, repo, token)

    // poll 到新 run 的 id（GitHub 索引延迟 ~1-2s），存进 metadata 供后续 run 状态兜底
    let newRunId: number | null = null
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const rs = await getLatestRun('paper_convert', owner, repo, token, beforeCreatedAt)
      if (rs) { newRunId = rs.id; break }
    }
    if (newRunId) console.log('[paperPipeline] 新 id: ', newRunId)
    else console.warn('[paperPipeline] 没找到新 id，后续只能靠 progress.json')

    // 更新 task metadata，加上 id
    if (newRunId) {
      try {
        await useTaskQueueStore.getState().update_task(taskId, {
          metadata: {
            pdf_github_path: pdfPath,
            file_name: file.name,
            file_size: file.size,
            slug,
            source: 'paperPipeline',
            id: newRunId,
          },
        })
      } catch { /* 不阻塞 */ }
    }

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

export interface EnqueuePaperItem {
  doi: string
  title: string
  file: File
}

/** 单篇的入队结果；results 与传入 items 顺序一一对应 */
export interface EnqueuePaperItemResult {
  ok: boolean
  doi: string
  pdf_path?: string
  task_id?: string
  error?: string
}

export interface EnqueuePaperBatchResult {
  ok: boolean
  results: EnqueuePaperItemResult[]
  error?: string
}

/**
 * 把一批文献 PDF 加入后端 paper_convert 转换队列。
 * 所有 PDF 一次上传、一次 dispatch（runner 内按 PAPER_CONCURRENCY 并发跑）。
 *
 * 为什么批量：GitHub concurrency group「pipeline-write-main」只保留 1 running + 1 pending，
 * 逐篇 dispatch 会在几秒内连发 N 个 run，后到的顶掉前一个 pending 的（cancelled）。
 * 合并成一次 = 一个 run。
 */
export async function enqueuePaperMineruConvertBatch(
  items: EnqueuePaperItem[],
): Promise<EnqueuePaperBatchResult> {
  const results: EnqueuePaperItemResult[] = items.map((it) => ({ ok: false, doi: it.doi }))
  if (items.length === 0) return { ok: true, results }

  const auth = useAuthStore.getState()
  const ws = useWorkspaceStore.getState()
  const owner = auth.user?.login
  const repo = ws.repo?.name
  const token = auth.token
  if (!owner || !repo || !token) {
    const msg = '未登录或私库未配置，请先完成设置'
    toast.error(msg)
    results.forEach((r) => { r.error = msg })
    return { ok: false, results, error: msg }
  }

  const stamp = Date.now()

  // 先逐篇过一遍约束：超大 PDF 直接判失败，不拖累其余篇
  const valid: { idx: number; doi: string; title: string; file: File; slug: string; pdfPath: string; taskId: string }[] = []
  items.forEach((it, idx) => {
    if (it.file.size > MAX_PDF_SIZE) {
      const msg = `PDF 过大：${(it.file.size / 1024 / 1024).toFixed(1)} MB > 100 MB GitHub 硬限。请裁剪后重试。`
      toast.error(`${it.file.name}：${msg}`)
      results[idx].error = msg
      return
    }
    const slug = doiToSlug(it.doi)
    const safeName = it.file.name.replace(/[^\w.\-]+/g, '_')
    valid.push({
      idx,
      doi: it.doi,
      title: it.title,
      file: it.file,
      slug,
      pdfPath: `literatures/${slug}/source/${stamp}_${idx}_${safeName}`,
      taskId: `paper_${slug}_${stamp}_${idx}`,
    })
  })
  if (valid.length === 0) return { ok: false, results }

  // ──── 1. 所有 PDF 一次上传（一次 commit） ────
  try {
    const ops: BatchFileOp[] = []
    for (const v of valid) {
      const b64 = await fileToBase64(v.file)
      ops.push({ path: v.pdfPath, content: b64, encoding: 'base64' })
    }
    const msg = valid.length === 1
      ? `upload ${valid[0].file.name} for ${valid[0].slug}`
      : `upload ${valid.length} PDFs for papers`
    await writeFileBatch(ops, msg, owner, repo, token)
  } catch (err: any) {
    const msg = `PDF 上传失败：${err?.message || String(err)}`
    toast.error(msg)
    valid.forEach((v) => {
      results[v.idx].error = msg
      results[v.idx].task_id = v.taskId
    })
    return { ok: false, results, error: msg }
  }

  // ──── 2. 逐篇注册一个 taskQueue 任务（右侧面板逐篇可见） ────
  for (const v of valid) {
    try {
      const tq = useTaskQueueStore.getState()
      const now = Date.now()
      await tq.add_task({
        id: v.taskId,
        type: 'paper_convert',
        doi: v.doi,
        book_id: undefined,
        title: v.title || v.slug,
        stage: 'queued',
        node_index: STAGE_META.queued.node,
        progress: 0,
        status: 'pending',
        message: 'PDF 已上传，等待后端处理...',
        created_at: now,
        updated_at: now,
        error: undefined,
        metadata: {
          pdf_github_path: v.pdfPath,
          file_name: v.file.name,
          file_size: v.file.size,
          slug: v.slug,
          source: 'paperPipeline',
        },
      })
    } catch (err: any) {
      console.warn('[paperPipeline] taskQueue.add_task 失败（不阻塞 pipeline）:', err?.message)
    }
  }

  // ──── 3. 一次 dispatch 触发后端（所有篇同一个 run） ────
  try {
    const beforeRun = await getLatestRun('paper_convert', owner, repo, token)
    const beforeCreatedAt = beforeRun?.created_at ?? new Date(Date.now() - 60_000).toISOString()

    await dispatchPaperConvertBatch(
      valid.map((v) => ({ doi: v.doi, title: v.title || v.slug, pdfPath: v.pdfPath })),
      owner, repo, token,
    )

    // 轮询新 run 的 id（GitHub 索引有 1-2s 延迟），存进每篇 metadata 供状态兜底
    let newRunId: number | null = null
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const rs = await getLatestRun('paper_convert', owner, repo, token, beforeCreatedAt)
      if (rs) { newRunId = rs.id; break }
    }
    if (newRunId) {
      console.log('[paperPipeline] 批量新 id: ', newRunId)
      for (const v of valid) {
        try {
          await useTaskQueueStore.getState().update_task(v.taskId, {
            metadata: {
              pdf_github_path: v.pdfPath,
              file_name: v.file.name,
              file_size: v.file.size,
              slug: v.slug,
              source: 'paperPipeline',
              id: newRunId,
            },
          })
        } catch { /* 不阻塞 */ }
      }
    } else {
      console.warn('[paperPipeline] 没找到新 id，后续只能靠 progress.json')
    }

    valid.forEach((v) => {
      results[v.idx].ok = true
      results[v.idx].pdf_path = v.pdfPath
      results[v.idx].task_id = v.taskId
    })
    return { ok: true, results }
  } catch (err: any) {
    const msg = `触发后端 pipeline 失败：${err?.message || String(err)}。请检查 GitHub Actions 是否启用。`
    toast.error(msg)
    for (const v of valid) {
      results[v.idx].error = msg
      results[v.idx].task_id = v.taskId
      try {
        await useTaskQueueStore.getState().update_task(v.taskId, {
          status: 'failed',
          stage: 'failed',
          node_index: STAGE_META.failed.node,
          message: `触发后端失败：${msg}`,
          error: msg,
        })
      } catch {}
    }
    return { ok: false, results, error: msg }
  }
}
