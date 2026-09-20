#!/usr/bin/env node
/**
 * AcademicFlow Book Pipeline — GitHub Actions Runner
 * ============================================================
 * 只做一件事：PDF → Markdown（MinerU），**不做任何 AI 处理**。
 * （文献那套 clean / tag / enumerate / translate / words 对图书全部不需要。）
 *
 * 分页策略：
 *   MinerU 单文件页数有上限，整本教材常常超。所以 PDF 页数 > SPLIT_THRESHOLD_PAGES
 *   时用 qpdf 按 CHUNK_PAGES 页切成若干段 → 一次 batch 提交给 MinerU →
 *   等所有段都 done 后按原顺序拼回整本。
 *   页数没过线就单段直传，不做任何切分。
 *
 * 触发：repository_dispatch event_type=book_convert
 *   payload: { book_id, title, pdf_path }
 *   book_id = 书名，同时也是 textbooks/ 下的目录名（阅读页按它定位）
 *
 * 产物：
 *   textbooks/{book_id}/content.md   整本正文（阅读页读它）
 *   textbooks/{book_id}/images/      MinerU 抽出的图片（md 里引用 images/xxx）
 *
 * 进度协议（stage 名与文献 pipeline 完全一致，前端进度条零改动）：
 *   textbooks/{book_id}/.progress.json     done 后删除
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const REPO_ROOT = process.cwd()

const MINERU_API = 'https://mineru.net/api/v4'
const MAX_BLOB_SIZE = 100 * 1024 * 1024

/** 超过这个页数才切分（MinerU 单文件页数上限约 200 页） */
const SPLIT_THRESHOLD_PAGES = 200
/** 切分粒度：每段 180 页 */
const CHUNK_PAGES = 180

const { MINERU_API_TOKEN, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env
if (!MINERU_API_TOKEN) { console.error('❌ MINERU_API_TOKEN not set'); process.exit(1) }
if (!GITHUB_OWNER || !GITHUB_REPO) { console.error('❌ GITHUB_OWNER / GITHUB_REPO not set'); process.exit(1) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ============================================================
// GitHub API（只用于写 .progress.json —— 产物走本地 git commit）
// ============================================================
async function ghApi(method, apiPath, body) {
  const init = {
    method,
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'academicflow-book-pipeline/1.0',
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
    const wait = 200 * Math.pow(2, attempt) + Math.floor(Math.random() * 500)
    console.log(`  [ghApi] ${resp.status} on ${method} ${apiPath}, retry ${attempt + 1}/${MAX_RETRY} in ${wait}ms`)
    await sleep(wait)
  }
}

const progressPath = (bookId) => `textbooks/${bookId}/.progress.json`

async function writeProgress(bookId, data) {
  const json = JSON.stringify({ ...data, updated_at: new Date().toISOString() }, null, 2)
  const filePath = progressPath(bookId)
  const b64 = Buffer.from(json, 'utf-8').toString('base64')
  // 409 = sha 过期（并发写），重取 sha 再来一次
  for (let attempt = 0; attempt < 2; attempt++) {
    let sha = null
    try {
      const existing = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(filePath)}`)
      sha = existing?.sha ?? null
    } catch { /* 404 当作不存在 */ }
    const body = { message: `progress: book ${data.stage}`, content: b64 }
    if (sha) body.sha = sha
    try {
      return await ghApi('PUT', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(filePath)}`, body)
    } catch (e) {
      if (attempt === 0 && String(e?.message).includes('409')) continue
      throw e
    }
  }
}

async function deleteProgress(bookId) {
  const filePath = progressPath(bookId)
  try {
    const existing = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(filePath)}`)
    if (!existing?.sha) return
    await ghApi('DELETE', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(filePath)}`, {
      message: 'progress done',
      sha: existing.sha,
    })
  } catch { /* 已经没了就算了 */ }
}

// ============================================================
// MinerU（Node fetch，无代理）
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
  // v4 统一响应：{ code, msg, data }，code !== 0 是业务错误
  if (typeof j === 'object' && j !== null && 'code' in j && j.code !== 0) {
    throw new Error(`MinerU ${method} ${urlPath} code=${j.code} msg=${j.msg || ''}`)
  }
  return j
}

/** 递归找目录下第一个 .md（正常情况 zip 里就叫 full.md，这里只是兜底） */
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

/**
 * 把若干段 PDF 一次性交给 MinerU 转换，返回每段的 markdown + 合并后的图片。
 * chunks: [{ name, buf }]，顺序即最终拼接顺序。
 */
async function mineruConvertBatch(chunks, onProgress) {
  for (const c of chunks) {
    if (c.buf.length > MAX_BLOB_SIZE) {
      throw new Error(`分段 ${c.name} 体积 ${c.buf.length} 超过 100MB blob 硬限`)
    }
  }

  // 1. 一次 batch 申请所有段的上传 URL
  onProgress({ stage: 'mineru_apply', message: `申请上传 URL（共 ${chunks.length} 段）...`, pct: 5 })
  const applyResp = await mineruRequest('POST', '/file-urls/batch', {
    files: chunks.map((c) => ({ name: c.name, is_ocr: false })),
    model_version: 'pipeline',
    enable_formula: true,
    enable_table: true,
    language: 'auto',
  })
  const batchId = applyResp.data?.batch_id
  const urls = applyResp.data?.file_urls || []
  if (!batchId || urls.length !== chunks.length) {
    throw new Error(`MinerU 响应缺 batch_id / file_urls（要 ${chunks.length} 个，拿到 ${urls.length} 个）`)
  }
  console.log(`  [mineru] batch_id=${batchId}, chunks=${chunks.length}`)

  // 2. 逐段 PUT 到预签名 URL
  //    ⚠️ 不能带 Content-Type：OSS 预签名 URL 的 StringToSign 里它是空串，
  //    带了就 SignatureDoesNotMatch(403)。所以显式传 headers: {}。
  for (let i = 0; i < chunks.length; i++) {
    onProgress({
      stage: 'mineru_upload',
      message: `上传第 ${i + 1}/${chunks.length} 段...`,
      pct: 10 + Math.round((i / chunks.length) * 15),
    })
    const putResp = await fetch(urls[i], { method: 'PUT', headers: {}, body: chunks[i].buf })
    if (!putResp.ok) {
      throw new Error(`分段 ${i + 1} OSS PUT: ${putResp.status} ${await putResp.text().catch(() => '')}`)
    }
  }

  // 3. 轮询，等所有段 done
  //    整本书比单篇慢得多：5s × 120 轮 = 最长 10 分钟
  const MAX_ROUNDS = 120
  const results = new Array(chunks.length).fill(null)
  for (let round = 0; round < MAX_ROUNDS; round++) {
    await sleep(5000)
    const pollResp = await mineruRequest('GET', `/extract-results/batch/${batchId}`)
    const list = pollResp.data?.extract_result || []
    for (const r of list) {
      // 正常情况下 extract_result 与请求的 files 同序；名字对得上就更稳
      let idx = chunks.findIndex((c) => c.name === r.file_name)
      if (idx < 0) idx = list.indexOf(r)
      if (idx < 0 || idx >= chunks.length) continue
      if (r.state === 'done') {
        results[idx] = r
      } else if (r.state === 'failed' || r.state === 'error') {
        throw new Error(`第 ${idx + 1} 段 MinerU ${r.state}: ${r.err_msg || '无错误详情'}`)
      }
    }
    const doneCount = results.filter(Boolean).length
    onProgress({
      stage: 'mineru_poll',
      message: `MinerU 解析中（${doneCount}/${chunks.length} 段完成）...`,
      pct: 30 + Math.round((doneCount / chunks.length) * 40),
    })
    if (doneCount === chunks.length) break
  }
  const stalled = results.findIndex((r) => !r)
  if (stalled >= 0) {
    throw new Error(`MinerU 轮询超时：第 ${stalled + 1}/${chunks.length} 段未完成`)
  }

  // 4. 逐段下载 zip → 取 md + 图片
  const markdowns = []
  const images = new Map()
  for (let i = 0; i < chunks.length; i++) {
    onProgress({
      stage: 'mineru_download',
      message: `下载第 ${i + 1}/${chunks.length} 段产物...`,
      pct: 75 + Math.round((i / chunks.length) * 20),
    })
    const r = results[i]
    if (!r.full_zip_url) throw new Error(`第 ${i + 1} 段 state=done 但没有 full_zip_url`)

    const zipResp = await fetch(r.full_zip_url)
    if (!zipResp.ok) throw new Error(`下载第 ${i + 1} 段 zip: ${zipResp.status}`)
    const zipBuf = Buffer.from(await zipResp.arrayBuffer())

    const tmpDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp_book_'))
    try {
      const zipPath = path.join(tmpDir, 'result.zip')
      fs.writeFileSync(zipPath, zipBuf)
      execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { stdio: 'pipe' })

      const fullMdPath = path.join(tmpDir, 'full.md')
      const mdFile = fs.existsSync(fullMdPath) ? fullMdPath : findFirstMd(tmpDir)
      if (!mdFile) throw new Error(`第 ${i + 1} 段 zip 里没找到 .md`)
      markdowns.push(fs.readFileSync(mdFile, 'utf-8'))

      const imgDir = path.join(tmpDir, 'images')
      if (fs.existsSync(imgDir)) {
        for (const f of fs.readdirSync(imgDir)) {
          try { images.set(f, fs.readFileSync(path.join(imgDir, f))) } catch (e) {
            console.warn(`  [mineru] 第 ${i + 1} 段图片读取失败 ${f}: ${e.message}`)
          }
        }
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    }
  }

  return { markdowns, images }
}

// ============================================================
// PDF 页数 / 切分（qpdf）
// ============================================================
function pdfPageCount(pdfLocalPath) {
  try {
    const out = execSync(`qpdf --show-npages "${pdfLocalPath}"`, { stdio: 'pipe' }).toString().trim()
    return parseInt(out, 10) || 0
  } catch (e) {
    console.warn(`  [split] qpdf 读页数失败（${String(e.message).slice(0, 120)}），按单段处理`)
    return 0
  }
}

/** 把 PDF 按 chunkPages 切成多段，返回 [{ name, buf }]（顺序即页码顺序） */
function splitPdf(pdfLocalPath, baseName, chunkPages) {
  const total = pdfPageCount(pdfLocalPath)
  if (total <= SPLIT_THRESHOLD_PAGES) {
    console.log(`  [split] 共 ${total || '未知'} 页 ≤ ${SPLIT_THRESHOLD_PAGES}，不切分`)
    return [{ name: baseName, buf: fs.readFileSync(pdfLocalPath) }]
  }

  const workDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp_book_split_'))
  const chunks = []
  try {
    const n = Math.ceil(total / chunkPages)
    console.log(`  [split] 共 ${total} 页 → 按 ${chunkPages} 页切 ${n} 段`)
    for (let i = 0; i < n; i++) {
      const from = i * chunkPages + 1
      const to = Math.min((i + 1) * chunkPages, total)
      const outPath = path.join(workDir, `part-${String(i + 1).padStart(2, '0')}.pdf`)
      // --empty 保证输出只含选中的页
      execSync(`qpdf --empty --pages "${pdfLocalPath}" ${from}-${to} -- "${outPath}"`, { stdio: 'pipe' })
      chunks.push({
        name: `${baseName.replace(/\.pdf$/i, '')}-part${String(i + 1).padStart(2, '0')}.pdf`,
        buf: fs.readFileSync(outPath),
      })
    }
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {}
  }
  return chunks
}

// ============================================================
// 提交产物（git commit + push）
// ============================================================
async function commitLocalFiles(fileRelPaths, message) {
  // 与文献 pipeline 同一套：先 fetch + reset --soft 把本地 commit 压平成工作区改动，
  // 再只 add 指定文件后 push。前端会持续把 background_tasks.csv 写回 main，
  // 所以 push 可能撞车，这里按"远程前进"的签名重试。
  const MAX_RETRY = 10
  const run = () => {
    execSync(`git fetch origin main`, { cwd: REPO_ROOT, stdio: 'pipe' })
    execSync(`git reset --soft origin/main`, { cwd: REPO_ROOT, stdio: 'pipe' })
    try { execSync(`git reset`, { cwd: REPO_ROOT, stdio: 'pipe' }) } catch {}
    for (const p of fileRelPaths) {
      try { execSync(`git add -- "${p}"`, { cwd: REPO_ROOT, stdio: 'pipe' }) } catch {}
    }
    try {
      execSync(`git commit -m "${message.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { cwd: REPO_ROOT, stdio: 'pipe' })
    } catch (e) {
      if (e.stdout?.toString().includes('nothing to commit')) return
      throw e
    }
    const remoteSha = execSync(`git rev-parse refs/remotes/origin/main`, { cwd: REPO_ROOT, stdio: 'pipe' }).toString().trim()
    execSync(`git push origin main --force-with-lease=main:${remoteSha}`, { cwd: REPO_ROOT, stdio: 'pipe' })
  }

  const REJECTION_MARKERS = [
    'cannot lock ref', 'remote rejected', 'stale info',
    'non-fast-forward', 'fetch first', 'failed to push some refs', 'but expected',
  ]

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      run()
      if (attempt > 1) console.log(`  [commit] push ok after ${attempt} attempts`)
      return
    } catch (e) {
      const stderr = e.stderr?.toString() || String(e)
      const isRace = REJECTION_MARKERS.some((m) => stderr.includes(m))
      if (attempt < MAX_RETRY && isRace) {
        const base = Math.min(2000 * 2 ** (attempt - 1), 30000)
        const delay = Math.round(base * (0.5 + Math.random()))
        console.warn(`  [commit] remote moved, retry ${attempt}/${MAX_RETRY} in ${delay}ms`)
        await sleep(delay)
      } else {
        console.error(`  [commit] push FAILED after ${attempt} attempt(s): ${stderr.slice(0, 300)}`)
        throw e
      }
    }
  }
}

/** 从 checkout 或 GitHub API 读源 PDF（前端上传的路径可能不在本地） */
async function readSourcePdf(pdfPath) {
  const localPath = path.join(REPO_ROOT, pdfPath)
  if (fs.existsSync(localPath)) return { resolvedPath: pdfPath, buf: fs.readFileSync(localPath) }

  console.log(`  [pdf] 本地未找到，尝试 API 读取 ${pdfPath}`)
  const res = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(pdfPath)}`)
  if (res?.encoding === 'base64' && res.content) {
    if (res.size > MAX_BLOB_SIZE) throw new Error(`PDF 过大：${res.size} > 100MB`)
    fs.mkdirSync(path.dirname(localPath), { recursive: true })
    const buf = Buffer.from(res.content, 'base64')
    fs.writeFileSync(localPath, buf)
    return { resolvedPath: pdfPath, buf }
  }
  throw new Error(`PDF 读取失败：${pdfPath}`)
}

// ============================================================
// 主入口
// ============================================================
async function main() {
  const payload = JSON.parse(process.argv[2] || process.env.PIPELINE_PAYLOAD || '{}') || {}
  const { book_id, title, pdf_path } = payload
  if (!book_id || !pdf_path) {
    console.error('❌ 需要 book_id 和 pdf_path')
    process.exit(1)
  }

  console.log(`=== Book pipeline start ===`)
  console.log(`  book_id: ${book_id}`)
  console.log(`  pdf: ${pdf_path}`)

  const bookDirRel = `textbooks/${book_id}`
  const bookDirLocal = path.join(REPO_ROOT, bookDirRel)
  fs.mkdirSync(bookDirLocal, { recursive: true })

  await writeProgress(book_id, { stage: 'queued', message: '任务启动...', pct: 0, node: 0 }).catch(() => {})

  try {
    // 1. 读源 PDF
    const { buf: pdfBuf } = await readSourcePdf(pdf_path)
    console.log(`  ✓ PDF ${pdfBuf.length} bytes`)

    // 2. 按页切分（不超过阈值就是单段）
    const baseName = path.basename(pdf_path)
    const tmpPdf = path.join(bookDirLocal, `.tmp_${baseName}`)
    fs.writeFileSync(tmpPdf, pdfBuf)
    let chunks
    try {
      chunks = splitPdf(tmpPdf, baseName, CHUNK_PAGES)
    } finally {
      try { fs.unlinkSync(tmpPdf) } catch {}
    }
    console.log(`  ✓ 待转换 ${chunks.length} 段`)

    // 3. MinerU（唯一的重活）
    const { markdowns, images } = await mineruConvertBatch(chunks, (p) => {
      writeProgress(book_id, { ...p, node: 0 }).catch(() => {})
    })

    // 4. 按原顺序拼成整本
    const merged = markdowns
      .map((md) => md.trim())
      .filter(Boolean)
      .join('\n\n')
    if (!merged) throw new Error('MinerU 返回的 markdown 为空')
    console.log(`  ✓ 合并完成，content.md ${merged.length} chars`)

    // 5. 落盘 content.md + images/
    const contentRel = `${bookDirRel}/content.md`
    fs.mkdirSync(bookDirLocal, { recursive: true })
    fs.writeFileSync(path.join(REPO_ROOT, contentRel), merged, 'utf-8')
    if (images.size > 0) {
      const imgDir = path.join(bookDirLocal, 'images')
      fs.mkdirSync(imgDir, { recursive: true })
      for (const [name, buf] of images) fs.writeFileSync(path.join(imgDir, name), buf)
      console.log(`  ✓ 复制图片 ${images.size} 张`)
    }

    // 6. 提交（content.md + images + 清掉 progress.json）
    await writeProgress(book_id, { stage: 'commit', message: '提交到 GitHub...', pct: 98, node: 0 })
    const commitPaths = [contentRel]
    if (images.size > 0) commitPaths.push(`${bookDirRel}/images`)
    await commitLocalFiles(commitPaths, `[book] convert ${book_id}`)

    // 7. 终态：先写 done 让前端看到，再删掉 progress
    await writeProgress(book_id, { stage: 'done', message: '转换完成', pct: 100, node: 0 })
    try { fs.unlinkSync(path.join(REPO_ROOT, progressPath(book_id))) } catch {}
    await deleteProgress(book_id)

    console.log(`=== Book pipeline done ===`)
  } catch (err) {
    console.error(`❌ Book pipeline failed:`, err.message || err)
    try {
      await writeProgress(book_id, {
        stage: 'failed',
        message: `失败: ${err.message}`,
        pct: 0,
        node: 0,
        error: err.message || String(err),
      })
    } catch { console.warn('  [fail-safe] 写失败状态也失败了') }
    process.exit(1)
  }
}

main()
