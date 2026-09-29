# 项目规则（AcademicFlow）

## 部署 / 推送（长期规则，用户 2026-09-29 明确要求）
- **有凭证就自动推送 + 部署，不必等用户开口。** 只要 `gh auth status` 显示已登录（具备 GitHub 凭证），改完代码、验证通过后，默认直接 **commit → push main → 触发 GitHub Pages 部署**，不再询问。
- 部署是**推送即自动**：`push main` 会触发 `.github/workflows/deploy.yml`（GitHub Actions → GitHub Pages），无需手动命令。
- 上线地址：https://nikki-su.github.io/AcademicFlow/
- 无凭证时：说明缺凭证并停下，不要假装已部署。

## 每次推送前的固定验证
1. `npm run lint`（= `tsc -b`）
2. `npm run build`（= `tsc -b && vite build`）
3. commit + `git push origin main`
4. `gh run list --workflow=deploy.yml -L 3` 或 `gh run watch` 确认最新一次 deploy 为 **success**
5. 需要时 `curl -sL https://nikki-su.github.io/AcademicFlow/ | grep assets/index-` 比对线上产物 hash 与本地 `dist/index.html` 是否一致。

## 其他
- 回复、代码注释、界面文案一律使用**中文**。
- 不写任何「兼容旧数据」的兜底代码；旧数据一律走一次性迁移（见 ADJ-54）。
- 架构决策沉淀到 `架构.md`（头部批次行 + §2 目标调整 + §3 决策记录）。
