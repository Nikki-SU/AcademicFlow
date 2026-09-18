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

// 单块字符数：两块都按"输入 + 输出不撞 16k 输出上限"定（20k 字符 ≈ 5-6k tokens 输出）
const CLEAN_CHUNK = 20000
const TAG_CHUNK = 20000

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
          }),
          signal: ctrl.signal,
        })
        clearTimeout(timer)

        const elapsed = Date.now() - t0
        if (resp.ok) {
          const data = await resp.json().catch(() => ({}))
          const tokens = data.usage?.completion_tokens ?? '?'
          console.log(`  [ai-health] ${p.label} ✓ HTTP ${resp.status} ${elapsed}ms tokens=${tokens}`)
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
//   .tmp_translated.json  已翻译段落（{enItems, tables}）
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

/** 把某阶段产物提交进仓库；失败只告警，绝不阻断主流程 */
async function saveCheckpoint(slug, relPaths, label) {
  const list = Array.isArray(relPaths) ? relPaths : [relPaths]
  if (!list.some(artifactExists)) return
  try {
    await commitLocalFiles(list, `[pipeline] ${slug} checkpoint: ${label}`)
    console.log(`  [ckpt] ✓ 已存档 ${label}`)
  } catch (e) {
    console.warn(`  [ckpt] ⚠ 存档 ${label} 失败（不阻塞主流程）: ${e.message?.slice(0, 120) || e}`)
  }
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
 * 或在块边界吐出零散 ``` 行。围栏会让 autoInsertParaTags 把全文当成 code block，
 * 结果一个 PARA_EN 都插不进去 → nodes=0 → 零翻译 → 1 字节假成功 md。
 * 学术正文里不保留代码块（公式一律用 $），所以直接删除所有围栏行是安全的。
 */
function stripCodeFences(s) {
  if (!s) return s
  let t = s.replace(/^\uFEFF/, '')
  const lines = t.split('\n')
  const out = lines.filter((l) => !/^\s*```[A-Za-z0-9_-]*\s*$/.test(l))
  return out.join('\n').replace(/^\s*\n+/, '').replace(/\s+$/, '')
}

async function aiCall(baseUrl, apiKey, model, system, user, signal) {
  const MAX_RETRY = 10
  const TIMEOUT_MS = 900_000
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
          max_tokens: 16000,
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
      // 推理模型（如 kimi-k2 系）在长文重发任务上可能耗尽输出预算：
      // 16k tokens 全花在 reasoning_content 上，content 返回空字符串，
      // finish_reason=length。旧代码直接返回 '' → Tag "成功"但 0 标记 → 假成功。
      // 空响应视为可重试错误，让退避重试接管。
      if (!content || !content.trim()) {
        throw new Error(`AI ${model}: 空 content (finish_reason=${finishReason || '?'}, reasoning_chars=${reasoningChars})，可能输出预算耗尽或被截断`)
      }
      // 截断的输出绝不能当成功返回。
      // clean/tag 的输出是"原文的完整副本 + 标记"，一旦被截断就是静默丢正文
      // （实测：reasoning 吃掉输出预算，某块只回了 6 字符，整篇少了 40% 正文，
      //  但 run 仍然 success）。当作可重试错误抛出去，让退避重试接管；
      // 若重试后仍截断，就明确失败，绝不写残缺产物。
      if (finishReason === 'length') {
        throw new Error(`AI ${model}: 输出被截断 finish_reason=length (content=${content.length} chars, reasoning=${reasoningChars} chars —— 输出预算被 reasoning 占用)`)
      }
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
1. 移除页眉页脚、页码、版权声明、期刊模板文字
2. 拼接被打断的段落（处理断词断句）
3. 保留图片占位 ![image] 但不描述
4. 保留 Markdown 表格
5. 保留 LaTeX 公式原样不动
6. 参考文献章节完整保留
7. 纯 Markdown 输出，不要代码块
直接输出清理后的内容。`

const TAG_PROMPT = `你是文献标注专家。在 Markdown 上插 HTML 注释标记：
<!-- PARA_EN --> 插在每个英文正文段落**前**
<!-- IMG --> 插在每个 ![...] **前**
<!-- TABLE --> 插在每个 Markdown 表格**前**
<!-- REF_ALL --> 插在参考文献章节**前**（References/Bibliography）
只插标记，不改动原有文字。直接输出。`

const TRANSLATE_PROMPT = (type) => type === 'table'
  ? `翻译 Markdown 表格：格式不变，英文翻中文。输出 Markdown 表格。`
  : `翻译英文段落到中文，保持学术语气。只输出译文。`

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
    const raw = await aiCall(AI1_BASE_URL, AI1_API_KEY, AI1_MODEL, WORDS_EXTRACT_PROMPT, allEn)
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

function autoInsertParaTags(md) {
  const lines = md.split('\n'); const out = []; let inCB = false; let buf = []; let bufTable = false
  const flush = () => {
    if (!buf.length) return
    const block = buf.join('\n')
    const nonEmpty = buf.filter(l => l.trim()).length
    const hasLetter = /[A-Za-z\u4e00-\u9fa5\d]/.test(block)
    const isImgOnly = buf.every(l => !l.trim() || l.trim().startsWith('!['))
    const isTableOnly = bufTable
    const isFormulaOnly = buf.every(l => !l.trim() || /^\s*\$\$?[\s\S]*\$\$?\s*$/.test(l.trim()))
    out.push(...buf); buf = []; bufTable = false
    if (nonEmpty > 0 && hasLetter && !isImgOnly && !isTableOnly && !isFormulaOnly) out.push('<!-- PARA_EN -->')
  }
  for (const line of lines) {
    if (/^\s*```/.test(line)) { flush(); inCB = !inCB; out.push(line); continue }
    if (inCB) { out.push(line); continue }
    if (/^\s*<!--.*-->\s*$/.test(line)) { flush(); out.push(line); continue }
    if (!line.trim()) { flush(); out.push(line); continue }
    if (/^\s*!\[/.test(line)) { flush(); out.push(line); continue }
    if (/^\s*\|/.test(line)) { if (!buf.length) { buf = [line]; bufTable = true } else { flush(); buf = [line]; bufTable = true }; continue }
    if (bufTable) { buf.push(line); if (!/^\s*\|/.test(line)) flush(); continue }
    buf.push(line)
  }
  flush(); return out.join('\n')
}

function enumerateTaggedMd(md) {
  if (!/<!--\s*PARA_EN\s*-->/.test(md)) { console.log('  [enumerate] auto insert PARA_EN'); md = autoInsertParaTags(md) }
  const lines = md.split('\n'); const out = []; let idx = 0
  const total = lines.filter(l => /<!--\s*PARA_EN\s*-->/.test(l)).length
  for (const line of lines) {
    if (/<!--\s*PARA_EN\s*-->/.test(line)) { idx++; out.push(`<!-- PARA en ${idx}/${total} -->`); continue }
    if (/<!--\s*IMG\s*-->/.test(line)) { out.push(`<!-- IMG between ${idx} and ${idx + 1} -->`); continue }
    if (/<!--\s*TABLE\s*-->/.test(line)) { out.push(`<!-- TABLE between ${idx} and ${idx + 1} -->`); continue }
    if (/<!--\s*REF_ALL\s*-->/.test(line)) { out.push('<!-- REF ALL -->'); continue }
    out.push(line)
  }
  return out.join('\n')
}

function parseAlignedMd(md) {
  const lines = md.split('\n'); const nodes = []; let curPara = { idx: 0, total: 0, content: '' }
  let inTable = false; let tableBuf = []; let tableStart = -1
  let refContent = ''; let inRef = false; let lastParaIdx = 0
  const flushPara = () => {
    if (curPara.idx > 0 && curPara.content.trim()) {
      nodes.push({ type: 'para', idx: curPara.idx, total: curPara.total, content: curPara.content.trim() })
    }
    curPara = { idx: 0, total: 0, content: '' }
  }
  for (const line of lines) {
    const paraMatch = line.match(/<!--\s*PARA\s+en\s+(\d+)\/(\d+)\s*-->/)
    if (paraMatch) { flushPara(); curPara = { idx: Number(paraMatch[1]), total: Number(paraMatch[2]), content: '' }; if (inRef) { refContent += '\n'; inRef = false }; continue }
    const imgMatch = line.match(/<!--\s*IMG\s+between\s+(\d+)\s+and\s+(\d+)\s*-->/)
    if (imgMatch) { continue } // imgs handled via tree
    const tableMatch = line.match(/<!--\s*TABLE\s+between\s+(\d+)\s+and\s+(\d+)\s*-->/)
    if (tableMatch) { flushPara(); inTable = true; tableBuf = []; tableStart = Number(tableMatch[1]); continue }
    if (/<!--\s*REF\s+ALL\s*-->/.test(line)) { flushPara(); inRef = true; continue }
    if (inTable) {
      if (/^\s*\|/.test(line)) { tableBuf.push(line); continue }
      else { if (tableBuf.length) { nodes.push({ type: 'table', beforeIdx: tableStart, afterIdx: tableStart + 1, content: tableBuf.join('\n').trim() }) }; inTable = false; tableBuf = [] }
    }
    if (inRef) { refContent += (refContent ? '\n' : '') + line; continue }
    if (curPara.idx > 0) { curPara.content += (curPara.content ? '\n' : '') + line; if (line.trim()) lastParaIdx = curPara.idx }
  }
  flushPara()
  return { nodes, refContent: refContent.trim() }
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
      const part = stripCodeFences(await aiCall(AI1_BASE_URL, AI1_API_KEY, AI1_MODEL, CLEAN_PROMPT, chunk))
      cleanDone++
      console.log(`  [clean] chunk ${i + 1} done (${cleanDone}/${chunks.length})`)
      return part
    })
    cleanMd = cleanedParts.join('\n')
    cleanMd = cleanMd.replace(/<span[^>]*>.*?<\/span>/g, '').replace(/^\s*\n/gm, '').trim()
    write(tmpLocal.cleaned, cleanMd)
    console.log(`  ✓ clean ok, ${cleanMd.length} chars`)
    await saveCheckpoint(slug, t.cleaned, 'ai1_clean')
  } else {
    console.log('  [resume] skip clean')
    await writeProgress(slug, { stage: 'ai1_clean', message: '续跑：跳过 Clean', pct: 10, node: 1 })
  }
  // 2. Tag（分块：整篇 5w+ 字符一次性重发，16k 输出 token 装不下，
  //    推理模型还可能把预算全烧在 reasoning_content 上 → content 空 → 0 标记假成功。
  //    与 clean 同策略分块；单块漏标时必须让模型重试，绝不本地正则冒充。）
  const RETRY_TAG_PROMPT = `你是文献标注专家。在 Markdown 上插 HTML 注释标记：
<!-- PARA_EN --> 插在每个英文正文段落**前**
<!-- IMG --> 插在每个 ![...] **前**
<!-- TABLE --> 插在每个 Markdown 表格**前**
<!-- REF_ALL --> 插在参考文献章节**前**（References/Bibliography）
要求：
1. 保留原文每一个字、每一张图片、每一个表格。禁止摘要/改写。
2. 每个英文正文段落前必须单独一行插入 <!-- PARA_EN -->，不允许漏掉任何段落。
3. 禁止用三反引号代码块包裹整篇内容。
4. 直接输出插好标记的 Markdown 原文。`

  const tagCleanMd = async () => {
    // 块=20k：单块输出不会撞 16k 输出上限；并发 TAG_CONCURRENCY（见文件顶部常量）。
    // 单块漏标记时必须让模型重试，绝不本地正则冒充。
    const tChunks = []
    for (let i = 0; i < cleanMd.length; i += TAG_CHUNK) tChunks.push(cleanMd.slice(i, i + TAG_CHUNK))
    console.log(`  [tag] clean=${cleanMd.length} chars → ${tChunks.length} chunks (chunk=${TAG_CHUNK}, concurrency=${TAG_CONCURRENCY})`)
    let tagDone = 0
    const parts = await mapLimit(tChunks, TAG_CONCURRENCY, async (chunk, i) => {
      let out = stripCodeFences(await aiCall(AI1_BASE_URL, AI1_API_KEY, AI1_MODEL, TAG_PROMPT, chunk))
      if (!/<!--\s*PARA_EN\s*-->/.test(out) && /[A-Za-z]/.test(chunk)) {
        console.warn(`  [tag] chunk ${i + 1} 首遍无 PARA_EN，重试一次...`)
        out = stripCodeFences(await aiCall(AI1_BASE_URL, AI1_API_KEY, AI1_MODEL, RETRY_TAG_PROMPT, chunk))
      }
      if (!/<!--\s*PARA_EN\s*-->/.test(out) && /[A-Za-z]/.test(chunk)) {
        throw new Error(`Tag 阶段 chunk ${i + 1}/${tChunks.length} 连续两次未插入 PARA_EN 标记。可能是当前 AI-1 模型不遵循指令，请检查模型选择或重试。`)
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
  // 3. Enumerate
  let skeletonMd = read(tmpLocal.enumerated)
  let parsed
  if (!skeletonMd) {
    await writeProgress(slug, { stage: 'enumerate', message: '纯代码编号...', pct: 40, node: 1 })
    onProgress?.({ stage: 'enumerate', pct: 40 })
    skeletonMd = enumerateTaggedMd(taggedMd)
    parsed = parseAlignedMd(skeletonMd)
    // 硬保护：一个正文段落都没解析出来时，绝不能继续往下跑（否则 0 次翻译 + 1 字节假成功 md）。
    // 先带着更强约束让 AI-1 重新打标一次；仍为 0 就明确失败，让用户看到红叉而不是空白阅读页。
    if (parsed.nodes.filter(n => n.type === 'para').length === 0) {
      console.warn('  [enumerate] 首轮流标 nodes=0，剥离围栏后重试 Tag 一次...')
      const RETRY_TAG_PROMPT = TAG_PROMPT +
        '\n\n特别注意：必须直接输出插好标记的 Markdown 原文，禁止用三反引号代码块整篇包裹；' +
        '每个正文段落前必须单独一行插入 <!-- PARA_EN -->，不允许漏掉任何段落。'
      taggedMd = stripCodeFences(await aiCall(AI1_BASE_URL, AI1_API_KEY, AI1_MODEL, RETRY_TAG_PROMPT, cleanMd))
      write(tmpLocal.tagged, taggedMd)
      skeletonMd = enumerateTaggedMd(taggedMd)
      parsed = parseAlignedMd(skeletonMd)
    }
    const paraCount = parsed.nodes.filter(n => n.type === 'para').length
    if (paraCount === 0) {
      throw new Error('Tag/Enumerate 后解析出 0 个正文段落（AI 未按要求插入 PARA_EN 标记），已中止以避免生成空白译文。请重跑本任务。')
    }
    write(tmpLocal.enumerated, skeletonMd)
    console.log('  ✓ enumerate ok, nodes=', parsed.nodes.length, 'paras=', paraCount)
    await saveCheckpoint(slug, t.enumerated, 'enumerate')
  } else {
    console.log('  [resume] skip enumerate')
    parsed = parseAlignedMd(skeletonMd)
    await writeProgress(slug, { stage: 'enumerate', message: '续跑：跳过 Enumerate', pct: 40, node: 1 })
  }
  // 4. Translate
  const enNodes = parsed.nodes.filter(n => n.content && /[A-Za-z]/.test(n.content))
  const tableNodes = parsed.nodes.filter(n => n.type === 'table')

  // ── 提前启动 AI-1 词汇提取（与 AI-2 翻译并行；结果写 .tmp_words.json，由 runWordsExtraction 续跑接管） ──
  const wordsTmpFile = path.join(REPO_ROOT, `literatures/${slug}/.tmp_words.json`)
  if (!fs.existsSync(wordsTmpFile) && enNodes.length) {
    const wordsEn = enNodes.map(n => n.content).join('\n\n')
    console.log(`  [words] 提前启动 AI-1 词汇提取（与翻译并行, ${wordsEn.length} chars）...`)
    pendingWordsExtract = (async () => {
      const raw = await aiCall(AI1_BASE_URL, AI1_API_KEY, AI1_MODEL, WORDS_EXTRACT_PROMPT, wordsEn)
      const cands = parseJsonArray(raw)
      if (cands?.length) {
        fs.writeFileSync(wordsTmpFile, JSON.stringify(cands), 'utf-8')
        await saveCheckpoint(slug, `literatures/${slug}/.tmp_words.json`, 'words_extract')
      }
      console.log(`  [words] AI-1 预提取完成: ${cands?.length || 0} 词`)
    })().catch(e => { console.warn(`  [words] 预提取失败（主流程稍后重试）: ${e.message?.slice(0, 120) || e}`); return null })
  }
  let enItems = [], tables = [], startEn = 0, startTable = 0
  let resumeData = null
  if (exists(tmpLocal.translated)) {
    try { resumeData = JSON.parse(read(tmpLocal.translated)); enItems = resumeData.enItems || []; tables = resumeData.tables || []; startEn = enItems.length; startTable = tables.length } catch {}
    console.log(`  [resume] translate: ${enItems.length} segments done`)
  }
  // 并发翻译（TRANS_CONCURRENCY，见文件顶部常量）：结果按原文顺序有序收集（保证续跑语义与最终段落顺序）
  let transDone = startEn
  const transOut = {}
  let nextToAppend = startEn
  const collectOrdered = () => {
    while (transOut[nextToAppend] !== undefined) {
      const seg = enNodes[nextToAppend]
      enItems.push({ idx: seg.idx ?? nextToAppend + 1, total: enNodes.length, en: seg.content, cn: transOut[nextToAppend] })
      delete transOut[nextToAppend]
      nextToAppend++
    }
    if (enItems.length % 5 === 0) {
      fs.writeFileSync(tmpLocal.translated, JSON.stringify({ enItems, tables }), 'utf-8')
    }
  }
  await mapLimit(enNodes.slice(startEn), TRANS_CONCURRENCY, async (seg, j) => {
    const i = startEn + j
    const cn = await aiCall(AI2_BASE_URL, AI2_API_KEY, AI2_MODEL, TRANSLATE_PROMPT('para'), seg.content)
    transOut[i] = cn
    transDone++
    collectOrdered()
    const pct = 50 + Math.round(40 * transDone / Math.max(1, enNodes.length))
    writeProgressThrottled(slug, { stage: 'translating', message: `AI-2 翻译 ${transDone}/${enNodes.length}`, pct, node: 2 })
    onProgress?.({ stage: 'translating', pct })
    // 每 20 段存档一次：中途挂掉时重试只补剩下的段落，不重翻已完成的
    if (transDone % 20 === 0) await saveCheckpoint(slug, t.translated, `translating ${transDone}/${enNodes.length}`)
  })
  collectOrdered()
  fs.writeFileSync(tmpLocal.translated, JSON.stringify({ enItems, tables }), 'utf-8')
  // 表格并发翻译（有序 push）
  let tableDone = startTable
  const tableOut = new Array(tableNodes.length).fill(undefined)
  await mapLimit(tableNodes.slice(startTable), TRANS_CONCURRENCY, async (seg, j) => {
    tableOut[startTable + j] = await aiCall(AI2_BASE_URL, AI2_API_KEY, AI2_MODEL, TRANSLATE_PROMPT('table'), seg.content)
    tableDone++
    writeProgressThrottled(slug, { stage: 'translating', message: `AI-2 表格 ${tableDone}/${tableNodes.length}`, pct: 90, node: 2 })
  })
  for (let i = startTable; i < tableNodes.length; i++) {
    if (tableOut[i] === undefined) continue
    const seg = tableNodes[i]
    tables.push({ beforeIdx: seg.beforeIdx ?? 0, afterIdx: seg.afterIdx ?? 0, en: seg.content, cn: tableOut[i] })
  }
  // 表格译文也一起存档（否则重试会重翻表格）
  fs.writeFileSync(tmpLocal.translated, JSON.stringify({ enItems, tables }), 'utf-8')
  await saveCheckpoint(slug, t.translated, 'translating done')
  // 5. 组装
  await writeProgress(slug, { stage: 'assemble', message: '组装最终文件...', pct: 95, node: 3 })
  onProgress?.({ stage: 'assemble', pct: 95 })
  let out = ''
  // 输出格式必须与前端 parseAlignedMd 的语法严格一致：
  //   <!-- PARA en i/N --> / <!-- PARA cn i/N --> / <!-- TABLE between a and b --> / <!-- TABLE cn a-b --> / <!-- REF ALL -->
  // 旧代码写的是无编号 <!-- PARA_EN -->（且 cn 没有标记），前端解析出 0 个节点
  // → 阅读页"中英对照 / 全中文"只剩一句"翻译尚未生成"的警告，正文全部空白。
  const totalPara = enItems.length
  const tablesUsed = new Set()
  for (let i = 0; i < enItems.length; i++) {
    const p = enItems[i]
    const n = (typeof p.idx === 'number' && p.idx > 0) ? p.idx : i + 1
    out += `<!-- PARA en ${n}/${totalPara} -->\n${(p.en || '').trim()}\n\n`
    if (p.cn && p.cn.trim()) out += `<!-- PARA cn ${n}/${totalPara} -->\n${p.cn.trim()}\n\n`
    for (let ti = 0; ti < tables.length; ti++) {
      const t = tables[ti]
      if (t.beforeIdx !== n) continue
      tablesUsed.add(ti)
      out += `<!-- TABLE between ${t.beforeIdx} and ${t.afterIdx} -->\n${(t.en || '').trim()}\n\n`
      if (t.cn && t.cn.trim()) out += `<!-- TABLE cn ${t.beforeIdx}-${t.afterIdx} -->\n${t.cn.trim()}\n\n`
    }
  }
  // 兜底：beforeIdx 没对上任何段落的表格也要落盘，不能丢内容
  for (let ti = 0; ti < tables.length; ti++) {
    if (tablesUsed.has(ti)) continue
    const t = tables[ti]
    out += `<!-- TABLE between ${t.beforeIdx} and ${t.afterIdx} -->\n${(t.en || '').trim()}\n\n`
    if (t.cn && t.cn.trim()) out += `<!-- TABLE cn ${t.beforeIdx}-${t.afterIdx} -->\n${t.cn.trim()}\n\n`
  }
  if (parsed.refContent) out += `<!-- REF ALL -->\n${parsed.refContent.trim()}\n`
  const alignedMd = out.trim() + '\n'
  if (enItems.length === 0) {
    throw new Error('组装阶段发现 0 条翻译（enItems=0），拒绝写入空白 ' + `${slug}.md` + '。请重跑本任务。')
  }
  const alignedRel = `literatures/${slug}/${slug}.md`
  fs.writeFileSync(path.join(REPO_ROOT, alignedRel), alignedMd, 'utf-8')
  // 6. 清理 tmp
  for (const f of Object.values(tmpLocal)) { try { if (fs.existsSync(f)) fs.unlinkSync(f) } catch {} }
  return { alignedMd, enItems }
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
    console.log(`  [resume] 已存档: ${plan.done.length ? plan.done.join(' → ') : '（无）'}；本次从「${plan.next}」开始`)

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
    await commitLocalFiles([
      'literatures/literatures.csv',
      `literatures/${slug}/full.md`,
      `literatures/${slug}/${slug}.md`,
      `literatures/${slug}/images`,
      `vocabulary/vocabulary.csv`,
      `literatures/${slug}/.progress.json`,
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
