# AcademicFlow

> 一款以 GitHub 为后端的个人学术工作流工具 · Vite + React + TypeScript · **AGPL-3.0-or-later**

**在线体验：** https://nikki-su.github.io/AcademicFlow/

> **许可提示**：本项目采用 AGPL-3.0（或更新版本）开源。若你在网络环境中运行、修改或分发本项目（包括作为 SaaS 提供服务），你必须向用户公开完整的源代码。详见本文件底部「许可」章节及 [LICENSE](./LICENSE)。

## 项目简介

AcademicFlow 是一个**纯前端 SPA**，把用户自己的 GitHub 私库作为存储后端、GitHub Actions 作为算力后端，覆盖学术科研的完整工作流：

- 🔎 **文献追踪（Tracking）** — 关键词布尔表达式 + 期刊追踪，定时计划自动抓取候选入库
- 📖 **精读（Reading）** — 文献 / 图书 / 文档统一精读，中英对照翻译、批注、笔记、问 AI
- 🎙️ **会议 · 课程（Session）** — 实时录音转写 + 拍照采集，课堂 / 组会记录
- ✍️ **写作（Writing）** — Markdown → LaTeX，本地 WASM / 云端编译 PDF，DOI 引用，双引擎 AI 写作
- 🔤 **学习（Learn）** — 阅读中划词收集生词 / 长难句 / 翻译练习，SM-2 间隔复习
- 📅 **日程（Schedule）** — 跨项目课程表、DDL 清单、校历与调休
- 🗂️ **管理（Management）** — 文献 / 模板 / 图书 / 文档全生命周期管理
- 🤖 **AI 助手** — 段落解读、术语解释、写作辅助、忠实性核查（AI-1 生成 + AI-2 审阅）

## 数据主权声明

AcademicFlow **无任何后端服务器**。所有数据（笔记、论文、词汇、AI 调用）均通过用户自己的凭据直连 GitHub / 硅基流动 / Free Dictionary，**工具作者在架构上无法获取任何用户数据**。代码开源可审计（AGPL-3.0），出站请求可通过浏览器 DevTools → Network 面板自行核验。

## 数据资源与第三方许可

AcademicFlow 在用户本地或用户自己的 GitHub 私库中处理数据，不内置、不托管任何受版权保护的学术内容。项目中可能引用的公开数据资源及其许可如下：

| 资源 | 用途 | 许可 |
|---|---|---|
| CSL 引用样式 | 参考文献格式化 | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| Academic Word List (AWL) | 学术词汇学习参考 | 仅作为用户可导入的公开词表示例，遵循原作者使用条款 |
| Free Dictionary API | 单词释义查询 | 按服务方公开接口条款使用 |
| CrossRef / OpenAlex | 文献元数据检索 | 按服务方 API 条款使用 |
| MinerU | PDF → Markdown 解析 | GitHub Actions runner 直调，按 MinerU 服务条款使用 |

> 注意：任何由用户自行导入的 PDF、图片、词表、引用样式等内容的版权均归用户或原权利人所有，AcademicFlow 仅提供本地/私库处理工具，不主张任何权利。

## MinerU PDF → Markdown（GitHub Actions runner 直调）

论文导入需要把 PDF 转成 Markdown（保留公式和图片），AcademicFlow 用 [MinerU v4 API](https://mineru.net)。MinerU 服务端不返回 CORS 头、浏览器不能直连，因此 PDF → Markdown 的调用**不在浏览器里做**，而是由 **GitHub Actions 后端 runner 直接调用**（`.github/scripts/*.mjs → https://mineru.net/api/v4`）。前端只把 `MINERU_API_TOKEN` 写入私库的 GitHub Secrets，不直接发 MinerU 业务请求。

> 早期版本曾用「用户自部署的透传代理（Deno Deploy / Cloudflare Workers）」转发 MinerU，该方案因 Deno Deploy 50s 超时 + GitHub Pages HTTPS → HTTP Mixed Content 双重阻塞已废弃（见 `src/services/mineruConnectivity.ts` 注释）。

### 数据链路

```
你的浏览器（前端 SPA）
   │  只把 MINERU_API_TOKEN 写入 GitHub Secrets（libsodium 密封盒）
   ▼
GitHub Actions runner（在 GitHub 的 VM 上，.github/scripts/*.mjs）
   │  直调 https://mineru.net/api/v4/*（PDF 上传 / 轮询 / 下载 markdown）
   └──→ 结果 commit 回你的 GitHub 私库
```

### 分发场景下的隔离

- 每个使用者的 runner 都跑在**各自自己的 GitHub 私库**里，用各自填的 `MINERU_API_TOKEN` 调 MinerU，作者不接触任何数据。
- 不需要用户部署任何代理服务；MinerU 的调用完全发生在 GitHub Actions（GitHub 官方托管 VM）内。

## 技术栈

| 层 | 选型 |
|---|---|
| 构建 | Vite 8 |
| 框架 | React 18 + TypeScript 7 |
| 路由 | React Router 7 |
| 状态 | Zustand 4 |
| 本地存储 | Dexie 4（IndexedDB 封装） |
| 样式 | Tailwind CSS 3 |
| Markdown | Vditor 3 |
| 图标 | Lucide React |
| 通知 | Sonner |
| 部署 | GitHub Pages（通过 Actions 自动部署） |

## 本地开发

```bash
npm install
npm run dev       # 本地开发（http://localhost:5173）
npm run build     # 生产构建
npm run preview   # 预览构建产物
```

## 部署

推送到 `main` 分支后，GitHub Actions 会自动构建并部署到 GitHub Pages。

## 许可

[AGPL-3.0-or-later](./LICENSE) — 你可以自由使用、修改、分发本项目，但衍生作品必须以相同许可开源。

## 状态

✅ **可用** — 已实现文献追踪、精读、会议转写、写作编译、学习打卡、日程、管理的完整科研工作流，持续迭代中。
