/**
 * runner 改动的本地验证 —— 用一个 mock HTTP server 假扮 AI-1 / AI-2 的 OpenAI 兼容端点，
 * 端到端跑 runDualEngine，覆盖三个关键场景。
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

const ai2 = (claims, summary) => JSON.stringify({ passed: false, claims, summary })

const SCENARIOS = {
  // 场景 1：复现用户踩的坑 —— claims 全 supported、引证全过，但 AI-2 自填 passed:false
  'ai2-all-supported': ai2(
    [{ claim: '本实验在 200 °C 下反应', verdict: 'supported', source_span: EVIDENCE_SPAN, explanation: '源材料支撑' }],
    '缺少源材料提到的反应时间24小时，不过这不构成事实性错误。'
  ),
  // 场景 2：omitted 且 source_span 真实存在于源材料
  'ai2-omitted-real': ai2(
    [{ claim: '源材料提到的 5 MPa 压力未被覆盖', verdict: 'omitted', source_span: EVIDENCE_SPAN, explanation: '漏了压力条件' }],
    '漏掉了关键实验条件。'
  ),
  // 场景 3：omitted 但 source_span 是编造的
  'ai2-omitted-fake': ai2(
    [{ claim: '源材料某内容未被覆盖', verdict: 'omitted', source_span: '这段原文在源材料里根本不存在啊啊啊', explanation: '瞎报' }],
    '漏了。'
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

const show = (tag, r) => {
  const f = r.ai2Feedback
  console.log(`\n=== ${tag} ===`)
  console.log('finalPassed  :', r.finalPassed)
  console.log('evidenceCheck:', JSON.stringify(f.evidenceCheck))
  console.log('verdicts     :', f.claims.map((c) => c.verdict).join(', ') || '(无)')
}

scenario = 'ai2-all-supported'
show('场景1 全supported但passed自填false  → 期望 finalPassed=true', await runDualEngine(input))

scenario = 'ai2-omitted-real'
show('场景2 omitted + span真实存在        → 期望 finalPassed=false, evidenceOk=true', await runDualEngine(input))

scenario = 'ai2-omitted-fake'
show('场景3 omitted + span编造            → 期望 finalPassed=false, evidenceOk=false', await runDualEngine(input))

server.close()
