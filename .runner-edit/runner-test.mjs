#!/usr/bin/env node
/**
 * M3.6 双引擎运行器 — 在 GitHub Actions Node runner 上执行
 *
 * 从前端 dual-engine.ts 移植过来的完整双引擎循环逻辑。
 * 前端调用方零感知 — 只 dispatch ai-service workflow + poll 结果。
 *
 * 环境依赖：process.env 里的 AI1_BASE_URL / AI1_API_KEY / AI1_MODEL
 *                                 AI2_BASE_URL / AI2_API_KEY / AI2_MODEL
 */

const { AI1_BASE_URL, AI1_API_KEY, AI1_MODEL,
        AI2_BASE_URL, AI2_API_KEY, AI2_MODEL } = process.env

const DEFAULT_MAX_ATTEMPTS = 5
const EMPTY_USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
const NOT_IN_SOURCE_TAG = '[NOT_IN_SOURCE]'
const EVIDENCE_START = '@@EVIDENCE@@'
const EVIDENCE_END = '@@END_EVIDENCE@@'

// 输出预算。必须给推理模型留出足够的 headroom：
// reasoning token 和正文**共用**这一个 max_tokens，额度不够时模型会把额度全烧在
// 推理上、正文一个字都不输出 —— 表现不是「答得不好」而是「AI-2 输出为空」，
// 解析不出 report → passed=false，界面上却显示成「未通过核查」，完全误导。
// 实测：同一道 faithfulness_check 题，只喂正文时 AI-2 推理 3475 token；
// 依据里再并进一段联网检索结果后，推理直接顶满 16000 且三轮全空。
//
// 32000 对**整篇论文**不够：实测转一篇 97KB 的 md，AI-1 正文要 34000+ token
// （DeepSeek 那次到 48000）。撞上 32000 就是 finish_reason=length，
// 而重试只会再截断一次 —— 白烧一轮还拿不到完整正文。
// glm-4.7-flash / spark-x2.5-4b 都支持 128K 输出，所以留到 64000。
const MAX_TOKENS = 64000

/**
 * 把推理模式档位翻译成请求体参数。
 *   undefined / '' → 什么都不加（沿用模型默认 —— 用户没配过时行为必须和以前一致）
 *   off            → thinking:{type:'disabled'}
 *   low/high/max   → thinking:{type:'enabled'} + reasoning_effort
 *
 * 措辞与 paper_convert.mjs / ai_call.mjs 的 thinkingParams 保持一致：
 * DeepSeek 的两个端点都认 thinking:{type}（已实测；Anthropic 端点上的
 * reasoning:{effort:'none'} 反而无效），强度只有 OpenAI 兼容端点认 reasoning_effort。
 */
function thinkingParams(level) {
  if (!level) return {}
  if (level === 'off') return { thinking: { type: 'disabled' } }
  return { thinking: { type: 'enabled' }, reasoning_effort: level }
}

// ─── AI 调用（复用 ai-service.mjs 的 aiCall 签名 + retry） ────────────────
//
// 两道时间闸门，都是为了让这个任务**一定在 job 被砍之前结束并写出结果文件**：
//   CALL_TIMEOUT_MS —— 单次模型调用的硬超时。旧代码没有 AbortController，provider
//     挂住时 fetch 会一直等，最后 GitHub 的 timeout-minutes 到点把 job 整个杀掉，
//     结果文件永远不出现 → 前端只能干等轮询超时，用户看到的就是"静默失败"。
//   TOTAL_BUDGET_MS —— 整个任务的总预算。到点不再发起新的调用，带着已有结果正常返回。
//
// ⚠️ 这两个值和 ai_call.yml 的 timeout-minutes、前端 pollResultFile 的轮询上限
//    是**四条必须同时成立的时间线**（job 上限 > 总预算；前端轮询 > job 上限）。
//    改任意一个都要回头核对其余三个，详见 docs/BACKEND_PENDING.md §2。
//    当前关系：单次 15min / 总预算 40min / job 50min / 前端轮询 60min。
//
// 为什么从 5min/18min 抬上来：免费档吞吐低，实测 spark-x2.5-4b 转整篇论文的
// AI-1 就要 437s，300s 会在正文写到一半时被 AbortController 掐断；
// 更糟的是被掐断后服务端往往还在继续生成，紧接着的重试会直接撞 429 限流。
const CALL_TIMEOUT_MS = 900_000
const TOTAL_BUDGET_MS = 40 * 60_000
/** 剩余预算低于这个数就别再发起调用了（发出去也来不及跑完） */
const CALL_MIN_REMAINING_MS = 5_000

/** 本次任务的总 deadline；由 runDualEngine 设置 */
let deadlineAt = 0

/** 预算耗尽：不可重试，由 runDualEngine 捕获后停止后续轮次并正常返回 */
class BudgetExceededError extends Error {
  constructor(msg) { super(msg); this.name = 'BudgetExceededError'; this.budgetExceeded = true }
}

/**
 * provider 可选覆盖：{ baseUrl, apiKey, model, thinking } — DualEngineTestPanel 用；不传则用 Secrets
 * @returns {{content:string, usage:object, finishReason:string, reasoningTokens:number, thinkingUsed:string}}
 */
async function aiCall(engine, system, user, provider) {
  const baseUrl = provider?.baseUrl || (engine === 2 ? AI2_BASE_URL : AI1_BASE_URL)
  const apiKey  = provider?.apiKey  || (engine === 2 ? AI2_API_KEY  : AI1_API_KEY)
  const model   = provider?.model   || (engine === 2 ? AI2_MODEL    : AI1_MODEL)

  // 留痕：一个双引擎任务会打十几次 AI 调用，出问题时要能看出每次到底发没发
  // thinking、发的什么档位，而不是靠猜。
  console.log(`  [dual-engine] aiCall(engine=${engine}) thinking=${provider?.thinking || '(未干预)'}`)

  // ── 5 次 retry + 指数退避 ──
  const MAX_RETRY = 5
  // 进过一次"空输出 / 被截断"之后就把思考关掉再重试：32k 输出预算是 reasoning 和
  // 正文**共用**的，推理型模型很容易把预算烧在思考上、正文吐空。关掉思考是唯一
  // 能在不换模型的前提下把预算全部让给正文的办法。
  let thinkingOverride = null
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const remaining = deadlineAt ? deadlineAt - Date.now() : CALL_TIMEOUT_MS
    if (remaining <= CALL_MIN_REMAINING_MS) {
      throw new BudgetExceededError(`双引擎任务总预算（${Math.round(TOTAL_BUDGET_MS / 60000)} 分钟）已耗尽，停止发起新的模型调用`)
    }
    const perTry = Math.min(CALL_TIMEOUT_MS, remaining)
    const thinkingUsed = thinkingOverride ?? provider?.thinking
    const think = thinkingParams(thinkingUsed)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), perTry)
    try {
      const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.1, max_tokens: MAX_TOKENS, ...think }),
        signal: ctrl.signal,
      })
      if (!resp.ok) {
        const t = await resp.text().catch(() => '')
        // 401/403/404 是不可恢复的鉴权问题，不 retry
        if (resp.status === 401 || resp.status === 403 || resp.status === 404) {
          throw new Error(`AI ${engine} ${resp.status} (不可重试): ${t.slice(0, 300)}`)
        }
        throw new Error(`AI ${engine} ${resp.status}: ${t.slice(0, 300)}`)
      }
      const j = await resp.json()
      const choice = j.choices?.[0] || {}
      const msg = choice.message || {}
      const content = msg.content || ''
      const finishReason = choice.finish_reason || ''
      const usage = j.usage || EMPTY_USAGE
      const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0

      console.log(`  [dual-engine] aiCall(engine=${engine}) ok: content=${content.length} chars, finish=${finishReason || '?'}, reasoning=${reasoningTokens} tok, thinking=${thinkingUsed || '(未干预)'}`)

      // 空正文 / 被截断都当可重试错误：正文空着或半截地返回，等于把"模型哑了"
      // 伪装成"审阅不通过"，用户会拿着残缺内容继续往下写。
      if (!content.trim()) {
        throw new Error(`AI ${engine} 返回空 content（finish_reason=${finishReason || '?'}, reasoning=${reasoningTokens} tok）—— 输出预算可能被推理烧穿`)
      }
      if (finishReason === 'length') {
        throw new Error(`AI ${engine} 输出被截断（finish_reason=length, content=${content.length} chars, reasoning=${reasoningTokens} tok）`)
      }
      return { content, usage, finishReason, reasoningTokens, thinkingUsed: thinkingUsed || '' }
    } catch (e) {
      // 空输出/截断 → 下一轮关思考；真实网络错误则保持原档位
      if (/空 content|被截断/.test(e.message || '')) thinkingOverride = 'off'
      if (e.budgetExceeded) throw e
      if (attempt === MAX_RETRY) throw e
      const wait = Math.min(2 ** attempt * 1000, 16_000) + Math.floor(Math.random() * 1000)
      console.warn(`  [dual-engine] aiCall(engine=${engine}) attempt ${attempt}/${MAX_RETRY} failed (${e.message?.slice(0, 80)}), retry in ${wait}ms...`)
      await new Promise(r => setTimeout(r, wait))
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`aiCall failed after ${MAX_RETRY} retries`)
}

// ─── Prompt 构造 ──────────────────────────────────────────────────

const NOT_IN_SOURCE_INSTRUCTIONS = [
  '',
  '【未提及项的固定表达格式（强制机器可识别标记，务必严格遵守）】',
  '6. 当用户任务指令要求源材料未涉及/未提及的字段或子问题时，**必须**以以下固定格式输出：',
  '     `[NOT_IN_SOURCE] <字段名或子问题的简要中文描述>`',
  '7. **必须**保留字面完整的 tag：方括号、全大写英文单词、下划线一个都不能变。',
  '8. 该 tag 是给系统识别的内部标记，前端会自动替换成用户友好文案，你无需担心用户看到 tag 字符本身。',
  '',
  '【引用原文标注（第一次引证锚定用）】',
  '9. 在正文输出完毕后，你**必须**在末尾附加一个引用标注块，格式：',
  '     @@EVIDENCE@@',
  '     原文片段1（≥10字符，必须是源材料中的逐字原文）',
  '     ---',
  '     原文片段2',
  '     ---',
  '     @@END_EVIDENCE@@',
  '10. 每条原文片段必须是从【源材料】中**逐字复制**的连续文本（≥10字符）。',
  '11. 如果你没有引用任何原文，仍然必须输出空的引用块：',
  '     @@EVIDENCE@@',
  '     @@END_EVIDENCE@@',
].join('\n')

const DEFAULT_AI1_ROLE = [
  '你是一名严谨的学术总结助手。用户会提供一段【源材料】和一条【任务指令】，你需要按指令做总结。',
  '',
  '【核心约束（必须严格遵守）】',
  '1. 只使用【源材料】中的信息，禁止引入源材料未提及的外部知识、常识、评论、推测或联想。',
  '2. 若源材料信息不足以完成指令的某一子问题，宁可留白或明确说明，也不要猜测/补全/编造。',
  '3. 忠于原文字面含义，不泛化、不外推、不改写数字/年份/人名/机构。',
  '4. 输出简洁的 Markdown，保持事实性描述，不发表主观评论。',
  '5. 输出语言跟随用户指令：用户指令是中文就用中文输出，用户指令是英文就用英文输出。',
].join('\n')

/**
 * 【源材料前缀】—— 一次任务里每篇文章只在这里出现一次，且是各次调用**逐字节相同**的最长前缀。
 *
 * 为什么必须这么做：模型端点是无状态的，AI-1 首轮 / AI-1 重写 / AI-2 核查 / AI-2 自纠错
 * 每一次请求都必须自己带上【源材料】，没有别的地方能让模型拿到原文。所以"每篇文章只传一次"
 * 在无状态 API 上唯一能落地的形态就是：让【源材料】成为同一条长前缀，
 * 支持前缀缓存的端点（DeepSeek / 硅基流动等）只会真正**处理**它一次，后续调用按缓存命中算；
 * 前缀一旦有任何字节不同，整段缓存失效，同一篇文章就被完整重算一遍。
 *
 * ⇒ 因此**任何"每轮才变"的文案（重写要求、纠错要求、"第 N 轮"）都必须放在源材料之后**，
 *    绝不能进 system；system 只有一点差异，前缀就从头作废。
 *    下面 buildAI1System / AI2_SYSTEM 被首轮与重写轮共用，就是为了守住这条。
 */
function buildSourcePrefix(params) {
  return ['【源材料】', params.sourceMaterial, '', '【任务指令】', params.ai1Instruction].join('\n')
}

/** AI-1 的 system —— 首轮与重写轮**必须完全一样**（重写轮的差异文案见 buildAI1RewriteMessages） */
function buildAI1System(params) {
  return (params.ai1RolePrompt || DEFAULT_AI1_ROLE) + NOT_IN_SOURCE_INSTRUCTIONS
}

function buildAI1FirstMessages(params) {
  const user = buildSourcePrefix(params)
  return [{ role: 'system', content: buildAI1System(params) }, { role: 'user', content: user }]
}

function buildAI1RewriteMessages(params, previousOutput, previousFeedback, attemptIndex, maxAttempts) {
  const feedbackLines = []
  previousFeedback.claims.forEach((c, i) => {
    const tag = c.verdict === 'added' ? '❌ added（必须删除或改写）'
              : c.verdict === 'contradicted' ? '❌ contradicted（必须改写或删除）'
              : c.verdict === 'omitted' ? '⚠️ omitted（源材料里有、你漏了 —— 必须补上）'
              : '✅ supported（可保留）'
    feedbackLines.push(`${i + 1}. ${tag}\n   claim: ${c.claim}`)
    if (c.explanation) feedbackLines.push(`   审查意见: ${c.explanation}`)
    if (c.verdict === 'omitted' && c.source_span) feedbackLines.push(`   源材料原文（补写依据）: ${c.source_span}`)
  })

  // 第一项固定是 buildSourcePrefix(params)，一个字都不能改（见函数上方说明）。
  // 重写专用的约束从这里往下追加；通用约束（只用源材料、忠于原文等）已在 system 里，不重复。
  const user = [
    buildSourcePrefix(params), '',
    '【本轮为重写】',
    '你上一版的输出被审查方（AI-2）判定存在忠实性问题，现在需要根据反馈**重写**。',
    '重写时额外遵守：',
    '1. 对反馈中被判 "added" 的 claim：**必须删除**，或改写为源材料明确支持的说法。',
    '2. 对反馈中被判 "contradicted" 的 claim：**改写为源材料明确支持的说法**，或直接删掉。',
    '3. 对反馈中被判 "omitted" 的 claim：**必须补上**——源材料里确实有这段内容，你上一版漏掉了。',
    '   按反馈里给出的「源材料原文」把这段信息补进正文，数值 / 条件要一字不差。',
    '4. 对反馈中被判 "通过" 的 claim：保留原意。',
    '5. **禁止**为了凑字数补充新的、源材料没有的信息。',
    `这是第 ${attemptIndex}/${maxAttempts} 轮尝试。`,
    '',
    '【上一版你的总结】', previousOutput, '',
    '【AI-2 的忠实性核查反馈】', feedbackLines.join('\n'), '',
    previousFeedback.summary ? `【整体评价】${previousFeedback.summary}` : '',
    '请基于以上反馈重写总结。',
  ].filter(s => s !== '').join('\n')
  return [{ role: 'system', content: buildAI1System(params) }, { role: 'user', content: user }]
}

/** AI-2 侧的源材料前缀 —— 首核与纠错重跑共用同一段（理由见 buildSourcePrefix） */
function buildAI2SourcePrefix(params) {
  return ['【源材料】', params.sourceMaterial].join('\n')
}

/** AI-2 的 system —— 首次核查与纠错重跑**必须完全一样**，差异文案放源材料之后 */
const AI2_SYSTEM = [
  '你是一名严格的忠实性核查助手。你会收到两份内容：',
  '- 【源材料】：唯一 ground truth',
  '- 【AI-1 总结】：待核查的总结', '',
  '【前置抽取规则】',
  '在抽取 claim 之前，先做元陈述过滤：',
  '- 含有 `[NOT_IN_SOURCE]` tag 的行 / 句子，一律不抽取为 claim。', '',
  '【任务 A：正向核查 AI-1 写了什么】',
  '逐条抽取 AI-1 总结中的可核查断言（跳过含 tag 行后），针对每条给出结论：',
  '- supported: 源材料明确支撑该 claim',
  '- added: AI-1 编造/补充了源材料未提及的内容',
  '- contradicted: 源材料的内容与该 claim 矛盾', '',
  '【任务 B：反向扫描源材料，找 AI-1 漏了什么】',
  '任务 A 只核查「AI-1 写出来的内容对不对」，**抓不到「源材料里有、AI-1 没写」的遗漏**。',
  '所以还要反向扫一遍源材料，把 AI-1 漏掉的关键内容报出来，verdict 标 omitted：',
  '- omitted: 源材料中的重要内容，AI-1 完全没有覆盖', '',
  '**omitted 只报这两类**：',
  '  ① 硬信息 —— 数值、实验条件 / 参数、结论性断言、否定性陈述（如"不反应""无活性"）。',
  '  ② 整段论述 —— 源材料中成段的机理阐述 / 论证被整段漏掉。', '',
  '**omitted 绝对不要报**：',
  '  · 展望 / 未来工作 / 后续研究方向',
  '  · 套话、致谢、投稿信息、作者简介',
  '  · 行文风格、修辞、措辞详略的差异',
  '  · 次要举例、补充说明、图注细节', '',
  '**数量与把握**：只报最关键的，**最多 5 条**；没把握的一律不报（宁缺勿滥）。',
  '误报一条 omitted 会让 AI-1 白改一轮 —— 代价比漏报高。', '',
  '【严格要求】',
  '1. supported / contradicted 的 source_span **必须是源材料的原文引用**（≥10 字符，逐字复制）。',
  '2. omitted 的 source_span 也**必须是源材料里被漏掉的那段原文**（≥10 字符，逐字复制）；',
  '   系统会拿它去源材料里做字面匹配 —— 若你编了一段源材料里根本没有的 span，本轮核查结论直接作废。',
  '3. added 的 source_span 为空字符串。',
  '4. omitted 的 claim 字段写「源材料中的这段内容未被覆盖」的简述，不要写成 AI-1 的句子。',
  '5. 只处理 AI-1 总结中真正对源材料做出的事实断言。',
  '6. **passed 定义**：无 added、无 contradicted、无 omitted 时 passed=true。',
  '7. 输出严格 JSON，不要 markdown 代码块。', '',
  '【输出 JSON 结构】',
  '{',
  '  "passed": boolean,',
  '  "claims": [{ "claim": string, "verdict": "supported"|"added"|"contradicted"|"omitted", "source_span": string, "explanation": string }],',
  '  "summary": string',
  '}',
].join('\n')

function buildAI2Messages(params, ai1Output) {
  const user = [
    buildAI2SourcePrefix(params), '',
    '【AI-1 收到的任务指令】', params.ai1Instruction, '',
    '【AI-1 输出的总结】', ai1Output, '',
    '请按 system 指令做忠实性核查，输出 JSON。',
  ].join('\n')
  return [{ role: 'system', content: AI2_SYSTEM }, { role: 'user', content: user }]
}

function buildAI2SelfCorrectMessages(params, ai1Output, previousRawOutput, previousFeedback, attemptIndex, maxAttempts) {
  const failedIndices = previousFeedback.evidenceCheck?.failedIndices || []
  const failedSpans = failedIndices.map(idx => {
    const c = previousFeedback.claims[idx]
    return c ? `- 第 ${idx + 1} 条 claim: "${c.claim}"\n  你之前挑的 span: "${c.source_span}" ← 前端 grep 失败` : ''
  }).filter(s => s !== '').join('\n')
  // 同样以 buildAI2SourcePrefix 打头（一字不改），纠错文案往下追加
  const user = [
    buildAI2SourcePrefix(params), '',
    '【本轮为引证锚定纠错重跑】',
    '你上一版的核查结果**引证锚定失败**，需要重跑核查。', '',
    '【问题】',
    '你挑的 source_span 无法在源材料中定位 — 通常是因为你压缩、改写、意译了源材料原文。', '',
    '【本轮任务】',
    '1. AI-1 的总结保持不变，你需要基于同一份 (源材料, AI-1 总结) 重新给出核查报告。',
    '2. source_span 必须原样 copy 自源材料（≥10 字符，逐字对齐）。',
    '3. 找不到能字面对齐的 span → 先判断该 claim 是否含 [NOT_IN_SOURCE] tag（tag 行应直接剔除）；',
    '   若该 claim 的 verdict 是 omitted，说明你以为漏掉的那段原文其实并不在源材料里 ——',
    '   这是误报，直接删掉这条 claim；否则标 added。',
    '4. 输出严格 JSON，格式与首次核查完全一致。', '',
    `这是第 ${attemptIndex}/${maxAttempts} 轮尝试（AI-2 自我纠错模式）。`, '',
    '【AI-1 输出的总结（保持不变）】', ai1Output, '',
    '【你上一版的原始输出】', previousRawOutput, '',
    '【引证锚定失败的具体 claim】', failedSpans || '（重新做全量核查）', '',
    '请重新做完整的忠实性核查，输出严格 JSON。',
  ].join('\n')
  return [{ role: 'system', content: AI2_SYSTEM }, { role: 'user', content: user }]
}

// ─── 解析 / 校验 ──────────────────────────────────────────────────

function normalizeVerdict(v) {
  if (v === 'supported' || v === 'added' || v === 'contradicted' || v === 'omitted') return v
  if (v === 'out_of_scope') return 'supported'
  return 'added'
}

function parseFaithfulnessReport(rawOutput) {
  let jsonText = rawOutput.trim()
  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) jsonText = fenceMatch[1].trim()
  const firstBrace = jsonText.indexOf('{')
  const lastBrace = jsonText.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) jsonText = jsonText.slice(firstBrace, lastBrace + 1)
  try {
    const parsed = JSON.parse(jsonText)
    const claims = Array.isArray(parsed.claims)
      ? parsed.claims.map(c => ({
          claim: String(c.claim ?? ''),
          verdict: normalizeVerdict(c.verdict),
          source_span: String(c.source_span ?? ''),
          explanation: String(c.explanation ?? ''),
        }))
      : []
    return { passed: Boolean(parsed.passed), claims, summary: String(parsed.summary ?? '') }
  } catch {
    return { passed: false, claims: [], summary: rawOutput.slice(0, 500) }
  }
}

function isMetaClaim(c) {
  return c.claim.includes(NOT_IN_SOURCE_TAG) || c.explanation.includes(NOT_IN_SOURCE_TAG) || c.source_span.includes(NOT_IN_SOURCE_TAG)
}

function parseAI1Evidence(rawOutput) {
  const startIdx = rawOutput.indexOf(EVIDENCE_START)
  const endIdx = rawOutput.indexOf(EVIDENCE_END)
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return { content: rawOutput.trim(), evidenceSpans: [] }
  }
  const content = (rawOutput.slice(0, startIdx) + rawOutput.slice(endIdx + EVIDENCE_END.length)).trim()
  const evidenceBlock = rawOutput.slice(startIdx + EVIDENCE_START.length, endIdx).trim()
  if (!evidenceBlock) return { content, evidenceSpans: [] }
  const evidenceSpans = evidenceBlock.split(/\n---\n|\n---|\n-{3}\n/).map(s => s.trim()).filter(s => s.length >= 10)
  return { content, evidenceSpans }
}

/**
 * 引证核对的匹配口径：忽略空白与 Markdown 强调符。
 *
 * 之前是裸 `sourceMaterial.includes(span)`，而模型复述原文时几乎必然会把换行重排、
 * 把 `**加粗**` 去掉或改写。实测一段从依据里逐字摘出来的规则列表，因为被换行重排，
 * 字面匹配就失败了 —— AI-2 明明判 supported、总结里也写 passed=true，却因为这项
 * 检查被整轮否决。去空白 + 去 `* _ \`` 之后语义不变，仍能挡住真正编造的引文
 * （那种是「依据里根本没有这段话」，不是「排版不同」）。
 */
function normalizeForMatch(s) {
  return String(s ?? '').replace(/[*_`]/g, '').replace(/\s+/g, '')
}

function verifyAI1Evidence(sourceMaterial, evidenceSpans) {
  const haystack = normalizeForMatch(sourceMaterial)
  const failedIndices = []
  let checked = 0, matched = 0
  evidenceSpans.forEach((span, idx) => {
    checked++
    if (haystack.includes(normalizeForMatch(span))) matched++
    else failedIndices.push(idx)
  })
  return { ok: failedIndices.length === 0, checked, matched, failedIndices }
}

function verifyEvidence(sourceMaterial, claims) {
  const haystack = normalizeForMatch(sourceMaterial)
  const failedIndices = []
  let checked = 0, matched = 0
  claims.forEach((c, idx) => {
    if (isMetaClaim(c)) return
    // added 无需 span（源材料未提及，本来就找不到原文）；
    // omitted 相反 —— 它报的正是"源材料里有这段但你漏了"，所以 **必须**带 span 并接受校验：
    // 校验通过 = 这段原文确实存在，"漏"成立；校验失败 = AI-2 凭空说漏，本轮作废。
    if (c.verdict === 'added') return
    checked++
    if (!c.source_span || c.source_span.length < 10) { failedIndices.push(idx); return }
    if (haystack.includes(normalizeForMatch(c.source_span))) matched++
    else failedIndices.push(idx)
  })
  return { ok: failedIndices.length === 0, checked, matched, failedIndices }
}

function decideNextReason(previous) {
  if (previous.ai1EvidenceCheck && !previous.ai1EvidenceCheck.ok) return 'ai1_evidence_failed'
  if (!previous.ai2Feedback.evidenceCheck.ok) return 'ai2_self_correct'
  return 'ai1_rewrite'
}

// ─── 单轮执行 ──────────────────────────────────────────────────

async function runSingleAttempt(params, attemptIndex, maxAttempts, reason, previousAttempt) {
  let ai1RawOutput, ai1Output, ai1Usage = EMPTY_USAGE, ai1Ms = 0, ai1Invoked = false, ai1EvidenceCheck = null

  // AI-1 阶段
  if (reason === 'ai2_self_correct') {
    ai1Output = previousAttempt.ai1Output
    ai1RawOutput = previousAttempt.ai1Output
    ai1EvidenceCheck = previousAttempt.ai1EvidenceCheck
  } else {
    const t0 = Date.now()
    const messages = reason === 'first_run'
      ? buildAI1FirstMessages(params)
      : buildAI1RewriteMessages(params, previousAttempt.ai1Output, previousAttempt.ai2Feedback, attemptIndex, maxAttempts)
    const resp = await aiCall(1, messages[0].content, messages[1].content, params.ai1_provider)
    ai1Ms = Date.now() - t0
    ai1RawOutput = resp.content
    ai1Usage = resp.usage
    ai1Invoked = true
    const parsed = parseAI1Evidence(ai1RawOutput)
    ai1Output = parsed.content
    ai1EvidenceCheck = verifyAI1Evidence(params.sourceMaterial, parsed.evidenceSpans)

    if (!ai1EvidenceCheck.ok) {
      const emptyFeedback = {
        passed: false, claims: [],
        summary: `AI-1 引证锚定失败：标注的 ${ai1EvidenceCheck.failedIndices.length} 条原文引用在源材料中找不到。`,
        evidenceCheck: { ok: false, checked: 0, matched: 0, failedIndices: ai1EvidenceCheck.failedIndices },
      }
      return {
        attempt: attemptIndex, reason, ai1Output, ai1Invoked, ai1Usage, ai1Ms, ai1EvidenceCheck,
        ai2Feedback: emptyFeedback, ai2RawOutput: '', ai2Usage: EMPTY_USAGE, ai2Ms: 0,
        passed: false, previousAI1Output: previousAttempt?.ai1Output ?? null,
      }
    }
  }

  // AI-2 阶段（"空正文"已由 aiCall 内部当可重试错误处理，并会关掉思考重试，这里不再套一层重试）
  //
  // AI-2 彻底哑掉时**不能把 AI-1 的成果一起丢掉**：以前这里直接抛错，ai_call.mjs 只写一份
  // {error}，用户看不到任何正文 —— 这正是"明明生成了却显示失败"的来源。改成降级返回：
  // 正文照给，只是明确标注"这一轮没得到复核"。
  // 但鉴权类错误（401/403/404）例外：那说明 key/端点配错了，必须让用户看到，不能伪装成"AI-2 没说话"。
  const t2 = Date.now()
  let ai2Resp = null
  let ai2Error = null
  try {
    const ai2Messages = reason === 'ai2_self_correct'
      ? buildAI2SelfCorrectMessages(params, ai1Output, previousAttempt.ai2RawOutput, previousAttempt.ai2Feedback, attemptIndex, maxAttempts)
      : buildAI2Messages(params, ai1Output)
    ai2Resp = await aiCall(2, ai2Messages[0].content, ai2Messages[1].content, params.ai2_provider)
  } catch (e) {
    if (/不可重试/.test(e.message || '') || e.budgetExceeded) throw e
    ai2Error = e
  }
  const ai2Ms = Date.now() - t2
  const ai2RawOutput = ai2Resp?.content || ''
  const ai2Silent = !ai2RawOutput.trim()
  const report = ai2Silent ? { passed: false, claims: [], summary: '' } : parseFaithfulnessReport(ai2RawOutput)
  const evidenceCheck = ai2Silent
    ? { ok: false, checked: 0, matched: 0, failedIndices: [] }
    : verifyEvidence(params.sourceMaterial, report.claims)
  // passed 由代码按 verdict 算，**不再采信 AI-2 自填的 report.passed**。
  // 实测：AI-2 会在 claims 全部 supported、引证 16/16 全过的情况下，仅凭 summary 里
  // 一句「漏了 XX」就把 passed 填成 false —— 那个 false 没有任何 claim 支撑，
  // 界面上显示成「处处正常却被打回重写」，用户完全无从判断错在哪。判定权必须收回代码。
  // （AI-2 的 summary 仍然照常透出，作为文字评论，但不再是否决依据。）
  const hasBlocking = report.claims.some(
    (c) => c.verdict === 'added' || c.verdict === 'contradicted' || c.verdict === 'omitted'
  )
  const passed = !ai2Silent && !hasBlocking && evidenceCheck.ok

  const ai2Feedback = {
    passed,
    claims: report.claims,
    summary: ai2Silent
      ? `AI-2 没有返回任何内容${ai2Error ? `（${String(ai2Error.message).slice(0, 200)}）` : ''}，这一轮未获复核。`
      : report.summary,
    evidenceCheck,
  }
  return {
    attempt: attemptIndex, reason, ai1Output, ai1Invoked, ai1Usage, ai1Ms, ai1EvidenceCheck,
    ai2Feedback, ai2RawOutput, ai2Usage: ai2Resp?.usage || EMPTY_USAGE, ai2Ms,
    passed, ai2Silent,
    // AI-2 哑了不是 AI-1 的错：再让它改一遍也没有复核结果，多跑一轮只是白花钱。
    stopRetry: ai2Silent,
    previousAI1Output: previousAttempt?.ai1Output ?? null,
  }
}

// ─── 主入口 ──────────────────────────────────────────────────

/**
 * 后端 runner 的主函数 —— 被 ai-service.mjs 的 dual_engine handler 调用
 * @param {object} input - { taskType, sourceMaterial, ai1Instruction, ai1RolePrompt, maxAttempts }
 * @returns {Promise<object>} DualEngineResult
 */
export async function runDualEngine(input) {
  const params = {
    taskType: input.taskType || 'faithfulness_check',
    sourceMaterial: input.sourceMaterial || '',
    ai1Instruction: input.ai1Instruction || '',
    ai1RolePrompt: input.ai1RolePrompt,
    maxAttempts: Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    // 可选 provider 覆盖 — DualEngineTestPanel 用；不传则用 GitHub Secrets
    ai1_provider: input.ai1 && input.ai1.baseUrl ? input.ai1 : null,
    ai2_provider: input.ai2 && input.ai2.baseUrl ? input.ai2 : null,
  }

  const startedAt = Date.now()
  // 总预算 deadline：所有 aiCall 都看着它决定还能不能再发起调用（见 aiCall 顶部注释）
  deadlineAt = startedAt + TOTAL_BUDGET_MS
  const attempts = []
  const maxAttempts = params.maxAttempts
  let stopReason = ''

  for (let i = 1; i <= maxAttempts; i++) {
    const previous = attempts.length > 0 ? attempts[attempts.length - 1] : null
    const reason = i === 1 ? 'first_run' : decideNextReason(previous)
    let attempt
    try {
      attempt = await runSingleAttempt(params, i, maxAttempts, reason, previous)
    } catch (e) {
      // 只要前面几轮已经产出了结果，就不要因为这一轮失败把整份结果丢掉。
      // 直接抛出去的话 ai_call.mjs 只会写一份 {error}，前端连"跑到第几轮、AI-2 说了什么"
      // 都看不到 —— 用户看到的又是"静默失败"。宁可带着已有结果 + 一句原因正常返回。
      if (attempts.length > 0) {
        stopReason = e.budgetExceeded ? 'budget_exceeded' : 'call_failed'
        console.warn(`  [dual-engine] 第 ${i} 轮失败（${e.message?.slice(0, 120) || e}）；带着已有 ${attempts.length} 轮结果返回`)
        break
      }
      throw e
    }
    attempts.push(attempt)
    if (attempt.passed) break
    if (attempt.stopRetry) { stopReason = 'ai2_silent'; console.warn('  [dual-engine] AI-2 无输出，停止后续轮次（再重写一遍也换不来复核）'); break }
  }

  if (attempts.length === 0) {
    throw new Error(`双引擎没有产生任何结果${stopReason ? `（${stopReason}）` : ''}`)
  }

  const last = attempts[attempts.length - 1]
  return {
    taskType: params.taskType,
    sourceMaterial: params.sourceMaterial,
    ai1Instruction: params.ai1Instruction,
    ai1Model: AI1_MODEL,
    ai2Model: AI2_MODEL,
    ai1Output: last.ai1Output,
    ai2Feedback: last.ai2Feedback,
    ai2RawOutput: last.ai2RawOutput,
    attempts,
    maxAttempts,
    finalPassed: last.passed,
    /** AI-2 是"没说话"而不是"说不忠实"—— 前端据此不要把两件事混为一谈 */
    ai2Silent: !!last.ai2Silent,
    /** 提前收尾的原因：'' | 'ai2_silent' | 'budget_exceeded' */
    stopReason,
    ai1Usage: attempts[0].ai1Usage,
    ai2Usage: attempts[0].ai2Usage,
    startedAt,
    finishedAt: Date.now(),
  }
}

// 允许直接 node 执行（调试用）
if (process.argv[1]?.includes('dual_engine_runner')) {
  const input = JSON.parse(process.argv[2] || '{}')
  runDualEngine(input).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e); process.exit(1) })
}

export { normalizeVerdict, verifyEvidence, parseFaithfulnessReport };
