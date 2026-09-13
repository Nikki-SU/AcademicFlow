#!/usr/bin/env node
/**
 * MinerU 联通性测试脚本 —— GitHub Actions runner
 *
 * 只做一件事：POST /api/v4/file-urls/batch 申请上传 URL。
 * 不真的上传 PDF、不轮询解析、零 MinerU 配额消耗。
 *
 * 成功 → exit 0，日志打印 batch_id / upload_url
 * 失败 → exit 1，日志打印 MinerU 返回的具体错误
 *
 * 用法：node mineru-test.mjs
 * 环境变量：MINERU_API_TOKEN（必需，从 GitHub Secrets 注入）
 */
const MINERU_API = 'https://mineru.net/api/v4'

const TOKEN = process.env.MINERU_API_TOKEN
if (!TOKEN) {
  console.error('❌ MINERU_API_TOKEN secret 未配置')
  process.exit(1)
}

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 15000)

try {
  const res = await fetch(`${MINERU_API}/file-urls/batch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      files: [{ name: 'connectivity-test.pdf', is_ocr: false }],
      model_version: 'pipeline',
      enable_formula: false,
      enable_table: false,
      language: 'auto',
    }),
    signal: controller.signal,
  })
  clearTimeout(timer)

  const txt = await res.text()

  if (!res.ok) {
    console.error(`❌ MinerU HTTP ${res.status} ${res.statusText}`)
    console.error(`   ${txt.slice(0, 500)}`)
    // 常见错误码给友好提示
    if (res.status === 401 || res.status === 403) {
      console.error('   → Token 无效或已过期，请在 Settings 页重新填写 MinerU Token')
    } else if (res.status === 429) {
      console.error('   → MinerU 配额耗尽或请求太频繁')
    }
    process.exit(1)
  }

  let data
  try { data = JSON.parse(txt) } catch {
    console.error(`❌ MinerU 返回非 JSON：${txt.slice(0, 200)}`)
    process.exit(1)
  }

  if (data.code !== 0) {
    console.error(`❌ MinerU 拒绝：code=${data.code} msg=${data.msg}`)
    process.exit(1)
  }

  const batchId = data?.data?.batch_id
  const uploadUrl = data?.data?.file_urls?.[0]
  console.log('✅ MinerU 联通成功！')
  console.log(`   batch_id: ${batchId}`)
  console.log(`   upload_url: ${uploadUrl ? uploadUrl.slice(0, 80) + '...' : '(none)'}`)
} catch (e) {
  clearTimeout(timer)
  if (e?.name === 'AbortError') {
    console.error('❌ 请求超时（15s）—— runner 无法连接 mineru.net，可能是网络阻断')
  } else {
    console.error(`❌ 网络错误：${e?.message || String(e)}`)
  }
  process.exit(1)
}
