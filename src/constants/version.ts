/**
 * 应用版本号体系（ADJ-126）：记载**所有**更新，不只数据迁移。
 *
 * 多段版本号：**改哪个方面，只 bump 对应段** —— 读版本差异就知道这次改的是什么、
 * 该同步什么：
 *   - `data`     数据格式版本：对应 migrations 的 DATA_VERSION，变化 → 走数据迁移
 *                （强制更新，不兼容旧数据；迁移自带 `affects` 锁定受影响页面）。
 *   - `backend`  后端 workflow/脚本版本：前端嵌入的私库 GitHub Actions pipeline
 *                （paper_convert / book_convert / ai_call / session_images 等）。
 *                变化 → 启动时自动同步到私库（读私库版本副本比对，落后即强制重写）。
 *   - `frontend` 前端交互/界面版本：部署即最新、无同步动作，仅版本记载。
 *
 * 私库版本副本（与 data-version.csv 同机制）：
 *   - data：`settings/data-version.csv`（migrations 管理）
 *   - backend：`settings/backend-version.csv`（pipelineAutoSync 管理，随 workflow 一起写入）
 * 前端启动读副本比对对应段，段不一致即对该段执行强制更新（ADJ-126 语义：不兼容旧版一律更新）。
 *
 * 维护规则：**每次改动，bump 对应段 +1**（数据迁移改 `data` 并给迁移填 `since = 新值`；
 * workflow 改动改 `backend`；纯前端改动改 `frontend`）。严禁只改代码不 bump ——
 * 否则老设备比对版本号一致、会静默跳过更新。
 */
export interface AppVersion {
  data: number
  backend: number
  frontend: number
}

export const APP_VERSION: AppVersion = {
  data: 9,     // = migrations DATA_VERSION（迁移新增时与此同步 +1）
  backend: 4,  // 后端 workflow / runner 脚本有任何改动就 +1（1→2：dual_engine_runner 加 opt-in 文件交付——AI-1 按 @@FILE@@ 标记块交付、核查前剥离、结果回传 deliveredFiles；2→3：ai_call.mjs 的 web_search 不再硬绑 AI-1 必须是 DeepSeek，改为自动挑「配成 DeepSeek 的槽位」（AI-1 优先，否则 AI-2）取凭据/模型，修「联网检索总是失败」；3→4：dual_engine_runner 的输出预算不再写死 64000，改由前端按「ai1/ai2 两个模型较小的上下文窗口」算好后经 input.maxTokens 传入（防给 32K 窗口模型发 64000 输出被上游拒），不传则等值兜底 64000）
  frontend: 9, // 前端界面 / 交互改动就 +1（1→2：阅读页问 AI 面板「原点」+ 精简文案；2→3：VditorEditor 内置格式按钮操作后恢复选区，支持「先加粗再斜体」连续操作；3→4：VditorEditor 初始化改为「延迟创建 + 卸载取消」，修掉 React 18 StrictMode 双重挂载导致的编辑器串根 / 选区恢复失灵；4→5：会议转写默认模型按实测改为 Qwen3-ASR-1.7B，预置与提示文案同步更新；5→6：问 AI 支持交付文件（阅读页 / 写作页接入 + 「已交付文件」卡片）+ readRepoTextFile >1MB 走 Git Blob API 兜底；6→7：阅读页问 AI 面板把「联网」拆成与「可信检索」并列的独立开关，四组合全支持，默认 可信检索=开、联网=关；7→8：可信检索不再硬编码截断原文，改为按「模型→窗口」查证表估算 token——整本塞得下就送全文、塞不下则「目录 → AI 选章 → 送选中章节正文」两阶段，修「书里有却答 not in source」（ADJ-129）；8→9：修选章步骤「提问失败：AI 未按契约返回」——解析口径对齐 task-requirement-extractor（围栏不再锚定整串、补 {..} 提取，兜「围栏 / 前后夹带文字」两种等价形态），并区分「没返回 JSON」与「JSON 不可解析」的可读错误）
}
