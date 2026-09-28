/**
 * 硅基流动 ASR + 翻译直连服务（浏览器 → 硅基流动）
 * -------------------------------------------------
 * ⚠️ 「前端不直连模型」根原则的**明确例外**，仅限会议/课程转写与翻译。
 * 端点（OpenAI 兼容）：
 *   POST {baseUrl}/audio/transcriptions   表单 file + model
 *   POST {baseUrl}/chat/completions       翻译
 * 实测硅基流动 CORS 允许任意源（预检 204 + `Access-Control-Allow-Origin: *`），
 * 无需代理。音频只在内存里走一趟，转写完即丢弃，不落任何存储。
 */

/** 转写 / 翻译共用同一种端点配置（同一 baseUrl + 同一 apiKey） */
export interface AsrConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/** 拼接端点：去尾斜杠后拼上固定路径 */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}${path}`
}

/** 文本是否含中日韩汉字（无 language 字段时的兜底判定） */
function hasCjk(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text)
}

/** 取响应片段用于报错（不让上层收到一句干巴巴的「失败」） */
async function errorSnippet(res: Response): Promise<string> {
  const body = await res.text().catch(() => '')
  return body.replace(/\s+/g, ' ').trim().slice(0, 300) || '(空响应)'
}

/**
 * 转写一段音频。
 * - 非 2xx：抛带状态码与响应片段的 Error（**不吞**）。
 * - language：响应含 language/lang 就用它，否则按文本是否含 CJK 判 'zh' / 'other'。
 */
export async function transcribeAudio(
  blob: Blob,
  cfg: AsrConfig,
  signal?: AbortSignal,
  /** 上传文件名（后端按扩展名判容器）；默认 webm/opus = 录音产物 */
  fileName = 'audio.webm',
): Promise<{ text: string; language: string }> {
  const form = new FormData()
  // 文件名给个占位（很多后端按扩展名判容器；webm/opus 就是我们录出来的格式）
  form.append('file', blob, fileName)
  form.append('model', cfg.model)

  const res = await fetch(joinUrl(cfg.baseUrl, '/audio/transcriptions'), {
    method: 'POST',
    // 只带 Authorization；Content-Type 交给浏览器自动加 multipart boundary
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
    signal,
  })

  if (!res.ok) {
    const snippet = await errorSnippet(res)
    throw new Error(`转写失败（HTTP ${res.status}）：${snippet}`)
  }

  const data = (await res.json().catch(() => null)) as
    | { text?: unknown; language?: unknown; lang?: unknown }
    | null
  if (!data) throw new Error('转写失败：响应不是合法 JSON')

  const text = String(data.text ?? '')
  const rawLang = data.language ?? data.lang
  const language =
    rawLang !== undefined && rawLang !== null && String(rawLang).trim() !== ''
      ? String(rawLang).trim()
      : hasCjk(text)
        ? 'zh'
        : 'other'

  return { text, language }
}

/**
 * 把文本翻译成目标语言（默认中文）。
 * - 未配置翻译模型（空 model）：直接抛「未配置翻译模型」。
 * - 非 2xx：抛带状态码与响应片段的 Error。
 * - 返回 choices[0].message.content。
 */
export async function translateText(
  text: string,
  cfg: AsrConfig,
  signal?: AbortSignal,
): Promise<string> {
  const model = cfg.model.trim()
  if (!model) throw new Error('未配置翻译模型')

  const res = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            '你是翻译引擎。只翻译，不改写、不添加、不省略；保持原意与语气，' +
            '数字、专有名词、术语原样保留。直接输出译文，不要任何解释、标注或前后缀。',
        },
        { role: 'user', content: text },
      ],
    }),
    signal,
  })

  if (!res.ok) {
    const snippet = await errorSnippet(res)
    throw new Error(`翻译失败（HTTP ${res.status}）：${snippet}`)
  }

  const data = (await res.json().catch(() => null)) as
    | { choices?: Array<{ message?: { content?: unknown } }> }
    | null
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('翻译失败：响应缺少 choices[0].message.content')
  }
  return content.trim()
}
