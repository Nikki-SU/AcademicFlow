/**
 * 阅读页「问 AI」面板
 * -------------------------------------------------
 * 图书和文献共用（两者只在 pipeline 上有区别，阅读侧完全对称）。
 *
 * 两种回答路径，由「可信检索」开关决定：
 *   开 → 先联网检索一轮，把「正文 + 检索结果」一起作为 ground truth 喂给 AI-1，
 *        AI-2 逐条核查有没有编造（回答带 pass/fail 审阅结论）
 *   关 → 不喂原文，让 DeepSeek 联网检索后自由回答（附来源列表）
 *
 * 两条路都会联网 —— 区别在于回答受不受「依据」约束、有没有 AI-2 审阅。
 *
 * 对话记录按「一篇文献 / 一本书一个大对话」持久化到
 *   literatures/{slug}/ai-chat.md 或 textbooks/{书名}/ai-chat.md
 * 格式与写作页的 memory.md 一致（人可读、可手改）：
 *   # 问 AI · 书名
 *   ## 用户 · 2026-09-21 10:30
 *   内容
 *   ## AI · 2026-09-21 10:31 · pass
 *   内容
 * 有 `· pass|fail` 后缀 = 这条走了可信检索（双引擎审阅）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Eraser,
  Globe,
  Loader2,
  Quote,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
} from 'lucide-react'
import { toast } from 'sonner'
import { callWebSearch, type WebSearchSource } from '../services/ai/web-search'
import { runDualEngine } from '../services/ai/dual-engine'
import { isAbortError } from '../services/ai/abort'
import { useSettingsStore } from '../stores/settings'
import { loadReadingChat, saveReadingChat, type DocRef } from '../services/readingDocData'
import { renderMarkdownToHtml } from '../services/markdown-renderer'

export interface ReadingChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  /** 有值 = 走了可信检索（双引擎），值是 AI-2 的审阅结论 */
  reviewStatus?: 'pass' | 'fail'
}

interface Props {
  docRef: DocRef | null
  docTitle: string
  /** 当前对象的正文（文献取当前显示模式的内容，图书取 content.md） */
  docMarkdown: string
  /** 正文里当前选中的文字，可能为空 */
  selectedText: string
}

/** 源材料窗口大小：选中处前后各取这么多字符 */
const SOURCE_WINDOW = 4000
/** 不选文字时，正文最多送这么多字符当依据 */
const SOURCE_MAX = 12000
/** 多轮上下文最多回带多少字符 */
const HISTORY_MAX = 3000

/** 联网检索用的系统提示（两条路径共用） */
const SEARCH_SYSTEM =
  '你是学术阅读助手。用户在读一篇文献或一本书，会就其中某个词或某段文字提问。' +
  '先联网检索再回答，说明该概念在学术界的通行含义、学科背景和典型用法。' +
  '引用检索到的说法要给出处；不确定的地方明确说不确定，不要编造文献、作者或出处。用中文回答。'

/**
 * 注入「依据」的检索来源条数上限。
 *
 * 注意：检索正文**不截断** —— 双引擎的 AI-2 是靠 `sourceMaterial.includes(span)`
 * 做字面引证核对的，正文一旦从中间截断，AI-2 引用的片段就会跨过断点、匹配不上，
 * 于是明明判定 supported 也被算成核验失败（实测踩过）。控制体量要靠 AI-2 的
 * 输出预算（后端已从 16000 提到 32000），不是靠截断依据。
 */
const SEARCH_MATERIAL_SOURCES = 8

function formatMinute(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function messagesToMd(title: string, messages: ReadingChatMessage[]): string {
  const body = messages
    .map((m) => {
      const who = m.role === 'user' ? '用户' : 'AI'
      const status = m.role === 'assistant' && m.reviewStatus ? ` · ${m.reviewStatus}` : ''
      return `## ${who} · ${formatMinute(m.createdAt)}${status}\n${m.content.trim()}`
    })
    .join('\n\n')
  return `# 问 AI · ${title}\n\n${body}${body ? '\n' : ''}`
}

function mdToMessages(md: string): ReadingChatMessage[] {
  const out: ReadingChatMessage[] = []
  let cur: { role: 'user' | 'assistant'; status?: 'pass' | 'fail'; time: number; buf: string[] } | null = null

  const flush = () => {
    if (!cur) return
    const content = cur.buf.join('\n').trim()
    if (content) {
      out.push({
        id: `${cur.time}_${out.length}`,
        createdAt: cur.time,
        role: cur.role,
        content,
        reviewStatus: cur.status,
      })
    }
    cur = null
  }

  for (const line of md.split('\n')) {
    const m = /^##\s+(用户|AI)\s*·\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?:\s*·\s*(pass|fail))?\s*$/.exec(line)
    if (m) {
      flush()
      const parsed = Date.parse(m[2].replace(' ', 'T') + ':00')
      cur = {
        role: m[1] === '用户' ? 'user' : 'assistant',
        status: m[3] as 'pass' | 'fail' | undefined,
        time: Number.isNaN(parsed) ? Date.now() : parsed,
        buf: [],
      }
      continue
    }
    if (cur) cur.buf.push(line)
  }
  flush()
  return out
}

/**
 * 构造可信检索的源材料（唯一 ground truth）。
 * 选中文字一定放进去 —— 否则 AI-2 会把「引用原文」判成 AI-1 编造的。
 */
function buildSourceMaterial(docMarkdown: string, focusText: string): string {
  const parts: string[] = []
  if (focusText.trim()) parts.push(`【用户选中的正文片段】\n${focusText.trim()}`)

  if (!docMarkdown.trim()) return parts.join('\n\n')

  const idx = focusText.trim() ? docMarkdown.indexOf(focusText.trim()) : -1
  if (idx >= 0) {
    const start = Math.max(0, idx - SOURCE_WINDOW)
    const end = Math.min(docMarkdown.length, idx + focusText.length + SOURCE_WINDOW)
    parts.push(`【选中文片段所在的上下文】\n${docMarkdown.slice(start, end)}`)
  } else {
    parts.push(`【正文开头节选】\n${docMarkdown.slice(0, SOURCE_MAX)}`)
  }
  return parts.join('\n\n')
}

/** 来源列表最多展示几条（DeepSeek 一次检索能返回十几条，全列出来会淹掉答案本身） */
const MAX_SOURCES = 8

/**
 * 联网检索的来源以 Markdown 链接追加到答案末尾。
 * 直接拼进 content 而不是单独存字段 —— 这样对话落盘成 md 之后再读回来，
 * 来源跟着正文一起回来，不需要额外解析。
 */
function appendSources(content: string, sources: WebSearchSource[]): string {
  if (sources.length === 0) return content
  const clean = (s: string) => s.replace(/[\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  const items = sources
    .slice(0, MAX_SOURCES)
    .map((s, i) => `${i + 1}. [${clean(s.title) || s.url}](${s.url})`)
  const more =
    sources.length > MAX_SOURCES ? `\n\n（另有 ${sources.length - MAX_SOURCES} 条来源未列出）` : ''
  return `${content}\n\n---\n\n**参考来源**\n\n${items.join('\n')}${more}`
}

export default function ReadingAskPanel({ docRef, docTitle, docMarkdown, selectedText }: Props) {
  const [messages, setMessages] = useState<ReadingChatMessage[]>([])
  const [input, setInput] = useState('')
  const [trusted, setTrusted] = useState(true)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [loaded, setLoaded] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipSaveRef = useRef(false)
  /** 当前提问的取消句柄：点「停止」就 abort，前端立刻不再收后端输出 */
  const abortRef = useRef<AbortController | null>(null)

  const docKey = docRef ? `${docRef.kind}:${docRef.id}` : ''

  // ── 切换对象：换一个大对话 ──
  useEffect(() => {
    if (!docRef) {
      skipSaveRef.current = true
      setMessages([])
      setLoaded(false)
      return
    }
    let cancelled = false
    setLoaded(false)
    skipSaveRef.current = true
    loadReadingChat(docRef)
      .then((md) => {
        if (cancelled) return
        setMessages(mdToMessages(md))
      })
      .catch((err) => {
        console.error('[ReadingAsk] 加载对话失败:', err)
        if (!cancelled) setMessages([])
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => { cancelled = true }
    // docKey 已经唯一标识对象，docRef 是每渲染新建的对象，不能进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey])

  // ── 对话变化 → 防抖落盘 ──
  useEffect(() => {
    if (!docRef || !loaded) return
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      return
    }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveReadingChat(docRef, messagesToMd(docTitle, messages)).catch((err) =>
        console.error('[ReadingAsk] 保存对话失败:', err),
      )
    }, 800)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, loaded, docKey])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, busy])

  const historyContext = useMemo(() => {
    if (messages.length === 0) return ''
    const tail = messages
      .slice(-6)
      .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
      .join('\n')
    return tail.slice(-HISTORY_MAX)
  }, [messages])

  const send = useCallback(
    async (question: string, useTrusted: boolean, focusText: string) => {
      const q = question.trim()
      if (!q || busy || !docRef) return

      // 联网检索走的是 AI-1 位的凭据，所以它的推理模式也跟 AI-1 位设置走。
      // '' 表示不干预 → 传 undefined，后端就不发 thinking（保持模型默认）。
      const webSearchThinking = useSettingsStore.getState().thinkingAi1 || undefined

      const now = Date.now()
      const userMsg: ReadingChatMessage = {
        id: `u_${now}`,
        role: 'user',
        content: focusText.trim() ? `${q}\n\n> ${focusText.trim()}` : q,
        createdAt: now,
      }
      setMessages((prev) => [...prev, userMsg])
      setInput('')
      setBusy(true)
      setStage('联网检索中…')

      const controller = new AbortController()
      abortRef.current = controller
      const signal = controller.signal

      try {
        if (useTrusted) {
          const { ai1, ai2 } = useSettingsStore.getState().getDualEngineConfig()
          const docMaterial = buildSourceMaterial(docMarkdown, focusText)
          if (!docMaterial.trim()) {
            throw new Error('这篇文章还没有正文，可信检索没有可锚定的原文')
          }

          // 可信检索也要能查外部资料：先联网检索一轮，把结果并进「依据」再交给双引擎。
          // 这样 AI-2 判的是「原文或检索结果有没有支持」，双引擎的判定语义没变，只是依据变宽了。
          setStage('联网检索中…')
          let webMaterial = ''
          let webSources: WebSearchSource[] = []
          try {
            const search = await callWebSearch({
              system: SEARCH_SYSTEM,
              user: [
                docTitle ? `【正在读】${docTitle}` : '',
                focusText.trim() ? `【相关文字】\n${focusText.trim()}` : '',
                `【问题】\n${q}`,
              ].filter(Boolean).join('\n\n'),
              maxUses: 3,
              thinking: webSearchThinking,
              signal,
            })
            webSources = search.sources
            if (search.content.trim()) {
              webMaterial = [
                '【联网检索结果（与正文同为可信依据）】',
                search.content.trim(),
                webSources.length
                  ? `【检索来源】\n${webSources.slice(0, SEARCH_MATERIAL_SOURCES).map((s, i) => `${i + 1}. ${s.title || s.url}`).join('\n')}`
                  : '',
              ].filter(Boolean).join('\n\n')
            }
          } catch (err) {
            // 用户点了「停止」不是检索失败，别吞掉它去跑下一步
            if (isAbortError(err)) throw err
            // 检索失败不该让整个提问失败 —— 退回「只依据正文」的可信检索
            console.warn('[ReadingAsk] 可信检索的联网检索失败，退回只依据正文:', err)
            toast.warning('联网检索失败，本次只依据正文做可信检索')
          }

          const sourceMaterial = [docMaterial, webMaterial].filter(Boolean).join('\n\n')

          const instruction = [
            historyContext ? `【此前的对话】\n${historyContext}` : '',
            `【当前问题】\n${q}`,
            focusText.trim() ? `【需要解释的文字】\n${focusText.trim()}` : '',
          ].filter(Boolean).join('\n\n')

          setStage('AI-1 生成中…')
          const result = await runDualEngine({
            taskType: 'faithfulness_check',
            sourceMaterial,
            ai1Instruction: instruction,
            ai1,
            ai2,
            maxAttempts: 3,
            signal,
            onProgress: (ev) => {
              if (ev.stage === 'ai2_running' || ev.stage === 'ai2_self_correct_running') {
                setStage(`AI-2 审阅中（第 ${ev.attempt}/${ev.maxAttempts} 轮）…`)
              } else if (ev.stage === 'ai1_running') {
                setStage(`AI-1 生成中（第 ${ev.attempt}/${ev.maxAttempts} 轮）…`)
              }
            },
          })

          setMessages((prev) => [
            ...prev,
            {
              id: `a_${Date.now()}`,
              role: 'assistant',
              content: appendSources(result.ai1Output || '（AI 没有返回内容）', webSources),
              createdAt: Date.now(),
              reviewStatus: result.finalPassed ? 'pass' : 'fail',
            },
          ])
        } else {
          // 联网问答：后端用 AI1_* 直连 DeepSeek 的 Anthropic 兼容端点 + 内置
          // web_search 工具，所以这条路径不需要本地 API Key，也就不经过 settings。
          const sys = SEARCH_SYSTEM
          const userContent = [
            historyContext ? `【此前的对话】\n${historyContext}` : '',
            `【正在读】${docTitle}`,
            focusText.trim() ? `【相关文字】\n${focusText.trim()}` : '',
            `【问题】\n${q}`,
          ].filter(Boolean).join('\n\n')

          const resp = await callWebSearch({
            system: sys,
            user: userContent,
            thinking: webSearchThinking,
            signal,
          })

          setMessages((prev) => [
            ...prev,
            {
              id: `a_${Date.now()}`,
              role: 'assistant',
              content: appendSources(resp.content || '（AI 没有返回内容）', resp.sources),
              createdAt: Date.now(),
            },
          ])
        }
      } catch (err: any) {
        if (isAbortError(err)) {
          // 用户主动停止：不是错误，给一条简短记录即可
          setMessages((prev) => [
            ...prev,
            {
              id: `a_${Date.now()}`,
              role: 'assistant',
              content: '_（已停止）_',
              createdAt: Date.now(),
            },
          ])
        } else {
          const msg = err?.message || String(err)
          console.error('[ReadingAsk] 提问失败:', err)
          toast.error(`提问失败：${msg}`)
          setMessages((prev) => [
            ...prev,
            {
              id: `a_${Date.now()}`,
              role: 'assistant',
              content: `⚠️ 提问失败：${msg}`,
              createdAt: Date.now(),
            },
          ])
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null
        setBusy(false)
        setStage('')
      }
    },
    [busy, docRef, docMarkdown, docTitle, historyContext],
  )

  /** 停止本次提问：前端立刻不再接收后端输出，并让后端也停下（省额度） */
  const stop = useCallback(() => {
    abortRef.current?.abort()
    setStage('正在停止…')
  }, [])

  /** 预设问法 1：查这个词的学术含义 —— 需要外部知识，走联网检索（可信检索关） */
  const askAcademicMeaning = () => {
    const word = selectedText.trim() || input.trim()
    if (!word) {
      toast.error('请先在正文里选中一个词，或直接输入要查的词')
      return
    }
    setTrusted(false)
    void send(`「${word}」在学术界通常指什么？请说明它的学科背景、常见用法与代表性含义。`, false, '')
  }

  /** 预设问法 2：结合本文解释这段文字 —— 必须锚定原文，走可信检索（开） */
  const askExplainInContext = () => {
    const text = selectedText.trim() || input.trim()
    if (!text) {
      toast.error('请先在正文里选中一段文字')
      return
    }
    setTrusted(true)
    void send('请结合本文上下文解释这段文字的意思，不要引入原文没有的说法。', true, text)
  }

  const clearChat = () => {
    if (!confirm('确定清空这篇的 AI 对话记录吗？')) return
    setMessages([])
    if (docRef) {
      saveReadingChat(docRef, messagesToMd(docTitle, [])).catch((err) =>
        console.error('[ReadingAsk] 清空对话失败:', err),
      )
    }
  }

  if (!docRef) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-400 px-6 text-center">
        <div>
          <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">先选择一篇文献或一本书</p>
          <p className="text-xs mt-1">选中正文里的词句后，可以直接问 AI</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 可信检索开关 */}
      <div className="px-3 py-2 border-b border-ink-100 flex-shrink-0 bg-paper-100/50">
        <button
          onClick={() => setTrusted(!trusted)}
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition border ${
            trusted
              ? 'bg-seal-50 border-seal-200 text-seal-700'
              : 'bg-paper-50 border-ink-200 text-ink-500 hover:bg-paper-100'
          }`}
          title={
            trusted
              ? '可信检索：先联网检索，回答依据「正文 + 检索结果」，AI-2 逐条核查是否编造'
              : '自由问答：不喂原文，DeepSeek 联网检索后回答，不做审阅（适合查外部知识）'
          }
        >
          {trusted ? <ShieldCheck className="w-3.5 h-3.5" /> : <Globe className="w-3.5 h-3.5" />}
          <span className="font-medium">可信检索</span>
          <span className="ml-auto">{trusted ? '开 · 双引擎审阅' : '关 · 联网检索'}</span>
        </button>
        <div className="mt-1.5 flex items-center justify-between text-[0.625rem] text-ink-400">
          <span className="truncate">{docTitle}</span>
          <button
            onClick={clearChat}
            disabled={messages.length === 0 || busy}
            className="flex items-center gap-0.5 hover:text-red-500 disabled:opacity-40 flex-shrink-0"
            title="清空对话"
          >
            <Eraser className="w-3 h-3" />
            清空
          </button>
        </div>
      </div>

      {/* 消息列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
        {!loaded ? (
          <div className="text-center py-6 text-ink-400 text-xs">
            <div className="w-6 h-6 border-2 border-ink-200 border-t-seal-500 rounded-full animate-spin mx-auto mb-2" />
            加载对话记录…
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-6 text-ink-400 text-xs px-2">
            <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p className="text-ink-500 font-medium mb-1">问 AI</p>
            <p className="leading-relaxed">
              在正文里选中一个词或一段话，下面会出现两个快捷问法；也可以直接输入任意问题。
            </p>
            <p className="mt-2">对话会一直保留在这个{docRef.kind === 'book' ? '书' : '文献'}里。</p>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
              <div
                className={`rounded-lg px-3 py-2 text-sm max-w-full ${
                  m.role === 'user'
                    ? 'bg-seal-600 text-paper-50'
                    : 'bg-paper-100 border border-ink-200 text-ink-700'
                }`}
              >
                {m.role === 'user' ? (
                  <div className="whitespace-pre-wrap break-words">{m.content}</div>
                ) : (
                  <div
                    className="prose-sm max-w-none break-words"
                    dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(m.content) }}
                  />
                )}
                {m.role === 'assistant' && m.reviewStatus && (
                  <div
                    className={`mt-1.5 text-[0.625rem] ${
                      m.reviewStatus === 'pass' ? 'text-green-600' : 'text-amber-600'
                    }`}
                  >
                    {m.reviewStatus === 'pass'
                      ? '✓ 可信检索：AI-2 核查通过'
                      : '⚠ 可信检索：AI-2 未通过核查（可能有原文不支持的说法）'}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-ink-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span className="flex-1 min-w-0 truncate">{stage || '处理中…'}</span>
            <button
              onClick={stop}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-ink-200 text-ink-500 hover:border-red-300 hover:text-red-600 transition flex-shrink-0"
              title="停止：不再接收本次回答，并让后端也停下"
            >
              <Square className="w-3 h-3" />
              停止
            </button>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* 快捷问法（有选中文字才出现） */}
      {selectedText.trim() && (
        <div className="px-3 py-2 border-t border-ink-100 flex-shrink-0 bg-seal-50/40">
          <div className="flex items-start gap-1.5 text-[0.625rem] text-ink-500 mb-1.5">
            <Quote className="w-3 h-3 flex-shrink-0 mt-0.5" />
            <span className="line-clamp-2">{selectedText.trim()}</span>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={askAcademicMeaning}
              disabled={busy}
              className="flex-1 px-2 py-1.5 text-[0.6875rem] bg-paper-50 border border-ink-200 rounded-md hover:border-seal-400 hover:text-seal-600 transition disabled:opacity-40 text-left"
              title="关闭可信检索，让 AI 联网检索该词的学术含义"
            >
              查学术含义
            </button>
            <button
              onClick={askExplainInContext}
              disabled={busy}
              className="flex-1 px-2 py-1.5 text-[0.6875rem] bg-paper-50 border border-ink-200 rounded-md hover:border-seal-400 hover:text-seal-600 transition disabled:opacity-40 text-left"
              title="开启可信检索，结合本文原文与联网检索解释这段文字"
            >
              结合本文解释
            </button>
          </div>
        </div>
      )}

      {/* 自由提问 */}
      <div className="px-3 py-2 border-t border-ink-100 flex-shrink-0">
        <div className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send(input, trusted, selectedText)
              }
            }}
            rows={2}
            placeholder="输入问题，Enter 发送 / Shift+Enter 换行"
            className="flex-1 px-2 py-1.5 text-xs border border-ink-200 rounded-md resize-none focus:outline-none focus:border-seal-400"
          />
          <button
            onClick={() => void send(input, trusted, selectedText)}
            disabled={busy || !input.trim()}
            className="p-2 bg-seal-600 text-paper-50 rounded-md hover:bg-seal-700 transition disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
            title="发送"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
        <div className="mt-1 text-[0.625rem] text-ink-400">
          {trusted
            ? '可信检索开：先联网检索，回答受「正文 + 检索结果」约束，AI-2 会核查是否编造'
            : '可信检索关：DeepSeek 联网检索后回答并附来源，不核查是否超出原文'}
        </div>
      </div>
    </div>
  )
}
