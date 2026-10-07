/**
 * AI 交付文件 —— 前端侧解析与落库
 * -------------------------------------------------
 * 背景：任何「问 AI」的功能都应允许 AI 把成篇成果作为**独立文件**交付，
 * 并自动存成全局「其他文档」、归入当前任务 —— 否则 AI 的产出就只是一段
 * 聊不回来的文本，没人会真的用它。
 *
 * 交付契约（与后端 dual_engine_runner.mjs 逐字一致）：
 *     @@FILE@@{"title":"文件名（不含扩展名）"}
 *     文件的完整 Markdown 正文
 *     @@END_FILE@@
 *
 * 两条链路的分工：
 *   - 双引擎（可信检索）链路：后端 runner 在 AI-2 核查**之前**就把交付块从
 *     ai1Output 剥离（否则会被判「编造内容 added」并被重写删除），随结果返回
 *     deliveredFiles —— 前端直接落库即可，不解析文本。
 *   - 联网问答链路：后端 web_search 是无状态的 DeepSeek 直连，没有交付机制，
 *     于是前端从回复正文里解析 @@FILE@@ 块（本文件的 parseDeliveredFileBlocks）。
 *
 * 「先约束，再容错」：契约要求 title 是**同行**的合法 JSON；解析失败时
 * **不猜标题**（留空，界面提示），但正文是 AI 的真实产出，予以保留落库。
 */
import type { DeliveredFile } from '../../types'
import { importMarkdownDocs, type DocumentSummary } from '../documentData'
import { loadMaterialMeta, saveMaterialMeta, setMeta } from '../materialMeta'

const FILE_START = '@@FILE@@'
const FILE_END = '@@END_FILE@@'

/**
 * 交付指令（供前端解析链路——联网问答——追加进 prompt）。
 * 双引擎链路的同款指令在后端 runner 里（deliverFiles opt-in），二者契约一致。
 */
export const DELIVER_FILES_PROMPT = [
  '',
  '【文件交付（你可以把成篇成果作为独立文件交付给用户）】',
  '当你产出的内容适合单独保存成一份完整文档（如完整的报告、清单、大纲、表格汇编、代码文件等）时，',
  '**必须**用下面的固定标记块把每个文件包起来，标记块放在回答正文之后：',
  `     ${FILE_START}{"title":"文件名（不含扩展名，简洁中文）"}`,
  '     文件的完整 Markdown 正文',
  `     ${FILE_END}`,
  `1. ${FILE_START} 后面**必须紧跟一个合法 JSON**，且只含 "title" 一个字段（字符串）；不要加任何别的字段，不要用代码块包 JSON。`,
  '2. 标记块与正文之间不要插入任何说明文字；标记块本身不会被当作回答正文。',
  '3. 一个文件一个标记块；没有需要单独保存的成果时，**不要**输出任何标记块。',
  '4. 交付文件的内容同样只依据你已有的依据，不确定的地方明确说明，不要编造。',
].join('\n')

/** 文本里是否含交付块（廉价判断，供调用方跳过无谓处理） */
export function hasDeliveredFileBlock(raw: string): boolean {
  return String(raw ?? '').includes(FILE_START)
}

/**
 * 从任意 AI 文本里解析 @@FILE@@ 交付块。
 * 返回：剥离交付块后的正文（供界面展示）+ 文件清单。
 */
export function parseDeliveredFileBlocks(raw: string): {
  content: string
  files: DeliveredFile[]
} {
  const lines = String(raw ?? '').split('\n')
  const kept: string[] = []
  const files: DeliveredFile[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].trim().startsWith(FILE_START)) {
      const metaText = lines[i].trim().slice(FILE_START.length).trim()
      let title = ''
      try {
        const m = JSON.parse(metaText)
        title = typeof m?.title === 'string' ? m.title.trim() : ''
      } catch {
        // 契约要求 title 是同行合法 JSON；解析失败不猜标题（留空由界面提示）
        title = ''
      }
      const body: string[] = []
      let j = i + 1
      while (j < lines.length && lines[j].trim() !== FILE_END) {
        body.push(lines[j])
        j++
      }
      const content = body.join('\n').trim()
      if (content) files.push({ title, content })
      i = j < lines.length ? j + 1 : j
      continue
    }
    kept.push(lines[i])
    i++
  }
  return { content: kept.join('\n').trim(), files }
}

/**
 * 把交付的文件注册为全局「其他文档」，并归入指定任务。
 * 复用 importMarkdownDocs（正文先写、索引后写，顺序不可反）；
 * 随后按 taskId 写 materials/meta.csv 归属。
 */
export async function registerDeliveredFiles(
  files: DeliveredFile[],
  taskId: string | null,
): Promise<DocumentSummary[]> {
  const usable = files.filter((f) => f.content.trim())
  if (usable.length === 0) return []

  const added = await importMarkdownDocs(
    usable.map((f) => ({
      // 标题缺失时用固定文案兜底（确定、可读），不猜一个「看起来合理」的名字
      title: f.title.trim() || 'AI 交付文件',
      source: 'AI 交付',
      content: f.content,
    })),
  )

  if (taskId && added.length > 0) {
    let meta = await loadMaterialMeta(true)
    for (const a of added) meta = setMeta(meta, 'document', a.id, { taskId })
    await saveMaterialMeta(meta)
  }

  return added
}

/** 界面「交付回执」条目（各入口共用；只带标题，正文已在文档库里） */
export interface DeliveredFileChip {
  title: string
}

/**
 * 交付文件落库 + 转成界面回执 chip —— 各「问 AI」入口共用的一段收尾逻辑。
 * 失败时向上抛错，由各入口决定怎么提示（服务层不耦合具体 toast）。
 */
export async function deliverFilesToTask(
  files: DeliveredFile[] | undefined,
  taskId: string,
): Promise<DeliveredFileChip[]> {
  if (!files || files.length === 0) return []
  const added = await registerDeliveredFiles(files, taskId || null)
  return added.map((d) => ({ title: d.title }))
}
