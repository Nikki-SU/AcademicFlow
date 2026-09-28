#!/usr/bin/env node
/**
 * AcademicFlow Session Images Pipeline — GitHub Actions Runner
 * ============================================================
 * 一节课的照片 → MinerU 逐张识别 → **合并成一个 markdown**。
 *
 * 与 book_convert 的差别：
 *   - 输入是一堆图片（不是一本 PDF），不需要 qpdf 切分；
 *   - 输出是「多张照片合并成的一份 board.md」，不是整本 content.md；
 *   - 与录音转写 transcript.md 并列：一节课 = 一个 transcript.md + 一个 board.md。
 *
 * 触发：repository_dispatch event_type=session_images
 *   payload: { task_id, session_id }
 *
 * 产物：
 *   projects/{task_id}/sessions/{session_id}/board.md         所有照片识别结果合并
 *   projects/{task_id}/sessions/{session_id}/board-images/    识别抽出的插图
 *
 * 进度协议（stage 名沿用文献/图书那一套，前端进度条零改动）：
 *   projects/{task_id}/sessions/{session_id}/.progress.json   done 后删除
 */

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const REPO_ROOT = process.cwd()

const MINERU_API = 'https://mineru.net/api/v4'
const MAX_BLOB_SIZE = 100 * 1024 * 1024
const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|tif{1,2})$/i

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
  const res = await ghApi('GET', `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURI(imagesRel)}`)
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

  try {
    // 1. 收集源照片
    const items = await listSourceImages(imagesRel)
    if (items.length === 0) throw new Error(`没有可识别的照片：${imagesRel}`)
    console.log(`  ✓ 待识别 ${items.length} 张`)

    // 2. MinerU（唯一的重活）
    const { markdowns, images } = await mineruConvertBatch(items, (p) => {
      writeProgress({ ...p, node: 0 }).catch(() => {})
    })

    // 3. 合并成一份 board.md（多张进、一份出）
    const parts = markdowns.map((md, i) => {
      const head = `## 图片 ${i + 1} · ${items[i].name}`
      const body = (md || '').trim()
      return body ? `${head}\n\n${body}` : `${head}\n\n_（本张未识别到内容）_`
    })
    const merged = [`# 课堂板书 / 幻灯片识别`, '', `> 本页由一节课的 ${items.length} 张照片经 MinerU 识别合并而成。`, '', ...parts].join('\n\n')
    console.log(`  ✓ 合并完成，board.md ${merged.length} chars`)

    // 4. 落盘 board.md + board-images/
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

    // 5. 提交
    await writeProgress({ stage: 'commit', message: '提交到 GitHub...', pct: 98, node: 0 })
    const commitPaths = [boardRel]
    if (images.size > 0) commitPaths.push(`${sessionRel}/board-images`)
    await commitLocalFiles(commitPaths, `[session] images → board.md (${task_id}/${session_id})`)

    // 6. 终态
    await writeProgress({ stage: 'done', message: '识别完成', pct: 100, node: 0 })
    try { fs.unlinkSync(path.join(REPO_ROOT, PROGRESS_PATH)) } catch {}
    await deleteProgress()

    console.log(`=== Session images pipeline done ===`)
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
