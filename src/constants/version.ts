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
  backend: 1,  // 后端 workflow / runner 脚本有任何改动就 +1（初始 1 已含 session_images 超时调整）
  frontend: 3, // 前端界面 / 交互改动就 +1（1→2：阅读页问 AI 面板「原点」+ 精简文案；2→3：VditorEditor 内置格式按钮操作后恢复选区，支持「先加粗再斜体」连续操作）
}
