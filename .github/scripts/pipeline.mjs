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
const CLEAN_PROMPT = `你是文献整理专家。清理 PDF 提取文本：
1. 移除页眉页脚、页码、版权声明、期刊模板文字
2. 拼接被打断的段落（处理断词断句）
3. 保留图片占位 ![image] 但不描述
4. 保留 Markdown 表格
5. 保留 LaTeX 公式原样不动
6. 参考文献章节完整保留
7. 纯 Markdown 输出，不要代码块
直接输出清理后的内容。`

const TAG_PROMPT = `你是文献标注专家。任务：在 Markdown 上插入 HTML 注释标记。

严格规则（不遵守就是致命错误）：
1. 每个英文正文段落（至少含 5 个英文字母、独立成段）前必须插一行：<!-- PARA_EN -->
2. 每个图片引用 ![...](...) 前必须插一行：<!-- IMG -->
3. 每个 Markdown 表格（以 | 开头的行）前必须插一行：<!-- TABLE -->
4. 参考文献章节（标题含 References/Bibliography）前必须插一行：<!-- REF_ALL -->

关键约束：
- 只插上述标记，**绝对不能修改、删减、重组原 Markdown 的任何文字**
- 原有标题（# / ## / ###）、段落、图片、表格、公式的位置和内容完全不变
- 输出长度必须与输入长度基本一致（偏差不超过 5%，仅新增标记行）
- 如果跳过标记，你会导致整个文献翻译流水线崩溃 — 请务必标记每一个段落

直接输出带标记的完整 Markdown。`

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
  'review_count', 'sm2_interval', 'sm2_ease',
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
  }

  // 2. AI-2 核验
  await writeProgress(slug, { stage: 'words_verify', message: 'AI-2 核验学术单词...', pct: 50, node: 3 })
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
const SEMANTIC_SEGMENT_PROMPT = `你是学术文献语义处理专家。下面是一段从 PDF 提取出来的 Markdown 文本——来源不可知，可能是 MinerU、Marker、PyMuPDF，也可能是用户手动粘贴的扫描 OCR 结果，甚至可能来自任何学术期刊的任何模板格式。

没有任何固定规则可以依赖。你必须完全凭语义和上下文来做判断。

你的任务（所有要求一次性完成）：

## 1. 识别并丢弃非实质内容（去垃圾）
以下内容不属于论文正文，直接丢弃不要：
- 页眉：期刊标题、卷号、期号、页码、作者缩写+页码的页眉格式（如 \`Author et al. / J. Catalysis 2024\`）
- 页脚：版权声明、DOI footer（单独一行的 DOI）、ISSN 号、网址、Published on 日期、Received/Accepted 日期（如果单独成段且无其他内容）
- 模板文字："Licence and permissions" / "Published by..." / "This article is licensed under..." / "© 2024 The Authors" 等版权模板
- 扫描 PDF 的 OCR 噪声：页码数字、页眉页脚的重复文字、乱码

**判断原则：如果内容不携带论文的实质学术信息，就丢弃。** 宁可漏丢一条模板文字，也不要错丢一段正文。

## 2. 跨页同段拼接
如果两段文本实际上是同一个段落被 PDF 分页切断了，把它们合并成一段。判断依据：
- 上一段结尾在句子中间（没有句号、问号、感叹号）
- 下一段开头是小写字母（承接上一段的续行）
- 两段的语义明显连贯，中间没有新的主题切换

## 3. 语义分段（不是按空行切！）
Markdown 的空行不可靠——PDF 提取器可能在段落中间插入空行，也可能把多段挤在一个空行里。你必须按**真正的语义段落**来分割：
- 一个段落表达一个完整的主题
- 同一主题的多行文字合并为一段，即使中间有多余空行
- 不同主题之间（如段落 A 讲方法，段落 B 讲结果）分开

## 4. 给每一段打标签（tag）
完全凭内容理解来判断，不要依赖字符串匹配。可选 tag：

- \`PARA_EN\` — 英文正文段落（有实质学术内容的英文段落，需要翻译）
- \`PARA_CN\` — 中文正文段落（有实质学术内容的中文段落，需要翻译）
- \`HEADING\` — 章节标题（如 \`# Introduction\`, \`## Experimental\`，不翻译）
- \`IMG\` — 图片引用（\`![caption](path)\`，原样保留不翻译）
- \`TABLE\` — Markdown 表格（含 \`|\` 分隔线的表格，整体保留）
- \`FORMULA\` — LaTeX 公式块（独立成行的 \`$$...$$\` 或 \`\\begin{equation}...\`，原样保留）
- \`REF_HEADING\` — 参考文献章节标题（如 \`# References\`）
- \`REF_ENTRY\` — 单条参考文献内容
- \`META\` — 论文元信息：论文标题、作者姓名和单位、摘要、关键词、通讯作者信息、基金致谢、DOI（在标题下方的 DOI，不是页脚的）、图表标题 caption 等**论文自带的有意义的元信息**——全部保留

## 5. 严格约束
- **顺序绝对不能变**：你输出的数组顺序 = 原文的阅读顺序，一条都不能重排
- **文本完整保留**：text 字段里必须包含完整的原始 Markdown 格式——LaTeX \`$$\`、\`$...$\`、图片 \`![...](...)\`、表格 \`|...|\`、代码块都原样不动
- **JSON 格式**：严格 JSON 数组，不要三重反引号包裹（即 markdown code fence），不要任何解释文字。字符串里如果有双引号请用 \\" 转义

示例输出：
[
  { "text": "这里是论文标题原文", "tag": "META" },
  { "text": "这里是作者和单位原文", "tag": "META" },
  { "text": "## 1. Introduction", "tag": "HEADING" },
  { "text": "这是第一段英文正文...", "tag": "PARA_EN" },
  { "text": "![Figure 1](images/img_001.png)", "tag": "IMG" },
  { "text": "## References", "tag": "REF_HEADING" },
  { "text": "[1] Author, J. Article title. Journal 2024, 5, 123-456.", "tag": "REF_ENTRY" }
]

Markdown 原文：
"""
{{DOCUMENT}}
"""

现在请输出 JSON 数组：`

// ============================================================
// 辅助：解析 AI 返回的 JSON 数组（容错 ```json``` 包裹、截断等）
// ============================================================
function parseAiSegments(resp) {
  if (!resp) return []
  // 去 ```json ... ``` 包裹
  let s = resp.replace(/^```json?\s*/im, '').replace(/\s*```\s*$/m, '').trim()
  // 找第一个 [ ... ]
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  if (start === -1 || end === -1) return []
  s = s.substring(start, end + 1)
  try {
    return JSON.parse(s)
  } catch {
    // 截断了也能 parse — 去掉最后一个不完整元素
    for (let cut = s.length - 1; cut > 0; cut--) {
      const tryS = s.substring(0, cut) + ']'
      try { return JSON.parse(tryS) } catch {}
    }
    return []
  }
}

// ============================================================
// 辅助：纯代码层面的 enumerate / parse（不做 AI 调用，只处理标记）
// ============================================================
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

  // ============ Phase 1: AI 语义分段（续跑跳过） ============
  let skeletonMd = read(tmpLocal.enumerated)
  let parsed = null

  if (!skeletonMd) {
    await writeProgress(slug, { stage: 'ai1_clean', message: 'AI semantic segmentation...', pct: 5, node: 1 })
    onProgress?.({ stage: 'ai1_clean', pct: 5 })

    // 分块喂 AI：每块 ~25000 chars，块间 overlap 5000 chars（防段落被切断）
    const BLOCK = 25000, OVERLAP = 5000
    const chunks = []
    for (let i = 0; i < markdown.length; i += BLOCK - OVERLAP) {
      chunks.push(markdown.slice(i, Math.min(i + BLOCK, markdown.length)))
      if (i + BLOCK >= markdown.length) break
    }
    console.log(`  [semantic] markdown=${markdown.length} chars -> ${chunks.length} chunks`)

    const allSegments = []
    for (let ci = 0; ci < chunks.length; ci++) {
      const userMsg = SEMANTIC_SEGMENT_PROMPT.replace('{{DOCUMENT}}', chunks[ci])
      let raw
      try {
        raw = await aiCall(AI1_BASE_URL, AI1_API_KEY, AI1_MODEL,
          `You are a literature semantic segmentation expert. Output ONLY a valid JSON array as specified by the user. No extra text.`,
          userMsg)
      } catch (e) {
        console.warn(`  [semantic chunk ${ci+1}/${chunks.length}] AI failed: ${e.message?.slice(0,120)}`)
        continue
      }
      const segments = parseAiSegments(raw)
      console.log(`  [semantic chunk ${ci+1}/${chunks.length}] -> ${segments.length} segments`)
      for (const s of segments) {
        if (s.text && s.text.trim()) {
          allSegments.push({ text: s.text.trim(), tag: s.tag || 'PARA_EN' })
        }
      }

      const pct = 5 + Math.round((ci + 1) / chunks.length * 20)
      await writeProgress(slug, { stage: 'ai1_clean', message: `AI semantic seg (${ci+1}/${chunks.length})...`, pct, node: 1 })
      onProgress?.({ stage: 'ai1_clean', pct })
      await new Promise(r => setTimeout(r, 300))
    }

    const segments = allSegments
    const tagStats = {}
    for (const s of segments) tagStats[s.tag] = (tagStats[s.tag] || 0) + 1
    console.log(`  ✓ semantic done: ${segments.length} segments, tags=${JSON.stringify(tagStats)}`)

    // AI tag -> HTML comments
    const tagToComment = {
      PARA_EN: '<!-- PARA_EN -->',
      PARA_CN: '<!-- PARA_EN -->',
      IMG: '<!-- IMG -->',
      TABLE: '<!-- TABLE -->',
      REF_HEADING: '<!-- REF_ALL -->',
    }
    let taggedMd = ''
    for (const seg of segments) {
      const comment = tagToComment[seg.tag]
      if (comment) taggedMd += comment + '\n'
      taggedMd += seg.text + '\n\n'
    }

    // Enumerate (pure code) + write resume file
    await writeProgress(slug, { stage: 'enumerate', message: 'Code enumeration...', pct: 25, node: 1 })
    onProgress?.({ stage: 'enumerate', pct: 25 })
    skeletonMd = enumerateTaggedMd(taggedMd)
    write(tmpLocal.enumerated, skeletonMd)
    parsed = parseAlignedMd(skeletonMd)
    console.log(`  ✓ enumerate ok, nodes=${parsed.nodes.length}`)
  } else {
    console.log('  [resume] semantic + enumerate already done, loading skeleton')
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

    const pct = 30 + Math.round(55 * i / Math.max(1, enNodes.length))
    await writeProgress(slug, { stage: 'translating', message: `AI-2 translating para ${i + 1}/${enNodes.length}`, pct, node: 2 })
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

    await writeProgress(slug, { stage: 'translating', message: `AI-2 translating table ${i + 1}/${tableNodes.length}`, pct: 88, node: 2 })
    onProgress?.({ stage: 'translating', pct: 88 })
  }

  // ============ Phase 3: 按编号顺序组装最终 Markdown ============
  await writeProgress(slug, { stage: 'assemble', message: 'Assembling final markdown in order...', pct: 95, node: 3 })
  onProgress?.({ stage: 'assemble', pct: 95 })

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
  writeProgress(slug, { stage: 'queued', message: 'Pipeline 启动...', pct: 0, node: 0 }).catch(() => {})
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
    await writeProgress(slug, { stage: 'mineru_apply', message: 'MinerU 申请...', pct: 10, node: 0 })
    const mineru = await mineruConvert(pdfBuf, `${slug}.pdf`, (p) => writeProgress(slug, { ...p, node: 0 }))
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
      console.warn(`  ⚠️ Words extraction failed: ${e.message}`)
    }

    // 4. 提交所有变更到 GitHub（一次 git commit + push）
    await writeProgress(slug, { stage: 'commit', message: '提交到 GitHub...', pct: 98, node: 3 })
    await commitLocalFiles([
      'literatures/literatures.csv',
      `literatures/${slug}/fulltext.md`,
      `literatures/${slug}/${slug}.md`,
      `literatures/${slug}/images`,
      `vocabulary/vocabulary.csv`,
      `literatures/${slug}/.progress.json`,
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
      await writeProgress(slug, {
        stage: 'failed', message: `失败: ${err.message}`,
        pct: 0, node: 3, error: err.message || String(err),
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
