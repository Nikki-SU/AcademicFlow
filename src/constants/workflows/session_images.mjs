#!/usr/bin/env node
/**
 * AcademicFlow Session Images Pipeline — GitHub Actions Runner
 * ============================================================
 * 一节课的「照片 + 课程材料」→ MinerU → **markdown**：
 *   - 照片：逐张识别 → **合并成一个 board.md**（多张进、一份出）；
 *   - 课程材料（PDF / PPT / Word）：每份 → 一份 materials-md/{名}.md
 *     （PDF 直送 MinerU；Word/PPT 先经 LibreOffice 转 PDF 再送，与 note_convert 同法）。
 *
 * 与 book_convert 的差别：
 *   - 输入是「一堆图片 + 若干材料文件」（不是一本 PDF），图片不需要 qpdf 切分、
 *     材料超过页数阈值才切；
 *   - 输出是「多张照片合并的一份 board.md + 每份材料一份 md」；
 *   - 与录音转写 transcript.md 并列：一节课 = 一个 transcript.md + 一个 board.md + 材料 md。
 *
 * 触发：repository_dispatch event_type=session_images
 *   payload: { task_id, session_id }
 *
 * 产物：
 *   projects/{task_id}/sessions/{session_id}/board.md           所有照片识别结果合并
 *   projects/{task_id}/sessions/{session_id}/board-images/      照片识别抽出的插图
 *   projects/{task_id}/sessions/{session_id}/materials-md/      每份课程材料一份 md
 *   projects/{task_id}/sessions/{session_id}/materials-md-images/ 材料识别抽出的插图
 *
 * 进度协议（stage 名沿用文献/图书那一套，前端进度条零改动）：
 *   projects/{task_id}/sessions/{session_id}/.progress.json   done 后删除
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'

const REPO_ROOT = process.cwd()

const MINERU_API = 'https://mineru.net/api/v4'
const MAX_BLOB_SIZE = 100 * 1024 * 1024
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|tif{1,2})$/i

/** 课程材料支持的类型：PDF 直送 MinerU；Word / PPT 先经 LibreOffice 转 PDF 再送 */
const MATERIAL_EXT = /\.(pdf|docx?|pptx?)$/i
const OFFICE_EXT = /\.(docx?|pptx?)$/i
/** 超过这个页数才切分（MinerU 单文件页数上限约 200 页） */
const SPLIT_THRESHOLD_PAGES = 200
/** 切分粒度：每段 180 页 */
const CHUNK_PAGES = 180

const { MINERU_API_TOKEN, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env
if (!MINERU_API_TOKEN) { console.error('❌ MINERU_API_TOKEN not set'); process.exit(1) }
if (!GITHUB_OWNER || !GITHUB_REPO) { console.error('❌ GITHUB_OWNER / GITHUB_REPO not set'); process.exit(1) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ============================================================
// GitHub API（只用于写 / 删 .progress.json —— 产物走本地 git commit）
// ============================================================
async function ghApi(method, apiPath, body) {
  const init = {
    method,
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'academicflow-session-images/1.0',
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
      const err = new Error(`GitHub ${method} ${apiPath}: ${resp.status} ${txt.slice(0, 300)}`)
      // 附上 HTTP 状态码：调用方需要区分「目录不存在（404，正常）」和「真错误」
      err.status = resp.status
      throw err
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
let PROGRESS_LABEL = ''

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
    const body = { message: `progress: session images ${data.stage}`, content: b64 }
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
      message: `progress done ${PROGRESS_LABEL}`,
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
  if (typeof j === 'object' && j !== null && 'code' in j && j.code !== 0) {
    throw new Error(`MinerU ${method} ${urlPath} code=${j.code} msg=${j.msg || ''}`)
  }
  return j
}

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
 * 把一节课的所有照片一次性交给 MinerU，返回与输入同序的 markdown 数组 + 合并后的图片。
 * items: [{ name, buf }]，顺序即最终拼接顺序。
 */
async function mineruConvertBatch(items, onProgress) {
  for (const it of items) {
    if (it.buf.length > MAX_BLOB_SIZE) {
      throw new Error(`照片 ${it.name} 体积 ${it.buf.length} 超过 100MB blob 硬限`)
    }
  }

  onProgress({ stage: 'mineru_apply', message: `申请上传 URL（共 ${items.length} 张）...`, pct: 5 })
  const applyResp = await mineruRequest('POST', '/file-urls/batch', {
    files: items.map((it) => ({ name: it.name, is_ocr: true })),
    model_version: 'pipeline',
    enable_formula: true,
    enable_table: true,
    language: 'auto',
  })
  const batchId = applyResp.data?.batch_id
  const urls = applyResp.data?.file_urls || []
  if (!batchId || urls.length !== items.length) {
    throw new Error(`MinerU 响应缺 batch_id / file_urls（要 ${items.length} 个，拿到 ${urls.length} 个）`)
  }
  console.log(`  [mineru] batch_id=${batchId}, images=${items.length}`)

  // 逐张 PUT 到预签名 URL。⚠️ 不能带 Content-Type：OSS 预签名 StringToSign 里它是空串。
  for (let i = 0; i < items.length; i++) {
    onProgress({
      stage: 'mineru_upload',
      message: `上传第 ${i + 1}/${items.length} 张...`,
      pct: 10 + Math.round((i / items.length) * 15),
    })
    const putResp = await fetch(urls[i], { method: 'PUT', headers: {}, body: items[i].buf })
    if (!putResp.ok) {
      throw new Error(`照片 ${i + 1} OSS PUT: ${putResp.status} ${await putResp.text().catch(() => '')}`)
    }
  }

  const MAX_ROUNDS = 120
  const results = new Array(items.length).fill(null)
  for (let round = 0; round < MAX_ROUNDS; round++) {
    await sleep(5000)
    const pollResp = await mineruRequest('GET', `/extract-results/batch/${batchId}`)
    const list = pollResp.data?.extract_result || []
    for (const r of list) {
      let idx = items.findIndex((it) => it.name === r.file_name)
      if (idx < 0) idx = list.indexOf(r)
      if (idx < 0 || idx >= items.length) continue
      if (r.state === 'done') {
        results[idx] = r
      } else if (r.state === 'failed' || r.state === 'error') {
        throw new Error(`第 ${idx + 1} 张 MinerU ${r.state}: ${r.err_msg || '无错误详情'}`)
      }
    }
    const doneCount = results.filter(Boolean).length
    onProgress({
      stage: 'mineru_poll',
      message: `MinerU 识别中（${doneCount}/${items.length} 张完成）...`,
      pct: 30 + Math.round((doneCount / items.length) * 40),
    })
    if (doneCount === items.length) break
  }
  const stalled = results.findIndex((r) => !r)
  if (stalled >= 0) {
    throw new Error(`MinerU 轮询超时：第 ${stalled + 1}/${items.length} 张未完成`)
  }

  const markdowns = []
  const images = new Map()
  for (let i = 0; i < items.length; i++) {
    onProgress({
      stage: 'mineru_download',
      message: `下载第 ${i + 1}/${items.length} 张产物...`,
      pct: 75 + Math.round((i / items.length) * 20),
    })
    const r = results[i]
    if (!r.full_zip_url) throw new Error(`第 ${i + 1} 张 state=done 但没有 full_zip_url`)

    const zipResp = await fetch(r.full_zip_url)
    if (!zipResp.ok) throw new Error(`下载第 ${i + 1} 张 zip: ${zipResp.status}`)
    const zipBuf = Buffer.from(await zipResp.arrayBuffer())

    const tmpDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp_session_img_'))
    try {
      const zipPath = path.join(tmpDir, 'result.zip')
      fs.writeFileSync(zipPath, zipBuf)
      execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { stdio: 'pipe' })

      const fullMdPath = path.join(tmpDir, 'full.md')
      const mdFile = fs.existsSync(fullMdPath) ? fullMdPath : findFirstMd(tmpDir)
      let md = mdFile ? fs.readFileSync(mdFile, 'utf-8') : ''

      // 每张照片的插图重命名加序号前缀，避免多张照片的 images/ 同名互相覆盖；
      // 同时把 md 里的 `images/xxx` 引用改到 `board-images/` 下的新名字。
      const imgDir = path.join(tmpDir, 'images')
      if (fs.existsSync(imgDir)) {
        for (const f of fs.readdirSync(imgDir)) {
          const newName = `img${String(i + 1).padStart(2, '0')}_${f}`
          try {
            images.set(newName, fs.readFileSync(path.join(imgDir, f)))
            md = md.split(`images/${f}`).join(`board-images/${newName}`)
          } catch (e) {
            console.warn(`  [mineru] 第 ${i + 1} 张图片读取失败 ${f}: ${e.message}`)
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
// 课程材料 → PDF 切段 / MinerU（复用 note_convert 的成熟做法）
// ============================================================

/** 用 LibreOffice 把 Word / PPT 转成 PDF，返回生成的 PDF 本地路径。失败即抛错，不静默降级。 */
function officeToPdf(srcLocalPath, outDir) {
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
    throw new Error('LibreOffice 未能把 Word / PPT 转成 PDF（文件可能损坏或格式不受支持）')
  }
  return outPath
}

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

  const workDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp_session_split_'))
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

/**
 * 把多份材料的所有 PDF 分段**一次性**交给 MinerU（一次 batch）转换，
 * 返回每份材料的分段 markdown + 合并后的图片。
 *
 * jobs: [{ chunks: [{ name, buf }] }]，jobs[i] 是第 i 份材料；段名必须全局唯一
 * （调用方用「材料序号_」前缀），轮询回流时才不会串份。
 * imageRefBase: 图片在 md 里引用的仓库绝对目录（…/materials-md-images）。
 * 返回：{ markdowns: string[][]（markdowns[i] = 第 i 份材料的分段 md）, images: Map<name, Buffer> }
 */
async function mineruConvertDocuments(jobs, imageRefBase, onProgress) {
  // 拍平成全局段列表，记住每段属于哪一份材料
  const flat = []
  for (let j = 0; j < jobs.length; j++) {
    for (const c of jobs[j].chunks) flat.push({ job: j, name: c.name, buf: c.buf })
  }
  if (flat.length === 0) throw new Error('没有待转换的分段')
  for (const c of flat) {
    if (c.buf.length > MAX_BLOB_SIZE) {
      throw new Error(`分段 ${c.name} 体积 ${c.buf.length} 超过 100MB blob 硬限`)
    }
  }

  // 1. 一次 batch 申请所有段的上传 URL
  onProgress({
    stage: 'mineru_apply',
    message: `申请上传 URL（共 ${jobs.length} 份材料 / ${flat.length} 段）...`,
    pct: 10,
  })
  const applyResp = await mineruRequest('POST', '/file-urls/batch', {
    files: flat.map((c) => ({ name: c.name, is_ocr: false })),
    model_version: 'pipeline',
    enable_formula: true,
    enable_table: true,
    language: 'auto',
  })
  const batchId = applyResp.data?.batch_id
  const urls = applyResp.data?.file_urls || []
  if (!batchId || urls.length !== flat.length) {
    throw new Error(`MinerU 响应缺 batch_id / file_urls（要 ${flat.length} 个，拿到 ${urls.length} 个）`)
  }
  console.log(`  [mineru] batch_id=${batchId}, materials=${jobs.length}, chunks=${flat.length}`)

  // 2. 逐段 PUT 到预签名 URL。⚠️ 不能带 Content-Type：OSS 预签名 StringToSign 里它是空串。
  for (let i = 0; i < flat.length; i++) {
    onProgress({
      stage: 'mineru_upload',
      message: `上传第 ${i + 1}/${flat.length} 段...`,
      pct: 25 + Math.round((i / flat.length) * 10),
    })
    const putResp = await fetch(urls[i], { method: 'PUT', headers: {}, body: flat[i].buf })
    if (!putResp.ok) {
      throw new Error(`分段 ${i + 1} OSS PUT: ${putResp.status} ${await putResp.text().catch(() => '')}`)
    }
  }

  // 3. 轮询，等所有段 done（5s × 120 轮 = 最长 10 分钟）
  const MAX_ROUNDS = 120
  const results = new Array(flat.length).fill(null)
  for (let round = 0; round < MAX_ROUNDS; round++) {
    await sleep(5000)
    const pollResp = await mineruRequest('GET', `/extract-results/batch/${batchId}`)
    const list = pollResp.data?.extract_result || []
    for (const r of list) {
      let idx = flat.findIndex((c) => c.name === r.file_name)
      if (idx < 0) idx = list.indexOf(r)
      if (idx < 0 || idx >= flat.length) continue
      if (r.state === 'done') {
        results[idx] = r
      } else if (r.state === 'failed' || r.state === 'error') {
        throw new Error(`第 ${idx + 1} 段 MinerU ${r.state}: ${r.err_msg || '无错误详情'}`)
      }
    }
    const doneCount = results.filter(Boolean).length
    onProgress({
      stage: 'mineru_poll',
      message: `MinerU 解析中（${doneCount}/${flat.length} 段完成）...`,
      pct: 40 + Math.round((doneCount / flat.length) * 30),
    })
    if (doneCount === flat.length) break
  }
  const stalled = results.findIndex((r) => !r)
  if (stalled >= 0) {
    throw new Error(`MinerU 轮询超时：第 ${stalled + 1}/${flat.length} 段未完成`)
  }

  // 4. 逐段下载 zip → 取 md + 图片；图片重命名加全局序号避免多段同名互相覆盖，
  //    同时把 md 里的 `images/xxx` 引用改写到仓库绝对目录，渲染页才能显示。
  const markdowns = jobs.map(() => [])
  const images = new Map()
  let imgSeq = 0
  for (let i = 0; i < flat.length; i++) {
    onProgress({
      stage: 'mineru_download',
      message: `下载第 ${i + 1}/${flat.length} 段产物...`,
      pct: 75 + Math.round((i / flat.length) * 20),
    })
    const r = results[i]
    if (!r.full_zip_url) throw new Error(`第 ${i + 1} 段 state=done 但没有 full_zip_url`)

    const zipResp = await fetch(r.full_zip_url)
    if (!zipResp.ok) throw new Error(`下载第 ${i + 1} 段 zip: ${zipResp.status}`)
    const zipBuf = Buffer.from(await zipResp.arrayBuffer())

    const tmpDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp_session_mat_zip_'))
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
            md = md.split(`images/${f}`).join(`${imageRefBase}/${newName}`)
          } catch (e) {
            console.warn(`  [mineru] 第 ${i + 1} 段图片读取失败 ${f}: ${e.message}`)
          }
        }
      }
      markdowns[flat[i].job].push(md)
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    }
  }

  return { markdowns, images }
}

/** 列出课程材料源文件：优先本地 checkout，找不到再用 Contents API 兜底（只认支持的类型） */
async function listSourceMaterials(materialsRel) {
  const localDir = path.join(REPO_ROOT, materialsRel)
  if (fs.existsSync(localDir)) {
    const names = fs.readdirSync(localDir).filter((n) => MATERIAL_EXT.test(n)).sort()
    if (names.length > 0) {
      return names.map((n) => ({
        name: n,
        buf: fs.readFileSync(path.join(localDir, n)),
      }))
    }
  }
  console.log(`  [materials] 本地未找到，尝试 API 列出 ${materialsRel}`)
  let res
  try {
    res = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(materialsRel)}`)
  } catch (e) {
    // 404 = 该课时从未上传过课程材料（git 不跟踪空目录，目录根本不存在）——这是正常状态，不是错误。
    if (e?.status === 404) return []
    throw e
  }
  if (!Array.isArray(res)) return []
  const items = []
  for (const entry of res.filter((e) => e.type === 'file' && MATERIAL_EXT.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    if ((entry.size || 0) > MAX_BLOB_SIZE) throw new Error(`材料 ${entry.name} 过大：${entry.size} > 100MB`)
    const file = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(entry.path)}`)
    if (file?.encoding === 'base64' && file.content) {
      items.push({ name: entry.name, buf: Buffer.from(file.content, 'base64') })
    }
  }
  return items
}

// ============================================================
// 提交产物（git commit + push）
// ============================================================
async function commitLocalFiles(fileRelPaths, message) {
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

/** 列出源图片：优先本地 checkout，找不到再用 Contents API 兜底 */
async function listSourceImages(imagesRel) {
  const localDir = path.join(REPO_ROOT, imagesRel)
  if (fs.existsSync(localDir)) {
    const names = fs.readdirSync(localDir).filter((n) => IMAGE_EXT.test(n)).sort()
    if (names.length > 0) {
      return names.map((n) => ({
        name: n,
        buf: fs.readFileSync(path.join(localDir, n)),
      }))
    }
  }
  console.log(`  [images] 本地未找到，尝试 API 列出 ${imagesRel}`)
  let res
  try {
    res = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(imagesRel)}`)
  } catch (e) {
    // 404 = 该课时没有 images/ 目录 —— 视为「没有照片」，交由主流程报可读错误，不在这里炸。
    if (e?.status === 404) return []
    throw e
  }
  if (!Array.isArray(res)) return []
  const items = []
  for (const entry of res.filter((e) => e.type === 'file' && IMAGE_EXT.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    if ((entry.size || 0) > MAX_BLOB_SIZE) throw new Error(`照片 ${entry.name} 过大：${entry.size} > 100MB`)
    const file = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(entry.path)}`)
    if (file?.encoding === 'base64' && file.content) {
      items.push({ name: entry.name, buf: Buffer.from(file.content, 'base64') })
    }
  }
  return items
}

// ============================================================
// 主入口
// ============================================================
async function main() {
  const payload = JSON.parse(process.argv[2] || process.env.PIPELINE_PAYLOAD || '{}') || {}
  const { task_id, session_id } = payload
  if (!task_id || !session_id) {
    console.error('❌ 需要 task_id 和 session_id')
    process.exit(1)
  }

  const sessionRel = `projects/${task_id}/sessions/${session_id}`
  const imagesRel = `${sessionRel}/images`
  PROGRESS_PATH = `${sessionRel}/.progress.json`
  PROGRESS_LABEL = `${task_id}/${session_id}`

  console.log(`=== Session images pipeline start ===`)
  console.log(`  task_id:    ${task_id}`)
  console.log(`  session_id: ${session_id}`)

  await writeProgress({ stage: 'queued', message: '任务启动...', pct: 0, node: 0 }).catch(() => {})

  /** 提交产物 + 写终态（照片 / 材料两条路共用） */
  async function finish(commitPaths, doneMessage) {
    await writeProgress({ stage: 'commit', message: '提交到 GitHub...', pct: 98, node: 0 })
    await commitLocalFiles(commitPaths, `[session] images + materials → md (${task_id}/${session_id})`)
    await writeProgress({ stage: 'done', message: doneMessage, pct: 100, node: 0 })
    try { fs.unlinkSync(path.join(REPO_ROOT, PROGRESS_PATH)) } catch {}
    await deleteProgress()
    console.log(`=== Session images pipeline done ===`)
  }

  try {
    // 0. 收集课程材料（PDF / PPT / Word），逐份转 Markdown：PDF 直送，Office 先经 LibreOffice 转 PDF
    const materialsRel = `${sessionRel}/materials`
    const materialsMdRel = `${sessionRel}/materials-md`
    const materialsImgRel = `${sessionRel}/materials-md-images`
    const matItems = await listSourceMaterials(materialsRel)
    const materialsCommit = []
    if (matItems.length > 0) {
      await writeProgress({ stage: 'queued', message: `准备 ${matItems.length} 份课程材料...`, pct: 2, node: 0 }).catch(() => {})
      const jobs = [] // [{ srcName, mdRel, chunks }]
      const workDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp_session_mat_'))
      try {
        for (let i = 0; i < matItems.length; i++) {
          const item = matItems[i]
          const ext = path.extname(item.name).toLowerCase()
          if (!MATERIAL_EXT.test(ext)) continue
          await writeProgress({
            stage: 'queued',
            message: `材料 ${i + 1}/${matItems.length}（${item.name}）准备中...`,
            pct: 2 + Math.round((i / matItems.length) * 3),
            node: 0,
          }).catch(() => {})
          const srcLocal = path.join(workDir, `src_${i + 1}${ext}`)
          fs.writeFileSync(srcLocal, item.buf)
          let pdfLocal
          if (ext === '.pdf') {
            pdfLocal = srcLocal
          } else {
            pdfLocal = officeToPdf(srcLocal, workDir)
            console.log(`  ✓ [材料 ${i + 1}] ${item.name} → PDF ${fs.statSync(pdfLocal).size} bytes`)
          }
          // 段名加「材料序号_」前缀，多份材料混进一次 batch 才不会串份
          const baseName = `m${i + 1}_${item.name.replace(/[/\\]/g, '_')}.pdf`
          const chunks = splitPdf(pdfLocal, baseName, CHUNK_PAGES)
          jobs.push({ srcName: item.name, mdRel: `${materialsMdRel}/${item.name}.md`, chunks })
          console.log(`  ✓ [材料 ${i + 1}] ${item.name} → ${chunks.length} 段`)
        }
        if (jobs.length > 0) {
          // 所有材料的段一次 MinerU batch
          const { markdowns, images } = await mineruConvertDocuments(
            jobs.map((j) => ({ chunks: j.chunks })),
            materialsImgRel,
            (p) => { writeProgress({ ...p, node: 0 }).catch(() => {}) },
          )
          // 逐份落盘；空产物即报可读错误，绝不写空 md
          fs.mkdirSync(path.join(REPO_ROOT, materialsMdRel), { recursive: true })
          for (let i = 0; i < jobs.length; i++) {
            const merged = markdowns[i].map((md) => md.trim()).filter(Boolean).join('\n\n')
            if (!merged) throw new Error(`材料「${jobs[i].srcName}」MinerU 返回的 markdown 为空`)
            fs.writeFileSync(path.join(REPO_ROOT, jobs[i].mdRel), merged, 'utf-8')
            materialsCommit.push(jobs[i].mdRel)
            console.log(`  ✓ [材料 ${i + 1}] ${jobs[i].mdRel} ${merged.length} chars`)
          }
          if (images.size > 0) {
            const imgDirLocal = path.join(REPO_ROOT, materialsImgRel)
            fs.mkdirSync(imgDirLocal, { recursive: true })
            for (const [name, buf] of images) fs.writeFileSync(path.join(imgDirLocal, name), buf)
            materialsCommit.push(materialsImgRel)
            console.log(`  ✓ 材料图片 ${images.size} 张`)
          }
        }
      } finally {
        try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {}
      }
    }

    // 1. 收集源照片
    const items = await listSourceImages(imagesRel)

    // 2. 无照片但有材料：材料已在上面转成 md，直接提交收尾（不要求必须有照片）
    if (items.length === 0) {
      if (materialsCommit.length === 0) {
        throw new Error(`没有可识别的照片、也没有课程材料：${sessionRel}`)
      }
      console.log(`  ✓ 无照片，但有 ${materialsCommit.length} 份材料 md，直接提交收尾`)
      await finish(materialsCommit, '材料转换完成')
      return
    }
    console.log(`  ✓ 待识别 ${items.length} 张`)

    // 3. MinerU（唯一的重活）
    const { markdowns, images } = await mineruConvertBatch(items, (p) => {
      writeProgress({ ...p, node: 0 }).catch(() => {})
    })

    // 4. 合并成一份 board.md（多张进、一份出）
    const parts = markdowns.map((md, i) => {
      const head = `## 图片 ${i + 1} · ${items[i].name}`
      const body = (md || '').trim()
      return body ? `${head}\n\n${body}` : `${head}\n\n_（本张未识别到内容）_`
    })
    const merged = [`# 课堂板书 / 幻灯片识别`, '', `> 本页由一节课的 ${items.length} 张照片经 MinerU 识别合并而成。`, '', ...parts].join('\n\n')
    console.log(`  ✓ 合并完成，board.md ${merged.length} chars`)

    // 5. 落盘 board.md + board-images/
    const sessionLocal = path.join(REPO_ROOT, sessionRel)
    fs.mkdirSync(sessionLocal, { recursive: true })
    const boardRel = `${sessionRel}/board.md`
    fs.writeFileSync(path.join(REPO_ROOT, boardRel), merged, 'utf-8')
    if (images.size > 0) {
      const imgDir = path.join(sessionLocal, 'board-images')
      fs.mkdirSync(imgDir, { recursive: true })
      for (const [name, buf] of images) fs.writeFileSync(path.join(imgDir, name), buf)
      console.log(`  ✓ 复制图片 ${images.size} 张`)
    }

    // 6. 提交（材料 md + board）+ 终态
    const commitPaths = [...materialsCommit, boardRel]
    if (images.size > 0) commitPaths.push(`${sessionRel}/board-images`)
    await finish(commitPaths, '识别 / 材料转换完成')
  } catch (err) {
    console.error(`❌ Session images pipeline failed:`, err.message || err)
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
  }
}

main()
