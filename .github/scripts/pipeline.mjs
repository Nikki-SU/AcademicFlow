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

const { MINERU_API_TOKEN,
        AI1_BASE_URL, AI1_API_KEY, AI1_MODEL,
        AI2_BASE_URL, AI2_API_KEY, AI2_MODEL,
        GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env

// —— 统一入口预检：所有必需的 secrets 先过一遍，任何缺失立即 fail
//   设计原则：MinerU 要花 1-3 分钟，AI 预检 + GitHub token 检查放在最前面
//   任何 secrets 缺失都能在几秒钟内 fail，不白跑后续步骤
const _missing = []
if (!MINERU_API_TOKEN)    _missing.push('MINERU_API_TOKEN')
if (!AI1_BASE_URL)        _missing.push('AI1_BASE_URL')
if (!AI1_API_KEY)         _missing.push('AI1_API_KEY')
if (!AI1_MODEL)           _missing.push('AI1_MODEL')
if (!AI2_BASE_URL)        _missing.push('AI2_BASE_URL')
if (!AI2_API_KEY)         _missing.push('AI2_API_KEY')
if (!AI2_MODEL)           _missing.push('AI2_MODEL')
if (!GITHUB_TOKEN)        _missing.push('GITHUB_TOKEN')
if (!GITHUB_OWNER)        _missing.push('GITHUB_OWNER')
if (!GITHUB_REPO)         _missing.push('GITHUB_REPO')
if (_missing.length) {
  console.error(`❌ Missing ${_missing.length} required secrets: ${_missing.join(', ')}`)
  process.exit(1)
}
console.log(`✓ All ${_missing.length === 0 ? 10 : 10 - _missing.length} required secrets present (MINERU + AI1×3 + AI2×3 + GITHUB×3)`)

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

    const t0 = Date.now()
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 15_000)
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
        throw new Error(`${p.label} 连接超时（15s）—— 检查 baseUrl 是否正确`)
      }
      throw new Error(`${p.label} 预检失败: ${e.message}`)
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
    } catch (e) { if (e?.message?.includes('404')) { /* 文件不存在，正常情况 */ } else { console.warn(`  [ghWriteContents] non-404 error: ${e.message}`) } }
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
  const { execSync } = await import('node:child_process')
  const MAX_RETRY = 3
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
    execSync(`git push origin main --force-with-lease`, { cwd: REPO_ROOT, stdio: 'pipe' })
  }

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      run()
      return
    } catch (e) {
      // 清理可能遗留的 rebase
      try { execSync(`git rebase --abort`, { cwd: REPO_ROOT, stdio: 'pipe' }) } catch {}
      // force-with-lease 可能被拒绝（远程又变了），或者 commit 真出错了
      const stderr = e.stderr?.toString() || String(e)
      if (attempt < MAX_RETRY && (
        stderr.includes('force-with-lease') ||
        stderr.includes('non-fast-forward') ||
        stderr.includes('could not') ||
        stderr.includes('conflict')
      )) {
        console.warn(`  [commitLocalFiles] push attempt ${attempt} failed, retrying after ${attempt * 3}s...`)
        console.warn(`    reason: ${stderr.slice(0, 200)}`)
        await sleep(attempt * 3000)
      } else {
        console.error(`  [commitLocalFiles] push FAILED after ${attempt} attempt(s)`)
        console.error(`    reason: ${stderr.slice(0, 300)}`)
        throw e
      }
    }
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
  onProgress?.({ stage: 'mineru_upload', message: '上传 PDF...', pct: 15 })
  const putResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {},
    body: pdfBuf,
  })
  if (!putResp.ok) throw new Error(`OSS PUT: ${putResp.status} ${await putResp.text().catch(() => '')}`)

  // 3. 轮询 /extract-results/batch/{batch_id}
  //    v4 MineruFileState: waiting-file / pending / running / converting / done / failed / error
  onProgress?.({ stage: 'mineru_poll', message: '轮询转换状态...', pct: 20 })
  let fileResult = null
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000))
    const pollResp = await mineruRequest('GET', `/extract-results/batch/${batchId}`)
    const extracted = pollResp.data?.extract_result?.[0]
    if (!extracted) {
      onProgress?.({ stage: 'mineru_poll', message: `轮询中 (${i + 1}/60)... 等待解析结果`, pct: Math.min(50, 20 + Math.min(10, i)) })
      continue
    }
    const state = extracted.state
    const apiProgress = extracted.extract_progress
    // 用 MinerU API 返回的真实进度（0-100）映射到全局 pct 的 poll 区间 [20, 50]
    let pollPct
    if (apiProgress != null) {
      const clamped = Math.max(0, Math.min(100, apiProgress))
      pollPct = Math.min(50, 20 + Math.round(clamped * 0.3))  // API 0-100 → 全局 20-50
    } else {
      pollPct = Math.min(50, 20 + Math.min(10, i))  // fallback：按轮询次数
    }
    const msg = `轮询中 (${i + 1}/60)... state=${state}${apiProgress != null ? ` (MinerU ${apiProgress}%)` : ''}`
    onProgress?.({ stage: 'mineru_poll', message: msg, pct: pollPct })

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
  onProgress?.({ stage: 'mineru_download', message: '下载产物 zip...', pct: 48 })
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

  onProgress?.({ stage: 'mineru_download', message: '下载完成', pct: 50 })
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
      return j.choices[0].message.content
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

// ============================================================
// Post-Mineru 纯函数（同前端逻辑但 Runner 本地跑）
// ============================================================
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
  'review_count', 'sm2_interval', 'sm2_ease',
]

/** AI 返回 JSON 字符串解析，容错（常见 ```json ``` 包裹、trailing comma） */
function parseJsonArray(text) {
  if (!text) return null
  let t = text.trim()
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (m) t = m[1].trim()
  try { return JSON.parse(t) } catch { /* AI 返回的不是严格 JSON，继续尝试容错解析 */ }
  const arrStart = t.indexOf('[')
  const arrEnd = t.lastIndexOf(']')
  if (arrStart >= 0 && arrEnd > arrStart) {
    try { return JSON.parse(t.slice(arrStart, arrEnd + 1)) } catch { /* 容错也失败，返回 null */ }
  }
  return null
}

/** runWordsExtraction — AI-1 提取 + AI-2 核验 → vocabulary/vocabulary.csv */
async function runWordsExtraction(enItems, doi, slug) {
  if (!enItems?.length) return { extracted: 0, verified: 0, added: 0 }

  const tmpFile = path.join(REPO_ROOT, `literatures/${slug}/.tmp_words.json`)

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
    await writeProgress(slug, { stage: 'words_extract', message: 'AI-1 提取学术单词...', pct: 93})
    const allEn = enItems.map(p => p.en).join('\n\n')
    const raw = await aiCall(AI1_BASE_URL, AI1_API_KEY, AI1_MODEL, WORDS_EXTRACT_PROMPT, allEn)
    candidateWords = parseJsonArray(raw)
    if (!candidateWords?.length) {
      console.warn(`  [words] AI-1 返回空词汇列表, raw 前200: ${raw?.slice(0, 200)}`)
      return { extracted: 0, verified: 0, added: 0 }
    }
    fs.writeFileSync(tmpFile, JSON.stringify(candidateWords), 'utf-8')
    console.log(`  [words] AI-1 extracted ${candidateWords.length}`)
  }

  // 2. AI-2 核验
  await writeProgress(slug, { stage: 'words_verify', message: 'AI-2 核验学术单词...', pct: 95})
  const allEn = enItems.map(p => p.en).join('\n\n')
  const verifyUser = WORDS_VERIFY_PROMPT
    .replace('{{PARAGRAPHS}}', allEn.slice(0, 8000))
    .replace('{{CANDIDATES}}', JSON.stringify(candidateWords, null, 2))
  const rawV = await aiCall(AI2_BASE_URL, AI2_API_KEY, AI2_MODEL, verifyUser)
  const verified = parseJsonArray(rawV) || []
  console.log(`  [words] AI-2 verified ${verified.length}/${candidateWords.length}`)

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
      enc(r.sm2_interval), enc(r.sm2_ease),
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
// Prompt 1: 语义分段 + 清理 + 跨页拼接
// 输入：MinerU (或任何提取器) 的完整 Markdown
// 输出：JSON 数组 [{ "text": "...", "tag": "..." }, ...]
//   - tag 告诉流水线这段是什么类型
//   - 顺序严格等于原文阅读顺序
// ============================================================
const SEMANTIC_SEGMENT_PROMPT = `你是学术文献语义处理专家。下面是一段从 PDF 提取出来的 Markdown——来源不可知，可能是 MinerU、Marker、PyMuPDF、扫描 OCR 或任何期刊模板。

没有任何固定规则可以依赖。你必须完全凭语义和上下文做判断。

你的任务（一步完成所有）：

1. 去垃圾 — 直接丢弃以下内容：
   · 页眉：期刊标题/卷号/页码/作者缩写+页码（如 "Author et al. / J. Catalysis 2024"）
   · 页脚：版权声明、单独一行的 DOI footer、ISSN、网址、Published on 日期、单独成段的 Received/Accepted
   · 模板文字："Licence and permissions" / "Published by..." / "This article is licensed under..." / "© 2024 The Authors"
   · OCR 噪声：纯页码数字、页眉页脚重复文字、乱码
   判断原则：不携带实质学术信息 → 丢弃。宁可漏丢一条模板文字，也不要错丢正文。

2. 跨页同段拼接 — 两段其实是 PDF 分页切断的同一段时合并：上一段结尾在句子中间（没句号）、下一段开头小写、语义连贯。

3. 语义分段 — 按真正的语义段落切，不是按空行硬切：一个段落表达一个主题，空行可能是 PDF 提取器的噪声。

4. **检查并保留 Markdown 标题层级**
   原始 Markdown 里可能有 # / ## / ### / #### 标题。你要做两件事：
   
   (a) 确认标题是不是真的标题 — 检查它是否应该是标题：
       · 论文主标题 → # Title （正确，保留）
       · 章节标题（Introduction / Experimental / Results and Discussion / Conclusion）→ ## 编号+标题（如 ## 1. Introduction）（正确，保留）
       · 子章节标题（2.1 Catalyst Preparation / 3.2 Kinetic Analysis）→ ### 编号+标题（正确，保留）
       · 参考文献、致谢、附录标题 → ## 标题（正确，保留）
       · 正文段落 → 不应该有 # 前缀，去掉误加的 # （MinerU 有时把正文第一行误标成标题）
       · 页码、页眉、页脚里的 "1"、"J. Catal. 2024" → 不是标题，应该在第 1 步"去垃圾"中丢弃
   
   (b) 修正错误的标题层级 — 如果标题层级明显不对：
       · 论文主标题用了 ## 或 ### → 改成 #
       · 章节标题（Introduction 等）用了 # 或 #### → 改成 ##
       · 子章节标题用了 ## 或 #### → 改成 ###
   
   关键：**标题行本身就是格式标记**，它告诉读者这里是一个章节的开始。不要去掉 # 号，不要改变标题文字本身，只检查层级是否正确。

5. 给段落插标记（**只有正文段落/图片/表格/参考文献标题需要插标记**，Markdown 标题行不插——它本身就是标记）：

   <!-- PARA_EN -->     英文正文段落（需要翻译）
   <!-- PARA_CN -->     中文正文段落（需要翻译）
   <!-- IMG -->         图片引用 ![caption](path)（原样保留）
   <!-- TABLE -->       Markdown 表格（原样保留）
   <!-- REF_ALL -->     参考文献章节标题（References/Bibliography）

   · 标题行（# / ## / ###）**不插任何标记** — 标题本身就是段落分隔符
   · 论文元信息（标题/作者/单位/摘要/基金）、LaTeX 公式块 $$...$$、参考文献条目 —— 这些不要插标记，原样保留就行。

6. 严格约束：
   · 顺序绝对不能变 — 标记后段落顺序 = 原文阅读顺序
   · 文本绝对不能改 — 除了插标记行、丢弃垃圾、**修正标题层级**（只有标题层级可以改），不要改动任何原有文字、格式、LaTeX、图片路径、表格。标题的文字内容不能改，只能调整其 # 数量
   · 直接输出带标记的纯 Markdown — 不要 JSON，不要代码块包裹（不要 markdown code fence），不要任何解释文字

示例输出（注意：标题保留正确层级，只给需要翻译的段落/图片/表格插标记）：

# Catalytic Conversion of CO2 to Methanol and Dimethyl Ether

作者张三 李四 王五

摘要原文 ...

## 1. Introduction

<!-- PARA_EN -->
Catalytic conversion of CO2 has attracted significant attention...

<!-- PARA_EN -->
Various strategies have been proposed to address this challenge...

### 1.1. Background

<!-- PARA_EN -->
CO2 concentration in atmosphere continues to increase annually...

<!-- PARA_EN -->
这是第二段英文正文...

<!-- IMG -->
![Figure 1](images/img_001.png)

<!-- TABLE -->
| entry | type | params |
|-------|------|--------|

## References

[1] Author, J. Article title. Journal 2024, 5, 123-456.

## Acknowledgments

This work was supported by the National Science Foundation.

Markdown 原文：
"""
{{__DOCUMENT_PLACEHOLDER__}}
"""

现在输出带标记的纯 Markdown：`

// ============================================================
// 切分工具：按真实段落边界切 + 打包成 chunks（无重叠，零丢失零重复）
// 设计原则：
//   输入给 AI 的每个段落单元只出现在一个 chunk 里
//   切分边界永远在段落之间，不会切断段落
//   不依赖 AI 自觉"不要重复输出"——从输入层面杜绝重复
// ============================================================

/**
 * 把 Markdown 按"真实段落边界"切成段落单元数组。
 * 段落边界 = 连续两个或以上空行
 * 例外：
 *   - ``` 代码块：内部空行不算边界
 *   - | 开头的表格块：多行表格算一个段落单元
 *   - LaTeX $$...$$ 跨多行公式块：算一个段落单元
 *   - 图片行 ![...](...) 单独一个段落单元
 *   - HTML 注释标记行 <!-- XXX --> 单独一个段落单元
 *
 * 返回：[{ text: string, charCount: number }, ...]
 */
function splitIntoParagraphs(md) {
  if (!md) return []
  const lines = md.split('\n')
  const units = []
  let buf = []
  let inCodeFence = false
  let bufIsTable = false
  let bufIsFormula = false

  const flush = () => {
    if (!buf.length) return
    // 如果最后一个单元只有空行，跳过
    if (buf.every(l => !l.trim())) { buf = []; bufIsTable = false; bufIsFormula = false; return }
    const text = buf.join('\n').trim()
    if (text.length > 0) {
      units.push({ text, charCount: text.length })
    }
    buf = []
    bufIsTable = false
    bufIsFormula = false
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // ``` 代码块切换
    if (/^\s*```/.test(line)) {
      flush()
      inCodeFence = !inCodeFence
      buf.push(line)
      continue
    }
    if (inCodeFence) {
      buf.push(line)
      continue
    }

    // 空行 → 段落边界
    if (!line.trim()) {
      flush()
      continue
    }

    // HTML 注释标记行 → 独立单元
    if (/^\s*<!--.*-->\s*$/.test(line)) {
      flush()
      buf.push(line)
      flush()
      continue
    }

    // 表格行 |...| → 连续表格合并
    if (/^\s*\|/.test(line)) {
      if (!bufIsTable) { flush(); bufIsTable = true }
      buf.push(line)
      continue
    }
    // 之前是表格，现在不是 → 表格结束
    if (bufIsTable) { flush(); bufIsTable = false }

    // LaTeX $$...$$ 跨多行
    if (/^\s*\$\$\s*$/.test(line)) {
      // 独立 $$ 行 → 可能开始或结束公式块
      if (bufIsFormula) { buf.push(line); flush(); bufIsFormula = false; continue }
      else { flush(); bufIsFormula = true; buf.push(line); continue }
    }
    if (bufIsFormula) {
      buf.push(line)
      if (/\$\$/.test(line)) { flush(); bufIsFormula = false }
      continue
    }

    // 普通行
    buf.push(line)
  }
  // 代码块还没闭合？把残余 flush
  flush()
  return units
}

/**
 * 把段落单元数组打包成 chunks。
 * 每个 chunk 里的段落总字符数 ≤ maxChars，**但允许最后加一个段落让它略微超过**
 * （否则一个 3000 chars 的段落永远单独成一个 chunk 也没问题）
 *
 * 关键保证：每个段落单元只出现在一个 chunk 里 → 零重叠 → 零重复
 */
function packChunks(units, maxChars) {
  if (!units.length) return []
  const chunks = []
  let cur = []
  let curChars = 0

  for (const u of units) {
    // 如果当前 chunk 已经有内容，且加上这个段落会大幅超过 maxChars → 新开一个 chunk
    // "大幅"定义为 > maxChars * 1.3（允许小段落让 chunk 略超）
    if (cur.length > 0 && curChars + u.charCount > maxChars * 1.3) {
      chunks.push(cur)
      cur = []
      curChars = 0
    }
    cur.push(u)
    curChars += u.charCount
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

// 
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
    // 如果整个 buf 是 Markdown 标题行，不插 PARA_EN（在清空 buf 之前检查！）
    const isHeadingOnly = buf.length === 1 && /^#{1,6}\s/.test(buf[0])
    out.push(...buf); buf = []; bufTable = false
    if (nonEmpty > 0 && hasLetter && !isImgOnly && !isTableOnly && !isFormulaOnly && !isHeadingOnly) out.push('<!-- PARA_EN -->')
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
    if (imgMatch) { continue }
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
// runPostMineru —— AI 语义分段 + 每段流水线（打标 → 翻译 → 组装）
// 流程：MinerU → Markdown → AI 语义判别（去垃圾、跨页拼接、分段、打 tag）
//      → enumerate 编号 → 逐段翻译 → 按编号顺序组装
// ============================================================

async function runPostMineru(doi, markdown, slug, onProgress) {
  const t = {
    enumerated: `literatures/${slug}/.tmp_enumerated.md`,
    translated: `literatures/${slug}/.tmp_translated.json`,
  }
  const tmpLocal = {}
  for (const [k, rel] of Object.entries(t)) {
    tmpLocal[k] = path.join(REPO_ROOT, rel)
  }
  const exists = (p) => fs.existsSync(p)
  const read = (p) => exists(p) ? fs.readFileSync(p, 'utf-8') : ''
  const write = (p, c) => fs.writeFileSync(p, c, 'utf-8')

  // ============ Phase 1: AI 语义分段 + 清理 + 打标（续跑跳过） ============
  let skeletonMd = read(tmpLocal.enumerated)
  let parsed = null

  if (!skeletonMd) {
    await writeProgress(slug, { stage: 'ai1_clean', message: 'AI 语义分段 + 清理 + 打标...', pct: 51})
    onProgress?.({ stage: "ai1_clean", pct: 51 })

    // 按**真实段落边界**切 → 零重叠 → 零重复
    // 设计：每个段落单元只属于一个 chunk，从输入层面杜绝重复
    const BLOCK = 28000  // 每 chunk 建议不超过 ~28K chars（给 AI 留 max_tokens 余量）
    const paraUnits = splitIntoParagraphs(markdown)
    const chunksPacked = packChunks(paraUnits, BLOCK)
    const chunks = chunksPacked.map(pack => pack.map(u => u.text).join('\n\n'))

    // 日志：打印每个 chunk 的段落数和字符数
    console.log(`  [semantic] markdown=${markdown.length} chars, ${paraUnits.length} paragraph units -> ${chunks.length} chunks`)
    for (let i = 0; i < chunks.length; i++) {
      console.log(`    chunk ${i+1}: ${chunksPacked[i].length} paras, ${chunks[i].length} chars`)
    }

    // 每块 AI 返回带 <!-- TAG --> 注释的 Markdown，直接拼接
    let taggedMd = ""
    for (let ci = 0; ci < chunks.length; ci++) {
      const userMsg = SEMANTIC_SEGMENT_PROMPT.replace('{{__DOCUMENT_PLACEHOLDER__}}', chunks[ci])
      let raw
      try {
        raw = await aiCall(AI1_BASE_URL, AI1_API_KEY, AI1_MODEL,
          `You are a literature semantic expert. Output ONLY the marked Markdown as specified. No JSON, no code blocks, no extra text.`,
          userMsg)
      } catch (e) {
        console.warn(`  [semantic chunk ${ci+1}/${chunks.length}] AI failed: ${e.message?.slice(0,120)}`)
        continue
      }

      // 简单清理：去掉 AI 可能加的 markdown code fence 包裹
      let cleaned = raw.replace(/^```markdown?\s*/im, "").replace(/\s*```\s*$/m, "").trim()
      taggedMd += cleaned + "\n\n"

      // 统计本块标记（直接 grep 注释，人眼可查）
      const paraCount = (cleaned.match(/<!--\s*PARA_EN\s*-->/g) || []).length
      const imgCount = (cleaned.match(/<!--\s*IMG\s*-->/g) || []).length
      const tblCount = (cleaned.match(/<!--\s*TABLE\s*-->/g) || []).length
      const refCount = (cleaned.match(/<!--\s*REF_ALL\s*-->/g) || []).length
      console.log(`  [semantic chunk ${ci+1}/${chunks.length}] -> PARA=${paraCount} IMG=${imgCount} TABLE=${tblCount} REF=${refCount}`)

      const pct = 51 + Math.round((ci + 1) / chunks.length * 14)
      await writeProgress(slug, { stage: 'ai1_clean', message: `AI 语义分段中 (${ci+1}/${chunks.length})...`, pct})
      onProgress?.({ stage: "ai1_clean", pct })
      await new Promise(r => setTimeout(r, 300))
    }

    // 打印统计（直接 grep 注释标记，人眼可查）
    const totalPARA = (taggedMd.match(/<!--\s*PARA_EN\s*-->/g) || []).length
    const totalIMG = (taggedMd.match(/<!--\s*IMG\s*-->/g) || []).length
    const totalTABLE = (taggedMd.match(/<!--\s*TABLE\s*-->/g) || []).length
    const totalREF = (taggedMd.match(/<!--\s*REF_ALL\s*-->/g) || []).length
    console.log(`  ✓ semantic done: PARA=${totalPARA} IMG=${totalIMG} TABLE=${totalTABLE} REF=${totalREF}, md length=${taggedMd.length}`)

    // sanity check：AI 输出长度如果比输入短 50% 以上 → fail-fast
    // （之前只是 WARN，但 WARN 不阻断 → 用户拿到残缺文献却以为完成了）
    const paraUnitsWithContent = paraUnits.filter(u => u.charCount > 10).length
    const outputMarkers = (taggedMd.match(/<!--\s*(PARA_EN|IMG|TABLE|REF_ALL)\s*-->/g) || []).length
    const ratio = taggedMd.length / markdown.length
    console.log(`  [sanity] input=${paraUnitsWithContent} meaningful units, output_markers=${outputMarkers}, output_length=${taggedMd.length}/${markdown.length} (${(ratio*100).toFixed(0)}%)`)
    if (taggedMd.length < markdown.length * 0.5) {
      throw new Error(`AI semantic segmentation output is too short: ${taggedMd.length}/${markdown.length} chars (${(ratio*100).toFixed(0)}%). Likely lost content. Aborting.`)
    }

    // Enumerate（纯代码编号，不调 AI）+ 写续跑文件
    await writeProgress(slug, { stage: 'enumerate', message: '纯代码编号...', pct: 67})
    onProgress?.({ stage: "enumerate", pct: 67 })
    skeletonMd = enumerateTaggedMd(taggedMd)
    write(tmpLocal.enumerated, skeletonMd)
    parsed = parseAlignedMd(skeletonMd)
    console.log(`  ✓ enumerate ok, nodes=${parsed.nodes.length}`)
  } else {
    console.log('  [resume] semantic + enumerate 已完成，加载 skeleton')
    parsed = parseAlignedMd(skeletonMd)
  }

  // ============ Phase 2: 逐段翻译（续跑跳过已完成部分） ============
  const enNodes = parsed.nodes.filter(n => n.type === 'para' && /[A-Za-z]/.test(n.content))
  const tableNodes = parsed.nodes.filter(n => n.type === 'table')
  let enItems = [], tables = [], startEn = 0, startTable = 0

  if (exists(tmpLocal.translated)) {
    try {
      const resumeData = JSON.parse(read(tmpLocal.translated))
      enItems = resumeData.enItems || []
      tables = resumeData.tables || []
      startEn = enItems.length
      startTable = tables.length
      console.log(`  [resume] translate: ${enItems.length} paragraphs + ${tables.length} tables already done`)
    } catch {}
  }

  for (let i = startEn; i < enNodes.length; i++) {
    const seg = enNodes[i]
    const cn = await aiCall(AI2_BASE_URL, AI2_API_KEY, AI2_MODEL,
      `You are an academic translator. Translate the following English paragraph to Chinese in a scholarly tone. Output ONLY the translation.`,
      seg.content)
    enItems.push({ idx: seg.idx ?? i + 1, total: enNodes.length, en: seg.content, cn })

    const pct = 70 + Math.round(20 * i / Math.max(1, enNodes.length))
    await writeProgress(slug, { stage: 'translating', message: `AI-2 translating para ${i + 1}/${enNodes.length}`, pct})
    onProgress?.({ stage: 'translating', pct })

    if (enItems.length % 5 === 0) {
      write(tmpLocal.translated, JSON.stringify({ enItems, tables }))
    }
  }

  for (let i = startTable; i < tableNodes.length; i++) {
    const seg = tableNodes[i]
    const cn = await aiCall(AI2_BASE_URL, AI2_API_KEY, AI2_MODEL,
      `Translate the following Markdown table to Chinese. Keep the table format identical. Output ONLY the Markdown table.`,
      seg.content)
    tables.push({ beforeIdx: seg.beforeIdx ?? 0, afterIdx: seg.afterIdx ?? 0, en: seg.content, cn })

    await writeProgress(slug, { stage: 'translating', message: `AI-2 translating table ${i + 1}/${tableNodes.length}`, pct: 90})
    onProgress?.({ stage: 'translating', pct: 90 })
  }

  // ============ Phase 3: 按编号顺序组装最终 Markdown ============
  await writeProgress(slug, { stage: 'assemble', message: 'Assembling final markdown in order...', pct: 92})
  onProgress?.({ stage: 'assemble', pct: 92 })

  // 用 skeletonMd 作为骨架：遇到 PARA en X/Y 标记处插入翻译内容
  let out = ''
  const paraMap = new Map()
  for (const p of enItems) paraMap.set(p.idx, p)
  const tableList = tables.sort((a, b) => a.beforeIdx - b.beforeIdx)
  let tableIdx = 0

  const skeletonLines = skeletonMd.split('\n')
  for (const line of skeletonLines) {
    const paraMatch = line.match(/<!--\s*PARA\s+en\s+(\d+)\/(\d+)\s*-->/)
    if (paraMatch) {
      const idx = Number(paraMatch[1])
      const p = paraMap.get(idx)
      if (p) {
        out += `<!-- PARA en ${idx}/${enItems.length} -->\n${p.en}\n\n${p.cn}\n\n`
      }
      continue  // 跳过原标记和下一行原文（已在上面输出了 en）
    }
    const tableMatch = line.match(/<!--\s*TABLE\s+between\s+(\d+)\s+and\s+(\d+)\s*-->/)
    if (tableMatch) {
      const t = tableList[tableIdx++]
      if (t) out += `<!-- TABLE between ${t.beforeIdx} and ${t.afterIdx} -->\n${t.cn}\n\n`
      continue
    }
    if (/<!--\s*IMG\s+between/.test(line)) {
      out += line + '\n'
      continue
    }
    if (/<!--\s*REF\s+ALL/.test(line)) {
      continue  // REF_ALL 后用 parsed.refContent
    }
    out += line + '\n'
  }

  if (parsed.refContent) {
    out += `\n<!-- REF ALL -->\n${parsed.refContent}\n`
  }

  const alignedMd = out.trim() + '\n'

  // 清理续跑文件
  for (const f of Object.values(tmpLocal)) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f) } catch {}
  }

  return { alignedMd, enItems }
}


async function main() {
  const payload = JSON.parse(process.argv[2] || '{}')
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
  writeProgress(slug, { stage: 'queued', message: 'Pipeline 启动...', pct: 0}).catch(() => {})
  updateLocalCsvField(doi, 'md_status', 'converting')

  try {
    // 1. 本地读 PDF（checkout 后磁盘上应该有，但可能不在 repo 跟踪里）
    const pdfLocalPath = path.join(REPO_ROOT, pdf_path)
    if (!fs.existsSync(pdfLocalPath)) {
      // fallback：通过 GitHub API blob GET 读
      console.log(`  [pdf] 本地未找到，尝试 API 读取 ${pdf_path}`)
      try {
        const blobRes = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${pdf_path}`, null)
        if (blobRes?.encoding === 'base64' && blobRes.content) {
          if (blobRes.size > MAX_BLOB_SIZE) throw new Error(`PDF too large: ${blobRes.size} > 100MB`)
          fs.writeFileSync(pdfLocalPath, Buffer.from(blobRes.content, 'base64'))
        } else throw new Error('无法读取 PDF')
      } catch (e) {
        throw new Error(`PDF 不存在：${pdf_path} (本地和 API 都找不到): ${e.message}`)
      }
    }
    const pdfBuf = fs.readFileSync(pdfLocalPath)
    if (pdfBuf.length > MAX_BLOB_SIZE) {
      throw new Error(`PDF too large: ${pdfBuf.length} bytes > 100MB GitHub blob limit. 用户需手动裁剪或用 Git LFS.`)
    }
    console.log(`  ✓ PDF ${pdfBuf.length} bytes`)

    // 2. MinerU
    await writeProgress(slug, { stage: 'mineru_apply', message: 'MinerU 申请...', pct: 5})
    const mineru = await mineruConvert(pdfBuf, `${slug}.pdf`, (p) => writeProgress(slug, { ...p}))
    console.log(`  ✓ MinerU done, md length=${mineru.markdown.length}`)

    // ── 检查 B: MinerU 跑完后（可能花了好几分钟），用户可能删了文献 ──
    if (!(await checkLiteratureAlive(doi))) {
      console.log(`=== Pipeline ABORTED (文献已被删除) ===`)
      return
    }

    // 存 fulltext.md（本地写，commit 时 push）
    const fulltextLocal = path.join(REPO_ROOT, `literatures/${slug}/fulltext.md`)
    fs.writeFileSync(fulltextLocal, mineru.markdown, 'utf-8')

    // 3. Post-Mineru（本地跑 AI，结果存本地 —— 内部会写 ai1_clean → ai1_tag → enumerate → translating → assemble）
    const postResult = await runPostMineru(doi, mineru.markdown, slug, (p) => console.log(`  [post] ${p.stage} ${p.pct ?? ''}`))

    // 3.5 单词提取（AI-1 提取 + AI-2 核验 → vocabulary/vocabulary.csv，节点 3 的 words_extract / words_verify）
    try {
      const wres = await runWordsExtraction(postResult.enItems, doi, slug)
      console.log(`  ✓ Words: extracted=${wres.extracted}, verified=${wres.verified}, added=${wres.added}`)
    } catch (e) {
      // words 提取失败不阻断主流程（vocabulary 是学习辅助功能，不是核心产物）
      // 但要给用户明显信号：写一条 WARNING 级别的 progress，让前端在 UI 上能看到
      const wmsg = `⚠️ Words extraction skipped: ${e.message}`
      console.warn(`  ${wmsg}`)
      try { await writeProgress(slug, { stage: 'words_extract', message: wmsg, pct: 93, warning: true }) } catch {}
    }

    // 4. 提交所有变更到 GitHub（一次 git commit + push）
    await writeProgress(slug, { stage: 'commit', message: '提交到 GitHub...', pct: 98})
    await commitLocalFiles([
      'literatures/literatures.csv',
      `literatures/${slug}/fulltext.md`,
      `literatures/${slug}/${slug}.md`,
      `literatures/${slug}/images`,
      `vocabulary/vocabulary.csv`,
      `literatures/${slug}/.progress.json`,
    ], `[pipeline] convert ${slug}: ${title}`)

    // 4.5 写终态 stage=done（给前端 UI 最后一次进度反馈）
    await writeProgress(slug, { stage: 'done', message: '转换完成', pct: 100})

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
      await writeProgress(slug, {
        stage: 'failed', message: `失败: ${err.message}`,
        pct: 0, error: err.message || String(err),
      })
      await commitLocalFiles([
        'literatures/literatures.csv',
        `literatures/${slug}/.progress.json`,
      ], `[pipeline] ${slug} failed: ${err.message}`)
    } catch { console.warn('  [fail-safe] 写失败状态也失败了') }
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
