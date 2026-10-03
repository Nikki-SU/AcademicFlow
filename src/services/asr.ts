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

  // Hunyuan-MT-7B 这类专用翻译模型没有默认 system prompt，官方模板就是「只发一条
  // user 消息」（把指令和正文写在一起）；给它发 system 消息会偏离训练分布。
  // 其余通用对话模型沿用 system + user 的结构，指令更稳。
  const isDedicatedMt = /hunyuan-mt/i.test(model)
  const messages = isDedicatedMt
    ? [{ role: 'user', content: `把下面的文本翻译成中文，不要额外解释：\n\n${text}` }]
    : [
        {
          role: 'system',
          content:
            '你是翻译引擎。只翻译，不改写、不添加、不省略；保持原意与语气，' +
            '数字、专有名词、术语原样保留。直接输出译文，不要任何解释、标注或前后缀。',
        },
        { role: 'user', content: text },
      ]

  const res = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages,
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

/**
 * 转写稿 AI 修饰后的一个段落块。
 * - `text`：修饰后的段落（与讲者原语种一致）。
 * - `translation`：原文为非中文时的中文翻译；原文为中文时为空串。
 * - `unclear`：识别质量极差、无法判断原意的段落（原样保留，前端标红）。
 */
export interface TranscriptBlock {
  text: string
  translation: string
  unclear: boolean
}

/** 修饰模型的调用约束：转写稿整理是「搬运 + 轻修饰」，禁止它做任何推理 */
const POLISH_SYSTEM_PROMPT = `你是转写稿整理引擎。输入是一段语音自动转写的原始文本（含口语、口头禅、重复、结巴、错别字）。
请把它整理成便于阅读的书面段落。规则：
1. 只做「必要的修饰」：去掉口头禅（嗯、那个、就是……）、语气词、无意义重复与结巴；补全明显的标点与断句。
2. 绝不压缩信息、绝不总结、绝不增删事实；专有名词、数字、术语一律原样保留。
3. 按语义重新分段，每段是一个完整的意思单元。
4. 遇到识别质量极差、无法判断原意的片段：不要猜测、不要编造，**原样保留**该片段，并把该段 unclear 置为 true。
5. 原文主要为英文时，为每一段给出忠实的中文翻译；原文主要为中文时，translation 一律为空字符串。
6. **只输出 JSON**，不要任何解释、不要 Markdown 代码块围栏、不要前后缀文字。

输出 JSON 结构（字段名固定，不可增删、不可改名、不可嵌套多余层级）：
{"blocks":[{"text":"段落原文","translation":"中文翻译或空串","unclear":false}]}`

/** 剥掉模型可能多包的一层 Markdown 代码块围栏（这是允许的等价形态） */
function stripCodeFence(s: string): string {
  const t = s.trim()
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  return m ? m[1].trim() : t
}

/**
 * 对转写原文做 AI 修饰：重新分段、去掉口语，得到书面化的段落块。
 *
 * **契约先行（ADJ-68 / ADJ-70）**：prompt 里把 schema 逐字约束死；解析层只兜「模型多包一层代码块」
 * 这一种等价形态，其余（缺 blocks / text 非字符串 / 非 JSON）一律抛**可读错误**，绝不静默降级成空结果。
 */
export async function polishTranscript(
  rawText: string,
  cfg: AsrConfig,
  opts: { translateToZh: boolean },
  signal?: AbortSignal,
): Promise<TranscriptBlock[]> {
  const model = cfg.model.trim()
  if (!model) throw new Error('未配置转写稿修饰模型')
  const source = rawText.trim()
  if (!source) throw new Error('没有可修饰的转写内容')

  const userHint = opts.translateToZh
    ? '（若原文主要为英文，请逐段给出中文翻译；若原文为中文，translation 填空串）'
    : '（不要翻译：所有 translation 一律填空串）'

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
        { role: 'system', content: POLISH_SYSTEM_PROMPT },
        { role: 'user', content: `${userHint}\n\n${source}` },
      ],
    }),
    signal,
  })

  if (!res.ok) {
    const snippet = await errorSnippet(res)
    throw new Error(`转写稿修饰失败（HTTP ${res.status}）：${snippet}`)
  }

  const data = (await res.json().catch(() => null)) as
    | { choices?: Array<{ message?: { content?: unknown } }> }
    | null
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('转写稿修饰失败：响应缺少 choices[0].message.content')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(content))
  } catch {
    throw new Error('转写稿修饰失败：模型返回的不是合法 JSON，请重试')
  }

  const blocks = (parsed as { blocks?: unknown } | null)?.blocks
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error('转写稿修饰失败：返回缺少 blocks 数组，请重试')
  }

  return blocks.map((b, i) => {
    const item = b as { text?: unknown; translation?: unknown; unclear?: unknown } | null
    const text = typeof item?.text === 'string' ? item.text.trim() : ''
    if (!text) {
      throw new Error(`转写稿修饰失败：第 ${i + 1} 段缺少 text 文本，请重试`)
    }
    const translation = item?.translation
    if (translation !== undefined && typeof translation !== 'string') {
      throw new Error(`转写稿修饰失败：第 ${i + 1} 段的 translation 不是字符串，请重试`)
    }
    return {
      text,
      translation: typeof translation === 'string' ? translation.trim() : '',
      // unclear 省略 = 该段无存疑（等价形态）；给了就必须是布尔
      unclear: item?.unclear === true,
    }
  })
}

/**
 * 按浏览器支持的音频容器挑一个 MediaRecorder mimeType。
 * 录音与连通性测试共用同一套，保证「测试能过 = 录音能过」。
 */
export function pickAudioMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
  return candidates.find((t) => MediaRecorder.isTypeSupported(t))
}

/**
 * 由音频 Blob 的 mimeType 推一个带正确扩展名的文件名。
 * 后端（硅基流动）按扩展名判容器 —— 一律叫 .webm 会让 Safari 录出的
 * mp4/aac 被当成 webm 解析而失败；这里按真实类型给名。
 */
export function audioFileNameFor(blob: Blob): string {
  const t = (blob.type || '').toLowerCase()
  if (t.includes('webm')) return 'audio.webm'
  if (t.includes('ogg')) return 'audio.ogg'
  if (t.includes('mp4') || t.includes('aac') || t.includes('m4a')) return 'audio.m4a'
  if (t.includes('mpeg') || t.includes('mp3')) return 'audio.mp3'
  if (t.includes('wav')) return 'audio.wav'
  return 'audio.webm'
}

/**
 * 探测 Key 是否可用：GET {baseUrl}/models（OpenAI 兼容）。
 * 返回可用的模型数量；非 2xx 抛错（带响应片段）。
 */
export async function probeModels(cfg: AsrConfig, signal?: AbortSignal): Promise<number> {
  const res = await fetch(joinUrl(cfg.baseUrl, '/models'), {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal,
  })
  if (!res.ok) {
    const snippet = await errorSnippet(res)
    throw new Error(`HTTP ${res.status}：${snippet}`)
  }
  const data = (await res.json().catch(() => null)) as { data?: unknown[] } | null
  return Array.isArray(data?.data) ? data.data.length : 0
}

/**
 * 录一小段真实音频（走与生产录音完全相同的 MediaRecorder 链路）。
 * 连通性测试用它去真调转写端点，才能证明「录音能不能出字」。
 */
export async function recordShortClip(ms = 2500): Promise<Blob> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前环境无法录音（需 HTTPS 或 localhost，且浏览器支持麦克风）')
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  try {
    const mimeType = pickAudioMimeType()
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    const chunks: BlobPart[] = []
    const done = new Promise<Blob>((resolve) => {
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data)
      }
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }))
    })
    recorder.start()
    await new Promise((r) => setTimeout(r, ms))
    recorder.stop()
    const blob = await done
    if (blob.size === 0) throw new Error('录到的音频为空（麦克风可能被静音或占用）')
    return blob
  } finally {
    stream.getTracks().forEach((t) => t.stop())
  }
}

/** 连通性测试用的配置（来自设置页） */
export interface AsrProbeConfig {
  baseUrl: string
  apiKey: string
  asrModel: string
  translateModel: string
  translateToZh: boolean
}

export type AsrProbeStepKey = 'key' | 'transcribe' | 'translate'
export type AsrStepStatus = 'running' | 'done' | 'error' | 'skip'
export type AsrStepReporter = (key: AsrProbeStepKey, status: AsrStepStatus, detail?: string) => void

/** 轻量校验：Key + 网络 + 端点（GET /models）。启动时用它，不碰麦克风、不弹权限。 */
export async function probeAsrKey(
  cfg: AsrProbeConfig,
  signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
  if (!cfg.apiKey.trim()) return { ok: false, detail: '未配置 API Key' }
  try {
    const n = await probeModels({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.asrModel }, signal)
    return { ok: true, detail: `Key 有效 · 可用模型 ${n} 个` }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 完整连通性测试（设置页「测试」按钮用）：
 *   ① Key 校验（GET /models）
 *   ② 真录 2.5 秒 → 走生产同款 MediaRecorder → 真调 /audio/transcriptions
 *   ③ 若开了翻译 → 真调 /chat/completions
 * 任一步失败即如实报错，绝不把「配了 Key」当成「能用」。
 */
export async function probeAsrFull(
  cfg: AsrProbeConfig,
  onStep?: AsrStepReporter,
): Promise<{ ok: boolean }> {
  const report = onStep ?? (() => {})

  // ① Key
  report('key', 'running')
  const key = await probeAsrKey(cfg)
  if (!key.ok) {
    report('key', 'error', key.detail)
    report('transcribe', 'skip', 'Key 不通，跳过')
    report('translate', 'skip', 'Key 不通，跳过')
    return { ok: false }
  }
  report('key', 'done', key.detail)

  // ② 真录音 → 真转写（与生产完全同一条链路）
  report('transcribe', 'running', '正在录 2.5 秒真实音频…')
  try {
    const blob = await recordShortClip(2500)
    const { text, language } = await transcribeAudio(
      blob,
      { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.asrModel },
      undefined,
      audioFileNameFor(blob),
    )
    const snippet = text.trim()
    report(
      'transcribe',
      'done',
      snippet
        ? `识别到（${language}）：“${snippet.slice(0, 40)}${snippet.length > 40 ? '…' : ''}”`
        : '端点返回 200，但这段没识别到文字（静默 / 没说话都正常，说明链路是通的）',
    )
  } catch (e) {
    report('transcribe', 'error', e instanceof Error ? e.message : String(e))
    report('translate', 'skip', '转写不通，跳过')
    return { ok: false }
  }

  // ③ 翻译（可选）
  if (!cfg.translateToZh || !cfg.translateModel.trim()) {
    report('translate', 'skip', '未启用翻译（可跳过）')
    return { ok: true }
  }
  report('translate', 'running')
  try {
    const out = await translateText('Hello, this is a connectivity test.', {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.translateModel,
    })
    report('translate', 'done', `译回：“${out.slice(0, 40)}${out.length > 40 ? '…' : ''}”`)
    return { ok: true }
  } catch (e) {
    report('translate', 'error', e instanceof Error ? e.message : String(e))
    return { ok: false }
  }
}
