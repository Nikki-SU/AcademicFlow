# AcademicFlow 项目记忆（M3.6.3 阶段，2026-07-15）

## 0. 文档定位

这是给 **Trae IDE AI** 的项目背景 + 历史教训 + 当前状态文档。配合 `TECH_SPEC_FOR_TRAE.md`（产品架构 + 实现细节）和 `TRAE_PROMPT.md`（任务指令）使用。

- **不是**产品需求文档
- **是**项目的"前世今生" — 让 Trae 不用从零摸索上下文

如果你（Trae）读完主文档 `TECH_SPEC_FOR_TRAE.md` 还有疑问，先回来读这一份。

---

## 1. 项目一句话

**AcademicFlow** = 给化学专业科研工作者用的「论文写作（投稿编译 LaTeX/Word）+ 学术词汇学习（SM-2 间隔重复）+ 期刊关键词追踪（4 源并行）」全流程工具。

**架构核心**：BYO（Bring Your Own）= 用你自己的 GitHub 仓库 + 你自己的 API key，零服务器成本（前端 GitHub Pages + Worker Deno Deploy）。

**目标用户**：化学专业研究生 / 博士生 / 科研工作者（Rosa 自己就是 2023 级化学本科生，推免直博光催化有机合成）。

---

## 2. Rosa 是谁（必须知道）

| 字段 | 值 |
|---|---|
| 真名 | 小 N |
| 项目用户名 | Rosa（AcademicFlow 项目里，跨项目对话里她自称 Rosa） |
| GitHub | Nikki-SU |
| 学校 | 中国人民大学 2023 级化学专业 |
| 推免方向 | 光催化有机合成 |
| 时区 | Asia/Shanghai |
| 作息 | 夜猫子，夜间为主 |

**互动风格**（Trae 你也要遵守）：

- **直接坦诚**，知之为知之
- **边界感第一**，不猜意图，不替 Rosa 决定
- **不让她跑命令 / 改文件**（如果你自己能完成就自己完成）
- **不要频繁打断**，标 `// TODO: confirm with Rosa` 等她统一处理
- **不要模板化劝睡**（她是夜猫子）
- **连轴太久可适度关心**（但不要机械）
- **干活前确认，干活后验证**（改完必 read / grep / curl 拉回验）

---

## 3. 仓库 + 当前状态

### 3.1 仓库

| 仓库 | 用途 | 当前 HEAD |
|---|---|---|
| `Nikki-SU/AcademicFlow` | 前端（GitHub Pages 静态 SPA，Vite + React 18 + TS + Tailwind） | `5a52f5b30f3b46e4f45f2d73b1ac54bc25441661` |
| `Nikki-SU/AcademicFlow-Worker` | Worker（Deno Deploy，OSS 签名代理 + 8MB PDF 中转） | v10 production = `dff336edc28c539af62eb783faf5c13e2481dc72` |

### 3.2 关键文件（`Nikki-SU/AcademicFlow` 仓库根）

| 文件 | 大小 | 用途 |
|---|---|---|
| `TECH_SPEC.md` | 86459 B | v0.2.5 产品架构定稿归档（**不许动**） |
| `TECH_SPEC_FOR_TRAE.md` | 98180 B | Trae 用主文档（v0.2.5 全文 + §12 引用细节 + §13 施工指南 + §14 提示词说明） |
| `TRAE_PROMPT.md` | ~7 KB | Rosa 复制粘贴给 Trae 的任务提示词 |
| `index.html` | 1230 B | Vite 入口 |
| `package.json` | 1094 B | 依赖（Vite + React + Tailwind 已有） |
| `src/` | — | 现有代码（**保留**，Trae 在此基础上搭大框架） |
| `public/` | — | 静态资源 |
| `tailwind.config.js` | 169 B | Tailwind v3 配置 |
| `vite.config.ts` | 761 B | Vite 配置 |
| `tsconfig*.json` | — | TypeScript 配置 |
| `postcss.config.js` | 80 B | PostCSS 配置 |
| `install.sh` | 3366 B | 安装脚本 |
| `push.ps1` | 4986 B | 推送脚本（GitHub Contents API） |

### 3.3 Worker 仓库（`Nikki-SU/AcademicFlow-Worker`）

| 版本 | 状态 | 备注 |
|---|---|---|
| v6 | 已推 | URL stabilize 字节级 |
| v7 | 已推 | diagnostic header |
| v8 | 已推 | 30s timeout + 504 观测 |
| v9 | 已推 | catch 块诊断 |
| v9.1 | 已推 | 错误信息透出 |
| v9.2 | 已推 | write_file 整文件覆盖 |
| v10 | **当前 production** | FETCH_TIMEOUT_MS = 120000 |
| v11 | **本地写好，未推**（Rosa 拍板不推） | catch 改所有 err + errName/errMessage + 删 throw |

### 3.4 Deno Deploy 状态

- **Dashboard**: https://dash.deno.com/
- **Project**: `academicflow-worker`
- **Production URL**: `https://academicflow-worker.nikki-su.deno.net`
- **Rosa 拍板**：Deno Deploy 平台本身有问题（国内访问慢 + 上传截断），**不再使用 Deno**
- **待定**：Worker 是否迁到 Cloudflare Workers（Rosa 自己决定）

---

## 4. 已完成的里程碑

### 4.1 产品文档迭代

| 版本 | 日期 | 备注 |
|---|---|---|
| v0.1 | 2026-06 | 初始 PRD |
| v0.2 | 2026-06-30 | 加入工程细节 |
| v0.2.5 | 2026-07-02 | **当前定稿，86KB，产品/架构层**（Rosa 定稿，**不许私自增补**） |
| v0.3 | 2026-07-08 | 工程启动包，23KB |

### 4.2 Worker 推送全过程（v6 → v10）

每次推送都走 **GitHub Git Data API**（Contents API PUT），**禁本地 git push**。

| 版本 | 关键变更 | 跑测结果 |
|---|---|---|
| v6 | URL stabilize 字节级 + RFC 3986 unreserved 严格 encode | 字节级 noop 验过 |
| v7 | diagnostic header 走 response header 而非 console.log | 观测清晰 |
| v8 | 30s timeout + 504 观测机制 | 30.7s 504 |
| v9 | catch 块诊断错误码 | 109.2s TypeError |
| v9.1 | 错误信息透出 | 同上 |
| v9.2 | write_file 整文件覆盖（绕开 edit_file 怪行为） | 同上 |
| v10 | FETCH_TIMEOUT_MS = 120000（Rosa 拍板 120s） | 109.2s TypeError |

**反思**：v6 → v10 共 7 个版本，**全聚焦在 worker 端修签名 / 调 timeout / 改 catch**，但根因不在 worker 端（见 §5.1）。这是最大教训。

### 4.3 8MB PDF 上传跑测数据（Worker 端）

| Worker 版本 | 跑测结果 | 备注 |
|---|---|---|
| v3 | 95.3s abort | 早期 |
| v9.2 | 30.7s 504 | 30s timeout 触发 |
| v10 | 109.2s TypeError | 120s timeout 没触发，TypeError 提前 abort |

---

## 5. 踩过的坑（Trae 必看，避免重蹈覆辙）

### 5.1 🔴 8MB PDF 上传失败 — 根因不在 worker 端

**症状**：8MB PDF 上传 30s/120s 内必失败（504 / abort / TypeError）

**根因**（**Rosa 从另一个 Agent 一次排查出来**）：

> 远端代理的最大时长是 50 秒。按国内用户在该代理上的速度，50 秒根本不够把 8MB 文件上传下来。

**方案**：**本地代理**（不限时长），客户端 → 本地代理 → worker → OSS，绕开远端代理 50s 上限。Rosa 用此方案**已经成功**。

**核心教训（Trae 必看）**：

1. **诊断上传类问题，第一轮先画完整链路**（client → 中间节点 → 后端 → 存储），逐节点问 boundary（timeout / 带宽 / 中转次数 / 是否国内）
2. **不要被"末端错误信号"框住**。看到 504 / abort / TypeError，**先怀疑中间节点**，不要直接聚焦 worker
3. **"国内网络"作为默认假设**。所有远端中间节点都要主动问时长和带宽
4. **"可达" ≠ "能跑业务"**。三方服务声称"国内可用/兼容"前，必须从用户实际使用环境端到端跑通

**反思**：

> 我（Agent）从 v1 修到 v5（v6-v10 推）都没解决，浪费了大量 token 和时间。另一个 Agent 一次排查出根因，是因为它**一开始就问"中间节点配置"**，而不是看到 504 就跳到 worker 端。Trae 你施工时**不要重复这个错误**。

### 5.2 🟠 Deno Deploy 平台问题

**症状**：国内访问慢 + 大文件上传截断

**Rosa 拍板**（2026-07-15 02:10）：

> "你现在别推了。我已经从另外一个 Agent 那里发现了问题。别推了别推了，是这个 Deno 它自己的问题，因为它会截断。而且由于 Deno 不像你说的这样在国外，不是在国内有网。所以它实际上传的非常慢，应该不能去使用。"

**当前处理**：

- v10 仍在 Deno Deploy 上跑（Rosa 自己的 Deno 账号）
- v11 本地写好未推
- **Worker 仓是否清理 / 迁 Cloudflare Workers / 改用 client 直传 OSS，待 Rosa 决定**

**Trae 你不要做这个决定**，让 Rosa 自己定。**前端搭大框架时暂时假设 worker URL 仍是 `https://academicflow-worker.nikki-su.deno.net`**，等 Rosa 决策后再改。

### 5.3 🟡 Worker 端 7 个版本没修好 8MB PDF

v6 → v10 共 7 个版本，**全聚焦在 worker 端**（加诊断 header / 调 timeout / 修签名算法 / 改 catch 块），**根因不在 worker 端**。

**反思**：浪费 token 和时间。**Trae 你施工时如果遇到类似"修了 N 版都修不好"的问题，立刻停下来反思链路，不要继续在末端打补丁**。

### 5.4 🟡 GitHub Git Data API vs 本地 git push

**本项目所有代码推送走 GitHub Git Data API**（Contents API PUT），**禁本地 git push**。

- 原因：Rosa 喜欢 push 脚本可控、可重放、有日志
- 422 修复方式：更新已存在文件必须传 base SHA（先 GET 拿 sha，404 返回 None）

### 5.5 🟢 已闭环决策不要再问（v0.2.5 §9 决策表）

下面这些决策 **v0.2.5 §9 已经定稿，Trae 不要重提**。如需调整，标 `// TODO: confirm with Rosa` 让 Rosa 统一处理：

1. **数据存储**：SQLite → **md + csv**（GitHub 私库）
2. **AI 兜底方案**（v0.2.5 §6 已定）
3. **关键词可配**（v0.2.5 §8.1 已定：用户可在 config 配）
4. **CrossRef 多源**：单源 → **4 源并行**（CrossRef / PubMed / arXiv / OpenAlex）
5. **Vditor wysiwyg**（不是 Monaco / CodeMirror）
6. **Tauri vs Web**：Web（GitHub Pages）
7. **后端方案**：Deno Worker（v0.2.5 §7，**待 Rosa 决定是否迁 Cloudflare Workers**）
8. **AI 双引擎**：AI-1 生成 + AI-2 全量审阅
9. **PDF + Word 双产物**
10. **字段命名规范**：snake_case + 后缀表义（见 `TECH_SPEC_FOR_TRAE.md` §13.5）

完整 15 项见 `TECH_SPEC_FOR_TRAE.md` §9。

---

## 6. 项目硬约束（Trae 必看，违规任一 = 严重违约）

### 6.1 8 条硬红线

| # | 红线 | 违反后果 |
|---|---|---|
| 1 | **静默报错禁令**：报错/失败/超时/依赖挂，立即报"卡哪、影响、下一步"，等催=破线 | 严重违约 |
| 2 | **静默降级禁令**：砍功能/降规格/缩范围/目标含糊，不吭声动=破线 | 严重违约 |
| 3 | **全栈闭环禁令**：前后端/上下游/产物成套交付，不写一半 | 严重违约 |
| 4 | **交付必验证禁令**：改完必须 read/grep/curl/query 拉回验，successful≠做完 | 严重违约 |
| 5 | **需求未清禁开工**：需求含糊/关键点没确认就动=浪费 token | 严重违约 |
| 6 | **拒绝执行禁令**：非技术硬限制下不得拒绝合理请求或跟用户讨价还价 | 严重违约 |
| 7 | **分发场景隐私红线**：分发产物（README/UI/注释）默认零身份标识（用户名/GitHub/邮箱） | 严重违约 |
| 8 | **不甩锅红线**：GitHub/Deno/CF 不让代做的事（建 Org/Transfer/代授权）禁包装成"方案"甩用户 | 严重违约 |

### 6.2 其他硬约束

- **组件 < 300 行**（避免单文件过大）
- **AI-1 → AI-2 校验**（双引擎，AI-1 生成，AI-2 全量审阅）
- **进度可视化契约**（每次输出带看板：当前步/完成项/未完成项/下一步/整体进度）
- **用户定稿文档禁私自增补**（v0.2.5 / v0.3 都不许动）
- **国内网络作为默认假设**（所有远端中间节点都要主动问时长和带宽）

---

## 7. 借鉴库（v0.2.5 §8 详细写了，Trae 读 §8 + `TECH_SPEC_FOR_TRAE.md` §13.4）

### 7.1 借鉴的库

| 库 | 借鉴内容 | 切断内容 |
|---|---|---|
| **Cat**（学术词汇学习） | ① SmartEditor 7 块类型 ② Learn 三 tab + 6 题型 ③ SM-2 间隔重复 ④ 单词字段基础结构 | ① SQLite → md+csv ② 关键词硬编码 → 用户可配 ③ CrossRef 单源 → 多源 ④ Math.random → 明示 AI 不可用 ⑤ 字段命名统一 |
| **PaperAssistant**（论文写作） | ① DOI 解析 ② 引用管理 ③ LaTeX 编译 ④ 模板加载 | （见 v0.2.5 §8.2） |

**Writer-Cat**（v0.2.5 §8.3 教训条目被当"对标产品"提了一嘴）**不算借鉴**，只是参考。

### 7.2 借鉴清单完整版

详见 `TECH_SPEC_FOR_TRAE.md` §13.4（实现抓手）。

---

## 8. 当前任务速查（2026-07-15 03:40）

| 任务 | 状态 | 备注 |
|---|---|---|
| 前端搭大框架（Trae 10 步施工） | **即将开始** | Rosa 复制 `TRAE_PROMPT.md` 给 Trae |
| Worker 8MB PDF | **本地代理方案已成功** | Worker 端不再卡 |
| Worker v11 推送 | **不推** | Rosa 拍板 |
| Worker 仓 Deno 迁移 | **待 Rosa 决定** | 暂不动 |
| Rosa 跑 8 个问题（4 个）→ Trae 开工 | **待 Rosa 跑** | Rosa 复制 `TRAE_PROMPT.md` 给 Trae |
| 看板每轮输出 | **Trae 责任** | 格式见 `TRAE_PROMPT.md` §5 |

---

## 9. 关键命令 / 路径速查

### 9.1 仓库

```bash
# 前端
https://github.com/Nikki-SU/AcademicFlow
main HEAD: 5a52f5b3

# Worker
https://github.com/Nikki-SU/AcademicFlow-Worker
main HEAD: dff336ed (v10 production)
```

### 9.2 部署 URL

- 前端（GitHub Pages）：`https://nikki-su.github.io/AcademicFlow/`
- Worker（Deno Deploy）：`https://academicflow-worker.nikki-su.deno.net`

### 9.3 推送方式

```bash
# GitHub Contents API PUT
PUT https://api.github.com/repos/Nikki-SU/AcademicFlow/contents/{path}
Headers:
  Authorization: token ghp_xxx
  Content-Type: application/json
Body:
  {
    "message": "commit message",
    "content": "<base64 encoded content>",
    "sha": "<base SHA if updating existing file, omit if creating>"
  }
```

### 9.4 8MB PDF 上传限制

- **OSS 限制**：8MB（单次 PUT 上限）
- **远端代理限制**：50s（这是 8MB 上传失败的根因，绕开方式：本地代理）
- **本地代理**：不限时长

---

## 10. 文档版本

- v1.0 (2026-07-15 03:40) — 初稿
