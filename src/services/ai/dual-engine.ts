/**
 * AI 双引擎编排（AI-1 生成 + AI-2 审阅）
 * -------------------------------------------------
 * 对应 SPEC v0.3 §9.2。M3 阶段先跑通 fact_check 一个任务类型。
 *
 * 流程：
 *   1. 调 AI-1 → 得到 ai1Output
 *   2. 把 AI-1 的输入 + 输出一起丢给 AI-2 审阅
 *   3. AI-2 返回 JSON 结构 {passed, issues, summary}
 *   4. 组装 DualEngineResult 返回给上层 UI
 *
 * AI-2 输出严格 JSON 约束：
 *   - 用 system prompt 强要求 "Only output a valid JSON object, no markdown fences"
 *   - 若 AI-2 返回内容不合法 JSON → 兜底降级为 passed=false + summary=raw text
 */
import type {
  AIRequest,
  DualEngineIssue,
  DualEngineResult,
  DualEngineTaskType,
} from '../../types'
import { callAI } from './client'

/** 双引擎单侧配置 */
export interface DualEngineSideConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/** 双引擎运行参数 */
export interface DualEngineRunParams {
  taskType: DualEngineTaskType
  /** 待处理原文（对 fact_check 来说是"含事实性声明的一段文本"） */
  input: string
  /** 附加上下文（可选，如文献片段/笔记） */
  context?: string
  ai1: DualEngineSideConfig
  ai2: DualEngineSideConfig
}

/** AI-1（生成位）prompt 生成器 —— 按任务类型分派 */
function buildAI1Messages(
  params: DualEngineRunParams,
): AIRequest['messages'] {
  const { taskType, input, context } = params
  switch (taskType) {
    case 'fact_check': {
      const system = [
        '你是一名严谨的学术事实核查助手。用户会提供一段包含事实性声明的文本，你需要：',
        '1. 逐条抽取其中的可核查事实点（如年份、人名、数字、机构、文献引用、公式常数、机制描述等）；',
        '2. 对每个事实点给出你的判断：verified / questionable / uncertain / not_verifiable_by_llm；',
        '3. 对 questionable / uncertain 项，说明疑点与建议的核查方向；',
        '4. 用中文回答，输出结构化 Markdown（一级标题「事实核查报告」下按事实点分小节）；',
        '5. 只对文本中真实出现的声明发表判断，不要虚构。',
      ].join('\n')

      const userParts: string[] = []
      if (context) userParts.push(`【上下文】\n${context}\n`)
      userParts.push(`【待核查文本】\n${input}`)

      return [
        { role: 'system', content: system },
        { role: 'user', content: userParts.join('\n') },
      ]
    }
    case 'translate':
    case 'summarize':
    case 'novelty_check':
    default:
      throw new Error(`任务类型 ${taskType} 在 M3 阶段暂未实现`)
  }
}

/** AI-2（审阅位）prompt 生成器 */
function buildAI2Messages(
  params: DualEngineRunParams,
  ai1Output: string,
): AIRequest['messages'] {
  const { taskType, input, context } = params

  const system = [
    '你是一名严格的学术审稿助手，专门审阅另一个 AI（下称 AI-1）的输出。',
    '你的目标：找出 AI-1 输出中的问题，而不是重做任务。',
    '',
    '审阅维度：',
    '- divergence（发散/偏题）：AI-1 输出偏离用户原始请求',
    '- omission（遗漏）：AI-1 漏掉原文中重要事实点',
    '- mistranslation（误译）：翻译类任务中出现意思偏差（对 fact_check 通常不适用）',
    '- unverified_link（未核实链接）：AI-1 输出中给出的 URL/DOI 未标注核实状态',
    '- other（其他）：如逻辑矛盾、术语误用、编造事实等',
    '',
    '输出严格要求：只输出一个合法 JSON 对象，不要 markdown 代码块，不要任何前后缀说明。',
    '字段：',
    '{',
    '  "passed": boolean,   // AI-1 输出是否可以直接采纳；有任何 issues 应为 false',
    '  "issues": [          // 每个 issue 对象',
    '    { "type": "divergence"|"omission"|"mistranslation"|"unverified_link"|"other",',
    '      "detail": "中文说明具体问题，含 AI-1 原文片段引用" }',
    '  ],',
    '  "summary": "对 AI-1 输出质量的一段整体评价（中文，1-3 句话）"',
    '}',
  ].join('\n')

  const originalRequest =
    taskType === 'fact_check'
      ? `【原始任务】对下面这段文本做事实核查。\n${
          context ? `【上下文】\n${context}\n` : ''
        }【原文】\n${input}`
      : `【原始任务类型】${taskType}\n【原文】\n${input}`

  const user = [
    originalRequest,
    '',
    '【AI-1 输出】',
    ai1Output,
    '',
    '请按 system 指令审阅并输出 JSON。',
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/**
 * 解析 AI-2 输出为结构化反馈
 * 兼容 AI-2 意外套 markdown 代码块（```json ... ```）的情况
 */
function parseAI2Feedback(rawOutput: string): {
  passed: boolean
  issues: DualEngineIssue[]
  summary: string
} {
  let jsonText = rawOutput.trim()

  // 剥离 ```json ... ``` 或 ``` ... ``` 代码块
  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonText = fenceMatch[1].trim()

  // 提取第一个 { 到最后一个 } 之间的部分（防前后有解释性文字）
  const firstBrace = jsonText.indexOf('{')
  const lastBrace = jsonText.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    jsonText = jsonText.slice(firstBrace, lastBrace + 1)
  }

  try {
    const parsed = JSON.parse(jsonText) as {
      passed?: boolean
      issues?: { type?: string; detail?: string }[]
      summary?: string
    }
    const issues: DualEngineIssue[] = Array.isArray(parsed.issues)
      ? parsed.issues.map((i) => ({
          type: normalizeIssueType(i.type),
          detail: String(i.detail || ''),
        }))
      : []
    return {
      passed: Boolean(parsed.passed),
      issues,
      summary: String(parsed.summary || ''),
    }
  } catch {
    // 解析失败：兜底降级为 passed=false，summary 用原文前 500 字符
    return {
      passed: false,
      issues: [
        {
          type: 'other',
          detail: 'AI-2 未按要求输出合法 JSON，请查看原始输出。',
        },
      ],
      summary: rawOutput.slice(0, 500),
    }
  }
}

function normalizeIssueType(t: string | undefined): DualEngineIssue['type'] {
  switch (t) {
    case 'divergence':
    case 'omission':
    case 'mistranslation':
    case 'unverified_link':
      return t
    default:
      return 'other'
  }
}

/**
 * 双引擎完整流程
 * @throws 底层 client.ts 里的 AIError 子类
 */
export async function runDualEngine(
  params: DualEngineRunParams,
): Promise<DualEngineResult> {
  const startedAt = Date.now()

  // 步骤 1：调 AI-1 生成
  const ai1Resp = await callAI({
    baseUrl: params.ai1.baseUrl,
    apiKey: params.ai1.apiKey,
    model: params.ai1.model,
    messages: buildAI1Messages(params),
    temperature: 0.3,
    maxTokens: 2048,
  })

  // 步骤 2：调 AI-2 审阅
  const ai2Resp = await callAI({
    baseUrl: params.ai2.baseUrl,
    apiKey: params.ai2.apiKey,
    model: params.ai2.model,
    messages: buildAI2Messages(params, ai1Resp.content),
    temperature: 0.2,
    maxTokens: 1536,
  })

  // 步骤 3：解析 AI-2 反馈
  const feedback = parseAI2Feedback(ai2Resp.content)
  const finishedAt = Date.now()

  return {
    taskType: params.taskType,
    input: params.input,
    ai1Model: params.ai1.model,
    ai1Output: ai1Resp.content,
    ai1Usage: ai1Resp.usage,
    ai2Model: params.ai2.model,
    ai2Feedback: feedback,
    ai2RawOutput: ai2Resp.content,
    ai2Usage: ai2Resp.usage,
    startedAt,
    finishedAt,
  }
}
