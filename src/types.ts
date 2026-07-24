/**
 * AcademicFlow 全局类型定义
 */

/** GitHub 用户信息（GET /user 返回的核心字段） */
export interface GitHubUser {
  login: string
  id: number
  name: string | null
  avatar_url: string
  html_url: string
  email: string | null
  bio: string | null
}

/** 登录态 */
export interface AuthState {
  /** GitHub Personal Access Token */
  token: string | null
  /** 当前登录用户信息 */
  user: GitHubUser | null
  /** PAT 授权的 scope 列表（从 X-OAuth-Scopes 响应头解析） */
  scopes: string[]
  /** 认证方式：device_flow / pat */
  method: 'device_flow' | 'pat' | null
  /** 登录时间 */
  loginAt: number | null
  /** PAT 过期时间（仅 PAT 方式有值） */
  expiresAt: number | null
  /** 是否正在初始化 / 校验中 */
  isLoading: boolean
  /** 初始化时是否已尝试从 IndexedDB 读取过 token（用于避免首次渲染时误跳登录页） */
  isInitialized: boolean
  /** 上次登录/验证的错误信息 */
  error: string | null
  /** 全局认证错误（401/403），触发后冻结写操作 */
  authError: string | null
}

/** PAT 验证成功后的返回结果 */
export interface PATVerifyResult {
  user: GitHubUser
  scopes: string[]
  /** 剩余速率配额（X-RateLimit-Remaining） */
  rateLimitRemaining: number
  /** PAT 过期时间（Unix ms），当 GitHub 响应头提供时才有 */
  expiresAt?: number
}

/** GitHub API 错误 */
export class GitHubAPIError extends Error {
  status: number
  /** GitHub 返回的原始 message，如"Bad credentials"、"API rate limit exceeded"等 */
  githubMessage: string

  constructor(status: number, githubMessage: string, friendly?: string) {
    super(friendly || githubMessage)
    this.name = 'GitHubAPIError'
    this.status = status
    this.githubMessage = githubMessage
  }
}

/** GitHub 仓库信息（GET /repos/{owner}/{repo} 返回的核心字段） */
export interface GitHubRepo {
  id: number
  name: string
  full_name: string
  private: boolean
  owner: {
    login: string
    id: number
  }
  html_url: string
  description: string | null
  default_branch: string
  created_at: string
  updated_at: string
}

/** Workspace 状态 */
export interface WorkspaceState {
  /** 是否已完成一次检测（避免加载态闪烁） */
  isChecked: boolean
  /** 是否正在检测/创建中 */
  isLoading: boolean
  /** 用户 workspace 仓库（存在则代表已 onboarding） */
  repo: GitHubRepo | null
  /** onboarding 阶段的分步进度提示，用于 UI 展示 */
  progress: string | null
  /** 检测/创建过程中的错误 */
  error: string | null
}

// ============================================================
// M3: 设置页 + AI 双引擎（SPEC v0.3 §7.3 / §9）
// ============================================================

/** AI 服务提供方模式：普通模式锁定硅基流动，高级模式可切自定义 OpenAI 兼容端点 */
export type AIProviderMode = 'siliconflow' | 'custom'

/** OpenAI /v1/models 兼容响应中的单个模型 */
export interface AIModel {
  id: string
  object?: string
  created?: number
  owned_by?: string
}

/** 用户可编辑的完整设置数据（SPEC v0.3 §7.3） */
export interface SettingsData {
  /** 高级模式总开关：false 只暴露硅基流动+AI-1/AI-2 下拉；true 解锁自定义端点 */
  advancedMode: boolean
  /** AI 服务提供方模式：普通=siliconflow，高级可切 custom */
  aiProviderMode: AIProviderMode
  /** 硅基流动 API Key（普通模式必填） */
  siliconflowApiKey: string
  /** AI-1（生成位）默认模型 id */
  ai1Model: string
  /** AI-2（审阅位）默认模型 id */
  ai2Model: string
  /** 高级模式：AI-1 自定义端点 */
  customAi1BaseUrl: string
  customAi1ApiKey: string
  customAi1Model: string
  /** 高级模式：AI-2 自定义端点 */
  customAi2BaseUrl: string
  customAi2ApiKey: string
  customAi2Model: string
  /** MinerU JWT token（BYO）——用于 PDF → Markdown 解析 */
  mineruToken: string
  /**
   * MinerU 代理 URL（BYO）——用户在自己的 VPS 上部署透传代理后填入。
   *
   * 格式：http://你的VPS公网IP:8000
   *
   * 部署指引：Settings → MinerU 代理 提供一键安装脚本
   * 数据隐私：代理只做纯转发，不缓存不落盘。部署在用户自己的服务器上，作者不接触。
   */
  mineruWorkerUrl: string
  /**
   * 是否提取"题图（cover figure）"—— 论文里最能代表全文核心的那张单图。
   * 通常是第一张但不必然（有些论文第一张是路线图/示意图/TOC graphic）。
   * 理工科需要，社科可关。判断需要 AI 参与，逻辑在 Import 里落地。默认 true。
   */
  extractCoverImage: boolean
  /**
   * MinerU 调试模式（M3.6.3-b）
   * -------------------------------------------------
   * 打开时，MineruTestPanel 会展示一个 Debug Console，
   * 展示每个 fetch 的 method/url/status/duration/body 片段，方便定位卡点。
   * 分发前可在 Settings 里手动关。默认 true（开发期）。
   */
  mineruDebugMode: boolean
}

/** 设置 store 状态 */
export interface SettingsState extends SettingsData {
  /** 是否已从 IndexedDB rehydrate 完成 */
  isInitialized: boolean
  /** 硅基流动 /v1/models 拉取的模型清单（用于 UI 下拉） */
  siliconflowModels: AIModel[]
  /** 模型清单最后一次拉取的时间戳（Unix ms） */
  siliconflowModelsFetchedAt: number | null
  /** 正在拉取模型清单 */
  isLoadingModels: boolean
  /** 正在跑双引擎试运行 */
  isRunningDualEngine: boolean
  /** 双引擎最近一次结果 */
  lastDualEngineResult: DualEngineResult | null
  /** 错误提示 */
  error: string | null
}

/** SPEC §9.1: OpenAI 兼容对话请求 */
export interface AIRequest {
  baseUrl: string
  apiKey: string
  model: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  temperature?: number
  maxTokens?: number
}

/** SPEC §9.1: OpenAI 兼容对话响应 */
export interface AIResponse {
  content: string
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
  finishReason: string
  modelId: string
}

/** SPEC §9.2 (M3.5): 双引擎任务类型 —— 忠实性核查（面向"总结不加戏"场景） */
export type DualEngineTaskType = 'faithfulness_check'

/** SPEC §9.2 (M3.5 · M3.6.3 回到三分类 + 固定 tag 硬编码): 单条 claim 的核查结论
 *  - supported: 源材料明确支撑该 claim
 *  - added: 源材料未提及但 AI-1 引入了外部内容（"加戏"，需追责，AI-1 必须删除或替换为占位）
 *  - contradicted: 源材料与该 claim 矛盾（AI-1 曲解原文，需追责）
 *
 *  M3.6.3 关键变更（治本方案）：
 *   - 废除 out_of_scope verdict：AI-1 用户指令索取源材料未覆盖信息时，
 *     硬编码要求 AI-1 输出固定 tag `[NOT_IN_SOURCE] <字段>` 格式；
 *     AI-2 抽取阶段识别到 tag → 直接跳过，不成为 claim；
 *     前端 verifyEvidence 也识别 tag 做前置过滤（三层保底）。
 *   - 这样元陈述根本不进 verdict/引证核查流程，从根源上避免了
 *     "AI-2 判 verdict 陷入模糊边界 → 被迫改判 added → AI-1 rewrite 死循环"的旧 bug。
 *   - 旧 IndexedDB 记录里若含 out_of_scope，UI 渲染时静默降级为 supported，不炸。
 */
export type FaithfulnessVerdict =
  | 'supported'
  | 'added'
  | 'contradicted'

/** SPEC §9.2 (M3.5): AI-2 输出的单条 claim 核查 */
export interface FaithfulnessClaim {
  /** 从 AI-1 总结中抽取的可核查断言（原文或轻度精简，保留核心语义） */
  claim: string
  /** 核查结论 */
  verdict: FaithfulnessVerdict
  /** 源材料中的原文引用（用于自动锚定校验）
   *  - supported: 支撑该 claim 的源材料原文片段（≥10 字符）
   *  - contradicted: 被 claim 矛盾的源材料原文片段（≥10 字符）
   *  - added: 空字符串（源材料未提及，无需 span）
   *
   *  M3.6.3: 元陈述（含 `[NOT_IN_SOURCE]` tag 的 AI-1 输出）由 AI-2 在抽取阶段
   *  就跳过，不成为 claim，因此不会出现在此 span 校验流程中。
   */
  source_span: string
  /** 中文简要说明 */
  explanation: string
}

/** SPEC §9.2 (M3.5 · M3.6.3): 引证锚定校验结果
 *  前端遍历 AI-2 输出的 claims，逐条 sourceMaterial.includes(source_span) 校验；
 *  任何一条应有 span 但校验失败 → ok=false → 强制 passed=false（AI-2 编造引用）。
 *
 *  M3.6.3: 三层保底跳过规则：
 *    ① AI-1 硬编码用 `[NOT_IN_SOURCE] <字段>` tag 表达元陈述
 *    ② AI-2 抽取阶段识别 tag → 不抽为 claim
 *    ③ verifyEvidence 兜底：claim.claim 或 explanation 含 tag → 跳过校验
 *  同时 added 类无需 span，也从 checked 池中排除。
 */
export interface EvidenceCheck {
  /** 是否全部锚定命中（无编造引用） */
  ok: boolean
  /** 需要校验的 claim 数（verdict === 'supported' || verdict === 'contradicted'，且不含 tag） */
  checked: number
  /** 命中数（source_span 能在源材料中 grep 到） */
  matched: number
  /** 校验失败的 claim 索引 */
  failedIndices: number[]
}

/** SPEC §9.2 (M3.5): AI-2 结构化反馈 */
export interface FaithfulnessFeedback {
  /** M3.6.3: 无 added/contradicted 且 evidenceCheck.ok=true 时才为 true
   *  （元陈述 `[NOT_IN_SOURCE]` 已在抽取阶段被跳过，不进入 verdict 池） */
  passed: boolean
  /** 逐条 claim 核查 */
  claims: FaithfulnessClaim[]
  /** 对 AI-1 总结整体忠实性的一段评价 */
  summary: string
  /** 引证锚定校验（防 AI-2 编造引用） */
  evidenceCheck: EvidenceCheck
}

/** SPEC §9.2 (M3.6): 触发本轮的原因 —— 分层归因用
 *
 *  - first_run: 首轮，直接跑 AI-1 → AI-2
 *  - ai1_rewrite: 上一轮 AI-2 抓出 added/contradicted（AI-1 加戏），且引证锚定 ok；本轮打回 AI-1 重写 + AI-2 重审
 *  - ai2_self_correct: 上一轮引证锚定失败（AI-2 编造 span），本轮 AI-1 输出保留不变，只让 AI-2 自我纠错
 */
export type AttemptReason = 'first_run' | 'ai1_rewrite' | 'ai2_self_correct'

/** SPEC §9.2 (M3.6): 单轮尝试的完整记录 —— 用于 5 轮重写循环的历史留痕
 *
 *  每轮 = 一次归因 + 只调那个错的 AI（分层归因）
 *  - first_run: 首次跑 AI-1 → AI-2
 *  - ai1_rewrite: 只调 AI-1（用上一轮反馈重写）+ 重跑 AI-2 审新版
 *  - ai2_self_correct: 只调 AI-2（AI-1 输出复用上一轮），让它重挑真实存在的 span
 */
export interface DualEngineAttempt {
  /** 轮次序号，从 1 开始 */
  attempt: number
  /** 本轮触发原因（决定本轮调哪个 AI） */
  reason: AttemptReason
  /** AI-1 本轮的输出（ai2_self_correct 时 = 上一轮的 ai1Output，AI-1 未重调） */
  ai1Output: string
  /** AI-1 是否本轮真正被调用（ai2_self_correct 时为 false） */
  ai1Invoked: boolean
  /** AI-1 token 使用（未调用时为占位空对象） */
  ai1Usage: AIResponse['usage']
  /** AI-1 耗时（ms；未调用时为 0） */
  ai1Ms: number
  /** AI-2 结构化反馈 */
  ai2Feedback: FaithfulnessFeedback
  /** AI-2 原始文本（JSON 解析失败时的兜底） */
  ai2RawOutput: string
  /** AI-2 token 使用 */
  ai2Usage: AIResponse['usage']
  /** AI-2 耗时（ms） */
  ai2Ms: number
  /** 本轮是否通过（= ai2Feedback.passed；即 AI-2 自判 passed 且引证锚定全命中） */
  passed: boolean
  /** 上一轮的 AI-1 输出（重写时作为 context；首轮为 null） */
  previousAI1Output: string | null
}

/** SPEC §9.2 (M3.5 语义 · M3.6 重写循环): 双引擎完整结果 —— 忠实性核查 */
export interface DualEngineResult {
  taskType: DualEngineTaskType
  /** 用户提供的源材料（唯一 ground truth） */
  sourceMaterial: string
  /** 用户对 AI-1 的指令（如"简洁总结上述材料"） */
  ai1Instruction: string
  /** AI-1 使用的模型 id（本次运行统一使用） */
  ai1Model: string
  /** AI-2 使用的模型 id（本次运行统一使用） */
  ai2Model: string
  /** 最终交付的 AI-1 输出（= attempts 中最后一轮的 ai1Output） */
  ai1Output: string
  /** 最终 AI-2 反馈（= attempts 中最后一轮的 ai2Feedback） */
  ai2Feedback: FaithfulnessFeedback
  /** 最终 AI-2 原始输出（= attempts 中最后一轮的 ai2RawOutput） */
  ai2RawOutput: string
  /** M3.6: 全部尝试历史（长度 = 实际执行轮数，最少 1 最多 maxAttempts） */
  attempts: DualEngineAttempt[]
  /** M3.6: 最大允许轮数（用于 UI 显示"第 N/M 轮"，默认 5） */
  maxAttempts: number
  /** M3.6: 最终是否通过（= 最后一轮 passed；5 轮全失败时为 false） */
  finalPassed: boolean
  /** 首轮 AI-1 token 使用（保留向后兼容，= attempts[0].ai1Usage） */
  ai1Usage: AIResponse['usage']
  /** 首轮 AI-2 token 使用（保留向后兼容，= attempts[0].ai2Usage） */
  ai2Usage: AIResponse['usage']
  /** 起止时间戳 */
  startedAt: number
  finishedAt: number
}

// ============================================================
// M3.5.1: 双引擎分阶段进度反馈（UX 增强，不改核心语义）
// ============================================================

/** 双引擎运行阶段（面向 UI 时间线展示；M3.6 加入 attempt_start / attempt_failed_retry / ai2_self_correct） */
export type DualEngineStage =
  | 'idle' // 未开始
  | 'attempt_start' // 新一轮开始（M3.6：event.attempt=当前轮次 · event.reason=本轮触发原因）
  | 'ai1_running' // AI-1 生成/重写中
  | 'ai1_done' // AI-1 完成（AI-2 尚未启动）
  | 'ai2_running' // AI-2 首次核查中
  | 'ai2_self_correct_running' // M3.6: AI-2 自我纠错中（上一轮引证锚定失败，AI-1 输出不变，AI-2 重跑）
  | 'ai2_done' // AI-2 返回（前端锚定校验尚未做）
  | 'verifying' // 前端锚定校验中（通常 <100ms）
  | 'attempt_failed_retry' // M3.6: 本轮未通过，准备进入下一轮
  | 'finished' // 全部完成（可能是通过，也可能是 maxAttempts 用尽）
  | 'error' // 中途异常

/** 单次进度回调事件 —— dual-engine 在关键节点触发（M3.6 加入 attempt / reason 相关字段） */
export interface DualEngineProgressEvent {
  stage: DualEngineStage
  /** M3.6: 当前轮次（从 1 开始） */
  attempt?: number
  /** M3.6: 最大轮数（默认 5） */
  maxAttempts?: number
  /** M3.6: 本轮触发原因（决定本轮调哪个 AI） */
  reason?: AttemptReason
  /** AI-1 完成后传出（供 UI 提前展示 AI-1 输出） */
  ai1Output?: string
  ai1Model?: string
  ai1Usage?: AIResponse['usage']
  /** 已知的各阶段耗时（ms） */
  ai1Ms?: number
  ai2Ms?: number
  /** M3.6: 本轮 AI-2 反馈（attempt_failed_retry 时传出，供 UI 展示"上轮为何被打回"） */
  ai2Feedback?: FaithfulnessFeedback
  /** 错误信息（stage='error' 时） */
  errorMessage?: string
}

/** 双引擎进度回调签名 */
export type DualEngineProgressCallback = (
  event: DualEngineProgressEvent,
) => void

/** M3.5.1: 硅基流动账户信息（用于双引擎面板顶部余额显示 + 跑之前预检） */
export interface UserAccountInfo {
  /** 总余额（充值+赠送），字符串形式（避免 float 精度问题），如 "12.34" */
  totalBalance: string
  /** 充值余额（可选，服务商可能不返回） */
  chargeBalance?: string
  /** 账号状态："normal" / "suspended" 等（可选） */
  status?: string
  /** 服务商返回的 name / 昵称（可选，用于 UI 上下文） */
  name?: string
  /** 客户端拉取时间戳（用于展示"更新于 XX 秒前"） */
  fetchedAt: number
}

// ============================================================================
// MinerU 类型定义（M3.7）
// ============================================================================
// 官方 v4 API 契约（2026-06 抓取自 mineru.net/apiManage/docs）：
//   POST /api/v4/file-urls/batch  申请上传 URL
//   PUT  <presigned_url>          上传 PDF 二进制
//   GET  /api/v4/extract-results/batch/{batch_id}  轮询解析状态
//   GET  <full_zip_url>           下载解析产物 zip
// 单文件硬约束：≤200MB 且 ≤200 页（官方 2026-07 更新，原 600 页已降为 200 页）

/** MinerU JWT 解析结果（用于 UI 展示到期时间和倒计时） */
export interface MineruJwtInfo {
  /** 原 token 字符串 */
  raw: string
  /** JWT jti（会话 id，硅基流动侧可用于工单排查） */
  jti?: string
  /** UUID（Rosa 侧账号标识） */
  uuid?: string
  /** iat 签发时间（秒 unix 时间戳） */
  iat?: number
  /** exp 过期时间（秒 unix 时间戳） */
  exp?: number
  /** exp 转成 Date 便于 UI 直接展示 */
  expiresAt?: Date
  /** 距离过期还剩多少天（可为负） */
  remainingDays?: number
  /** 是否已过期 */
  isExpired: boolean
  /** 解析出错时的错误信息（token 格式无效等） */
  parseError?: string
}

/** MinerU 单个文件的处理状态（v4 API 官方枚举） */
export type MineruFileState =
  | 'waiting-file' // 已申请 URL，等文件上传
  | 'pending' // 已上传，排队中
  | 'running' // 解析中
  | 'converting' // 转换中（部分场景）
  | 'done' // 完成
  | 'failed' // 解析失败（提取业务错误）
  | 'error' // 系统错误

/** POST /api/v4/file-urls/batch 请求体 */
export interface MineruApplyRequest {
  /** 待上传文件描述（batch 单批可多个，本项目 M3.7 只用 1 个） */
  files: Array<{
    name: string
    /** 是否强制 OCR（扫描 PDF 需要 true，正常 PDF false 即可） */
    is_ocr?: boolean
    /** 页范围过滤，例如 "1-5,7,10-N"；不传则全量 */
    page_ranges?: string
    /** 自定义 data_id 便于回调关联 */
    data_id?: string
  }>
  /** 模型版本，v4 默认 pipeline */
  model_version?: 'pipeline' | 'vlm'
  /** 是否解析公式 */
  enable_formula?: boolean
  /** 是否解析表格 */
  enable_table?: boolean
  /** 语言提示，'ch' / 'en' / 'auto' 等 */
  language?: string
  /** 附加输出格式，如 ['docx','html','latex'] —— 需按需申请配额 */
  extra_formats?: string[]
  /** 回调 URL（Web 前端场景一般不用） */
  callback?: string
  seed?: string
}

/** POST /api/v4/file-urls/batch 响应体 */
export interface MineruApplyResponse {
  code: number
  msg: string
  data: {
    batch_id: string
    /** 与 files[] 顺序一致的预签名上传 URL */
    file_urls: string[]
  }
}

/** GET /api/v4/extract-results/batch/{batch_id} 里单文件的结果 */
export interface MineruFileResult {
  file_name: string
  state: MineruFileState
  /** state=done 时才有：解析产物 zip 的下载 URL */
  full_zip_url?: string
  /** state=failed / error 时的错误说明 */
  err_msg?: string
  /** 部分状态下的进度百分比（0-100） */
  extract_progress?: number
  data_id?: string
}

/** GET /api/v4/extract-results/batch/{batch_id} 响应体 */
export interface MineruBatchResult {
  code: number
  msg: string
  data: {
    batch_id: string
    extract_result: MineruFileResult[]
  }
}

/** MineruTestPanel 阶段可视化用（DualEngineTestPanel StageTimeline 同款语义） */
export type MineruStage =
  | 'idle'
  | 'applying' // 申请上传 URL
  | 'uploading' // PUT 到 OSS
  | 'polling' // 轮询解析状态
  | 'downloading' // 拉产物 zip
  | 'extracting' // jszip 解压
  | 'done'
  | 'failed'

/** MineruTestPanel 单步进度事件 */
export interface MineruProgressEvent {
  stage: MineruStage
  /** 人类可读的进度描述，比如"上传 3.2MB..."、"解析进度 42%..." */
  message: string
  /** 事件时刻（Date.now()） */
  at: number
  /** 可选：service 侧透出的关键 id / url，便于错误排查 */
  batchId?: string
  fileName?: string
}

/** MineruProgressCallback 回调签名（组件订阅进度） */
export type MineruProgressCallback = (event: MineruProgressEvent) => void

/**
 * MinerU 调试事件（M3.6.3-b）
 * -------------------------------------------------
 * 独立于 MineruProgressEvent，专门记 HTTP 请求级细节：
 * method / url / status / duration / body 片段 / 错误堆栈。
 * 不影响 UI 主进度条，仅在 debugMode 开启时挂到 Debug Console 展示。
 */
export interface MineruDebugEvent {
  /** 事件类型 */
  kind: 'request' | 'response' | 'error' | 'info'
  /** 属于哪个阶段（跟 MineruStage 对齐） */
  phase: MineruStage
  /** 事件时刻 Date.now() */
  at: number
  /** HTTP 方法（kind=request/response 时有） */
  method?: string
  /** 请求 URL（kind=request/response 时有） */
  url?: string
  /** HTTP 状态码（kind=response 时有） */
  status?: number
  /** 从对应 request 到 response 的耗时（ms，kind=response 时有） */
  durationMs?: number
  /** 关键 payload 片段：body / message / snippet，最多 500 字符 */
  detail?: string
  /** 错误名（kind=error 时有，如 'MineruNetworkError'） */
  errorName?: string
}

/** MineruDebugCallback 回调签名（组件订阅底层 debug 流） */
export type MineruDebugCallback = (event: MineruDebugEvent) => void

/** MineruTestPanel 最终跑完的完整结果 */
export interface MineruTestResult {
  batchId: string
  fileName: string
  /** 页数（客户端粗探） */
  pageCount?: number
  /** 各阶段耗时（ms），键 = stage */
  timing: Partial<Record<MineruStage, number>>
  /** 提取到的 markdown 全文（合并前的原始 md） */
  markdown: string
  /** 图片名 → Blob 的映射（组件里再 URL.createObjectURL 展示） */
  images: Record<string, Blob>
  /** markdown 里引用了但 zip 里没有的图（缺失图，一般是 layout 分析副产物） */
  missingImages: string[]
  /** zip 里有但 markdown 没引用的图（孤儿图，非致命） */
  orphanImages: string[]
}

// ============================================================================
// 期刊模板 & 引用系统（M? · AI 期刊排版）
// ============================================================================

/** 引用条目元数据（从 CrossRef / OpenAlex 等源获取） */
export interface CitationEntry {
  /** 归一化后的纯 DOI（10.xxx/xxx，不含协议前缀），作为主键 */
  doi: string
  /** 文献标题 */
  title: string
  /** 作者列表（姓, 名 缩写 格式） */
  authors: string[]
  /** 期刊名 */
  journal?: string
  /** 发表年份 */
  year?: number
  /** 卷号 */
  volume?: string
  /** 期号 */
  issue?: string
  /** 页码范围 */
  pages?: string
  /** 出版社 */
  publisher?: string
  /** 原始 BibTeX（如果有） */
  bibtex?: string
  /** 数据来源：crossref / openalex / manual */
  source: 'crossref' | 'openalex' | 'manual'
  /** 获取时间戳 */
  fetched_at: number
}

/** 期刊模板 —— 存储投稿须知 + LaTeX 排版参数 */
export interface JournalTemplate {
  /** 模板唯一 id（小写字母+数字+连字符） */
  id: string
  /** 期刊全称 */
  name: string
  /** 期刊简称 / 缩写 */
  short_name?: string
  /** 出版社 */
  publisher?: string
  /** 期刊主页 URL */
  journal_url?: string
  /** 投稿须知 URL */
  guidelines_url?: string
  /** 投稿须知原文（纯文本 / HTML，用户粘贴或抓取） */
  guidelines_content?: string
  /** 投稿须知版本历史（每次更新留一条） */
  guidelines_history?: GuidelineVersion[]
  /** 投稿须知最后检测时间 */
  guidelines_last_checked_at?: number
  /** 投稿须知最后更新时间 */
  guidelines_last_updated_at?: number
  /** 投稿须知内容哈希（用于检测变化） */
  guidelines_content_hash?: string
  /** LaTeX documentclass，如 article / elsarticle / IEEEtran */
  document_class: string
  /** LaTeX 文档选项，如 twocolumn,12pt */
  document_options?: string
  /** 需要引入的宏包列表 */
  packages: string[]
  /** 引用样式（BibTeX style），如 unsrt / apalike / ieeetr */
  bibtex_style: string
  /** 是否双栏排版 */
  two_column: boolean
  /** 字号（pt） */
  font_size?: number
  /** 页边距配置 */
  margins?: {
    top?: string
    bottom?: string
    left?: string
    right?: string
  }
  /** 标题格式说明（给 AI 的 prompt 用） */
  title_format_note?: string
  /** 摘要格式说明 */
  abstract_format_note?: string
  /** 参考文献格式说明 */
  reference_format_note?: string
  /** 自定义 LaTeX 前置代码（插入 \begin{document} 之前） */
  custom_preamble?: string
  /** 完整 LaTeX 模板骨架（对应 templates/journals/{slug}/template.tex） */
  template_tex?: string
  /** 投稿信模板（对应 templates/journals/{slug}/cover-letter.md.tpl） */
  cover_letter?: string
  /** 备注 / 用户笔记 */
  notes?: string
  /** 创建时间 */
  created_at: number
  /** 更新时间 */
  updated_at: number
}

/** 投稿须知版本记录 */
export interface GuidelineVersion {
  /** 版本号，从 1 开始递增 */
  version: number
  /** 更新时间 */
  updated_at: number
  /** 内容摘要（前 200 字） */
  summary: string
  /** 完整内容（可选，节省空间可只存最新版全文） */
  full_content?: string
  /** 更新说明 */
  change_note?: string
}

/** Markdown → LaTeX 转换结果 */
export interface LatexConversionResult {
  /** 生成的完整 LaTeX 代码 */
  latex: string
  /** 提取出的引用 DOI 列表（按出现顺序） */
  citations: string[]
  /** 解析成功的引用条目 */
  citation_entries: CitationEntry[]
  /** 解析失败的 DOI */
  failed_dois: string[]
  /** 生成的 BibTeX 内容 */
  bibtex: string
  /** AI 原始输出（用于调试） */
  ai_raw_output?: string
  /** 耗时（ms） */
  duration_ms: number
  /** 使用的期刊模板 id */
  journal_template_id: string
}

/** DOI 归一化结果 */
export interface DoiNormalizeResult {
  /** 是否是有效的 DOI */
  valid: boolean
  /** 归一化后的纯 DOI（10.xxx/xxx） */
  doi?: string
  /** 原始输入 */
  raw: string
}
