/**
 * 阅读页「问 AI」的在途状态仓
 * -------------------------------------------------
 * 为什么要有这个 store：
 * 阅读页右侧是「问 AI / 笔记 / 批注」三个 tab **互斥渲染**的，切 tab 就是把面板
 * 卸载再挂回来；切到别的窗口再回来也一样。此前 messages / busy / stage / abort 全在
 * 组件里，卸载后提问的异步链还在跑，但 `setMessages/setBusy/setStage` 落在已卸载的
 * 实例上等于空操作 —— 切回来看到的是「既不回话、也不显示等待」的死界面，答案直接丢掉。
 *
 * 现在的口径：**提问这件事归 store 管，不归组件管**。
 * - 面板只做「读取 + 触发」，卸载不影响在途请求（promise 活在模块作用域）。
 * - 每个对象（文献 / 图书 / 文档）一个 key，各自一份 state；切回来时若这一篇
 *   还在跑，原样恢复「在跑 + 已等多久 + 当前阶段」。
 * - 结果写回时先校验 docKey，防止 A 篇的回答串到 B 篇。
 * - 落盘也在这里做（800ms 防抖 + 切换对象 / 卸载 / 提问结束立即 flush），
 *   卸载不再丢最后一条消息。
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import {
  callWebSearch,
  resolveWebSearchSupport,
  type WebSearchSource,
} from '../services/ai/web-search'
import { callAI } from '../services/ai/client'
import { runDualEngine } from '../services/ai/dual-engine'
import { buildReadingSourceMaterial } from '../services/ai/readingSource'
import { historyTokenBudget, resolveContextWindow } from '../services/ai/modelWindow'
import { isAbortError } from '../services/ai/abort'
import {
  DELIVER_FILES_PROMPT,
  deliverFilesToTask,
  parseDeliveredFileBlocks,
  type DeliveredFileChip,
} from '../services/ai/deliveredFiles'
import { loadReadingChat, saveReadingChat, type DocRef } from '../services/readingDocData'
import { loadMaterialMeta, taskOf } from '../services/materialMeta'
import { runOptimistic, errText } from '../services/optimistic'
import { useSettingsStore } from './settings'

export interface ReadingChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  /** 有值 = 走了可信检索（双引擎），值是 AI-2 的审阅结论 */
  reviewStatus?: 'pass' | 'fail'
  /**
   * 本条回答交付的文件（已注册为全局「其他文档」）。
   * 只作界面「交付回执」，不写进对话 md —— 文件本身已永久存进文档库，不需要在
   * 聊天记录里再存一份正文（否则 md 会翻倍膨胀）。
   */
  deliveredFiles?: DeliveredFileChip[]
  /** 本条是失败提示（不进多轮上下文；界面给「重试」入口） */
  failed?: boolean
}

/** 一条带引文的提问 → 在正文边上画一个「原点」 */
export interface AskAnchor {
  /** 对应消息 id，点原点时用来跳转定位 */
  id: string
  question: string
  quote: string
}

/** 拆出用户消息里的「问题」与「引文」（引文形如 "\n\n> 选中文字"） */
export function splitUserContent(content: string): { question: string; quote: string } {
  const at = content.indexOf('\n\n> ')
  if (at < 0) return { question: content, quote: '' }
  return { question: content.slice(0, at), quote: content.slice(at + 5).trim() }
}

/** 失败提示：旧对话从 md 读回时没有 failed 标记，用固定前缀认出来 */
export function isFailedMessage(m: ReadingChatMessage): boolean {
  return m.role === 'assistant' && (m.failed === true || m.content.startsWith('⚠️ 提问失败'))
}

/** 失败 / 已停止的提示不进多轮上下文，免得模型把错误文本当历史 */
function isNoiseMessage(m: ReadingChatMessage): boolean {
  return isFailedMessage(m) || (m.role === 'assistant' && m.content.trim() === '_（已停止）_')
}

/** 联网检索用的系统提示（可信路径与自由路径共用） */
const SEARCH_SYSTEM =
  '你是学术阅读助手。用户在读一篇文献或一本书，会就其中某个词或某段文字提问。' +
  '先联网检索再回答，说明该概念在学术界的通行含义、学科背景和典型用法。' +
  '引用检索到的说法要给出处；不确定的地方明确说不确定，不要编造文献、作者或出处。用中文回答。'

/** 纯模型问答的系统提示（不联网、不喂原文，只靠模型自身知识回答） */
const PLAIN_SYSTEM =
  '你是学术阅读助手。用户在读一篇文献或一本书，会就其中某个词或某段文字提问。' +
  '用你自己的知识回答，说得准确、简洁。' +
  '不确定的地方明确说不确定，不要编造文献、作者或出处。用中文回答。'

/**
 * 注入「依据」的检索来源条数上限。
 *
 * 注意：检索正文**不截断** —— 双引擎的 AI-2 是靠 `sourceMaterial.includes(span)`
 * 做字面引证核对的，正文一旦从中间截断，AI-2 引用的片段就会跨过断点、匹配不上，
 * 于是明明判定 supported 也被算成核验失败（实测踩过）。控制体量要靠 AI-2 的
 * 输出预算（后端已从 16000 提到 32000），不是靠截断依据。
 */
const SEARCH_MATERIAL_SOURCES = 8

/** 来源列表最多展示几条（DeepSeek 一次检索能返回十几条，全列出来会淹掉答案本身） */
const MAX_SOURCES = 8

function formatMinute(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function messagesToMd(title: string, messages: ReadingChatMessage[]): string {
  const body = messages
    .map((m) => {
      const who = m.role === 'user' ? '用户' : 'AI'
      const status = m.role === 'assistant' && m.reviewStatus ? ` · ${m.reviewStatus}` : ''
      return `## ${who} · ${formatMinute(m.createdAt)}${status}\n${m.content.trim()}`
    })
    .join('\n\n')
  return `# 问 AI · ${title}\n\n${body}${body ? '\n' : ''}`
}

export function mdToMessages(md: string): ReadingChatMessage[] {
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
 * 联网检索的来源以 Markdown 链接追加到答案末尾。
 * 直接拼进 content 而不是单独存字段 —— 这样对话落盘成 md 之后再读回来，
 * 来源跟着正文一起回来，不需要额外解析。
 */
export function appendSources(content: string, sources: WebSearchSource[]): string {
  if (sources.length === 0) return content
  const clean = (s: string) => s.replace(/[\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  const items = sources
    .slice(0, MAX_SOURCES)
    .map((s, i) => `${i + 1}. [${clean(s.title) || s.url}](${s.url})`)
  const more =
    sources.length > MAX_SOURCES ? `\n\n（另有 ${sources.length - MAX_SOURCES} 条来源未列出）` : ''
  return `${content}\n\n---\n\n**参考来源**\n\n${items.join('\n')}${more}`
}

const docKeyOf = (ref: DocRef) => `${ref.kind}:${ref.id}`

/**
 * 每个对象一份运行态。放模块作用域而不是 store state 里：
 * 面板卸载 / 切换对象都不该影响它，只有「当前正在看的那篇」才投影到 store。
 */
interface RunState {
  ref: DocRef
  title: string
  messages: ReadingChatMessage[]
  loaded: boolean
  busy: boolean
  stage: string
  /** 本次提问开始时间戳（ms），面板据此显示「已等待 Ns」 */
  startedAt: number
  /** 取消句柄：点「停止」时 abort，前端不再收输出、后端也一起停 */
  abort: AbortController | null
}

const runs = new Map<string, RunState>()

function runOf(ref: DocRef, title = ''): RunState {
  const key = docKeyOf(ref)
  const exist = runs.get(key)
  if (exist) {
    if (title) exist.title = title
    return exist
  }
  const fresh: RunState = {
    ref,
    title,
    messages: [],
    loaded: false,
    busy: false,
    stage: '',
    startedAt: 0,
    abort: null,
  }
  runs.set(key, fresh)
  return fresh
}

/* ── 落盘：800ms 防抖，但切换对象 / 卸载 / 提问结束立即 flush ── */
let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingSave: { ref: DocRef; title: string; messages: ReadingChatMessage[] } | null = null

function scheduleSave(ref: DocRef, title: string, messages: ReadingChatMessage[]) {
  pendingSave = { ref, title, messages }
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushSave, 800)
}

export function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const job = pendingSave
  pendingSave = null
  if (!job) return
  void saveReadingChat(job.ref, messagesToMd(job.title, job.messages)).catch((err) =>
    console.error('[ReadingAsk] 保存对话失败:', err),
  )
}

export interface ReadingAskSendParams {
  ref: DocRef
  docTitle: string
  docMarkdown: string
  question: string
  focusText: string
  trusted: boolean
  web: boolean
  /** 重试时传「撤掉失败那一轮之后」的消息列表，作为多轮上下文来源 */
  historySource?: ReadingChatMessage[]
}

export interface ReadingAskRetryParams {
  ref: DocRef
  docTitle: string
  docMarkdown: string
  /** 要重试的那条失败消息 */
  messageId: string
  trusted: boolean
  web: boolean
}

interface ReadingAskState {
  docKey: string
  messages: ReadingChatMessage[]
  loaded: boolean
  busy: boolean
  stage: string
  /** 本次提问开始时间戳；0 = 没有在跑 */
  startedAt: number
  /** 面板挂载 / 切对象时调用；同一对象重复调用不会重读盘、更不会冲掉在途状态 */
  load: (ref: DocRef | null) => void
  send: (params: ReadingAskSendParams) => void
  retry: (params: ReadingAskRetryParams) => void
  stop: () => void
  clear: (ref: DocRef, title: string) => void
}

export const useReadingAskStore = create<ReadingAskState>((set, get) => {
  /** 把某对象的运行态投影到 store —— 只投影「当前正在看的那篇」，避免串台 */
  const mirror = (key: string, run: RunState, extra?: Partial<ReadingAskState>) => {
    if (get().docKey !== key) return
    set({
      messages: run.messages,
      loaded: run.loaded,
      busy: run.busy,
      stage: run.stage,
      startedAt: run.startedAt,
      ...extra,
    })
  }

  /**
   * 提问主体。抽成闭包内函数是为了让「首次提问」与「失败重试」共用同一套
   * 三路分支（可信 / 联网 / 纯模型），不复制两份状态机。
   */
  const doSend = ({
    ref,
    docTitle,
    docMarkdown,
    question,
    focusText,
    trusted: useTrusted,
    web: useWeb,
    historySource,
  }: ReadingAskSendParams) => {
    const q = question.trim()
    if (!q) return
    const run = runOf(ref, docTitle)
    if (run.busy) return

    // 联网开着但当前 provider 没有原生联网能力：直接说清原因，不假装检索
    if (useWeb) {
      const support = resolveWebSearchSupport()
      if (!support.supported) {
        toast.error(support.reason)
        return
      }
    }

    const key = docKeyOf(ref)
    const push = (msg: ReadingChatMessage) => {
      run.messages = [...run.messages, msg]
      mirror(key, run)
      scheduleSave(ref, run.title, run.messages)
    }

    // 当前端实际使用的槽位配置（可信检索需要 ai1 + ai2，自由问答只需 ai1）
    const { ai1, ai2 } = useSettingsStore.getState().getDualEngineConfig()

    // 后端按 provider 能力自动挑联网槽位；推理模式沿用 AI-1 位设置。
    // '' 表示不干预 → 传 undefined，后端就不发 thinking（保持模型默认）。
    const webSearchThinking = useSettingsStore.getState().thinkingAi1 || undefined

    // 多轮上下文：保留最近 6 条，并按模型窗口派生的预算裁剪。
    // 注意：这是「对话记录」的预算，与图书正文无关 —— 图书正文不再截断（见 readingSource）。
    // 失败/已停止的提示不进上下文；重试时传 historySource 以排除被撤掉的那一轮。
    const rawHistory = (historySource ?? run.messages)
      .filter((m) => !isNoiseMessage(m))
      .slice(-6)
      .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
      .join('\n')
    const historyBudget = historyTokenBudget(
      Math.min(resolveContextWindow(ai1.model), resolveContextWindow(ai2.model)),
    )
    const historyContext = historyBudget > 0 ? rawHistory.slice(-historyBudget) : ''

    const now = Date.now()
    push({
      id: `u_${now}`,
      role: 'user',
      content: focusText.trim() ? `${q}\n\n> ${focusText.trim()}` : q,
      createdAt: now,
    })

    const controller = new AbortController()
    run.busy = true
    run.stage = useWeb ? '联网检索中…' : 'AI-1 生成中…'
    run.startedAt = now
    run.abort = controller
    mirror(key, run)
    const signal = controller.signal

    void (async () => {
      // 交付文件要归到「这篇材料所属的任务」下面 —— 直接查 materials/meta.csv 的归属，
      // 不额外加 prop、也不依赖宿主页面传参。查不到（或读取失败）就只做全局「其他文档」。
      let ownerTaskId = ''
      try {
        ownerTaskId = taskOf(await loadMaterialMeta(), ref.kind, ref.id)
      } catch (err) {
        console.warn('[ReadingAsk] 读取材料归属失败，交付文件将不带任务归属:', err)
      }

      /** 阶段文案写回：卸载期间也要落到 store 上，切回来才看得到进度 */
      const setStage = (stage: string) => {
        run.stage = stage
        mirror(key, run)
      }

      try {
        if (useTrusted) {
          // 源材料构造：整本塞得下就送全文，否则走「目录 → AI 选章 → 送选中章节正文」两阶段。
          // 不再硬编码截断原文 —— 送不送得下、截不截，由模型真实窗口决定（见 modelWindow / readingSource）。
          const src = await buildReadingSourceMaterial({
            docMarkdown,
            focusText,
            question: q,
            historyContext,
            ai1,
            ai2,
            signal,
            onStage: setStage,
          })
          const docMaterial = src.material
          if (!docMaterial.trim()) {
            throw new Error('这篇文章还没有正文，可信检索没有可锚定的原文')
          }

          // 联网开关打开时：先联网检索一轮，把结果并进「依据」再交给双引擎。
          // 这样 AI-2 判的是「原文或检索结果有没有支持」，双引擎的判定语义没变，只是依据变宽了。
          let webMaterial = ''
          let webSources: WebSearchSource[] = []
          if (useWeb) {
            setStage('联网检索中…')
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
              // 联网开关是用户明确打开的：检索失败就如实报错并给重试入口，
              // 不静默降级成「只依据正文」—— 那会让用户以为答案用过联网。
              console.warn('[ReadingAsk] 可信检索的联网检索失败:', err)
              throw new Error(
                `联网检索失败：${errText(err)}。可关闭「联网」只依据正文重试，或点「重试」再试一次。`,
              )
            }
          }

          const sourceMaterial = [docMaterial, webMaterial].filter(Boolean).join('\n\n')

          const instruction = [
            historyContext ? `【此前的对话】\n${historyContext}` : '',
            `【当前问题】\n${q}`,
            focusText.trim() ? `【需要解释的文字】\n${focusText.trim()}` : '',
          ].filter(Boolean).join('\n\n')

          setStage(
            src.mode === 'chapters' && src.pickedTitles.length
              ? `已依据章节：${src.pickedTitles.join('、')}，AI-1 生成中…`
              : 'AI-1 生成中…',
          )
          const result = await runDualEngine({
            taskType: 'faithfulness_check',
            sourceMaterial,
            ai1Instruction: instruction,
            ai1,
            ai2,
            maxAttempts: 3,
            signal,
            // 允许 AI 把成篇成果作为独立文件交付 —— runner 会在 AI-2 核查前剥离
            // @@FILE@@ 块并回传 deliveredFiles，避免被误判成「编造内容」删除。
            deliverFiles: true,
            onProgress: (ev) => {
              if (ev.stage === 'ai2_running' || ev.stage === 'ai2_self_correct_running') {
                setStage(`AI-2 审阅中（第 ${ev.attempt}/${ev.maxAttempts} 轮）…`)
              } else if (ev.stage === 'ai1_running') {
                setStage(`AI-1 生成中（第 ${ev.attempt}/${ev.maxAttempts} 轮）…`)
              }
            },
          })

          // 交付文件已由后端剥离并回传，这里落库为全局「其他文档」+ 归入本任务。
          // 落库失败不吞回答本身：给出提示，正文照常展示。
          let deliveredChips: DeliveredFileChip[] = []
          try {
            deliveredChips = await deliverFilesToTask(result.deliveredFiles, ownerTaskId)
          } catch (err) {
            console.warn('[ReadingAsk] 交付文件登记失败:', err)
            toast.warning('回答已生成，但交付文件登记失败')
          }

          push({
            id: `a_${Date.now()}`,
            role: 'assistant',
            content: appendSources(result.ai1Output || '（AI 没有返回内容）', webSources),
            createdAt: Date.now(),
            reviewStatus: result.finalPassed ? 'pass' : 'fail',
            deliveredFiles: deliveredChips,
          })
        } else if (useWeb) {
          // 联网自由问答：后端按 provider 能力自动挑一个支持原生 web_search 的槽位；
          // 不喂原文，凭据只从 Secrets 取（前端不传本地 Key）。
          const userContent = [
            historyContext ? `【此前的对话】\n${historyContext}` : '',
            `【正在读】${docTitle}`,
            focusText.trim() ? `【相关文字】\n${focusText.trim()}` : '',
            `【问题】\n${q}`,
            DELIVER_FILES_PROMPT,
          ].filter(Boolean).join('\n\n')

          const resp = await callWebSearch({
            system: SEARCH_SYSTEM,
            user: userContent,
            thinking: webSearchThinking,
            signal,
          })

          // 联网问答链路是无状态直连，没有后端落库 —— 由前端从回复里解析 @@FILE@@ 块，
          // 剥离后的正文才是展示内容，交付文件落库为全局「其他文档」+ 归入本任务。
          const parsed = parseDeliveredFileBlocks(resp.content || '')
          let deliveredChips: DeliveredFileChip[] = []
          if (parsed.files.length > 0) {
            try {
              deliveredChips = await deliverFilesToTask(parsed.files, ownerTaskId)
            } catch (err) {
              console.warn('[ReadingAsk] 交付文件登记失败:', err)
              toast.warning('回答已生成，但交付文件登记失败')
            }
          }

          push({
            id: `a_${Date.now()}`,
            role: 'assistant',
            content: appendSources(parsed.content || '（AI 没有返回内容）', resp.sources),
            createdAt: Date.now(),
            deliveredFiles: deliveredChips,
          })
        } else {
          // 纯模型问答：不喂原文、不联网，直接走 chat handler（AI-1 槽位），让模型用
          // 自身知识回答。仍允许交付文件 —— 前端解析 @@FILE@@ 块后落库为「其他文档」。
          const userContent = [
            historyContext ? `【此前的对话】\n${historyContext}` : '',
            `【正在读】${docTitle}`,
            focusText.trim() ? `【相关文字】\n${focusText.trim()}` : '',
            `【问题】\n${q}`,
            DELIVER_FILES_PROMPT,
          ].filter(Boolean).join('\n\n')

          setStage('AI-1 生成中…')
          const resp = await callAI({
            messages: [
              { role: 'system', content: PLAIN_SYSTEM },
              { role: 'user', content: userContent },
            ],
            thinking: ai1.thinking,
            signal,
          })

          const parsed = parseDeliveredFileBlocks(resp.content || '')
          let deliveredChips: DeliveredFileChip[] = []
          if (parsed.files.length > 0) {
            try {
              deliveredChips = await deliverFilesToTask(parsed.files, ownerTaskId)
            } catch (err) {
              console.warn('[ReadingAsk] 交付文件登记失败:', err)
              toast.warning('回答已生成，但交付文件登记失败')
            }
          }

          push({
            id: `a_${Date.now()}`,
            role: 'assistant',
            content: parsed.content || '（AI 没有返回内容）',
            createdAt: Date.now(),
            deliveredFiles: deliveredChips,
          })
        }
      } catch (err: any) {
        if (isAbortError(err)) {
          // 用户主动停止：不是错误，给一条简短记录即可
          push({
            id: `a_${Date.now()}`,
            role: 'assistant',
            content: '_（已停止）_',
            createdAt: Date.now(),
          })
        } else {
          const msg = err?.message || String(err)
          console.error('[ReadingAsk] 提问失败:', err)
          toast.error(`提问失败：${msg}`)
          push({
            id: `a_${Date.now()}`,
            role: 'assistant',
            content: `⚠️ 提问失败：${msg}`,
            createdAt: Date.now(),
            failed: true,
          })
        }
      } finally {
        if (run.abort === controller) run.abort = null
        run.busy = false
        run.stage = ''
        run.startedAt = 0
        mirror(key, run)
        // 最后一条（答案 / 报错）必须立刻落盘，不能被 800ms 防抖吞掉
        flushSave()
      }
    })()
  }

  return {
    docKey: '',
    messages: [],
    loaded: false,
    busy: false,
    stage: '',
    startedAt: 0,

    load: (ref) => {
      if (!ref) {
        flushSave()
        set({ docKey: '', messages: [], loaded: false, busy: false, stage: '', startedAt: 0 })
        return
      }
      const key = docKeyOf(ref)
      if (get().docKey === key) return

      // 切走之前把上一篇没落盘的那条先写掉
      flushSave()
      const run = runOf(ref)
      set({
        docKey: key,
        messages: run.messages,
        loaded: run.loaded,
        busy: run.busy,
        stage: run.stage,
        startedAt: run.startedAt,
      })
      if (run.loaded) return

      void loadReadingChat(ref)
        .then((md) => {
          if (run.loaded) return
          run.messages = mdToMessages(md)
        })
        .catch((err) => {
          console.error('[ReadingAsk] 加载对话失败:', err)
        })
        .finally(() => {
          run.loaded = true
          mirror(key, run)
        })
    },

    send: (params) => doSend(params),

    retry: ({ ref, docTitle, docMarkdown, messageId, trusted, web }) => {
      const run = runOf(ref, docTitle)
      if (run.busy) return
      const idx = run.messages.findIndex((m) => m.id === messageId)
      if (idx < 0) return
      // 找到这条失败提示之前的那条用户提问 —— 重试是「把这一轮撤掉重发」
      let userIdx = -1
      for (let i = idx - 1; i >= 0; i--) {
        if (run.messages[i].role === 'user') {
          userIdx = i
          break
        }
      }
      if (userIdx < 0) return
      const { question, quote } = splitUserContent(run.messages[userIdx].content)
      const rest = run.messages.filter((_, i) => i !== idx && i !== userIdx)
      const key = docKeyOf(ref)
      run.messages = rest
      mirror(key, run)
      scheduleSave(ref, run.title, rest)
      doSend({
        ref,
        docTitle,
        docMarkdown,
        question,
        focusText: quote,
        trusted,
        web,
        historySource: rest,
      })
    },

    /** 停止本次提问：前端立刻不再接收后端输出，并让后端也停下（省额度） */
    stop: () => {
      const run = runs.get(get().docKey)
      if (!run?.busy) return
      run.abort?.abort()
      run.stage = '正在停止…'
      mirror(get().docKey, run)
    },

    clear: (ref, title) => {
      const key = docKeyOf(ref)
      const run = runOf(ref, title)
      const prevMessages = run.messages
      void runOptimistic({
        apply: () => {
          run.messages = []
          mirror(key, run)
        },
        commit: () => saveReadingChat(ref, messagesToMd(title, [])),
        rollback: () => {
          run.messages = prevMessages
          mirror(key, run)
          scheduleSave(ref, title, prevMessages)
        },
        errorMessage: (err) => `清空对话失败：${errText(err)}`,
      })
    },
  }
})
