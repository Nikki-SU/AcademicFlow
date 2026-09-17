/**
 * 串行后台任务队列 Store (Zustand)
 * -------------------------------------------------
 * 管理 MinerU + post-mineru 全流程的串行后台任务队列。
 * 只负责队列调度和状态持久化，不负责具体执行——执行器由 Management 组件注册。
 *
 * 持久化：CSV 存储在 settings/background_tasks.csv（通过 userData.ts）。
 * 刷新后 load_tasks() 会把所有 running 重置为 pending，自动重跑。
 */

import { create } from 'zustand'
import { readCsvFile, writeCsvFile, getRepoContext } from '../services/userData'
import { uploadRepoBinaryFile, downloadRepoBinaryFile } from '../services/github'
import { doiToSlug } from '../services/literatureData'
import type { TaskType } from '../types'

// 生成 PDF 在 GitHub 上的存储路径
// 格式: literatures/{doi_slug}/source/{timestamp}_{filename}
// 注意：slug 必须和 literatureData.ts 的 doiToSlug 保持一致，
// 否则 MinerU 产物会落到不同目录导致 post-mineru 找不到文件。
export function buildSourcePdfPath(doi: string, filename: string): string {
  const slug = doiToSlug(doi)
  const ts = Date.now()
  const safeName = filename.replace(/[^a-zA-Z0-9.\-_]/g, '_')
  return `literatures/${slug}/source/${ts}_${safeName}`
}

// ============================================================
// 统一的流水线阶段（所有 stage 共享一个类型，零映射）
// ============================================================

export type PipelineStage =
  | 'queued'
  // --- UI 节点 0：转换（MinerU PDF → Markdown）---
  | 'mineru_apply'     // 申请上传 URL
  | 'mineru_upload'    // 上传 PDF
  | 'mineru_poll'      // 轮询解析状态
  | 'mineru_download'  // 下载 zip 产物
  // --- UI 节点 1：标注（AI-1 Clean + AI-1 Tag + 纯代码 Enumerate）---
  | 'ai1_clean'        // AI-1 语义分段 + 清理 + 打标（一步完成，输出带标记的 Markdown）
  | 'enumerate'        // 纯代码编号（瞬间完成）
  // --- UI 节点 2：翻译（AI-2 逐段）---
  | 'translating'
  // --- UI 节点 3：提词 + 组装 + 提交 ---
  | 'words_extract'
  | 'words_verify'
  | 'assemble'          // 组装 aligned.md + 最终翻译 md（纯代码）
  | 'commit'            // git commit + push 到 GitHub
  // --- 终态 ---
  | 'done'
  | 'failed'
  | 'aborted'

/**
 * 每个 stage 固定属于哪个 UI 节点 + 节点内进度起始百分比 + 人类可读标签。
 * 执行器直接 set stage，UI 直接读 meta，零映射代码。
 */
export const STAGE_META: Record<PipelineStage, { node: 0 | 1 | 2 | 3; pctBase: number; label: string }> = {
  // 节点 0：转换
  queued:          { node: 0, pctBase: 0,  label: '排队中' },
  mineru_apply:    { node: 0, pctBase: 5,  label: 'MinerU 申请上传 URL' },
  mineru_upload:   { node: 0, pctBase: 15, label: 'MinerU 上传 PDF' },
  mineru_poll:     { node: 0, pctBase: 20, label: 'MinerU 解析中' },
  mineru_download: { node: 0, pctBase: 48, label: 'MinerU 下载产物' },
  // 节点 1：标注
  ai1_clean:       { node: 1, pctBase: 51, label: 'AI-1 语义分段 + 清理 + 打标' },
  enumerate:       { node: 1, pctBase: 67, label: '纯代码编号对齐' },
  // 节点 2：翻译
  translating:     { node: 2, pctBase: 70, label: 'AI-2 逐段翻译' },
  // 节点 3：提词 + 组装 + 提交
  words_extract:   { node: 3, pctBase: 93, label: 'AI-1 提取学术单词' },
  words_verify:    { node: 3, pctBase: 95, label: 'AI-2 核验学术单词' },
  assemble:        { node: 3, pctBase: 97, label: '组装最终 Markdown' },
  commit:          { node: 3, pctBase: 98, label: '提交到 GitHub' },
  // 终态
  done:            { node: 3, pctBase: 100, label: '完成' },
  failed:          { node: 3, pctBase: 0,   label: '失败' },
  aborted:         { node: 3, pctBase: 0,   label: '已中止' },
}

/** UI 四节点标签 */
export const NODE_LABELS = ['转换', '标注', '翻译', '提词'] as const

// 向后兼容：TaskStep 仍存在但不再是状态源，所有新代码用 PipelineStage
export type TaskStep = PipelineStage

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'aborted'

export interface BackgroundTask {
  id: string
  type: TaskType
  doi?: string
  book_id?: string
  title: string
  /** 当前真实阶段（唯一状态源） */
  stage: PipelineStage
  /** UI 节点编号 0-3（可直接从 STAGE_META[stage].node 推导，但存了省得每次查） */
  node_index: 0 | 1 | 2 | 3
  /** 节点内进度 0-100 */
  progress: number
  status: TaskStatus
  message: string
  created_at: number
  updated_at: number
  error?: string
  metadata?: Record<string, unknown>
}

export type TaskExecutor = (task: BackgroundTask, signal: AbortSignal) => Promise<void>

// ============================================================
// CSV 配置
// ============================================================

const CSV_PATH = 'settings/background_tasks.csv'

// 新头（v2）：stage + node_index 替代旧的 current_step + step_index + total_steps
const CSV_HEADERS_V2 = [
  'id', 'type', 'doi', 'book_id', 'title',
  'stage', 'node_index', 'progress',
  'status', 'message', 'created_at', 'updated_at', 'error', 'metadata',
]
// 旧头（v1，向后兼容读取）——保留用于迁移，但不再写入
// const CSV_HEADERS_V1 = [
//   'id', 'type', 'doi', 'book_id', 'title',
//   'current_step', 'step_index', 'total_steps', 'progress',
//   'status', 'message', 'created_at', 'updated_at', 'error', 'metadata',
// ]

// ============================================================

function serializeTask(task: BackgroundTask): string[] {
  return [
    task.id,
    task.type,
    task.doi ?? '',
    task.book_id ?? '',
    task.title,
    task.stage,
    String(task.node_index),
    String(task.progress),
    task.status,
    task.message,
    String(task.created_at),
    String(task.updated_at),
    task.error ?? '',
    task.metadata ? JSON.stringify(task.metadata) : '',
  ]
}

function parseTask(rows: string[][]): BackgroundTask[] {
  if (rows.length <= 1) return []
  const header = rows[0]
  const isV2 = header.includes('stage')
  const tasks: BackgroundTask[] = []
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.length < (isV2 ? 14 : 15)) continue
    try {
      if (isV2) {
        const stage = row[5] as PipelineStage
        tasks.push({
          id: row[0],
          type: row[1] as TaskType,
          doi: row[2] || undefined,
          book_id: row[3] || undefined,
          title: row[4],
          stage,
          node_index: (Number(row[6]) || (STAGE_META[stage]?.node ?? 0)) as 0 | 1 | 2 | 3,
          progress: Number(row[7]) || 0,
          status: row[8] as TaskStatus,
          message: row[9],
          created_at: Number(row[10]) || 0,
          updated_at: Number(row[11]) || 0,
          error: row[12] || undefined,
          metadata: row[13] ? JSON.parse(row[13]) : undefined,
        })
      } else {
        // v1 → 迁移：用旧 step_index 粗略推断 node_index，stage 用 step 名
        const oldStep = row[5] as PipelineStage
        const oldStepIdx = Number(row[6]) || 0
        const node = (oldStepIdx <= 0 ? 0 : oldStepIdx === 1 ? 1 : oldStepIdx === 2 ? 2 : 3) as 0 | 1 | 2 | 3
        tasks.push({
          id: row[0],
          type: row[1] as TaskType,
          doi: row[2] || undefined,
          book_id: row[3] || undefined,
          title: row[4],
          stage: oldStep in STAGE_META ? oldStep : 'queued',
          node_index: node,
          progress: Number(row[8]) || 0,
          status: row[9] as TaskStatus,
          message: row[10],
          created_at: Number(row[11]) || 0,
          updated_at: Number(row[12]) || 0,
          error: row[13] || undefined,
          metadata: row[14] ? JSON.parse(row[14]) : undefined,
        })
      }
    } catch (e) {
      console.warn('[taskQueue] 解析 CSV 行失败:', row, e)
    }
  }
  return tasks
}

// ============================================================
// Store
// ============================================================

interface TaskQueueState {
  tasks: BackgroundTask[]
  _executor: TaskExecutor | null
  _abort_controllers: Map<string, AbortController>
  _running: boolean
  // 内存中的 File 映射，不持久化（刷新后重传）。key = task.id
  _files: Map<string, File>
}

interface TaskQueueActions {
  add_task: (task: BackgroundTask, file?: File) => Promise<void>
  get_file: (id: string) => File | undefined
  update_task: (id: string, patch: Partial<BackgroundTask>) => Promise<void>
  remove_task: (id: string) => Promise<void>
  abort_task: (id: string) => Promise<void>
  load_tasks: () => Promise<void>
  set_executor: (fn: TaskExecutor) => void
  _run_next: () => Promise<void>
  _persist: () => Promise<void>
  /** 进度类高频更新的合并写（debounce），结构性变化仍应直接调 _persist */
  _persistSoon: () => void
}

type TaskQueueStore = TaskQueueState & TaskQueueActions

// 进度抖动（progress/message/updated_at）的合并写计时器。
// runner 在 GitHub Actions 里跑时，前端每几秒一个 "Update background_tasks.csv" commit
// 会不断推进 main，把 runner 末尾的 force-with-lease push 顶成 cannot lock ref 失败。
// 所以纯进度更新走 5s debounce，只有 stage/status 等结构性变化才立即落盘。
let persistTimer: ReturnType<typeof setTimeout> | null = null
const PERSIST_DEBOUNCE_MS = 5000

export const useTaskQueueStore = create<TaskQueueStore>((set, get) => ({
  tasks: [],
  _executor: null,
  _abort_controllers: new Map(),
  _running: false,
  _files: new Map(),

  set_executor: (fn: TaskExecutor) => {
    set({ _executor: fn })
  },

  _persist: async () => {
    // 立即落盘：取消任何挂起的合并写，避免旧数据后写覆盖新数据
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
    const { tasks } = get()
    try {
      await writeCsvFile<BackgroundTask>(CSV_PATH, tasks, CSV_HEADERS_V2, serializeTask)
    } catch (err) {
      console.warn('[taskQueue] 持久化 CSV 失败（非致命）:', err)
    }
  },

  _persistSoon: () => {
    // 合并写：5s 内的连续进度抖动只会产生一个 CSV commit
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      void get()._persist()
    }, PERSIST_DEBOUNCE_MS)
  },

  load_tasks: async () => {
    try {
      const loaded = await readCsvFile<BackgroundTask>(CSV_PATH, parseTask)
      // 刷新/路由切换后的状态处理（最小化影响原则）：
      //
      //  ❌ 旧逻辑：running → pending + stage=queued + progress=0（全部清零，从头重跑）
      //  ✅ 新逻辑：running → pending，但**保留 stage/progress/node_index**
      //             executor 的 ensure_file() 会从 GitHub 重建 PDF，
      //             然后从 CSV 里存的当前 stage 继续往下跑。
      //             这样一篇已经跑到 AI-1 Clean 阶段的任务不会被拉回 MinerU 从头解析。
      //
      // 例外：如果 pdf_github_path 都没有（真丢了），那也只能标记 failed。
      const now = Date.now()
      const reset = loaded.map((t) => {
        if (t.status === 'running' || t.status === 'pending') {
          const hasPdfPath = !!t.metadata?.pdf_github_path
          if (!hasPdfPath) {
            // PDF 路径也没了，真的没法续跑
            return {
              ...t,
              status: 'failed' as TaskStatus,
              stage: 'failed' as PipelineStage,
              node_index: STAGE_META.failed.node,
              message: 'PDF 文件丢失，请重新上传',
              error: 'PDF 文件丢失（GitHub 路径不存在）',
              updated_at: now,
            }
          }
          // 保留 stage/progress/node_index，只把 status 改成 pending
          // executor 重新调度时会从 ensure_file() 重建 PDF → 按 CSV 里的 stage 继续
          return {
            ...t,
            status: 'pending' as TaskStatus,
            message: `中断，将从 ${t.stage} 续跑${t.progress ? `（${t.progress}%）` : ''}`,
            updated_at: now,
          }
        }
        return t
      })

      // _files Map 刷新后是空 Map — File 对象不在此处重建
      // executor 调 ensure_file() 时从 GitHub 按需下载
      set({ tasks: reset, _files: new Map() })

      // 如果还有 pending，持久化后启动调度器
      // 注意：只改 status 为 pending 后 _run_next() 会从 CSV 里的 stage 继续，
      //       不会从零开始重新 MinerU 解析
      if (reset.some((t) => t.status === 'pending')) {
        get()._persist()
        queueMicrotask(() => get()._run_next())
      }
    } catch (err) {
      console.warn('[taskQueue] 加载任务失败:', err)
    }
  },

  add_task: async (task: BackgroundTask, file?: File) => {
    const state = get()
    console.log('[taskQueue] add_task 调用, _running=', state._running, '_executor=', !!state._executor, '有文件:', !!file, file ? `size=${file.size}` : '')

    // 1) 先把 File 存内存 Map + 持久化 CSV —— 这步**不依赖 GitHub**
    const enrichedTask: BackgroundTask = file
      ? { ...task, metadata: { ...(task.metadata ?? {}), file_name: file.name, file_size: file.size } }
      : task

    const tasks = [...state.tasks, enrichedTask]
    const files = new Map(state._files)
    if (file) files.set(task.id, file)  // 关键：内存 Map 存原始 File（Executor 直接拿）
    set({ tasks, _files: files })

    try {
      await get()._persist()
      console.log('[taskQueue] add_task persist 成功')
    } catch (err) {
      console.error('[taskQueue] add_task persist 失败:', err)
      throw err
    }

    // 2) GitHub upload 改成 fire-and-forget（异步不阻塞 pipeline）
    //    成功后 update_task 会把 pdf_github_path 补进 metadata（CSV 已持久化过了，异步 update_task 会再 persist 一次）
    if (file) {
      const ctx = getRepoContext()
      if (ctx) {
        const doi = task.doi ?? task.id
        const githubPath = buildSourcePdfPath(doi, file.name)
        console.log(`[taskQueue] 后台上传 PDF 到 GitHub: ${githubPath} (${file.size}B)`)
        uploadRepoBinaryFile(ctx.owner, ctx.repo, githubPath, file, ctx.token,
          `Upload source PDF for ${task.title}`)
          .then(async () => {
            console.log(`[taskQueue] GitHub upload 成功 → ${githubPath}`)
            // 成功 → 把路径写回 metadata 持久化
            const t = get().tasks.find(x => x.id === task.id)
            if (t && !t.metadata?.pdf_github_path) {
              await get().update_task(task.id, {
                metadata: { ...(t.metadata ?? {}), pdf_github_path: githubPath },
              })
            }
          })
          .catch((err) => {
            console.warn('[taskQueue] GitHub upload 失败（不阻塞 pipeline）:', err instanceof Error ? err.message : err)
          })
      }
    }

    // 如果当前没有 running 任务，立即启动
    if (!state._running) {
      console.log('[taskQueue] add_task 触发 _run_next')
      queueMicrotask(() => get()._run_next())
    }
  },

  get_file: (id: string) => get()._files.get(id),

  // 从 GitHub 重建 File 对象（内存 Map 没有时调用）
  ensure_file: async (id: string): Promise<File | undefined> => {
    const cached = get()._files.get(id)
    if (cached) return cached

    const task = get().tasks.find((t) => t.id === id)
    const path = task?.metadata?.pdf_github_path as string | undefined
    if (!path) return undefined

    const ctx = getRepoContext()
      if (!ctx) return undefined

    console.log(`[taskQueue] 内存无 File，从 GitHub 下载: ${path}`)
    try {
      const result = await downloadRepoBinaryFile(ctx!.owner, ctx!.repo, path, ctx!.token, 'application/pdf')
      if (!result) return undefined
      const fileName = (task!.metadata?.file_name as string) ?? path.split('/').pop() ?? `${id}.pdf`
      const file = new File([result.blob], fileName, { type: 'application/pdf', lastModified: Date.now() })
      const files = new Map(get()._files)
      files.set(id, file)
      set({ _files: files })
      console.log(`[taskQueue] 重建 File 成功: ${fileName} (${file.size}B)`)
      return file
    } catch (err) {
      console.error('[taskQueue] GitHub 下载 PDF 失败:', err)
      return undefined
    }
  },

  update_task: async (id: string, patch: Partial<BackgroundTask>) => {
    // 注意：任务到终态（done/failed/aborted）时**绝对不删原始 PDF**
    // 之前的 cleanup 逻辑会把用户上传的 PDF 自动删掉、csv 里的 pdf_github_path 也清掉
    // → 导致：下次 executor 断点续跑时 ensure_file() 找不到 PDF
    // 原始 PDF 是用户数据，不是临时文件，只有用户手动删文献时才会删
    const prev = get().tasks.find((t) => t.id === id)
    const tasks = get().tasks.map((t) => {
      if (t.id !== id) return t
      const merged: BackgroundTask = { ...t, ...patch, updated_at: Date.now() }
      return merged
    })
    set({ tasks })

    // 结构性变化（status/stage/error/metadata 真的变了，含进入终态）立即落盘；
    // 仅 progress/message/node_index 抖动（轮询进度时几秒一次）走 debounce 合并写，
    // 避免 background_tasks.csv 高频 commit 抢 main 导致 runner push 失败。
    const structural =
      !prev ||
      (patch.status !== undefined && patch.status !== prev.status) ||
      (patch.stage !== undefined && patch.stage !== prev.stage) ||
      patch.error !== undefined ||
      patch.metadata !== undefined
    if (structural) {
      await get()._persist()
    } else {
      get()._persistSoon()
    }
  },

  remove_task: async (id: string) => {
    // 如果正在运行，先 abort
    const ac = get()._abort_controllers.get(id)
    if (ac) {
      try {
        ac.abort()
      } catch {}
      get()._abort_controllers.delete(id)
    }
    const tasks = get().tasks.filter((t) => t.id !== id)
    set({ tasks })
    await get()._persist()
  },

  abort_task: async (id: string) => {
    const task = get().tasks.find((t) => t.id === id)
    if (!task) return

    if (task.status === 'running') {
      // running 状态：调 AbortController
      const ac = get()._abort_controllers.get(id)
      if (ac) {
        try {
          ac.abort()
        } catch {}
      }
      // executor 会 catch AbortError 并标记为 aborted
      // 这里先标记 message，等 executor 抛错后 update_task 完整更新
      await get().update_task(id, { message: '正在中止...' })
    } else if (task.status === 'pending') {
      // pending 状态：直接标记 aborted
      await get().update_task(id, {
        status: 'aborted',
        stage: 'aborted',
        node_index: STAGE_META.aborted.node,
        message: '已取消',
      })
    }
  },

  _run_next: async () => {
    const state = get()
    if (state._running) return // 已有在跑，防止重入

    // 找第一个 pending 任务
    const next = state.tasks.find((t) => t.status === 'pending')
    if (!next) {
      console.log('[taskQueue] 没有 pending 任务，队列空')
      set({ _running: false })
      return
    }

    const executor = state._executor
    if (!executor) {
      // executor 未注册（Management 未挂载），等待
      console.warn('[taskQueue] executor 未注册，等待 Management 组件挂载')
      set({ _running: false })
      return
    }

    const taskId = next.id
    const ac = new AbortController()

    console.log('[taskQueue] 开始执行任务:', next.id, next.title, next.type)
    console.log('[taskQueue] _files 状态:', get()._files.has(taskId) ? '有 File' : '无 File')

    // 标记为 running
    set((s) => {
      const tasks = s.tasks.map((t) =>
        t.id === taskId
          ? { ...t, status: 'running' as TaskStatus, updated_at: Date.now() }
          : t,
      )
      const controllers = new Map(s._abort_controllers)
      controllers.set(taskId, ac)
      return { tasks, _running: true, _abort_controllers: controllers }
    })
    await get()._persist()

    try {
      await executor(next, ac.signal)
      // executor 正常返回（任务已被标记为 done/failed 等）
      console.log('[taskQueue] executor 正常返回:', next.id)
      const controllers = new Map(get()._abort_controllers)
      controllers.delete(taskId)
      set({ _abort_controllers: controllers })
    } catch (err) {
      // executor 抛异常
      const isAbort = err instanceof Error && err.name === 'AbortError'
      const controllers = new Map(get()._abort_controllers)
      controllers.delete(taskId)

      if (isAbort) {
        await get().update_task(taskId, {
          status: 'aborted',
          stage: 'aborted',
          node_index: STAGE_META.aborted.node,
          message: '已中止',
        })
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        await get().update_task(taskId, {
          status: 'failed',
          stage: 'failed',
          node_index: STAGE_META.failed.node,
          message: `执行失败: ${msg}`,
          error: msg,
        })
      }
      set({ _abort_controllers: controllers })
    } finally {
      set({ _running: false })
      // 跑下一个
      queueMicrotask(() => get()._run_next())
    }
  },
}))

// ============================================================
// 辅助：直接从 STAGE_META 查，零映射
// ============================================================

/** 节点内百分比 = STAGE_META[p.stage].pctBase + progress */
export function nodeInnerPercent(stage: PipelineStage, progress: number): number {
  const base = STAGE_META[stage]?.pctBase ?? 0
  // 同节点内的进度：把 [0,100] 映射到 [pctBase, nextStage.pctBase)
  return Math.min(100, base + Math.round(progress * 0.3))
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '排队中',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  aborted: '已中止',
}
