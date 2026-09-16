/**
 * 文献管理服务
 * -------------------------------------------------
 * SPEC §3：所有文献数据存储在 GitHub 私库。
 * - literatures/literatures.csv — 文献元数据表
 * - literatures/{doi-slug}/fulltext.md — 正文 Markdown
 * - literatures/{doi-slug}/abstract_en.md — 英文摘要
 * - literatures/{doi-slug}/abstract_cn.md — 中文摘要
 * - literatures/{doi-slug}/annotations/ — 批注目录
 * - literatures/{doi-slug}/notes.md — 阅读笔记
 */

import { readCsvFile, writeCsvFile, readMdFile, writeMdFile } from './userData'
import { useWorkspaceStore } from '../stores/workspace'
import { useAuthStore } from '../stores/auth'
import { githubFetch } from './github'

export type MdStatus = 'none' | 'converting' | 'done' | 'failed'

export interface Literature {
  doi: string
  title: string
  journal: string
  year: number
  authors: string
  keywords: string
  abstractEn: string
  abstractCn: string
  tier: number
  hasGraphicalAbstract: boolean
  addedAt: number
  pdfAddedAt: number
  source: string
  trackingGroup: string
  mdStatus: MdStatus
}

const LITERATURES_PATH = 'literatures/literatures.csv'
const LITERATURE_HEADERS = [
  'doi', 'title', 'journal', 'year', 'authors', 'keywords',
  'abstract_en', 'abstract_cn', 'tier', 'has_graphical_abstract',
  'added_at', 'pdf_added_at', 'source', 'tracking_group',
  'md_status',
]

export function doiToSlug(doi: string): string {
  return encodeURIComponent(doi).replace(/%2F/g, '_').replace(/\./g, '-')
}

/**
 * 从 GitHub git trees 一次性拿全仓库文件列表，用来校验 mdStatus
 * 返回 Set<string>，包含所有 literatures/ 下的文件路径
 */
async function fetchLiteratureFileSet(): Promise<Set<string> | null> {
  const ws = useWorkspaceStore.getState()
  const token = useAuthStore.getState().token
  if (!ws.repo || !token) return null
  try {
    const res = await githubFetch(
      `/repos/${ws.repo.owner.login}/${ws.repo.name}/git/trees/main?recursive=1`,
      token,
    )
    if (!res.ok) return null
    const data = await res.json()
    const set = new Set<string>()
    for (const entry of (data.tree ?? []) as Array<{ path: string; type: string }>) {
      if (entry.type === 'blob' && entry.path.startsWith('literatures/')) {
        set.add(entry.path)
      }
    }
    return set
  } catch {
    return null
  }
}

/**
 * 根据 GitHub 上实际文件推断 mdStatus
 *   - 有 {slug}.md → done（全流程完成）
 *   - 有 fulltext.md → converting（MinerU 成功，post-mineru 未完成/失败）
 *   - 什么都没有 → none
 */
function inferMdStatusFromFiles(doi: string, fileSet: Set<string>): MdStatus {
  const slug = doiToSlug(doi)
  if (fileSet.has(`literatures/${slug}/${slug}.md`)) return 'done'
  if (fileSet.has(`literatures/${slug}/fulltext.md`)) return 'converting'
  return 'none'
}

export async function loadLiteratures(force = false): Promise<Literature[]> {
  // 并行：读 CSV + 拉 git trees（用来校验 mdStatus）
  const [rows, fileSet] = await Promise.all([
    readCsvFile(LITERATURES_PATH, (rows) => rows, force).catch(() => [] as string[][]),
    fetchLiteratureFileSet(),
  ])

  if (!rows || rows.length <= 1) return []

  const EXPECTED_COLS = LITERATURE_HEADERS.length // 15
  const results: Literature[] = []
  const dirtyRows: number[] = []

  rows.slice(1).forEach((r, idx) => {
    const rowNum = idx + 1 // 含 header
    // ======= 脏行跳过条件 =======
    if (!r || r.length === 0) return
    const doi = (r[0] || '').trim()
    if (!doi) {
      dirtyRows.push(rowNum)
      console.warn(`[loadLiteratures] row ${rowNum}: doi 为空，跳过 (r=${JSON.stringify(r.slice(0, 5))})`)
      return
    }

    let fixedRow = r

    // ======= 列数修复 =======
    if (r.length !== EXPECTED_COLS) {
      if (r.length < EXPECTED_COLS) {
        // 尾部补空
        fixedRow = [...r, ...Array(EXPECTED_COLS - r.length).fill('')]
      } else {
        // 列数过多 → 中间字段被逗号拆散
        // 策略：从后往前保留最后 7 列是可靠的
        // （tier, has_graphical_abstract, added_at, pdf_added_at, source, tracking_group, md_status）
        // 合并中间被拆散的字段（authors, keywords, abstract_en, abstract_cn）
        const tail7 = r.slice(-7)
        const head3 = r.slice(0, 3) // doi, title, journal — 通常不会被拆散
        const year = r[3] || ''
        // positions 4 to r.length-7 全部合并成 authors
        const mergedMiddle = r.slice(4, r.length - 7).join(', ')
        fixedRow = [...head3, year, mergedMiddle, '', '', '', ...tail7]
        if (fixedRow.length !== EXPECTED_COLS) {
          dirtyRows.push(rowNum)
          console.warn(`[loadLiteratures] row ${rowNum}: 列数不匹配 (${r.length} vs ${EXPECTED_COLS})，修复后 ${fixedRow.length} 列，跳过`)
          return
        }
        dirtyRows.push(rowNum)
        console.warn(`[loadLiteratures] row ${rowNum}: 列数不匹配 (${r.length} vs ${EXPECTED_COLS})，已自动修复`)
      }
    }

    const csvStatus: MdStatus = (fixedRow[14] as MdStatus) || 'none'
    // 如果 git trees 可用，以 GitHub 实际文件为准（权威来源）
    const inferredStatus = fileSet
      ? inferMdStatusFromFiles(doi, fileSet)
      : csvStatus
    // 但如果 CSV 明确标 failed，保留（git trees 无法区分 failed 和 converting）
    const finalStatus: MdStatus =
      csvStatus === 'failed' ? 'failed' : inferredStatus

    results.push({
      doi,
      title: fixedRow[1] || '',
      journal: fixedRow[2] || '',
      year: parseInt(fixedRow[3] || '0', 10),
      authors: fixedRow[4] || '',
      keywords: fixedRow[5] || '',
      abstractEn: fixedRow[6] || '',
      abstractCn: fixedRow[7] || '',
      tier: parseInt(fixedRow[8] || '0', 10),
      hasGraphicalAbstract: fixedRow[9] === 'true',
      addedAt: parseInt(fixedRow[10] || '0', 10),
      pdfAddedAt: parseInt(fixedRow[11] || '0', 10),
      source: fixedRow[12] || '',
      trackingGroup: fixedRow[13] || '',
      mdStatus: finalStatus,
    })
  })

  if (dirtyRows.length > 0) {
    console.warn(`[loadLiteratures] 共 ${dirtyRows.length} 行脏数据（rows ${dirtyRows.join(', ')}），已修复 ${dirtyRows.length - (rows.length - 1 - results.length)} 行`)
  }

  return results
}

/** md_status 优先级（越高越"终态"），用来防止前端覆盖 Bot 的进度更新 */
const MD_STATUS_RANK: Record<MdStatus, number> = {
  none: 0,
  converting: 1,
  failed: 2,
  done: 3,
}

export async function saveLiteratures(literatures: Literature[]): Promise<void> {
  // ======= 乐观锁：先读 GitHub 上最新 CSV，保护 Bot 刚写入的 md_status =======
  // 典型冲突场景：Bot 刚把某篇 md_status 改成 done，前端还拿着旧值（none），
  // 点保存就把 done 覆盖回 none，Bot 白干了。
  let githubStatusMap: Map<string, MdStatus> | null = null
  try {
    const currentOnGithub = await loadLiteratures(true) // force 跳过缓存
    githubStatusMap = new Map(currentOnGithub.map((l) => [l.doi, l.mdStatus]))
  } catch {
    // 读失败（网络抖动、repo 未就绪等）→ 降级为不保护，让写入继续
    console.warn('[saveLiteratures] 读 GitHub 最新状态失败，跳过 md_status 保护')
  }

  // 冲突检测：GitHub 上 rank 更高的 md_status 保留，不被前端覆盖
  const protectedLiteratures = literatures.map((lit) => {
    if (!githubStatusMap) return lit
    const githubStatus = githubStatusMap.get(lit.doi)
    if (!githubStatus) return lit
    const frontendRank = MD_STATUS_RANK[lit.mdStatus] ?? 0
    const githubRank = MD_STATUS_RANK[githubStatus] ?? 0
    if (githubRank > frontendRank) {
      console.info(
        `[saveLiteratures] 保护 ${lit.doi}: GitHub 上是 ${githubStatus}(rank ${githubRank})，` +
        `前端要写 ${lit.mdStatus}(rank ${frontendRank}) → 保留 GitHub 的值`,
      )
      return { ...lit, mdStatus: githubStatus }
    }
    return lit
  })

  try {
    await writeCsvFile(
      LITERATURES_PATH,
      protectedLiteratures,
      LITERATURE_HEADERS,
      (lit) => [
        lit.doi,
        lit.title,
        lit.journal,
        String(lit.year),
        lit.authors,
        lit.keywords,
        lit.abstractEn,
        lit.abstractCn,
        String(lit.tier),
        String(lit.hasGraphicalAbstract),
        String(lit.addedAt),
        String(lit.pdfAddedAt),
        lit.source,
        lit.trackingGroup,
        lit.mdStatus || 'none',
      ],
    )
    console.log(`[saveLiteratures] OK — ${protectedLiteratures.length} 条写入 ${LITERATURES_PATH}`)
  } catch (err) {
    console.error(`[saveLiteratures] FAIL — 写入 ${LITERATURES_PATH} 失败:`, err)
    throw err
  }
}

export async function loadFulltext(doi: string): Promise<string> {
  const slug = doiToSlug(doi)
  // 新版写 fulltext.md；旧版（2026-09-11 之前）写 index.md —— 都要兼容
  let result = await readMdFile(`literatures/${slug}/fulltext.md`)
  if (!result) {
    result = await readMdFile(`literatures/${slug}/index.md`)
    if (result) {
      console.warn(
        `[loadFulltext] ${doi} 只有旧路径 index.md，新版应使用 fulltext.md。下次转换会自动写入 fulltext.md。`,
      )
    }
  }
  return result?.content || ''
}

export async function loadTranslation(doi: string): Promise<string> {
  const slug = doiToSlug(doi)
  const result = await readMdFile(`literatures/${slug}/translation.md`)
  return result?.content || ''
}

export async function saveTranslation(doi: string, content: string): Promise<void> {
  const slug = doiToSlug(doi)
  await writeMdFile(`literatures/${slug}/translation.md`, content, 'Save AI translation')
}

export async function loadAlignedMd(doi: string): Promise<string> {
  const slug = doiToSlug(doi)
  // 新版：{slug}.md（标准路径，知识库唯一 md）
  let result = await readMdFile(`literatures/${slug}/${slug}.md`)
  if (result) return result.content || ''
  // 兼容：旧版 aligned.md
  result = await readMdFile(`literatures/${slug}/aligned.md`)
  if (result) return result.content || ''
  // 兼容：更旧的 fulltext.md（纯原文，无译文）
  result = await readMdFile(`literatures/${slug}/fulltext.md`)
  if (result) return result.content || ''
  // 兼容：最旧的 index.md
  result = await readMdFile(`literatures/${slug}/index.md`)
  return result?.content || ''
}

export async function saveAlignedMd(doi: string, content: string): Promise<void> {
  const slug = doiToSlug(doi)
  // 标准路径：literatures/{slug}/{slug}.md —— 进入知识库的唯一 md
  await writeMdFile(`literatures/${slug}/${slug}.md`, content, 'Save aligned (canonical) markdown')
  // 清理旧文件（fulltext.md / index.md / translation.md / aligned.md）
  await cleanupLegacyMd(doi)
}

/**
 * 清理旧版遗留的 md 文件。aligned.md 写入后，这些中间产物不再需要。
 * 保留：{slug}.md（主文件）、images/ 文件夹、vocabulary.csv、annotations.csv
 */
export async function cleanupLegacyMd(doi: string): Promise<void> {
  const slug = doiToSlug(doi)
  const paths = [
    `literatures/${slug}/fulltext.md`,
    `literatures/${slug}/index.md`,
    `literatures/${slug}/translation.md`,
    `literatures/${slug}/aligned.md`,
  ]
  const ws = useWorkspaceStore.getState()
  const token = useAuthStore.getState().token
  if (!ws.repo || !token) return

  // 逐个尝试删除，404 跳过（文件本来就不存在），其他错误警告
  const { deleteRepoFiles } = await import('./github')
  for (const p of paths) {
    try {
      await deleteRepoFiles([p], `chore: cleanup legacy ${p}`, ws.repo.owner.login, ws.repo.name, token)
      console.log(`[cleanupLegacyMd] 已删除 ${p}`)
    } catch (e: any) {
      // 404 = 文件不存在，正常跳过；其他错误才警告
      if (e?.message?.includes('404') || e?.status === 404) continue
      console.warn(`[cleanupLegacyMd] 删除 ${p} 失败（非关键）:`, e?.message ?? e)
    }
  }
}

export async function saveFulltext(doi: string, content: string): Promise<void> {
  const slug = doiToSlug(doi)
  await writeMdFile(`literatures/${slug}/fulltext.md`, content, 'Update fulltext')
}

export async function loadNotes(doi: string): Promise<string> {
  const slug = doiToSlug(doi)
  const result = await readMdFile(`literatures/${slug}/notes.md`)
  return result?.content || ''
}

export async function saveNotes(doi: string, content: string): Promise<void> {
  const slug = doiToSlug(doi)
  await writeMdFile(`literatures/${slug}/notes.md`, content, 'Update reading notes')
}

/**
 * 便捷 helper：根据 DOI 直接更新 CSV 里某篇 paper 的 mdStatus
 * 不依赖任何组件 state — executor 跨页面跑时可以放心调用
 */
export async function updatePaperMdStatus(doi: string, mdStatus: MdStatus): Promise<void> {
  const lits = await loadLiteratures()
  const updated = lits.map((l) =>
    l.doi === doi ? { ...l, mdStatus } : l,
  )
  await saveLiteratures(updated)
}
