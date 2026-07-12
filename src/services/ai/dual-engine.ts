/**
 * AI 双引擎编排（AI-1 生成 + AI-2 忠实性核查）
 * -------------------------------------------------
 * SPEC v0.3 §9.2 · M3.5 语义 + M3.5.1 分阶段进度回调
 *
 * 语义（M3.5 起，替换 M3 版）：
 *   - AI-1: 拿用户提供的**源材料**（ground truth）+ 用户指令 → 生成总结
 *   - AI-2: 拿 (源材料, AI-1 总结) → 逐句核查总结的**忠实性**
 *     - supported / added（AI-1 加戏）/ contradicted（AI-1 曲解）
 *   - 前端锚定校验：AI-2 给出的 source_span 必须能在源材料中 grep 到，
 *     否则判定"AI-2 编造引用"，强制降级 passed=false。
 *
 * M3.5.1 新增：
 *   - runDualEngine 接受可选 onProgress 回调
 *   - 在 AI-1 前后、AI-2 前后、锚定校验前后、错误路径触发进度事件
 *   - AI-1 完成时把 ai1Output 提前推给 UI，让用户不必等 AI-2 也能看到进展
 */
import type {
  AIRequest,
  DualEngineProgressCallback,
  DualEngineResult,
  DualEngineTaskType,
  EvidenceCheck,
  FaithfulnessClaim,
  FaithfulnessVerdict,
} from '../../types'
import { callAI } from './client'

/** 双引擎单侧配置 */
export interface DualEngineSideConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/** 双引擎运行参数（M3.5 + M3.5.1） */
export interface DualEngineRunParams {
  taskType: DualEngineTaskType
  /** 源材料原文 —— 唯一 ground truth */
  sourceMaterial: string
  /** 给 AI-1 的指令（如"简洁忠实地总结"） */
  ai1Instruction: string
  ai1: DualEngineSideConfig
  ai2: DualEngineSideConfig
  /** M3.5.1: 分阶段进度回调（可选） */
  onProgress?: DualEngineProgressCallback
}

/** AI-1（生成位）prompt —— 严禁引入源材料以外的信息 */
function buildAI1Messages(params: DualEngineRunParams): AIRequest['messages'] {
  const system = [
    '你是一名严谨的学术总结助手。用户会提供一段【源材料】和一条【任务指令】，你需要按指令做总结。',
    '',
    '【核心约束（必须严格遵守）】',
    '1. 只使用【源材料】中的信息，禁止引入源材料未提及的外部知识、常识、评论、推测或联想。',
    '2. 若源材料信息不足以完成指令，明确写"源材料未提及"，不要猜测、不要补全。',
    '3. 忠于原文字面含义，不泛化、不外推、不改写数字/年份/人名/机构。',
    '4. 输出简洁的中文 Markdown，保持事实性描述，不发表主观评论。',
    '',
    '【反例（禁止行为）】',
    '- 源材料只说"屠呦呦获诺奖" → 不能写"她是中国大陆首位诺奖科学得主"（源材料没说）',
    '- 源材料说"2015 年" → 不能改写为"约 2015 年前后"（曲解）',
    '- 源材料没提某作者 → 不能补充"该研究是 XX 团队做的"（编造）',
  ].join('\n')

  const user = [
    '【源材料】',
    params.sourceMaterial,
    '',
    '【任务指令】',
    params.ai1Instruction,
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** AI-2（核查位）prompt —— 拿 (源材料, AI-1 总结) 做忠实性核查 */
function buildAI2Messages(
  params: DualEngineRunParams,
  ai1Output: string,
): AIRequest['messages'] {
  const system = [
    '你是一名严格的忠实性核查助手。你会收到两份内容：',
    '- 【源材料】：唯一 ground truth',
    '- 【AI-1 总结】：待核查的总结（AI-1 应仅基于源材料生成，你的任务是抓出它是否加戏或曲解）',
    '',
    '【任务】',
    '逐条抽取 AI-1 总结中的可核查断言（claim），针对每条给出结论：',
    '- supported: 源材料明确支撑该 claim',
    '- added: 源材料未提及该 claim（AI-1 引入了源材料以外的信息）',
    '- contradicted: 源材料的内容与该 claim 矛盾（AI-1 曲解了源材料）',
    '',
    '【严格要求】',
    '1. 每条 claim 必须给出 source_span：',
    '   - supported: 源材料中支撑该 claim 的**原文片段**（≥10 字符，直接从源材料中原样引用）',
    '   - contradicted: 源材料中被 claim 矛盾的**原文片段**（≥10 字符，直接从源材料中原样引用）',
    '   - added: source_span 为空字符串（源材料没提到，无需 span）',
    '2. source_span **必须是源材料的原文引用**，禁止改写、压缩、意译、翻译。',
    '   前端会用 sourceMaterial.includes(source_span) 做锚定校验，若引用不实会自动标记为"AI-2 编造引用"并强制降级。',
    '3. 只处理 AI-1 总结中的断言，不要评价其"是否符合世界常识" —— ground truth 只有源材料。',
    '4. 输出严格 JSON，不要 markdown 代码块，不要任何前后缀说明。',
    '',
    '【输出 JSON 结构】',
    '{',
    '  "passed": boolean,           // 无 added 且无 contradicted 时为 true',
    '  "claims": [',
    '    {',
    '      "claim": "从 AI-1 总结中抽取的断言（保留核心语义）",',
    '      "verdict": "supported" | "added" | "contradicted",',
    '      "source_span": "源材料原文引用（≥10 字符）或空字符串",',
    '      "explanation": "中文简要说明为何这么判断"',
    '    }',
    '  ],',
    '  "summary": "对 AI-1 总结整体忠实性的评价（中文 1-3 句）"',
    '}',
  ].join('\n')

  const user = [
    '【源材料】',
    params.sourceMaterial,
    '',
    '【AI-1 收到的任务指令】',
    params.ai1Instruction,
    '',
    '【AI-1 输出的总结】',
    ai1Output,
    '',
    '请按 system 指令做忠实性核查，输出 JSON。',
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** 标准化 verdict 字段（未知值兜底 added，宁误判也不放过） */
function normalizeVerdict(v: unknown): FaithfulnessVerdict {
  if (v === 'supported' || v === 'added' || v === 'contradicted') return v
  return 'added'
}

/** 解析 AI-2 输出为结构化 claims 数组
 *  兼容：markdown 代码块 / 前后无效字符 / 解析失败降级
 */
function parseFaithfulnessReport(rawOutput: string): {
  passed: boolean
  claims: FaithfulnessClaim[]
  summary: string
} {
  let jsonText = rawOutput.trim()

  // 剥离 ```json ... ``` 或 ``` ... ``` 代码块
  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonText = fenceMatch[1].trim()

  // 截取第一个 { 到最后一个 }
  const firstBrace = jsonText.indexOf('{')
  const lastBrace = jsonText.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    jsonText = jsonText.slice(firstBrace, lastBrace + 1)
  }

  try {
    const parsed = JSON.parse(jsonText) as {
      passed?: boolean
      claims?: {
        claim?: string
        verdict?: string
        source_span?: string
        explanation?: string
      }[]
      summary?: string
    }
    const claims: FaithfulnessClaim[] = Array.isArray(parsed.claims)
      ? parsed.claims.map((c) => ({
          claim: String(c.claim ?? ''),
          verdict: normalizeVerdict(c.verdict),
          source_span: String(c.source_span ?? ''),
          explanation: String(c.explanation ?? ''),
        }))
      : []
    return {
      passed: Boolean(parsed.passed),
      claims,
      summary: String(parsed.summary ?? ''),
    }
  } catch {
    return {
      passed: false,
      claims: [],
      summary: rawOutput.slice(0, 500),
    }
  }
}

/** 前端锚定校验：AI-2 给的 source_span 是否真的能在源材料中找到
 *  任何一条应有 span 但校验失败 → ok=false，前端强制降级 passed=false
 */
function verifyEvidence(
  sourceMaterial: string,
  claims: FaithfulnessClaim[],
): EvidenceCheck {
  const failedIndices: number[] = []
  let checked = 0
  let matched = 0
  claims.forEach((c, idx) => {
    // added: 源材料未提及，本就没 span → 不校验
    if (c.verdict === 'added') return
    checked++
    // supported / contradicted 必须有 ≥10 字符的 span，且能在源材料中 grep 到
    if (!c.source_span || c.source_span.length < 10) {
      failedIndices.push(idx)
      return
    }
    if (sourceMaterial.includes(c.source_span)) {
      matched++
    } else {
      failedIndices.push(idx)
    }
  })
  return {
    ok: failedIndices.length === 0,
    checked,
    matched,
    failedIndices,
  }
}

/**
 * 双引擎完整流程（M3.5 语义 · M3.5.1 分阶段进度）
 * @throws 底层 client.ts 里的 AIError 子类
 */
export async function runDualEngine(
  params: DualEngineRunParams,
): Promise<DualEngineResult> {
  const startedAt = Date.now()

  try {
    // 步骤 1：AI-1 基于源材料生成总结
    params.onProgress?.({ stage: 'ai1_running' })
    const ai1T0 = Date.now()
    const ai1Resp = await callAI({
      baseUrl: params.ai1.baseUrl,
      apiKey: params.ai1.apiKey,
      model: params.ai1.model,
      messages: buildAI1Messages(params),
      temperature: 0.2,
      maxTokens: 2048,
    })
    const ai1Ms = Date.now() - ai1T0
    params.onProgress?.({
      stage: 'ai1_done',
      ai1Output: ai1Resp.content,
      ai1Model: params.ai1.model,
      ai1Usage: ai1Resp.usage,
      ai1Ms,
    })

    // 步骤 2：AI-2 拿 (源材料, AI-1 总结) 做忠实性核查
    params.onProgress?.({ stage: 'ai2_running', ai1Ms })
    const ai2T0 = Date.now()
    const ai2Resp = await callAI({
      baseUrl: params.ai2.baseUrl,
      apiKey: params.ai2.apiKey,
      model: params.ai2.model,
      messages: buildAI2Messages(params, ai1Resp.content),
      temperature: 0.1,
      maxTokens: 2048,
    })
    const ai2Ms = Date.now() - ai2T0
    params.onProgress?.({ stage: 'ai2_done', ai1Ms, ai2Ms })

    // 步骤 3：解析 AI-2 报告 + 锚定校验
    params.onProgress?.({ stage: 'verifying', ai1Ms, ai2Ms })
    const report = parseFaithfulnessReport(ai2Resp.content)
    const evidenceCheck = verifyEvidence(params.sourceMaterial, report.claims)

    // 步骤 4：合并 passed —— AI-2 自判通过 + 锚定校验通过，才算真通过
    const finalPassed = report.passed && evidenceCheck.ok

    const finishedAt = Date.now()
    params.onProgress?.({ stage: 'finished', ai1Ms, ai2Ms })

    return {
      taskType: params.taskType,
      sourceMaterial: params.sourceMaterial,
      ai1Instruction: params.ai1Instruction,
      ai1Model: params.ai1.model,
      ai1Output: ai1Resp.content,
      ai1Usage: ai1Resp.usage,
      ai2Model: params.ai2.model,
      ai2Feedback: {
        passed: finalPassed,
        claims: report.claims,
        summary: report.summary,
        evidenceCheck,
      },
      ai2RawOutput: ai2Resp.content,
      ai2Usage: ai2Resp.usage,
      startedAt,
      finishedAt,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    params.onProgress?.({ stage: 'error', errorMessage: msg })
    throw err
  }
}
