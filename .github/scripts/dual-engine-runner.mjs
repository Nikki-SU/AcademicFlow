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

// ─── AI 调用（复用 ai-service.mjs 的 aiCall 签名） ────────────────
// provider 可选覆盖：{ baseUrl, apiKey, model } — DualEngineTestPanel 用；不传则用 Secrets
async function aiCall(engine, system, user, provider) {
  const baseUrl = provider?.baseUrl || (engine === 2 ? AI2_BASE_URL : AI1_BASE_URL)
  const apiKey  = provider?.apiKey  || (engine === 2 ? AI2_API_KEY  : AI1_API_KEY)
  const model   = provider?.model   || (engine === 2 ? AI2_MODEL    : AI1_MODEL)
  const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.1, max_tokens: 16000 }),
  })
  if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error(`AI ${engine} ${resp.status}: ${t.slice(0, 300)}`) }
  const j = await resp.json()
  const choice = j.choices?.[0] || {}
  const msg = choice.message || {}
  return { content: msg.content || '', usage: j.usage || EMPTY_USAGE }
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

function buildAI1FirstMessages(params) {
  const roleDesc = params.ai1RolePrompt || DEFAULT_AI1_ROLE
  const system = roleDesc + NOT_IN_SOURCE_INSTRUCTIONS
  const user = ['【源材料】', params.sourceMaterial, '', '【任务指令】', params.ai1Instruction].join('\n')
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

function buildAI1RewriteMessages(params, previousOutput, previousFeedback, attemptIndex, maxAttempts) {
  const roleDesc = params.ai1RolePrompt
    ? params.ai1RolePrompt.replace(/你是一名.+?(?=【核心约束)/s, '你上一版的输出被审查方（AI-2）判定存在忠实性问题，现在需要根据反馈**重写**。')
    : '你是一名严谨的学术总结助手。你上一版的总结被审查方（AI-2）判定存在忠实性问题，现在需要根据反馈**重写**。'

  const system = [
    roleDesc, '', '【核心约束（必须严格遵守）】',
    '1. 只使用【源材料】中的信息，禁止引入外部知识。',
    '2. 对反馈中被判 "added" 的 claim：**必须删除**，或改写为源材料明确支持的说法。',
    '3. 对反馈中被判 "contradicted" 的 claim：**改写为源材料明确支持的说法**，或直接删掉。',
    '4. 对反馈中被判 "通过" 的 claim：保留原意。',
    '5. **禁止**为了凑字数补充新的、源材料没有的信息。',
    '6. 忠于原文字面含义。输出简洁的 Markdown，不发表主观评论。',
    NOT_IN_SOURCE_INSTRUCTIONS, '',
    `这是第 ${attemptIndex}/${maxAttempts} 轮尝试。`,
  ].join('\n')

  const feedbackLines = []
  previousFeedback.claims.forEach((c, i) => {
    const tag = c.verdict === 'added' ? '❌ added（必须删除或改写）'
              : c.verdict === 'contradicted' ? '❌ contradicted（必须改写或删除）'
              : '✅ supported（可保留）'
    feedbackLines.push(`${i + 1}. ${tag}\n   claim: ${c.claim}`)
    if (c.explanation) feedbackLines.push(`   审查意见: ${c.explanation}`)
  })

  const user = [
    '【源材料】', params.sourceMaterial, '',
    '【任务指令】', params.ai1Instruction, '',
    '【上一版你的总结】', previousOutput, '',
    '【AI-2 的忠实性核查反馈】', feedbackLines.join('\n'), '',
    previousFeedback.summary ? `【整体评价】${previousFeedback.summary}` : '',
    '请基于以上反馈重写总结。',
  ].filter(s => s !== '').join('\n')
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

function buildAI2Messages(params, ai1Output) {
  const system = [
    '你是一名严格的忠实性核查助手。你会收到两份内容：',
    '- 【源材料】：唯一 ground truth',
    '- 【AI-1 总结】：待核查的总结', '',
    '【前置抽取规则】',
    '在抽取 claim 之前，先做元陈述过滤：',
    '- 含有 `[NOT_IN_SOURCE]` tag 的行 / 句子，一律不抽取为 claim。',
    '',
    '【任务】',
    '逐条抽取 AI-1 总结中的可核查断言（跳过含 tag 行后），针对每条给出结论：',
    '- supported: 源材料明确支撑该 claim',
    '- added: AI-1 编造/补充了源材料未提及的内容',
    '- contradicted: 源材料的内容与该 claim 矛盾', '',
    '【严格要求】',
    '1. supported/contradicted 的 source_span **必须是源材料的原文引用**（≥10 字符，逐字复制）。',
    '2. added 的 source_span 为空字符串。',
    '3. 只处理 AI-1 总结中真正对源材料做出的事实断言。',
    '4. **passed 定义**：无 added 且无 contradicted 时 passed=true。',
    '5. 输出严格 JSON，不要 markdown 代码块。', '',
    '【输出 JSON 结构】',
    '{',
    '  "passed": boolean,',
    '  "claims": [{ "claim": string, "verdict": "supported"|"added"|"contradicted", "source_span": string, "explanation": string }],',
    '  "summary": string',
    '}',
  ].join('\n')
  const user = ['【源材料】', params.sourceMaterial, '', '【AI-1 收到的任务指令】', params.ai1Instruction, '', '【AI-1 输出的总结】', ai1Output, '', '请按 system 指令做忠实性核查，输出 JSON。'].join('\n')
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

function buildAI2SelfCorrectMessages(params, ai1Output, previousRawOutput, previousFeedback, attemptIndex, maxAttempts) {
  const system = [
    '你是一名严格的忠实性核查助手。你上一版的核查结果**引证锚定失败**，需要重跑核查。', '',
    '【问题】',
    '你挑的 source_span 无法在源材料中定位 — 通常是因为你压缩、改写、意译了源材料原文。', '',
    '【本轮任务】',
    '1. AI-1 的总结保持不变，你需要基于同一份 (源材料, AI-1 总结) 重新给出核查报告。',
    '2. source_span 必须原样 copy 自源材料（≥10 字符，逐字对齐）。',
    '3. 找不到能字面对齐的 span → 先判断该 claim 是否含 [NOT_IN_SOURCE] tag（tag 行应直接剔除），否则标 added。',
    '4. 输出严格 JSON，格式与首次核查完全一致。', '',
    `这是第 ${attemptIndex}/${maxAttempts} 轮尝试（AI-2 自我纠错模式）。`,
  ].join('\n')
  const failedIndices = previousFeedback.evidenceCheck?.failedIndices || []
  const failedSpans = failedIndices.map(idx => {
    const c = previousFeedback.claims[idx]
    return c ? `- 第 ${idx + 1} 条 claim: "${c.claim}"\n  你之前挑的 span: "${c.source_span}" ← 前端 grep 失败` : ''
  }).filter(s => s !== '').join('\n')
  const user = ['【源材料】', params.sourceMaterial, '', '【AI-1 输出的总结（保持不变）】', ai1Output, '', '【你上一版的原始输出】', previousRawOutput, '', '【引证锚定失败的具体 claim】', failedSpans || '（重新做全量核查）', '', '请重新做完整的忠实性核查，输出严格 JSON。'].join('\n')
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

// ─── 解析 / 校验 ──────────────────────────────────────────────────

function normalizeVerdict(v) {
  if (v === 'supported' || v === 'added' || v === 'contradicted') return v
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

function verifyAI1Evidence(sourceMaterial, evidenceSpans) {
  const failedIndices = []
  let checked = 0, matched = 0
  evidenceSpans.forEach((span, idx) => {
    checked++
    if (sourceMaterial.includes(span)) matched++
    else failedIndices.push(idx)
  })
  return { ok: failedIndices.length === 0, checked, matched, failedIndices }
}

function verifyEvidence(sourceMaterial, claims) {
  const failedIndices = []
  let checked = 0, matched = 0
  claims.forEach((c, idx) => {
    if (isMetaClaim(c)) return
    if (c.verdict === 'added') return
    checked++
    if (!c.source_span || c.source_span.length < 10) { failedIndices.push(idx); return }
    if (sourceMaterial.includes(c.source_span)) matched++
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

  // AI-2 阶段
  const t2 = Date.now()
  const ai2Messages = reason === 'ai2_self_correct'
    ? buildAI2SelfCorrectMessages(params, ai1Output, previousAttempt.ai2RawOutput, previousAttempt.ai2Feedback, attemptIndex, maxAttempts)
    : buildAI2Messages(params, ai1Output)
  const ai2Resp = await aiCall(2, ai2Messages[0].content, ai2Messages[1].content, params.ai2_provider)
  const ai2Ms = Date.now() - t2
  const report = parseFaithfulnessReport(ai2Resp.content)
  const evidenceCheck = verifyEvidence(params.sourceMaterial, report.claims)
  const passed = report.passed && evidenceCheck.ok

  const ai2Feedback = { passed, claims: report.claims, summary: report.summary, evidenceCheck }
  return {
    attempt: attemptIndex, reason, ai1Output, ai1Invoked, ai1Usage, ai1Ms, ai1EvidenceCheck,
    ai2Feedback, ai2RawOutput: ai2Resp.content, ai2Usage: ai2Resp.usage, ai2Ms,
    passed, previousAI1Output: previousAttempt?.ai1Output ?? null,
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
  const attempts = []
  const maxAttempts = params.maxAttempts

  for (let i = 1; i <= maxAttempts; i++) {
    const previous = attempts.length > 0 ? attempts[attempts.length - 1] : null
    const reason = i === 1 ? 'first_run' : decideNextReason(previous)
    const attempt = await runSingleAttempt(params, i, maxAttempts, reason, previous)
    attempts.push(attempt)
    if (attempt.passed) break
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
    ai1Usage: attempts[0].ai1Usage,
    ai2Usage: attempts[0].ai2Usage,
    startedAt,
    finishedAt: Date.now(),
  }
}

// 允许直接 node 执行（调试用）
if (process.argv[1]?.includes('dual-engine-runner')) {
  const input = JSON.parse(process.argv[2] || '{}')
  runDualEngine(input).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e); process.exit(1) })
}
