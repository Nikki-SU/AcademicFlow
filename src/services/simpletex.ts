/**
 * SimpleTex 公式识图（图片 → LaTeX）
 * ------------------------------------------------------------
 * 官方文档：https://doc.simpletex.cn/zh/api/
 *   POST https://server.simpletex.cn/api/latex_ocr        标准模型（准确，500 次/日）
 *   POST https://server.simpletex.cn/api/latex_ocr_turbo  轻量模型（快，2000 次/日）
 *   请求体：multipart/form-data，图片字段名固定为 `file`
 *
 * 鉴权两种（二选一）：
 *   1) UAT：header { token }
 *   2) APP：header { app-id, random-str, timestamp, sign }
 *      sign = MD5( 按 key 升序用 & 连接 "k=v" 后追加 "&secret=<APP Secret>" )
 *
 * 为什么不浏览器直连：SimpleTex 的鉴权全靠自定义 header，而这些 header 一个都不在
 *   它返回的 Access-Control-Allow-Headers 白名单里（实测白名单只有 accept/
 *   accept-encoding/authorization/content-type/dnt/origin/user-agent/x-csrftoken/
 *   x-requested-with）。预检过不了 → 浏览器直接 `Failed to fetch`，UAT / APP 都一样。
 *   所以改走后端：图片先提交进私库 → dispatch 到 GitHub Actions → runner 拿令牌调
 *   SimpleTex（令牌由前端 input_json 传入，和 list_models 同款即时传参）→ 结果回写。
 */
import { getSetting, SETTING_KEYS } from './db'
import { uploadRepoBinaryFile, readRepoTextFile } from './github'
import { dispatchAiCall } from './workflowClient'
import { useAuthStore } from '../stores/auth'
import { useWorkspaceStore } from '../stores/workspace'

export type SimpleTexModel = 'standard' | 'turbo'

export interface SimpleTexCredentials {
  /** UAT 或 APP ID */
  token: string
  /** APP 模式下的 APP Secret；UAT 模式留空 */
  secret: string
}

export async function loadSimpleTexCredentials(): Promise<SimpleTexCredentials> {
  const [token, secret] = await Promise.all([
    getSetting(SETTING_KEYS.SIMPLETEX_TOKEN),
    getSetting(SETTING_KEYS.SIMPLETEX_SECRET),
  ])
  return { token: (token || '').trim(), secret: (secret || '').trim() }
}

/** 统一获取后端上下文（私库 + PAT） */
function getBackendContext(): { token: string; owner: string; repo: string } {
  const { token, user } = useAuthStore.getState()
  const repo = useWorkspaceStore.getState().repo?.name
  const owner = user?.login
  if (!token || !owner || !repo) {
    throw new Error('未登录或私库未配置 — 无法触发后端识图服务')
  }
  return { token, owner, repo }
}

/** 猜图片后缀（结果文件命名用，不影响识别） */
function extOf(file: File | Blob): string {
  if (typeof File !== 'undefined' && file instanceof File) {
    const m = file.name.match(/\.([a-z0-9]+)$/i)
    if (m) return m[1].toLowerCase()
  }
  const t = (file.type || '').toLowerCase()
  if (t.includes('png')) return 'png'
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg'
  if (t.includes('webp')) return 'webp'
  if (t.includes('bmp')) return 'bmp'
  if (t.includes('gif')) return 'gif'
  return 'png'
}

export interface SimpleTexResult {
  latex: string
  requestId: string
}

/** 轮询 runner 写回的结果文件 */
async function pollOcrResult(
  outputPath: string,
  owner: string,
  repo: string,
  token: string,
): Promise<SimpleTexResult> {
  const maxAttempts = 100 // 3s × 100 = 5min（OCR 本身很快，主要在等 Actions 排队）
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    try {
      const raw = await readRepoTextFile(owner, repo, outputPath, token)
      if (!raw) continue
      const parsed = JSON.parse(raw.content)
      if (parsed.error) throw new Error(`后端识图失败：${parsed.error}`)
      const latex = parsed.latex || ''
      if (!latex) throw new Error('后端识图没返回公式源码')
      return { latex, requestId: parsed.request_id || '' }
    } catch (e: any) {
      // 已知的业务失败直接抛；其余（文件还没 commit / JSON 还没写完）继续等
      const msg = e?.message || ''
      if (msg.includes('后端识图失败') || msg.includes('没返回公式源码')) throw e
    }
  }
  throw new Error('后端识图超时（5 分钟未返回）。可能是 GitHub Actions 排队过久或 SimpleTex 无响应。')
}

/**
 * 识图 → LaTeX（走后端）。
 * @param file 图片文件（png/jpg 截图，建议先裁到只有公式区域）
 * @param cred IndexedDB 里的 SimpleTex 令牌，随 input_json 传给 runner
 * @param model 'standard' 更准 | 'turbo' 更快
 */
export async function recognizeFormulaImage(
  file: File | Blob,
  cred: SimpleTexCredentials,
  model: SimpleTexModel = 'standard',
): Promise<SimpleTexResult> {
  if (!cred.token) {
    throw new Error('还没配置 SimpleTex 令牌。请到「设置 → 公式识图」里填入 UAT 或 APP ID。')
  }

  const { token: ghToken, owner, repo } = getBackendContext()

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const imagePath = `temp/ai/ocr/ocr_${stamp}.${extOf(file)}`
  const outputPath = `temp/ai/ocr/ocr_${stamp}.json`
  const taskId = `ocr_${stamp}`

  // 1. 图片先提交进私库（浏览器直连必被 CORS 拦，见文件头注释）
  await uploadRepoBinaryFile(
    owner, repo, imagePath, file, ghToken,
    `[academicflow] upload ocr image ${imagePath}`,
  )

  // 2. dispatch 到 runner；令牌随 input_json 传入，runner 识别成功后把临时图片删掉
  await dispatchAiCall(
    taskId, 'simpletex_ocr',
    { image_path: imagePath, model, token: cred.token, secret: cred.secret },
    outputPath, 1, owner, repo, ghToken,
  )

  // 3. 轮询结果
  return pollOcrResult(outputPath, owner, repo, ghToken)
}
