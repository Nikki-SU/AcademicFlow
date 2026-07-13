/**
 * AI 双引擎编排（AI-1 生成 + AI-2 忠实性核查 + M3.6 分层归因重试循环）
 * -------------------------------------------------
 * SPEC v0.3 §9.2 · M3.5 语义 + M3.5.1 分阶段进度回调 + M3.6 分层归因
 *
 * M3.5 语义：
 *   - AI-1: 拿用户提供的**源材料**（ground truth）+ 用户指令 → 生成总结
 *   - AI-2: 拿 (源材料, AI-1 总结) → 逐句核查总结的**忠实性**
 *     - supported / added（AI-1 加戏）/ contradicted（AI-1 曲解）
 *   - 前端锚定校验：AI-2 给出的 source_span 必须能在源材料中 grep 到
 *
 * M3.5.1：分阶段进度回调 + 每轮 90s 硬超时（由 client.ts 实现）
 *
 * M3.6 新增（分层归因重试循环）：
 *   - 每轮结束后归因，分层处理：
 *     · passed=true & 引证ok=true → 全通过退出
 *     · 引证ok=false → 判定 AI-2 错（编造 span）→ 只让 AI-2 自我纠错，AI-1 输出保留不变
 *     · 引证ok=true & passed=false → 判定 AI-1 错（加戏/曲解）→ 打回 AI-1 重写 + AI-2 重审
 *     · 两个都错 → 优先归因 AI-2（引证都错，AI-2 的 verdict 也不可信）
 *   - 最多 maxAttempts=5 轮，任一轮双通过退出
 *   - 5 轮全失败：返回最后一轮结果 + finalPassed=false，UI 显著红标
 */
import type {
  AIRequest,
  AttemptReason,
  DualEngineAttempt,
  DualEngineProgressCallback,
  DualEngineResult,
  DualEngineTaskType,
  EvidenceCheck,
  FaithfulnessClaim,
  FaithfulnessFeedback,
  FaithfulnessVerdict,
} from '../../types'
import { callAI } from './client'

/** 双引擎单侧配置 */
export interface DualEngineSideConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/** 双引擎运行参数（M3.5 + M3.5.1 + M3.6） */
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
  /** M3.6: 最大重试轮数，默认 5；传 1 即退化为 M3.5 语义（不重试） */
  maxAttempts?: number
}

const DEFAULT_MAX_ATTEMPTS = 5

/** AI-1 未调用时的 usage 占位（保持 AIResponse['usage'] 形状） */
const EMPTY_USAGE = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
}

// ============================================================
// AI-1 prompt 构造
// ============================================================

/** AI-1 首轮 prompt —— 严禁引入源材料以外的信息
 *
 *  语言约束：跟随用户指令语言（用户写中文指令就中文输出，写英文指令就英文输出）
 *
 *  设计原则（M3.6.3-fix · 固定 tag 硬编码）：
 *    对"源材料未涉及但用户任务指令索取"的字段，强制 AI-1 输出**固定 tag**
 *    `[NOT_IN_SOURCE] <字段名>`。这是内部机器可识别标记，前端会自动替换为
 *    用户友好文案（"（原文未提及：字段名）"）；AI-2 抽取时识别到 tag 就跳过，
 *    不成为 claim；verifyEvidence 也做兜底过滤。
 *
 *    这样元陈述根本不进 verdict/引证核查流程，从根源上避免了旧版
 *    "AI-2 判 verdict 陷入模糊边界 → 被迫改判 added → AI-1 rewrite 死循环"的 bug。
 */
function buildAI1FirstMessages(params: DualEngineRunParams): AIRequest['messages'] {
  const system = [
    '你是一名严谨的学术总结助手。用户会提供一段【源材料】和一条【任务指令】，你需要按指令做总结。',
    '',
    '【核心约束（必须严格遵守）】',
    '1. 只使用【源材料】中的信息，禁止引入源材料未提及的外部知识、常识、评论、推测或联想。',
    '2. 若源材料信息不足以完成指令的某一子问题，宁可留白或明确说明，也不要猜测/补全/编造。',
    '3. 忠于原文字面含义，不泛化、不外推、不改写数字/年份/人名/机构。',
    '4. 输出简洁的 Markdown，保持事实性描述，不发表主观评论。',
    '5. 输出语言跟随用户指令：用户指令是中文就用中文输出，用户指令是英文就用英文输出。',
    '',
    '【未提及项的固定表达格式（强制机器可识别标记，务必严格遵守）】',
    '6. 当用户任务指令要求源材料未涉及/未提及的字段或子问题时，**必须**以以下固定格式输出：',
    '     `[NOT_IN_SOURCE] <字段名或子问题的简要中文描述>`',
    '   示例：`[NOT_IN_SOURCE] 作者信息`、`[NOT_IN_SOURCE] 发表年份`、`[NOT_IN_SOURCE] 实验设备型号`',
    '7. **必须**保留字面完整的 tag：方括号、全大写英文单词、下划线一个都不能变。',
    '   - 禁止翻译（不能写 `[原文未涉及]` / `[NOT MENTIONED]` / `[未提及]`）',
    '   - 禁止改写（不能写自然语言"原文未提及作者"、"该问题超出源材料范围"）',
    '   - 禁止省略 tag 直接留白或跳过该子问题',
    '   - 禁止在 tag 后附加任何编造/推测内容（tag 后只能跟字段名的中文简要描述）',
    '8. 该 tag 是给系统识别的内部标记，前端会自动替换成用户友好文案，你无需担心用户看到 tag 字符本身。',
    '',
    '【反例（禁止行为）】',
    '- 源材料只说"屠呦呦获诺奖" → 不能写"她是中国大陆首位诺奖科学得主"（源材料没说 = 加戏）',
    '- 源材料说"2015 年" → 不能改写为"约 2015 年前后"（曲解）',
    '- 源材料没提某作者，指令要求列出作者 → 必须写 `[NOT_IN_SOURCE] 作者信息`；',
    '  禁止编造"该研究是 XX 团队做的"，也禁止写自然语言"原文未提及作者"（tag 必须原样保留）',
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

/** AI-1 重写 prompt（M3.6）—— 收 AI-2 反馈，删掉 added/contradicted 或改写为源材料支持的说法 */
function buildAI1RewriteMessages(
  params: DualEngineRunParams,
  previousOutput: string,
  previousFeedback: FaithfulnessFeedback,
  attemptIndex: number,
  maxAttempts: number,
): AIRequest['messages'] {
  const system = [
    '你是一名严谨的学术总结助手。你上一版的总结被审查方（AI-2）判定存在忠实性问题，现在需要根据反馈**重写**。',
    '',
    '【核心约束（必须严格遵守）】',
    '1. 只使用【源材料】中的信息，禁止引入源材料未提及的外部知识、常识、评论、推测或联想。',
    '2. 对反馈中被判 "added" 的 claim：**必须删除**，或改写为源材料明确支持的说法。禁止只换措辞保留。',
    '3. 对反馈中被判 "contradicted" 的 claim：**改写为源材料明确支持的说法**，或直接删掉。',
    '4. 对反馈中被判 "通过" 的 claim：保留原意，措辞可微调。',
    '5. **禁止**为了凑字数补充新的、源材料没有的信息；宁可短，宁可留白，不可加戏。',
    '6. 忠于原文字面含义，不泛化、不外推、不改写数字/年份/人名/机构。',
    '7. 输出简洁的 Markdown，保持事实性描述，不发表主观评论。',
    '8. 输出语言跟随用户原始指令（中文指令则中文，英文指令则英文）。',
    '',
    '【未提及项的固定表达格式（M3.6.3 强制机器可识别标记，务必严格遵守）】',
    '9. 当用户任务指令要求源材料未涉及/未提及的字段或子问题时，**必须**以固定格式输出：',
    '     `[NOT_IN_SOURCE] <字段名或子问题的简要中文描述>`',
    '   示例：`[NOT_IN_SOURCE] 作者信息`、`[NOT_IN_SOURCE] 发表年份`',
    '10. **必须**保留字面完整的 tag：方括号、全大写英文单词、下划线一个都不能变。',
    '    - 禁止翻译（不能写 `[原文未涉及]` / `[NOT MENTIONED]` / `[未提及]`）',
    '    - 禁止改写（不能写自然语言"原文未提及作者"、"该问题超出源材料范围"）',
    '    - 禁止省略 tag 直接留白或跳过该子问题',
    '    - 禁止在 tag 后附加任何编造/推测内容',
    '11. 若上一版你已经用了 tag，本轮请**原样保留**这些 tag 行，AI-2 不会追责它们。',
    '',
    `这是第 ${attemptIndex}/${maxAttempts} 轮尝试。若本轮仍未通过，将继续被打回（或者转由 AI-2 自我纠错）。`,
  ].join('\n')

  const feedbackLines: string[] = []
  previousFeedback.claims.forEach((c, i) => {
    let tag: string
    switch (c.verdict) {
      case 'added':
        tag = '❌ added（必须删除或改写为源材料明确支持的说法）'
        break
      case 'contradicted':
        tag = '❌ contradicted（必须改写或删除）'
        break
      // M3.6.3: out_of_scope 类别已废除，但需向后兼容旧 IndexedDB 数据中可能残留的记录
      // 若 verdict 值不在三分类中（如旧数据里的 'out_of_scope'），静默视为"通过"
      default:
        tag = '✅ supported（可保留）'
    }
    feedbackLines.push(`${i + 1}. ${tag}`)
    feedbackLines.push(`   claim: ${c.claim}`)
    if (c.explanation) feedbackLines.push(`   审查意见: ${c.explanation}`)
  })

  const user = [
    '【源材料】',
    params.sourceMaterial,
    '',
    '【任务指令】',
    params.ai1Instruction,
    '',
    '【上一版你的总结】',
    previousOutput,
    '',
    '【AI-2 的忠实性核查反馈】',
    feedbackLines.join('\n'),
    '',
    previousFeedback.summary ? `【整体评价】${previousFeedback.summary}` : '',
    '',
    '请基于以上反馈重写总结（同样围绕原任务指令）。',
  ]
    .filter((s) => s !== '')
    .join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

// ============================================================
// AI-2 prompt 构造
// ============================================================

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
    '【前置抽取规则（M3.6.3 关键·务必遵守）】',
    '在抽取 claim 之前，先做元陈述过滤：',
    '- AI-1 侧被硬编码要求：源材料未涉及的字段用固定 tag `[NOT_IN_SOURCE] <字段名>` 表达（例：`[NOT_IN_SOURCE] 作者信息`）。',
    '- **含有 `[NOT_IN_SOURCE]` tag 的行 / 项目符号 / 句子，一律不抽取为 claim**（它是 AI-1 的诚实标注，不是关于源材料内容的事实断言，不参与忠实性核查）。',
    '- 只有真正对源材料内容做出事实断言的语句才抽取为 claim。',
    '',
    '【任务】',
    '逐条抽取 AI-1 总结中的可核查断言（claim，跳过含 tag 行后），针对每条给出结论：',
    '- supported: 源材料明确支撑该 claim',
    '- added: AI-1 编造/补充了源材料未提及的内容（"加戏"，追责项）',
    '- contradicted: 源材料的内容与该 claim 矛盾（AI-1 曲解源材料，追责项）',
    '',
    '【严格要求】',
    '1. 每条 claim 必须给出 source_span：',
    '   - supported: 源材料中支撑该 claim 的**原文片段**（≥10 字符，直接从源材料中原样引用）',
    '   - contradicted: 源材料中被 claim 矛盾的**原文片段**（≥10 字符，直接从源材料中原样引用）',
    '   - added: source_span 为空字符串（源材料没提到，无需 span）',
    '2. source_span **必须是源材料的原文引用**，禁止改写、压缩、意译、翻译。',
    '   前端会用 sourceMaterial.includes(source_span) 做锚定校验，若引用不实会自动标记为"AI-2 编造引用"并强制降级。',
    '3. 只处理 AI-1 总结中真正对源材料做出的事实断言，不要评价其"是否符合世界常识" —— ground truth 只有源材料。',
    '4. **含 `[NOT_IN_SOURCE]` tag 的行绝对不抽取为 claim**（这是本次核查铁律，违反将触发死循环 bug）。',
    '5. **passed 定义**：抽取出的所有 claim 中无 added 且无 contradicted 时 passed=true。',
    '6. 输出严格 JSON，不要 markdown 代码块，不要任何前后缀说明。',
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
    '  "summary": "对 AI-1 总结整体忠实性的评价（中文 1-3 句）；若 AI-1 大量使用了 [NOT_IN_SOURCE] tag 属于诚实行为，可正面评价"',
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

/** AI-2 自我纠错 prompt（M3.6）—— 上一轮引证锚定失败时使用
 *
 *  设计要点：
 *  - 明确告诉 AI-2 "你上一版哪些 span 前端 grep 不到"，让它重新挑
 *  - 保留 AI-1 输出不变（同一 AI-1 总结 + 同一源材料）
 *  - 强调 span 必须**原样 copy 自源材料**，不允许改写、翻译、压缩
 *  - 兼容 AI-1 输出可能确实加戏的情况：如果确实找不到支撑，就老实标 added
 */
function buildAI2SelfCorrectMessages(
  params: DualEngineRunParams,
  ai1Output: string,
  previousRawOutput: string,
  previousFeedback: FaithfulnessFeedback,
  attemptIndex: number,
  maxAttempts: number,
): AIRequest['messages'] {
  const system = [
    '你是一名严格的忠实性核查助手。你上一版的核查结果**引证锚定失败**（你挑的 source_span 无法在源材料中定位），需要重跑核查。',
    '',
    '【问题】',
    '前端用 sourceMaterial.includes(source_span) 做校验时，你上一版的部分 span 匹配失败。这通常是因为：',
    '- 你压缩、改写、意译或翻译了源材料的原文（前端只做**字面完全匹配**）',
    '- 你把跨段的两个句子拼接成一个 span（源材料中不存在这样的连续片段）',
    '- 你给 supported/contradicted 类型的 claim 留了空 span 或 <10 字符的 span',
    '',
    '【前置抽取规则（M3.6.3 关键·务必遵守）】',
    '在抽取 claim 之前，先做元陈述过滤：',
    '- AI-1 侧被硬编码要求：源材料未涉及的字段用固定 tag `[NOT_IN_SOURCE] <字段名>` 表达（例：`[NOT_IN_SOURCE] 作者信息`）。',
    '- **含有 `[NOT_IN_SOURCE]` tag 的行 / 项目符号 / 句子，一律不抽取为 claim**（诚实标注，不参与忠实性核查）。',
    '- 如果你上一版把含 tag 的行错误抽取为 claim，本轮**必须剔除**这些条目。',
    '',
    '【本轮任务】',
    '1. **AI-1 的总结保持不变**，你需要基于同一份 (源材料, AI-1 总结) **重新给出核查报告**。',
    '2. 每条 supported / contradicted 的 source_span **必须原样 copy 自源材料**（≥10 字符，逐字对齐，含标点/大小写/空格）。',
    '3. 如果你找不到能字面对齐源材料的 span 来支持某条 claim，请**先判断该 claim 属于哪一类**：',
    '   - claim 内容中含 `[NOT_IN_SOURCE]` tag → **不应作为 claim 抽取**，本轮请直接剔除',
    '   - AI-1 用陈述句写了源材料没写的内容（且无 tag）→ 标 **added**（追责，source_span 留空）',
    '4. 三类 verdict 及 span 规则：',
    '   - supported: 需要 ≥10 字符原文 span',
    '   - contradicted: 需要 ≥10 字符原文 span',
    '   - added: source_span 留空字符串',
    '5. **passed 定义**：无 added 且无 contradicted 时 passed=true。',
    '6. 输出严格 JSON，格式与首次核查完全一致（verdict 只允许 supported / added / contradicted 三值）。',
    '',
    `这是第 ${attemptIndex}/${maxAttempts} 轮尝试（AI-2 自我纠错模式）。`,
  ].join('\n')

  const failedIndices = previousFeedback.evidenceCheck.failedIndices
  const failedSpans = failedIndices
    .map((idx) => {
      const c = previousFeedback.claims[idx]
      if (!c) return ''
      return `- 第 ${idx + 1} 条 claim: "${c.claim}"\n  你之前挑的 span: "${c.source_span}" ← 前端 grep 失败`
    })
    .filter((s) => s !== '')
    .join('\n')

  const user = [
    '【源材料】',
    params.sourceMaterial,
    '',
    '【AI-1 收到的任务指令】',
    params.ai1Instruction,
    '',
    '【AI-1 输出的总结（保持不变）】',
    ai1Output,
    '',
    '【你上一版的原始输出（供参考）】',
    previousRawOutput.slice(0, 2000),
    '',
    '【引证锚定失败的具体 claim】',
    failedSpans || '（未定位到具体失败的 claim，请重新做全量核查并给出可字面对齐的 span）',
    '',
    '请重新做完整的忠实性核查，输出严格 JSON。',
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

// ============================================================
// 解析 / 校验 工具
// ============================================================

function normalizeVerdict(v: unknown): FaithfulnessVerdict {
  if (v === 'supported' || v === 'added' || v === 'contradicted') {
    return v
  }
  // M3.6.3: 向后兼容 —— 旧数据/漏网 AI-2 输出的 'out_of_scope' 静默归为 supported
  //   （元陈述本身天然合法，不追责）
  if (v === 'out_of_scope') {
    return 'supported'
  }
  return 'added'
}

function parseFaithfulnessReport(rawOutput: string): {
  passed: boolean
  claims: FaithfulnessClaim[]
  summary: string
} {
  let jsonText = rawOutput.trim()

  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonText = fenceMatch[1].trim()

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

/** M3.6.3 元陈述固定 tag —— AI-1 硬编码使用，AI-2 抽取跳过，前端兜底过滤。
 *  三层保底任一失守，其他层还能拦。 */
const NOT_IN_SOURCE_TAG = '[NOT_IN_SOURCE]'

/** 判断一条 claim 是否是元陈述（含固定 tag） */
function isMetaClaim(c: FaithfulnessClaim): boolean {
  return (
    c.claim.includes(NOT_IN_SOURCE_TAG) ||
    c.explanation.includes(NOT_IN_SOURCE_TAG) ||
    c.source_span.includes(NOT_IN_SOURCE_TAG)
  )
}

function verifyEvidence(
  sourceMaterial: string,
  claims: FaithfulnessClaim[],
): EvidenceCheck {
  const failedIndices: number[] = []
  let checked = 0
  let matched = 0
  claims.forEach((c, idx) => {
    // M3.6.3 兜底过滤（前端第三层保底）：
    //   若 AI-2 违反抽取规则、把含 [NOT_IN_SOURCE] tag 的行错误抽取为 claim，
    //   前端在此静默剔除，绝不让元陈述进入引证锚定校验 —— 从根源上避免
    //   "supported 无 span → grep fail → AI-2 自纠 → 改判 added → AI-1 rewrite 死循环"。
    if (isMetaClaim(c)) return
    // added 类无需 span，也从 checked 池中排除
    if (c.verdict === 'added') return
    checked++
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

// ============================================================
// M3.6 分层归因：根据上一轮结果决定下一轮调哪个 AI
// ============================================================

/**
 * 归因函数：给定上一轮结果，决定下一轮的触发原因
 *
 * 规则：
 * - 上一轮 passed & ok → 不需要下一轮（外部循环会退出）
 * - ok=false（AI-2 编造引用） → 下一轮走 ai2_self_correct（不管 passed 是啥，先修引证）
 * - ok=true & passed=false（AI-1 加戏）→ 下一轮走 ai1_rewrite
 */
function decideNextReason(previous: DualEngineAttempt): AttemptReason {
  if (!previous.ai2Feedback.evidenceCheck.ok) {
    // AI-2 引证不实 → AI-2 自纠优先（哪怕 passed=false，AI-2 的 verdict 也不可信）
    return 'ai2_self_correct'
  }
  // 引证 ok 但 passed=false → AI-1 加戏
  return 'ai1_rewrite'
}

// ============================================================
// 单轮执行
// ============================================================

/** 单轮执行：根据 reason 分别处理三种情况
 *  - first_run: 首次跑 AI-1 → AI-2
 *  - ai1_rewrite: 只调 AI-1 重写 + AI-2 重审（走 ai2_running）
 *  - ai2_self_correct: AI-1 输出保留，只调 AI-2 自我纠错（走 ai2_self_correct_running）
 */
async function runSingleAttempt(
  params: DualEngineRunParams,
  attemptIndex: number,
  maxAttempts: number,
  reason: AttemptReason,
  previousAttempt: DualEngineAttempt | null,
): Promise<DualEngineAttempt> {
  params.onProgress?.({
    stage: 'attempt_start',
    attempt: attemptIndex,
    maxAttempts,
    reason,
  })

  let ai1Output: string
  let ai1Usage = EMPTY_USAGE
  let ai1Ms = 0
  let ai1Invoked = false

  // ------ AI-1 阶段（first_run / ai1_rewrite 会真跑；ai2_self_correct 保留上一轮） ------
  if (reason === 'ai2_self_correct') {
    // AI-2 自纠：AI-1 输出不变，直接沿用上一轮
    if (!previousAttempt) {
      throw new Error(
        'AI-2 self-correct requires a previous attempt but got null',
      )
    }
    ai1Output = previousAttempt.ai1Output
  } else {
    // first_run 或 ai1_rewrite：都要真调 AI-1
    params.onProgress?.({
      stage: 'ai1_running',
      attempt: attemptIndex,
      maxAttempts,
      reason,
    })
    const ai1T0 = Date.now()
    const ai1Messages =
      reason === 'first_run'
        ? buildAI1FirstMessages(params)
        : buildAI1RewriteMessages(
            params,
            previousAttempt!.ai1Output,
            previousAttempt!.ai2Feedback,
            attemptIndex,
            maxAttempts,
          )
    const ai1Resp = await callAI({
      baseUrl: params.ai1.baseUrl,
      apiKey: params.ai1.apiKey,
      model: params.ai1.model,
      messages: ai1Messages,
      temperature: 0.2,
      maxTokens: 2048,
    })
    ai1Ms = Date.now() - ai1T0
    ai1Output = ai1Resp.content
    ai1Usage = ai1Resp.usage
    ai1Invoked = true
    params.onProgress?.({
      stage: 'ai1_done',
      attempt: attemptIndex,
      maxAttempts,
      reason,
      ai1Output: ai1Resp.content,
      ai1Model: params.ai1.model,
      ai1Usage: ai1Resp.usage,
      ai1Ms,
    })
  }

  // ------ AI-2 阶段（三种模式都会调 AI-2） ------
  const ai2Stage =
    reason === 'ai2_self_correct' ? 'ai2_self_correct_running' : 'ai2_running'
  params.onProgress?.({
    stage: ai2Stage,
    attempt: attemptIndex,
    maxAttempts,
    reason,
    ai1Ms,
  })
  const ai2T0 = Date.now()
  const ai2Messages =
    reason === 'ai2_self_correct'
      ? buildAI2SelfCorrectMessages(
          params,
          ai1Output,
          previousAttempt!.ai2RawOutput,
          previousAttempt!.ai2Feedback,
          attemptIndex,
          maxAttempts,
        )
      : buildAI2Messages(params, ai1Output)
  const ai2Resp = await callAI({
    baseUrl: params.ai2.baseUrl,
    apiKey: params.ai2.apiKey,
    model: params.ai2.model,
    messages: ai2Messages,
    temperature: 0.1,
    maxTokens: 2048,
  })
  const ai2Ms = Date.now() - ai2T0
  params.onProgress?.({
    stage: 'ai2_done',
    attempt: attemptIndex,
    maxAttempts,
    reason,
    ai1Ms,
    ai2Ms,
  })

  // ------ 引证锚定 ------
  params.onProgress?.({
    stage: 'verifying',
    attempt: attemptIndex,
    maxAttempts,
    reason,
    ai1Ms,
    ai2Ms,
  })
  const report = parseFaithfulnessReport(ai2Resp.content)
  const evidenceCheck = verifyEvidence(params.sourceMaterial, report.claims)
  const passed = report.passed && evidenceCheck.ok

  const ai2Feedback: FaithfulnessFeedback = {
    passed,
    claims: report.claims,
    summary: report.summary,
    evidenceCheck,
  }

  return {
    attempt: attemptIndex,
    reason,
    ai1Output,
    ai1Invoked,
    ai1Usage,
    ai1Ms,
    ai2Feedback,
    ai2RawOutput: ai2Resp.content,
    ai2Usage: ai2Resp.usage,
    ai2Ms,
    passed,
    previousAI1Output: previousAttempt?.ai1Output ?? null,
  }
}

// ============================================================
// 主编排（M3.6：分层归因 + 5 轮上限）
// ============================================================

/**
 * 双引擎完整流程（M3.5 语义 · M3.5.1 分阶段进度 · M3.6 分层归因重试）
 * @throws 底层 client.ts 里的 AIError 子类
 */
export async function runDualEngine(
  params: DualEngineRunParams,
): Promise<DualEngineResult> {
  const startedAt = Date.now()
  const maxAttempts = Math.max(1, params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const attempts: DualEngineAttempt[] = []

  try {
    for (let i = 1; i <= maxAttempts; i++) {
      const previous =
        attempts.length > 0 ? attempts[attempts.length - 1] : null
      const reason: AttemptReason =
        i === 1 ? 'first_run' : decideNextReason(previous!)

      const attempt = await runSingleAttempt(
        params,
        i,
        maxAttempts,
        reason,
        previous,
      )
      attempts.push(attempt)

      // 双通过 → 立即退出
      if (attempt.passed) break

      // 未通过 & 还有下一轮 → 通知 UI "上一轮为何被打回 + 下一轮走哪种模式"
      if (i < maxAttempts) {
        params.onProgress?.({
          stage: 'attempt_failed_retry',
          attempt: i,
          maxAttempts,
          reason,
          ai2Feedback: attempt.ai2Feedback,
        })
      }
    }

    const last = attempts[attempts.length - 1]
    const finalPassed = last.passed
    const finishedAt = Date.now()

    params.onProgress?.({
      stage: 'finished',
      attempt: last.attempt,
      maxAttempts,
      reason: last.reason,
      ai1Ms: last.ai1Ms,
      ai2Ms: last.ai2Ms,
    })

    // 首轮 usage 兜底（保持 M3.5 时代字段兼容）
    const firstAttempt = attempts[0]

    return {
      taskType: params.taskType,
      sourceMaterial: params.sourceMaterial,
      ai1Instruction: params.ai1Instruction,
      ai1Model: params.ai1.model,
      ai2Model: params.ai2.model,
      ai1Output: last.ai1Output,
      ai2Feedback: last.ai2Feedback,
      ai2RawOutput: last.ai2RawOutput,
      attempts,
      maxAttempts,
      finalPassed,
      ai1Usage: firstAttempt.ai1Usage,
      ai2Usage: firstAttempt.ai2Usage,
      startedAt,
      finishedAt,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    params.onProgress?.({ stage: 'error', errorMessage: msg })
    throw err
  }
}
