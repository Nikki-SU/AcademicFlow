// MinerU 端到端测试脚本
// 运行: node scripts/test-mineru.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs"
import { execSync } from "node:child_process"

const TOKEN = "eyJ0eXBlIjoiSldUIiwiYWxnIjoiSFM1MTIifQ.eyJqdGkiOiI5NzYwMDA1OSIsInJvbCI6IlJPTEVfUkVHSVNURVIiLCJpc3MiOiJPcGVuWExhYiIsImlhdCI6MTc4MjgxMjA5MiwiY2xpZW50SWQiOiJsa3pkeDU3bnZ5MjJqa3BxOXgydyIsInBob25lIjoiIiwib3BlbklkIjpudWxsLCJ1dWlkIjoiNWU4MmNjNWItMmFkOS00NjVmLWFmZjktNDdlNTU5ZGY3NDZmIiwiZW1haWwiOiIiLCJleHAiOjE3OTA1ODgwOTJ9.wjJhlZvGD5qlQP5NAmc56s6K3_PgOYQijCrg0ga9DNERa-2ONpWoyL05_55VKGKySKKGCWdwMOZXckF9RBwF_g"
const WORKER = "http://localhost:8000"
const PDF_PATH = "c:/Users/Rosa/.trae-cn/attachments/6aa2acb566b755d2fcca11e1/bde298ae-baea-48f4-beca-6b875cb7d9e7_1c1d4527-36d6-473c-99af-1d818f15d592_测试用例pdf.pdf"
const FILE_NAME = "test.pdf"
const OUTPUT_DIR = "g:/AcademicFlow/AcademicFlow/test-output"

console.log("=== MinerU E2E Test ===")
console.log("Worker:", WORKER)
console.log("PDF:", PDF_PATH)

// ---- Step 1: 申请上传 URL ----
console.log("\n[1/4] 申请上传 URL...")
const applyBody = {
  files: [{ name: FILE_NAME, is_ocr: false }],
  model_version: "pipeline",
  enable_formula: true,
  enable_table: true,
  language: "auto",
}

let applyRes
try {
  applyRes = await fetch(`${WORKER}/api/v4/file-urls/batch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(applyBody),
  })
} catch (e) {
  console.error("申请 URL 网络错误:", e.message)
  process.exit(1)
}

if (!applyRes.ok) {
  console.error("申请 URL HTTP 错误:", applyRes.status, await applyRes.text())
  process.exit(1)
}
const applyData = await applyRes.json()
console.log("申请结果 code =", applyData.code, "msg =", applyData.msg)
if (applyData.code !== 0) {
  console.error("MinerU 拒绝:", applyData.msg)
  process.exit(1)
}

const batchId = applyData.data.batch_id
const uploadUrl = applyData.data.file_urls[0]
console.log("batch_id:", batchId)
console.log("upload_url:", uploadUrl.substring(0, 80) + "...")

// ---- Step 2: 通过 Worker proxy PUT 上传 PDF ----
console.log("\n[2/4] 通过 Worker proxy 上传 PDF...")
const pdfData = readFileSync(PDF_PATH)
console.log("PDF 大小:", pdfData.length, "bytes")

const proxiedUploadUrl = `${WORKER}/proxy?url=${encodeURIComponent(uploadUrl)}`
let putRes
try {
  putRes = await fetch(proxiedUploadUrl, {
    method: "PUT",
    body: pdfData,
    // 故意不带任何自定义 header（OSS 签名校验会挂）
  })
} catch (e) {
  console.error("上传网络错误:", e.message)
  process.exit(1)
}

console.log("上传 HTTP:", putRes.status, putRes.status === 200 ? "OK" : "FAIL")
if (!putRes.ok) {
  console.error("上传失败:", await putRes.text())
  process.exit(1)
}

// ---- Step 3: 轮询解析状态 ----
console.log("\n[3/4] 轮询解析状态...")
const pollUrl = `${WORKER}/api/v4/extract-results/batch/${batchId}`
let result = null
const maxPoll = 60

for (let i = 0; i < maxPoll; i++) {
  await new Promise((r) => setTimeout(r, 5000))
  const pollRes = await fetch(pollUrl, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
  })
  if (!pollRes.ok) {
    console.warn(`  轮询 ${i} HTTP ${pollRes.status}`)
    continue
  }
  const pollData = await pollRes.json()
  if (pollData.code !== 0) {
    console.warn(`  轮询 ${i} code=${pollData.code} msg=${pollData.msg}`)
    continue
  }
  // 第一次 poll 打印完整结构
  if (i === 0) {
    console.log("  [DEBUG] poll response keys:", Object.keys(pollData))
    console.log("  [DEBUG] data type:", Array.isArray(pollData.data) ? "array" : typeof pollData.data)
    console.log("  [DEBUG] data:", JSON.stringify(pollData.data).substring(0, 500))
    if (Array.isArray(pollData.data) && pollData.data.length > 0) {
      console.log("  [DEBUG] data[0] keys:", Object.keys(pollData.data[0]))
      console.log("  [DEBUG] data[0]:", JSON.stringify(pollData.data[0]).substring(0, 500))
    }
  }
  // MinerU 返回 data 可能是 extract_result 数组或直接对象
  const extractResult = Array.isArray(pollData.data)
    ? pollData.data[0]
    : (pollData.data?.extract_result
        ? (Array.isArray(pollData.data.extract_result)
            ? pollData.data.extract_result[0]
            : pollData.data.extract_result)
        : pollData.data)
  const state = extractResult?.state
  console.log(`  轮询 ${i}: state=${state}`)
  if (state === "done") {
    result = extractResult
    break
  }
  if (state === "failed" || state === "error" || state === "canceled") {
    console.error("MinerU 解析失败:", pollData)
    process.exit(1)
  }
}

if (!result) {
  console.error("超时未完成")
  process.exit(1)
}
console.log("解析完成！")
console.log("  full_zip_url:", (result.full_zip_url || result.zip_url || "").substring(0, 100) + "...")

// ---- Step 4: 下载 zip ----
console.log("\n[4/4] 下载结果...")
mkdirSync(OUTPUT_DIR, { recursive: true })

const zipUrl = result.full_zip_url || result.zip_url
if (!zipUrl) {
  console.error("没有找到 zip URL! result keys:", Object.keys(result))
  process.exit(1)
}
const proxyUrl = `${WORKER}/proxy?url=${encodeURIComponent(zipUrl)}`
const zipRes = await fetch(proxyUrl, {
  headers: { Authorization: `Bearer ${TOKEN}` },
})
if (!zipRes.ok) {
  console.error("下载 zip 失败:", zipRes.status, await zipRes.text())
  process.exit(1)
}
const zipBuffer = Buffer.from(await zipRes.arrayBuffer())
const zipPath = `${OUTPUT_DIR}/result.zip`
writeFileSync(zipPath, zipBuffer)
console.log("zip 已保存:", zipPath, zipBuffer.length, "bytes")

try {
  execSync(`cd "${OUTPUT_DIR}" && powershell -Command "Expand-Archive -Path 'result.zip' -DestinationPath 'extracted' -Force"`)
  const files = execSync(`powershell -Command "Get-ChildItem '${OUTPUT_DIR}/extracted' -Recurse | Select-Object FullName,Length | Format-Table -AutoSize"`, { encoding: "utf-8" })
  console.log("\n解压内容:\n" + files)

  const findMd = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const fp = `${dir}/${f.name}`
      if (f.isDirectory()) {
        const r = findMd(fp)
        if (r) return r
      } else if (f.name.endsWith(".md")) {
        return fp
      }
    }
    return null
  }
  const mdPath = findMd(`${OUTPUT_DIR}/extracted`)
  if (mdPath) {
    const md = readFileSync(mdPath, "utf-8")
    const outPath = `${OUTPUT_DIR}/fulltext.md`
    writeFileSync(outPath, md)
    console.log("\nMarkdown 已保存:", outPath, md.length, "chars")
    console.log("--- 前 800 字符 ---")
    console.log(md.substring(0, 800))
  } else {
    console.log("没找到 .md 文件")
  }
} catch (e) {
  console.error("解压失败:", e.message)
}

console.log("\n=== 完成 ===")
