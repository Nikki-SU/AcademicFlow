# AcademicFlow 项目报告

> 一款以 GitHub 为后端的个人学术工作流工具 · Vite + React + TypeScript · AGPL-3.0

- **GitHub 仓库**：https://github.com/Nikki-SU/AcademicFlow
- **在线体验**：https://nikki-su.github.io/AcademicFlow/

---

## 一、项目概述

AcademicFlow 是一款**纯前端 SPA（Single Page Application）学术工作流工具**，采用「无自建后端 + GitHub 私库作为存储后端」的极简架构，覆盖学术工作中最高频的四类场景：

- 📝 **笔记（Notes）** — Markdown 编辑，支持双链和标签
- 📚 **论文（Papers）** — 元数据管理、PDF 引用、参考文献生成
- 🔤 **生词本（Vocabulary）** — 阅读中划词收集，间隔复习
- 🤖 **AI 助手** — 段落解读、术语解释、写作辅助、忠实性核查

项目最大特色是**数据主权架构**：工具作者在架构层面无法获取任何用户数据，所有数据均通过用户自持凭据直连 GitHub / 硅基流动 / MinerU，代码完全开源可审计（AGPL-3.0）。

---

## 二、技术栈

| 层 | 选型 |
|---|---|
| 构建 | Vite 5 |
| 框架 | React 18 + TypeScript 5.5 |
| 路由 | React Router 6 |
| 状态管理 | Zustand 4 |
| 本地存储 | Dexie 4（IndexedDB 封装） |
| 样式 | Tailwind CSS 3 |
| Markdown 编辑器 | Vditor 3 |
| 公式渲染 | KaTeX |
| 图标 | Lucide React |
| 通知 | Sonner |
| 部署 | GitHub Pages（通过 Actions 自动部署） |

---

## 三、核心功能与技术实现

### 3.1 数据主权架构（核心创新点）

**问题**：传统学术工具要么把用户数据存到厂商服务器（隐私风险），要么需要用户自建后端（部署门槛）。

**解决方案**：
- 浏览器直连 `api.github.com`（该端点支持 CORS），用用户自己的 GitHub PAT（Personal Access Token）作为凭据
- 所有用户数据（笔记、论文、词汇、AI 凭据）存储在浏览器 IndexedDB 中，物理隔离
- 源码中**没有任何硬编码的代理 URL 或后端地址**，未配置时功能自动 disabled，从架构上杜绝作者接触用户数据的可能
- 出站请求可通过浏览器 DevTools → Network 面板自行核验

**认证双路径**：
- **Device Flow**（主路径）：OAuth 标准设备流程，无需后端、无需密钥
- **PAT**（备路径）：用户手动粘贴 Personal Access Token，前端校验 scope 与有效期

### 3.2 GitHub 私库初始化（Git Data API 工程化）

**问题**：用 GitHub 作为存储后端，需要在用户名下自动创建私库并写入初始骨架文件。

**技术难点**：
- 完全空仓库调用 `POST /git/blobs` 会返回 409 "Git Repository is empty"
- 需要兼容「完全空仓」与「已有 initial commit」两种起始状态

**解决方案**：实现自适应初始化流程
1. 通过 `GET /repos/{owner}/{repo}/branches` 判断仓库是否为空
2. 空仓库先用 Contents API PUT 引导第一个文件（自动创建 main 分支 + initial commit）
3. 剩余骨架文件走 Git Data API 追加模式（blob → tree → commit → PATCH refs）
4. UTF-8 安全的 base64 编码（解决浏览器 `btoa` 处理中文抛错问题）

### 3.3 AI 双引擎忠实性核查（最具创新性）

**问题**：LLM 在做总结时常见两类问题——「加戏」（编造源材料未提及的内容）和「曲解」（扭曲原文含义）。传统单模型自审无法可靠发现。

**解决方案**：设计**对抗式双引擎编排**

- **AI-1（生成位）**：拿源材料 + 用户指令生成总结
- **AI-2（核查位）**：拿（源材料, AI-1 总结）逐句做忠实性核查，输出三类 verdict：
  - `supported`：源材料明确支撑
  - `added`：AI-1 加戏（追责项）
  - `contradicted`：AI-1 曲解（追责项）
- **前端引证锚定校验**：用 `sourceMaterial.includes(source_span)` 字面匹配，防止 AI-2 编造引用

**分层归因重试循环**（最多 5 轮）：
- 错在 AI-2（引证锚定失败）→ 只让 AI-2 自我纠错，AI-1 输出保留不变
- 错在 AI-1（引证 ok 但 passed=false）→ 打回 AI-1 重写 + AI-2 重审
- 两个都错 → 优先归因 AI-2（引证都错，AI-2 的 verdict 也不可信）

**治本方案（固定 tag 三层保底）**：
针对「元陈述」（如用户问作者信息但源材料未提及）引发的死循环 bug，引入 `[NOT_IN_SOURCE] <字段>` 固定 tag：
1. AI-1 硬编码使用 tag 标记元陈述
2. AI-2 抽取阶段识别 tag → 跳过，不成为 claim
3. 前端 `verifyEvidence` 兜底过滤

三层任一失守，其他层还能拦截，从根源上避免「AI-2 判 verdict 陷入模糊边界 → 改判 added → AI-1 rewrite 死循环」的旧 bug。

### 3.4 MinerU PDF → Markdown 流水线（BYO 代理）

**问题**：论文导入需要把 PDF 转成 Markdown（保留公式和图片），MinerU v4 API 服务端不返回 CORS 头，浏览器无法直连。

**解决方案**：BYO（Bring Your Own）透传代理架构
- 每位用户自己部署透传代理到自己的账号（Deno Deploy 或 Cloudflare Workers 二选一）
- 代理约 200 行代码，不缓存、不落盘、不记录任何请求，完全开源可审计（MIT 协议）
- 源码中 `DEFAULT_SETTINGS.mineruWorkerUrl = ''`，未配置时功能 disabled，绝无回退到作者代理的可能

**5 阶段流水线编排**：
1. 申请上传 URL（POST /api/v4/file-urls/batch）
2. PUT 上传 PDF 到阿里云 OSS 预签名 URL
3. 轮询解析状态（GET /api/v4/extract-results/batch/{batch_id}）
4. 下载解析产物 zip
5. JSZip 解压 + 图片交叉验证（识别缺失图与孤儿图）

每阶段都有 progress callback，UI 实时展示时间线；debug 模式下还会记录每次 fetch 的 method/url/status/duration/body 片段，便于定位卡点。

### 3.5 期刊模板与引用系统

- 期刊模板：存储投稿须知 + LaTeX 排版参数（documentclass、宏包、双栏、字号、页边距等）
- 投稿须知版本历史留痕（content hash 检测变化）
- CrossRef / OpenAlex 引用元数据自动获取与缓存（DOI 归一化为主键）
- Markdown → LaTeX 转换（AI 辅助）

### 3.6 工程化质量

- **TypeScript 严格类型**：700+ 行类型定义集中管理，所有 API 契约（GitHub / MinerU / OpenAI 兼容）都有对应 interface
- **自定义错误类**：`GitHubAPIError` 承载 status + 原始 message + 友好提示三层信息，区分 401/403/scope 不足/网络错误/CORS
- **Dexie schema 版本演进**：v1 → v2 → v3 平滑升级
- **路由保护三态**：未登录 → 登录 → Onboarding → 主界面
- **JSDoc 详尽**：关键设计决策（如空仓引导策略、tag 治本方案）都写明「为什么」
- **GitHub Actions 自动部署**：推送 main 分支自动构建并部署到 GitHub Pages

---

## 四、项目亮点

1. **架构创新**：用「GitHub 私库 + IndexedDB」组合替代传统后端，在零服务器成本下实现数据持久化与多设备同步，同时保证用户数据主权

2. **AI 工程化深度**：双引擎 + 分层归因 + 引证锚定 + 固定 tag 三层保底，是经过多次迭代修复死循环 bug 后的成熟设计，体现了对 LLM 行为边界的深刻理解

3. **隐私架构彻底**：从源码层面杜绝作者接触用户数据的可能，README 数据链路图透明可审计，分发场景下也保持物理隔离

4. **工程完成度高**：从认证、初始化、AI 编排、PDF 解析、期刊排版到引用管理，覆盖学术工作完整链路，代码注释与类型定义质量高于一般个人项目水准

5. **跨层技术综合**：前端工程（React + TS + Tailwind）、API 集成（GitHub / OpenAI 兼容 / MinerU）、分布式代理（Deno / Cloudflare Workers）、AI Prompt 工程、数据库 schema 演进均有涉及

---

## 五、项目链接

- **GitHub 仓库**：https://github.com/Nikki-SU/AcademicFlow
- **在线体验**：https://nikki-su.github.io/AcademicFlow/
- **代理模板仓库**（BYO 透传代理，MIT 协议）：https://github.com/Nikki-SU/AcademicFlow-Worker
- **开源协议**：AGPL-3.0-or-later

---

## 六、技术关键词

`React 18` · `TypeScript 5.5` · `Vite 5` · `Zustand` · `Dexie / IndexedDB` · `React Router 6` · `Tailwind CSS` · `Vditor` · `KaTeX` · `GitHub REST API` · `OAuth Device Flow` · `Git Data API` · `OpenAI 兼容 API` · `LLM 双引擎编排` · `Prompt Engineering` · `MinerU v4 API` · `BYO 代理架构` · `Deno Deploy` · `Cloudflare Workers` · `JSZip` · `GitHub Actions CI/CD` · `CORS` · `JWT` · `Base64 UTF-8 安全编码`
