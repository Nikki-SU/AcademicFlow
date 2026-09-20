/**
 * SimpleTex 公式识图（图片 → LaTeX）
 * ------------------------------------------------------------
 * 官方文档：https://doc.simpletex.cn/zh/api/
 *   POST https://server.simpletex.cn/api/latex_ocr        标准模型（准确，500 次/日）
 *   POST https://server.simpletex.cn/api/latex_ocr_turbo  轻量模型（快，2000 次/日）
 *   请求体：multipart/form-data，图片字段名固定为 `file`
 *
 * 鉴权两种（二选一，token 存本机 IndexedDB，不上服务器）：
 *   1) UAT：header { token }
 *   2) APP：header { app-id, random-str, timestamp, sign }
 *      sign = MD5( 按 key 升序用 & 连接 "k=v" 后追加 "&secret=<APP Secret>" )
 *      注意：二进制文件参数不参与签名；APP Secret 不放进请求体。
 *
 * ⚠️ 坑（不隐瞒）：这是浏览器直连 SimpleTex 服务器。能否成功取决于对方是否放行
 *    CORS。实测该域名的接口是通的，但 CORS 头由对方控制，失败会在前端报网络错误。
 *    若被拦，只能改走后端代理（把图片传到私库再让 Actions 调 SimpleTex）。
 */
import { getSetting, SETTING_KEYS } from './db'

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

// ────────────────────────────────────────────────────────────
// MD5（APP 模式签名用；Web Crypto 不提供 MD5，故自带一份）
// 实现取自 RFC 1321 的标准算法，纯函数、无依赖。
// ────────────────────────────────────────────────────────────
function md5(input: string): string {
  const utf8 = unescape(encodeURIComponent(input))

  function add32(a: number, b: number) {
    return (a + b) & 0xffffffff
  }
  function cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
    a = add32(add32(a, q), add32(x, t))
    return add32((a << s) | (a >>> (32 - s)), b)
  }
  function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn((b & c) | (~b & d), a, b, x, s, t)
  }
  function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn((b & d) | (c & ~d), a, b, x, s, t)
  }
  function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn(b ^ c ^ d, a, b, x, s, t)
  }
  function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn(c ^ (b | ~d), a, b, x, s, t)
  }

  function cycle(x: number[], k: number[]) {
    let a = x[0]
    let b = x[1]
    let c = x[2]
    let d = x[3]

    a = ff(a, b, c, d, k[0], 7, -680876936)
    d = ff(d, a, b, c, k[1], 12, -389564586)
    c = ff(c, d, a, b, k[2], 17, 606105819)
    b = ff(b, c, d, a, k[3], 22, -1044525330)
    a = ff(a, b, c, d, k[4], 7, -176418897)
    d = ff(d, a, b, c, k[5], 12, 1200080426)
    c = ff(c, d, a, b, k[6], 17, -1473231341)
    b = ff(b, c, d, a, k[7], 22, -45705983)
    a = ff(a, b, c, d, k[8], 7, 1770035416)
    d = ff(d, a, b, c, k[9], 12, -1958414417)
    c = ff(c, d, a, b, k[10], 17, -42063)
    b = ff(b, c, d, a, k[11], 22, -1990404162)
    a = ff(a, b, c, d, k[12], 7, 1804603682)
    d = ff(d, a, b, c, k[13], 12, -40341101)
    c = ff(c, d, a, b, k[14], 17, -1502002290)
    b = ff(b, c, d, a, k[15], 22, 1236535329)

    a = gg(a, b, c, d, k[1], 5, -165796510)
    d = gg(d, a, b, c, k[6], 9, -1069501632)
    c = gg(c, d, a, b, k[11], 14, 643717713)
    b = gg(b, c, d, a, k[0], 20, -373897302)
    a = gg(a, b, c, d, k[5], 5, -701558691)
    d = gg(d, a, b, c, k[10], 9, 38016083)
    c = gg(c, d, a, b, k[15], 14, -660478335)
    b = gg(b, c, d, a, k[4], 20, -405537848)
    a = gg(a, b, c, d, k[9], 5, 568446438)
    d = gg(d, a, b, c, k[14], 9, -1019803690)
    c = gg(c, d, a, b, k[3], 14, -187363961)
    b = gg(b, c, d, a, k[8], 20, 1163531501)
    a = gg(a, b, c, d, k[13], 5, -1444681467)
    d = gg(d, a, b, c, k[2], 9, -51403784)
    c = gg(c, d, a, b, k[7], 14, 1735328473)
    b = gg(b, c, d, a, k[12], 20, -1926607734)

    a = hh(a, b, c, d, k[5], 4, -378558)
    d = hh(d, a, b, c, k[8], 11, -2022574463)
    c = hh(c, d, a, b, k[11], 16, 1839030562)
    b = hh(b, c, d, a, k[14], 23, -35309556)
    a = hh(a, b, c, d, k[1], 4, -1530992060)
    d = hh(d, a, b, c, k[4], 11, 1272893353)
    c = hh(c, d, a, b, k[7], 16, -155497632)
    b = hh(b, c, d, a, k[10], 23, -1094730640)
    a = hh(a, b, c, d, k[13], 4, 681279174)
    d = hh(d, a, b, c, k[0], 11, -358537222)
    c = hh(c, d, a, b, k[3], 16, -722521979)
    b = hh(b, c, d, a, k[6], 23, 76029189)
    a = hh(a, b, c, d, k[9], 4, -640364487)
    d = hh(d, a, b, c, k[12], 11, -421815835)
    c = hh(c, d, a, b, k[15], 16, 530742520)
    b = hh(b, c, d, a, k[2], 23, -995338651)

    a = ii(a, b, c, d, k[0], 6, -198630844)
    d = ii(d, a, b, c, k[7], 10, 1126891415)
    c = ii(c, d, a, b, k[14], 15, -1416354905)
    b = ii(b, c, d, a, k[5], 21, -57434055)
    a = ii(a, b, c, d, k[12], 6, 1700485571)
    d = ii(d, a, b, c, k[3], 10, -1894986606)
    c = ii(c, d, a, b, k[10], 15, -1051523)
    b = ii(b, c, d, a, k[1], 21, -2054922799)
    a = ii(a, b, c, d, k[8], 6, 1873313359)
    d = ii(d, a, b, c, k[15], 10, -30611744)
    c = ii(c, d, a, b, k[6], 15, -1560198380)
    b = ii(b, c, d, a, k[13], 21, 1309151649)
    a = ii(a, b, c, d, k[4], 6, -145523070)
    d = ii(d, a, b, c, k[11], 10, -1120210379)
    c = ii(c, d, a, b, k[2], 15, 718787259)
    b = ii(b, c, d, a, k[9], 21, -343485551)

    x[0] = add32(a, x[0])
    x[1] = add32(b, x[1])
    x[2] = add32(c, x[2])
    x[3] = add32(d, x[3])
  }

  function md5blk(s: string) {
    const md5blks: number[] = []
    for (let i = 0; i < 64; i += 4) {
      md5blks[i >> 2] =
        s.charCodeAt(i) +
        (s.charCodeAt(i + 1) << 8) +
        (s.charCodeAt(i + 2) << 16) +
        (s.charCodeAt(i + 3) << 24)
    }
    return md5blks
  }

  const n = utf8.length
  const state = [1732584193, -271733879, -1732584194, 271733878]
  let i: number
  for (i = 64; i <= n; i += 64) cycle(state, md5blk(utf8.substring(i - 64, i)))

  const tail = utf8.substring(i - 64)
  const block = new Array<number>(16).fill(0)
  for (i = 0; i < tail.length; i++) block[i >> 2] |= tail.charCodeAt(i) << ((i % 4) << 3)
  block[i >> 2] |= 0x80 << ((i % 4) << 3)

  if (i > 55) {
    cycle(state, block)
    for (i = 0; i < 16; i++) block[i] = 0
  }
  block[14] = n * 8
  cycle(state, block)

  const hex = '0123456789abcdef'
  let out = ''
  for (i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const byte = (state[i] >> (j * 8)) & 0xff
      out += hex[(byte >> 4) & 0x0f] + hex[byte & 0x0f]
    }
  }
  return out
}

function randomStr16(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  const arr = new Uint32Array(16)
  crypto.getRandomValues(arr)
  for (let i = 0; i < 16; i++) s += chars[arr[i] % chars.length]
  return s
}

/**
 * 构造鉴权 header。
 * 有 secret → 走 APP 签名；没有 → 当作 UAT（header.token）。
 */
function authHeaders(cred: SimpleTexCredentials): Record<string, string> {
  if (cred.secret) {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const random = randomStr16()
    // 表单里只有 file 一个字段，且二进制不参与签名 → 待签名 key 只有这三个
    const pairs: Record<string, string> = {
      'app-id': cred.token,
      'random-str': random,
      timestamp,
    }
    const sorted = Object.keys(pairs).sort()
    const joined = sorted.map((k) => `${k}=${pairs[k]}`).join('&')
    const sign = md5(`${joined}&secret=${cred.secret}`)
    return { 'app-id': cred.token, 'random-str': random, timestamp, sign }
  }
  return { token: cred.token }
}

export interface SimpleTexResult {
  latex: string
  requestId: string
}

/**
 * 识图 → LaTeX。
 * @param file 图片文件（png/jpg 截图，建议先裁到只有公式区域）
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

  const form = new FormData()
  form.append('file', file)

  const url =
    model === 'turbo'
      ? 'https://server.simpletex.cn/api/latex_ocr_turbo'
      : 'https://server.simpletex.cn/api/latex_ocr'

  let resp: Response
  try {
    resp = await fetch(url, { method: 'POST', headers: authHeaders(cred), body: form })
  } catch (err) {
    // 网络层直接失败 —— 多半是 CORS 被拦（见文件头注释）
    throw new Error(
      `调用 SimpleTex 失败（网络层）：${err instanceof Error ? err.message : String(err)}。` +
        '若这是跨域被拦，浏览器控制台会有一条 CORS 报错。',
    )
  }

  const text = await resp.text()
  let data: { status?: boolean; res?: { latex?: string; text?: string }; request_id?: string; message?: string }
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`SimpleTex 返回了非 JSON（HTTP ${resp.status}）：${text.slice(0, 200)}`)
  }

  if (data.status === false) {
    throw new Error(`SimpleTex 识别失败：${data.message || '未知错误'}（${text.slice(0, 200)}）`)
  }
  const latex = data.res?.latex || data.res?.text || ''
  if (!latex) throw new Error(`SimpleTex 没返回公式源码：${text.slice(0, 200)}`)
  return { latex, requestId: data.request_id || '' }
}
