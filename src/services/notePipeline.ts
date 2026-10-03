/**
 * 笔记附件转换入队（公共 helper）
 * ---------------------------------------------------
 * Word / PDF 附件 → 云端 note_convert 管线 → 命名笔记（markdown）。
 * 与 bookPipeline 同构，差别只在进度/产物位置：
 *   - 进度落盘在 {base_path}/.progress.json（阅读对象目录下）
 *   - 产物是 {base_path}/notes/{note_name}.md + {base_path}/notes/images/
 *   - Word 先在 runner 里用 LibreOffice 转 PDF，再进 MinerU（PDF 直通）
 *
 * 真实进度链路：
 *   1. 前端上传源文件 → GitHub 私库 {base_path}/attachments/
 *   2. 前端 dispatchNoteConvert（**一批附件只 dispatch 一次**）→ 触发 note_convert workflow
 *   3. 同时注册进 taskQueue → 后台监控面板立即可见
 *   4. runner 写 {base_path}/.progress.json → 前端轮询同步回 taskQueue
 *   5. runner 产出笔记 md + images，阅读页直接读
 *
 * 为什么批量：runner 是全新 VM，装 LibreOffice 要 2~4 分钟。逐篇 dispatch 会把这段
 * 固定开销乘 N（用户等不起）。合并成一次 = 装一次环境 + 一次 MinerU batch。
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

export interface EnqueueNoteItem {
  file: File
  /** 目标笔记名（不含 .md；调用方保证不与已有笔记重名） */
  noteName: string
}

/** 单篇的入队结果；results 与传入 items 顺序一一对应 */
export interface EnqueueNoteResult {
  ok: boolean
  note_name: string
  source_path?: string
  task_id?: string
  error?: string
}

export interface EnqueueNoteBatchResult {
  ok: boolean
  results: EnqueueNoteResult[]
  error?: string
}

/**
 * 把一批 Word / PDF 附件加入后端 note_convert 转换队列。
 * 所有附件一次上传、一次 dispatch（runner 只装一次环境、一次 MinerU batch）。
 * docRef 决定产物落在哪个阅读对象目录下。
 */
export async function enqueueNoteConvertBatch(
  docRef: DocRef,
  items: EnqueueNoteItem[],
): Promise<EnqueueNoteBatchResult> {
  const results: EnqueueNoteResult[] = items.map((it) => ({ ok: false, note_name: it.noteName }))
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

  const basePath = docBasePath(docRef)
  const stamp = Date.now()

  // 先逐篇过一遍约束：超大附件直接判失败，不拖累其余篇
  const valid: { idx: number; file: File; noteName: string; sourcePath: string; taskId: string }[] = []
  items.forEach((it, idx) => {
    if (it.file.size > MAX_ATTACHMENT_SIZE) {
      const msg = `附件过大：${(it.file.size / 1024 / 1024).toFixed(1)} MB > 100 MB GitHub 硬限。请裁剪后重试。`
      toast.error(`${it.file.name}：${msg}`)
      results[idx].error = msg
      return
    }
    const safeName = it.file.name.replace(/[/\\]+/g, '_').replace(/\s+/g, '_')
    valid.push({
      idx,
      file: it.file,
      noteName: it.noteName,
      sourcePath: `${attachmentsDir(docRef)}/${stamp}_${idx}_${safeName}`,
      taskId: `note_${stamp}_${idx}_${Math.random().toString(36).slice(2, 8)}`,
    })
  })
  if (valid.length === 0) return { ok: false, results }

  // ──── 1. 所有附件一次上传（一次 commit） ────
  try {
    const ops: BatchFileOp[] = []
    for (const v of valid) {
      const b64 = await fileToBase64(v.file)
      ops.push({ path: v.sourcePath, content: b64, encoding: 'base64' })
    }
    const msg = valid.length === 1
      ? `upload ${valid[0].file.name} for note ${valid[0].noteName}`
      : `upload ${valid.length} attachments for notes`
    await writeFileBatch(ops, msg, owner, repo, token)
  } catch (err: any) {
    const msg = `附件上传失败：${err?.message || String(err)}`
    toast.error(msg)
    valid.forEach((v) => {
      results[v.idx].error = msg
      results[v.idx].task_id = v.taskId
    })
    return { ok: false, results, error: msg }
  }

  // ──── 2. 每篇各注册一个 taskQueue 任务（后台监控面板逐篇可见） ────
  for (const v of valid) {
    try {
      const tq = useTaskQueueStore.getState()
      const now = Date.now()
      await tq.add_task({
        id: v.taskId,
        type: 'note_convert',
        title: `${docRef.id} · ${v.noteName}`,
        stage: 'queued',
        node_index: STAGE_META.queued.node,
        progress: 0,
        status: 'pending',
        message: '附件已上传，等待后端转换...',
        created_at: now,
        updated_at: now,
        metadata: {
          source_path: v.sourcePath,
          file_name: v.file.name,
          file_size: v.file.size,
          // slug 存 base_path：进度轮询按它拼 {base_path}/.progress.json
          slug: basePath,
          base_path: basePath,
          note_name: v.noteName,
          source: 'notePipeline',
        },
      })
    } catch (err: any) {
      console.warn('[notePipeline] taskQueue.add_task 失败（不阻塞 pipeline）:', err?.message)
    }
  }

  // ──── 3. 一次 dispatch 触发后端（所有篇同一个 run） ────
  try {
    const beforeRun = await getLatestRun('note_convert', owner, repo, token)
    const beforeCreatedAt = beforeRun?.created_at ?? new Date(Date.now() - 60_000).toISOString()

    await dispatchNoteConvert(
      basePath,
      valid.map((v) => ({ noteName: v.noteName, sourcePath: v.sourcePath })),
      owner, repo, token,
    )

    // 轮询新 run 的 id（GitHub 索引有 1-2s 延迟），存进每篇 metadata 供状态兜底
    let newRunId: number | null = null
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const rs = await getLatestRun('note_convert', owner, repo, token, beforeCreatedAt)
      if (rs) { newRunId = rs.id; break }
    }
    if (newRunId) {
      for (const v of valid) {
        try {
          await useTaskQueueStore.getState().update_task(v.taskId, {
            metadata: {
              source_path: v.sourcePath,
              file_name: v.file.name,
              file_size: v.file.size,
              slug: basePath,
              base_path: basePath,
              note_name: v.noteName,
              source: 'notePipeline',
              id: newRunId,
            },
          })
        } catch { /* 不阻塞 */ }
      }
    } else {
      console.warn('[notePipeline] 没找到新 run id，后续只能靠 progress.json / 产物兜底')
    }

    valid.forEach((v) => {
      results[v.idx].ok = true
      results[v.idx].source_path = v.sourcePath
      results[v.idx].task_id = v.taskId
    })
    toast.success(
      valid.length === 1 ? `已提交后端转换：${valid[0].noteName}` : `已提交后端转换 ${valid.length} 篇笔记`,
      { description: 'Word / PDF 正在转成 markdown 笔记，可在笔记面板看到进度' },
    )
    return { ok: true, results }
  } catch (err: any) {
    const msg = `触发后端 pipeline 失败：${err?.message || String(err)}。请检查私库是否已安装 note_convert workflow（设置页可一键安装）。`
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
      } catch { /* 不阻塞 */ }
    }
    return { ok: false, results, error: msg }
  }
}
