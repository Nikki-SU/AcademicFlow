/**
 * 文献管理服务
 * -------------------------------------------------
 * SPEC §3：所有文献数据存储在 GitHub 私库。
 * - literatures/literatures.csv — 文献元数据表
 * - literatures/{doi-slug}/full.md — MinerU 原始正文 Markdown（用 MinerU 产物的原名，不再改名）
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
 * 根据标题/期刊名自动推断文献等级（tier）：
 *   1 = 一级文献（原创研究论文）
 *   2 = 二级文献（综述 / meta 分析 / 进展评述等二手文献）
 *
 * 判定依据是综述类标题的高频特征词（大小写不敏感、按词边界匹配），
 * 如 review / survey / overview / meta-analysis / advances / progress 等。
 * 拿不准时默认一级（原创研究的数量远多于综述）。
 */
const SECONDARY_TIER_PATTERNS: RegExp[] = [
  /\breview\b/i,
  /\breviews\b/i,
  /\bsurvey\b/i,
  /\bsurveys\b/i,
  /\boverview\b/i,
  /\bmeta[- ]analysis\b/i,
  /\bsystematic\b.{0,40}\b(study|review|analysis)\b/i,
  /\badvances?\b/i,
  /\bprogress\b/i,
  /\bperspective[s]?\b/i,
  /\bcurrent\s+(challenges?|status|developments?|opinions?)\b/i,
  /\brecent\s+(developments?|progress|advances?)\b/i,
  /\bstate[- ]of[- ]the[- ]art\b/i,
  /\bminireview\b/i,
  /\btutorial\b/i,
  /\bcommentary\b/i,
  /\bcritical\s+assessment\b/i,
]

export function inferPaperTier(title: string, journal?: string): 1 | 2 {
  const t = title || ''
  const j = journal || ''
  if (!t && !j) return 1
  // 期刊名本身就是综述刊（Chemical Reviews / Chemical Society Reviews 等）的强特征
  if (/reviews?\b|annual\s+review|current\s+opinion|trends\s+in/i.test(j)) return 2
  return SECONDARY_TIER_PATTERNS.some((re) => re.test(t)) ? 2 : 1
}

/**
 * 从 GitHub git trees 一次性拿全仓库文件列表，用来校验 mdStatus
 * 返回 Map<path, size>，包含所有 literatures/ 下的文件及其字节数
 */
async function fetchLiteratureFileSet(): Promise<Map<string, number> | null> {
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
    const map = new Map<string, number>()
    for (const entry of (data.tree ?? []) as Array<{ path: string; type: string; size?: number }>) {
      if (entry.type === 'blob' && entry.path.startsWith('literatures/')) {
        map.set(entry.path, entry.size ?? 0)
      }
    }
    return map
  } catch {
    return null
  }
}

/**
 * 导出给「清理 PDF」面板用：一次性拿全仓库 literatures/ 下文件清单（Map<path,size>）
 */
export async function fetchLiteratureFiles(): Promise<Map<string, number> | null> {
  return fetchLiteratureFileSet()
}

/** 小于该字节数的 {slug}.md 视为空壳（runner 历史 bug 会留下 1 字节假成功文件） */
const MIN_VALID_ALIGNED_BYTES = 50

/**
 * 根据 GitHub 上实际文件推断 mdStatus
 *   - 有 {slug}.md（且非空壳）→ done（全流程完成）
 *   - 有 full.md 或只有空壳 {slug}.md → converting（MinerU 成功，post-mineru 未完成/失败）
 *   - 什么都没有 → none
 * 注：full.md 是 MinerU 原始产物名；fulltext.md 是 2026-09 之前的旧名，一并兼容读取。
 */
function inferMdStatusFromFiles(doi: string, fileSet: Map<string, number>): MdStatus {
  const slug = doiToSlug(doi)
  const alignedSize = fileSet.get(`literatures/${slug}/${slug}.md`)
  if (alignedSize !== undefined && alignedSize >= MIN_VALID_ALIGNED_BYTES) return 'done'
  if (fileSet.has(`literatures/${slug}/full.md`)) return 'converting'
  if (fileSet.has(`literatures/${slug}/fulltext.md`)) return 'converting'
  // 空壳 {slug}.md 也按未完成处理，提示用户重跑转换
  if (alignedSize !== undefined) return 'converting'
  return 'none'
}

/**
 * 仅凭 GitHub 实际文件推断某篇文献的 mdStatus（不读 CSV）。
 * 供后端 progress.json 缺失、且任务未记录 run_id 时的兜底判定，
 * 避免前端任务队列永远卡在 running。
 */
export async function inferMdStatusByDoi(doi: string): Promise<MdStatus | null> {
  const fileSet = await fetchLiteratureFileSet()
  if (!fileSet) return null
  return inferMdStatusFromFiles(doi, fileSet)
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

/**
 * saveLiteratures — 前端只管写元数据，状态字段完全信任 GitHub
 *
 * 两类字段：
 *   元数据（前端写）：doi, title, journal, year, authors, keywords,
 *                    abstract_en, abstract_cn, tier, has_graphical_abstract
 *   状态字段（GitHub 权威）：added_at, pdf_added_at, source, tracking_group, md_status
 *
 * 典型冲突：Bot 刚把 md_status 改成 done，用户点编辑保存元数据，
 * 前端内存里还拿着 md_status=none → 旧逻辑会把 done 覆盖回 none。
 * 现在从源头剥掉：前端写前先读 GitHub，把状态字段 merge 回来。
 */
export async function saveLiteratures(literatures: Literature[]): Promise<void> {
  // 1. 读 GitHub 最新 CSV，按 doi 建 map
  let githubMap: Map<string, Literature> | null = null
  try {
    const currentOnGithub = await loadLiteratures(true) // force 跳过缓存
    githubMap = new Map(currentOnGithub.map((l) => [l.doi, l]))
  } catch {
    console.warn('[saveLiteratures] 读 GitHub 最新 CSV 失败，状态字段可能不准确但继续写入')
  }

  // 2. merge：元数据用前端的，状态字段用 GitHub 的
  const toWrite = literatures.map((lit) => {
    const gh = githubMap?.get(lit.doi)
    if (!gh) {
      // 新文献（GitHub 上还没有）→ added_at 用前端值，md_status 默认 none
      return lit
    }
    return {
      ...lit,
      addedAt: gh.addedAt,
      pdfAddedAt: gh.pdfAddedAt,
      source: gh.source,
      trackingGroup: gh.trackingGroup,
      mdStatus: gh.mdStatus, // ✅ 关键：永远不覆盖 Bot 的 md_status
    }
  })

  try {
    await writeCsvFile(
      LITERATURES_PATH,
      toWrite,
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
    console.log(`[saveLiteratures] OK — ${toWrite.length} 条写入 (状态字段来自 GitHub)`)
  } catch (err) {
    console.error(`[saveLiteratures] FAIL — 写入 ${LITERATURES_PATH} 失败:`, err)
    throw err
  }
}

export async function loadFulltext(doi: string): Promise<string> {
  const slug = doiToSlug(doi)
  // 标准路径 full.md（MinerU 原始产物名，不改名）；
  // 兼容 fulltext.md（2026-09 之前的旧名）与 index.md（更旧）。
  let result = await readMdFile(`literatures/${slug}/full.md`)
  if (!result) result = await readMdFile(`literatures/${slug}/fulltext.md`)
  if (!result) {
    result = await readMdFile(`literatures/${slug}/index.md`)
    if (result) {
      console.warn(
        `[loadFulltext] ${doi} 只有旧路径 index.md，新版应使用 full.md。下次转换会自动写入 full.md。`,
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
  // 注意：空白内容（如历史 bug 留下的 1 字节空壳 {slug}.md）必须当作不存在，
  // 否则阅读页会显示空白而不是回退到 fulltext.md 的英文原文。
  // 新版：{slug}.md（标准路径，知识库唯一 md）
  let result = await readMdFile(`literatures/${slug}/${slug}.md`)
  if (result?.content?.trim()) return result.content
  // 兼容：旧版 aligned.md
  result = await readMdFile(`literatures/${slug}/aligned.md`)
  if (result?.content?.trim()) return result.content
  // 兼容：MinerU 原始产物（纯原文，无译文）
  result = await readMdFile(`literatures/${slug}/full.md`)
  if (result?.content?.trim()) return result.content
  result = await readMdFile(`literatures/${slug}/fulltext.md`)
  if (result?.content?.trim()) return result.content
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
 * 保留：{slug}.md（主文件）、full.md / fulltext.md / index.md（MinerU 原始产物，永不删）、
 *       images/ 文件夹、vocabulary.csv、annotations.csv
 */
export async function cleanupLegacyMd(doi: string): Promise<void> {
  const slug = doiToSlug(doi)
  // ⚠️ 不要在这里加 full.md / fulltext.md / index.md：
  // 它们是 MinerU 的原始产物（阅读页图片与英文原文的来源），删除会导致重跑 MinerU。
  // 也不要加 images/（阅读页图片一直需要正常显示）。
  const paths = [
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
  await writeMdFile(`literatures/${slug}/full.md`, content, 'Update full.md')
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
