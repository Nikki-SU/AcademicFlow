# AcademicFlow

> 一款以 GitHub 为后端的个人学术工作流工具 · Vite + React + TypeScript · AGPL-3.0

**在线体验：** https://nikki-su.github.io/AcademicFlow/

## 项目简介

AcademicFlow 是一个**纯前端 SPA**，把用户自己的 GitHub 私库作为存储后端，覆盖学术工作中最高频的四类场景：

- 📝 **笔记（Notes）** — Markdown 编辑，支持双链和标签
- 📚 **论文（Papers）** — 元数据管理、PDF 引用、参考文献生成
- 🔤 **生词本（Vocabulary）** — 阅读中划词收集，间隔复习
- 🤖 **AI 助手** — 段落解读、术语解释、写作辅助

## 数据主权声明

AcademicFlow **无任何后端服务器**。所有数据（笔记、论文、词汇、AI 调用）均通过用户自己的凭据直连 GitHub / 硅基流动 / Free Dictionary，**工具作者在架构上无法获取任何用户数据**。代码开源可审计（AGPL-3.0），出站请求可通过浏览器 DevTools → Network 面板自行核验。

## MinerU PDF → Markdown（BYO 代理，双 Runtime）

论文导入需要把 PDF 转成 Markdown（保留公式和图片），AcademicFlow 用 [MinerU v4 API](https://mineru.net)。但 MinerU 服务端不返回 CORS 头，浏览器不能直连，需要一个「透传代理」。

**这个代理由每位用户自己部署到自己的账号，作者不接触任何数据。** 提供两种 Runtime，功能等价，同一份代码，用户在 Settings 面板里二选一：

| | 🇨🇳 Deno Deploy | 🌍 Cloudflare Workers |
|---|---|---|
| **国内直连** | ✅ 三大运营商基本可达 | ❌ workers.dev 需代理 |
| **部署** | dash.deno.com 网页 6 步（含 Organization 建立） | Deploy Button 一键 |
| **免费额度** | 100k requests/day | 100k requests/day |
| **推荐给** | 国内用户（默认） | 有代理 / 出海用户 |

### 数据链路

```
你的浏览器
   │  (1) 申请上传 URL / 轮询 / 下载 markdown
   ▼
你的代理（Deno Deploy 或 Cloudflare Workers）  ──→  https://mineru.net/api/v4/*
   │  (2) PUT 上传 PDF / GET 下载 zip 走 /proxy 白名单转发
   └──→  MinerU 阿里云 OSS 预签名 URL (*.aliyuncs.com)
```

代理代码约 200 行（core.js + 两个入口），不缓存、不落盘、不记录任何请求，完全开源可审计（MIT 协议）：
👉 https://github.com/Nikki-SU/AcademicFlow-Worker

### 分发场景下的隔离

如果 AcademicFlow 被分发给多个用户：

- **每位用户走各自部署的代理**，URL 只保存在各自浏览器的 IndexedDB（Origin 隔离，物理分区）
- 源代码里**没有任何硬编码的代理 URL**（`DEFAULT_SETTINGS.mineruWorkerUrl = ''`），未配置时 MinerU 测试按钮 disabled、流程抛错，绝无回退到作者代理的可能
- 作者只提供两个静态资源：GitHub Pages 上的前端 SPA + GitHub 上的 Worker 模板仓库；两个都是纯代码，不承载数据

即使把 AcademicFlow 前端 URL 转发给 100 个用户，作者仍然全程零接触任何请求和数据。

## 技术栈

| 层 | 选型 |
|---|---|
| 构建 | Vite 5 |
| 框架 | React 18 + TypeScript 5.5 |
| 路由 | React Router 6 |
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

🚧 **M0（部署骨架）** — 当前阶段
