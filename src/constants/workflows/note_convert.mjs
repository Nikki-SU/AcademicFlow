#!/usr/bin/env node
/**
 * AcademicFlow Note Convert Pipeline — GitHub Actions Runner
 * ============================================================
 * 阅读笔记附件 → 一篇命名笔记（markdown）：
 *   Word(.doc / .docx) → PDF（LibreOffice headless）→ MinerU → markdown
 *   PDF                → 直接走 MinerU → markdown
 *
 * 触发：repository_dispatch event_type=note_convert
 *   payload: { base_path, items: [{ note_name, source_path }] }
 *     base_path  = 阅读对象的仓库根目录（literatures/{slug} | textbooks/{书名} | documents/{目录名}）
 *     items      = 待转换的笔记列表；一次 dispatch 可带多篇
 *       note_name  = 目标笔记名（不含 .md；前端已按已有笔记去重）
 *       source_path= 前端上传到私库的源文件（{base_path}/attachments/{ts}_{文件名}）
 *   手动调试也可只给 base_path + note_name + source_path（按单篇处理）
 *
 * 为什么一次带多篇：runner 是全新 VM，装 LibreOffice 要 2~4 分钟。逐篇 dispatch
 * 会把这段固定开销乘 N，用户等不起。合并成一次后：装一次环境、所有段一次 MinerU batch。
 *
 * 产物：
 *   {base_path}/notes/{note_name}.md      转换出的笔记正文（阅读页读它）
 *   {base_path}/notes/images/             MinerU 抽出的图片；md 里用**仓库绝对路径**引用
 *
 * Word → PDF 走 LibreOffice headless：
 *   串行、确定性、保真——内容/结构都以排版为准，不靠猜。转换失败即报可读错误，
 *   绝不静默降级成空笔记（先约束、再容错）。
 *
 * 进度协议（stage 名沿用文献/图书那一套，前端进度条零改动）：
 *   {base_path}/.progress.json            done 后删除
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
      'User-Agent': 'academicflow-note-convert/1.0',
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
    const body = { message: `progress: note convert ${data.stage}`, content: b64 }
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
 * 把多篇笔记的所有 PDF 分段**一次性**交给 MinerU（一次 batch）转换，
 * 返回每篇的分段 markdown + 合并后的图片。
 *
 * jobs: [{ chunks: [{ name, buf }] }]，jobs[i] 是第 i 篇；段顺序即拼接顺序。
 *   段名（name）必须全局唯一，调用方用「篇序号_」前缀保证，轮询回流时才不会串篇。
 * imageRefBase: 图片在 md 里引用的仓库绝对目录（{base_path}/notes/images）。
 * 返回：{ markdowns: string[][]（markdowns[i] = 第 i 篇的分段 md）, images: Map<name, Buffer> }
 */
async function mineruConvertNotes(jobs, imageRefBase, onProgress) {
  // 拍平成全局段列表，记住每段属于哪一篇
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
    message: `申请上传 URL（共 ${jobs.length} 篇 / ${flat.length} 段）...`,
    pct: 5,
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
  console.log(`  [mineru] batch_id=${batchId}, notes=${jobs.length}, chunks=${flat.length}`)

  // 2. 逐段 PUT 到预签名 URL
  //    ⚠️ 不能带 Content-Type：OSS 预签名 URL 的 StringToSign 里它是空串，
  //    带了就 SignatureDoesNotMatch(403)。所以显式传 headers: {}。
  for (let i = 0; i < flat.length; i++) {
    onProgress({
      stage: 'mineru_upload',
      message: `上传第 ${i + 1}/${flat.length} 段...`,
      pct: 10 + Math.round((i / flat.length) * 15),
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
      // 正常情况下 extract_result 与请求的 files 同序；名字对得上就更稳
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
      pct: 30 + Math.round((doneCount / flat.length) * 40),
    })
    if (doneCount === flat.length) break
  }
  const stalled = results.findIndex((r) => !r)
  if (stalled >= 0) {
    throw new Error(`MinerU 轮询超时：第 ${stalled + 1}/${flat.length} 段未完成`)
  }

  // 4. 逐段下载 zip → 取 md + 图片
  //    图片重命名加全局序号，避免多段同名互相覆盖；
  //    同时把 md 里的 `images/xxx` 引用改写成仓库绝对路径，渲染页才能显示。
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

    const tmpDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp_note_zip_'))
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

  const workDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp_note_split_'))
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
  // 与文献/图书 pipeline 同一套：先 fetch + reset --soft 把本地 commit 压平成工作区改动，
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
  const base_path = payload.base_path
  // 批量 items[]（正常）；缺省回落到单篇 note_name / source_path（手动调试）
  const items = Array.isArray(payload.items) && payload.items.length > 0
    ? payload.items
    : (payload.note_name && payload.source_path
      ? [{ note_name: payload.note_name, source_path: payload.source_path }]
      : [])
  if (!base_path || items.length === 0) {
    console.error('❌ 需要 base_path + items[]，或单篇 note_name / source_path')
    process.exit(1)
  }
  for (const it of items) {
    if (!it || !it.note_name || !it.source_path) {
      console.error(`❌ items 项缺 note_name / source_path：${JSON.stringify(it)}`)
      process.exit(1)
    }
  }

  PROGRESS_PATH = `${base_path}/.progress.json`
  PROGRESS_LABEL = `${base_path} / ${items.length} 篇笔记`

  const notesRel = `${base_path}/notes`
  const imagesRel = `${notesRel}/images`

  console.log(`=== Note convert pipeline start ===`)
  console.log(`  base_path: ${base_path}`)
  console.log(`  items:     ${items.length} 篇`)
  items.forEach((it, i) => console.log(`    [${i + 1}] ${it.note_name}  <-  ${it.source_path}`))

  await writeProgress({ stage: 'queued', message: `${items.length} 篇笔记排队中...`, pct: 0, node: 0 }).catch(() => {})

  const workDir = fs.mkdtempSync(path.join(REPO_ROOT, '.tmp_note_'))
  try {
    // 1. 逐篇：判定源类型 → 读源 → Word→PDF → 切段
    //    段名统一加「篇序号_」前缀，多篇混进一次 MinerU batch 时才不会串篇。
    const jobs = []
    for (let i = 0; i < items.length; i++) {
      const { note_name, source_path } = items[i]
      const ext = path.extname(source_path).toLowerCase()
      if (ext !== '.pdf' && !WORD_EXT.test(ext)) {
        throw new Error(`第 ${i + 1} 篇「${note_name}」不支持的文件类型：${ext || source_path}（只支持 .doc / .docx / .pdf）`)
      }

      await writeProgress({
        stage: 'queued',
        message: `准备第 ${i + 1}/${items.length} 篇（${note_name}）...`,
        pct: Math.round((i / items.length) * 5),
        node: 0,
      }).catch(() => {})

      const srcBuf = await readSourceFile(source_path)
      console.log(`  ✓ [${i + 1}] 源文件 ${srcBuf.length} bytes（${ext}）`)
      const srcLocal = path.join(workDir, `source_${i + 1}${ext}`)
      fs.writeFileSync(srcLocal, srcBuf)

      // 2. Word → PDF（若源就是 PDF 则直通）
      let pdfLocalPath
      if (ext === '.pdf') {
        pdfLocalPath = srcLocal
      } else {
        await writeProgress({
          stage: 'queued',
          message: `第 ${i + 1}/${items.length} 篇 Word 转 PDF（LibreOffice）...`,
          pct: Math.round((i / items.length) * 5),
          node: 0,
        }).catch(() => {})
        pdfLocalPath = wordToPdf(srcLocal, workDir)
        console.log(`  ✓ [${i + 1}] Word → PDF ${fs.statSync(pdfLocalPath).size} bytes`)
      }

      // 3. 按页切分（不超过阈值就是单段）
      const baseName = `n${i + 1}_${note_name.replace(/[/\\]/g, '_')}.pdf`
      const chunks = splitPdf(pdfLocalPath, baseName, CHUNK_PAGES)
      console.log(`  ✓ [${i + 1}] 待转换 ${chunks.length} 段`)
      jobs.push({ note_name, noteRel: `${notesRel}/${note_name}.md`, chunks })
    }

    // 4. 所有篇的所有段，一次 MinerU batch（装一次环境、一次申请）
    const { markdowns, images } = await mineruConvertNotes(
      jobs.map((j) => ({ chunks: j.chunks })),
      imagesRel,
      (p) => { writeProgress({ ...p, node: 0 }).catch(() => {}) },
    )

    // 5. 逐篇按原顺序拼接落盘（空产物即报可读错误，绝不写空笔记）
    const commitPaths = []
    fs.mkdirSync(path.join(REPO_ROOT, notesRel), { recursive: true })
    for (let i = 0; i < jobs.length; i++) {
      const merged = markdowns[i].map((md) => md.trim()).filter(Boolean).join('\n\n')
      if (!merged) throw new Error(`第 ${i + 1} 篇「${jobs[i].note_name}」MinerU 返回的 markdown 为空`)
      fs.writeFileSync(path.join(REPO_ROOT, jobs[i].noteRel), merged, 'utf-8')
      commitPaths.push(jobs[i].noteRel)
      console.log(`  ✓ [${i + 1}] ${jobs[i].note_name}.md ${merged.length} chars`)
    }

    // 6. 图片（全局命名，一次落盘）
    if (images.size > 0) {
      const imgDirLocal = path.join(REPO_ROOT, imagesRel)
      fs.mkdirSync(imgDirLocal, { recursive: true })
      for (const [name, buf] of images) fs.writeFileSync(path.join(imgDirLocal, name), buf)
      commitPaths.push(imagesRel)
      console.log(`  ✓ 复制图片 ${images.size} 张`)
    }

    // 7. 一次提交所有产物（note md + images）
    await writeProgress({ stage: 'commit', message: '提交到 GitHub...', pct: 98, node: 0 })
    await commitLocalFiles(commitPaths, `[note] convert ${jobs.map((j) => j.note_name).join(', ')}`)

    // 8. 终态：先写 done 让前端看到，再删掉 progress
    await writeProgress({ stage: 'done', message: '转换完成', pct: 100, node: 0 })
    try { fs.unlinkSync(path.join(REPO_ROOT, PROGRESS_PATH)) } catch {}
    await deleteProgress()

    console.log(`=== Note convert pipeline done ===`)
  } catch (err) {
    console.error(`❌ Note convert pipeline failed:`, err.message || err)
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
