#!/usr/bin/env node
/**
 * AcademicFlow通用AI服务 — GitHub Actions Runner
 *
 * 触发：repository_dispatch event_type=ai_call
 * payload: { task_id, task_type, input_json, output_path, ai_engine: 1|2(默认1) }
 *
 * 支持的 task_type（逐个 handler）：
 *   - chat            : system + user message → 回复内容
 *   - json_extract    : AI-1 从文本中抽 JSON 结构化数据
 *   - freeform        : 自由 prompt（不指定 system，input_json.system + input_json.user）
 *
 * 进度：写 output_path + '.progress' 进度文件（前端轮询用 output_path）
 *
 * Secrets：同 pipeline.yml 的 AI1/AI2_*
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const { AI1_BASE_URL, AI1_API_KEY, AI1_MODEL,
        AI2_BASE_URL, AI2_API_KEY, AI2_MODEL,
        GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env

if (!AI1_API_KEY) { console.error('❌ AI1_API_KEY not set'); process.exit(1) }

const REPO_ROOT = process.cwd()

async function aiCall(engine, systemOrOpts, userMaybe) {
  const baseUrl = engine === 2 ? AI2_BASE_URL : AI1_BASE_URL
  const apiKey = engine === 2 ? AI2_API_KEY : AI1_API_KEY
  const model = engine === 2 ? AI2_MODEL : AI1_MODEL

  // 新签名：aiCall(engine, { messages, temperature, maxTokens })
  let messages, temperature = 0.1, maxTokens = 16000
  if (typeof systemOrOpts === 'object' && Array.isArray(systemOrOpts.messages)) {
    messages = systemOrOpts.messages
    temperature = systemOrOpts.temperature ?? 0.1
    maxTokens = systemOrOpts.maxTokens ?? 16000
  } else {
    // 旧签名：aiCall(engine, system, user) — freeform / json_extract 还在用
    messages = [{ role: 'system', content: systemOrOpts || '' }, { role: 'user', content: userMaybe || '' }]
  }

  // ── 5 次 retry + 指数退避 ──
  // pipeline.mjs 已验证过 AI 端点可用，但单条请求仍可能遇到瞬时 502 / 限流 / 网络抖动
  const MAX_RETRY = 5
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
      })
      if (!resp.ok) {
        const t = await resp.text().catch(() => '')
        // 401/403 是不可恢复的鉴权问题，不 retry
        if (resp.status === 401 || resp.status === 403 || resp.status === 404) {
          throw new Error(`AI ${engine} ${resp.status} (不可重试): ${t.slice(0, 300)}`)
        }
        // 其他 4xx/5xx 或网络错误 → retry
        throw new Error(`AI ${engine} ${resp.status}: ${t.slice(0, 300)}`)
      }
      const j = await resp.json()
      const choice = j.choices?.[0] || {}
      return {
        content: choice.message?.content || '',
        usage: j.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        finish_reason: choice.finish_reason || 'stop',
        model: j.model || '',
      }
    } catch (e) {
      // 最后一次直接抛
      if (attempt === MAX_RETRY) throw e
      const wait = Math.min(2 ** attempt * 1000, 16_000) + Math.floor(Math.random() * 1000)
      console.warn(`  [ai-service] aiCall attempt ${attempt}/${MAX_RETRY} failed (${e.message?.slice(0, 80)}), retry in ${wait}ms...`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
  // 理论上到不了这里
  throw new Error(`aiCall failed after ${MAX_RETRY} retries`)
}

async function commitFile(outputRelPath, message) {
  // 和 pipeline.mjs 一样：retry + rebase 防 non-fast-forward 竞态
  try { execSync(`git add "${outputRelPath}"`, { cwd: REPO_ROOT, stdio: 'pipe' }) } catch {}
  try {
    execSync(`git commit -m "${message.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { cwd: REPO_ROOT, stdio: 'pipe' })
  } catch (e) {
    // nothing to commit → 跳过 push
    if (e.stdout?.toString().includes('nothing to commit')) return
    throw e
  }

  const MAX_RETRY = 3
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      execSync(`git fetch origin main`, { cwd: REPO_ROOT, stdio: 'pipe' })
      execSync(`git rebase origin/main`, { cwd: REPO_ROOT, stdio: 'pipe' })
      execSync(`git push origin main`, { cwd: REPO_ROOT, stdio: 'pipe' })
      return
    } catch (e) {
      const stderr = e.stderr?.toString() || ''
      const isConflict = stderr.includes('could not apply') || stderr.includes('conflict') || stderr.includes('non-fast-forward')
      try { execSync(`git rebase --abort`, { cwd: REPO_ROOT, stdio: 'pipe' }) } catch {}
      if (attempt < MAX_RETRY && isConflict) {
        console.warn(`  [commitFile] push attempt ${attempt} failed (conflict), retrying...`)
        await sleep(attempt * 3000)
      } else {
        throw e
      }
    }
  }
}

// Handlers
const HANDLERS = {
  chat: async (input, engine) => {
    if (Array.isArray(input.messages)) {
      // 新格式：完整 messages array + 可选 temperature/maxTokens（前端 callAI wrapper 用）
      const r = await aiCall(engine, {
        messages: input.messages,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      })
      return { content: r.content, usage: r.usage, finish_reason: r.finish_reason, model: r.model }
    }
    // 旧格式：system + user 字符串
    const system = input.system || 'You are a helpful assistant.'
    const user = typeof input === 'string' ? input : input.user || input.prompt || ''
    const r = await aiCall(engine, system, user)
    return { content: r.content, usage: r.usage, finish_reason: r.finish_reason, model: r.model }
  },
  freeform: async (input, engine) => {
    const r = await aiCall(engine, input.system || '', input.user || input.prompt || '')
    return { content: r.content, usage: r.usage }
  },
  json_extract: async (input, engine) => {
    const system = input.system || 'You extract structured JSON from the given text. Return ONLY valid JSON, no code fences.'
    const r = await aiCall(engine, system, input.text || input.content || input)
    try { return { content: r.content, usage: r.usage, data: JSON.parse(r.content) } }
    catch { return { content: r.content, usage: r.usage, data: null, parse_error: true } }
  },
  // 为每个零散 AI 功能预留：
  guideline_extract: async (input, engine) => {
    const system = `你是期刊投稿规范专家。从给定的作者须知原文中，提取结构化的关键规则。
输出 JSON 格式（直接输出，不要代码块标记）：
{
  "sections": [{ "heading": string, "content": string }],
  "hard_deadlines": [string],
  "format_requirements": [string],
  "submission_steps": [string],
  "special_notes": [string]
}`
    const r = await aiCall(engine, system, input.guidelines_text || input.text || '')
    try { return { content: r.content, usage: r.usage, data: JSON.parse(r.content) } }
    catch { return { content: r.content, usage: r.usage, data: null, parse_error: true } }
  },
  cover_figure: async (input, engine) => {
    const system = `你是学术论文审稿专家。根据论文全文和图片信息，判断哪张图最可能是题图（graphical abstract / cover figure）。
输出 JSON：{ "figure_index": number, "reason": string, "confidence": "high"|"medium"|"low" }`
    const r = await aiCall(engine, system, JSON.stringify({ figures: input.figures || [], paper_context: input.paper_context || '' }))
    try { return { content: r.content, usage: r.usage, data: JSON.parse(r.content) } }
    catch { return { content: r.content, usage: r.usage, data: null, parse_error: true } }
  },
  latex_convert: async (input, engine) => {
    const system = `你是 LaTeX 转换专家。将给定的 Markdown 转换为 LaTeX 源文件，处理公式、表格、参考文献。
输出完整 .tex 文件内容（包含 documentclass, usepackage, document 环境）。`
    const r = await aiCall(engine, system, input.markdown || input.text || '')
    return { content: r.content, usage: r.usage }
  },
  // M3.6 双引擎编排（AI-1 生成 + AI-2 忠实性核查 + 分层归因重试循环）
  // 特殊：此 handler 同时使用 AI1 + AI2，不接受 ai_engine 参数覆盖
  dual_engine: async (input, _engine) => {
    const { runDualEngine } = await import('./dual-engine-runner.mjs')
    const result = await runDualEngine(input)
    return { data: result, content: result.ai1Output }
  },
}

async function main() {
  const payload = JSON.parse(process.argv[2] || '{}')
  const { task_id, task_type, input_json, output_path, ai_engine } = payload
  if (!task_type || !output_path) { console.error('❌ 需要 task_type + output_path'); process.exit(1) }

  const engine = ai_engine === 2 ? 2 : 1
  console.log(`=== AI Service start ===`)
  console.log(`  task_id: ${task_id}, type: ${task_type}, engine: ${engine}`)

  const handler = HANDLERS[task_type]
  if (!handler) {
    console.error(`❌ 未知 task_type: ${task_type}`)
    try {
      fs.mkdirSync(path.join(REPO_ROOT, path.dirname(output_path)), { recursive: true })
      fs.writeFileSync(path.join(REPO_ROOT, output_path), JSON.stringify({ error: `unknown task_type: ${task_type}`, available: Object.keys(HANDLERS) }))
      await commitFile(output_path, `[ai-service] failed: unknown task_type`)
    } catch {}
    process.exit(1)
  }

  try {
    const input = typeof input_json === 'string' ? JSON.parse(input_json) : (input_json || {})
    const result = await handler(input, engine)
    const localPath = path.join(REPO_ROOT, output_path)
    fs.mkdirSync(path.dirname(localPath), { recursive: true })
    fs.writeFileSync(localPath, JSON.stringify({ task_id, task_type, engine, input_keys: Object.keys(input), ...result, done: true, completed_at: new Date().toISOString() }, null, 2))
    await commitFile(output_path, `[ai-service] ${task_type} done`)
    console.log(`=== AI Service done ===`)
  } catch (err) {
    console.error(`❌ AI Service failed:`, err.message)
    try {
      const localPath = path.join(REPO_ROOT, output_path)
      fs.mkdirSync(path.dirname(localPath), { recursive: true })
      fs.writeFileSync(localPath, JSON.stringify({ task_id, task_type, error: err.message, done: false, failed_at: new Date().toISOString() }, null, 2))
      await commitFile(output_path, `[ai-service] ${task_type} failed: ${err.message}`)
    } catch {}
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
