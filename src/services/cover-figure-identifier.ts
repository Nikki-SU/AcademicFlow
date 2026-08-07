/**
 * 题图识别服务（双引擎兜底）
 * -------------------------------------------------
 * 论文 PDF 经 MinerU 解析后会产生多张图片，其中一张是"题图
 * （graphical abstract / cover figure）"——能代表全文核心的单图。
 *
 * 本服务复用 dual-engine.ts 的完整双引擎基础设施：
 *   - AI-1：拿【源材料】（markdown 中所有图片引用 + caption + 上下文）→
 *     判断哪张图最可能是题图，给出图片名 + 理由
 *   - AI-2：拿 (源材料, AI-1 判断) → 核查 AI-1 引用的 caption / 位置 /
 *     关键词是否真实存在于源材料中（引证锚定）
 *   - 分层归因重试：AI-1 编造 caption → 重写；AI-2 编造 span → 自纠
 *
 * 注：当前 AI-1/AI-2 走文本推理（看 caption 关键词、位置、上下文），
 * 不直接看图片像素。这是 v1 兜底方案，足以覆盖大多数"caption 含
 * graphical abstract / TOC / scheme 1"的典型场景。
 */
import { runDualEngine } from './ai/dual-engine'
import type { DualEngineProgressCallback } from '../types'

/** 单张图片在 markdown 中的上下文快照（喂给 AI-1 的源材料片段） */
export interface CoverFigureCandidate {
  /** 图片在 zip 中的相对路径，如 images/abc123.jpg */
  imageName: string
  /** markdown 中的 alt 文本（![alt](url) 的 alt 部分） */
  alt: string
  /** 图片在 markdown 中出现的 0-based 序号 */
  position: number
  /** 图片引用前后的上下文（前后各 ~200 字符） */
  contextBefore: string
  contextAfter: string
}

/** 识别结果 */
export interface CoverFigureIdentificationResult {
  /** 选中的图片名（zip 内相对路径）；未识别到合适候选时为 null */
  chosenImage: string | null
  /** AI-1 给出的判断理由 */
  reason: string
  /** AI-2 是否通过核查（引证锚定 + 忠实性） */
  reviewPassed: boolean
  /** AI-2 整体评价 */
  ai2Summary: string
  /** 双引擎跑了几轮 */
  attempts: number
}

/**
 * 从 markdown 中抽取所有图片候选（含 alt、位置、上下文）
 */
export function extractImageCandidates(markdown: string): CoverFigureCandidate[] {
  const candidates: CoverFigureCandidate[] = []
  // 匹配 ![alt](url) 形式（兼容空 alt）
  const regex = /!\[([^\]]*)\]\(([^)]+)\)/g
  let match: RegExpExecArray | null
  let idx = 0
  while ((match = regex.exec(markdown)) !== null) {
    const alt = match[1] || ''
    const url = match[2] || ''
    const start = match.index
    const end = start + match[0].length
    const contextBefore = markdown.slice(Math.max(0, start - 200), start).trim()
    const contextAfter = markdown.slice(end, Math.min(markdown.length, end + 200)).trim()
    candidates.push({
      imageName: url,
      alt,
      position: idx,
      contextBefore,
      contextAfter,
    })
    idx++
  }
  return candidates
}

/**
 * 把候选列表序列化成 AI-1 可读的源材料块
 */
function formatCandidatesAsSource(candidates: CoverFigureCandidate[]): string {
  if (candidates.length === 0) return '（markdown 中未发现任何图片引用）'
  return candidates
    .map((c, i) => {
      return [
        `### 图片 #${i} (position=${c.position})`,
        `imageName: ${c.imageName}`,
        `alt: ${c.alt || '(空)'}`,
        `contextBefore: ${c.contextBefore.slice(-150)}`,
        `contextAfter: ${c.contextAfter.slice(0, 150)}`,
      ].join('\n')
    })
    .join('\n\n')
}

/** 解析 AI-1 输出的 JSON：{ chosenImage, reason } */
interface ParsedJudgment {
  chosenImage: string | null
  reason: string
}
function parseJudgment(raw: string): ParsedJudgment {
  let text = raw.trim()
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) text = fenceMatch[1].trim()
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1)
  }
  try {
    const parsed = JSON.parse(text) as Partial<ParsedJudgment>
    return {
      chosenImage: typeof parsed.chosenImage === 'string' && parsed.chosenImage.length > 0
        ? parsed.chosenImage
        : null,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    }
  } catch {
    // 兜底：从正文里尝试找图片名
    const nameMatch = raw.match(/(images\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|gif|bmp|webp))/i)
    return {
      chosenImage: nameMatch ? nameMatch[1] : null,
      reason: raw.slice(0, 500),
    }
  }
}

/**
 * 识别题图（双引擎兜底）
 * -------------------------------------------------
 * @param params.markdown 文献的 markdown 全文（含 ![](images/xxx.jpg) 引用）
 * @param params.ai1 AI-1 端点配置
 * @param params.ai2 AI-2 端点配置
 * @param params.onProgress 可选的双引擎进度回调
 */
export async function identifyCoverFigure(params: {
  markdown: string
  ai1: { baseUrl: string; apiKey: string; model: string }
  ai2: { baseUrl: string; apiKey: string; model: string }
  onProgress?: DualEngineProgressCallback
}): Promise<CoverFigureIdentificationResult> {
  const { markdown, ai1, ai2, onProgress } = params

  // 1. 从 markdown 抽取所有图片候选 + 上下文
  const candidates = extractImageCandidates(markdown)
  if (candidates.length === 0) {
    return {
      chosenImage: null,
      reason: 'markdown 中未发现任何图片引用，无法识别题图',
      reviewPassed: false,
      ai2Summary: '无候选图片',
      attempts: 0,
    }
  }
  // 只有一张图：直接返回，无需调用 AI
  if (candidates.length === 1) {
    return {
      chosenImage: candidates[0].imageName,
      reason: '文献中只有一张图片，直接作为题图',
      reviewPassed: true,
      ai2Summary: '单图无需审阅',
      attempts: 0,
    }
  }

  // 2. 构造源材料 = 所有图片候选的上下文快照（唯一 ground truth）
  const sourceMaterial = [
    '【源材料：文献 markdown 中所有图片引用的上下文快照】',
    formatCandidatesAsSource(candidates),
    '',
    '【文献前 800 字（提供整体上下文）】',
    markdown.slice(0, 800),
  ].join('\n')

  // 3. AI-1 角色 prompt：替换默认的"学术总结助手"为"题图识别助手"
  //    [NOT_IN_SOURCE] tag 指令由 dual-engine 自动追加
  const ai1RolePrompt = [
    '你是一名学术文献版面分析助手。用户会提供一段【源材料】（文献 markdown 中所有图片引用的上下文快照）',
    '和一条【任务指令】，你需要按指令判断哪张图最可能是题图（graphical abstract / cover figure）。',
    '',
    '【核心约束（必须严格遵守）】',
    '1. 只使用【源材料】中的信息，禁止引入源材料未提及的外部知识、常识或对该文献主题的预判。',
    '2. 判断依据必须能在源材料中找到字面对应：caption 关键词（如 "graphical abstract" / "TOC" / "scheme"）、',
    '   图片在 markdown 中的位置（position）、alt 文本、上下文叙述。',
    '3. 忠于原文字面含义，不编造 caption、不编造 alt、不编造 position。',
    '4. 若源材料信息不足以判断，宁可返回 chosenImage=null，也不要凭偏好猜测。',
    '5. 输出严格 JSON 格式，不要任何额外文字、不要 markdown 代码块包裹。',
  ].join('\n')

  // 4. AI-1 任务指令：定义输出 JSON schema + 判断规则
  const ai1Instruction = [
    '请基于上述源材料，判断哪张图片最可能是该文献的题图（graphical abstract / cover figure）。',
    '题图通常具有以下特征（按优先级）：',
    '1. caption / alt / 上下文中含 "graphical abstract"、"TOC"、"cover figure"、"scheme 1" 等关键词',
    '2. 出现在文献开头（position 较小），且上下文是概述性内容而非具体实验结果',
    '3. 一张能代表全文核心机制的图，而非具体数据图 / 表格截图 / 公式截图',
    '',
    '【输出格式（严格 JSON，不要 markdown 代码块包裹）】',
    '{',
    '  "chosenImage": "选中的图片 imageName（必须与源材料中某条 imageName 完全一致），无合适候选时为 null",',
    '  "reason": "中文判断理由，需引用源材料中的具体 caption / position / 关键词作为依据"',
    '}',
    '',
    '【严格要求】',
    '- chosenImage 必须是源材料中出现过的某个 imageName 字面值，禁止编造图片名',
    '- reason 中引用的 caption / alt / position 必须与源材料字面一致',
    '- 源材料未涉及的信息用 [NOT_IN_SOURCE] <字段名> 标注',
  ].join('\n')

  // 5. 调用双引擎（AI-1 判断 + AI-2 核查 + 引证锚定 + 分层归因重试）
  const dualResult = await runDualEngine({
    taskType: 'faithfulness_check',
    sourceMaterial,
    ai1Instruction,
    ai1,
    ai2,
    ai1RolePrompt,
    onProgress,
  })

  // 6. 解析 AI-1 输出 + 兜底校验（chosenImage 必须在候选列表中）
  const parsed = parseJudgment(dualResult.ai1Output)
  const validImageNames = new Set(candidates.map((c) => c.imageName))
  if (parsed.chosenImage && !validImageNames.has(parsed.chosenImage)) {
    // AI-1 编造了图片名（双引擎未拦住的兜底）：置为 null
    parsed.chosenImage = null
    parsed.reason = `${parsed.reason}\n\n[兜底校验] AI-1 给出的 chosenImage 不在候选列表中，已置为 null`
  }

  return {
    chosenImage: parsed.chosenImage,
    reason: parsed.reason,
    reviewPassed: dualResult.finalPassed,
    ai2Summary: dualResult.ai2Feedback.summary || '',
    attempts: dualResult.attempts.length,
  }
}

/**
 * 把识别出的题图重命名为 graphical-abstract.{ext}
 * -------------------------------------------------
 * 用于在 mineru-storage 保存前，把识别命中的图片名改成约定俗成的
 * "graphical-abstract.{ext}"，方便 Management 页面直接展示。
 */
export function renameCoverImage(
  images: Record<string, Blob>,
  chosenImage: string | null,
): { images: Record<string, Blob>; renamedFrom: string | null } {
  if (!chosenImage || !images[chosenImage]) {
    return { images, renamedFrom: null }
  }
  // 提取扩展名
  const extMatch = chosenImage.match(/\.([a-zA-Z0-9]+)$/)
  const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg'
  const newName = `graphical-abstract.${ext}`

  // 复制 blob 到新 key，删除旧 key
  const newImages: Record<string, Blob> = {}
  for (const [k, v] of Object.entries(images)) {
    if (k === chosenImage) {
      newImages[newName] = v
    } else {
      newImages[k] = v
    }
  }
  return { images: newImages, renamedFrom: chosenImage }
}
