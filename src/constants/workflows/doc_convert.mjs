#!/usr/bin/env node
/**
 * AcademicFlow Doc Convert Pipeline — GitHub Actions Runner
 * ============================================================
 * 「其他文档」转换：把一份文档转成一篇 markdown，**不做任何 AI 处理**。
 *   Word(.doc / .docx) → PDF（LibreOffice headless）→ MinerU → markdown
 *   PDF                → 直接走 MinerU → markdown
 *
 * 与 book_convert 的区别：
 *   - book_convert 产出 textbooks/{book_id}/content.md（图书，通常整本很长）
 *   - doc_convert  产出 documents/{doc_id}/content.md（其他文档：讲义 / 报告 / 杂项）
 *   与 note_convert 的区别：note_convert 是「一篇对象的若干笔记」，产物在 {base_path}/notes/；
 *   doc_convert 是「一个独立文档」，产物在 documents/{doc_id}/ 根下的 content.md。
 *
 * Word → PDF 走 LibreOffice headless：串行、确定性、保真——内容/结构都以排版为准，
 * 不靠猜。转换失败即报可读错误，绝不静默降级成空文档（先约束、再容错）。
 *
 * 分页策略：MinerU 单文件页数有上限，长文档常超。PDF 页数 > SPLIT_THRESHOLD_PAGES
 *   时用 qpdf 按 CHUNK_PAGES 页切成若干段 → 一次 batch 提交给 MinerU →
 *   等所有段都 done 后按原顺序拼回整篇。页数没过线就单段直传，不做任何切分。
 *
 * 触发：repository_dispatch event_type=doc_convert
 *   payload: { doc_id, title, source_path }
 *     doc_id      = documents/ 下的目录名（前端生成、去重；同时也是阅读页定位键）
 *     title       = 文档标题（用于日志 / commit message）
 *     source_path = 前端上传到私库的源文件（documents/{doc_id}/source/{ts}_{文件名}）
 *
 * 产物：
 *   documents/{doc_id}/content.md   正文（阅读页读它）
 *   documents/{doc_id}/images/      MinerU 抽出的图片（md 里引用 images/xxx，相对 content.md）
 *
 * 进度协议（stage 名与文献 / 图书 pipeline 完全一致，前端进度条零改动）：
 *   documents/{doc_id}/.progress.json     done 后删除
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'

const REPO_ROOT = process.cwd()

const MINERU_API = 'https://mineru.net/api/v4'
const MAX_BLOB_SIZE = 100 * 1024 * 1024

/** 超过这个页数才切分（MinerU 单文件页数上限约 200 页） */
const SPLIT_THRESHOLD_PAGES = 200
/** 切分粒度：每段 180 页 */
const CHUNK_PAGES = 180

/** 支持的源文件类型：Word 先转 PDF，PDF 直接进 MinerU */
const WORD_EXT = /\.docx?$/i

const { MINERU_API_TOKEN, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env
if (!MINERU_API_TOKEN) { console.error('❌ MINERU_API_TOKEN not set'); process.exit(1) }
if (!GITHUB_OWNER || !GITHUB_REPO) { console.error('❌ GITHUB_OWNER / GITHUB_REPO not set'); process.exit(1) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ============================================================
// GitHub API（只用于读源文件 / 写 .progress.json —— 产物走本地 git commit）
// ============================================================
async function ghApi(method, apiPath, body) {
  const init = {
    method,
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'academicflow-doc-convert/1.0',
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

// ============================================================
// 进度文件
// ============================================================
let PROGRESS_PATH = ''

async function writeProgress(data) {
  if (!PROGRESS_PATH) return
  const json = JSON.stringify({ ...data, updated_at: new Date().toISOString() }, null, 2)
  const b64 = Buffer.from(json, 'utf-8').toString('base64')
  for (let attempt = 0; attempt < 2; attempt++) {
    let sha = null
    try {
      const existing = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(PROGRESS_PATH)}`)
      sha = existing?.sha ?? null
    } catch { /* 404 当作不存在 */ }
    const body = { message: `progress: doc convert ${data.stage}`, content: b64 }
    if (sha) body.sha = sha
    try {
      return await ghApi('PUT', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(PROGRESS_PATH)}`, body)
    } catch (e) {
      if (attempt === 0 && String(e?.message).includes('409')) continue
      throw e
    }
  }
}

async function deleteProgress() {
  if (!PROGRESS_PATH) return
  try {
    const existing = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(PROGRESS_PATH)}`)
    if (!existing?.sha) return
    await ghApi('DELETE', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(PROGRESS_PATH)}`, {
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
 * 图片在 md 里保持相对引用 `images/xxx`（阅读页按 documents/{doc_id}/ 作基准解析）。
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

  // 3. 轮询，等所有段 done（5s × 120 轮 = 最长 10 分钟）
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
  //    图片重命名加全局序号，避免多段同名互相覆盖；md 里的 `images/xxx` 引用同步改名。
  const markdowns = []
  const images = new Map()
  let imgSeq = 0
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

    const tmpDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp_doc_zip_'))
    try {
      const zipPath = path.join(tmpDir, 'result.zip')
      fs.writeFileSync(zipPath, zipBuf)
      execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { stdio: 'pipe' })

      const fullMdPath = path.join(tmpDir, 'full.md')
      const mdFile = fs.existsSync(fullMdPath) ? fullMdPath : findFirstMd(tmpDir)
      if (!mdFile) throw new Error(`第 ${i + 1} 段 zip 里没找到 .md`)
      let md = fs.readFileSync(mdFile, 'utf-8')

      const imgDir = path.join(tmpDir, 'images')
      if (fs.existsSync(imgDir)) {
        for (const f of fs.readdirSync(imgDir)) {
          const newName = `img${String(++imgSeq).padStart(3, '0')}_${f}`
          try {
            images.set(newName, fs.readFileSync(path.join(imgDir, f)))
            md = md.split(`images/${f}`).join(`images/${newName}`)
          } catch (e) {
            console.warn(`  [mineru] 第 ${i + 1} 段图片读取失败 ${f}: ${e.message}`)
          }
        }
      }
      markdowns.push(md)
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

  const workDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp_doc_split_'))
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
// Word → PDF（LibreOffice headless）
// ============================================================
/**
 * 用 LibreOffice 把 Word 转成 PDF，返回生成的 PDF 本地路径。
 * 失败（无产物）直接抛错——不返回空、不静默降级。
 */
function wordToPdf(srcLocalPath, outDir) {
  // 独立的 UserInstallation profile：避免 headless 首次运行时因默认 profile 被占用而卡住
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo_profile_'))
  try {
    execSync(
      `soffice --headless --norestore --invisible --nologo ` +
      `-env:UserInstallation=file://${profileDir} ` +
      `--convert-to pdf --outdir "${outDir}" "${srcLocalPath}"`,
      { stdio: 'pipe', timeout: 5 * 60 * 1000 },
    )
  } finally {
    try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch {}
  }
  const stem = path.basename(srcLocalPath).replace(/\.[^.]+$/, '')
  const outPath = path.join(outDir, `${stem}.pdf`)
  if (!fs.existsSync(outPath)) {
    throw new Error('LibreOffice 未能把 Word 转成 PDF（文件可能损坏或格式不受支持）')
  }
  return outPath
}

// ============================================================
// 提交产物（git commit + push）
// ============================================================
async function commitLocalFiles(fileRelPaths, message) {
  // 与文献 / 图书 pipeline 同一套：先 fetch + reset --soft 把本地 commit 压平成工作区改动，
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

/** 读源文件：优先本地 checkout，找不到再用 Contents API 兜底 */
async function readSourceFile(relPath) {
  const localPath = path.join(REPO_ROOT, relPath)
  if (fs.existsSync(localPath)) return fs.readFileSync(localPath)

  console.log(`  [source] 本地未找到，尝试 API 读取 ${relPath}`)
  const res = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(relPath)}`)
  if (res?.encoding === 'base64' && res.content) {
    if ((res.size || 0) > MAX_BLOB_SIZE) throw new Error(`源文件过大：${res.size} > 100MB`)
    return Buffer.from(res.content, 'base64')
  }
  throw new Error(`源文件读取失败：${relPath}`)
}

// ============================================================
// 主入口
// ============================================================
async function main() {
  const payload = JSON.parse(process.argv[2] || process.env.PIPELINE_PAYLOAD || '{}') || {}
  const { doc_id, title, source_path } = payload
  if (!doc_id || !source_path) {
    console.error('❌ 需要 doc_id 和 source_path')
    process.exit(1)
  }

  PROGRESS_PATH = `documents/${doc_id}/.progress.json`

  const docDirRel = `documents/${doc_id}`
  const docDirLocal = path.join(REPO_ROOT, docDirRel)
  fs.mkdirSync(docDirLocal, { recursive: true })

  console.log(`=== Doc convert pipeline start ===`)
  console.log(`  doc_id: ${doc_id}`)
  console.log(`  title:  ${title || '(未提供)'}`)
  console.log(`  source: ${source_path}`)

  await writeProgress({ stage: 'queued', message: '任务启动...', pct: 0, node: 0 }).catch(() => {})

  const workDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp_doc_'))
  try {
    const ext = path.extname(source_path).toLowerCase()
    if (ext !== '.pdf' && !WORD_EXT.test(ext)) {
      throw new Error(`不支持的文件类型：${ext || source_path}（只支持 .doc / .docx / .pdf）`)
    }

    // 1. 读源文件
    const srcBuf = await readSourceFile(source_path)
    console.log(`  ✓ 源文件 ${srcBuf.length} bytes（${ext}）`)
    const srcLocal = path.join(workDir, `source${ext}`)
    fs.writeFileSync(srcLocal, srcBuf)

    // 2. Word → PDF（源就是 PDF 则直通）
    let pdfLocalPath
    if (ext === '.pdf') {
      pdfLocalPath = srcLocal
    } else {
      await writeProgress({ stage: 'queued', message: 'Word 转 PDF（LibreOffice）...', pct: 3, node: 0 }).catch(() => {})
      pdfLocalPath = wordToPdf(srcLocal, workDir)
      console.log(`  ✓ Word → PDF ${fs.statSync(pdfLocalPath).size} bytes`)
    }

    // 3. 按页切分（不超过阈值就是单段）
    const baseName = `${doc_id.replace(/[/\\]/g, '_')}.pdf`
    const chunks = splitPdf(pdfLocalPath, baseName, CHUNK_PAGES)
    console.log(`  ✓ 待转换 ${chunks.length} 段`)

    // 4. MinerU（唯一的重活）
    const { markdowns, images } = await mineruConvertBatch(chunks, (p) => {
      writeProgress({ ...p, node: 0 }).catch(() => {})
    })

    // 5. 按原顺序拼成整篇
    const merged = markdowns.map((md) => md.trim()).filter(Boolean).join('\n\n')
    if (!merged) throw new Error('MinerU 返回的 markdown 为空')
    console.log(`  ✓ 合并完成，content.md ${merged.length} chars`)

    // 6. 落盘 content.md + images/
    const contentRel = `${docDirRel}/content.md`
    fs.writeFileSync(path.join(REPO_ROOT, contentRel), merged, 'utf-8')
    const commitPaths = [contentRel]
    if (images.size > 0) {
      const imgDir = path.join(docDirLocal, 'images')
      fs.mkdirSync(imgDir, { recursive: true })
      for (const [name, buf] of images) fs.writeFileSync(path.join(imgDir, name), buf)
      commitPaths.push(`${docDirRel}/images`)
      console.log(`  ✓ 复制图片 ${images.size} 张`)
    }

    // 7. 提交（content.md + images）
    await writeProgress({ stage: 'commit', message: '提交到 GitHub...', pct: 98, node: 0 })
    await commitLocalFiles(commitPaths, `[doc] convert ${doc_id}`)

    // 8. 终态：先写 done 让前端看到，再删掉 progress
    await writeProgress({ stage: 'done', message: '转换完成', pct: 100, node: 0 })
    try { fs.unlinkSync(path.join(REPO_ROOT, PROGRESS_PATH)) } catch {}
    await deleteProgress()

    console.log(`=== Doc convert pipeline done ===`)
  } catch (err) {
    console.error(`❌ Doc convert pipeline failed:`, err.message || err)
    try {
      await writeProgress({
        stage: 'failed',
        message: `失败: ${err.message}`,
        pct: 0,
        node: 0,
        error: err.message || String(err),
      })
    } catch { console.warn('  [fail-safe] 写失败状态也失败了') }
    process.exit(1)
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {}
  }
}

main()
