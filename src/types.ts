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
  /** 是否正在初始化 / 校验中 */
  isLoading: boolean
  /** 初始化时是否已尝试从 IndexedDB 读取过 token（用于避免首次渲染时误跳登录页） */
  isInitialized: boolean
  /** 上次登录/验证的错误信息 */
  error: string | null
}

/** PAT 验证成功后的返回结果 */
export interface PATVerifyResult {
  user: GitHubUser
  scopes: string[]
  /** 剩余速率配额（X-RateLimit-Remaining） */
  rateLimitRemaining: number
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

/** SPEC §9.2 (M3.5): 单条 claim 的核查结论
 *  - supported: 源材料明确支撑该 claim
 *  - added: 源材料未提及（AI-1 引入了源材料以外的信息，即"加戏"）
 *  - contradicted: 源材料与该 claim 矛盾（AI-1 曲解了原文）
 */
export type FaithfulnessVerdict = 'supported' | 'added' | 'contradicted'

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
   */
  source_span: string
  /** 中文简要说明 */
  explanation: string
}

/** SPEC §9.2 (M3.5): 引证锚定校验结果
 *  前端遍历 AI-2 输出的 claims，逐条 sourceMaterial.includes(source_span) 校验；
 *  任何一条应有 span 但校验失败 → ok=false → 强制 passed=false（AI-2 编造引用）。
 */
export interface EvidenceCheck {
  /** 是否全部锚定命中（无编造引用） */
  ok: boolean
  /** 需要校验的 claim 数（verdict !== 'added'） */
  checked: number
  /** 命中数（source_span 能在源材料中 grep 到） */
  matched: number
  /** 校验失败的 claim 索引 */
  failedIndices: number[]
}

/** SPEC §9.2 (M3.5): 双引擎完整结果 —— 忠实性核查 */
export interface DualEngineResult {
  taskType: DualEngineTaskType
  /** 用户提供的源材料（唯一 ground truth） */
  sourceMaterial: string
  /** 用户对 AI-1 的指令（如"简洁总结上述材料"） */
  ai1Instruction: string
  /** AI-1 使用的模型 id */
  ai1Model: string
  /** AI-1 生成的总结 */
  ai1Output: string
  /** AI-1 token 使用 */
  ai1Usage: AIResponse['usage']
  /** AI-2 使用的模型 id */
  ai2Model: string
  /** AI-2 审阅结论 */
  ai2Feedback: {
    /** 无 added/contradicted 且 evidenceCheck.ok=true 时才为 true */
    passed: boolean
    /** 逐条 claim 核查 */
    claims: FaithfulnessClaim[]
    /** 对 AI-1 总结整体忠实性的一段评价 */
    summary: string
    /** 引证锚定校验（防 AI-2 编造引用） */
    evidenceCheck: EvidenceCheck
  }
  /** AI-2 原始文本（未 JSON 解析时的兜底） */
  ai2RawOutput: string
  /** AI-2 token 使用 */
  ai2Usage: AIResponse['usage']
  /** 起止时间戳 */
  startedAt: number
  finishedAt: number
}
