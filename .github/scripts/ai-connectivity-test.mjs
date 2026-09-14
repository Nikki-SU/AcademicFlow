#!/usr/bin/env node
/**
 * AI Connectivity Test —— 在 GitHub Actions Runner 上跑
 *
 * 设计原则：Runner 有正常网络 + HTTPS_PROXY 环境（runner 自己带代理），
 * 所以这里直接 POST /v1/chat/completions 就是**真实运行环境**的测试。
 * 前端"测试连接"按钮不直连 AI API，而是 dispatch 这个 workflow，
 * 因为 AI 真正在 Runner 里跑。
 *
 * 与 pipeline.mjs 里的 quickAiHealthCheck 是**同一份逻辑**，
 * 但加了更详细的 PASS/FAIL 输出，方便在 runner logs 里一眼看懂。
 */
const {
  AI1_BASE_URL, AI1_API_KEY, AI1_MODEL,
  AI2_BASE_URL, AI2_API_KEY, AI2_MODEL,
  TARGET,
} = process.env

let pass = 0, fail = 0, skipped = 0

async function test(label, baseUrl, apiKey, model) {
  if (!baseUrl || !apiKey || !model) {
    console.log(`\n${label}: SKIP (secret 缺失 — baseUrl/apiKey/model 任一为空)`)
    skipped++
    return
  }

  const t0 = Date.now()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15_000)
    const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const elapsed = Date.now() - t0
    const body = await resp.text().catch(() => '')

    if (resp.ok) {
      let tokens = '?'
      try {
        tokens = JSON.parse(body).usage?.completion_tokens ?? '?'
      } catch {}
      console.log(`\n${label}: ✓ PASS — HTTP ${resp.status} · ${elapsed}ms · completion_tokens=${tokens}`)
      console.log(`     endpoint: ${baseUrl}/chat/completions`)
      console.log(`     model:    ${model}`)
      pass++
    } else {
      let hint = ''
      if (resp.status === 401) hint = 'API Key 无效或已过期'
      else if (resp.status === 403) hint = '没有权限 —— 可能需要充值 / 开通'
      else if (resp.status === 404) hint = 'baseUrl 或 model 不存在'
      else if (resp.status === 429) hint = '限流了'
      else if (resp.status === 400) hint = 'model ID 可能不对 — 七牛云需要厂商前缀如 deepseek/xxx'
      console.log(`\n${label}: ✗ FAIL — HTTP ${resp.status} ${hint}`)
      console.log(`     endpoint: ${baseUrl}/chat/completions`)
      console.log(`     model:    ${model}`)
      console.log(`     body:     ${body.slice(0, 300)}`)
      fail++
    }
  } catch (e) {
    const elapsed = Date.now() - t0
    const reason = e.name === 'AbortError'
      ? `连接超时（15s）—— 检查 baseUrl 是否正确`
      : e.message || String(e)
    console.log(`\n${label}: ✗ FAIL — ${reason} (${elapsed}ms)`)
    console.log(`     endpoint: ${baseUrl}/chat/completions`)
    console.log(`     model:    ${model}`)
    fail++
  }
}

const target = (TARGET || 'both').trim()
console.log('═══════════════════════════════════════════════')
console.log('  AI Connectivity Test (runner-side)')
console.log('═══════════════════════════════════════════════')
console.log(`  target = ${target}`)

if (target !== 'ai2')  await test('AI1', AI1_BASE_URL, AI1_API_KEY, AI1_MODEL)
if (target !== 'ai1')  await test('AI2', AI2_BASE_URL, AI2_API_KEY, AI2_MODEL)

console.log('\n═══════════════════════════════════════════════')
console.log(`  结果: ${pass} 通过 / ${fail} 失败 / ${skipped} 跳过`)
console.log('═══════════════════════════════════════════════')

if (fail > 0) {
  process.exit(1)
}
