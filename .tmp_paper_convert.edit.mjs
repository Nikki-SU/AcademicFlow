#!/usr/bin/env node
/**
 * AcademicFlow Paper Pipeline — GitHub Actions Runner
 *
 * 设计原则：
 *   ✓ Runner 本地 checkout → 所有读 fs.readFileSync()，零 GitHub API 读
 *   ✓ 写智能分流：<1MB Contents PUT；≥1MB blob → tree → commit → refs
 *   ✓ 所有写点 size check：blob ≤100MB，Contents ≤1MB（超了硬报错）
 *   ✓ 串行写：内部 Promise 队列，一次一个写
 *   ✓ .progress.json 每阶段更新，done 后删除
 *   ✓ 续跑：.tmp_xxx 文件存在则跳过对应阶段
 *   ✓ 失败态：try 写 literatures.csv md_status=failed + progress.json stage=failed
 *
 * 触发：repository_dispatch event_type=paper_convert
 *  payload: { doi, title, pdf_path }
 *
 * 进度协议：literatures/{slug}/.progress.json
 *  CSV 状态：literatures/literatures.csv md_status 列
 *
 * 大小限制硬常量：
 *   MAX_BLOB_SIZE = 100 * 1024 * 1024   (100 MB)
 *   MAX_CONTENTS_SIZE = 1 * 1024 * 1024 (1 MB)
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  OPEN, CLOSE, END,
  parseBlocks, serializeBlocks, renumber,
  readDocument, isTranslatable, blockId, labelOf, stripMarkers,
} from './blocks.mjs'

const MINERU_API = 'https://mineru.net/api/v4'
const MAX_BLOB_SIZE = 100 * 1024 * 1024
const MAX_CONTENTS_SIZE = 1 * 1024 * 1024

// ============================================================
// AI 并发度 / 分块大小
// ------------------------------------------------------------
// 当前 AI-1 / AI-2 都指向 DeepSeek 官方，官方不设硬性并发限制，
// 原先"并发=1、块=12k"是为七牛云 kimi-k2.6（RPM 3 + reasoning 烧输出预算）
// 做的降级，这里一并恢复。偶发 429/503 由 aiCall 的 10 次指数退避重试兜底。
// 想临时调：改这几个数即可，其他代码不用动。
// ============================================================
const CLEAN_CONCURRENCY = 8   // 清理并发
const TAG_CONCURRENCY = 8     // 打标并发
const TRANS_CONCURRENCY = 12  // 逐段翻译 + 表格翻译并发（段落数最多，收益最大）

// 单块字符数：两块都按"输入 + 输出不撞输出上限"定
const CLEAN_CHUNK = 20000
const TAG_CHUNK = 20000

// 单次调用的输出上限（max_tokens）。
// 带 reasoning 的模型会把预算花在 reasoning_content 上：实测 max_tokens=16000 时
// reasoning 占 41k-67k 字符，正文被截断到个位数 → 残篇被当成功产物。
// 先提到 32768 验证；若 provider 不支持更大值会返回 400（aiCall 会重试后明确失败），
// 那就把它调回来并改用缩小分块。
const AI_MAX_TOKENS = 32768

// ============================================================
// 思考模式（reasoning）—— 按阶段关/开
// ------------------------------------------------------------
// 背景：推理模型**默认开启思考**，而 reasoning_content 与正文**共用** max_tokens
// 预算，且按 output 计价（约为 input 的 4 倍）。实测 reasoning 可占掉 79% 的输出
// 预算，导致正文被截断成空（finish_reason=length、content=''）。
// 清理/打标/翻译都是机械任务，关掉思考后预算全部留给正文，同时显著省钱。
//
// 配置来源：私库 settings/global.md 的 ai_thinking_* 字段（前端 Settings 页写入）。
// runner 已 checkout 整个仓库，所以直接读本地文件，不需要额外的 Secret。
// ============================================================
const AI_THINKING_LEVELS = ['off', 'low', 'high', 'max']

/** 按阶段的思考模式；main() 启动时由 loadThinkingConfig() 覆盖 */
const THINKING = { clean: 'off', tag: 'off', translate: 'off', words: 'low' }

function loadThinkingConfig() {
  try {
    const md = fs.readFileSync(path.join(REPO_ROOT, 'settings/global.md'), 'utf-8')
    for (const line of md.split('\n')) {
      const m = line.match(/^\s*-\s*ai_thinking_(clean|tag|translate|words)\s*:\s*(\S+)/)
      if (!m) continue
      const level = m[2].trim()
      if (AI_THINKING_LEVELS.includes(level)) THINKING[m[1]] = level
      else console.warn(`  [thinking] 忽略非法值 ai_thinking_${m[1]}=${level}（合法值: ${AI_THINKING_LEVELS.join('/')}）`)
    }
  } catch (e) {
    console.warn(`  [thinking] 读取 settings/global.md 失败，全部使用默认值: ${e.message?.slice(0, 120) || e}`)
  }
  console.log(`  [thinking] 思考模式: 清理=${THINKING.clean} 打标=${THINKING.tag} 翻译=${THINKING.translate} 提词=${THINKING.words}`)
}

/**
 * 把阶段思考模式翻译成请求体参数。
 *   off      → thinking:{type:'disabled'}（不产出 reasoning，预算全给正文）
 *   low/high/max → thinking:{type:'enabled'} + reasoning_effort（控制思考强度）
 */
function thinkingParams(stage) {
  const level = THINKING[stage] || 'off'
  if (level === 'off') return { thinking: { type: 'disabled' } }
  return { thinking: { type: 'enabled' }, reasoning_effort: level }
}

const { MINERU_API_TOKEN,
        AI1_BASE_URL, AI1_API_KEY, AI1_MODEL,
        AI2_BASE_URL, AI2_API_KEY, AI2_MODEL,
        GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env

if (!MINERU_API_TOKEN) { console.error('❌ MINERU_API_TOKEN not set'); process.exit(1) }

/**
 * AI secrets 快速预检 —— MinerU 之前先确认 AI 能用
 *
 * 经验教训：MinerU 可能花 3-5 分钟，跑完才发现 AI key 无效 / endpoint 不通，
 * 白跑浪费时间。现在加一个最小 chat 请求（max_tokens=1, timeout=15s），
 * 两端都测，任何一端挂了立即 fail 并把 HTTP 状态码 + 错误透出。
 *
 * 特殊优化：如果 AI1 和 AI2 共用同一个 baseUrl（预置 provider 场景），
 *           合并成一次请求 —— 同一个 key 测两次没必要。
 */
async function quickAiHealthCheck() {
  const pairs = [
    { label: 'AI1', baseUrl: AI1_BASE_URL, apiKey: AI1_API_KEY, model: AI1_MODEL },
    { label: 'AI2', baseUrl: AI2_BASE_URL, apiKey: AI2_API_KEY, model: AI2_MODEL },
  ]

  const seen = new Set()
  for (const p of pairs) {
    if (!p.baseUrl || !p.apiKey || !p.model) {
      throw new Error(`${p.label} 配置缺失（baseUrl / apiKey / model 任一为空）`)
    }
    // 如果两端完全相同，只测一次
    const key = `${p.baseUrl}||${p.apiKey}`
    if (seen.has(key)) {
      console.log(`  [ai-health] ${p.label} 与对端共用端点 + key，跳过重复测试`)
      continue
    }
    seen.add(key)

    // AI-1 七牛云 kimi-k2.6 跨太平洋首包可能 >15s；改为 30s 超时 + 一次重试
    for (let attempt = 1; attempt <= 2; attempt++) {
      const t0 = Date.now()
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 30_000)
        const resp = await fetch(`${p.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
          body: JSON.stringify({
            model: p.model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            // 思考关掉：health check 只是 ping，不该为 reasoning 付钱与等时间。
            // 同时这一步也顺带验证 provider 接受该参数——若被拒绝会返回 400，
            // 在 MinerU 之前快速失败，不会跑到一半才发现。
            thinking: { type: 'disabled' },
          }),
          signal: ctrl.signal,
        })
        clearTimeout(timer)

        const elapsed = Date.now() - t0
        if (resp.ok) {
          const data = await resp.json().catch(() => ({}))
          const tokens = data.usage?.completion_tokens ?? '?'
          const rTok = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0
          console.log(`  [ai-health] ${p.label} ✓ HTTP ${resp.status} ${elapsed}ms tokens=${tokens} reasoning=${rTok}`)
          break
        } else {
          const txt = await resp.text().catch(() => '')
          let hint = ''
          if (resp.status === 401) hint = 'API Key 无效或已过期'
          else if (resp.status === 403) hint = '没有权限 —— 可能需要充值 / 开通'
          else if (resp.status === 404) hint = 'baseUrl 或 model 不存在'
          else if (resp.status === 429) hint = '限流了'
          throw new Error(`${p.label} HTTP ${resp.status} ${hint}: ${txt.slice(0, 200)}`)
        }
      } catch (e) {
        if (e.name === 'AbortError') {
          if (attempt === 2) throw new Error(`${p.label} 连接两次均超时（30s）—— 检查 baseUrl/网络/七牛云是否可用`)
          console.warn(`  [ai-health] ${p.label} 首包超时，再试一次...`)
          await new Promise(r => setTimeout(r, 2000))
          continue
        }
        throw new Error(`${p.label} 预检失败: ${e.message}`)
      }
    }
  }
}

// ============================================================
// 串行写队列 —— Runner 内串行，不并发写 GitHub
// ============================================================
let writeQueue = Promise.resolve()
function enqueueWrite(fn, label) {
  writeQueue = writeQueue.then(async () => {
    try { return await fn() }
    catch (e) { console.error(`[writeQueue ${label}]`, e); throw e }
  })
  return writeQueue
}

// ============================================================
// GitHub API（只写——读全走 fs）
// ============================================================
async function ghApi(method, apiPath, body) {
  const init = {
    method,
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'academicflow-pipeline/1.0',
    },
  }
  if (body !== undefined && body !== null) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const url = `https://api.github.com${apiPath}`
  const MAX_RETRY = 5
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    const resp = await fetch(url, init)
    if (resp.ok) {
      if (resp.status === 204) return null
      return resp.json()
    }
    const txt = await resp.text().catch(() => '')
    const isRetryable = resp.status === 409 || resp.status === 403 || resp.status >= 500
    if (!isRetryable || attempt === MAX_RETRY) {
      throw new Error(`GitHub ${method} ${apiPath}: ${resp.status} ${txt.slice(0, 300)}`)
    }
    const jitter = Math.floor(Math.random() * 500)
    const wait = 200 * Math.pow(2, attempt) + jitter  // 200, 400, 800, 1600, 3200 + jitter
    console.log(`  [ghApi] ${resp.status} on ${method} ${apiPath}, retry ${attempt+1}/${MAX_RETRY} in ${wait}ms`)
    await new Promise(r => setTimeout(r, wait))
  }
}

// 写小文件（≤ MAX_CONTENTS_SIZE）用 Contents PUT
async function ghWriteContents(filePath, content, message) {
  const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf-8') : content.length
  if (bytes > MAX_CONTENTS_SIZE) {
    throw new Error(`ghWriteContents fail: ${filePath} is ${bytes} bytes > MAX_CONTENTS_SIZE (${MAX_CONTENTS_SIZE}). Use blob path instead.`)
  }
  const b64 = Buffer.isBuffer(content) ? content.toString('base64') : Buffer.from(content, 'utf-8').toString('base64')
  // 409 retry: 先 GET 拿 sha → PUT；如果 409 说明 sha 过期了，再 GET 新 sha 重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    let sha = null
    try {
      const existing = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`)
      sha = existing?.sha ?? null
    } catch {} // 404 就当不存在
    const body = { message, content: b64 }
    if (sha) body.sha = sha
    try {
      return await ghApi('PUT', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`, body)
    } catch (e) {
      // 409 conflict → sha 过期，重试
      if (attempt === 0 && e?.message?.includes('409')) {
        console.log(`  [ghWriteContents] 409 conflict on ${filePath}, retrying with fresh sha...`)
        continue
      }
      throw e
    }
  }
}

// 写大文件（任何 size，blob 硬限 MAX_BLOB_SIZE）
async function ghWriteBlob(filePath, content, message) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8')
  if (buf.length > MAX_BLOB_SIZE) {
    throw new Error(`ghWriteBlob HARD FAIL: ${filePath} size=${buf.length} > 100MB GitHub blob limit. Cannot proceed.`)
  }
  // 1. 读 main HEAD
  const ref = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/main`)
  const baseCommitSha = ref.object.sha
  // 2. 读 commit → 拿 base_tree
  const commit = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits/${baseCommitSha}`)
  const baseTreeSha = commit.tree.sha
  // 3. 读现有 tree 条目（拿要替换文件的 sha，如果已存在）
  let existingFileSha = null
  try {
    const parentDir = path.dirname(filePath)
    const tree = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${baseTreeSha}:${parentDir}`, null)
    if (tree?.tree) {
      const leaf = tree.tree.find(e => e.path === path.basename(filePath))
      if (leaf?.sha) existingFileSha = leaf.sha
    }
  } catch {}
  // 4. 先 blob POST
  const blobRes = await ghApi('POST', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs`, {
    content: buf.toString('base64'),
    encoding: 'base64',
  })
  const newBlobSha = blobRes.sha
  // 5. 构造 tree items（删除旧的 → 让新的 blob 生效）
  const treeItems = []
  // 为了让 tree 里同一个 path 的 sha 变掉，我们 PUT 整个 tree 条目
  // 简化：用 base_tree + 新条目（GitHub tree 自动 merge 同名条目用新 sha）
  treeItems.push({
    path: filePath,
    mode: '100644',
    type: 'blob',
    sha: newBlobSha,
  })
  // 如果文件已存在，我们用完整 tree 替换——需要 parent tree + 新条目
  // 简化做法：重新获取 parent tree 完整条目，替换对应 sha，POST 新 tree
  const finalTreeItems = []
  try {
    const parentDir2 = path.dirname(filePath)
    const treeData = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${baseTreeSha}:${parentDir2}?recursive=0`, null)
    if (treeData?.tree) {
      for (const entry of treeData.tree) {
        if (entry.type === 'blob' && entry.path === path.basename(filePath)) continue
        if (entry.type === 'tree' && !filePath.startsWith(entry.path + '/')) {
          finalTreeItems.push({ path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha })
        }
      }
    }
  } catch {}
  finalTreeItems.push({
    path: path.basename(filePath),
    mode: '100644',
    type: 'blob',
    sha: newBlobSha,
  })
  // 6. POST 新 tree（用 parent 的 sha 做 base）
  const treeBody = { tree: finalTreeItems }
  if (baseTreeSha) treeBody.base_tree = baseTreeSha
  const newTree = await ghApi('POST', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees`, treeBody)
  // 7. POST 新 commit
  const newCommit = await ghApi('POST', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [baseCommitSha],
  })
  // 8. PATCH refs
  await ghApi('PATCH', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/main`, {
    sha: newCommit.sha,
    force: false,
  })
  return { sha: newBlobSha, commit: newCommit.sha }
}

// 智能分流：自动选 Contents 或 blob
async function ghWrite(filePath, content, message) {
  const bytes = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, 'utf-8')
  if (bytes <= MAX_CONTENTS_SIZE) return enqueueWrite(() => ghWriteContents(filePath, content, message), `Contents ${filePath}`)
  if (bytes <= MAX_BLOB_SIZE) return enqueueWrite(() => ghWriteBlob(filePath, content, message), `Blob ${filePath}`)
  throw new Error(`ghWrite HARD FAIL: ${filePath} size=${bytes} > 100MB GitHub blob limit`)
}

// 删除文件（Contents DELETE）
async function ghDelete(filePath, message = 'cleanup') {
  try {
    const existing = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`)
    if (!existing?.sha) return null
    return enqueueWrite(() => ghApi('DELETE', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`, {
      message, sha: existing.sha,
    }), `DELETE ${filePath}`)
  } catch { return null }
}

// ============================================================
// Progress JSON
// ============================================================
async function writeProgress(slug, data) {
  const path = `literatures/${slug}/.progress.json`
  const json = JSON.stringify({ ...data, updated_at: new Date().toISOString() }, null, 2)
  await ghWrite(path, json, `progress: ${data.stage}`)
}
/** progress 写节流：translating 高频循环里距上次写 <8s 直接跳过，
 *  把每段一次的 GitHub Contents 提交压到 ~7 次/分钟以内（限流保护）。
 *  stage 切换的 writeProgress 不走此函数，仍然即时写。 */
let _lastThrottledWriteAt = 0
function writeProgressThrottled(slug, data) {
  const now = Date.now()
  if (now - _lastThrottledWriteAt < 8000) return Promise.resolve(null)
  _lastThrottledWriteAt = now
  return writeProgress(slug, data).catch(() => null)
}

async function deleteProgress(slug) {
  await ghDelete(`literatures/${slug}/.progress.json`, 'progress done')
}

// ============================================================
// CSV 工具（fs 读写，因为 runner 本地有完整 checkout）
// ============================================================
const REPO_ROOT = process.cwd()

function loadLocalCsv(relPath) {
  const full = path.join(REPO_ROOT, relPath)
  if (!fs.existsSync(full)) return { headers: [], rows: [] }
  const text = fs.readFileSync(full, 'utf-8')
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length === 0) return { headers: [], rows: [] }
  return { headers: lines[0].split(','), rows: lines.slice(1).map(l => l.split(',')) }
}

function saveLocalCsv(relPath, headers, rows) {
  const full = path.join(REPO_ROOT, relPath)
  const content = [headers.join(','), ...rows.map(r => r.map(v => {
    const s = String(v ?? '')
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s
  }).join(','))].join('\n') + '\n'
  fs.writeFileSync(full, content, 'utf-8')
}

async function commitLocalFiles(fileRelPaths, message) {
  // 用 git commit + push。pipeline 可能被多次调用（progress 状态 + final commit），
  // 每次都先 fetch + reset --soft 把所有本地 commit 压成一个，再 force-with-lease 推。
  // 永远不 rebase —— CI 里并发短 commit 叠多了 rebase 会炸。
  //
  // 并发背景：前端 App 会持续把 settings/background_tasks.csv 写回 main（几秒一个 commit），
  // fetch 之后、push 之前远程很可能又前进了，--force-with-lease 因此被拒：
  //   ! [remote rejected] main -> main (cannot lock ref 'refs/heads/main':
  //     is at <new> but expected <old>)
  // 这是可恢复的竞争：整段 fetch → soft reset → add → commit → push 重来即可。
  const { execSync } = await import('node:child_process')
  const MAX_RETRY = 10
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))

  const run = () => {
    execSync(`git fetch origin main`, { cwd: REPO_ROOT, stdio: 'pipe' })
    // squash：把所有本地已有 commit 压成工作树变更
    execSync(`git reset --soft origin/main`, { cwd: REPO_ROOT, stdio: 'pipe' })
    try { execSync(`git reset`, { cwd: REPO_ROOT, stdio: 'pipe' }) } catch {}
    // 重新 add 指定文件 + commit
    for (const p of fileRelPaths) {
      try { execSync(`git add "${p}"`, { cwd: REPO_ROOT, stdio: 'pipe' }) } catch {}
    }
    try {
      execSync(`git commit -m "${message.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { cwd: REPO_ROOT, stdio: 'pipe' })
    } catch (e) {
      // nothing to commit → 这次跳过
      if (e.stdout?.toString().includes('nothing to commit')) return
      throw e
    }
    // 显式 lease：用刚 fetch 到的远程 SHA，缩小竞态窗口
    const remoteSha = execSync(`git rev-parse refs/remotes/origin/main`, { cwd: REPO_ROOT, stdio: 'pipe' }).toString().trim()
    execSync(`git push origin main --force-with-lease=main:${remoteSha}`, { cwd: REPO_ROOT, stdio: 'pipe' })
  }

  // git 拒绝信息里并不包含 "force-with-lease" 字样（旧匹配条件因此一次失败就放弃）。
  // 真正的远程前进签名：
  const REJECTION_MARKERS = [
    'cannot lock ref',
    'remote rejected',
    'stale info',
    'non-fast-forward',
    'fetch first',
    'failed to push some refs',
    'but expected',
  ]

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      run()
      if (attempt > 1) console.log(`  [commitLocalFiles] push ok after ${attempt} attempts`)
      return
    } catch (e) {
      // 清理可能遗留的 rebase
      try { execSync(`git rebase --abort`, { cwd: REPO_ROOT, stdio: 'pipe' }) } catch {}
      const stderr = e.stderr?.toString() || String(e)
      const isRace = REJECTION_MARKERS.some((marker) => stderr.includes(marker))
      if (attempt < MAX_RETRY && isRace) {
        // 指数退避 2s 起、封顶 30s，加 0.5~1.5 倍 jitter，避免和前端定时写入持续撞点
        const base = Math.min(2000 * 2 ** (attempt - 1), 30000)
        const delay = Math.round(base * (0.5 + Math.random()))
        console.warn(`  [commitLocalFiles] remote moved, retry ${attempt}/${MAX_RETRY} in ${delay}ms`)
        console.warn(`    reason: ${stderr.slice(0, 200).replace(/\n/g, ' ')}`)
        await sleep(delay)
      } else {
        console.error(`  [commitLocalFiles] push FAILED after ${attempt} attempt(s)`)
        console.error(`    reason: ${stderr.slice(0, 300)}`)
        throw e
      }
    }
  }
}
// ============================================================
// 阶段存档（checkpoint）+ 断点续跑
// ------------------------------------------------------------
// 每个昂贵阶段（一次 AI 调用）结束后，把该阶段产物提交进仓库。
// runner 被销毁或任务失败后重试时，从已存档的产物继续往下跑，
// 不再把已经花过 token 的 clean / tag / enumerate / translate / words 重跑一遍。
//
// 存档文件（都放在 literatures/{slug}/ 下，前端/阅读页不读它们）：
//   .tmp_meta.json        源 PDF 指纹（pdf_path + size）—— 源变了就作废全部存档
//   full.md + images/ MinerU 原始产物（跳过 MinerU 解析，省 MinerU 额度与时间）
//   .tmp_cleaned.md       AI-1 清理产物
//   .tmp_tagged.md        AI-1 打标产物
//   .tmp_enumerated.md    编号骨架
//   .tmp_translated.json  已翻译的块（{translations: {目标下标 → 译文}}）
//   .tmp_words.json       AI-1 提取的候选词汇
// 全部成功结束后这些文件会被清理掉，不留垃圾。
// ============================================================

function artifactPaths(slug) {
  return {
    meta:       `literatures/${slug}/.tmp_meta.json`,
    cleaned:    `literatures/${slug}/.tmp_cleaned.md`,
    tagged:     `literatures/${slug}/.tmp_tagged.md`,
    enumerated: `literatures/${slug}/.tmp_enumerated.md`,
    translated: `literatures/${slug}/.tmp_translated.json`,
    words:      `literatures/${slug}/.tmp_words.json`,
  }
}

const localFull = (rel) => path.join(REPO_ROOT, rel)

function artifactExists(rel) {
  try { return fs.statSync(localFull(rel)).size > 0 } catch { return false }
}

/** 当前仓库里已存档到哪一步（给日志和失败态 resume_from 用） */
function resumePlan(slug) {
  const a = artifactPaths(slug)
  return {
    mineru: artifactExists(`literatures/${slug}/full.md`),
    clean: artifactExists(a.cleaned),
    tag: artifactExists(a.tagged),
    enumerate: artifactExists(a.enumerated),
    translate: artifactExists(a.translated),
    words: artifactExists(a.words),
  }
}

/** 依次列出已存档阶段，用于日志；返回第一个"尚未完成"的阶段名与中文名 */
function describeResume(slug) {
  const p = resumePlan(slug)
  const order = [['mineru', 'MinerU 解析'], ['clean', 'AI-1 清理'], ['tag', 'AI-1 打标'],
    ['enumerate', '编号对齐'], ['translate', 'AI-2 翻译'], ['words', 'AI-1 提词']]
  const doneLabels = order.filter(([k]) => p[k]).map(([, label]) => label)
  const next = order.find(([k]) => !p[k])
  return { done: doneLabels, next: next ? next[0] : 'assemble', nextLabel: next ? next[1] : '组装最终文件' }
}

async function readSourceMeta(slug) {
  try { return JSON.parse(fs.readFileSync(localFull(artifactPaths(slug).meta), 'utf-8')) } catch { return null }
}

function writeSourceMeta(slug, pdfPath, size) {
  const target = localFull(artifactPaths(slug).meta)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target,
    JSON.stringify({ pdf_path: pdfPath, pdf_size: size, saved_at: new Date().toISOString() }, null, 2), 'utf-8')
}

/**
 * 源 PDF 变了（换文件/重新上传）→ 之前的存档全部作废，必须从头跑。
 * 同一次转换的重试（同一 pdf_path + 同 size）才允许续跑。
 */
async function purgeArtifacts(slug, reason) {
  const a = artifactPaths(slug)
  const rels = Object.values(a)
  console.log(`  [ckpt] 作废已有存档（${reason}）`)
  for (const rel of rels) { try { fs.unlinkSync(localFull(rel)) } catch {} }
  try {
    // git add 不存在的路径 == 记录删除；这样一次提交就把所有存档从仓库摘掉
    await commitLocalFiles(rels, `[pipeline] ${slug} 作废存档: ${reason}`)
  } catch (e) {
    console.warn(`  [ckpt] 清理旧存档失败（不阻塞）: ${e.message?.slice(0, 120) || e}`)
  }
}

/**
 * 把某阶段产物提交进仓库；失败只告警，绝不阻断主流程。
 * 这里用 git 提交（不走 API 写队列），必须自己串行：
 * 翻译阶段的周期存档与 words 预提取的存档可能同时触发，
 * 并发 git add/commit 会撞 index.lock（实测出现过一次）。
 */
let ckptQueue = Promise.resolve()
async function saveCheckpoint(slug, relPaths, label) {
  const list = Array.isArray(relPaths) ? relPaths : [relPaths]
  if (!list.some(artifactExists)) return
  const run = ckptQueue.catch(() => {}).then(async () => {
    try {
      await commitLocalFiles(list, `[pipeline] ${slug} checkpoint: ${label}`)
      console.log(`  [ckpt] ✓ 已存档 ${label}`)
    } catch (e) {
      const detail = (e?.stderr?.toString() || e?.stdout?.toString() || e?.message || String(e))
        .split('\n').map((s) => s.trim()).filter(Boolean).slice(-3).join(' | ').slice(0, 300)
      console.warn(`  [ckpt] ⚠ 存档 ${label} 失败（不阻塞主流程）: ${detail}`)
    }
  })
  ckptQueue = run
  return run
}

// ── 文献存活检查：防止用户删除后 Runner 仍在跑把文件写回来 ──
// Runner 本地 checkout 的是 dispatch 时的快照，需要 git fetch 拉最新 main
async function checkLiteratureAlive(doi) {
  try {
    const { execSync } = await import('node:child_process')
    execSync('git fetch origin main --depth=1', { cwd: REPO_ROOT, stdio: 'pipe' })
    execSync('git checkout origin/main -- literatures/literatures.csv', { cwd: REPO_ROOT, stdio: 'pipe' })
    const lit = loadLocalCsv('literatures/literatures.csv')
    const doiCol = lit.headers.indexOf('doi')
    if (doiCol < 0) return true
    const row = lit.rows.find(r => r[doiCol] === doi)
    if (!row) {
      console.log(`⛔ 文献 ${doi} 已从 CSV 删除（用户可能删了），放弃 pipeline`)
      return false
    }
    console.log(`  ✓ 文献存活检查通过`)
    return true
  } catch (e) {
    console.warn(`  [checkAlive] 检查失败（放过去）: ${e.message}`)
    return true
  }
}


// ============================================================
// MinerU（Node fetch mineru.net，无代理）
// ============================================================
async function mineruRequest(method, urlPath, body) {
  const headers = { Authorization: `Bearer ${MINERU_API_TOKEN}` }
  const init = { method, headers }
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const resp = await fetch(`${MINERU_API}${urlPath}`, init)
  const txt = await resp.text()
  if (!resp.ok) throw new Error(`MinerU ${method} ${urlPath}: ${resp.status} ${txt.slice(0, 300)}`)
  if (!txt) return null
  const j = JSON.parse(txt)
  // v4 统一响应：{ code, msg, data }；code !== 0 表示业务错误
  if (typeof j === 'object' && j !== null && 'code' in j && j.code !== 0) {
    throw new Error(`MinerU ${method} ${urlPath} code=${j.code} msg=${j.msg || ''}`)
  }
  return j
}

async function mineruConvert(pdfBuf, fileName, onProgress) {
  // size check
  if (pdfBuf.length > MAX_BLOB_SIZE) {
    throw new Error(`MinerU PDF too large: ${pdfBuf.length} bytes > 100MB blob limit. Cannot process.`)
  }

  // 1. 申请上传 URL (v4: 对象 body, 响应 { code, msg, data: { batch_id, file_urls } })
  onProgress?.({ stage: 'mineru_apply', message: '申请上传 URL...', pct: 5 })
  const applyResp = await mineruRequest('POST', '/file-urls/batch', {
    files: [{ name: fileName, is_ocr: false }],
    model_version: 'pipeline',
    enable_formula: true,
    enable_table: true,
    language: 'auto',
  })
  const batchId = applyResp.data?.batch_id
  const uploadUrl = applyResp.data?.file_urls?.[0]
  if (!batchId || !uploadUrl) {
    throw new Error(`MinerU 响应缺 batch_id 或 file_urls: ${JSON.stringify(applyResp).slice(0, 300)}`)
  }
  console.log(`  [mineru] batch_id=${batchId}`)

  // 2. PUT PDF 到预签名 URL
  // ⚠️ 关键坑：**不能带 Content-Type header**。OSS 预签名 URL 的 StringToSign 里
  //    Content-Type 是空字符串，带了就 SignatureDoesNotMatch (HTTP 403)。
  //    Node fetch 默认会加 Content-Type，所以必须显式覆盖为空对象。
  onProgress?.({ stage: 'mineru_upload', message: '上传 PDF...', pct: 25 })
  const putResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {},
    body: pdfBuf,
  })
  if (!putResp.ok) throw new Error(`OSS PUT: ${putResp.status} ${await putResp.text().catch(() => '')}`)

  // 3. 轮询 /extract-results/batch/{batch_id}
  //    v4 MineruFileState: waiting-file / pending / running / converting / done / failed / error
  onProgress?.({ stage: 'mineru_poll', message: '轮询转换状态...', pct: 40 })
  let fileResult = null
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000))
    const pollResp = await mineruRequest('GET', `/extract-results/batch/${batchId}`)
    const extracted = pollResp.data?.extract_result?.[0]
    if (!extracted) {
      onProgress?.({ stage: 'mineru_poll', message: `轮询中 (${i + 1}/60)... 等待解析结果`, pct: 40 + Math.min(45, i) })
      continue
    }
    const state = extracted.state
    const progress = extracted.extract_progress
    const msg = `轮询中 (${i + 1}/60)... state=${state}${progress != null ? ` (${progress}%)` : ''}`
    onProgress?.({ stage: 'mineru_poll', message: msg, pct: 40 + Math.min(45, i) })

    if (state === 'done') { fileResult = extracted; break }
    if (state === 'failed' || state === 'error') {
      throw new Error(`MinerU task ${state}: ${extracted.err_msg || '无错误详情'}`)
    }
  }
  if (!fileResult) throw new Error('MinerU 60 轮轮询超时 (约 5 分钟)')

  // 4. 下载 full_zip_url + unzip
  if (!fileResult.full_zip_url) {
    throw new Error(`MinerU state=done 但无 full_zip_url: ${JSON.stringify(fileResult).slice(0, 500)}`)
  }
  onProgress?.({ stage: 'mineru_download', message: '下载产物 zip...', pct: 90 })
  const zipResp = await fetch(fileResult.full_zip_url)
  if (!zipResp.ok) throw new Error(`下载 zip: ${zipResp.status} ${await zipResp.text().catch(() => '')}`)
  const zipBuf = Buffer.from(await zipResp.arrayBuffer())

  // 解压到临时目录 (runner 默认有 unzip)
  const tmpDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp_mineru_'))
  const zipPath = path.join(tmpDir, 'result.zip')
  fs.writeFileSync(zipPath, zipBuf)
  try {
    const { execSync } = await import('node:child_process')
    execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { stdio: 'pipe' })
  } catch (e) {
    const stderr = e.stderr?.toString() || e.message
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    throw new Error(`MinerU 产物解压失败: ${stderr.slice(0, 300)}`)
  }

  // 5. 找 full.md (v4 zip 里固定叫 full.md)
  const fullMdPath = path.join(tmpDir, 'full.md')
  let markdown
  if (fs.existsSync(fullMdPath)) {
    markdown = fs.readFileSync(fullMdPath, 'utf-8')
  } else {
    const found = findFirstMd(tmpDir)
    if (!found) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
      throw new Error(`MinerU zip 里没找到 .md 文件。解压目录内容: ${fs.readdirSync(tmpDir).join(', ')}`)
    }
    markdown = fs.readFileSync(found, 'utf-8')
  }

  // 6. 复制 images/ 到 literatures/{slug}/images
  const slug = fileName.replace(/\.pdf$/i, '')
  const imagesSrcDir = path.join(tmpDir, 'images')
  const imgLocalDir = path.join(REPO_ROOT, `literatures/${slug}/images`)
  if (fs.existsSync(imagesSrcDir)) {
    fs.mkdirSync(imgLocalDir, { recursive: true })
    for (const f of fs.readdirSync(imagesSrcDir)) {
      try { fs.copyFileSync(path.join(imagesSrcDir, f), path.join(imgLocalDir, f)) } catch (e) {
        console.warn(`  [mineru] 图片复制失败: ${f} → ${e.message}`)
      }
    }
    const nImg = fs.readdirSync(imgLocalDir).length
    console.log(`  [mineru] 复制图片 ${nImg} 张`)
  }

  // 7. 清理临时目录
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}

  onProgress?.({ stage: 'mineru_download', message: '下载完成', pct: 100 })
  return { markdown, fileName }
}

/** 递归搜索目录下第一个 .md 文件 (full.md 不存在时的 fallback) */
function findFirstMd(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const r = findFirstMd(full)
      if (r) return r
    } else if (entry.name.endsWith('.md')) {
      return full
    }
  }
  return null
}

// ============================================================
// AI 调用
// ============================================================
/** AI 调用：带 3 次 retry + 120s timeout */
/**
 * 剥离 AI 输出里的 Markdown 代码围栏。
 * 模型（尤其被分块/长上下文时）经常把整篇内容包在 ```markdown ... ``` 里，
 * 或在块边界吐出零散 ``` 行。围栏会让打标阶段把全文当成 code block，
 * 结果一个块都切不出来 → 0 块 → 零翻译 → 假成功 md。
 * 学术正文里不保留代码块（公式一律用 $），所以直接删除所有围栏行是安全的。
 */
function stripCodeFences(s) {
  if (!s) return s
  let t = s.replace(/^\uFEFF/, '')
  const lines = t.split('\n')
  const out = lines.filter((l) => !/^\s*```[A-Za-z0-9_-]*\s*$/.test(l))
  return out.join('\n').replace(/^\s*\n+/, '').replace(/\s+$/, '')
}

async function aiCall(baseUrl, apiKey, model, system, user, stage, signal) {
  const MAX_RETRY = 10
  const TIMEOUT_MS = 900_000
  const thinkParams = thinkingParams(stage)
  let lastErr = null
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature: 0.1,
          max_tokens: AI_MAX_TOKENS,
          ...thinkParams,
        }),
        signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
      })
      clearTimeout(timer)
      if (!resp.ok) {
        const t = await resp.text().catch(() => '')
        throw new Error(`AI ${model}: ${resp.status} ${t.slice(0, 200)}`)
      }
      const j = await resp.json()
      const choice0 = j.choices?.[0]
      const msg = choice0?.message
      const content = msg?.content
      const finishReason = choice0?.finish_reason
      const reasoningChars = (msg?.reasoning_content || '').length
      const usage = j.usage || {}
      const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? 0
      // 推理模型在长文重发任务上可能耗尽输出预算：reasoning_content 把 max_tokens
      // 吃光，content 返回空字符串，finish_reason=length。
      // 旧代码直接返回 '' → Tag "成功"但 0 标记 → 假成功。
      // 空响应视为可重试错误，让退避重试接管。
      if (!content || !content.trim()) {
        throw new Error(`AI ${model}: 空 content (finish_reason=${finishReason || '?'}, reasoning=${reasoningTokens} tok/${reasoningChars} chars, 思考模式=${THINKING[stage] || 'off'})，可能输出预算耗尽或被截断`)
      }
      // 截断的输出绝不能当成功返回。
      // clean/tag 的输出是"原文的完整副本 + 标记"，一旦被截断就是静默丢正文
      // （实测：reasoning 吃掉输出预算，某块只回了 6 字符，整篇少了 40% 正文，
      //  但 run 仍然 success）。当作可重试错误抛出去，让退避重试接管；
      // 若重试后仍截断，就明确失败，绝不写残缺产物。
      if (finishReason === 'length') {
        throw new Error(`AI ${model}: 输出被截断 finish_reason=length (content=${content.length} chars, reasoning=${reasoningTokens} tok —— 输出预算被 reasoning 占用，思考模式=${THINKING[stage] || 'off'})`)
      }
      // 记录 reasoning 用量：这是验证"思考是否真的关掉了"的直接证据
      // （关掉思考后 reasoning 应恒为 0；若仍 >0 说明 provider 忽略了该参数）
      console.log(`  [aiCall] ${stage || '-'} ok: content=${content.length} chars, reasoning=${reasoningTokens} tok, completion=${usage.completion_tokens ?? '?'} tok`)
      return content
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      if (attempt === MAX_RETRY) throw e
      const wait = Math.min(2 ** attempt * 1000, 30_000) + Math.floor(Math.random() * 2000) // 2s→30s + jitter
      console.log(`  [aiCall] attempt ${attempt}/${MAX_RETRY} failed (${e.message?.slice(0, 120)}), retry in ${wait}ms...`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
  throw lastErr
}

/** 并发映射工具：保持结果顺序，限制并发数防止 AI 限流 */
async function mapLimit(arr, limit, fn) {
  const ret = new Array(arr.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= arr.length) return
      ret[i] = await fn(arr[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, worker))
  return ret
}

// ============================================================
// Post-Mineru 纯函数（同前端逻辑但 Runner 本地跑）
// ============================================================
const CLEAN_PROMPT = `你是文献整理专家。清理 PDF 提取文本：
1. 移除页眉页脚、页码、版权声明、期刊模板文字（**只删这些文字，其中的图片链接要保留**）
2. 拼接被打断的段落（处理断词断句）
3. 【图片一张都不能少、一个字都不能改】![说明](images/xxxx.jpg) 必须连路径一起逐字照抄。
   严禁改写成 ![image] 这种没有路径的形式，严禁改写/省略/替换任何图片路径。
   即使图片出现在页眉页脚、期刊封面或广告位，也只删它周围的文字，图片本身必须留下。
   宁可多留几张无关的图，也绝不允许丢图。
4. 保留 Markdown 表格
5. 保留 LaTeX 公式原样不动
6. 参考文献章节完整保留
7. 纯 Markdown 输出，不要代码块
8. 绝对不要输出 ⟨⟨⟨ 和 ⟩⟩⟩ 这两个符号
直接输出清理后的内容。`

/** clean 阶段发现丢图时的纠正提示（只重跑丢图的那几个分块） */
const CLEAN_RETRY_PROMPT = CLEAN_PROMPT + `

特别注意（上一遍就是这里出错的）：图片语法必须连路径一起原样输出。
例如原文里的 ![image](images/3b3aef4ab75d.jpg) 必须原样写成 ![image](images/3b3aef4ab75d.jpg)，
绝对不允许写成 ![image]（那样路径就丢了，图就没了）。`

/**
 * 打标：把清理好的文本切成"块"。
 * 块 = ⟨⟨⟨元信息⟩⟩⟩内容原文⟨⟨⟨/⟩⟩⟩
 * 编号不要求模型数对（代码会统一重排），但块必须切对、内容一个字都不能改。
 */
const TAG_PROMPT = `你是文献结构标注助手。把给定的 Markdown 文本按语义切成"块"，每块用一对定界符包起来。

块的样子：${OPEN}元信息${CLOSE}内容原文${END}

元信息只有下面这九种（· 是分隔符）：

1. 标题：文字·标题·L·N            L = 标题级别（1-6）
2. 正文段落：文字·正文·0·N
3. 列表：列表·L·N                  L = 列表层级（从 1 开始）
4. 图片：图·A·S                    （![...](...) 图片语法）
5. 表格：表·A·S                    （Markdown 管道表格）
6. 图注：图注·A·S                  （图片的说明文字，如 "Figure 1. ..."）
7. 公式：公式·A·S                  （独占一段的块级 $$...$$；行内 $...$ 不算，留在正文里）
8. 引文：引文                      （整段引用的文字，通常以 > 开头）
9. 参考文献：文献                  （References / Bibliography 章节，整章一个块）

编号规则（数不准没关系，代码会重排）：
- N 是流块序号：标题、正文、列表**共用同一个序列**，按出现顺序 1、2、3……
- A 是锚点：取该浮动块前面最近的那个流块编号
- S 是浮动块序号：图/表/图注/公式在**同一个锚点内共用一个序列**，从 1 开始

硬性要求：
1. 内容原文必须**逐字保留**：禁止摘要、改写、翻译、合并段落、增删标点，禁止改动图片路径与表格内容。
2. 图片块的内容必须是**完整的图片语法（含路径）**，例如 ![image](images/abc.jpg)。
   绝对不允许写成 ![image] 这种没有路径的形式 —— 那样图就没了。
3. 每个块开标记之后必须紧跟 ${END} 闭合，不允许漏。
4. 块与块之间保留原有的空行（空行放在块外面）。
5. 行内公式 $...$、行内代码、脚注标记都留在正文块里，不要单独成块。
6. 禁止用三反引号代码块包裹整体输出。

示例（节选）：
${OPEN}文字·标题·1·1${CLOSE}From Powder to Technical Body${END}

${OPEN}文字·正文·0·2${CLOSE}We report a general route to...${END}

${OPEN}图·2·1${CLOSE}![Figure 1](images/abc.jpg)${END}
${OPEN}图注·2·2${CLOSE}Figure 1. Schematic of the process.${END}

${OPEN}表·2·3${CLOSE}| Entry | TON |
|-------|-----|
| 1 | 120 |${END}

${OPEN}文献${CLOSE}[1] A. Author, J. Name 12, 345 (2020).${END}

直接输出切好块的文本，不要任何解释。`

const TRANSLATE_PROMPT = (type) => type === 'table'
  ? `翻译 Markdown 表格：格式不变，英文翻中文。输出 Markdown 表格。不要添加任何标记或解释。`
  : `翻译英文段落到中文，保持学术语气。只输出译文。不要添加任何标记或解释。`

// ============================================================
// 单词提取（AI-1 提取 + AI-2 核验 → vocabulary/vocabulary.csv）
// ============================================================
const WORDS_EXTRACT_PROMPT = `你是化学领域学术英语词汇专家。从给定的英文论文段落中，提取 15-30 个核心学术英语单词。

选择标准：
1. 专业术语（catalysis, photocatalyst, heterojunction, quantum yield...）
2. 不常见的学术词汇（facilitate, mitigate, elucidate, corroborate...）
3. 重要动词和形容词（noteworthy, substantial, systematically...）
4. 跳过停用词（the, is, of, a, in, that, it, for, with, as, are, by, be, on, this, at, from, or, an, we, these, its...）
5. 跳过纯数字和化学式缩写

输出 JSON 数组，每个元素：
{
  "word_en": "英文词（小写单数形式）",
  "pos": "词性 (noun/verb/adjective/adverb)",
  "definition_cn": "简明中文释义（10字以内）",
  "definition_en": "简明英文释义（15词以内）",
  "example_context": "来自原文的例句（完整句子，英文）"
}

严格输出 JSON，不要任何解释文字。`

const WORDS_VERIFY_PROMPT = `你是学术词汇审核专家。审核下面列出的论文核心词汇，确保每个词都值得学习。

审核标准：
1. 每个词必须是化学领域有学习价值的学术英语词汇
2. 释义必须准确
3. 例句必须来自原文且包含该词
4. 如果某个词只是普通高频词（如 "show", "use", "make", "include", "report", "obtain", "given", "result", "method", "study", "provide", "allow", "require", "apply"），删除它

输入：
=== 原始英文段落 ===
{{PARAGRAPHS}}
=== 待审核词汇列表 ===
{{CANDIDATES}}

输出 JSON 数组（只保留通过审核的词汇），格式同输入。严格输出 JSON，不要任何解释文字。`

const VOCAB_CSV_PATH = 'vocabulary/vocabulary.csv'
const VOCAB_HEADERS = [
  'word_en', 'word_cn', 'phonetic', 'definition_cn', 'definition_en',
  'example_context', 'source_doi', 'status', 'added_at', 'last_review',
  'review_count', 'sm2_interval', 'sm2_ease', 'wrong_count', 'streak',
]

/** AI 返回 JSON 字符串解析，容错（常见 ```json ``` 包裹、trailing comma） */
function parseJsonArray(text) {
  if (!text) return null
  let t = text.trim()
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (m) t = m[1].trim()
  try { return JSON.parse(t) } catch {}
  const arrStart = t.indexOf('[')
  const arrEnd = t.lastIndexOf(']')
  if (arrStart >= 0 && arrEnd > arrStart) {
    try { return JSON.parse(t.slice(arrStart, arrEnd + 1)) } catch {}
  }
  return null
}

let pendingWordsExtract = null // runPostMineru 预启动的 AI-1 词汇提取 promise；runWordsExtraction 先 await 它再查 tmpFile

/** runWordsExtraction — AI-1 提取 + AI-2 核验 → vocabulary/vocabulary.csv */
async function runWordsExtraction(enItems, doi, slug) {
  if (!enItems?.length) return { extracted: 0, verified: 0, added: 0 }

  const tmpFile = path.join(REPO_ROOT, `literatures/${slug}/.tmp_words.json`)
  // 等待与翻译并行的 AI-1 预提取落盘（若已启动），再走下方 tmpFile 续跑判断
  if (pendingWordsExtract) { try { await pendingWordsExtract } catch {} }

  // 续跑：有 .tmp_words.json 就跳过 AI-1
  let candidateWords
  let skipAI1 = false
  if (fs.existsSync(tmpFile)) {
    try {
      candidateWords = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'))
      skipAI1 = true
      console.log(`  [words] resume: skip AI-1, load ${candidateWords.length} candidates`)
    } catch {}
  }

  // 1. AI-1 提取
  if (!skipAI1) {
    await writeProgress(slug, { stage: 'words_extract', message: 'AI-1 提取学术单词...', pct: 0, node: 3 })
    const allEn = enItems.map(p => p.en).join('\n\n')
    const raw = await aiCall(AI1_BASE_URL, AI1_API_KEY, AI1_MODEL, WORDS_EXTRACT_PROMPT, allEn, 'words')
    candidateWords = parseJsonArray(raw)
    if (!candidateWords?.length) {
      console.warn(`  [words] AI-1 返回空词汇列表, raw 前200: ${raw?.slice(0, 200)}`)
      return { extracted: 0, verified: 0, added: 0 }
    }
    fs.writeFileSync(tmpFile, JSON.stringify(candidateWords), 'utf-8')
    console.log(`  [words] AI-1 extracted ${candidateWords.length}`)
    await saveCheckpoint(slug, `literatures/${slug}/.tmp_words.json`, 'words_extract')
  }

  // 2. AI-2 核验
  await writeProgress(slug, { stage: 'words_verify', message: 'AI-2 核验学术单词...', pct: 50, node: 3 })
  const allEn = enItems.map(p => p.en).join('\n\n')
  const verifyUser = WORDS_VERIFY_PROMPT
    .replace('{{PARAGRAPHS}}', allEn.slice(0, 8000))
    .replace('{{CANDIDATES}}', JSON.stringify(candidateWords, null, 2))
  const rawV = await aiCall(
    AI2_BASE_URL, AI2_API_KEY, AI2_MODEL,
    '你是严谨的学术词汇审核助手。严格按用户要求的 JSON 数组格式输出，不要任何解释文字。',
    verifyUser,
    'words',
  )
  const verified = parseJsonArray(rawV) || []
  console.log(`  [words] AI-2 verified ${verified.length}/${candidateWords.length}`)
  if (!verified.length) {
    console.warn(`  [words] ⚠ AI-2 核验返回 0 条，raw 前200: ${rawV?.slice(0, 200)}`)
  }

  // 3. 追加到 vocabulary/vocabulary.csv（去重：word_en 相同跳过）
  const vocabPath = path.join(REPO_ROOT, VOCAB_CSV_PATH)
  fs.mkdirSync(path.dirname(vocabPath), { recursive: true })

  // 读现有 CSV 拿已存在 word_en 集合
  let existingWords = new Set()
  if (fs.existsSync(vocabPath)) {
    const { headers, rows } = loadLocalCsv(VOCAB_CSV_PATH)
    const wordIdx = headers.indexOf('word_en')
    if (wordIdx >= 0) existingWords = new Set(rows.map(r => (r[wordIdx] || '').toLowerCase()))
  }
  const existing = existingWords

  const nowMs = Date.now()
  const newRows = []
  for (const w of verified) {
    const key = (w.word_en || '').toLowerCase().trim()
    if (!key || existing.has(key)) continue
    newRows.push({
      word_en: key,
      word_cn: w.definition_cn || '',
      phonetic: '',
      definition_cn: w.definition_cn || '',
      definition_en: w.definition_en || '',
      example_context: w.example_context || '',
      source_doi: doi,
      status: 'new',
      added_at: nowMs,
      last_review: 0,
      review_count: 0,
      sm2_interval: 1,
      sm2_ease: 2.5,
      wrong_count: 0,
      streak: 0,
    })
  }

  if (newRows.length) {
    // 构造 CSV 行
    const enc = (v) => {
      const s = String(v ?? '')
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s
    }
    const csvRows = newRows.map(r => [
      enc(r.word_en), enc(r.word_cn), enc(r.phonetic), enc(r.definition_cn),
      enc(r.definition_en), enc(r.example_context), enc(r.source_doi),
      enc(r.status), enc(r.added_at), enc(r.last_review), enc(r.review_count),
      enc(r.sm2_interval), enc(r.sm2_ease), enc(r.wrong_count), enc(r.streak),
    ].join(',')).join('\n') + '\n'

    if (!fs.existsSync(vocabPath)) {
      fs.writeFileSync(vocabPath, VOCAB_HEADERS.join(',') + '\n', 'utf-8')
    }
    fs.appendFileSync(vocabPath, csvRows, 'utf-8')
    console.log(`  [words] 写入 vocabulary.csv: ${newRows.length} 新词汇`)
  }

  // 清理续跑文件
  try { fs.unlinkSync(tmpFile) } catch {}

  return { extracted: candidateWords.length, verified: verified.length, added: newRows.length }
}

// ============================================================
// 块语法（解析/序列化/重排的实现见 blocks.mjs —— 与前端共用同一份源码）
// 这里只放 runner 侧的编排：切块统计、内容守恒校验、取翻译目标、插译文
// ============================================================

/** 抽出一段文本里所有图片路径（![...](路径) 里的路径部分） */
function imagePaths(s) {
  const out = new Set()
  for (const m of String(s ?? '').matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)/g)) out.add(m[1])
  return out
}

/** 返回 before 里有、after 里没有的图片路径 */
function missingImages(before, after) {
  const b = imagePaths(before)
  const a = imagePaths(after)
  return [...b].filter((p) => !a.has(p))
}

/**
 * 图是不可以丢的。
 * 实测 clean 阶段会把 ![](images/x.jpg) 改写成没有路径的 ![image]，
 * 7 张图静默消失 —— 而字符数守恒检查只看比例（0.2%），完全看不出来。
 * 所以每个阶段结束都单独核对一遍图片路径，缺任何一张就报出来。
 */
function logImages(before, after, stage) {
  const b = imagePaths(before).size
  const a = imagePaths(after).size
  console.log(`  [images] ${stage}: ${b} → ${a} 张`)
  return a
}

function describeMissing(lost) {
  return `${lost.slice(0, 5).map((p) => p.split('/').pop()).join(', ')}${lost.length > 5 ? ` 等 ${lost.length} 张` : ''}`
}

/**
 * Tag 产出 → 带正确编号的骨架文档。
 * renumber 只改元信息里的编号，内容逐字不动，因此结构上不可能丢东西。
 * 另加一道内容守恒硬校验：剥掉标记后的正文必须和清理稿基本一致，
 * 防止 AI 打标时悄悄吞段落（历史上真发生过，产物残缺却判了 success）。
 */
function enumerateBlocks(taggedMd, cleanedMd) {
  const { items, warnings } = parseBlocks(taggedMd)
  for (const w of warnings.slice(0, 5)) console.warn(`  [enumerate] ${w}`)
  if (warnings.length > 5) console.warn(`  [enumerate] 另有 ${warnings.length - 5} 条同类告警`)

  const blocks = items.filter(it => it.t === 'block')
  const stats = {}
  for (const it of blocks) {
    const k = it.node.kind === 'note' ? it.node.type : it.node.kind === 'flow' ? `文字·${it.node.type}` : it.node.type
    stats[k] = (stats[k] || 0) + 1
  }
  console.log(`  [enumerate] 切出 ${blocks.length} 块：${Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  if (blocks.length === 0) {
    throw new Error('打标产出里一个块都没有（AI 未按块语法输出），已中止以避免生成空白译文。请重跑本任务。')
  }

  const skeletonMd = serializeBlocks(renumber(items))

  const norm = (s) => String(s ?? '').replace(/\s+/g, '')
  const before = norm(stripMarkers(cleanedMd))
  const after = norm(stripMarkers(skeletonMd))
  const loss = before.length ? 1 - after.length / before.length : 0
  console.log(`  [enumerate] 内容守恒：清理稿 ${before.length} 字 → 打标稿 ${after.length} 字（差 ${(loss * 100).toFixed(1)}%）`)
  if (before.length && loss > 0.03) {
    throw new Error(`打标阶段丢了 ${(loss * 100).toFixed(1)}% 正文（${before.length} → ${after.length} 字），已中止以避免写出残缺产物。请重跑本任务。`)
  }
  if (before.length && after > before * 1.03) {
    console.warn(`  [enumerate] ⚠️ 打标稿比清理稿多 ${((after / before - 1) * 100).toFixed(1)}% 字符，模型可能改写了原文，请留意`)
  }

  // 图单独核一遍：字符数守恒看比例，丢几张图（0.2%）根本触发不了阈值
  const lostImgs = missingImages(cleanedMd, skeletonMd)
  logImages(cleanedMd, skeletonMd, 'tag')
  if (lostImgs.length) {
    throw new Error(`打标阶段丢了 ${lostImgs.length} 张图，已中止（图不可以丢）。缺失：${describeMissing(lostImgs)}。请重跑本任务。`)
  }
  return skeletonMd
}

/**
 * 骨架文档里需要翻译的块，顺序即文档顺序。
 * key 用目标数组下标作续跑标识：骨架文档本身是存档产物，顺序稳定。
 */
function translationTargets(skeletonMd) {
  const { items } = readDocument(skeletonMd)
  const out = []
  for (const it of items) {
    if (it.t !== 'block' || !isTranslatable(it.node)) continue
    out.push({
      key: String(out.length),
      id: blockId(it.node),
      label: labelOf(it.node),
      type: it.node.type,
      content: it.content.trim(),
    })
  }
  return out
}

/** 把译文块插到各自源块之后，序列化成最终产物 */
function assembleBlocks(skeletonMd, translations) {
  const { items } = parseBlocks(skeletonMd)
  const out = []
  let ti = 0
  let inserted = 0
  for (const it of items) {
    out.push(it)
    if (it.t !== 'block' || !isTranslatable(it.node)) continue
    const cn = translations[String(ti)]
    ti++
    if (!cn || !cn.trim()) continue
    out.push({ t: 'block', node: { kind: 'translation', ref: blockId(it.node) }, content: `\n${cn.trim()}\n` })
    inserted++
  }
  return { md: serializeBlocks(out), inserted, total: ti }
}

// ============================================================
// Post-Mineru 主流程（带续跑 + progress）
// ============================================================
async function runPostMineru(doi, markdown, slug, onProgress) {
  const t = {
    cleaned: `literatures/${slug}/.tmp_cleaned.md`,
    tagged: `literatures/${slug}/.tmp_tagged.md`,
    enumerated: `literatures/${slug}/.tmp_enumerated.md`,
    translated: `literatures/${slug}/.tmp_translated.json`,
  }
  const tmpLocal = {}
  for (const [k, rel] of Object.entries(t)) {
    tmpLocal[k] = path.join(REPO_ROOT, rel)
  }
  const exists = (localPath) => fs.existsSync(localPath)
  const read = (localPath) => fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf-8') : ''
  const write = (localPath, content) => fs.writeFileSync(localPath, content, 'utf-8')

  // 1. Clean（分块：每块 ≤30K，防止 AI context 溢出）
  let cleanMd = read(tmpLocal.cleaned)
  if (!cleanMd) {
    await writeProgress(slug, { stage: 'ai1_clean', message: 'AI-1 清理...', pct: 10, node: 1 })
    onProgress?.({ stage: 'ai1_clean', pct: 10 })
    const chunks = []
    for (let i = 0; i < markdown.length; i += CLEAN_CHUNK) chunks.push(markdown.slice(i, i + CLEAN_CHUNK))
    console.log(`  [clean] markdown=${markdown.length} chars → ${chunks.length} chunks (chunk=${CLEAN_CHUNK}, concurrency=${CLEAN_CONCURRENCY})`)
    // 并发清理（AI 慢时串行要 20+ 分钟；429/超时由 aiCall 内部退避重试兜底）
    let cleanDone = 0
    const cleanedParts = await mapLimit(chunks, CLEAN_CONCURRENCY, async (chunk, i) => {
      const part = stripCodeFences(await aiCall(AI1_BASE_URL, AI1_API_KEY, AI1_MODEL, CLEAN_PROMPT, chunk, 'clean'))
      cleanDone++
      console.log(`  [clean] chunk ${i + 1} done (${cleanDone}/${chunks.length})`)
      return part
    })

    // 图片核对：clean 最容易在这里把 ![](images/x.jpg) 改写成 ![image]（路径就没了）。
    // 丢图时只重跑"含这些图的那几个分块"，不整篇重来 —— 省时省钱，也避免把已清理好的块又过一遍 AI。
    let lostImgs = missingImages(markdown, cleanedParts.join('\n'))
    if (lostImgs.length) {
      const badIdx = chunks
        .map((c, i) => (lostImgs.some((p) => c.includes(p)) ? i : -1))
        .filter((i) => i >= 0)
      console.warn(`  [clean] ⚠️ ${lostImgs.length} 张图丢了路径，重跑 ${badIdx.length} 个分块: ${describeMissing(lostImgs)}`)
      for (const i of badIdx) {
        cleanedParts[i] = stripCodeFences(
          await aiCall(AI1_BASE_URL, AI1_API_KEY, AI1_MODEL, CLEAN_RETRY_PROMPT, chunks[i], 'clean'),
        )
      }
      lostImgs = missingImages(markdown, cleanedParts.join('\n'))
      console.log(`  [clean] 重跑后仍缺 ${lostImgs.length} 张`)
    }
    logImages(markdown, cleanedParts.join('\n'), 'clean')

    cleanMd = cleanedParts.join('\n')
    cleanMd = cleanMd.replace(/<span[^>]*>.*?<\/span>/g, '').replace(/^\s*\n/gm, '').trim()

    // 核对放在最后（span 剥离之后），否则上面那步万一吃掉图就查不出来了
    lostImgs = missingImages(markdown, cleanMd)
    if (lostImgs.length) {
      throw new Error(`Clean 阶段丢了 ${lostImgs.length} 张图，已中止（图不可以丢）。缺失：${describeMissing(lostImgs)}。请重跑本任务。`)
    }
    write(tmpLocal.cleaned, cleanMd)
    console.log(`  ✓ clean ok, ${cleanMd.length} chars`)
    await saveCheckpoint(slug, t.cleaned, 'ai1_clean')
  } else {
    console.log('  [resume] skip clean')
    await writeProgress(slug, { stage: 'ai1_clean', message: '续跑：跳过 Clean', pct: 10, node: 1 })
  }
  // 2. Tag（分块：整篇 5w+ 字符一次性重发，16k 输出 token 装不下，
  //    推理模型还可能把预算全烧在 reasoning_content 上 → content 空 → 0 块假成功。
  //    与 clean 同策略分块；单块没切出块时必须让模型重试，绝不本地正则冒充。）
  const RETRY_TAG_PROMPT = TAG_PROMPT + `

特别注意：
1. 必须直接输出切好块的原文，禁止用三反引号代码块包裹整篇内容。
2. 每一个块都必须以 ${END} 收尾，不允许漏。
3. 不允许有任何内容落在 ${OPEN}……${CLOSE} 之外（块之间的空行除外）。`

  const tagCleanMd = async () => {
    // 块=20k：单块输出不会撞输出上限；并发 TAG_CONCURRENCY（见文件顶部常量）。
    const tChunks = []
    for (let i = 0; i < cleanMd.length; i += TAG_CHUNK) tChunks.push(cleanMd.slice(i, i + TAG_CHUNK))
    console.log(`  [tag] clean=${cleanMd.length} chars → ${tChunks.length} chunks (chunk=${TAG_CHUNK}, concurrency=${TAG_CONCURRENCY})`)
    let tagDone = 0
    // 判定"模型是否真的切出了块"：能解析出至少一个块就算合规。
    // 用共享解析器判定，和前端的口径完全一致。
    const hasBlock = (s) => parseBlocks(s).items.some(it => it.t === 'block')
    // 块切出来了、且这一块的图一张没少，才算合规
    const okChunk = (out, chunk) => hasBlock(out) && missingImages(chunk, out).length === 0
    const parts = await mapLimit(tChunks, TAG_CONCURRENCY, async (chunk, i) => {
      let out = stripCodeFences(await aiCall(AI1_BASE_URL, AI1_API_KEY, AI1_MODEL, TAG_PROMPT, chunk, 'tag'))
      if (!okChunk(out, chunk) && /[A-Za-z]/.test(chunk)) {
        console.warn(`  [tag] chunk ${i + 1} 首遍不合规（没切出块或丢了图），重试一次...`)
        out = stripCodeFences(await aiCall(AI1_BASE_URL, AI1_API_KEY, AI1_MODEL, RETRY_TAG_PROMPT, chunk, 'tag'))
      }
      // 图不可以丢：单块就对一遍，别等到最后才发现
      const lost = missingImages(chunk, out)
      if (lost.length) {
        throw new Error(`Tag 阶段 chunk ${i + 1}/${tChunks.length} 丢了 ${lost.length} 张图（图不可以丢）。缺失：${describeMissing(lost)}`)
      }
      if (!hasBlock(out) && /[A-Za-z]/.test(chunk)) {
        throw new Error(`Tag 阶段 chunk ${i + 1}/${tChunks.length} 连续两次没切出任何块（${OPEN}元信息${CLOSE}…${END}）。可能是当前 AI-1 模型不遵循指令，请检查模型选择或重试。`)
      }
      tagDone++
      console.log(`  [tag] chunk ${i + 1} done (${tagDone}/${tChunks.length})`)
      return out
    })
    return parts.join('\n')
  }
  let taggedMd = read(tmpLocal.tagged)
  if (!taggedMd) {
    await writeProgress(slug, { stage: 'ai1_tag', message: 'AI-1 打标...', pct: 25, node: 1 })
    onProgress?.({ stage: 'ai1_tag', pct: 25 })
    taggedMd = await tagCleanMd()
    write(tmpLocal.tagged, taggedMd)
    console.log('  ✓ tag ok')
    await saveCheckpoint(slug, t.tagged, 'ai1_tag')
  } else {
    console.log('  [resume] skip tag')
    await writeProgress(slug, { stage: 'ai1_tag', message: '续跑：跳过 Tag', pct: 25, node: 1 })
  }
  // 3. Enumerate（纯代码：重排编号 + 内容守恒校验）
  let skeletonMd = read(tmpLocal.enumerated)
  if (!skeletonMd) {
    await writeProgress(slug, { stage: 'enumerate', message: '纯代码编号...', pct: 40, node: 1 })
    onProgress?.({ stage: 'enumerate', pct: 40 })
    skeletonMd = enumerateBlocks(taggedMd, cleanMd)
    write(tmpLocal.enumerated, skeletonMd)
    await saveCheckpoint(slug, t.enumerated, 'enumerate')
  } else {
    console.log('  [resume] skip enumerate')
    await writeProgress(slug, { stage: 'enumerate', message: '续跑：跳过 Enumerate', pct: 40, node: 1 })
  }
  const targets = translationTargets(skeletonMd)
  if (targets.length === 0) {
    throw new Error('骨架文档里没有任何需要翻译的块，已中止以避免生成空白 ' + `${slug}.md` + '。请重跑本任务。')
  }
  console.log(`  ✓ enumerate ok, 待翻译 ${targets.length} 块`)

  // 4. Translate（逐块并发；结果以目标下标为 key 存 .tmp_translated.json，续跑只补缺的）
  const wordsSource = targets.filter(t => t.type !== '表' && /[A-Za-z]/.test(t.content)).map(t => t.content).join('\n\n')

  // ── 提前启动 AI-1 词汇提取（与 AI-2 翻译并行；结果写 .tmp_words.json，由 runWordsExtraction 续跑接管） ──
  const wordsTmpFile = path.join(REPO_ROOT, `literatures/${slug}/.tmp_words.json`)
  if (!fs.existsSync(wordsTmpFile) && wordsSource) {
    console.log(`  [words] 提前启动 AI-1 词汇提取（与翻译并行, ${wordsSource.length} chars）...`)
    pendingWordsExtract = (async () => {
      const raw = await aiCall(AI1_BASE_URL, AI1_API_KEY, AI1_MODEL, WORDS_EXTRACT_PROMPT, wordsSource, 'words')
      const cands = parseJsonArray(raw)
      if (cands?.length) {
        fs.writeFileSync(wordsTmpFile, JSON.stringify(cands), 'utf-8')
        await saveCheckpoint(slug, `literatures/${slug}/.tmp_words.json`, 'words_extract')
      }
      console.log(`  [words] AI-1 预提取完成: ${cands?.length || 0} 词`)
    })().catch(e => { console.warn(`  [words] 预提取失败（主流程稍后重试）: ${e.message?.slice(0, 120) || e}`); return null })
  }

  let translations = {}
  if (exists(tmpLocal.translated)) {
    try { translations = JSON.parse(read(tmpLocal.translated)).translations || {} } catch {}
    console.log(`  [resume] translate: ${Object.keys(translations).length}/${targets.length} 块已完成`)
  }
  const todo = targets.filter(t => !translations[t.key]?.trim())
  let transDone = targets.length - todo.length
  const flushTranslations = () => fs.writeFileSync(tmpLocal.translated, JSON.stringify({ translations }), 'utf-8')
  await mapLimit(todo, TRANS_CONCURRENCY, async (t) => {
    const cn = await aiCall(
      AI2_BASE_URL, AI2_API_KEY, AI2_MODEL,
      TRANSLATE_PROMPT(t.type === '表' ? 'table' : 'para'),
      t.content, 'translate',
    )
    translations[t.key] = cn
    transDone++
    const pct = 50 + Math.round(40 * transDone / Math.max(1, targets.length))
    writeProgressThrottled(slug, { stage: 'translating', message: `AI-2 翻译 ${transDone}/${targets.length}`, pct, node: 2 })
    onProgress?.({ stage: 'translating', pct })
    // 每 10 块落盘一次：中途挂掉时重试只补剩下的块，不重翻已完成的
    if (transDone % 10 === 0) { flushTranslations(); await saveCheckpoint(slug, t.translated, `translating ${transDone}/${targets.length}`) }
  })
  flushTranslations()
  await saveCheckpoint(slug, t.translated, 'translating done')

  // 5. 组装（纯代码：把译文块插到各自源块之后）
  await writeProgress(slug, { stage: 'assemble', message: '组装最终文件...', pct: 95, node: 3 })
  onProgress?.({ stage: 'assemble', pct: 95 })
  const { md: alignedMd, inserted, total } = assembleBlocks(skeletonMd, translations)
  if (inserted === 0) {
    throw new Error('组装阶段发现 0 条译文，拒绝写入空白 ' + `${slug}.md` + '。请重跑本任务。')
  }
  if (inserted < total) {
    console.warn(`  ⚠️ ${total - inserted}/${total} 块没有译文，已按原文落盘（阅读页会标注"译文排队中"）`)
  }
  console.log(`  ✓ assemble ok，${total} 块中 ${inserted} 块带译文`)
  // 图最后再核一遍：组装只是插译文块，任何一张图没了都说明前面有环节出问题
  const finalLost = missingImages(skeletonMd, alignedMd)
  logImages(skeletonMd, alignedMd, 'assemble')
  if (finalLost.length) {
    throw new Error(`组装阶段丢了 ${finalLost.length} 张图，已中止（图不可以丢）。缺失：${describeMissing(finalLost)}。请重跑本任务。`)
  }
  const alignedRel = `literatures/${slug}/${slug}.md`
  fs.writeFileSync(path.join(REPO_ROOT, alignedRel), alignedMd, 'utf-8')
  // 6. 清理 tmp
  for (const f of Object.values(tmpLocal)) { try { if (fs.existsSync(f)) fs.unlinkSync(f) } catch {} }
  return { alignedMd, enItems: targets.map(t => ({ en: t.content })) }
}

// ============================================================
// CSV 状态更新（fs 读写本地文件，然后 commitLocalFiles push）
// ============================================================
function updateLocalCsvField(doi, field, value, message) {
  const relPath = 'literatures/literatures.csv'
  const fullPath = path.join(REPO_ROOT, relPath)
  if (!fs.existsSync(fullPath)) { console.warn(`  [csv] 文件不存在: ${relPath}`); return false }
  const lit = loadLocalCsv(relPath)
  const doiCol = lit.headers.indexOf('doi')
  const fieldCol = lit.headers.indexOf(field)
  if (doiCol < 0 || fieldCol < 0) {
    console.warn(`  [csv] 找不到 doi 或 ${field} 列，跳过 CSV 更新`)
    return false
  }
  for (const row of lit.rows) { if (row[doiCol] === doi) { row[fieldCol] = String(value); break } }
  saveLocalCsv(relPath, lit.headers, lit.rows)
  return true
}

// ============================================================
// PDF 自动发现
// ============================================================

/**
 * 列出 literatures/{slug}/source/ 目录，返回一个真实存在的 PDF 路径。
 * 前端重新转换时可能传错文件名（source.pdf vs 时间戳文件名），这里做最终兜底。
 * 优先：体积最大的 .pdf；其次任意 .pdf；都没有返回 null。
 */
async function discoverPdfInSourceDir(slug) {
  const dirRel = `literatures/${slug}/source`
  try {
    const listing = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${dirRel}`, null)
    if (!Array.isArray(listing)) return null
    const pdfs = listing
      .filter((f) => f.type === 'file' && /\.pdf$/i.test(f.name))
      .sort((a, b) => (b.size || 0) - (a.size || 0))
    if (pdfs.length === 0) return null
    return pdfs[0].path
  } catch (e) {
    console.warn(`  [pdf] source/ 目录列举失败: ${e.message?.slice(0, 120) || e}`)
    return null
  }
}

// ============================================================
// 主入口
// ============================================================
async function main() {
  // payload 可来自 argv（旧 workflow）或 PIPELINE_PAYLOAD 环境变量（新 workflow），
  // 环境变量方式可避免标题含单引号时破坏 shell 引号结构
  const payload = JSON.parse(process.argv[2] || process.env.PIPELINE_PAYLOAD || '{}') || {}
  const { doi, title, pdf_path } = payload
  if (!doi || !pdf_path) { console.error('❌ 需要 doi 和 pdf_path'); process.exit(1) }
  const slug = doi.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\./g, '-')
  console.log(`=== Pipeline start ===`)
  console.log(`  DOI: ${doi}, Slug: ${slug}, PDF: ${pdf_path}`)

  // 思考模式：从私库 settings/global.md 读取按阶段的配置（runner 已 checkout 仓库）
  loadThinkingConfig()

  // 本地目录
  const slugLocalDir = path.join(REPO_ROOT, `literatures/${slug}`)
  fs.mkdirSync(slugLocalDir, { recursive: true })

  // ── 检查 A: Pipeline 启动前，确认文献还活着 ──
  if (!(await checkLiteratureAlive(doi))) {
    console.log(`=== Pipeline ABORTED (文献已被删除) ===`)
    return
  }

  // ── 检查 A.5: AI secrets 快速预检（MinerU 之前确认 AI 能用） ──
  console.log(`  [ai-health] 预检 AI1 / AI2 ...`)
  await quickAiHealthCheck()

  // 初始状态
  writeProgress(slug, { stage: 'queued', message: 'Pipeline 启动...', pct: 0, node: 0 }).catch(() => {})
  updateLocalCsvField(doi, 'md_status', 'converting')

  try {
    // 1. 本地读 PDF（checkout 后磁盘上应该有，但可能不在 repo 跟踪里）
    let resolvedPdfPath = pdf_path
    let pdfLocalPath = path.join(REPO_ROOT, resolvedPdfPath)
    if (!fs.existsSync(pdfLocalPath)) {
      // fallback：通过 GitHub API blob GET 读
      console.log(`  [pdf] 本地未找到，尝试 API 读取 ${resolvedPdfPath}`)
      try {
        const blobRes = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${resolvedPdfPath}`, null)
        if (blobRes?.encoding === 'base64' && blobRes.content) {
          if (blobRes.size > MAX_BLOB_SIZE) throw new Error(`PDF too large: ${blobRes.size} > 100MB`)
          fs.writeFileSync(pdfLocalPath, Buffer.from(blobRes.content, 'base64'))
        } else throw new Error('无法读取 PDF')
      } catch (e) {
        // 前端"重新转换"历史上会硬传 literatures/{slug}/source/source.pdf，
        // 但实际上传文件名带时间戳（如 1789678524767__pdf.pdf）→ 404 直接整单失败。
        // 兜底：列出 source/ 目录，自动挑一个真正存在的 .pdf。
        console.log(`  [pdf] 指定路径不可用（${e.message.slice(0, 120)}），自动发现 source/ 下的 PDF...`)
        const found = await discoverPdfInSourceDir(slug)
        if (!found) {
          throw new Error(`PDF 不存在：${pdf_path} (本地、API、source/ 自动发现都找不到): ${e.message}`)
        }
        resolvedPdfPath = found
        pdfLocalPath = path.join(REPO_ROOT, resolvedPdfPath)
        console.log(`  [pdf] 自动发现 PDF: ${resolvedPdfPath}`)
        if (!fs.existsSync(pdfLocalPath)) {
          const blobRes2 = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${resolvedPdfPath}`, null)
          if (blobRes2?.encoding === 'base64' && blobRes2.content) {
            fs.mkdirSync(path.dirname(pdfLocalPath), { recursive: true })
            fs.writeFileSync(pdfLocalPath, Buffer.from(blobRes2.content, 'base64'))
          } else {
            throw new Error(`自动发现的 PDF 读取失败: ${resolvedPdfPath}`)
          }
        }
      }
    }
    console.log(`  [pdf] 使用文件: ${resolvedPdfPath}`)
    const pdfBuf = fs.readFileSync(pdfLocalPath)
    if (pdfBuf.length > MAX_BLOB_SIZE) {
      throw new Error(`PDF too large: ${pdfBuf.length} bytes > 100MB GitHub blob limit. 用户需手动裁剪或用 Git LFS.`)
    }
    console.log(`  ✓ PDF ${pdfBuf.length} bytes`)

    // ── 断点续跑：先看仓库里存档到哪一步 ──
    const savedMeta = await readSourceMeta(slug)
    const artifactsOnDisk = Object.values(artifactPaths(slug)).some(artifactExists)
    // 存档可信的前提：存了源 PDF 指纹，且和本次 dispatch 的 PDF 完全一致。
    // 没有指纹说明存档来路不明（例如上次已经成功跑完、.tmp 已清），一律不复用。
    const sourceChanged = !!savedMeta && (savedMeta.pdf_path !== resolvedPdfPath || savedMeta.pdf_size !== pdfBuf.length)
    const trusted = !!savedMeta && !sourceChanged
    if (artifactsOnDisk && !trusted) {
      await purgeArtifacts(slug, sourceChanged
        ? `源 PDF 已变化: ${savedMeta.pdf_path} → ${resolvedPdfPath}`
        : '缺少源 PDF 指纹，无法确认存档属于本篇')
    }
    const plan = describeResume(slug)
    console.log(`  [resume] ${trusted
      ? `源 PDF 指纹匹配；已存档: ${plan.done.length ? plan.done.join(' → ') : '（无）'}；本次从「${plan.nextLabel}」开始`
      : '无可信存档（首次转换，或上次已成功跑完），从头跑'}`)

    const mineruMdRel = `literatures/${slug}/full.md`
    const imagesRel = `literatures/${slug}/images`
    const mineruMdLocalMain = path.join(REPO_ROOT, mineruMdRel)
    const imagesDirMain = path.join(REPO_ROOT, imagesRel)
    const hasImages = fs.existsSync(imagesDirMain) && fs.readdirSync(imagesDirMain).length > 0

    // 2. MinerU（存档可信 + full.md + images/ 都在 → 直接复用，不重复消耗 MinerU 额度与时间）
    const canReuseMineru = trusted && plan.mineru && hasImages
      && fs.existsSync(mineruMdLocalMain) && fs.statSync(mineruMdLocalMain).size > 1000
    let markdown = null
    if (canReuseMineru) {
      markdown = fs.readFileSync(mineruMdLocalMain, 'utf-8')
      console.log(`  [resume] 复用已存档 MinerU 产物（full.md ${markdown.length} chars + images），跳过 MinerU`)
      await writeProgress(slug, { stage: 'mineru_download', message: '续跑：复用已存档 MinerU 产物', pct: 48, node: 0 })
    } else {
      await writeProgress(slug, { stage: 'mineru_apply', message: 'MinerU 申请...', pct: 10, node: 0 })
      const mineru = await mineruConvert(pdfBuf, `${slug}.pdf`, (p) => writeProgress(slug, { ...p, node: 0 }))
      markdown = mineru.markdown
      console.log(`  ✓ MinerU done, md length=${markdown.length}`)
    }

    // ── 检查 B: MinerU 跑完后（可能花了好几分钟），用户可能删了文献 ──
    if (!(await checkLiteratureAlive(doi))) {
      console.log(`=== Pipeline ABORTED (文献已被删除) ===`)
      return
    }

    // 存 MinerU 原始 md：就用它本来的文件名 full.md，不改名（少一层映射）
    const mineruMdLocal = path.join(REPO_ROOT, mineruMdRel)
    fs.writeFileSync(mineruMdLocal, markdown, 'utf-8')
    // 刚跑完 MinerU → 立刻存档 full.md + images + 源指纹：下次重试可整段跳过 MinerU
    if (!canReuseMineru) {
      writeSourceMeta(slug, resolvedPdfPath, pdfBuf.length)
      await saveCheckpoint(slug, [mineruMdRel, imagesRel, artifactPaths(slug).meta], 'mineru')
    }

    // 3. Post-Mineru（本地跑 AI，结果存本地 —— 内部会写 ai1_clean → ai1_tag → enumerate → translating → assemble）
    const postResult = await runPostMineru(doi, markdown, slug, (p) => console.log(`  [post] ${p.stage} ${p.pct ?? ''}`))

    // 3.5 单词提取（AI-1 提取 + AI-2 核验 → vocabulary/vocabulary.csv，节点 3 的 words_extract / words_verify）
    try {
      const wres = await runWordsExtraction(postResult.enItems, doi, slug)
      console.log(`  ✓ Words: extracted=${wres.extracted}, verified=${wres.verified}, added=${wres.added}`)
    } catch (e) {
      // words 提取失败不阻断主流程（vocabulary 是学习辅助功能，不是核心产物）
      console.warn(`  ⚠️ Words extraction failed: ${e.message}`)
    }

    // 4. 提交所有变更到 GitHub（一次 git commit + push）
    await writeProgress(slug, { stage: 'commit', message: '提交到 GitHub...', pct: 98, node: 3 })
    // 全流程成功 → 阶段存档作废：本地删掉，并把删除动作一起提交（否则 .tmp 会永远留在仓库里）
    const ckptRels = Object.values(artifactPaths(slug))
    for (const rel of ckptRels) { try { fs.unlinkSync(localFull(rel)) } catch {} }
    // 上次失败留下的 .diag 诊断产物：这次成功了就不该再留在私库里占空间
    const diagDirRel = `literatures/${slug}/.diag`
    try { fs.rmSync(localFull(diagDirRel), { recursive: true, force: true }) } catch {}
    await commitLocalFiles([
      'literatures/literatures.csv',
      `literatures/${slug}/full.md`,
      `literatures/${slug}/${slug}.md`,
      `literatures/${slug}/images`,
      `vocabulary/vocabulary.csv`,
      `literatures/${slug}/.progress.json`,
      diagDirRel,
      ...ckptRels,
    ], `[pipeline] convert ${slug}: ${title}`)

    // 4.5 写终态 stage=done（给前端 UI 最后一次进度反馈）
    await writeProgress(slug, { stage: 'done', message: '转换完成', pct: 100, node: 3 })

    // 5. 终态：写 md_status=done，删 progress
    await updateLocalCsvField(doi, 'md_status', 'done')
    fs.writeFileSync(path.join(REPO_ROOT, 'literatures/literatures.csv'), fs.readFileSync(path.join(REPO_ROOT, 'literatures/literatures.csv')))
    await commitLocalFiles(['literatures/literatures.csv'], `[pipeline] ${slug} done`)
    try { fs.unlinkSync(path.join(REPO_ROOT, `literatures/${slug}/.progress.json`)) } catch {}
    try { await ghDelete(`literatures/${slug}/.progress.json`, 'progress done') } catch {}

    console.log(`=== Pipeline done ===`)
  } catch (err) {
    console.error(`❌ Pipeline failed:`, err.message || err)
    try {
      updateLocalCsvField(doi, 'md_status', 'failed')
      // 记录"下次重试会从哪一步开始"，前端/日志都能看到，避免以为要重跑全部
      const rp = describeResume(slug)
      await writeProgress(slug, {
        stage: 'failed', message: `失败: ${err.message}`,
        pct: 0, node: 3, error: err.message || String(err),
        resume_from: rp.nextLabel,
        checkpointed: rp.done,
      })
      console.log(`  [resume] 已存档阶段: ${rp.done.join(' → ') || '（无）'}；重试将从「${rp.nextLabel}」继续`)
      // 诊断快照：把失败现场的中间文件（cleaned/tag 产物）提交到 .diag/，不污染 .tmp 续跑逻辑
      const diagDir = `literatures/${slug}/.diag`
      fs.mkdirSync(path.join(REPO_ROOT, diagDir), { recursive: true })
      const copyIfExists = (src, dst) => { try { if (fs.existsSync(src) && fs.statSync(src).size) fs.copyFileSync(src, dst) } catch {} }
      copyIfExists(path.join(REPO_ROOT, `literatures/${slug}/.tmp_cleaned.md`), path.join(REPO_ROOT, `${diagDir}/cleaned.md`))
      copyIfExists(path.join(REPO_ROOT, `literatures/${slug}/.tmp_tagged.md`), path.join(REPO_ROOT, `${diagDir}/tagged.md`))
      copyIfExists(path.join(REPO_ROOT, `literatures/${slug}/.tmp_enumerated.md`), path.join(REPO_ROOT, `${diagDir}/enumerated.md`))
      fs.writeFileSync(path.join(REPO_ROOT, `${diagDir}/error.txt`), `${err.message || String(err)}\n\nmodel: ${AI1_MODEL}\n`, 'utf-8')
      await commitLocalFiles([
        'literatures/literatures.csv',
        `literatures/${slug}/.progress.json`,
        `${diagDir}/`,
      ], `[pipeline] ${slug} failed: ${err.message}`)
    } catch { console.warn('  [fail-safe] 写失败状态也失败了') }
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
