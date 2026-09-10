# AcademicFlow 问题跟踪与方案讨论

> 本文档用于同步当前项目状态、核心问题、已做修改及下一步计划。
> 最后更新：2026-09-10

---

## 1. 项目简介

AcademicFlow 是一个面向学术研究的工作流工具，核心功能包括：

- 文献管理（DOI 入库、元数据存储）
- 论文阅读与批注
- 关键词/句式学习
- 写作项目管理
- 通过 MinerU API 解析 PDF

**技术栈**：React + TypeScript + Vite + Tailwind CSS + Zustand  
**后端存储**：GitHub 私有仓库（文献 CSV、项目 CSV、settings markdown 等）  
**PDF 解析**：MinerU API，通过本地 Deno 代理转发请求

---

## 2. 当前部署方式

- **前端**：部署在 GitHub Pages，强制 HTTPS  
  地址：`https://nikki-su.github.io/AcademicFlow/`
- **本地代理**：Deno 脚本 `worker/deno.js`，监听 `http://localhost:8000`
- **代理作用**：转发前端请求到 MinerU API，避免前端直接暴露 token 和处理 CORS

---

## 3. 核心问题

### 问题 A：HTTPS 页面无法请求 HTTP localhost 代理（浏览器 Mixed Content 限制）

**现象**：在 GitHub Pages（HTTPS）打开后，点击 MinerU 测试/解析按钮，提示：

```
Failed to fetch
TypeError: Failed to fetch
```

**根因**：浏览器安全策略禁止 HTTPS 页面向 HTTP 地址发送请求（Mixed Content）。这是 W3C/浏览器层面的硬限制，不是代码 bug。

**影响**：
- 用户无法通过 GitHub Pages 使用本地 MinerU 代理
- 每个访问者都会遇到这个问题，无法对外发布

**已排除的原因**：
- 代理本身正常（PowerShell 直接调用代理返回 `login required`，说明转发链路通）
- 不是 CORS 问题
- 不是代理端口问题

---

### 问题 B：start-proxy.bat 启动脚本路径判断不够健壮

**现象**：把 `start-proxy.bat` 放到项目根目录或 Windows 启动目录时，无法正确找到 `worker/deno.js`，导致代理启动失败。

**根因**：原脚本只处理了 bat 位于 `worker/` 目录下这一种情况。

**状态**：已修复。新脚本支持三级 fallback：
1. 用户手动配置 `MY_PROJECT_DIR`
2. bat 同级目录存在 `worker/deno.js`（项目根双击）
3. bat 上级目录存在 `worker/deno.js`（worker/ 下双击）

---

### 问题 C：MinerU 请求失败时错误信息不友好

**现象**：代理未启动或协议不匹配时，前端只显示 `Failed to fetch`，用户不知道具体原因。

**状态**：已修复。`src/services/mineru/client.ts` 增加了 `diagnoseFetchError`，会根据 URL 和错误类型给出明确指引。

---

## 4. 已完成的修改

| 文件 | 修改内容 |
|------|---------|
| `worker/start-proxy.bat` | 增加三级路径 fallback，支持项目根/worker/启动目录任意位置双击启动 |
| `src/services/mineru/client.ts` | 增加 `diagnoseFetchError`，优化 fetch 失败时的用户提示 |
| 多个页面数据加载 `useEffect` | 修复空依赖 `[]` 导致 F5 刷新后数据短暂消失的问题（依赖 `repo`） |
| `src/App.tsx` / `src/services/userData.ts` | 修复 workspace 初始化 race condition 和静默丢弃写入的问题 |

以上修改均已推送到 `main` 分支并部署到 GitHub Pages。

---

## 5. 当前阻塞

**主要阻塞仍是问题 A**：GitHub Pages（HTTPS）无法直接使用 HTTP localhost 代理。需要选择一个产品方案。

---

## 6. 可选方案对比

| 方案 | 是否碰云端 | 给用户负担 | 开发工作量 | 说明 |
|------|-----------|-----------|-----------|------|
| A. 本地 HTTPS 代理 + 自签名证书 | 否 | 中 | 小 | 首次访问需手动点"继续前往 localhost（不安全）"，对普通用户不友好 |
| B. 浏览器扩展 | 否 | 小 | 中 | 扩展 origin 可绕过 Mixed Content，用户只需安装扩展 + 启动本地代理 |
| C. 本地 all-in-one（proxy + 静态前端 HTTP server） | 否 | 中 | 小 | 用户不再访问 GitHub Pages，改访问 `http://localhost:5173`，不适合"给别人用" |
| D. 桌面应用（Tauri / Electron） | 否 | 中 | 大 | 彻底解决，可应用内浏览网页并返回，但需重构项目、打包分发 |
| E. 云端代理（Deno Deploy / Cloudflare Workers） | 是 | 小 | 小 | 体验最好，但用户明确拒绝（数据隐私） |

**决策方向（待确认）**：
- 短期：先在本地开发模式下调通 MinerU 全流程（`http://localhost:5173` + `http://localhost:8000`）
- 长期：另起一个 Rust + Tauri 桌面应用项目，作为最终对外发布形态

---

## 7. 本地开发调试步骤

在最终方案确定前，建议用本地开发模式验证功能逻辑：

### 7.1 启动本地代理

```powershell
cd C:\你的路径\AcademicFlow\worker
deno run --allow-net deno.js
```

如果 `deno` 不在 PATH：

```powershell
& "$env:USERPROFILE\.deno\bin\deno.exe" run --allow-net deno.js
```

验证：`http://localhost:8000/__af_health` 应返回绿色页面。

### 7.2 启动前端 dev server

```powershell
cd C:\你的路径\AcademicFlow
npm run dev
```

### 7.3 打开并测试

浏览器访问：`http://localhost:5173`

设置页确认 MinerU 代理地址为：`http://localhost:8000`

然后测试 MinerU 上传/解析流程。

---

## 8. 待解决问题清单

- [ ] 在本地开发模式下完整跑通 MinerU PDF 解析流程
- [ ] 确认 MinerU API Token 的获取和配置方式
- [ ] 决定最终产品形态：浏览器扩展 / Tauri 桌面应用 / 其他
- [ ] 如果选择 Tauri，规划重构范围：哪些服务迁到 Rust，哪些保留在前端
- [ ] 修复健康检查中 `upstream` 字段带反引号的小显示问题（不影响功能）

---

## 9. 关键联系人

- 主要负责人：Nikki
- 协作对象：（待补充）

