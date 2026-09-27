/**
 * runner 改动的本地验证 —— 用一个 mock HTTP server 假扮 AI-1 / AI-2 的 OpenAI 兼容端点，
 * 端到端跑 runDualEngine，覆盖「omitted 降级为提示」后的判定语义。
 *
 * 核心断言：passed 只由 added / contradicted + 引证锚定决定；
 * omitted 无论真假都不阻断，只是多出来一条提示。
 */
import http from 'node:http'
import { runDualEngine } from './runner-test.mjs'

const SOURCE = '本实验在 200 °C、5 MPa 下反应 24 小时，产物 4a 产率 73%。光照与光催化剂是必需条件。'
const EVIDENCE_SPAN = '本实验在 200 °C、5 MPa 下反应 24 小时'

const AI1_CONTENT = [
  '本实验在 200 °C、5 MPa 下反应 24 小时，产物 4a 产率 73%。',
  '@@EVIDENCE@@',
  EVIDENCE_SPAN,
  '@@END_EVIDENCE@@',
].join('\n')

// passed 一律故意填 false —— 就是要证明代码不再采信 AI-2 自填的这个字段
const ai2 = (claims, summary) => JSON.stringify({ passed: false, claims, summary })

const SCENARIOS = {
  // 1. 复现用户踩的坑：claims 全 supported、引证全过，但 AI-2 自填 passed:false
  'ai2-all-supported': ai2(
    [{ claim: '本实验在 200 °C 下反应', verdict: 'supported', source_span: EVIDENCE_SPAN, explanation: '源材料支撑' }],
    '缺少源材料提到的反应时间24小时，不过这不构成事实性错误。'
  ),
  // 2. omitted，span 真实存在（以前会打回，现在只提示）
  'ai2-omitted-real': ai2(
    [{ claim: '源材料提到的 5 MPa 压力未被覆盖', verdict: 'omitted', source_span: EVIDENCE_SPAN, explanation: '漏了压力条件' }],
    '漏掉了关键实验条件。'
  ),
  // 3. omitted，span 编造（以前会打回，现在也只提示、不做锚定校验）
  'ai2-omitted-fake': ai2(
    [{ claim: '源材料某内容未被覆盖', verdict: 'omitted', source_span: '这段原文在源材料里根本不存在啊啊啊', explanation: '瞎报' }],
    '漏了。'
  ),
  // 4. added —— 编造，必须阻断
  'ai2-added': ai2(
    [{ claim: '实验在 120 °C 下进行', verdict: 'added', source_span: '', explanation: '源材料未提及此温度' }],
    'AI-1 编造了温度条件。'
  ),
  // 5. contradicted —— 曲解，必须阻断
  'ai2-contradicted': ai2(
    [{ claim: '光照不是必需条件', verdict: 'contradicted', source_span: EVIDENCE_SPAN, explanation: '与源材料矛盾' }],
    'AI-1 曲解了实验结论。'
  ),
}

let scenario = 'ai2-all-supported'

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const j = JSON.parse(body || '{}')
    const content = j.model === 'ai1-model' ? AI1_CONTENT : SCENARIOS[scenario]
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }))
  })
})

await new Promise((r) => server.listen(8899, '127.0.0.1', r))

const base = { baseUrl: 'http://127.0.0.1:8899', apiKey: 'x' }
const input = {
  taskType: 'paper_convert',
  sourceMaterial: SOURCE,
  ai1Instruction: '总结这段材料。',
  maxAttempts: 1,
  ai1: { ...base, model: 'ai1-model' },
  ai2: { ...base, model: 'ai2-model' },
}

let failed = 0
async function check(tag, scenarioKey, expect) {
  scenario = scenarioKey
  const r = await runDualEngine(input)
  const f = r.ai2Feedback
  const verdicts = f.claims.map((c) => c.verdict).join(', ') || '(无)'
  const got = {
    finalPassed: r.finalPassed,
    evidenceOk: f.evidenceCheck.ok,
    checked: f.evidenceCheck.checked,
  }
  const ok = Object.entries(expect).every(([k, v]) => got[k] === v)
  if (!ok) failed++
  console.log(`\n${ok ? '✅' : '❌'} ${tag}`)
  console.log(`   verdicts     : ${verdicts}`)
  console.log(`   finalPassed  : ${got.finalPassed}  (期望 ${expect.finalPassed})`)
  console.log(`   evidenceCheck: ok=${got.evidenceOk} checked=${got.checked}  (期望 ok=${expect.evidenceOk}${'checked' in expect ? ` checked=${expect.checked}` : ''})`)
}

await check('场景1 全 supported + AI-2 自填 passed:false → 应通过', 'ai2-all-supported', { finalPassed: true, evidenceOk: true })
await check('场景2 omitted + span 真实 → 通过（仅提示），omitted 不进锚定校验', 'ai2-omitted-real', { finalPassed: true, evidenceOk: true, checked: 0 })
await check('场景3 omitted + span 编造 → 仍通过（omitted 不校验、不阻断）', 'ai2-omitted-fake', { finalPassed: true, evidenceOk: true, checked: 0 })
await check('场景4 added → 阻断', 'ai2-added', { finalPassed: false })
await check('场景5 contradicted → 阻断', 'ai2-contradicted', { finalPassed: false })

server.close()
console.log(failed === 0 ? '\n全部通过 🎉' : `\n${failed} 个场景未达预期 ❌`)
process.exit(failed === 0 ? 0 : 1)
