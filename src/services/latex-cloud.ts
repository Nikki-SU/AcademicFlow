/**
 * 云端编译服务（GitHub Actions）
 * -------------------------------------------------
 * 浏览器内的 XeLaTeX WASM 是「即时预览」通道 —— 快、不联网、源码不出本机，
 * 但它的 TeX Live 版本被上游钉死在同一份快照上，宏包装不进去。
 * 这里是第二条通道：把源文件提交进用户私库，用 repository_dispatch 叫起
 * Actions（跑官方 TeX Live 镜像，版本新、宏包全），编完把 PDF 提交回来。
 *
 * 与后端其它任务（paper_convert / ai_call）完全同构：
 *   - 触发走 repository_dispatch，只需要 Contents: write —— 现有 token 权限够用，
 *     不需要额外申请 Actions 权限
 *   - 结果状态写成一个 json 提交回仓库，前端轮询它，不依赖 Actions API
 *   - workflow 的 `name:` 必须与 event_type 同名（getLatestRun 靠它过滤）
 *
 * 目录约定（与 .github/workflows/latex_compile.yml 一一对应）：
 *   输入 projects/{id}/latex-cloud/main.tex (+ references.bib)
 *   输出 projects/{id}/latex-cloud/build.json（状态）/ main.pdf / main.log
 */

import {
  dispatchWorkflow,
  downloadRepoBinaryFile,
  readRepoTextFile,
  writeFileBatch,
  bytesToBase64,
  type BatchFileOp,
} from './github'
import { getRepoContext } from './userData'
import { assertCanWrite } from './authError'
import { getLatestRun } from './workflowClient'
import { withRuntimeCompat } from './xelatex-compiler'

/** event_type，同时也是 workflow yml 的 `name:` 字段 */
export const LATEX_CLOUD_EVENT = 'latex_compile'

export function latexCloudDir(projectId: string): string {
  return `projects/${projectId}/latex-cloud`
}

/**
 * build.json 的结构。字段名保持下划线，与工作流里 jq 写出来的一致 ——
 * 也和后端其它任务（literatures 的 .progress.json）保持同一套命名习惯。
 */
export interface CloudBuildStatus {
  run_id: string
  status: 'running' | 'ok' | 'error'
  started_at?: string
  finished_at?: string
  /** 失败时的 TeX 日志尾部（workflow 已经截好，约 4KB） */
  log_tail?: string
}

export interface CloudCompileResult {
  pdf: ArrayBuffer
  status: CloudBuildStatus
  /** Actions 运行页地址，编译慢或失败时让用户自己去 GitHub 看实时日志 */
  runUrl?: string
}

export interface CloudCompileOptions {
  onStage?: (stage: string) => void
  onRunUrl?: (url: string) => void
  /** 额外源文件（期刊模板自带的 assets/ 等），路径按 main.tex 的相对路径给 */
  extraFiles?: Array<{ path: string; data: Uint8Array }>
  /** 整体超时，默认 8 分钟 —— docker 镜像冷拉 + TeX Live 首次编译都要时间 */
  timeoutMs?: number
}

/** 生成本次编译的标识，用于在 build.json 里认出「这是我的那次」 */
function newRunId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 提交本次编译的源文件。
 * 垫片（中文字体）在这里注入，而不是让调用方自己拼 —— 云端和本地必须用同一份，
 * 否则两边排出来的 PDF 会长得不一样。
 */
async function saveCloudSource(
  projectId: string,
  source: string,
  bib: string | undefined,
  extraFiles: Array<{ path: string; data: Uint8Array }>,
  owner: string,
  repo: string,
  token: string,
): Promise<void> {
  const dir = latexCloudDir(projectId)
  const ops: BatchFileOp[] = [
    { path: `${dir}/main.tex`, content: withRuntimeCompat(source), encoding: 'utf-8' },
  ]
  if (bib && bib.trim()) {
    ops.push({ path: `${dir}/references.bib`, content: bib, encoding: 'utf-8' })
  }
  // 期刊模板自带资源（徽标、页眉图、字体、.bst/.bib）。落点必须与 main.tex 同目录、
  // 且保留模板里的相对路径，这样 \includegraphics{head_foot/xxx} 才能按原样解析 ——
  // workflow 是以 main.tex 所在目录为工作目录跑 latexmk 的。
  for (const f of extraFiles) {
    ops.push({ path: `${dir}/${f.path}`, content: bytesToBase64(f.data), encoding: 'base64' })
  }
  await writeFileBatch(ops, `云端编译：更新源文件（${projectId}）[skip ci]`, owner, repo, token)
}

/** 读 build.json；run_id 不是我们要的那次就当作「还没开始」 */
async function readBuildStatus(
  projectId: string,
  runId: string,
  owner: string,
  repo: string,
  token: string,
): Promise<CloudBuildStatus | null> {
  const file = await readRepoTextFile(
    owner,
    repo,
    `${latexCloudDir(projectId)}/build.json`,
    token,
  ).catch(() => null)
  if (!file) return null
  let parsed: CloudBuildStatus
  try {
    parsed = JSON.parse(file.content) as CloudBuildStatus
  } catch {
    return null
  }
  // 上一轮的 build.json 还没被覆盖时 run_id 对不上，说明这次的 runner 还没开始写
  return parsed.run_id === runId ? parsed : null
}

/**
 * 云端编译一份 LaTeX 源文件。
 *
 * 成功返回 PDF 字节；失败抛 Error，`.message` 里带着 workflow 截好的日志尾部，
 * 调用方可以直接展示。
 */
export async function compileOnGitHub(
  projectId: string,
  source: string,
  bib: string | undefined,
  opts: CloudCompileOptions = {},
): Promise<CloudCompileResult> {
  assertCanWrite()
  const ctx = getRepoContext()
  if (!ctx) throw new Error('未登录或未选择仓库，无法云端编译')
  const { owner, repo, token } = ctx
  const stage = opts.onStage ?? (() => {})

  // 先确认 workflow 装没装。没装的话 dispatch 出去什么也不会发生，
  // 用户会白等满整个超时 —— 不如现在就拦住，并告诉他去哪儿装。
  const workflowFile = await readRepoTextFile(
    owner,
    repo,
    '.github/workflows/latex_compile.yml',
    token,
  ).catch(() => null)
  if (!workflowFile) {
    throw new Error(
      '你的私库里还没有云端编译的 workflow。\n' +
        '去设置页的「后端处理能力」点一下「重写后端」，把 latex_compile.yml 写进私库，再回来点云端编译。',
    )
  }

  stage('正在把源文件提交到私库…')
  await saveCloudSource(projectId, source, bib, opts.extraFiles ?? [], owner, repo, token)

  // dispatch 前先记下「当前最新一次 run」，之后靠 created_at 增量找出我们自己那次
  const before = await getLatestRun(LATEX_CLOUD_EVENT, owner, repo, token)
  const beforeCreatedAt = before?.created_at ?? new Date(Date.now() - 60_000).toISOString()

  const runId = newRunId()
  stage('已触发正式编译（后端），等待 runner 接单…')
  await dispatchWorkflow(
    LATEX_CLOUD_EVENT,
    { project_id: projectId, run_id: runId },
    owner,
    repo,
    token,
  )

  // GitHub 收到 dispatch 后要一两秒才建出 run，先等一下再找
  await new Promise((r) => setTimeout(r, 2500))

  let runUrl: string | undefined
  let runFound = false
  for (let i = 0; i < 20; i++) {
    const rs = await getLatestRun(LATEX_CLOUD_EVENT, owner, repo, token, beforeCreatedAt)
    if (rs) {
      runFound = true
      runUrl = rs.html_url
      opts.onRunUrl?.(rs.html_url)
      break
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  if (runFound) {
    stage('正式编译（后端）进行中（首次运行要拉 TeX Live 镜像，可能几分钟）…')
  } else {
    // 找不到 run 不代表失败：可能只是排队慢。继续轮询 build.json，
    // 但把原因说清楚，免得用户干等。
    stage('还没看到 Actions 运行记录，继续等待（若一直没动静，检查后端 workflow 是否已安装）…')
  }

  // 轮询 build.json。GitHub API 不缓存，所以这里拿到的一定是仓库里的最新内容。
  const timeoutMs = opts.timeoutMs ?? 8 * 60 * 1000
  const intervalMs = 6000
  const maxAttempts = Math.max(1, Math.floor(timeoutMs / intervalMs))
  let status: CloudBuildStatus | null = null

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs))
    const s = await readBuildStatus(projectId, runId, owner, repo, token)
    if (s && s.status !== 'running') {
      status = s
      break
    }
    if (s) stage(`正式编译（后端）中…（已 ${Math.round(((i + 1) * intervalMs) / 1000)}s）`)
  }

  if (!status) {
    throw new Error(
      runFound
        ? `正式编译（后端）超时（${Math.round(timeoutMs / 1000)}s 内没有结果）。可以打开运行页看实时日志：${runUrl ?? ''}`
        : '正式编译（后端）没有启动。最可能的原因：后端 workflow 还没装到你的私库 —— 去设置页的「后端处理能力」点一下「重写后端」。',
    )
  }

  if (status.status === 'error') {
    throw new Error(
      `正式编译（后端）失败。\n\n${status.log_tail ?? '(workflow 没有留下日志)'}\n\n` +
        (runUrl ? `运行页：${runUrl}` : ''),
    )
  }

  stage('正在取回 PDF…')
  const pdfFile = await downloadRepoBinaryFile(
    owner,
    repo,
    `${latexCloudDir(projectId)}/main.pdf`,
    token,
    'application/pdf',
  )
  if (!pdfFile) {
    throw new Error('正式编译（后端）报告成功，但仓库里没有 main.pdf —— 去看一眼 workflow 日志。')
  }

  return { pdf: await pdfFile.blob.arrayBuffer(), status, runUrl }
}
