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
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const url = `https://api.github.com${apiPath}`
  const resp = await fetch(url, init)
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    throw new Error(`GitHub ${method} ${apiPath}: ${resp.status} ${txt.slice(0, 300)}`)
  }
  if (resp.status === 204) return null
  return resp.json()
}

// 写小文件（≤ MAX_CONTENTS_SIZE）用 Contents PUT
async function ghWriteContents(filePath, content, message) {
  const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf-8') : content.length
  if (bytes > MAX_CONTENTS_SIZE) {
    throw new Error(`ghWriteContents fail: ${filePath} is ${bytes} bytes > MAX_CONTENTS_SIZE (${MAX_CONTENTS_SIZE}). Use blob path instead.`)
  }
  const b64 = Buffer.isBuffer(content) ? content.toString('base64') : Buffer.from(content, 'utf-8').toString('base64')
  let sha = null
  try {
    const existing = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`)
    sha = existing?.sha ?? null
  } catch {} // 404 就当不存在
  const body = { message, content: b64 }
  if (sha) body.sha = sha
  return ghApi('PUT', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`, body)
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
  // 用 git commit + push，这比单独 blob+tree transactions 更高效
  const { execSync } = await import('node:child_process')
  // 只 add 变更的文件
  for (const p of fileRelPaths) {
    try { execSync(`git add "${p}"`, { cwd: REPO_ROOT, stdio: 'pipe' }) } catch {}
  }
  try { execSync(`git status --porcelain`, { cwd: REPO_ROOT, stdio: 'pipe' }).toString() } catch {}
  try {
    execSync(`git commit -m "${message.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { cwd: REPO_ROOT, stdio: 'pipe' })
  } catch (e) {
    // 没有变更（exit 1 with "nothing to commit"）就跳过
    if (!e.stdout?.toString().includes('nothing to commit')) throw e
  }
  execSync(`git push origin main`, { cwd: REPO_ROOT, stdio: 'pipe' })
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
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const resp = await fetch(`${MINERU_API}${urlPath}`, init)
  const txt = await resp.text()
  if (!resp.ok) throw new Error(`MinerU ${method} ${urlPath}: ${resp.status} ${txt.slice(0, 300)}`)
  if (!txt) return null
  return JSON.parse(txt)
}

async function mineruConvert(pdfBuf, fileName, onProgress) {
  // size check
  if (pdfBuf.length > MAX_BLOB_SIZE) {
    throw new Error(`MinerU PDF too large: ${pdfBuf.length} bytes > 100MB blob limit. Cannot process.`)
  }
  // 1. 申请上传 URL
  onProgress?.({ stage: 'mineru_apply', message: '申请上传 URL...', pct: 5 })
  const urlResp = await mineruRequest('POST', '/file-urls/batch', [
    { file_name: fileName, is_ocr: false, is_table: true, is_formula: true, is_figure: true, is_layout: true, version: 'v2.0.0' },
  ])
  const uploadUrl = urlResp?.[0]?.url
  if (!uploadUrl) throw new Error(`MinerU 上传 URL 失败: ${JSON.stringify(urlResp).slice(0, 300)}`)
  // 2. PUT PDF
  onProgress?.({ stage: 'mineru_upload', message: '上传 PDF...', pct: 25 })
  const putResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: pdfBuf,
  })
  if (!putResp.ok) throw new Error(`OSS PUT: ${putResp.status}`)
  // 3. 轮询
  const fileId = urlResp[0].file_id
  onProgress?.({ stage: 'mineru_poll', message: '轮询转换状态...', pct: 40 })
  let result = null
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000))
    const task = await mineruRequest('GET', `/task/${fileId}`)
    const status = task?.task_status || task?.status
    onProgress?.({ stage: 'mineru_poll', message: `轮询中 (${i + 1}/60)... status=${status}`, pct: 40 + Math.min(45, i) })
    if (status === 'success' || status === 'done') { result = task; break }
    if (status === 'failed' || status === 'error') throw new Error(`MinerU task failed: ${JSON.stringify(task).slice(0, 500)}`)
  }
  if (!result) throw new Error('MinerU 60 轮轮询超时')
  // 4. 下载 fulltext.md
  onProgress?.({ stage: 'mineru_download', message: '下载 fulltext.md...', pct: 90 })
  const mdUrl = result.result?.pdf_md?.url || result.md_url
  if (!mdUrl) throw new Error(`MinerU 无 md URL: ${JSON.stringify(result).slice(0, 500)}`)
  const mdResp = await fetch(mdUrl)
  if (!mdResp.ok) throw new Error(`下载 md: ${mdResp.status}`)
  const markdown = await mdResp.text()
  // 5. 下载图片
  const resultData = result.result || {}
  const images = resultData.images || []
  onProgress?.({ stage: 'mineru_download', message: `下载图片 ${images.length} 张...`, pct: 95 })
  if (images.length) {
    const slug = fileName.replace('.pdf', '')
    const imgLocalDir = path.join(REPO_ROOT, `literatures/${slug}/images`)
    fs.mkdirSync(imgLocalDir, { recursive: true })
    for (const img of images) {
      if (!img.url) continue
      try {
        const r = await fetch(img.url)
        if (!r.ok) continue
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length > MAX_BLOB_SIZE) {
          console.warn(`  [mineru] 图片跳过：${img.url} size=${buf.length} > 100MB`)
          continue
        }
        const saveName = img.name || img.url.split('/').pop() || `img-${Date.now()}.png`
        fs.writeFileSync(path.join(imgLocalDir, saveName), buf)
      } catch (e) {
        console.warn(`  [mineru] 图片下载失败: ${img.url} → ${e.message}`)
      }
    }
  }
  onProgress?.({ stage: 'mineru_download', message: '下载完成', pct: 100 })
  return { markdown, fileName }
}

// ============================================================
// AI 调用
// ============================================================
async function aiCall(baseUrl, apiKey, model, system, user, signal) {
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
    signal,
  })
  if (!resp.ok) {
    const t = await resp.text().catch(() => '')
    throw new Error(`AI ${baseUrl} ${model}: ${resp.status} ${t.slice(0, 300)}`)
  }
  const j = await resp.json()
  return j.choices[0].message.content
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
  for (const line of lines) {
    const paraMatch = line.match(/<!--\s*PARA\s+en\s+(\d+)\/(\d+)\s*-->/)
    if (paraMatch) { curPara = { idx: Number(paraMatch[1]), total: Number(paraMatch[2]), content: '' }; if (inRef) { refContent += '\n'; inRef = false }; continue }
    const imgMatch = line.match(/<!--\s*IMG\s+between\s+(\d+)\s+and\s+(\d+)\s*-->/)
    if (imgMatch) { continue } // imgs handled via tree
    const tableMatch = line.match(/<!--\s*TABLE\s+between\s+(\d+)\s+and\s+(\d+)\s*-->/)
    if (tableMatch) { inTable = true; tableBuf = []; tableStart = Number(tableMatch[1]); continue }
    if (/<!--\s*REF\s+ALL\s*-->/.test(line)) { inRef = true; continue }
    if (inTable) {
      if (/^\s*\|/.test(line)) { tableBuf.push(line); continue }
      else { if (tableBuf.length) { nodes.push({ type: 'table', beforeIdx: tableStart, afterIdx: tableStart + 1, content: tableBuf.join('\n').trim() }) }; inTable = false; tableBuf = [] }
    }
    if (inRef) { refContent += (refContent ? '\n' : '') + line; continue }
    if (curPara.idx > 0) { curPara.content += (curPara.content ? '\n' : '') + line; if (line.trim()) lastParaIdx = curPara.idx }
  }
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

  // 1. Clean
  let cleanMd = read(tmpLocal.cleaned)
  if (!cleanMd) {
    await writeProgress(slug, { stage: 'ai1_clean', message: 'AI-1 清理...', pct: 10, node: 1 })
    onProgress?.({ stage: 'ai1_clean', pct: 10 })
    cleanMd = await aiCall(AI1_BASE_URL, AI1_API_KEY, AI1_MODEL, CLEAN_PROMPT, markdown)
    cleanMd = cleanMd.replace(/<span[^>]*>.*?<\/span>/g, '').replace(/^\s*\n/gm, '').trim()
    write(tmpLocal.cleaned, cleanMd)
    console.log('  ✓ clean ok')
  } else {
    console.log('  [resume] skip clean')
    await writeProgress(slug, { stage: 'ai1_clean', message: '续跑：跳过 Clean', pct: 10, node: 1 })
  }
  // 2. Tag
  let taggedMd = read(tmpLocal.tagged)
  if (!taggedMd) {
    await writeProgress(slug, { stage: 'ai1_tag', message: 'AI-1 打标...', pct: 25, node: 1 })
    onProgress?.({ stage: 'ai1_tag', pct: 25 })
    taggedMd = await aiCall(AI1_BASE_URL, AI1_API_KEY, AI1_MODEL, TAG_PROMPT, cleanMd)
    write(tmpLocal.tagged, taggedMd)
    console.log('  ✓ tag ok')
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
    write(tmpLocal.enumerated, skeletonMd)
    parsed = parseAlignedMd(skeletonMd)
    console.log('  ✓ enumerate ok, nodes=', parsed.nodes.length)
  } else {
    console.log('  [resume] skip enumerate')
    parsed = parseAlignedMd(skeletonMd)
    await writeProgress(slug, { stage: 'enumerate', message: '续跑：跳过 Enumerate', pct: 40, node: 1 })
  }
  // 4. Translate
  const enNodes = parsed.nodes.filter(n => n.content && /[A-Za-z]/.test(n.content))
  const tableNodes = parsed.nodes.filter(n => n.type === 'table')
  let enItems = [], tables = [], startEn = 0, startTable = 0
  let resumeData = null
  if (exists(tmpLocal.translated)) {
    try { resumeData = JSON.parse(read(tmpLocal.translated)); enItems = resumeData.enItems || []; tables = resumeData.tables || []; startEn = enItems.length; startTable = tables.length } catch {}
    console.log(`  [resume] translate: ${enItems.length} segments done`)
  }
  for (let i = startEn; i < enNodes.length; i++) {
    const seg = enNodes[i]
    const cn = await aiCall(AI2_BASE_URL, AI2_API_KEY, AI2_MODEL, TRANSLATE_PROMPT('para'), seg.content)
    enItems.push({ idx: seg.idx ?? i + 1, total: enNodes.length, en: seg.content, cn })
    const pct = 50 + Math.round(40 * i / Math.max(1, enNodes.length))
    await writeProgress(slug, { stage: 'translating', message: `AI-2 翻译 ${i + 1}/${enNodes.length}`, pct, node: 2 })
    onProgress?.({ stage: 'translating', pct })
    if (enItems.length % 5 === 0) {
      fs.writeFileSync(tmpLocal.translated, JSON.stringify({ enItems, tables }), 'utf-8')
    }
  }
  for (let i = startTable; i < tableNodes.length; i++) {
    const seg = tableNodes[i]
    const cn = await aiCall(AI2_BASE_URL, AI2_API_KEY, AI2_MODEL, TRANSLATE_PROMPT('table'), seg.content)
    tables.push({ beforeIdx: seg.beforeIdx ?? 0, afterIdx: seg.afterIdx ?? 0, en: seg.content, cn })
    await writeProgress(slug, { stage: 'translating', message: `AI-2 表格 ${i + 1}/${tableNodes.length}`, pct: 90, node: 2 })
    onProgress?.({ stage: 'translating', pct: 90 })
  }
  // 5. 组装
  await writeProgress(slug, { stage: 'assemble', message: '组装最终文件...', pct: 95, node: 3 })
  onProgress?.({ stage: 'assemble', pct: 95 })
  let out = ''
  for (const p of enItems) { out += `<!-- PARA_EN -->\n${p.en}\n\n${p.cn}\n\n` }
  if (tables.length) { out += '\n---\n\n'; for (const t of tables) out += t.cn + '\n\n' }
  if (parsed.refContent) out += `\n<!-- REF_ALL -->\n${parsed.refContent}\n`
  const alignedMd = out.trim() + '\n'
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
// 主入口
// ============================================================
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

    // 3. Post-Mineru（本地跑 AI，结果存本地）
    await writeProgress(slug, { stage: 'clean', message: '开始 post-mineru...', pct: 15, node: 1 })
    const postResult = await runPostMineru(doi, mineru.markdown, slug, (p) => console.log(`  [post] ${p.stage} ${p.pct ?? ''}`))

    // 4. 提交所有变更到 GitHub（一次 git commit + push）
    await writeProgress(slug, { stage: 'commit', message: '提交到 GitHub...', pct: 98, node: 3 })
    await commitLocalFiles([
      'literatures/literatures.csv',
      `literatures/${slug}/fulltext.md`,
      `literatures/${slug}/${slug}.md`,
      `literatures/${slug}/images`,
      `literatures/${slug}/.progress.json`,
    ], `[pipeline] convert ${slug}: ${title}`)

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
