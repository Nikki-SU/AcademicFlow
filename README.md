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
