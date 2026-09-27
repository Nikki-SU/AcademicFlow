/**
 * SimpleTex 公式识图（图片 → LaTeX）
 * ------------------------------------------------------------
 * 官方文档：https://doc.simpletex.cn/zh/api/
 *   POST https://server.simpletex.cn/api/latex_ocr        标准模型（准确，500 次/日）
 *   POST https://server.simpletex.cn/api/latex_ocr_turbo  轻量模型（快，2000 次/日）
 *   请求体：multipart/form-data，图片字段名固定为 `file`
 *
 * 鉴权：只用 UAT（用户授权令牌），header { token }。
 *   UAT 在 https://simpletex.cn/user/center 的「用户授权令牌」里创建，**只有一个 key**，
 *   不需要 APP ID / APP Secret。所以设置页只收一个字段。
 *   （后端 handler 仍兼容 APP 签名，但前端不再要求，避免让用户填用不上的第二把钥匙。）
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
  /** UAT（用户授权令牌）—— 唯一的一把钥匙 */
  token: string
}

export async function loadSimpleTexCredentials(): Promise<SimpleTexCredentials> {
  const token = await getSetting(SETTING_KEYS.SIMPLETEX_TOKEN)
  return { token: (token || '').trim() }
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

/** 识图链路的阶段（设置页端到端测试用来点亮步骤条） */
export type SimpleTexStage = 'upload' | 'dispatch' | 'poll'

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
 * @param cred IndexedDB 里的 SimpleTex UAT，随 input_json 传给 runner
 * @param model 'standard' 更准 | 'turbo' 更快
 * @param onStage 每个阶段开始前回调（设置页端到端测试用来点亮步骤条）
 */
export async function recognizeFormulaImage(
  file: File | Blob,
  cred: SimpleTexCredentials,
  model: SimpleTexModel = 'standard',
  onStage?: (stage: SimpleTexStage) => void,
): Promise<SimpleTexResult> {
  if (!cred.token) {
    throw new Error('还没配置 SimpleTex 令牌。请到「设置 → 文献处理 → SimpleTex 令牌」里填入 UAT。')
  }

  const { token: ghToken, owner, repo } = getBackendContext()

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const imagePath = `temp/ai/ocr/ocr_${stamp}.${extOf(file)}`
  const outputPath = `temp/ai/ocr/ocr_${stamp}.json`
  const taskId = `ocr_${stamp}`

  // 1. 图片先提交进私库（浏览器直连必被 CORS 拦，见文件头注释）
  onStage?.('upload')
  await uploadRepoBinaryFile(
    owner, repo, imagePath, file, ghToken,
    `[academicflow] upload ocr image ${imagePath}`,
  )

  // 2. dispatch 到 runner；令牌随 input_json 传入，runner 识别成功后把临时图片删掉
  onStage?.('dispatch')
  await dispatchAiCall(
    taskId, 'simpletex_ocr',
    { image_path: imagePath, model, token: cred.token },
    outputPath, 1, owner, repo, ghToken,
  )

  // 3. 轮询结果
  onStage?.('poll')
  return pollOcrResult(outputPath, owner, repo, ghToken)
}

/**
 * 设置页「公式识图」自测用的内置样张
 * ------------------------------------------------------------
 * 一张**真实的公式位图**（PNG 223×75）：一元二次方程求根公式
 *   x = ( −b ± √(b²−4ac) ) / 2a
 * 点设置页的「端到端测试」时，它会被当作一张普通截图提交，走完整链路
 * （私库 → Actions → SimpleTex），返回的 LaTeX 原样贴在界面上 ——
 * 是不是真识别，和左边这张图对一眼就知道。
 */
const SAMPLE_IMAGE_B64 = `
iVBORw0KGgoAAAANSUhEUgAAAN8AAABLBAMAAAACIE9KAAAAMFBMVEX///8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAAAAAAAAAAAAAAAAAAAAAAv3aB7AAAAD3RSTlMAEM1EVDKZu93vq2Z2iSI6kd4sAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAE
nElEQVRoBe1ZPYgbRxR+q9WuTl5JJxxspfOSJj+QSJDCxgR0hQsXBql24VOK1BIk+IIK51wkEBe5A8dNwD5hDoydYMuFCSGF
7CqkkiCBxNWJK4JdWUnsyzk/t35vZmd3ZrUm8nI7hdGD251573vvm3lvZyW9A0gkXlKZJKKDV5PyeQkJ7ydbZ2Iv49/Erskc
i+vJ/BJ7LY6Ea+HahbEYJ7rbH381g9+wDD5wEyp/zuDwfEh2oJTH7sdCLwNwoNMH42k5FsOUD59vEpa8suBMkDthp3vhd7ww
YO4SwK0l0sVLNV4ta49M5Fk8YZ6WwYC5xwDt2EWxKAVPDhY/rruyPp4QSwjAgEYT4JMl2UMZP5iBcEtZbzwhlhBAAI2nCocy
2ZyBsFqTXWIJHSohCKCtFF12BufODIQepSuQWMJ8i+wC2FiiWaxUrP8nNHcV11jCAa1JAK0vFQdlcnMGwuLO4ZVzoVcs4Wdk
F8AHzRAdGZkjn/DoSus3WqTxQ3czgoHMzjkYhDHiCJ09cvKBpXfAuhsN4s9zwAkPXILTrOLfjaDYj4AX/8Ij7ZIyH37kdTgo
e57dF1p084GVMRRqTD19+cAnrI6hSBW38dAO3Aiuvo6LZ1swT6Cc/IiuYw5q87deg0050Pj8tTfWfDMHhVerxQntf/BF+Afq
t1oAG70QwEZtVEpvNzml2yf5ibsgAXOUhkgIMc0BJ1zGPRT/ownu8hT+HQly5wKs1TBb4cmSCc84Xh+DZdn+o8BIGCL92Ses
jjBpGDLzN2lRWO4ocyeaYNBy6zwk2WRCzMcqqhZ6eJkCqmEIUepxQstr8hfvcrgPsnPhuV4X0wjhEKsOvIRRYOARDHJlTshe
4A0XYBiGDUBQwFzD2ihQqDtcpNK/xYxRYOARDPxKPbbxuYf2XfzrBLZwUMAnSrxDSKsSFjE75hOGjgLDEPIoixWyd1Cz0TwA
9DxOiYmEVGAhKqHhdSDD1xkFCgf1ToSUC3wBVGDQQiOeFUUMtIrPHTKohNDeg3qTOUSBSpRg4iBhCR/O7V34HvKrqD9aDox8
8GOZkkVivYty7EO6jpkCL4924HV/HAKFMeZuezXcwNjsvQkdMC8DnB5FUdnu2THXTb/aAHLeIV5CPI4BMBoinN/HE34FnO7X
UOli1MPda/dC40wjy/ulMxNw30BVOsU6pU4nUacsSEdGC6859ZRpoZ2TzDMwz8A+ZyD4zqZnMAE9PAHLZJ/zNQ83z8A8Ay9p
Bn7d/UbrzrZvW7c+1chofIE/2b2xPkZ7Cbk2XH2EeaIaavxCzHoDdfwdqUsa1P1Ypt/RmuTgRSSqK614DcyshubK2dL7GsiI
Ys3Fy/WmdVXTw2PS71LqAW6xbjQtIV1ZoBK2+9iWctMlEtGpsWRRb1FusQhjCneHNpihoyha+ymQyCHrmExYxgYKaz7KlnTG
vJE/xK+0rKeYDokc9WEN4BXWHLS1nH+DPgzfY83B/BPoyUtJZ3ywiXF/guEI6zgxOumQyFHfxmb1qSvwqAel6qrTl02pjFkj
H/8dX9yD45l1bN2nLQ32y8sF+PZG31i5+cJ0zwCVaMk3Di9FfgAAAABJRU5ErkJggg==
`

/** 内置样张的 data URL（界面里 <img> 直接能显示） */
export const SIMPLETEX_SAMPLE_DATA_URL =
  'data:image/png;base64,' + SAMPLE_IMAGE_B64.replace(/\s/g, '')

/** 内置样张的 Blob（端到端测试提交给后端用） */
export function getSimpleTexSampleImage(): Blob {
  const bin = atob(SAMPLE_IMAGE_B64.replace(/\s/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: 'image/png' })
}
