/**
 * 阅读页「问 AI」面板
 * -------------------------------------------------
 * 图书和文献共用（两者只在 pipeline 上有区别，阅读侧完全对称）。
 *
 * 两个彼此独立的开关，组合出四种回答路径：
 *   可信检索（开/关）—— 回答是否受「依据」约束、是否交 AI-2 逐条核查有没有编造。
 *     开 → 把正文（+可选联网结果）作为 ground truth 喂给 AI-1，走双引擎 + AI-2 审阅。
 *     关 → 不喂原文，AI 自由回答，无审阅。
 *   联网（开/关）—— 回答前是否先联网检索。
 *     开 → 先联网检索一轮：可信路径把结果并入「依据」，自由路径把来源附在答案末尾。
 *     关 → 不联网，只靠正文与模型自身知识。
 *
 * 四组合：
 *   可信 + 联网 → 正文 + 检索结果 → 双引擎审阅（答案末尾附来源）
 *   可信        → 只依据正文       → 双引擎审阅
 *   联网        → 联网自由问答     → 单模型 + 来源列表（无审阅）
 *   都不开      → 纯模型问答       → 单模型，无依据、无来源、无审阅
 *
 * 联网检索走「有原生联网能力的 provider 槽位」：后端按 AI-1 → AI-2 的顺序挑第一个
 * 支持联网的槽位（DeepSeek / 智谱 GLM / OpenRouter / 讯飞星火），火山方舟与硅基流动
 * 会被明确拒绝。前端用 resolveWebSearchSupport() 按同一口径把不可用的联网开关置灰。
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
 *
 * 注意：消息 / 在途状态一律放 `stores/readingAsk.ts`，本组件**不做**提问状态机。
 * 右侧三个 tab 是互斥渲染的，切 tab 会把面板卸载；切到别的窗口再回来同理。
 * 状态留在组件里就会「切回来不说话也不显示等待」。现在的口径是：提问归 store，
 * 卸载不打断，重挂载原样恢复「在跑 + 已等多久 + 当前阶段」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Eraser,
  Globe,
  Loader2,
  Quote,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
} from 'lucide-react'
import { toast } from 'sonner'
import type { DocRef } from '../services/readingDocData'
import { resolveWebSearchSupport } from '../services/ai/web-search'
import { useSettingsStore } from '../stores/settings'
import { renderMarkdownToHtml } from '../services/markdown-renderer'
import { DeliveredFilesCard } from './DeliveredFilesCard'
import {
  flushSave,
  isFailedMessage,
  splitUserContent,
  useReadingAskStore,
  type AskAnchor,
} from '../stores/readingAsk'

export type { AskAnchor, ReadingChatMessage } from '../stores/readingAsk'

interface Props {
  docRef: DocRef | null
  docTitle: string
  /** 当前对象的正文（文献取当前显示模式的内容，图书取 content.md） */
  docMarkdown: string
  /** 正文里当前选中的文字，可能为空 */
  selectedText: string
  /** 把「带引文的提问」上报给阅读页，在正文边上画原点 */
  onAskAnchors?: (anchors: AskAnchor[]) => void
  /** 阅读页点原点后要滚动到的消息 id */
  jumpToMessageId?: string | null
  /** 已滚动到位，通知阅读页清空 */
  onJumped?: () => void
}

/** 秒数 → 「12s」/「3m05s」：等待时长要一直看得见，用户才知道后端还在跑 */
function formatWaited(sec: number): string {
  if (sec < 60) return `${sec}s`
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`
}

export default function ReadingAskPanel({
  docRef,
  docTitle,
  docMarkdown,
  selectedText,
  onAskAnchors,
  jumpToMessageId,
  onJumped,
}: Props) {
  const [input, setInput] = useState('')
  const [trusted, setTrusted] = useState(true)
  const [web, setWeb] = useState(false)
  /** 只用来驱动「已等待 Ns」每秒重算，不参与业务 */
  const [, tick] = useState(0)

  const messages = useReadingAskStore((s) => s.messages)
  const loaded = useReadingAskStore((s) => s.loaded)
  const busy = useReadingAskStore((s) => s.busy)
  const stage = useReadingAskStore((s) => s.stage)
  const startedAt = useReadingAskStore((s) => s.startedAt)
  const loadChat = useReadingAskStore((s) => s.load)
  const sendAsk = useReadingAskStore((s) => s.send)
  const retryAsk = useReadingAskStore((s) => s.retry)
  const stopAsk = useReadingAskStore((s) => s.stop)
  const clearAsk = useReadingAskStore((s) => s.clear)

  // 联网能力跟设置里的 provider 走：切到不支持联网的 provider 时开关自动关掉并置灰。
  const aiProviderMode = useSettingsStore((s) => s.aiProviderMode)
  const ai2ProviderMode = useSettingsStore((s) => s.ai2ProviderMode)
  const customAi1BaseUrl = useSettingsStore((s) => s.customAi1BaseUrl)
  const customAi2BaseUrl = useSettingsStore((s) => s.customAi2BaseUrl)
  const webSupport = useMemo(
    () => resolveWebSearchSupport(),
    [aiProviderMode, ai2ProviderMode, customAi1BaseUrl, customAi2BaseUrl],
  )

  useEffect(() => {
    if (!webSupport.supported) setWeb(false)
  }, [webSupport.supported])

  const docKey = docRef ? `${docRef.kind}:${docRef.id}` : ''

  // ── 切换对象 / 重新挂载：把 store 里这一篇的运行态投影过来（在途的继续在途） ──
  useEffect(() => {
    loadChat(docRef)
    // docKey 已经唯一标识对象，docRef 是每渲染新建的对象，不能进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey, loadChat])

  // ── 卸载（切 tab / 切换窗口 / 离开阅读页）：把没落盘的最后一条立刻写掉 ──
  useEffect(() => flushSave, [])

  // ── 在途时每秒重算等待时长 ──
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [busy])

  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, busy])

  // ── 带引文的提问 → 上报原点（正文里锚定过的位置） ──
  const askAnchors = useMemo<AskAnchor[]>(
    () =>
      messages
        .filter((m) => m.role === 'user')
        .map((m) => ({ id: m.id, ...splitUserContent(m.content) }))
        .filter((a) => a.quote.length >= 2),
    [messages],
  )

  useEffect(() => {
    onAskAnchors?.(askAnchors)
  }, [askAnchors, onAskAnchors])

  // ── 阅读页点原点跳过来 → 滚动到对应消息 ──
  useEffect(() => {
    if (!jumpToMessageId || !loaded) return
    const el = document.getElementById(`ask-msg-${jumpToMessageId}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    onJumped?.()
  }, [jumpToMessageId, loaded, onJumped])

  const send = useCallback(
    (question: string, useTrusted: boolean, useWeb: boolean, focusText: string) => {
      if (busy || !docRef) return
      if (!question.trim()) return
      sendAsk({
        ref: docRef,
        docTitle,
        docMarkdown,
        question,
        focusText,
        trusted: useTrusted,
        web: useWeb,
      })
      setInput('')
    },
    [busy, docRef, docTitle, docMarkdown, sendAsk],
  )

  /** 失败消息重试：撤掉失败那一轮（含它的用户提问），按当前开关重新发一次 */
  const retryFailed = useCallback(
    (messageId: string) => {
      if (busy || !docRef) return
      retryAsk({ ref: docRef, docTitle, docMarkdown, messageId, trusted, web })
    },
    [busy, docRef, docTitle, docMarkdown, retryAsk, trusted, web],
  )

  /** 预设问法 1：查这个词的学术含义 —— 需要外部知识，开联网、关可信检索 */
  const askAcademicMeaning = () => {
    if (!webSupport.supported) {
      toast.error(`「查学术含义」需要联网检索：${webSupport.reason}`)
      return
    }
    const word = selectedText.trim() || input.trim()
    if (!word) {
      toast.error('请先在正文里选中一个词，或直接输入要查的词')
      return
    }
    setTrusted(false)
    setWeb(true)
    send(`「${word}」在学术界通常指什么？请说明它的学科背景、常见用法与代表性含义。`, false, true, '')
  }

  /** 预设问法 2：结合本文解释这段文字 —— 必须锚定原文，开可信检索、关联网 */
  const askExplainInContext = () => {
    const text = selectedText.trim() || input.trim()
    if (!text) {
      toast.error('请先在正文里选中一段文字')
      return
    }
    setTrusted(true)
    setWeb(false)
    send('请结合本文上下文解释这段文字的意思，不要引入原文没有的说法。', true, false, text)
  }

  const clearChat = () => {
    if (!docRef) return
    if (!confirm('确定清空这篇的 AI 对话记录吗？')) return
    clearAsk(docRef, docTitle)
  }

  if (!docRef) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-400 px-6 text-center">
        <div>
          <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-ui-sm">先选择一篇文献或一本书</p>
        </div>
      </div>
    )
  }

  const waited = busy && startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 两个独立开关：可信检索（左）· 联网（右） */}
      <div className="af-line-b px-ui-gap py-2 flex-shrink-0 bg-paper-100/50">
        <div className="flex gap-1.5">
          <button
            onClick={() => setTrusted(!trusted)}
            className={`flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1.5 rounded-control-sm text-ui-xs transition border ${
              trusted
                ? 'bg-seal-50 border-seal-200 text-seal-700'
                : 'bg-paper-50 border-ink-200 text-ink-500 hover:bg-paper-100'
            }`}
            title={
              trusted
                ? '可信检索：回答依据「正文（+联网检索结果）」，AI-2 逐条核查是否编造'
                : '自由问答：不喂原文，AI 凭自身知识（或联网）回答，不做审阅'
            }
          >
            <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="font-medium truncate">可信检索</span>
            <span className="ml-auto flex-shrink-0">{trusted ? '开' : '关'}</span>
          </button>
          <button
            onClick={() => {
              if (!webSupport.supported) {
                toast.error(`联网不可用：${webSupport.reason}`)
                return
              }
              setWeb(!web)
            }}
            className={`flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1.5 rounded-control-sm text-ui-xs transition border ${
              !webSupport.supported
                ? 'bg-paper-50 border-ink-200 text-ink-300 cursor-not-allowed'
                : web
                  ? 'bg-seal-50 border-seal-200 text-seal-700'
                  : 'bg-paper-50 border-ink-200 text-ink-500 hover:bg-paper-100'
            }`}
            title={
              !webSupport.supported
                ? `联网不可用：${webSupport.reason}`
                : web
                  ? `联网：回答前先联网检索（由 ${webSupport.slot?.label ?? 'AI-1'} · ${webSupport.slot?.providerLabel ?? '当前 provider'} 提供）`
                  : '不联网：只用正文与模型自身知识回答'
            }
          >
            <Globe className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="font-medium truncate">联网</span>
            <span className="ml-auto flex-shrink-0">
              {!webSupport.supported ? '不可用' : web ? '开' : '关'}
            </span>
          </button>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-ui-2xs text-ink-400">
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
      <div className="flex-1 min-h-0 overflow-y-auto px-ui-gap py-3 space-y-3">
        {!loaded ? (
          <div className="text-center py-6 text-ink-400 text-ui-xs">
            <div className="w-6 h-6 border-2 border-ink-200 border-t-seal-500 rounded-full animate-spin mx-auto mb-2" />
            加载对话记录…
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-6 text-ink-400 text-ui-xs px-2">
            <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p>选中正文里的词句，或直接提问</p>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} id={`ask-msg-${m.id}`} className={m.role === 'user' ? 'flex justify-end' : ''}>
              <div
                className={`rounded-control px-ui-gap py-2 text-ui-sm max-w-full ${
                  m.role === 'user'
                    ? 'bg-seal-600 text-paper-50'
                    : isFailedMessage(m)
                      ? 'bg-red-50 border border-red-200 text-ink-700'
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
                    className={`mt-1.5 text-ui-2xs ${
                      m.reviewStatus === 'pass' ? 'text-green-600' : 'text-amber-600'
                    }`}
                  >
                    {m.reviewStatus === 'pass' ? '✓ 已核查' : '⚠ 未通过核查'}
                  </div>
                )}
                {m.role === 'assistant' && m.deliveredFiles && m.deliveredFiles.length > 0 && (
                  <DeliveredFilesCard files={m.deliveredFiles} />
                )}
                {m.role === 'assistant' && isFailedMessage(m) && (
                  <button
                    onClick={() => retryFailed(m.id)}
                    disabled={busy}
                    className="mt-1.5 flex items-center gap-1 px-1.5 py-0.5 rounded-control-sm border border-red-200 text-red-600 hover:bg-red-100 transition disabled:opacity-40"
                    title="撤掉这一轮，按当前开关重新提问一次"
                  >
                    <RotateCcw className="w-3 h-3" />
                    重试
                  </button>
                )}
              </div>
            </div>
          ))
        )}
        {busy && (
          <div className="flex items-center gap-2 text-ui-xs text-ink-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
            <span className="flex-1 min-w-0 truncate">{stage || '处理中…'}</span>
            <span className="flex-shrink-0 tabular-nums">已等待 {formatWaited(waited)}</span>
            <button
              onClick={stopAsk}
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-control-sm border border-ink-200 text-ink-500 hover:border-red-300 hover:text-red-600 transition flex-shrink-0"
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
        <div className="af-line-t px-ui-gap py-2 flex-shrink-0 bg-seal-50/40">
          <div className="flex items-start gap-1.5 text-ui-2xs text-ink-500 mb-1.5">
            <Quote className="w-3 h-3 flex-shrink-0 mt-0.5" />
            <span className="line-clamp-2">{selectedText.trim()}</span>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={askAcademicMeaning}
              disabled={busy}
              className="flex-1 px-2 py-1.5 text-ui-xs bg-paper-50 border border-ink-200 rounded-control-sm hover:border-seal-400 hover:text-seal-600 transition disabled:opacity-40 text-left"
              title="开启联网、关闭可信检索：让 AI 联网检索该词的学术含义"
            >
              查学术含义
            </button>
            <button
              onClick={askExplainInContext}
              disabled={busy}
              className="flex-1 px-2 py-1.5 text-ui-xs bg-paper-50 border border-ink-200 rounded-control-sm hover:border-seal-400 hover:text-seal-600 transition disabled:opacity-40 text-left"
              title="开启可信检索、关闭联网：结合本文原文解释这段文字"
            >
              结合本文解释
            </button>
          </div>
        </div>
      )}

      {/* 自由提问 */}
      <div className="af-line-t px-ui-gap py-2 flex-shrink-0">
        <div className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send(input, trusted, web, selectedText)
              }
            }}
            rows={2}
            placeholder="输入问题…"
            className="flex-1 px-2 py-1.5 text-ui-xs border border-ink-200 rounded-control-sm resize-none focus:outline-none focus:border-seal-400"
          />
          <button
            onClick={() => send(input, trusted, web, selectedText)}
            disabled={busy || !input.trim()}
            className="p-2 bg-seal-600 text-paper-50 rounded-control-sm hover:bg-seal-700 transition disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
            title="发送"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  )
}
