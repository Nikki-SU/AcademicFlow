/**
 * 本地工作区（Local Workspace）
 *
 * 通过 File System Access API 取得用户某个本地文件夹的读写授权，并在该文件夹内
 * 自动维护一套「任务制」文件结构：
 *
 *   选中文件夹（＝工作区根）
 *   ├─ 索引.csv                     ← 本地处理台账
 *   ├─ 研究
 *   │   ├─ 研究任务A
 *   │   │   ├─ 文献/   图书/   其他文档/   其他文档/image/
 *   │   │   └─ 研究任务A子任务A/…（子任务，内部同样三分类）
 *   │   └─ 研究任务B/…
 *   └─ 课程
 *       └─ 课程任务A/…
 *
 * 用户把 PDF / Word / Markdown 丢进对应分类文件夹，本模块扫描后按分类走各自的上游管线：
 * - 文献/*.pdf        → 解析 / 匹配 DOI → 入库文献 → enqueuePaperMineruConvert
 * - 图书/*.pdf        → 入库图书      → enqueueBookMineruConvert
 * - 其他文档/*.docx|.doc|.pdf → 入库文档 → enqueueDocConvert
 * - 其他文档/*.md|.markdown|.txt → 直接导入（importMarkdownDocs）
 *
 * 架构定位（为什么这样设计）：
 * - 静态前端无法在后台监视本地磁盘，用户私库的 GitHub Actions 也读不到本地磁盘；
 *   因此本地文件夹只是「投递口」，真正的数据真源仍是用户私库。
 * - 扫描只在「页面打开时」和「顶栏手动按钮」触发，不做 3:00 定时任务。
 */

import { toast } from 'sonner'
import {
  getFsHandle,
  putFsHandle,
  deleteFsHandle,
} from './db'
import { getRepoContext } from './userData'
import { enqueuePaperMineruConvertBatch } from './paperPipeline'
import { enqueueBookMineruConvert } from './bookPipeline'
import { enqueueDocConvert } from './docPipeline'
import {
  loadLiteratures,
  saveLiteratures,
  inferPaperTier,
  type Literature,
} from './literatureData'
import {
  normalizeDoi,
  isSameDoi,
  searchCrossref,
  type OnlineSearchResult,
} from './citation'
import {
  loadTextbooks,
  saveTextbooks,
  bookHasContent,
  type Textbook,
} from './textbookData'
import {
  loadDocuments,
  saveDocuments,
  docHasContent,
  documentSlug,
  titleFromFileName,
  importMarkdownDocs,
  type DocEntry,
} from './documentData'
import { loadMaterialMeta, saveMaterialMeta, setMeta } from './materialMeta'
import { loadProjects, type Project } from './projectData'
import { callAI } from './ai/client'
import { callWebSearch } from './ai/web-search'
import { useSettingsStore } from '../stores/settings'
import type { AISlotConfig } from '../types'

// ============================================================
// 常量
// ============================================================

/** 工作区根下的台账文件名 */
export const WORKSPACE_INDEX_FILE = '索引.csv'
/** 研究任务根目录 */
export const RESEARCH_DIR = '研究'
/** 课程任务根目录 */
export const COURSE_DIR = '课程'
/** 文献分类目录 */
export const PAPER_DIR = '文献'
/** 图书分类目录 */
export const BOOK_DIR = '图书'
/** 其他文档分类目录 */
export const DOC_DIR = '其他文档'
/** 其他文档下的图片目录（仅创建，不参与转换） */
export const IMAGE_DIR = 'image'

const CATEGORY_DIRS = [PAPER_DIR, BOOK_DIR, DOC_DIR] as const
export type WorkspaceCategory = (typeof CATEGORY_DIRS)[number]

/** 索引.csv 列序（逐字） */
export const INDEX_HEADERS = [
  '路径',
  '类型',
  '所属任务',
  '原文件名',
  '状态',
  '处理时间',
  '备注',
] as const

/** 台账状态 */
export type LedgerStatus = '已入库' | '处理中' | '失败' | '跳过' | '重复跳过'

/** 可直接走 doc_convert 的扩展名（后端管线只吃这三种） */
const DOC_CONVERT_EXT = new Set(['doc', 'docx', 'pdf'])
/** 直接导入的文本扩展名 */
const MARKDOWN_EXT = new Set(['md', 'markdown', 'txt'])

// ============================================================
// 类型
// ============================================================

/** 索引.csv 的本地台账行 */
export interface WorkspaceIndexRow {
  path: string
  category: string
  task: string
  originalName: string
  status: LedgerStatus
  processedAt: string
  note: string
}

/** 工作区状态（供 UI 显示） */
export interface WorkspaceInfo {
  /** 浏览器是否支持 File System Access API */
  supported: boolean
  /** 已授权文件夹名；未授权为 null */
  name: string | null
  /** 当前读权限状态；未授权为 null */
  permission: PermissionState | null
}

/** pickWorkspace 结果 */
export interface PickWorkspaceResult {
  ok: boolean
  name?: string
  /** 用户在系统弹窗里取消了选择 */
  canceled?: boolean
  error?: string
}

/** 单个文件的扫描结果（供 UI 展示） */
export interface ScanItemResult {
  path: string
  category: string
  task: string
  name: string
  status: LedgerStatus
  note: string
}

/** 一次扫描的汇总 */
export interface ScanResult {
  ok: boolean
  error?: string
  scanned: number
  ingested: number
  failed: number
  skipped: number
  items: ScanItemResult[]
}

// ============================================================
// 本地 CSV 读写（索引.csv 在工作区本地，不走私库）
// ============================================================

function csvEscapeLocal(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}

/**
 * RFC4180 风格 CSV 解析。索引.csv 由本模块写入，格式受控；
 * 解析层只兜「引号 / 逗号 / 换行」这类标准形态。
 */
function parseCsvLocal(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

async function readWorkspaceIndex(
  root: FileSystemDirectoryHandle,
): Promise<WorkspaceIndexRow[]> {
  let file: File | null = null
  try {
    const fh = await root.getFileHandle(WORKSPACE_INDEX_FILE)
    file = await fh.getFile()
  } catch {
    return []
  }
  let text = ''
  try {
    text = await file.text()
  } catch {
    return []
  }
  const rows = parseCsvLocal(text)
  if (rows.length <= 1) return []
  const out: WorkspaceIndexRow[] = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    if (!r || r.length === 0 || (r.length === 1 && r[0] === '')) continue
    out.push({
      path: r[0] ?? '',
      category: r[1] ?? '',
      task: r[2] ?? '',
      originalName: r[3] ?? '',
      status: (r[4] as LedgerStatus) ?? '失败',
      processedAt: r[5] ?? '',
      note: r[6] ?? '',
    })
  }
  return out
}

async function writeWorkspaceIndex(
  root: FileSystemDirectoryHandle,
  rows: WorkspaceIndexRow[],
): Promise<void> {
  const lines = [INDEX_HEADERS.join(',')]
  for (const r of rows) {
    lines.push(
      [r.path, r.category, r.task, r.originalName, r.status, r.processedAt, r.note]
        .map(csvEscapeLocal)
        .join(','),
    )
  }
  const fh = await root.getFileHandle(WORKSPACE_INDEX_FILE, { create: true })
  const w = await fh.createWritable()
  await w.write(lines.join('\n') + '\n')
  await w.close()
}

function nowStamp(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

// ============================================================
// 授权 / 句柄
// ============================================================

/** 浏览器是否支持目录授权 */
export function isWorkspaceSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

/** 读取已保存的工作区句柄与当前权限（不弹窗） */
export async function getWorkspaceInfo(): Promise<WorkspaceInfo> {
  if (!isWorkspaceSupported()) return { supported: false, name: null, permission: null }
  const row = await getFsHandle()
  if (!row) return { supported: true, name: null, permission: null }
  let permission: PermissionState = 'prompt'
  try {
    permission = await row.handle.queryPermission({ mode: 'readwrite' })
  } catch {
    permission = 'prompt'
  }
  return { supported: true, name: row.name, permission }
}

/** 弹出系统文件夹选择器，取得工作区根目录并持久化句柄 */
export async function pickWorkspace(): Promise<PickWorkspaceResult> {
  if (!isWorkspaceSupported()) {
    return { ok: false, error: '当前浏览器不支持本地文件夹授权（File System Access API）' }
  }
  let handle: FileSystemDirectoryHandle
  try {
    handle = await window.showDirectoryPicker({ id: 'academicflow-workspace', mode: 'readwrite' })
  } catch (err) {
    const name = (err as { name?: string })?.name
    if (name === 'AbortError') return { ok: false, canceled: true }
    return { ok: false, error: `选择文件夹失败：${(err as Error)?.message || String(err)}` }
  }
  try {
    await putFsHandle(handle)
  } catch (err) {
    return { ok: false, error: `保存文件夹授权失败：${(err as Error)?.message || String(err)}` }
  }
  return { ok: true, name: handle.name }
}

/**
 * 取回可用句柄。permission 不足时：
 * - interactive=true：调用 requestPermission 申请（需用户手势触发）
 * - interactive=false：直接返回 null，静默降级
 */
export async function ensureWorkspacePermission(
  interactive: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  if (!isWorkspaceSupported()) return null
  const row = await getFsHandle()
  if (!row) return null
  try {
    const cur = await row.handle.queryPermission({ mode: 'readwrite' })
    if (cur === 'granted') return row.handle
    if (!interactive) return null
    const asked = await row.handle.requestPermission({ mode: 'readwrite' })
    return asked === 'granted' ? row.handle : null
  } catch {
    return null
  }
}

/** 忘记当前工作区（清除保存的句柄） */
export async function forgetWorkspace(): Promise<void> {
  await deleteFsHandle()
}

// ============================================================
// 目录结构生成
// ============================================================

/** 去掉文件名里的非法路径字符，作为文件夹名 */
function sanitizeFolderName(name: string): string {
  const s = name
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
  return s || '未命名任务'
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '').trim() || name
}

interface TaskIndex {
  /** parentId → 子任务列表 */
  byParent: Map<string | null, Project[]>
  /** 文件夹名（已 sanitize）→ Project */
  byFolder: Map<string, Project>
}

function buildTaskIndex(projects: Project[]): TaskIndex {
  const byParent = new Map<string | null, Project[]>()
  const byFolder = new Map<string, Project>()
  for (const p of projects) {
    const key = p.parentId || null
    const list = byParent.get(key) ?? []
    list.push(p)
    byParent.set(key, list)
    byFolder.set(sanitizeFolderName(p.title), p)
  }
  return { byParent, byFolder }
}

async function ensureProjectFolders(
  parent: FileSystemDirectoryHandle,
  project: Project,
  idx: TaskIndex,
): Promise<void> {
  const dir = await parent.getDirectoryHandle(sanitizeFolderName(project.title), { create: true })
  await dir.getDirectoryHandle(PAPER_DIR, { create: true })
  await dir.getDirectoryHandle(BOOK_DIR, { create: true })
  const docsDir = await dir.getDirectoryHandle(DOC_DIR, { create: true })
  await docsDir.getDirectoryHandle(IMAGE_DIR, { create: true })
  for (const child of idx.byParent.get(project.projectId) ?? []) {
    await ensureProjectFolders(dir, child, idx)
  }
}

/**
 * 按当前应用内的任务树，在工作区里补齐标准目录结构，并确保索引.csv 存在。
 * 不传 root 时自动取已授权句柄（需用户手势后调用）。
 */
export async function ensureStructure(root?: FileSystemDirectoryHandle): Promise<void> {
  let dir = root
  if (!dir) {
    const handle = await ensureWorkspacePermission(true)
    if (!handle) throw new Error('尚未授权本地工作区文件夹')
    dir = handle
  }
  // 索引.csv 不存在则建表头
  try {
    await dir.getFileHandle(WORKSPACE_INDEX_FILE)
  } catch {
    await writeWorkspaceIndex(dir, [])
  }
  // 研究 / 课程 → 任务树
  const projects = await loadProjects()
  const idx = buildTaskIndex(projects)
  for (const rootType of [RESEARCH_DIR, COURSE_DIR] as const) {
    const typeDir = await dir.getDirectoryHandle(rootType, { create: true })
    const typeKey = rootType === RESEARCH_DIR ? 'research' : 'course'
    for (const p of idx.byParent.get(null) ?? []) {
      if (p.type !== typeKey) continue
      await ensureProjectFolders(typeDir, p, idx)
    }
  }
}

// ============================================================
// 扫描 / 分类
// ============================================================

interface FoundFile {
  relSegs: string[]
  handle: FileSystemFileHandle
}

async function walkFiles(
  dir: FileSystemDirectoryHandle,
  base: string[] = [],
): Promise<FoundFile[]> {
  const out: FoundFile[] = []
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith('.')) continue
    if (base.length === 0 && name === WORKSPACE_INDEX_FILE) continue
    if (handle.kind === 'directory') {
      const sub = await walkFiles(handle as FileSystemDirectoryHandle, [...base, name])
      out.push(...sub)
    } else if (handle.kind === 'file') {
      out.push({ relSegs: [...base, name], handle: handle as FileSystemFileHandle })
    }
  }
  return out
}

interface Classification {
  category: WorkspaceCategory
  /** 分类目录所在的父任务文件夹名（可能为空：文件直接放在分类目录下却没有上级任务） */
  taskFolder: string
}

/**
 * 按「最近的分类目录祖先」判定文件分类。
 * 例：研究/任务A/文献/x.pdf → 文献；任务是「任务A」
 *     研究/任务A/子任务A/文献/x.pdf → 文献；任务是「子任务A」（取分类目录的上一级）
 */
function classify(relSegs: string[]): Classification | null {
  const folders = relSegs.slice(0, -1)
  for (let i = folders.length - 1; i >= 0; i--) {
    const seg = folders[i]
    if ((CATEGORY_DIRS as readonly string[]).includes(seg)) {
      return { category: seg as WorkspaceCategory, taskFolder: folders[i - 1] ?? '' }
    }
  }
  return null
}

function extOf(name: string): string {
  const m = name.match(/\.([^.]+)$/)
  return m ? m[1].toLowerCase() : ''
}

// ============================================================
// AI：把「名称不对的 PDF」匹配到已有 DOI / 联网找 DOI
// ============================================================

/** 从 AI 文本里取出 JSON 对象（只兜代码块围栏与前后夹带） */
function extractJsonObject(raw: string): Record<string, unknown> {
  let s = raw.trim()
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    throw new Error('AI 返回中未找到 JSON 对象')
  }
  const parsed = JSON.parse(s.slice(start, end + 1))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI 返回不是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

function getAi1(): AISlotConfig {
  const { ai1 } = useSettingsStore.getState().getDualEngineConfig()
  return ai1
}

/**
 * 在候选 DOI 列表里做 AI 匹配（约束：只能命中候选，不得编造）。
 * 返回命中的候选 DOI；无匹配返回空串。
 */
async function aiMatchDoiFromCandidates(
  pdfName: string,
  candidates: { doi: string; title: string }[],
  ai: AISlotConfig,
): Promise<string> {
  if (candidates.length === 0) return ''
  const list = candidates.map((c) => `- DOI: ${c.doi} | 标题: ${c.title || '（无标题）'}`).join('\n')
  const system =
    '你是学术文献匹配助手。你只能从给定的候选文献中选择，绝对不得编造或改写 DOI。'
  const user = [
    '任务：给定一个 PDF 文件名与一份候选文献列表，判断该 PDF 最可能对应哪一条候选文献。',
    '规则：',
    '1) 只能返回候选列表中出现过的 DOI，且必须逐字照抄；',
    '2) 若没有任何一条候选与之明显匹配，返回空字符串；',
    '3) 不要输出任何解释。',
    '只返回如下 JSON（不要 markdown 代码块包裹，不要多余文字），键名必须逐字一致：',
    '{ "doi": "候选列表中的某个 DOI，或空字符串" }',
    '',
    `PDF 文件名：${pdfName}`,
    '候选文献：',
    list,
    '',
    '现在只输出 JSON：',
  ].join('\n')
  const res = await callAI({
    baseUrl: ai.baseUrl,
    apiKey: ai.apiKey,
    model: ai.model,
    temperature: 0,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })
  const obj = extractJsonObject(res.content)
  const raw = typeof obj.doi === 'string' ? obj.doi.trim() : ''
  if (!raw) return ''
  return candidates.find((c) => isSameDoi(c.doi, raw))?.doi ?? ''
}

/** 在 Crossref 候选里做 AI 选择（约束同 aiMatchDoiFromCandidates） */
async function aiPickCrossref(
  pdfName: string,
  candidates: OnlineSearchResult[],
  ai: AISlotConfig,
): Promise<string> {
  return aiMatchDoiFromCandidates(
    pdfName,
    candidates.map((c) => ({ doi: c.doi, title: c.title })),
    ai,
  )
}

/** 从联网检索内容里抽取 DOI（约束：必须是合法 DOI，否则空串） */
async function aiExtractDoiFromWeb(
  title: string,
  webContent: string,
  ai: AISlotConfig,
): Promise<string> {
  const system = '你是文献信息抽取助手。只输出结构化 JSON，不得输出解释文字。'
  const user = [
    '任务：根据下面这段联网检索结果，判断该文献的 DOI。',
    '规则：',
    '1) 只返回确定的 DOI；若无法确定，返回空字符串；',
    '2) DOI 必须是形如 10.xxxx/xxxx 的合法 DOI 字符串；',
    '3) 不要编造，找不到就留空。',
    '只返回如下 JSON（不要 markdown 代码块包裹，不要多余文字），键名必须逐字一致：',
    '{ "doi": "10.xxxx/xxxx 或空字符串" }',
    '',
    `文献标题（推测）：${title}`,
    '联网检索结果：',
    webContent.slice(0, 6000),
    '',
    '现在只输出 JSON：',
  ].join('\n')
  const res = await callAI({
    baseUrl: ai.baseUrl,
    apiKey: ai.apiKey,
    model: ai.model,
    temperature: 0,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })
  const obj = extractJsonObject(res.content)
  const raw = typeof obj.doi === 'string' ? obj.doi.trim() : ''
  const norm = normalizeDoi(raw)
  return norm.valid && norm.doi ? norm.doi : ''
}

interface ResolvedDoi {
  doi: string
  title: string
  method: string
}

/**
 * 为一份文献 PDF 解析 DOI（按可信度从高到低逐级尝试）：
 * 1) 文件名里直接含有合法 DOI；
 * 2) 与库中「已录入 DOI 但还没导入 PDF」的文献做 AI 匹配（用户说的补 PDF 场景）；
 * 3) Crossref 按标题模糊检索 → AI 在候选里挑选；
 * 4) AI 联网检索 → 抽取 DOI。
 * 全部失败返回 null（不猜，交给调用方报可读错误）。
 */
async function resolvePaperDoi(
  fileName: string,
  titleGuess: string,
): Promise<ResolvedDoi | null> {
  // 1) 文件名自带 DOI（优先用去掉扩展名的版本，避免把 .pdf 吃进 DOI）
  const byStripped = normalizeDoi(stripExt(fileName))
  if (byStripped.valid && byStripped.doi) {
    return { doi: byStripped.doi, title: titleGuess, method: '文件名含 DOI' }
  }
  const byRaw = normalizeDoi(fileName)
  if (byRaw.valid && byRaw.doi) {
    return { doi: byRaw.doi, title: titleGuess, method: '文件名含 DOI' }
  }

  const ai = getAi1()

  // 2) 库内「待补 PDF」文献 AI 匹配
  const lits = await loadLiteratures()
  const noPdf = lits.filter((l) => l.doi && !l.pdfAddedAt)
  if (noPdf.length > 0) {
    const matched = await aiMatchDoiFromCandidates(
      fileName,
      noPdf.map((l) => ({ doi: l.doi, title: l.title })),
      ai,
    )
    if (matched) {
      const hit = lits.find((l) => isSameDoi(l.doi, matched))
      return { doi: matched, title: hit?.title || titleGuess, method: 'AI 匹配库内待补 PDF 文献' }
    }
  }

  // 3) Crossref 模糊检索 + AI 选择
  try {
    const cands = await searchCrossref(titleGuess, 10)
    if (cands.length > 0) {
      const pick = await aiPickCrossref(fileName, cands, ai)
      if (pick) {
        const hit = cands.find((c) => isSameDoi(c.doi, pick))
        return { doi: pick, title: hit?.title || titleGuess, method: 'Crossref 检索 + AI 确认' }
      }
    }
  } catch {
    // 网络/接口异常 → 进入下一级
  }

  // 4) AI 联网检索
  try {
    const ws = await callWebSearch({
      system: '你是学术文献检索助手，联网查找指定文献并给出其官方 DOI。',
      user: `请联网检索这篇文献并提供其 DOI：${titleGuess}（PDF 文件名：${fileName}）。请给出 DOI 原文与来源链接。`,
    })
    const doi = await aiExtractDoiFromWeb(titleGuess, ws.content, ai)
    if (doi) return { doi, title: titleGuess, method: 'AI 联网检索' }
  } catch {
    // 兜底失败
  }

  return null
}

// ============================================================
// 各类文件的入库
// ============================================================

interface IngestOutcome {
  status: LedgerStatus
  note: string
}

async function attachTask(
  type: 'paper' | 'book' | 'document',
  id: string,
  taskId: string,
): Promise<void> {
  if (!taskId) return
  const meta = await loadMaterialMeta()
  await saveMaterialMeta(setMeta(meta, type, id, { taskId }))
}

/**
 * 文献 PDF 的「解析 + 去重 + 落库」阶段（不含派发）。
 * - 解析出 DOI 且需要转换：返回待派发信息 { doi, title, method }
 * - 解析失败 / 重复：直接返回终态 outcome（不进入批次）
 *
 * 派发统一由 scanWorkspace 收集成批次后一次性 dispatch（避免逐篇触发被
 * GitHub concurrency group 顶掉）。
 */
async function preparePaperForQueue(
  fileName: string,
): Promise<{ queue: { doi: string; title: string; method: string } } | { outcome: IngestOutcome }> {
  const titleGuess = stripExt(fileName)
  let resolved: ResolvedDoi | null
  try {
    resolved = await resolvePaperDoi(fileName, titleGuess)
  } catch (err) {
    return { outcome: { status: '失败', note: `DOI 解析失败：${(err as Error)?.message || String(err)}` } }
  }
  if (!resolved) {
    return {
      outcome: {
        status: '失败',
        note: '无法确定 DOI（文件名无 DOI、库内无匹配、联网检索失败），请手动补 DOI 后重试',
      },
    }
  }

  const lits = await loadLiteratures()
  const doi = resolved.doi
  const existing = lits.find((l) => isSameDoi(l.doi, doi))
  if (existing && existing.pdfAddedAt) {
    return { outcome: { status: '重复跳过', note: `库中已有 DOI ${doi} 且已导入 PDF` } }
  }

  const title = resolved.title || titleGuess
  if (!existing) {
    const now = Date.now()
    const newLit: Literature = {
      doi,
      title,
      journal: '',
      year: 0,
      authors: '',
      keywords: '',
      abstractEn: '',
      abstractCn: '',
      tier: inferPaperTier(title),
      hasGraphicalAbstract: false,
      addedAt: now,
      pdfAddedAt: now,
      source: '本地工作区',
      trackingGroup: '',
      mdStatus: 'none',
      correspondingAuthor: '',
    }
    await saveLiteratures([...lits, newLit])
  }

  return { queue: { doi, title, method: resolved.method } }
}

/** 图书 PDF：书名入库 → 走 MinerU 管线 */
async function ingestBook(file: File, fileName: string, taskId: string): Promise<IngestOutcome> {
  const title = stripExt(fileName)
  const books = await loadTextbooks()
  const existing = books.find((b) => b.textbookId === title)
  if (existing && (await bookHasContent(title))) {
    return { status: '重复跳过', note: `图书「${title}」已存在且已转换` }
  }
  if (!existing) {
    const newBook: Textbook = {
      textbookId: title,
      title,
      author: '',
      publisher: '',
      year: 0,
      notes: '来自本地工作区',
      addedAt: Date.now(),
    }
    await saveTextbooks([...books, newBook])
  }

  const r = await enqueueBookMineruConvert(title, file, title)
  if (!r.ok) return { status: '失败', note: r.error || 'MinerU 入队失败' }

  await attachTask('book', title, taskId)
  return { status: '已入库', note: `图书「${title}」` }
}

/** 其他文档（Word / PDF）：入库 → 走 doc_convert 管线 */
async function ingestDoc(file: File, fileName: string, taskId: string): Promise<IngestOutcome> {
  const title = stripExt(fileName)
  const docId = documentSlug(title)
  const docs = await loadDocuments()
  const existing = docs.find((d) => d.documentId === docId)
  if (existing && (await docHasContent(docId))) {
    return { status: '重复跳过', note: `文档「${title}」已存在且已转换` }
  }
  if (!existing) {
    const newDoc: DocEntry = {
      documentId: docId,
      title,
      author: '',
      source: '本地工作区',
      addedAt: Date.now(),
    }
    await saveDocuments([...docs, newDoc])
  }

  const r = await enqueueDocConvert(docId, file, title)
  if (!r.ok) return { status: '失败', note: r.error || '转换入队失败' }

  await attachTask('document', docId, taskId)
  return { status: '已入库', note: `文档「${title}」` }
}

/** 其他文档下的 .md/.txt：直接导入 */
async function ingestMarkdown(
  file: File,
  fileName: string,
  taskId: string,
): Promise<IngestOutcome> {
  const content = await file.text()
  if (!content.trim()) return { status: '跳过', note: '空文件' }
  const title = titleFromFileName(fileName)
  const created = await importMarkdownDocs([{ title, content, source: '本地工作区' }])
  const id = created[0]?.id
  if (id) await attachTask('document', id, taskId)
  return { status: '已入库', note: `Markdown「${title}」` }
}

// ============================================================
// 扫描主流程
// ============================================================

let _scanning = false

/**
 * 扫描工作区并处理新文件。
 * - 先补齐目录结构与索引.csv；
 * - 遍历全树，按分类目录判定类型；
 * - 已在台账中「已入库/处理中」的路径直接跳过（失败的可重试）；
 * - 逐个处理并回写台账。
 */
export async function scanWorkspace(): Promise<ScanResult> {
  const empty: ScanResult = { ok: false, scanned: 0, ingested: 0, failed: 0, skipped: 0, items: [] }
  if (_scanning) return { ...empty, error: '已有扫描正在进行中' }
  if (!isWorkspaceSupported()) {
    return { ...empty, error: '当前浏览器不支持本地文件夹授权' }
  }
  const root = await ensureWorkspacePermission(true)
  if (!root) return { ...empty, error: '尚未授权本地工作区文件夹（请先选择工作区）' }
  if (!getRepoContext()) {
    return { ...empty, error: '未登录或私库未配置：无法入库，请先完成设置' }
  }

  _scanning = true
  try {
    await ensureStructure(root)

    const projects = await loadProjects()
    const idx = buildTaskIndex(projects)
    const files = await walkFiles(root)
    const ledger = await readWorkspaceIndex(root)
    const ledgerMap = new Map(ledger.map((r) => [r.path, r]))

    const items: ScanItemResult[] = []
    let ingested = 0
    let failed = 0
    let skipped = 0

    // 文献 PDF 先解析 / 去重 / 落库，收集成批次，扫完后一次性派发（避免逐篇触发
    // 在 GitHub concurrency group 里互相顶掉）。其余类型边扫边处理。
    interface PaperSlot {
      slot: number
      taskId: string
      file: File
      doi: string
      title: string
      method: string
    }
    const paperSlots: PaperSlot[] = []
    const slotInfo: { relPath: string; category: string; taskLabel: string; name: string }[] = []
    const slotOutcome: (IngestOutcome | null)[] = []

    for (const found of files) {
      const cls = classify(found.relSegs)
      if (!cls) continue
      const ext = extOf(found.relSegs[found.relSegs.length - 1])

      // 该分类目录下，本模块能处理的扩展名
      let actionable = false
      if (cls.category === PAPER_DIR || cls.category === BOOK_DIR) {
        actionable = ext === 'pdf'
      } else {
        actionable = DOC_CONVERT_EXT.has(ext) || MARKDOWN_EXT.has(ext)
      }
      if (!actionable) continue

      const relPath = found.relSegs.join('/')
      const existingRow = ledgerMap.get(relPath)
      if (existingRow && (existingRow.status === '已入库' || existingRow.status === '处理中')) {
        continue
      }

      const task = idx.byFolder.get(cls.taskFolder)
      const taskId = task?.projectId ?? ''
      const taskLabel = task?.title ?? ''
      const name = found.relSegs[found.relSegs.length - 1]

      let outcome: IngestOutcome | null = null
      try {
        const file = await found.handle.getFile()
        if (cls.category === PAPER_DIR) {
          const pre = await preparePaperForQueue(name)
          if ('queue' in pre) {
            const slot = slotInfo.length
            slotInfo.push({ relPath, category: cls.category, taskLabel, name })
            slotOutcome.push(null)
            paperSlots.push({ slot, taskId, file, doi: pre.queue.doi, title: pre.queue.title, method: pre.queue.method })
            continue
          }
          outcome = pre.outcome
        } else if (cls.category === BOOK_DIR) {
          outcome = await ingestBook(file, name, taskId)
        } else if (MARKDOWN_EXT.has(ext)) {
          outcome = await ingestMarkdown(file, name, taskId)
        } else {
          outcome = await ingestDoc(file, name, taskId)
        }
      } catch (err) {
        outcome = { status: '失败', note: (err as Error)?.message || String(err) }
      }

      slotInfo.push({ relPath, category: cls.category, taskLabel, name })
      slotOutcome.push(outcome)
    }
    // ── 批次派发：所有文献 PDF 一次 dispatch ──
    if (paperSlots.length > 0) {
      let batch: Awaited<ReturnType<typeof enqueuePaperMineruConvertBatch>>
      try {
        batch = await enqueuePaperMineruConvertBatch(
          paperSlots.map((p) => ({ doi: p.doi, title: p.title, file: p.file })),
        )
      } catch (err) {
        batch = { ok: false, results: [], error: (err as Error)?.message || String(err) }
      }
      for (let i = 0; i < paperSlots.length; i++) {
        const p = paperSlots[i]
        const r = batch.results[i]
        if (r && r.ok) {
          try {
            await attachTask('paper', p.doi, p.taskId)
          } catch { /* 不阻塞 */ }
          slotOutcome[p.slot] = { status: '已入库', note: `DOI ${p.doi}（${p.method}）` }
        } else {
          slotOutcome[p.slot] = { status: '失败', note: r?.error || batch.error || 'MinerU 入队失败' }
        }
      }
    }

    // ── 汇总：按扫描顺序回写台账 + 结果 ──
    for (let i = 0; i < slotInfo.length; i++) {
      const info = slotInfo[i]
      const outcome: IngestOutcome = slotOutcome[i] || { status: '失败', note: '未处理' }

      if (outcome.status === '已入库' || outcome.status === '处理中') ingested++
      else if (outcome.status === '失败') failed++
      else skipped++

      const row: WorkspaceIndexRow = {
        path: info.relPath,
        category: info.category,
        task: info.taskLabel,
        originalName: info.name,
        status: outcome.status,
        processedAt: nowStamp(),
        note: outcome.note,
      }
      ledgerMap.set(info.relPath, row)
      items.push({
        path: info.relPath,
        category: info.category,
        task: info.taskLabel,
        name: info.name,
        status: outcome.status,
        note: outcome.note,
      })
    }

    await writeWorkspaceIndex(root, [...ledgerMap.values()].sort((a, b) => a.path.localeCompare(b.path)))

    return {
      ok: true,
      scanned: files.length,
      ingested,
      failed,
      skipped,
      items,
    }
  } catch (err) {
    return { ...empty, error: (err as Error)?.message || String(err) }
  } finally {
    _scanning = false
  }
}

/** 扫描是否正在进行 */
export function isScanning(): boolean {
  return _scanning
}

// ============================================================
// UI 便捷封装
// ============================================================

/**
 * 确保工作区可用（未授权就弹窗选择），返回是否就绪。
 * 成功一律静默（UX 规则：只有失败才弹窗）——授权结果由调用方的面板展示。
 */
export async function ensureWorkspaceReady(): Promise<boolean> {
  const info = await getWorkspaceInfo()
  if (!info.supported) {
    toast.error('当前浏览器不支持本地工作区')
    return false
  }
  if (!info.name) {
    const picked = await pickWorkspace()
    if (!picked.ok) {
      if (!picked.canceled) toast.error(picked.error || '选择工作区失败')
      return false
    }
    return true
  }
  const handle = await ensureWorkspacePermission(true)
  if (!handle) {
    toast.error('工作区授权已失效，请重新选择文件夹')
    return false
  }
  return true
}

/**
 * 手动扫描（顶栏按钮 / 工作区面板调用）：确保就绪 → 扫描。
 * 成功 / 普通进度一律静默（UX 规则：只有失败才弹窗）；失败才 toast.error，
 * 完整结果由调用方（工作区面板）展示。
 */
export async function runManualScan(): Promise<ScanResult | null> {
  const ready = await ensureWorkspaceReady()
  if (!ready) return null
  const result = await scanWorkspace()
  if (!result.ok) {
    toast.error(result.error || '扫描失败')
    return result
  }
  if (result.failed > 0) {
    toast.error(`扫描完成：${result.failed} 个文件处理失败，详见工作区面板`)
  }
  return result
}
