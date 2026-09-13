/**
 * Pipeline Trace — 收集 post-mineru 每阶段的输入/输出/prompt，
 * 用于 Settings 页的调试看板。
 *
 * 存 localStorage（key: af_pipeline_traces_v1），最多保留最近 20 条。
 */

export interface StageTrace {
  stage: string
  label: string
  prompt?: string
  inputPreview?: string
  outputPreview?: string
  inputLength?: number
  outputLength?: number
  startedAt: number
  endedAt: number
  durationMs: number
  retry?: number
  error?: string
  aiModel?: string
  aiEngine?: 'ai1' | 'ai2' | 'code'
  passed?: boolean
}

export interface PipelineRunTrace {
  id: string
  doi: string
  title?: string
  slug?: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'done' | 'failed'
  stages: StageTrace[]
  error?: string
  totalMs?: number
}

const STORAGE_KEY = 'af_pipeline_traces_v1'
const MAX_TRACES = 20

// ---------- Storage ----------

function loadAll(): Record<string, PipelineRunTrace> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveAll(map: Record<string, PipelineRunTrace>) {
  // 超过 MAX_TRACES 时删掉最老的
  const keys = Object.keys(map).sort((a, b) => map[a].startedAt - map[b].startedAt)
  while (keys.length > MAX_TRACES) {
    const oldest = keys.shift()!
    delete map[oldest]
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
}

// ---------- Public API ----------

export function createTrace(id: string, doi: string): PipelineRunTrace {
  const map = loadAll()
  const t: PipelineRunTrace = {
    id,
    doi,
    startedAt: Date.now(),
    status: 'running',
    stages: [],
  }
  map[id] = t
  saveAll(map)
  return t
}

export function getTrace(id: string): PipelineRunTrace | null {
  return loadAll()[id] ?? null
}

export function listRecentTraces(): PipelineRunTrace[] {
  return Object.values(loadAll()).sort((a, b) => b.startedAt - a.startedAt)
}

export function finalizeTrace(id: string, status: 'done' | 'failed', error?: string) {
  const map = loadAll()
  const t = map[id]
  if (!t) return
  t.endedAt = Date.now()
  t.status = status
  t.error = error
  t.totalMs = t.endedAt - t.startedAt
  saveAll(map)
}

export function deleteTrace(id: string) {
  const map = loadAll()
  delete map[id]
  saveAll(map)
}

export function clearAllTraces() {
  localStorage.removeItem(STORAGE_KEY)
}

// ---------- Stage recorder ----------

export class TraceRecorder {
  private trace: PipelineRunTrace
  private currentStage: StageTrace | null = null

  constructor(trace: PipelineRunTrace) {
    this.trace = trace
  }

  /** 开始一个新阶段 */
  beginStage(meta: {
    stage: string
    label: string
    prompt?: string
    inputPreview?: string
    inputLength?: number
    aiModel?: string
    aiEngine?: 'ai1' | 'ai2' | 'code'
    retry?: number
  }) {
    this.currentStage = {
      ...meta,
      startedAt: Date.now(),
      endedAt: 0,
      durationMs: 0,
    }
  }

  /** 结束当前阶段（成功） */
  endStage(outputPreview?: string, extra?: { outputLength?: number; passed?: boolean }) {
    if (!this.currentStage) return
    this.currentStage.endedAt = Date.now()
    this.currentStage.durationMs = this.currentStage.endedAt - this.currentStage.startedAt
    if (outputPreview != null) this.currentStage.outputPreview = outputPreview
    if (extra?.outputLength != null) this.currentStage.outputLength = extra.outputLength
    if (extra?.passed != null) this.currentStage.passed = extra.passed
    this.trace.stages.push({ ...this.currentStage })
    this.currentStage = null
    this.persist()
  }

  /** 当前阶段报错 */
  failStage(error: string) {
    if (!this.currentStage) return
    this.currentStage.endedAt = Date.now()
    this.currentStage.durationMs = this.currentStage.endedAt - this.currentStage.startedAt
    this.currentStage.error = error
    this.trace.stages.push({ ...this.currentStage })
    this.currentStage = null
    this.persist()
  }

  private persist() {
    const map = loadAll()
    map[this.trace.id] = this.trace
    saveAll(map)
  }
}

// ---------- Helpers ----------

export function truncate(s: string, max = 800): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n\n... [截断，共 ${s.length} 字符]`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}
