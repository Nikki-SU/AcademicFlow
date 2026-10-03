# 项目规则（AcademicFlow）

## 部署 / 推送（长期规则，用户 2026-09-29 明确要求）
- **有凭证就自动推送 + 部署，不必等用户开口。** 只要 `gh auth status` 显示已登录（具备 GitHub 凭证），改完代码、验证通过后，默认直接 **commit → push main → 触发 GitHub Pages 部署**，不再询问。
- 部署是**推送即自动**：`push main` 会触发 `.github/workflows/deploy.yml`（GitHub Actions → GitHub Pages），无需手动命令。
- 上线地址：https://nikki-su.github.io/AcademicFlow/
- 无凭证时：说明缺凭证并停下，不要假装已部署。
- 若 `git push` 报 `could not read Username for 'https://github.com'`：先执行 `gh auth setup-git` 接上凭证助手，再重推。

## 每次推送前的固定验证
1. `npm run lint`（= `tsc -b`）
2. `npm run build`（= `tsc -b && vite build`）
3. commit + `git push origin main`
4. `gh run list --workflow=deploy.yml -L 3` 或 `gh run watch` 确认最新一次 deploy 为 **success**
5. 需要时 `curl -sL https://nikki-su.github.io/AcademicFlow/ | grep assets/index-` 比对线上产物 hash 与本地 `dist/index.html` 是否一致。

## 密钥安全（硬约束，用户 2026-09-29 明确要求）
- 本仓库是**公开库**（GPL 系许可证），**任何密钥/token 都严禁进入被 git 跟踪的文件或提交历史**。
- `GH_TOKEN` 等凭证**只允许存在于运行时环境变量**（如 `GH_TOKEN`）；可以使用、可以推代码，但**不得落盘到仓库**。
- 禁止：把 token 写进 `.env`（已被忽略也别依赖）、写进脚本常量、拼进 remote URL 后 `git remote set-url` 持久化、在命令 / 日志 / 提交信息里 echo 打印 token。
- 推送前用 `gh auth setup-git` 接凭证助手（token 由 credential helper 运行时读取，不进仓库）；不要手写 `https://user:token@github.com`。
- 前端密钥一律走 GitHub Actions Secrets（`src/services/repoSecrets.ts` 用 libsodium 密封盒写入），代码里只引用 `${{ secrets.* }}`；运行时读 `process.env.*`。
- 新增文件若含密钥特征（`ghp_` / `github_pat_` / `sk-` / 私钥块等）必须先拦下，不得提交。

## 工程原则：先约束，再容错（Garbage in, garbage out，ADJ-68 / ADJ-70）
- **容错不等于用容错去掩盖约束不足。优先把约束写足，再谈容错。**
- 凡调用 AI / 外部上游并约定**结构化返回**（JSON 等）的地方：**prompt / 契约里先把 schema 约束死** —— 字段名 / 类型 / 层级逐字写明、给**合法 JSON 示例**、显式禁止代码块 / 多余文字 / 别名键名 / 字符串数字混用。
- 解析层容错只作**约束之后的安全网**，且只兜「真正可能出现的等价形态」；**禁止**猜未在约定内的字段别名、**禁止**解析失败静默降级成 空/0/默认值、**禁止链式容错**（容错产物又被下游再容错）。
- **兜底值必须是确定正确的**（如原文本身），不能是"看起来合理"的猜测。
- 违规（核心字段缺失 / 非数字等）一律**报可读错误让用户重试**，不给"像结果其实是垃圾"的东西。
- **新增 / 修改任何解析逻辑前，先按此口径审查**：这次是不是又在用容错遮约束不足？

## UX 资产（长期规则，用户 2026-10-02 明确要求）
- `UX_DETAILS.md` 是**资产**，累积了历次 UX 要求与踩过的坑。它**不是一次定死的文档**，而是按「**写前先查 → 写后再补**」的闭环滚动维护。
- **写前先查**：动手改任何交互 / 界面 / AI 输出展示前，**先通读 `UX_DETAILS.md`**，按里面既有原则来，不要重犯。
- **写后再补**：如果这次的方案**资产里没有覆盖**（新原则 / 新踩坑），**写完必须回写进 `UX_DETAILS.md`**（现象 → 为什么 → 怎么做）；不能只留在代码或对话里。
- 用户已明说：「不要每次犯错都要人来说。」——UX 类问题应**自查**，不要等用户指出。
- **改任何「高度 / 布局 / 容器」前，先过 `UX_DETAILS.md` 文首的布局自检**（已重犯多次，必须硬拦）：
  1. 会不会冒滚动条？**能一屏放下就必须一屏放下**，出现滚动条即违规（见「能不滚动就不滚动」原则）。
  2. 高度只能来自外壳已给的**剩余空间**（`flex h-full flex-col` + `flex-1 min-h-0`）；**禁止** `calc(100svh - N)` 这类魔法扣减去猜。
  3. **禁止**在外层列高之外再叠一层独立视口比例（`vh` / `clamp(vw)`）——两套口径必打架。
  4. `overflow` 只作兜底，**不作常态**；见滚动条先想「间距 / 口径」，不是「加滚动」。

## 其他
- 回复、代码注释、界面文案一律使用**中文**。
- 不写任何「兼容旧数据」的兜底代码；旧数据一律走一次性迁移（见 ADJ-54）。
- **每新增一条数据迁移（`src/services/migrations.ts` 的 `MIGRATIONS`），必须把 `DATA_VERSION` +1，并给该迁移填 `since = 新 DATA_VERSION`**（ADJ-57 / ADJ-59）——否则老设备比对「版本号一致」会跳过新迁移；`since` 用于增量闸门：版本升级时只探「这一代新加」的迁移，不重扫存量。
- **每新增一条迁移，必须填 `affects`（受影响的功能域）**（ADJ-63）：迁移期间这些页面会被 `MigrationLock` 暂时锁定，避免用户读到 / 写到半迁移的旧值；漏填会导致该页面在迁移途中仍可进入、看到错误数据。
- 架构决策沉淀到 `架构.md`（头部批次行 + §2 目标调整 + §3 决策记录）。
