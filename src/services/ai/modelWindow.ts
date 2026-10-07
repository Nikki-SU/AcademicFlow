/**
 * 模型 → 上下文窗口 查证表 + token 估算（ADJ-129）
 * -------------------------------------------------
 * 为什么需要它：阅读页「可信检索」以前是**硬编码截断**原文（选中处前后各 4000 字 /
 * 不选中只送开头 12000 字），于是「书里明明有」的内容根本没喂给模型，AI-1 只能老老实实
 * 回 [NOT_IN_SOURCE]，用户看到的就是「答不对、老说不在原文里」。
 *
 * 这里不再拍脑袋定一个数字，而是按**当前实际用的模型**查它真实能吃多长的上下文：
 *   - 整份材料塞得下 → 全送，绝不截断；
 *   - 塞不下 → 交给 readingSource 走「目录 → AI 选章 → 送该章正文」两阶段。
 *
 * 口径来源与不确定性都写在下面每一条的注释里 —— 查证不出的标注「依据不足」，
 * 并取**保守下限**（宁可触发两阶段多调一次，也不把超长材料硬塞导致请求报错）。
 */

/**
 * 各模型的上下文窗口（token）。值是逐条查证官方文档 / 实测得出的口径。
 *
 * ⚠️ 有的口径本身冲突（同一模型不同渠道给不同值），一律取**较小**的保守值。
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // ── DeepSeek 官方（V4 世代把 flash 从 128K 抬到 1M 上下文）──
  'deepseek-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,

  // ── 智谱 GLM ──
  // glm-5.3：实测 max_new_tokens=128000、1M token 上下文窗口
  'glm-5.3': 1_000_000,
  // glm-4.7-flash：**依据不足** —— 同族 GLM-4-Flash=128K、GLM-4.6=200K、GLM-4.6V=128K，
  // 但 4.7-flash 本身未见官方明确窗口值，取同族最常见的保守值 128K
  'glm-4.7-flash': 128_000,

  // ── 火山方舟 ──
  // ark-code-latest：Hermes 实测 context_length=256,000；火山文档 256k 上下文
  'ark-code-latest': 256_000,
  // doubao-seed-2.1-pro：**依据不足（冲突）** —— 一处「1M 上下文配 256k 深度思考」，
  // 多处「256K」，取较小值 256K
  'doubao-seed-2.1-pro': 256_000,
  // deepseek-v4-flash（火山版）：未见明确窗口值，按同属 DeepSeek V4 世代的保守值 256K
  'deepseek-v4-flash': 256_000,
  // deepseek-ai/DeepSeek-V4-Flash（硅基流动版）：未见明确窗口值，取保守 128K
  'deepseek-ai/DeepSeek-V4-Flash': 128_000,

  // ── 讯飞星火 ──
  // spark-x2.5-4b：官方标注原生上下文 1M tokens
  'spark-x2.5-4b': 1_000_000,

  // ── 硅基流动 ──
  'Qwen/Qwen2.5-7B-Instruct': 32_000,
  'THUDM/glm-4-9b-chat': 128_000,
}

/**
 * 查不到窗口时的保守下限。
 * 取已知**最小**的窗口（Qwen2.5-7B 的 32K）—— 这会让这些模型更倾向走两阶段选章，
 * 但绝不会因为高估窗口把超长材料硬塞进去。
 *
 * 会落到这里的：自定义端点（自建 Ollama / vLLM，模型名任意）、
 * openrouter/free（自动路由，每次真实模型不同）、用户「拉取模型清单」选中的表外模型。
 */
export const DEFAULT_CONTEXT_WINDOW = 32_000

/** 查一个模型的上下文窗口（token）。查不到 → 保守下限。 */
export function resolveContextWindow(model: string): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW
  return MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW
}

/**
 * 给模型**输出**预留的 token。
 *
 * 口径：后端 runner 的 dual_engine 每次调用都写死 `max_tokens: 64000`
 * （见 .runner-edit/dual_engine_runner.mjs 的 MAX_TOKENS），输入 + 输出必须一起
 * 塞进窗口，所以要从窗口里先扣掉这部分。但不能超过窗口一半 —— 32K 窗口的模型
 * 不可能要 64000 输出（那种请求本身就会被上游拒绝）。
 */
export function outputReserve(window: number): number {
  return Math.min(64_000, Math.floor(window / 2))
}

/**
 * 给「此前的对话」（多轮上下文）预留的 token 上限。
 *
 * 为什么需要它：AI 单轮回答上限是 64000 token（后端 MAX_TOKENS），若不加约束，
 * 几轮长回答叠加起来就能吃满、甚至超出窗口，把「源材料」挤没。这里给对话上下文
 * 划一个**工程预留份额** —— 窗口的 1/8，且不超过 8000 token，保证源材料永远占大头。
 *
 * ⚠️ 这是为「源材料优先」定的工程份额（非查证到的规格值），取小不取大：
 * 宁可少回带几轮对话，也不让图书正文被挤掉。
 */
export function historyTokenBudget(window: number): number {
  return Math.min(8_000, Math.floor(window / 8))
}

/**
 * 估算文本 token 数——**保守高估**（宁可少送，也不少送）。
 *
 * 口径说明：中文汉字的 token 换算在各方文档里口径冲突（1 字 ≈ 0.56 ~ 1.0 token）。
 * 取**最保守的上界**：所有非 ASCII 字符（汉字 / 日文 / 全角标点 / 带音标字母）一律
 * 按 1 token/字；ASCII 按 0.5 token/字（≈2 字符/token，高于常见的 ~4 字符/token）。
 * 两头都往高了估，确保「估算放得下」时实际一定放得下。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let ascii = 0
  for (const ch of text) {
    if ((ch.codePointAt(0) as number) > 0x7f) cjk++
    else ascii++
  }
  return cjk + Math.ceil(ascii / 2)
}
