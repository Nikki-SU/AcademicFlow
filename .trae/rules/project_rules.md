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

## 其他
- 回复、代码注释、界面文案一律使用**中文**。
- 不写任何「兼容旧数据」的兜底代码；旧数据一律走一次性迁移（见 ADJ-54）。
- 架构决策沉淀到 `架构.md`（头部批次行 + §2 目标调整 + §3 决策记录）。
