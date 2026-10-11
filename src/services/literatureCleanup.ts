/**
 * 文献级联清理服务
 * -------------------------------------------------
 * 原则（用户 2026-10-08 定调）：**删一篇文献，它的对应物件也要一起删**。
 * 单词本 / 长难句本 / 翻译练习本以 source_doi 关联文献；笔记 / 批注躺在
 * literatures/{slug}/ 目录下；任务队列 / 材料元数据 / 项目引用也都挂在 DOI 上。
 * 这些物件不跟着删，就等于留着"已经不想读的文献"的残留。
 *
 * 本模块把此前散在管理页里的级联逻辑收敛成一处，**管理页删除 与 追踪页撤销入库共用**，
 * 避免两处各写一份、口径走样（"删了文献单词还在"那类 bug 的根因）。
 *
 * 依赖：只依赖服务层与 store，不依赖任何页面组件。
 */

import { githubFetch, deleteRepoFiles } from './github'
import { doiToSlug } from './literatureData'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'
import { useTaskQueueStore, type BackgroundTask } from '../stores/taskQueue'
import {
  loadWords, saveWords,
  loadSentences, saveSentences,
  loadTranslations, saveTranslations,
} from './learningData'
import { removeLibraryReferences } from './projectData'
import { isSameDoi } from './citation'

export interface RepoContext {
  owner: string
  repo: string
  token: string
}

/** 取当前工作区的仓库上下文；未登录 / 未初始化时返回 null */
export function getRepoContextForDelete(): RepoContext | null {
  const auth = useAuthStore.getState()
  const ws = useWorkspaceStore.getState()
  if (!auth.token || !auth.user || !ws.repo) return null
  return { owner: auth.user.login, repo: ws.repo.name, token: auth.token }
}

/**
 * 收集要删除的文献目录下所有文件路径。
 * 用 git/trees?recursive=1 一次请求列出整个子树，避免 N 次 404 试探。
 * 目录还不存在（literatures/{slug} 根本没建）时返回空数组。
 */
export async function collectLiteratureFilePaths(paperDoi: string): Promise<string[]> {
  const ctx = getRepoContextForDelete()
  if (!ctx) return []
  const slug = doiToSlug(paperDoi)
  const dirPath = `literatures/${slug}`

  const treeRes = await githubFetch(
    `/repos/${ctx.owner}/${ctx.repo}/git/trees/main?recursive=1`,
    ctx.token,
  )
  if (treeRes.status === 404) return []
  if (!treeRes.ok) return []

  try {
    const data = await treeRes.json()
    const allEntries = (data.tree ?? []) as Array<{ path: string; type: string }>
    const paths: string[] = []
    for (const entry of allEntries) {
      if (entry.type === 'blob' && entry.path.startsWith(`${dirPath}/`)) {
        paths.push(entry.path)
      }
    }
    return paths
  } catch {
    return []
  }
}

/**
 * 级联清理：删除给定 DOI（可一次传多个）在全部学习数据 CSV 中的关联行。
 *
 * 两个关键设计（都是修 bug 的根因，不是随手加的）：
 *  1. **一次传一批 DOI、每张表只读写一遍**：逐篇 fire-and-forget 会对同一张表
 *     并发「读-改-写」，后写覆盖先写 / sha 冲突 → 部分行没删掉。
 *  2. **用 isSameDoi 匹配**：DOI 大小写不敏感，且展示侧（词根词缀核对区）也用同一口径，
 *     避免"界面显示有、删除说没有"。
 *
 * 返回失败的文件名列表；空数组 = 全部成功（调用方据此如实上报，不把失败咽进 console）。
 */
export async function purgeLiteratureObjects(dois: string[]): Promise<string[]> {
  const targets = dois.filter((d) => (d || '').trim())
  if (targets.length === 0) return []
  const hit = (sourceDoi: string) => targets.some((d) => isSameDoi(sourceDoi, d))
  const errors: string[] = []

  try {
    const words = await loadWords(true)
    const remaining = words.filter((w) => !hit(w.sourceDoi))
    if (remaining.length !== words.length) await saveWords(remaining)
  } catch (e) {
    errors.push('词汇本')
    console.warn('[purgeLiteratureObjects] vocabulary:', e)
  }
  try {
    const sentences = await loadSentences(true)
    const remaining = sentences.filter((s) => !hit(s.sourceDoi))
    if (remaining.length !== sentences.length) await saveSentences(remaining)
  } catch (e) {
    errors.push('长难句本')
    console.warn('[purgeLiteratureObjects] sentences:', e)
  }
  try {
    const translations = await loadTranslations(true)
    const remaining = translations.filter((t) => !hit(t.sourceDoi))
    if (remaining.length !== translations.length) await saveTranslations(remaining)
  } catch (e) {
    errors.push('翻译练习本')
    console.warn('[purgeLiteratureObjects] translations:', e)
  }
  return errors
}

/** 从 taskQueue 中清理某 DOI 的所有 paper_convert 任务（无论什么状态） */
export async function cleanupTasksForDoi(doi: string): Promise<void> {
  try {
    const tq = useTaskQueueStore.getState()
    const matching = tq.tasks.filter(
      (t: BackgroundTask) => t.doi === doi && t.type === 'paper_convert',
    )
    if (matching.length === 0) return
    console.log(`[cleanupTasksForDoi] 清理 ${matching.length} 个任务:`, matching.map((t: BackgroundTask) => `${t.id}(${t.status})`))
    for (const t of matching) {
      if (t.status === 'running' || t.status === 'pending') {
        try { await tq.abort_task(t.id) } catch {}
      }
      try { await tq.remove_task(t.id) } catch {}
    }
  } catch (e) {
    console.warn('[cleanupTasksForDoi] 失败（不阻塞删除）:', e)
  }
}

/**
 * 异步删除 GitHub 文件 + race cleanup（fire-and-forget，不阻塞 UI）
 * Phase1 立即删，Phase2/3 race retry 放后台 setTimeout(5s) 跑。
 * 返回 Promise<{deletedCount, phase1Ok}> —— Phase1 完成就 resolve。
 */
export async function deleteLiteratureFilesFast(
  doi: string,
  owner: string,
  repo: string,
  token: string,
): Promise<{ deletedCount: number; phase1Ok: boolean; error?: string }> {
  try {
    // Phase 1: 立即删（同步等它完成，因为用户点了删除就期望文件真的消失）
    const paths1 = await collectLiteratureFilePaths(doi)
    if (paths1.length > 0) {
      await deleteRepoFiles(
        paths1,
        `chore: delete literature ${doi.slice(0, 30)}`,
        owner, repo, token,
      )
      console.log(`[deleteFilesFast] phase1 删除 ${paths1.length} 个文件`)
    } else {
      console.log(`[deleteFilesFast] phase1: 无文件可删`)
    }

    // Phase 2/3: 后台 setTimeout 做 race cleanup（5 秒后，不阻塞）
    setTimeout(async () => {
      try {
        const paths2 = await collectLiteratureFilePaths(doi)
        if (paths2.length > 0) {
          console.log(`[deleteFilesFast] phase2 发现 ${paths2.length} 个残留（race 回写），异步重试删除`)
          await deleteRepoFiles(
            paths2,
            `chore: retry delete literature ${doi.slice(0, 30)} (race)`,
            owner, repo, token,
          )
        }
        const remaining = await collectLiteratureFilePaths(doi)
        if (remaining.length > 0) {
          console.warn(`[deleteFilesFast] ⚠️ 仍有 ${remaining.length} 个残留（新 pipeline 正在跑？）`)
        } else {
          console.log(`[deleteFilesFast] phase2 race cleanup OK — 干净`)
        }
      } catch (e) {
        console.warn(`[deleteFilesFast] phase2 失败（忽略）:`, e)
      }
    }, 5000)

    return { deletedCount: paths1.length, phase1Ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { deletedCount: 0, phase1Ok: false, error: msg }
  }
}

/**
 * 一站式级联清理（**不含**文献 CSV 行本身的移除）。
 *
 * 供追踪页「撤销入库」这类"文献行移除 + 关联物件清理"的场景直接调用：
 *   清任务队列 → 删 GitHub 文件 → 清学习数据 CSV → 摘项目引用。
 *
 * 管理页删除因要夹带 savePapers / 元数据的乐观回滚，仍自行编排各原子步骤；
 * 这里只是把"除文献行之外该清理的全部"打包，避免调用方漏步骤。
 *
 * 返回各步失败清单（空数组 / null = 成功），由调用方如实上报。
 */
export async function cascadeCleanupLiterature(dois: string[]): Promise<{
  csvErrors: string[]
  fileErrors: string[]
  refError: string | null
}> {
  const targets = dois.filter((d) => (d || '').trim())
  if (targets.length === 0) return { csvErrors: [], fileErrors: [], refError: null }

  // 1. 任务队列
  for (const d of targets) await cleanupTasksForDoi(d)

  // 2. GitHub 文件（Phase1 同步；Phase2 在各自函数里后台跑）
  const fileErrors: string[] = []
  const ctx = getRepoContextForDelete()
  if (ctx) {
    for (const d of targets) {
      const r = await deleteLiteratureFilesFast(d, ctx.owner, ctx.repo, ctx.token)
      if (!r.phase1Ok) fileErrors.push(d)
    }
  }

  // 3. 学习数据 CSV（一次批量清）
  const csvErrors = await purgeLiteratureObjects(targets)

  // 4. 项目引用（悬空引用清理）
  let refError: string | null = null
  try {
    await removeLibraryReferences('paper', targets)
  } catch (e) {
    refError = e instanceof Error ? e.message : String(e)
  }

  return { csvErrors, fileErrors, refError }
}
