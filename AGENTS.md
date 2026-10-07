# AGENTS.md — AcademicFlow 项目指引

> 本项目级指引每次对话自动进入上下文。核心**硬规则**在 `.trae/rules/project_rules.md`（已 alwaysApply 自动生效）；本文件负责**项目背景、文件地图与工作流速览**，详细经验请按「读我」清单主动读取，不要等用户交代。

## 这是什么项目

AcademicFlow：**学术工作流助手**（静态前端 SPA + 用户私库 GitHub Actions 后端管线）。用户上传论文 / 图书 / 课程材料 / 照片，由私库里的 workflow（MinerU 转写、AI 处理）产出 Markdown / 笔记，前端阅读与写作。用户环境通过**引导部署**实现：前端用用户 PAT 把 workflow 写入私库，版本更新即前后端一起更新。

- 技术栈：React + TypeScript + Vite（Tailwind，全站尺寸统一 vw/vh 参照系）；后端为写入用户私库的 GitHub Actions（`.mjs` runner + yml workflow，前端以 base64 嵌入）。
- 线上地址：https://nikki-su.github.io/AcademicFlow/（push main 自动触发 GitHub Pages 部署）。

## 文件地图（动手前先知道去哪读）

| 文件 | 内容 | 地位 |
|---|---|---|
| `.trae/rules/project_rules.md` | 硬约束：部署推送、密钥安全、先约束再容错、技术决策查证、带方案问用户、多段版本号体系等 | 已自动生效，必须遵守 |
| `架构.md` | 架构基线 + 全部决策记录（ADJ 编号，头部有批次索引） | 改架构 / 查决策依据时先读对应批次 |
| `UX_DETAILS.md` | UX 品味资产：历次界面 / 交互 / AI 输出展示的原则与踩坑 | **改任何交互 / 布局前必须先通读** |
| `src/constants/version.ts` | 多段版本号 `APP_VERSION`（data / backend / frontend） | **改完代码必须 bump 对应段** |
| `src/services/migrations.ts` | 数据迁移清单（DATA_VERSION = APP_VERSION.data） | 新增迁移必须 +1 并填 `since` / `affects` |

## 工作流速览

- **推送部署**：改完 → `npm run lint` + `npm run build` 双验证 → commit → push main（自动触发部署）。有 GitHub 凭证时自动做，不询问。
- **版本号**：改数据格式 bump `data`；改后端 workflow bump `backend`（启动自动同步私库）；改前端界面 bump `frontend`。忘 bump = 老设备跳过更新 = 静默用旧行为。
- **密钥**：任何 token / 密钥严禁进入 git 跟踪文件；前端密钥走 GitHub Actions Secrets（repoSecrets.ts 密封盒）。

## 读我（新对话 / 新任务先做）

1. 本文件已进上下文；硬规则已自动生效。
2. 要改**交互 / 界面 / AI 输出展示**：先通读 `UX_DETAILS.md`（文首布局自检必过）。
3. 要改**架构 / 引入机制**：先查 `架构.md` 有没有既有机制与决策（ADJ-54 / ADJ-57 / ADJ-63 / ADJ-126 等），说明它是什么、为什么接入或不接入。
4. 技术决策（API / 选型 / 超时 / 分块 / 并发）必须真实查证再定，依据写进回答；有疑惑带方案问用户。
5. 回复、代码注释、界面文案一律中文。
