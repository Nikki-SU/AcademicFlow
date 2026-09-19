/**
 * 导入宏包服务
 * -------------------------------------------------
 * 随站点分发的 XeLaTeX 运行时只内置了一部分宏包（清单见 Writing.tsx 的
 * RUNTIME_MISSING_FILE_HINT）。用户想用别的 —— acmart 这类重依赖文档类、
 * 冷门宏包、或者自己写的 .sty —— 不必去 CTAN 一棵棵凑依赖树：
 * 把 .sty/.cls 导进来一次，文件落到项目目录 `projects/{id}/latex-packages/`，
 * 之后每次编译自动挂进虚拟文件系统，长期可用。
 *
 * 为什么挂项目级而不是全局：不同论文用不同文档类，同名文件放在一起会互相覆盖
 * （很多宏包都有自己的 .cfg，扁平放进同一个目录必然打架）。
 *
 * 编译侧怎么生效：这些文件以**文件名**挂到 /work（扁平），而运行时环境变量
 * TEXINPUTS 的第一项是 `.`，XeTeX 会直接在工作目录里找到它们，
 * 效果等同于装进了 TeX 发行版。
 */

import {
  bytesToBase64,
  deleteRepoFiles,
  downloadRepoBinaryFile,
  listRepoFilesInDir,
  writeFileBatch,
  type BatchFileOp,
} from './github'
import { getRepoContext } from './userData'
import { assertCanWrite } from './authError'

/** 项目级宏包目录 */
export function latexPackagesDir(projectId: string): string {
  return `projects/${projectId}/latex-packages`
}

/**
 * 允许导入的扩展名（TeX 宏包解包后就是这些东西）：
 * - .sty / .cls 主文件
 * - .def .cfg .clo .fd .rtx .enc / .tex 各种实现与字体表
 *   （xkeyval 的实现文件是 .tex，revtex 的样式是 .rtx，caption 的是 .sto）
 */
const ALLOWED_EXTS = [
  '.sty', '.cls', '.def', '.cfg', '.clo', '.fd', '.rtx', '.enc', '.sto', '.tex',
]

/**
 * 单文件上限 1MB。
 * 上传走 Git Blob API（单 blob 100MB 都没问题），但**读回来**走的是 Contents API，
 * 它对 >1MB 的文件不返回内联内容（`encoding: "none"` + download_url），
 * 那份宏包在编译时就挂不进去 —— 与其留个哑坑，不如现在就挡掉。
 * 真实的 .sty/.cls 极少超过 1MB。
 */
const MAX_FILE_BYTES = 1024 * 1024

export interface LatexPackageInfo {
  name: string
  size: number
}

export interface ImportLatexPackagesResult {
  imported: string[]
  /** 被跳过的文件及原因（中文，可直接展示给用户） */
  skipped: Array<{ name: string; reason: string }>
}

/** 取基础文件名（拖文件夹进来时 webkitRelativePath 会带上目录层级，这里一律扁平化） */
function baseName(name: string): string {
  const parts = name.split(/[\\/]/)
  return parts[parts.length - 1]
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i === -1 ? '' : name.slice(i).toLowerCase()
}

/** 列出项目里已导入的宏包 */
export async function listLatexPackages(
  projectId: string,
): Promise<LatexPackageInfo[]> {
  const ctx = getRepoContext()
  if (!ctx) return []
  const entries = await listRepoFilesInDir(
    ctx.owner,
    ctx.repo,
    latexPackagesDir(projectId),
    ctx.token,
  )
  return entries
    .map((e) => ({ name: e.name, size: e.size }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 导入宏包：把文件内容以 base64 一次性提交到项目目录（一个 commit 装完所有文件）。
 * 同名文件直接覆盖（相当于升级版本）。
 */
export async function importLatexPackages(
  projectId: string,
  files: File[],
): Promise<ImportLatexPackagesResult> {
  assertCanWrite()
  const ctx = getRepoContext()
  if (!ctx) throw new Error('未登录或未选择仓库，无法导入宏包')

  const ops: BatchFileOp[] = []
  const imported: string[] = []
  const skipped: Array<{ name: string; reason: string }> = []
  const seen = new Set<string>()

  for (const file of files) {
    const name = baseName(file.name)
    if (!name) continue
    if (seen.has(name)) {
      skipped.push({ name, reason: '本次选择里有同名文件' })
      continue
    }
    const ext = extOf(name)
    if (!ALLOWED_EXTS.includes(ext)) {
      skipped.push({ name, reason: `不支持的扩展名 ${ext || '(无)'}` })
      continue
    }
    if (file.size > MAX_FILE_BYTES) {
      skipped.push({
        name,
        reason: `超过 1MB（${(file.size / 1024 / 1024).toFixed(1)}MB），编译器读不回来`,
      })
      continue
    }
    seen.add(name)
    const bytes = new Uint8Array(await file.arrayBuffer())
    ops.push({
      path: `${latexPackagesDir(projectId)}/${name}`,
      content: bytesToBase64(bytes),
      encoding: 'base64',
    })
    imported.push(name)
  }

  if (ops.length === 0) return { imported, skipped }

  await writeFileBatch(
    ops,
    `导入 LaTeX 宏包：${imported.join('、')}`,
    ctx.owner,
    ctx.repo,
    ctx.token,
  )
  return { imported, skipped }
}

/**
 * 读出项目里全部宏包内容，供编译时挂进虚拟文件系统。
 * path 用扁平的文件名（不是仓库路径）—— 它们要落在 /work 根下才被 TEXINPUTS 命中。
 * 读不回来的（例如历史遗留的超大文件）直接跳过，不让它挡住整篇编译。
 */
export async function loadLatexPackages(
  projectId: string,
): Promise<Array<{ path: string; data: Uint8Array }>> {
  const ctx = getRepoContext()
  if (!ctx) return []
  const entries = await listRepoFilesInDir(
    ctx.owner,
    ctx.repo,
    latexPackagesDir(projectId),
    ctx.token,
  )
  const results = await Promise.all(
    entries.map(async (entry) => {
      try {
        const file = await downloadRepoBinaryFile(
          ctx.owner,
          ctx.repo,
          entry.path,
          ctx.token,
        )
        if (!file) return null
        const buf = await file.blob.arrayBuffer()
        if (buf.byteLength === 0) return null
        return { path: entry.name, data: new Uint8Array(buf) }
      } catch {
        // 单个宏包读失败不该让整篇论文编不出来，跳过它，日志里会自然报 not found
        return null
      }
    }),
  )
  const loaded: Array<{ path: string; data: Uint8Array }> = []
  for (const item of results) if (item) loaded.push(item)
  return loaded
}

/** 删除若干已导入的宏包 */
export async function deleteLatexPackages(
  projectId: string,
  names: string[],
): Promise<void> {
  if (names.length === 0) return
  assertCanWrite()
  const ctx = getRepoContext()
  if (!ctx) throw new Error('未登录或未选择仓库，无法删除宏包')
  const dir = latexPackagesDir(projectId)
  await deleteRepoFiles(
    names.map((name) => `${dir}/${baseName(name)}`),
    `删除 LaTeX 宏包：${names.join('、')}`,
    ctx.owner,
    ctx.repo,
    ctx.token,
  )
}
