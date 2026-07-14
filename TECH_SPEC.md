# 学术工作流工具 · 技术说明书 v0.2.5

> 工作代号：**AcademicFlow**（正式名称待定）
> 版本：v0.2.5（需求 + 架构 + 接口定义阶段，不含代码）
> 编制日期：2026-07-10
> 版本历史：
> - v0.1（2026-07-10 16:27）：首版全量交付
> - v0.1.1（2026-07-10 16:30）：AI 写作动作"找证据"改为"新颖性检查"；新增 AI 不做立场性工作条款
> - v0.2（2026-07-10 16:36）：闭环全部 §9 未决问题——移动端确定为**跨端功能对等硬需求（非阉割版）**；期刊模板出厂零预置改为用户全自由维护；课本粒度加章节级引入；UI 默认中文；许可 AGPL-3.0
> - v0.2.1（2026-07-10 16:41）：前端布局策略精化——**只维护横屏 + 竖屏两套样板**，组件内部全部相对单位（%、vw/vh、rem、flex/grid 比例），禁用绝对 px；样板按**设备物理方向**路由，见 §2.4
> - **v0.2.2（2026-07-10 21:03）**：编辑器交互 + 对外交付格式双升为全局硬约束。① 编辑器改选 **Milkdown/Crepe（Obsidian 风 Live Preview WYSIWYG）**——源码-渲染同框内联，无编辑/预览切换、无弹窗打断；TipTap 块式 UX 淘汰。② 对外**唯一交付形态 = 编译好的 PDF + 格式正确的 Word**，md 只作内部落盘、不作对外产物。见 §1.10 / §1.11 / §2.1 / §5.7 / §5.8
> - **v0.2.3（2026-07-12 13:00）**：基于上一代 PaperAssistant 真实代码回扒（GitHub Nikki-SU/PaperAssistant，Tauri v2 + FastAPI，Vditor ^3.10.4 实装、xelatex→pdflatex→lualatex→tectonic 引擎链已跑通），三项修正：① §1.10 加**图片资源嵌入**细化（base64 内嵌 md 已在 PaperAssistant 实测跑通，方案直接沿用）；② §1.11 编辑器选型**软化为候选池**——**Vditor 首选（上一代实测跑通）**、Milkdown/Crepe、CodeMirror 6+装饰器、TipTap 有条件回归候选池，v0.3 用交互原型对比敲定；保留感受层硬约束（内联能改、零弹窗、源码-渲染同框或至少无切换按钮）；③ §5.8 补**PDF 导出频率标注**（低频入口，独立面板/切换视图，不占编辑器工具栏主位）；④ §8 撤回"TipTap 淘汰"反面案例，改为**"对标产品措辞是感受提示不是技术硬约束"**教训条目。见 §1.10 / §1.11 / §2.1 / §5.7 / §5.8 / §8
> - **v0.2.4（2026-07-12 14:07）**：DOI 展示形态硬约束升级——**存储/去重/比较层继续归一化兼容纯 DOI 与 DOI 链接**（v0.2.3 已定），**展示层默认统一渲染为可点击的完整 DOI 链接**（`https://doi.org/{doi}`）。纯 DOI 字符串不可直接点击跳原文，对人类不友好；凡表格列、卡片字段、追踪推送、单词卡回链等展示位置一律输出完整链接形态。见 §1.2 / §5.2 / §5.5 / §5.6 / §9
> - **v0.2.5（2026-07-12 17:30）**：GitHub 私库接入认证方案闭环——**Device Flow 主路径 + Fine-grained PAT 兜底 + IndexedDB 存 Token + 新增 §5.0 认证/onboarding UI 模块 + 显式化登出/切号/Token 失效流**。v0.2.4 之前登录只散在 §7.1 一句"点击『用 GitHub 登录』→ OAuth（repo 权限）"，未具体化认证 flow、Token 存储位置、XSS 缓解、切号登出等，v0.2.5 全部闭环。GitHub Pages 无后端硬约束（§2.3）下，传统 OAuth Web Flow 需 `client_secret` 不可行，Device Flow 是唯一零后端零密钥的原生方案；对不愿走 Device Flow 或需单库权限最小化的使用者，提供 Fine-grained PAT 手贴兜底路径。见 §1.12 / §2.1 / §2.2 / §2.3 / §5.0 / §7.1 / §9
> 编制者：小科（依据与 Rosa 的对话闭环）

---

## 0. 定位与目标用户

**一句话定位**：把学术工作全链路（追踪 → 管理 → 阅读+笔记 → 学习 → 写作 → 投稿）打通的、以 Markdown + CSV 为唯一落盘格式的、**跨端可用**、可分发的静态 SPA 工具。

**目标用户**：
- 首要：Rosa 本人（化学专业本科生，钙钛矿太阳能电池方向）
- 次要：任何有意愿在自己 GitHub 私库存学术数据的科研工作者

**分发形式**：
- 分发对象是**软件本身**，不是数据。
- 每个使用者拥有独立的 GitHub 私有仓库存储自己的全部数据。
- 前端部署为一份 GitHub Pages 静态站点，所有使用者访问同一 URL，各自登录 GitHub 后读写自己的私库。

**跨端策略（v0.2 新增，硬需求）**：
- 前端 = **PWA（Progressive Web App）+ 横竖两套样板 + 相对单位布局**，一份代码、一份能力，任何屏幕（PC / 笔记本 / 平板 / 手机 / 折叠屏 / 竖屏显示器）全支持。同一 URL 同一账号，数据后端就是 GitHub 私库，天然跨端。
- **功能对等，不是阉割版**：移动端与桌面端能力完全一致。全部模块（追踪、管理、**PDF→md**、阅读批注、笔记、学习、写作、投稿、模板管理）都能在手机上完整触发和完成。手机拍照/文件选择器传 PDF → MinerU 转 md → 切图 → 单词提取 → 入库 → 批注/学习/写作/投稿，全链路可跑。
- **允许的差异仅两类**：
  1. UI 布局：**仅维护横屏样板 + 竖屏样板两套**（不是"桌面/平板/手机三档"，也不是按设备类型分档）。组件内部一律用相对单位（%、vw/vh、rem、flex/grid 比例），禁用绝对 px 定位。样板按**设备物理方向**自动路由：横屏形态（PC/笔记本/平板横屏）→ 横屏样板；竖屏形态（手机/平板竖屏）→ 竖屏样板。**内容与功能完全一致，只是排布方式随方向切换**。详见 §2.4。
  2. 重计算任务耗时：如 Tectonic WASM LaTeX 编译、编辑器大文档渲染，在低端手机上耗时更长——UI 需显示进度、支持后台任务、允许中断/重试。**能跑，只是慢**，不是"不能用"。
- **禁止的差异**：任何"手机端不做 X 模块 / 手机端只做只读 / 手机端不支持某功能"的设计视为需求缺陷。
- 移动端不做原生 App，PWA 一份到底。

---

## 1. 全局硬约束（元原则 & 铁律）

所有模块、所有代码路径必须遵守以下规则。任一冲突必须回溯需求收集阶段确认，禁止在实现中静默妥协。

### 1.1 元原则
1. **默认自动化优先**：能用规则/AI 自动处理的，绝不弹选择框；边界 case 用默认规则兜底，不制造决策负担。
2. **用户第一次说 = 硬约束**：不需要反复强调才升级；不许降格为"建议""参考""偏好"。
3. **AI 双引擎强制**：科研生产任何环节的 AI 输出，必须走 AI-1 生成 + AI-2 审阅通过后才呈现给用户。
4. **默认继承**：老 PaperAssistant 五阶段与铁律默认继承进本项目，除非用户明确撤销。

### 1.2 数据铁律
- **只允许 Markdown + CSV 落盘**。JSON 仅可用于 HTTP 在途，不得写入 GitHub 私库。
- **DOI ≡ DOI 链接（存储/比较层）**：所有 DOI 输入/比较/去重/存储必须先归一化，视 `10.xxx/xxx`、`https://doi.org/10.xxx/xxx`、`http://...`、`dx.doi.org/...`、末尾带斜杠/不带斜杠为同一实体。CSV `doi` 字段**统一存归一化后的纯 DOI 形态**（`10.xxx/xxx`，不含协议前缀），作为 primary_key 保证唯一。
- **DOI 展示统一为完整链接（展示层，v0.2.4 新增硬约束）**：任何 UI 展示位置——表格列、卡片、详情面板、追踪推送、单词卡来源、批注元数据回链、写作稿引用悬浮预览等——**默认渲染为可点击的完整 DOI 链接 `https://doi.org/{归一化后的 doi}`**，点击新标签打开原文。纯 DOI 字符串不可直接跳转，对人类不友好，禁止只展示 `10.xxx/xxx` 而不包链接。列头文案统一叫**"DOI 链接"**（不是"DOI"），明示可点跳的产物形态。
- **图片零丢失**：PDF→md 全链路任何环节不得丢图；化学材料领域最高优先级铁律。

### 1.3 AI 可信性铁律
- 声称"来自某文献/某课本"的内容必须经 AI-2 核查原文。
- **AI 不可用时明确告知用户"不评分/不生成"**，禁止用随机数/占位内容伪造。
- AI 缺信息时告知用户如何补充，不得编造。
- AI 输出**物理隔离**用户原文：AI 生成内容默认放"AI 输出区"（侧栏/批注层），用户点击"接受"才合入正文；不得直接改写用户已写的文字。
- 用户定稿的文档禁止 AI 自动增补，仅按明确指定需求提供素材。
- **AI 只做客观事实核查，不做立场性工作**（学术诚信底线）：不主动找证据支持使用者论点、不主动找反例攻击对立观点、不主动优化论证。AI 该做的是新颖性检查、覆盖检查、术语核查、事实校对等 reviewer 视角的工作；论证、立场、判断是使用者自己的学术工作，禁止越俎代庖。

### 1.4 关键词与配置
- **关键词永远由用户在设置里维护**，代码不得内置硬编码词表；分发场景下每个使用者一份独立配置。
- **期刊模板永远由用户维护**（v0.2 新增，对齐 §1.4 关键词条款）：代码不得内置任何具体期刊模板；出厂只带 1 个通用样板作为"写法示例"，任何具体期刊（Nature、Adv. Mater. 等）由使用者自建或从 GitHub URL 导入。禁止在代码里出现期刊名与格式规则的硬编码映射。

### 1.5 链接校验
- 所有对外输出的 URL / DOI 必须通过 AI-2 fetch 验证：**HTTP 200 + 有实质内容 + 内容与 AI-1 宣称一致**。三条任一不满足即打回。

### 1.6 SDK/API 失败降级
- 任一外部 API（MinerU / CrossRef / OpenAlex / arXiv / AI 服务 / 词典 API）不可用时，业务必须显式提示卡点，不得静默失败或伪造数据。

### 1.7 UI 语言（v0.2 新增）
- **默认中文界面**。v1.0 不做 i18n 框架，界面文案直接用中文常量，注释里标 `// i18n: xxx` 备将来抽取。
- 面向对象：中文学术使用者。将来国际化再单独立项。

### 1.8 跨端功能对等硬需求（v0.2 新增）
- 见 §0"跨端策略"。**移动端与桌面端功能完全对等，不是阉割版**。任何模块（含 PDF→md、编辑器写作、Tectonic 编译、模板管理等）都必须能在手机上完整触发和完成。
- **唯一允许的差异**：UI 布局按物理方向切"横屏样板 / 竖屏样板"两套（组件内部一律相对单位，见 §2.4）、重计算任务在低端设备耗时更长。**功能层面禁止任何差异化**。
- 违反此原则的任何"移动端只做 X / 移动端仅可查看 / 移动端不支持 Y"的措辞或实现，都属于设计错误，必须回退到"功能对等 + 布局适配"的正确表述。

### 1.9 开源许可（v0.2 新增）
- 项目采用 **AGPL-3.0**（GNU Affero General Public License v3.0）。
- 语义：任何基于本项目改造后**对外提供网络服务**的实例（含 SaaS 化部署），必须开源修改后的完整代码。
- 目的：防止本项目被 fork 后包装成闭源商业服务，保护开源生态。
- 词表/CSL/期刊模板等**数据资源**的许可与软件本体许可**独立处理**（见 §11）。

### 1.10 对外交付格式硬约束（v0.2.2 新增，v0.2.3 补充图片嵌入）
- md 只是**内部落盘**格式（对齐 §1.2 数据铁律），**不作为对外交付产物**。
- 软件对外唯一交付形态：**编译好的 PDF + 格式正确的 Word（.docx）**。任何"把 md 甩给使用者、让他自己找工具转格式"的实现都是设计错误。
- 出口一律走 §5.8 编译链路：Tectonic（WASM）出 PDF、Pandoc（WASM 或等价方案）出 .docx，两者同时出、CSL 引用格式一致。
- 使用者在写作过程中随时可预览 PDF/Word 渲染效果，不必等到投稿阶段才编译。
- 产物落盘 `projects/{project-id}/exports/`。
- **图片资源必须实嵌，不留断链（v0.2.3 新增，对齐 Rosa 22:01「导出带图 PDF 发给别人」硬需求）**：
  - PDF / Word 里所有引用的图片都必须**物理嵌入**产物文件，不能只留相对路径或外链 URL。
  - **落盘 md 时图片处理策略**（沿用上一代 PaperAssistant 已实测方案）：本地选图 → FileReader → base64 → 直接以 `![alt](data:image/png;base64,...)` 内嵌进 md 源文件；同时拦截**粘贴/拖拽图片**走同一路径。图片跟着 md 一起走，无外部依赖，符合"本地隐私优先"与"离线可用"原则。
  - **图片体积保护**：单张 > 5MB 时前端提示"内嵌会显著增加 md 体积"，让使用者判断是否压缩后再插入；不阻断，只提示。
  - 编译到 PDF/Word 时，base64 图片按标准流程解码写入产物；即使使用者把 md 传到另一台设备，PDF/Word 依然完整。
  - **反面案例**：绝对不允许出现"PDF 里图片位置显示为红叉/404/图片路径打不开"的产物。发现该情况即视为编译链路 bug。

### 1.11 编辑器交互硬约束（v0.2.2 新增，v0.2.3 选型软化）
- **感受层硬约束（不变，v0.2.3 保留）**：
  - **内联就地编辑**：光标离开当前行/块时，md 语法自动渲染成最终样式；光标进入时显示源码可继续编辑。或至少做到**源码与渲染同框、无编辑/预览切换按钮**——不做"编辑/预览"分栏或分模式（这是老 Cat 的错误做法）。
  - **禁止弹窗打断工作流**（对齐 USER.md 长期偏好）：图片、公式、表格、链接、思维导图、链表、引用等元素一律**内联插入 + 就地编辑**，不弹独立编辑器窗口、不做模态框输入。若不得不弹辅助面板（如表格行列数选择器），必须是**页内 overlay + 点击外部即关**，不是操作系统级 modal dialog。
  - Rosa 22:01 原话：「内联就能改、改不要任何弹窗，并且可以导出带图的 PDF」。这是**感受硬约束**。
- **技术选型软化为候选池（v0.2.3 修正 v0.2.2 的过强判断）**：
  - **候选 A｜Vditor ^3.10.x（首选，上一代 PaperAssistant 已实测跑通）**：国产 markdown 编辑器（作者 88250，思源笔记同厂）；官方支持三模式：`wysiwyg`（所见即所得）/ `ir`（即时渲染，最接近 Obsidian Live Preview）/ `sv`（分屏，不采用）。上一代 PaperAssistant 用 `mode: "wysiwyg"` 实测跑通了 Rosa 全部感受要求（工具栏含 headings/bold/italic/list/quote/code/link/table/image/undo/redo/fullscreen/edit-mode，`insertValue` 支持 base64 图片内嵌，`preview.math.engine: "KaTeX"`）。**具体模式（wysiwyg vs ir）v0.3 敲定**。前端依赖极轻（PaperAssistant 前端 package.json 仅 `react + react-dom + vditor` 三个运行时依赖）。
  - **候选 B｜Milkdown / Crepe（ProseMirror 系）**：官方定位即 Obsidian 风 Live Preview，开箱支持所见即所得 + 内联块类型 + Markdown 双向序列化。生态更活跃、可扩展性强，但需要更多集成工作。
  - **候选 C｜CodeMirror 6 + Live Preview 装饰器**：Obsidian 严格同款技术栈，最接近 Obsidian 效果，但集成与装饰器工作量最大。
  - **候选 D｜TipTap（ProseMirror 系）**：v0.2.2 曾判"淘汰"，v0.2.3 撤回该结论并**有条件回归候选池**——若能配置为源码-渲染同框内联模式（而非 Notion 风块式），仍可参与对比；但需在原型阶段验证能否达到感受硬约束。
- **v0.3 原型对比敲定，本版本不锁死**：v0.3 交互原型阶段用同一份 md 素材（含标题、粗体、公式、表格、图片、代码块、引用）分别在四个候选上做**5 分钟内联编辑测试**，按感受硬约束打分（内联无弹窗 / 公式表格图片内联 / 段间切换流畅 / 打包体积 / 与 md 落盘的双向序列化保真度）择优。选定后回填本节。
- **不设"预判淘汰"（v0.2.3 教训条目，见 §8）**：Rosa 提及"Obsidian""WPS 智能文档""Writer-Cat"等对标产品都是**感受提示**，不是**技术硬约束**。上一代 PaperAssistant 用 Vditor `wysiwyg` 满足了 Rosa 的相同要求，就是最强反例——技术层不该被产品名绑架。

### 1.12 GitHub 认证与 Token 存储硬约束（v0.2.5 新增）

**背景**：本项目分发形态是"GitHub Pages 静态 SPA + 使用者各自 GitHub 私库"（见 §0.4 与 §2.3），前端无后端、无 `client_secret` 存放位置，任何要求"服务器换 code 拿 token"的传统 OAuth Web Flow 都不可行。以下硬约束是这条根约束的必然推论。

#### 1.12.1 认证 flow：双路径
- **主路径｜GitHub Device Flow**（无后端、无密钥）：
  - 前端调 `POST https://github.com/login/device/code`（仅需 `client_id`，公开常量），拿到 `device_code`、`user_code`、`verification_uri`、`interval`、`expires_in`。
  - UI 显示 8 位 `user_code` + 提供"复制并跳转授权"按钮，跳转 `verification_uri`（`https://github.com/login/device`）新标签。
  - 使用者在 GitHub 页面粘 `user_code` 完成授权后，前端按 `interval` 轮询 `POST https://github.com/login/oauth/access_token`，成功即拿到 `access_token`。
  - **权限范围**：Device Flow 仅支持 **classic scope**（`repo` 一档，覆盖使用者全部私有仓库的读写；不支持 fine-grained 单库授权）。这是 GitHub 平台限制，非本项目决策。
- **兜底路径｜Fine-grained Personal Access Token（PAT）手贴**：
  - UI 提供"手动输入 PAT"入口，同时提供**跳转到 GitHub PAT 创建页 + 一键填充模板参数**（仓库单选、权限模板 `Contents: Read and write` + `Metadata: Read-only` + `Workflows: Read and write`、过期时间建议 90 天/1 年）的引导。
  - 使用者创建完 PAT 手贴回 UI，前端校验 token 有效性（`GET /user`）后保存。
  - **权限范围**：可精确到**单个仓库**、按最小权限勾选；对权限敏感的使用者是首选路径。
  - **过期**：fine-grained PAT 强制过期（最长 1 年），到期需重建；UI 需在过期前 7 天开始横幅提醒。
- **两条路径地位**：Device Flow = 首选（onboarding 顺滑、无过期）；PAT = 平权兜底（权限最小化、有过期）。使用者在首次登录页自主选择，不由软件替他决定；两条路径**功能完全对等**，登录成功后进入的软件状态无区别。

#### 1.12.2 Token 存储：IndexedDB + 明文标注
- **存储位置**：**IndexedDB**（不是 localStorage、不是 cookie、不是 sessionStorage）。理由：
  - **结构化存储**：可与其他元数据（`login_at`/`expires_at`/`scope`/`github_username`/`github_user_id`）一起存，便于登出、失效判断、UI 显示；localStorage 只能存字符串，需手动 JSON.parse/stringify 又违反 §1.2 数据铁律的精神。
  - **异步 API**：不阻塞主线程；登录/登出/失效检测都可以 await，不卡 UI。
  - **容量大**：远超 localStorage 的 5MB 上限；即便未来存离线缓存也不撑爆。
  - **多标签共享 + 生命周期明确**：同源多标签自动共享登录态（符合"打开多个文献同时精读"场景）；`versionchange` / `close` 事件可捕获 DB 关闭时机，便于跨标签同步登录/登出。
- **加密状态**：**明文存储**（无 Web KMS、无用户口令二次加密）。这是 GitHub Pages 静态 SPA 环境下的**已知妥协**，不掩盖不美化。妥协的必然性：前端加密密钥无处安放；用主密码派生密钥又强迫使用者记额外口令，UX 反收益。
- **明文存储的补偿性缓解措施（必须全部执行，不选择性做）**：
  1. **CSP（Content Security Policy）**：`default-src 'self'; script-src 'self'`；**禁 inline script + eval**；外链 API 白名单（github.com、api.github.com、openalex.org、crossref.org、arxiv.org、mineru.net、各 AI 服务域名）显式列进 `connect-src`。
  2. **SRI（Subresource Integrity）**：所有 CDN 资源（若有）必须带 `integrity` 属性；推荐全部自托管走同源加载。
  3. **依赖锁死**：`package-lock.json` / `pnpm-lock.yaml` 提交仓库；CI 里跑 `npm audit` / `pnpm audit`，高危漏洞未修不允许发布 GitHub Pages。
  4. **发布通道单一**：只从 GitHub Actions build 后 push 到 `gh-pages` 分支，不允许开发机直接 push；build 产物哈希写进版本页供使用者比对。
  5. **登出时 Token 立即物理删除**：不只是清 UI 态，`indexedDB.deleteObjectStore` 或明确 `delete` 记录，不留缓存副本。
- **敏感度对齐**：GitHub token 敏感度**等于**使用者 GitHub 私库全部数据；对 XSS 的防护级别不得低于对 GitHub 密码的防护级别。

#### 1.12.3 登出 / 切号 / Token 失效硬约束
- **登出**：UI 显式入口（不仅是清缓存/清浏览器数据）。执行：删 IndexedDB token 记录 → 清所有内存态（React state、Zustand/Redux store）→ 跳回登录页。**不撤销 GitHub 侧 token**（Device Flow token 无 revocation endpoint；PAT 只能使用者自己去 GitHub 设置里撤）；UI 需提示"如需彻底撤销此设备的访问权限，请到 GitHub → Settings → Applications 手动 revoke"。
- **切号**：等价于"登出 + 重新登录"，不做多账号并存。理由：多账号本地态复杂度暴增（每个账号一份私库根、一套 IndexedDB namespace、一份关键词组/词汇本）、错切库风险大。**设计上明确不支持多账号同时登录**，切号必须先登出。
- **Token 失效检测**：
  - 每次 GitHub API 调用返回 `401 Unauthorized` 或 `403 Forbidden` 且 message 含"bad credentials"时，前端立即：① 冻结所有写操作 ② 弹全局 modal「登录已过期，需要重新授权」 ③ 提供"重新登录"按钮 → 回到 §5.0 登录页首屏。
  - **不允许静默失败**：不允许把 401 当普通网络错处理、不允许后台重试后跳过用户。这是 §1.6 SDK 失败降级铁律在认证场景的具体化。
- **PAT 过期提醒**：token 元数据里存 `expires_at`（PAT 创建时从 GitHub API 拿到，Device Flow token 无过期字段则不存）。UI 每次启动时检查：距过期 ≤7 天弹横幅"PAT 即将过期，建议重新创建并更新"；已过期则直接走上一条失效检测流。

**违反本节任一条即视为需求缺陷，必须回溯到 §5.0 UI 或 §7.1 流程修正，不得在实现中静默妥协。**

---

## 2. 架构总览

### 2.1 组件
| 层 | 技术 | 说明 |
|---|---|---|
| 前端 SPA | React + Vite（延续 Cat 栈，但代码完全重写） + **PWA + 横竖两套样板 + 相对单位布局（v0.2.1）** | 部署在 GitHub Pages 静态站；同一 URL 全端复用，按设备物理方向切换横/竖样板，见 §2.4 |
| **认证（v0.2.5 新增）** | **GitHub Device Flow（主）+ Fine-grained PAT 手贴（兜底）** | 前端零 `client_secret`；两条路径地位平权；Token 存 IndexedDB 明文 + CSP/SRI/依赖锁死缓解；见 §1.12 & §5.0 & §7.1 |
| 编辑器 | **候选池（v0.2.3）：Vditor ^3.10.x 首选（上一代 PaperAssistant 实测跑通）、Milkdown/Crepe、CodeMirror 6+装饰器、TipTap 有条件回归**；v0.3 用原型对比敲定 + Markdown 落盘 | 感受硬约束：内联能改、零弹窗、源码-渲染同框或至少无编辑/预览切换按钮；图片走 base64 内嵌 md（沿用 PaperAssistant 方案）；落盘一律 md，编辑器只是渲染器，见 §1.10 / §1.11 |
| 后端存储 | 使用者自己的 GitHub 私有仓库 | 通过 GitHub Git Data API 读写 |
| 后台调度 | 使用者私库内 GitHub Actions（每日追踪等） | 免费额度对私库 2000 min/月 |
| PDF → Markdown | MinerU API（使用者自配 key） | 单次 ≤200 页，超出自动拆合 |
| DOI 元数据 | CrossRef API | 无需 key |
| 文献追踪源 | CrossRef + OpenAlex + arXiv + 目标期刊 RSS | 多源并行、DOI 归一化去重 |
| 词典 | Free Dictionary + Wiktionary + Merriam-Webster/Oxford（可选）+ IUPAC Gold Book | 免费源打底，AI 兜底 |
| AI 服务 | 使用者自配 key，兼容 OpenAI 协议 | 支持 OpenAI / Anthropic / Gemini / DeepSeek / Kimi / 本地 |
| PDF 编译 | Tectonic（WASM 编译版本，浏览器内跑） | md → LaTeX → PDF；无需服务器 |
| Word 编译 | **Pandoc（WASM 版）或等价方案**（v0.2.2 新增） | md → .docx，浏览器内跑；引用/图表映射与 PDF 一致，见 §1.10 / §5.8 |
| 引用样式 | CSL（Citation Style Language） | 出厂预置一份**通用样板**，具体样式由用户自建/导入 |

### 2.2 数据流总览

```
                          ┌─────────────────────┐
                          │  GitHub Pages SPA   │  ← 使用者访问
                          │  (静态、无后端)      │
                          └──────────┬──────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │  首次登录 · 双路径二选一 (v0.2.5) │
                    ├─────────────────────────────────┤
                    │  A. Device Flow（主，onboarding 顺滑）:
                    │     ① POST /login/device/code (client_id) 
                    │     ② 前端显示 user_code + 跳转 verification_uri
                    │     ③ 用户在 GitHub 侧粘 user_code 授权
                    │     ④ 前端按 interval 轮询 /login/oauth/access_token
                    │     ⑤ 拿到 access_token → 存 IndexedDB
                    │
                    │  B. Fine-grained PAT（兜底，权限最小化）:
                    │     ① UI 引导跳到 GitHub PAT 创建页 (预填参数)
                    │     ② 用户创建后手贴 PAT 回 UI
                    │     ③ 前端调 GET /user 校验有效性
                    │     ④ 拿到 PAT → 存 IndexedDB (含 expires_at)
                    └────────────────┬────────────────┘
                                     │  Authorization: Bearer <token>
                                     ▼
                          ┌─────────────────────┐
                          │  使用者 GitHub 私库 │  ← 数据全部落这里
                          │  md + csv           │
                          └──────────┬──────────┘
                                     │
                       ┌─────────────┼─────────────┐
                       ▼             ▼             ▼
                 GitHub Actions   外部 API     浏览器本地缓存
                 (每日追踪等)    (CrossRef等)   (PWA离线可读)
```

**认证态生命周期**（v0.2.5 补）：
- token 存 IndexedDB `auth` object store，字段：`method` (device_flow / pat)、`access_token`、`scope`、`login_at`、`expires_at`（仅 PAT）、`github_username`、`github_user_id`。
- 每次 API 调用带 `Authorization: Bearer <access_token>`；返回 401/403 立即冻结写操作并跳登录（见 §1.12.3）。
- 登出：物理删除 IndexedDB `auth` 记录，不撤 GitHub 侧 token（提示用户去 GitHub 手动 revoke）。

### 2.3 全局硬性禁忌
- 禁止服务器端代码（无自建后端）。
- 禁止将使用者数据存到开发者控制的任何地方。
- 禁止 JSON 落盘（HTTP 在途除外）。
- **禁止把敏感凭据（GitHub token、AI API key、MinerU API key、词典可选 API key 等）存 localStorage、sessionStorage 或 cookie（v0.2.5 新增）**；必须走 IndexedDB（GitHub token 走 `auth` object store、其他 API key 走 `settings` object store）。理由：localStorage 只存字符串、5MB 上限、同步 API 阻塞主线程、`storage` 事件仅在**其他**标签修改时触发（当前标签不感知自己刚写的）；cookie 会被浏览器自动附加到未列入 CSP `connect-src` 白名单的同源子请求上、且明文凭据落 cookie 一旦命中 `document.cookie` 读取的 XSS 即全丢；sessionStorage 关标签即丢，不满足"打开多个文献同时精读"的多标签场景。IndexedDB 的结构化存储 + 异步 API + 明确 upgrade lifecycle + 与 Cache API/Service Worker 天然协同，才是本项目的正确选择。
- **禁止 inline `<script>` 与 `eval`（v0.2.5 新增）**；CSP 显式禁用。所有 JS 走同源文件加载 + SRI 校验。这是明文存 token 场景下的 XSS 最小护栏。
- **禁止使用需要 `client_secret` 的传统 OAuth Web Flow（v0.2.5 新增）**；前端无处安放 secret。认证只走 Device Flow 或 PAT 手贴（见 §1.12.1）。

### 2.4 前端布局策略（v0.2.1 新增）

**核心原则**：**只维护两套样板，全组件相对单位，按物理方向路由**。

#### 2.4.1 两套样板
| 样板 | 适用形态 | 说明 |
|---|---|---|
| **横屏样板（landscape）** | PC、笔记本、平板横屏 | 双栏或多栏排布，导航靠左/顶部，主内容 + 侧边栏并列 |
| **竖屏样板（portrait）** | 手机、平板竖屏 | 单栏堆叠排布，导航折叠为顶部或抽屉，模块纵向排列 |

- **不按设备类型判定**（不是"是不是手机就用竖屏"），而是按当前视口的物理方向（`window.innerWidth > window.innerHeight` ⇒ 横屏样板；反之竖屏样板）。
- **平板横屏 = 走横屏样板**，与 PC 同款体验；**平板竖屏 = 走竖屏样板**，与手机同款体验。
- 设备横竖屏切换（如平板转向、手机横转）时，样板自动切换，页面状态保留（滚动位置/输入内容/打开的模态框不重置）。

#### 2.4.2 相对单位铁律
- **所有组件的尺寸、间距、位置一律用相对单位**：
  - 宽高与位置：`%` / `vw` / `vh` / `fr`（Grid）/ `flex` 比例
  - 字号与间距：`rem`（相对根字号）/ `em`（相对父字号）
  - 断点：仅 1 个断点，即"横竖方向切换点"（媒体查询 `@media (orientation: landscape)` / `(orientation: portrait)`）
- **禁用绝对 px 定位**。允许的例外仅两处：
  1. 1px 边框（`border`）
  2. 图标固定尺寸（如 16px/24px 图标，但仍建议用 rem）
- **禁用按屏幕宽度分档的媒体查询**（`min-width: 768px` 之类），一切以 orientation 为准。

#### 2.4.3 组件设计约束
- 每个组件必须**同时兼容横竖两种样板**，通过内部 flex/grid 方向切换实现，而不是写两套组件。
- 组件不感知"是不是手机"，只感知"是不是竖屏"。业务逻辑层零设备判断。
- 文本、图片、图表、编辑器、工具栏、模态框全部支持等比缩放；不允许出现"手机上被截断/被遮挡/需要横滑"的情况。

#### 2.4.4 为什么这样设计
- 消除设备碎片化：不再区分手机/平板/桌面/大屏，只区分横/竖两种物理形态。
- 一份代码低维护成本：新出的折叠屏、超宽屏、竖屏显示器都自动落到对应样板，无需追加断点。
- 强制功能对等：物理层没有"这是手机所以不做 X"的接口，从架构上根治阉割冲动（对齐 §1.8）。

---

## 3. 使用者 GitHub 私库目录结构

**初始化时软件自动创建，使用者无感。**

```
{repo-name}/
├── literatures/
│   ├── literatures.csv              # 一级+二级共表
│   ├── {doi-normalized-slug}/       # 二级文献目录（有 md 才建）
│   │   ├── content.md               # PDF → md 正文（图片引 image/）
│   │   ├── image/                   # 抽出的所有图片
│   │   │   ├── fig-1.png
│   │   │   ├── graphical-abstract.png
│   │   │   └── ...
│   │   └── annotations/             # 该文献的批注 md
│   │       └── {annotation-id}.md
│   └── pdfs-recent/                 # 近 30 天 PDF（自动删）
│       └── {doi-slug}.pdf
├── vocabulary/
│   └── vocabulary.csv               # 词汇本
├── sentences/
│   └── sentences.csv                # 长难句本
├── translation_practice/
│   └── translation_practice.csv     # 翻译练习本
├── keyword_groups/
│   └── keyword_groups.csv           # 追踪用关键词组
├── textbooks/
│   ├── textbooks.csv                # 课本索引（含 scope: full / chapters）
│   └── {textbook-id}/
│       ├── content.md               # 整本模式：PDF → 完整 md
│       ├── chapters/                # 章节模式：按 heading 切片后每章一份 md
│       │   ├── ch1-introduction.md
│       │   ├── ch2-fundamentals.md
│       │   └── ...
│       └── image/
├── projects/
│   ├── projects.csv                 # 项目索引
│   └── {project-id}/
│       ├── config.md                # 项目配置（引入哪些课本+章节、目标期刊等）
│       ├── manuscript.md            # 原稿（唯一源）
│       ├── notes/                   # 项目级笔记
│       │   └── {note-id}.md
│       └── exports/                 # 导出产物（pdf/docx）
├── settings/
│   └── global.md                    # 全局设置
├── templates/                       # 期刊+引用样式（用户全自由维护，出厂零具体期刊）
│   ├── journals/
│   │   └── _sample-generic/         # 出厂唯一样板，供用户参照结构自建
│   │       ├── template.tex
│   │       ├── meta.md              # 期刊元信息（名称/ISSN/字号/字体/图片规格等）
│   │       └── cover-letter.md.tpl  # 投稿信模板
│   │   # 用户自建的期刊（nature/ / adv-mater/ / ees/ 等）由用户添加，代码不预置
│   └── citations/
│       └── _sample-generic.csl      # 出厂唯一样板；具体样式（ACS/APA/Vancouver 等）用户自建/导入
├── logs/
│   └── tracking/                    # 追踪日志（默认静默）
│       └── {yyyy-mm-dd}.md
└── .github/
    └── workflows/
        └── daily-tracking.yml       # 每日追踪
```

**命名规则**：DOI 归一化后 slug 规则 = 全小写 + `/` 替换为 `__`（例如 `10.1038/s41586-020-2649-2` → `10.1038__s41586-020-2649-2`）。

---

## 4. 数据模型（关键 CSV Schema）

以下所有 CSV 使用逗号分隔、UTF-8 编码、首行为表头。任何字段允许换行/逗号时用双引号包裹。

### 4.1 `literatures/literatures.csv`
| 字段 | 类型 | 说明 |
|---|---|---|
| doi | string | 归一化后 DOI |
| title | string | 标题 |
| journal | string | 期刊名 |
| year | int | 出版年 |
| authors | string | 作者列表，`; ` 分隔 |
| keywords | string | 关键词，`; ` 分隔 |
| abstract_en | string | 英文摘要 |
| abstract_cn | string | 中文摘要（可选，翻译时填） |
| tier | int | 1=一级（无 md），2=二级（有 md） |
| has_graphical_abstract | bool | 是否有题图 |
| added_at | datetime | 加入时间 ISO 8601 |
| pdf_added_at | datetime | PDF 加入时间（超 30 天删 PDF） |
| source | string | 来源：`tracking` / `paste` / `manual` |
| tracking_group | string | 从哪个关键词组追踪进来的（可选） |

### 4.2 `vocabulary/vocabulary.csv`
| 字段 | 说明 |
|---|---|
| word_en | 英文原词 |
| word_cn | 中文翻译 |
| definition_cn | 中文学术定义（联网+AI-2 审） |
| definition_en | 英文学术定义（联网+AI-2 审） |
| example_context | 原文例句（PDF→md 中抽取） |
| source_doi | 来源 DOI（归一化后） |
| status | new / learning / learned / mastered / error_book |
| added_at | 加入时间 |
| last_review | 上次复习时间 |
| review_count | 复习次数 |
| sm2_interval | SM-2 当前间隔（天） |
| sm2_ease | SM-2 easiness factor |

### 4.3 `sentences/sentences.csv`
| 字段 | 说明 |
|---|---|
| id | uuid |
| sentence_en | 英文长难句 |
| sentence_cn | 用户译文（最新一次） |
| ai_reference_cn | AI-1 参考译文（AI-2 审后） |
| source_doi | 来源 DOI |
| status | new / learning / mastered |
| added_at / last_review / review_count / sm2_* | 同上 |

### 4.4 `translation_practice/translation_practice.csv`
| 字段 | 说明 |
|---|---|
| id | uuid |
| original_text | 原文段落（通常是摘要） |
| source_doi | 来源 DOI |
| latest_user_translation | 用户最新提交译文 |
| latest_ai_feedback | AI-2 审阅后的反馈（结构化：偏义点/遗漏/错译） |
| latest_error_words | 抽出的错词列表（`; ` 分隔） |
| status | pending / completed |
| added_at / last_practice / practice_count | 时间与次数 |

### 4.5 `keyword_groups/keyword_groups.csv`
| 字段 | 说明 |
|---|---|
| group_id | uuid |
| group_name | 组名（用户自取，如 `钙钛矿主线`） |
| expression | 关键词表达式（支持 AND/OR/NOT，见 §5.2） |
| enabled | bool |
| translate_abstract | bool（本组推送是否翻译摘要，覆盖全局设置） |
| created_at | 时间 |

### 4.6 `textbooks/textbooks.csv`
| 字段 | 说明 |
|---|---|
| textbook_id | slug（用户自取或从标题生成） |
| title | 书名 |
| author | 作者 |
| edition | 版次 |
| pages | 总页数 |
| added_at | 时间 |
| **scope** | **`full` = 整本引入（内容进 `content.md`）；`chapters` = 章节引入（内容按 heading 切片进 `chapters/` 目录，每章一份 md）** |
| chapters | 章节结构（`; ` 分隔的 "编号:标题:文件名" 列表，AI 从 md 生成；scope=full 时可选，scope=chapters 时必填） |
| included_chapters | 章节模式下**实际引入项目**的章节 id 白名单（`; ` 分隔）；空表示引入所有章 |

**章节切片规则**：MinerU 输出的 md 天然带 heading，按 `#`（一级）切主章，`##` 切子章。默认粒度到一级 heading，用户可在导入界面手动调整（勾选哪几章、并选择合并/拆分）。

**引用语法**：
- 整本引用：`[[textbook:{textbook_id}]]`
- 章节引用：`[[textbook:{textbook_id}#{chapter_id}]]`（如 `[[textbook:pv-fundamentals#ch3]]`）

### 4.7 `projects/projects.csv`
| 字段 | 说明 |
|---|---|
| project_id | slug |
| title | 项目标题 |
| target_journal | 目标期刊 slug（对应 `templates/journals/` 里的目录，值全由用户维护，代码不校验白名单） |
| textbook_refs | 引入的课本+章节引用列表（`; ` 分隔的 `textbook_id` 或 `textbook_id#chapter_id`） |
| status | draft / submitted / archived |
| created_at / updated_at | 时间 |

### 4.8 `settings/global.md`
Markdown 结构化配置，示例：

```markdown
# 全局设置

## 语言
- language_mode: cn    # cn / en，决定推送摘要/词典是否翻译

## AI 服务
- ai1_provider: openai
- ai1_model: gpt-4o
- ai2_provider: anthropic
- ai2_model: claude-3-5-sonnet
- ai_endpoint_override: (空)

## PDF 处理
- mineru_api_key: 存在本地 IndexedDB `settings` object store（不进 md，v0.2.5 修正）
- pdf_retention_days: 30    # 硬编码 30，此项仅显示不许改

## 追踪
- daily_push_time: 08:00
- push_channels: inbox      # inbox / email，多选逗号分隔
- push_email: (空)

## 词典
- dict_sources: freedict, wiktionary
- dict_extra_key_mw: (可选)
- dict_extra_key_oxford: (可选)

## 编辑器
- editor_theme: light / dark
```

**注意**：所有 API key **不写进 md 文件**，只存在浏览器 **IndexedDB `settings` object store**（v0.2.5 修正，与 §1.12.2 GitHub token 存储位置统一，也是 §2.3 硬性禁忌"禁止 localStorage 存敏感凭据"的直接落地）；每次跨设备重新填。这是安全底线。

---

## 5. 模块规格

### 5.0 模块 · 认证与 Onboarding（v0.2.5 新增）

**目标**：把 §1.12 的认证硬约束落成具体的 UI 规格，覆盖首次登录、日常鉴权、登出、切号、Token 失效重登五种状态。

**入口**：
- 未登录使用者访问 GitHub Pages URL → 前端 hydration 完成后检测 IndexedDB `auth` 无有效记录 → 强制跳登录页首屏。
- 登录页首屏 URL 建议 `/#/auth`（hash 路由，兼容 GitHub Pages 静态部署）。

#### 5.0.1 登录页首屏（首次登录）

**布局**（横竖两版按 §2.4 规则渲染）：
- 顶部：软件 Logo + 一句话 pitch（如"学术工作全链路 · 你的数据在你自己的 GitHub 私库"）。
- 中部：**两个平权 tab**——`Device Flow（推荐）` / `Fine-grained PAT`。**默认停在 Device Flow tab**（顺滑度最好）；使用者可切到 PAT tab 走兜底路径。**tab 之间地位平权，不做视觉降级**（不把 PAT 写成"高级"或"不推荐"）。
- 底部：项目 GitHub 仓库链接 + AGPL-3.0 许可提示 + 版本号/构建哈希（供审计者比对）。

**Device Flow tab 内容**：
- Step 1（触发）：一个大按钮「获取授权码」→ 点击调 `POST https://github.com/login/device/code`（携带 `client_id`）。
- Step 2（展示）：拿到 `user_code` 后按钮变为 8 位大字号 `user_code` 展示 + 两个按钮「复制授权码」「跳转 GitHub 授权」。
  - `user_code` 展示格式：`XXXX-XXXX`（GitHub 官方形态）；字号 ≥ 2rem，等宽字体，方便使用者念/输。
  - 「跳转 GitHub 授权」按钮打开新标签到 `verification_uri`（`https://github.com/login/device`）。
  - 底部展示倒计时（`expires_in` 转换成 `mm:ss`）+ 一行小字"授权码过期后请重新获取"。
- Step 3（轮询）：Step 2 展示的同时，前端后台按 `interval` 秒调 `POST https://github.com/login/oauth/access_token` 轮询。
  - 拿到 `access_token` → 走 §5.0.4 通用后置流程。
  - 收到 `authorization_pending` → 继续轮询。
  - 收到 `slow_down` → 按官方指示放慢 interval。
  - 收到 `expired_token` / `access_denied` → 停轮询，回 Step 1 让使用者重来。
- Step 4（错误态）：网络故障或 GitHub API 5xx → 显式提示"无法连接 GitHub，请检查网络"+ 提供"重试"按钮，不自动无限重试。

**Fine-grained PAT tab 内容**：
- 一段说明："如果你希望权限精确到单个仓库或对全库授权敏感，可用 PAT 手贴登录。"（客观陈述，不引导偏向）
- 一个按钮「跳到 GitHub 创建 PAT」→ 打开预填模板参数的 GitHub PAT 创建页 URL：
  - `https://github.com/settings/personal-access-tokens/new?name=AcademicFlow&description=...&expiration=90d&target_name=...&target_id=...`（尽量把参数预填到 GitHub 支持的查询参数上；GitHub 侧未支持的字段以文案指引使用者手动勾）。
  - 权限模板文案：`Repository access: Only select repositories → 选一个（推荐叫 academic-workflow-data）`；`Repository permissions: Contents (Read and write) + Metadata (Read-only) + Workflows (Read and write)`。
- 一个粘贴框「粘贴 PAT」+ 按钮「登录」→ 前端调 `GET https://api.github.com/user` 校验：
  - 200 → 拿到 `github_username` / `github_user_id` → 走 §5.0.4 通用后置流程。
  - 401/403 → 显式提示"PAT 无效或权限不足，请检查"，指出可能原因（复制不完整、权限勾错、已被撤销）。
- 从 GitHub API 响应头读取 PAT 过期时间（GitHub Fine-grained PAT 校验 `/user` 时会在响应头返回过期时间；具体响应头名以 GitHub 官方文档为准，v0.3 落接口定义时锁死），一并存进 IndexedDB `expires_at` 字段。

#### 5.0.2 登录后主界面右上角认证卡片

主界面右上角常驻**认证状态卡片**（横屏样板放右上角固定；竖屏样板收进抽屉/侧栏顶部）：
- 头像（`https://avatars.githubusercontent.com/u/{github_user_id}`）+ `@{github_username}`。
- 认证方式徽标：`Device Flow` / `PAT`（PAT 显示"距过期 X 天"，≤7 天红色，已过期变灰并提示重登）。
- 点击展开菜单：
  - 「查看/管理 GitHub 授权」→ 外链跳 `https://github.com/settings/applications`（Device Flow） / `https://github.com/settings/tokens`（PAT）。
  - 「重新登录」→ 走 §5.0.3 切号流。
  - 「登出」→ 走 §5.0.3 登出流。

#### 5.0.3 登出 / 切号

**登出流**：
- 点击「登出」→ 弹二次确认（避免误点）："登出后本设备的登录态将被清除。如需彻底撤销此设备对 GitHub 的访问权限，请到 GitHub → Settings → Applications 手动 revoke。"
- 确认后：物理删除 IndexedDB `auth` 记录 → 清所有内存态（Zustand / Redux store reset）→ 跳回登录页首屏。
- **不主动打开 GitHub revoke 页**，只在提示里给链接。理由：不打扰使用者、让他自己决定。

**切号流**：等价于「登出 + 重新登录」，不做多账号并存（见 §1.12.3）。UI 上「重新登录」按钮直接调登出流后跳登录页首屏。

#### 5.0.4 通用后置流程（拿到 token 之后）

无论 Device Flow 还是 PAT，拿到 token 后统一走：
1. 调 `GET https://api.github.com/user` 拿使用者信息（username / user_id / avatar_url）。
2. 写 IndexedDB `auth` object store（字段见 §2.2）。
3. 探测私库是否已存在：`GET /repos/{username}/{default_repo_name}`（默认 `academic-workflow-data`，可在 onboarding 界面自定义）。
   - 200 → 走"老用户续用"分支：加载现有目录结构 → 进主界面。
   - 404 → 走"新用户首次初始化"分支：弹 §7.1 引导（创建私库 + 写目录骨架 + 填 API keys + 建第一个关键词组）。
4. 进主界面。

#### 5.0.5 Token 失效重登

见 §1.12.3。UI 表现：
- 触发点：任何 GitHub API 调用返回 `401` 或 `403 + bad credentials`。
- 弹全局 modal（覆盖当前界面，遮罩层），文案：`"登录已过期或权限被撤销。为了保护你的数据，所有写操作已冻结。请重新登录后继续。"`
- Modal 按钮：`[重新登录]`（走登出流 + 跳登录页首屏） / `[稍后]`（关 modal，但所有写操作仍冻结，读操作保持——使用者可继续看已加载的 md）。
- Modal 关闭后，界面顶部横幅持续显示"登录已过期"直到重登。

#### 5.0.6 错误态 / 边缘情况文案库

- **Device Flow 授权码过期**：`"授权码已过期，请点击「获取授权码」重新开始。"`
- **Device Flow 使用者拒绝**：`"你在 GitHub 侧拒绝了授权。如果这是误操作，请重新获取授权码。"`
- **PAT 校验失败**：`"PAT 无效。常见原因：① 复制不完整（应以 `github_pat_` 开头）；② 权限勾选不满足（需 Contents 读写 + Metadata 读）；③ PAT 已过期或被撤销。"`
- **网络故障**：`"无法连接 GitHub（api.github.com）。请检查网络或稍后重试。"`
- **rate limit**：`"GitHub API 调用频率超限，请等待 X 分钟后重试。"`（从 `X-RateLimit-Reset` 响应头计算）

#### 5.0.7 与 §1.8 跨端功能对等的关系

本模块所有交互（登录、登出、切号、失效重登）在**横屏样板与竖屏样板**上功能完全对等，UI 布局按 §2.4 相对单位适配。手机端可完整跑 Device Flow 全流程（`user_code` 复制粘贴到 GitHub 手机版页面），不做任何阉割。

---



### 5.1 模块 · 文献追踪

**目标**：每天自动从多源拉当日新发表且命中用户关键词的文献，推送到收件箱/邮件。

**数据源**（并行拉，DOI 归一化去重）：
- CrossRef（不支持 AND/OR/NOT，服务端宽召回，本地补逻辑）
- OpenAlex（原生支持 `filter` 组合、`|` 表 OR、`!` 表 NOT）
- arXiv（原生支持 `AND / OR / ANDNOT`）
- 目标期刊 RSS（用户在关键词组设置里可勾选期刊白名单）

**关键词表达式引擎**：
- 用户在设置界面写形如 `(perovskite OR "wide bandgap") AND (tandem OR stability) NOT dye` 的表达式。
- 前端解析为中间 AST。
- 每个数据源 adapter 决定"下推多少到服务端 + 剩多少留本地"。
- 本地筛选走标题 + 摘要 + 作者关键词的正则/词形匹配（英文用 lemmatization，中文用 jieba 或类似）。

**调度**：
- 每日 08:00（可改）由 GitHub Actions 触发 `daily-tracking.yml`
- Actions 里跑一段 JS/Python 脚本（打包在软件里，初始化时写入使用者仓库）
- 结果 push 回私库：`logs/tracking/{yyyy-mm-dd}.md`（含每条 DOI 卡片）+ 更新 `literatures.csv`（新条目 tier=1）
- 推送渠道：
  - **inbox**：软件打开时读取当天 log 展示
  - **email**（可选）：Actions 里调 SMTP 直发到 `push_email`

**推送卡片内容**：
标题 / 期刊 / 作者关键词 / **DOI 链接**（渲染为可点击 `https://doi.org/...`，点击跳原文；旁边有"入库到 tier=1"按钮） / 摘要（按全局或本组 translate_abstract 决定翻译）

**追踪日志（默认静默）**：
- `logs/tracking/{yyyy-mm-dd}.md` 末尾隐藏区块，记录每条"命中/未命中的原因"、每个数据源返回条数、去重前后数量。
- 软件设置面板里有"调试模式"开关，开启后当日汇总末尾附一个折叠区显示统计；默认关闭。

**Cat 遗留 bug（本项目已修）**：
- Cat 关键词硬编码 → 本项目**用户可配置的关键词组**。
- Cat 只有 CrossRef 单源 → **CrossRef + OpenAlex + arXiv + RSS 多源并行**。
- Cat 产物 JSON → **md + csv**。

### 5.2 模块 · 文献管理

**界面（表格视图）字段**（极简）：
`题图缩略图 | 标题 | 期刊 | 关键词 | DOI 链接`

**行首图标**：
- 一级：📄（灰）
- 二级：📖（绿，表示有 md 可精读）

**DOI 链接列渲染与交互**（v0.2.4 明确）：
- **渲染形态**：单元格默认输出可点击的完整链接 `https://doi.org/{归一化 doi}`，链接文案可省略协议前缀以缩短显示（如 `doi.org/10.1038/s41586-020-2649-2`），但 `href` 必须是完整 URL。禁止只显示裸 `10.xxx/xxx`。
- **左键点击**：新标签打开原文（浏览器 target=_blank + rel=noopener）。
- **右键 / 复制按钮**：**默认复制** `[[10.xxxxx/xxxx]]`（写作粘贴即引用，走内部 DOI slug）；右键菜单额外提供"复制 DOI 链接"（复制完整 `https://doi.org/...`，便于粘到邮件/聊天/文档里给别人）。

**排序/筛选**：
- 默认按 `added_at` 倒序。
- 全字段模糊搜索。
- 侧栏筛选：期刊、来源关键词组、tier、是否有题图。

**入库方式**：
1. 追踪自动进 tier=1
2. 粘贴 DOI（在软件任意位置的"快速入库"框） → CrossRef 查元信息 → 进 tier=1
3. 上传 PDF → 走 PDF→md 流水线（§5.3）→ 进 tier=2

**元信息 100% 自动查**（CrossRef），禁止手动填。

### 5.3 模块 · PDF → Markdown 流水线

**上游触发**：
- 使用者上传 PDF（文献或课本）

**流水线步骤**：
1. 拿到 PDF → 上传到 MinerU API
2. 判断页数：≤200 → 单次处理；>200 → 按 200 页拆分为 N 段，分别处理
3. 每段 MinerU 返回 zip → 前端解压
4. 只取 `.md` 和 `image/` 目录里的图片；**丢弃所有 JSON**
5. N 段拼接（按段内页码顺序、图片路径重映射避免冲突）→ 单一 `content.md` + 统一 `image/`
6. 提取题图（Graphical Abstract）：
   - **规则层**：在 md 中扫描 "graphical abstract" / "TOC" / 位于摘要正后方的第一张大图
   - **AI 兜底**：规则失败时，AI-1 从 md 全文判断哪张图是题图，AI-2 审
   - 命中的图 rename 为 `image/graphical-abstract.{ext}`
7. **抽取生词入词汇本**（见 §5.6）
8. 落盘到 `literatures/{doi-slug}/`

**日常存储**：`content.md` 里图片走相对路径 `![](image/xxx.png)`。

**分享导出**：使用者点"生成便携版" → 前端读 md + 图片 → 转 base64 内嵌 → 输出单文件 md。

**图片零丢失校验**（AI-2 兜底）：
- 拆合前后图片数量一致
- md 中所有 `![](...)` 引用都能在 `image/` 里找到
- 校验不通过 → 报错、拒绝落盘、告知使用者

**PDF 保留**：
- 落盘到 `literatures/pdfs-recent/{doi-slug}.pdf`
- 每日 Actions 顺带跑 GC：`pdf_added_at` > 30 天的 PDF 自动 `git rm`
- 保留天数硬编码 30，UI 上仅显示不允许修改

### 5.4 模块 · 阅读 + 批注

**阅读**：直接展示 `content.md`（Milkdown 只读模式渲染，交互见 §1.11），左侧目录、右侧批注侧栏。

**批注核心**：
- 批注 = **独立 md 文件**，路径 `literatures/{doi-slug}/annotations/{annotation-id}.md`
- 批注文件头部 YAML frontmatter 记录锚点：
  ```yaml
  ---
  anchor:
    doi: 10.1038/s41586-020-2649-2
    method: text-quote        # text-quote / paragraph-index / heading
    quote: "The perovskite layer was..."
    prefix: "...before text..."
    suffix: "...after text..."
  created_at: 2026-07-10T16:20:00+08:00
  ---
  ```
- **文献本体 md 永远不变**，可迁移性完整保留。
- 批注正文用主编辑器（同 §5.7，感受硬约束「内联能改、零弹窗、源码-渲染同框或至少无切换按钮」；技术候选池见 §1.11 & §8.3），支持全部元素/块（文本 / 图片 / 公式 / md 表格 / 思维导图 / 链表可视化 / 引用块），交互见 §1.11。
- 批注中的图片默认落到 `annotations/image/`（与文献本身的 `image/` 分开）。

**渲染时**：阅读界面加载后，前端扫 `annotations/*.md`，按 anchor 定位到正文对应位置，右侧展示批注气泡。

### 5.5 模块 · 笔记

**两层绑定**：
| 层 | 存储位置 | 场景 |
|---|---|---|
| 文献级 | `literatures/{doi-slug}/annotations/`（即批注） | 读单篇文献时写 |
| 项目级 | `projects/{project-id}/notes/{note-id}.md` | 项目思考、TODO、跨文献综合 |

**跨层引用**：
- 项目笔记里可写 `[[10.xxxx/xxxx]]` 引用某文献。
- 项目笔记里可写 `![[10.xxxx/xxxx#annotation-id]]` 内嵌某条批注内容。
- 这些语法在编辑器渲染时展开，在正式导出时按引用规则处理。

**AI 边界**：
- AI 不主动动笔记。
- 用户点"AI 帮我总结/找矛盾/扩写" → 走 AI-1+AI-2 → 输出放 **AI 输出块**（笔记 md 里的 `:::ai-output` 折叠块），用户接受才合并到普通段落。

### 5.6 模块 · 学习（翻卡 + 长难句 + 翻译练习）

三个 tab，逻辑参考 Cat 的 `Learn.jsx` 但修掉所有已知坑。

#### 5.6.1 单词翻卡（words tab）
- 数据源：`vocabulary.csv`
- 题型 6 种（沿用 Cat）：`en_select_cn / cn_select_en / en_select_def / def_select_en / sent_select_cn / sent_select_def`
- 用户可勾选启用哪几种；默认 `en_select_cn`
- 队列长度、掌握判定阈值等设置沿用
- SM-2 到期复习
- 每张卡展示：word_en + 🔊音 + word_cn + definition_cn + definition_en + example_context + **来源 DOI 链接**（渲染为可点击 `https://doi.org/...`，点击回原文）
- 答错自动进 error_book（status 改）

#### 5.6.2 长难句（sentences tab）
- 数据源：`sentences.csv`
- 展示英文长句，用户打字翻译
- 提交 → AI-1 出参考译文 + AI-2 审（术语/语法准确性）
- **AI 不可用时明确显示"AI 服务不可用，本次不评分"**（Cat 用 random 伪造这条必修）

#### 5.6.3 翻译练习（translations tab，即摘要翻译）
- 数据源：`translation_practice.csv`
- 展示英文段落（通常来自 tier=2 文献的摘要），用户打字翻译
- 提交 → AI-1 打分 + 抽错词 → AI-2 审（AI-1 抽的错词是否真的错、参考译文是否准确）
- AI-2 通过后：错的**词/短语**自动进 `vocabulary.csv`，`source_doi` 指向来源摘要，`example_context` 是包含该词的英文原句
- **不打百分制硬分**，反馈结构化：`偏义点 / 遗漏 / 错译位置`
- **AI 不可用 = 不评分**（同上）

#### 5.6.4 生词提取器（PDF→md 之后自动跑）
**三层判定链**（自动、无配置）：
1. 通用高频词表命中（AWL 之外的 BNC/COCA top 5000 之类） → 视为日常词，**不进候选**
2. 学术词汇表（AWL 570 词族）或化学/材料专业词表命中 → 进候选
3. 都不命中 → AI-1 判"是否学科相关"（**不判"值不值得学"**） → AI-2 审 → 通过才进

**词表全部内置于软件，随分发发布**。

**联网查定义**（进 vocabulary.csv 前的填充）：
- 免费源：Free Dictionary API + Wiktionary（无 key）
- 可选源：Merriam-Webster Learner's / Oxford Learner's（有 key 更好）
- 化学/材料专业词：IUPAC Gold Book + 从**当前文献上下文**让 AI-1 抽学术义
- 三源并查 → AI-2 去重去矛盾 → 填 definition_cn / definition_en

### 5.7 模块 · 学术写作 + AI 交互

**编辑器**：感受硬约束「内联能改、零弹窗、源码-渲染同框或至少无编辑/预览切换按钮」；技术候选池 Vditor（PaperAssistant 实测跑通，首选）/ Milkdown-Crepe / CodeMirror 6+装饰器 / TipTap（有条件回归），v0.3 原型对比敲定，见 §1.11 & §2.1 & §8.3。落盘 md。

**交互规范**（详见 §1.11 硬约束）：
- 源码-渲染同框内联，光标离开当前行/块 → md 语法自动渲染；光标进入 → 显示源码可继续编辑。
- **无"编辑/预览"分栏或切换**——这是老 Cat 的反面案例（见 §8）。
- **禁止弹窗**：图片、公式、md 表格、思维导图、链表、引用块、内联链接一律**内联插入 + 就地编辑**。

**支持的元素/块**（全部内联渲染 + 就地编辑）：
- md 原生：标题（`#`）/ 粗斜体 / 列表 / 引用块（`>`）/ 内联链接 / 图片（`![]()`）/ 公式（`$$...$$`）/ md 表格 / 代码块
- 学术专用：`[[10.xxxx/xxxx]]` 文献引用（Obsidian wiki-link 风格，渲染为角标或作者-年）、`[[textbook:id]]` / `[[textbook:id#ch3]]` 课本引用
- 可视化 fenced code：思维导图（`\`\`\`mindmap`）/ 链表可视化（`\`\`\`linked-list`），代码块编辑 + 内联预览

**"插入文献"按钮**：
- 编辑器工具栏一个按钮，点击后**就地展开内联选择器**（非模态浮层，点空处自动收起，不打断当前光标位置）：
  - 上部：**从文献库选**（表格视图，仿 §5.2 极简字段）
  - 下部：**粘贴 DOI 现查**（走"粘贴入库"链路，进 tier=1，同时插入引用）
- 选中/查完 → 在光标位置插 `[[10.xxxx/xxxx]]`

**AI 可触发动作（全部用户主动点，AI 不主动跑）**：
| 动作 | AI-1 职责 | AI-2 职责 |
|---|---|---|
| 起草段落 | 按意图/大纲起草 | 检查引用真实性、术语准确性、有无编造 |
| **新颖性检查** | 查用户写的核心观点/结论前人是否已发表过（项目文献池+课本池+联网搜索），返回疑似重叠的文献清单 | 审 AI-1 找到的匹配是否**语义等价**（不是表面相似），fetch 每篇文献验证内容对应 |
| 反向覆盖检查 | 标出**缺引用**（观点没引）/**疑似照抄**（像原文没标引）的段落 | 复核标出是否合理 |
| 术语一致性 | 提出全文术语统一建议 | 审是否损失语义 |
| 风格改写 | 按目标期刊风格改写 | 审是否偏离原意 |
| 中↔英翻译 | 生成译文 | 审偏义/遗漏/错译 |

**关于"新颖性检查"的边界（重要）**：
- 这是 reviewer 视角，不是 advocate 视角。AI 只查"你说的这件事，之前有没有人说过"，不查"支持你观点的证据"。
- 找到疑似重叠时**标红警告**：`"疑似与 <https://doi.org/xxx>（可点跳原文）观点重叠，建议重新论述、明确增量、或改为引用而非原创"`——DOI 按 §1.2 展示层规则渲染为可点链接，交给使用者判断。
- 找证据支持自己论点、找反例支持对立观点，都是**使用者自己该做的学术工作**，AI 不代劳。这是学术诚信底线。
- 反向覆盖检查（下一条）与新颖性检查不同：反向覆盖是"你已经在引用，但引得不足"；新颖性是"你以为是原创，但前人写过"。两个方向。

**AI 产出物理隔离**：所有 AI 输出进入编辑器侧栏 / `:::ai-output` 折叠块。用户点"接受"才合入正文。AI 永远不动使用者原稿字符。

**知识范围**：写作时 AI 的上下文 = 全局文献池 + 当前项目 `config.md` 里勾选的课本子集。

**课本引用**：
- 项目配置里勾选引入哪几本课本。
- AI 生成时必须明确"根据《XXX教材》第 X 章第 Y 节"。
- AI-2 去课本 md 里核对：找不到就打回，不许含糊说"根据教材"。
- 课本引用**不进 `[[DOI]]` 参考文献表**（无 DOI），走独立"教材引用"区，最终按目标期刊模板要求排版。

### 5.8 模块 · 投稿（一份原稿 × N 期刊）

**原稿唯一源**：`projects/{project-id}/manuscript.md`

**引用标识**：正文里所有引用都写 `[[10.xxxx/xxxx]]`（英文双方括号，Obsidian wiki-link 风格）。

**参考文献表**：**扫全文按首次出现顺序自动生成**，用户不管编号。重复引用编号规则由目标期刊决定。

**期刊模板**：
- 位置：`templates/journals/{journal-slug}/`
  - `template.tex` — LaTeX 模板骨架
  - `meta.md` — 期刊元信息（引用样式 CSL id、正文字段限制、参考文献格式变体、AI 生成记录）
  - `cover-letter.md.tpl` — 投稿信模板（可选）
- **出厂零具体期刊**（v0.2 定稿，对齐 §1.4 期刊模板条款）：只带一个 `_sample-generic/` 目录作为**结构样板**，教用户怎么写 `template.tex` 和 `meta.md`。任何具体期刊（Nature/Science/JACS/Adv. Mater./EES/Joule/... 等）由**使用者自建或从他人 GitHub URL 导入**。代码里不出现任何期刊名硬编码。
- **用户添加期刊的方式**：
  1. **手动创建**：在模板管理界面新建目录，粘贴自己找到的官方 LaTeX 模板 + 填 meta 表单
  2. **AI 辅助生成**：上传"期刊投稿须知 + 官方 LaTeX 模板"→ AI-1 生成 `template.tex` + `meta.md` → AI-2 审查（fetch 投稿须知链接、比对格式细则）→ 通过才落盘
  3. **URL 导入**：从任意 GitHub 仓库 URL 拉他人共享的期刊模板目录，前端 fetch 拉下来审阅后并入本地 `templates/journals/`
- 使用者之间可通过 GitHub 分享模板（fork/PR），逐步形成社区维护的期刊模板集合，但**不属于本项目分发内容**。

**引用样式**：独立 CSL 库，位置 `templates/citations/`。期刊模板的 `meta.md` 里指定 `citation_style: {csl-filename}` 之类。**引用样式和期刊模板解耦**，同一 CSL 可被多个期刊复用。CSL 同样出厂零预置（除通用样板），用户自建/从 [citation-style-language/styles](https://github.com/citation-style-language/styles) 这类公开仓库导入。

**编译流程**：
1. 用户在项目里选目标期刊
2. 前端读 `manuscript.md` + 对应 `template.tex` + 对应 CSL
3. md → LaTeX 转换（图/公式/表格/引用做映射）
4. `[[DOI]]` 按首次出现顺序编号，参考文献表按 CSL 生成
5. Tectonic（WASM 版）在浏览器内编译 → **PDF**
6. 同时另出一份 **Word**：md → Pandoc（WASM 化或等价方案）→ .docx（引用同样按 CSL 生成，保持与 PDF 一致）
7. 落盘到 `projects/{project-id}/exports/{journal-slug}-{yyyy-mm-dd-HHMM}.{pdf,docx}`

**编译链路参考（v0.2.3 补充，来自上一代 PaperAssistant 实装经验）**：
- 桌面端如需本地 LaTeX 引擎降级，可参考 PaperAssistant 后端 `typesetting.py` 的引擎链：`auto` 模式按 **xelatex → pdflatex → lualatex → tectonic** 顺序探测本机可用引擎；检测到 `latexmk` 时用多遍编译（自动处理引用回填、bibtex/biber 调度）；`tectonic` 内部自处理多遍，不走 latexmk。**xelatex 化学论文中英混排首选**。本项目走浏览器端 Tectonic WASM 是首选路径，但如未来加桌面 sidecar，直接沿用该策略。
- 编译失败时必须解析 `.log` 拿**结构化错误（含行号）**并回显给用户，不能只丢 stderr 尾部让用户猜。这条来自 PaperAssistant 已跑通的 `_parse_latex_log` 实现。

**导出目标**：**PDF + Word 两种同时出，是软件对外唯一的交付形态**（见 §1.10 硬约束）。md 只是内部落盘格式，不作为对外产物，禁止让使用者拿 md 自己找工具转格式。

**入口位置约束（v0.2.3 新增，对齐 Rosa 22:01「平时我不这样做」的低频定位）**：
- PDF/Word 编译是**低频功能**，不占编辑器工具栏主显眼位置。
- **推荐布局**（沿用 PaperAssistant 已跑通的思路）：编辑器与"投稿/预览编译"是**主工作区可切换的两个并列面板**，编辑器面板内**不放**编译按钮；使用者主动切换到"投稿/预览编译"面板才看到引擎选择、期刊选择、编译触发等控件。
- 允许在编辑器工具栏右侧放一个**极简"预览产物"入口图标**，点击后弹出侧栏或跳到编译面板，但不能占据工具栏中间/主位。
- **禁止**在保存/写作路径上强制触发编译（如"每次保存自动出 PDF"）——那会严重拖慢日常写作。

**随时预览**：写作过程中随时可切到编译面板点"预览 PDF"或"预览 Word"，跑一次同流程出中间产物，用于实时确认排版效果，无需等到投稿阶段。

---

## 6. AI 双引擎组件规格（通用横切）

**接入位置**：追踪摘要翻译、生词学术义、单词学习参考、长难句参考译文、翻译练习评分、写作起草/新颖性检查/覆盖检查/术语/风格/翻译、题图识别兜底、期刊模板 AI 辅助生成 —— 全部经此组件。

### 6.1 接口
```
input:  { task_type, user_input, context, ai1_output? }
output: { ai1_result, ai2_verdict, ai2_notes, final_result | rejected_reason }
```

### 6.2 AI-2 通用职责
1. 对齐原文 vs AI-1 输出（信息差异/新增/矛盾）
2. **每条链接三重检查**：HTTP 200 + 有实质内容 + 内容与 AI-1 宣称一致
3. 事实类断言必须有可核查来源；无来源打回
4. 只做客观判定（学科相关/正确/偏义/矛盾），不做主观判定（"值不值得学"这类禁止）

### 6.3 失败降级
- AI-1 不可用 → 明示"AI 服务不可用，本次不生成"
- AI-2 不可用 → 明示"AI-2 审查服务不可用，本次不呈现 AI 结果"（**不许绕过 AI-2 直接把 AI-1 结果给用户**）
- 用户可在设置里明确开启"允许仅 AI-1 呈现（不推荐）"，默认关

### 6.4 模型配置
使用者在 `settings/global.md` 中分别指定 AI-1、AI-2 使用的服务商与模型。推荐两个用不同家的模型（比如 AI-1 用 GPT-4o，AI-2 用 Claude 3.5 Sonnet），异构降低共谋概率。

---

## 7. 分发与首次初始化流程

1. 使用者访问 GitHub Pages URL
2. **前端 hydration 后检测 IndexedDB `auth` 无有效记录 → 跳登录页首屏（§5.0.1）→ 二选一走 Device Flow 或 Fine-grained PAT（v0.2.5 具象化）**：
   - **Device Flow 路径**：点击「获取授权码」→ 前端调 `POST /login/device/code` → 页面显示 `XXXX-XXXX` 格式 `user_code` + 跳转 `https://github.com/login/device` → 使用者授权后前端轮询 `/login/oauth/access_token` 拿到 `access_token`（scope=`repo`）。
   - **Fine-grained PAT 路径**：点击「跳到 GitHub 创建 PAT」→ GitHub 侧选目标仓库 + 勾权限（Contents R/W + Metadata R + Workflows R/W）→ 手贴 PAT 回 UI → 前端调 `GET /user` 校验。
   - 两条路径均在拿到 token 后走 §5.0.4 通用后置流程：调 `/user` 拿 username/user_id、写 IndexedDB `auth`、探测私库是否存在。
3. 软件检测使用者是否已有 `academic-workflow-data`（或使用者自定义名）私库
   - 有：加载现有目录结构
   - 无：引导创建，软件写入完整目录骨架 + `.github/workflows/daily-tracking.yml`
4. 软件同步 `templates/` 骨架到使用者私库（仅含 `_sample-generic/` 通用样板 + 一份通用 CSL 样板；**零具体期刊、零具体样式**，由用户后续自建/导入）
5. 引导使用者填 MinerU key、AI-1/AI-2 服务与 key、词典可选 key、追踪推送邮箱（可选）
6. 引导创建第一个关键词组（不预置任何词，用户第一次说的就是硬约束）
7. 进入主界面

**跨设备**（v0.2.5 修正）：登录同一 GitHub 账号即可无缝续用；**GitHub token 存 IndexedDB，跨设备需重新登录**（IndexedDB 不跨设备同步；这是安全设计，不做云同步）。**AI/MinerU/词典 API key 存 IndexedDB `settings` object store**（v0.2.5 修正 v0.2.4 之前的 localStorage 说法，与 §1.12.2 存储位置统一），跨设备需重新填。PWA 可"添加到主屏幕"作为独立应用图标启动。

### 7.1.1 私库创建的最小 API 调用序列（v0.2.5 新增）

拿到 token 且检测到私库不存在后，按序调用：
1. `POST /user/repos`（创建 `academic-workflow-data` 私有仓库，`private: true`、`auto_init: true`）
2. `GET /repos/{owner}/{repo}/git/refs/heads/main`（拿到默认分支 HEAD sha）
3. 通过 **Git Data API** 批量写入目录骨架（blob → tree → commit → update ref），一次 commit 完成所有种子文件：
   - `README.md`（软件版本、私库结构说明、许可）
   - `literatures/literatures.csv`（表头 only）
   - `vocabulary/vocabulary.csv`（表头 only）
   - `sentences/sentences.csv`（表头 only）
   - `translation_practice/translation_practice.csv`（表头 only）
   - `keyword_groups/keyword_groups.csv`（表头 only）
   - `textbooks/textbooks.csv`（表头 only）
   - `projects/projects.csv`（表头 only）
   - `settings/global.md`（默认配置）
   - `templates/journals/_sample-generic/`（结构样板）
   - `templates/citations/_sample-generic.csl`
   - `.github/workflows/daily-tracking.yml`（追踪脚本）
4. 若步骤 1 因仓库已存在（`422 name already exists`）失败 → 回退到"老用户续用"分支，不覆盖使用者已有内容。
5. **所有步骤失败必须显式回滚 UI 态 + 明示错误码 + 提示重试**（对齐 §1.6 SDK 失败降级铁律），不允许把使用者卡在半初始化状态。

---

## 8. Cat / PaperAssistant 继承与切断

### 8.1 继承（沿用思路，代码重写）
- Cat SmartEditor 的元素/块类型思路（文本/图片/公式/表格/思维导图/链表/引用块），**渲染层选型 v0.3 用原型对比敲定**（Vditor / Milkdown/Crepe / CodeMirror 6 装饰器 / TipTap 四候选，见 §1.11）
- Cat Learn 的三 tab 结构 + 6 题型 + SM-2 复习
- Cat 单词字段基础结构
- PaperAssistant 五阶段（选题 / 文献综述 / 正文 / 引用 / 排版）
- PaperAssistant 铁律（md+csv、AI 边界、SDK 降级）
- **PaperAssistant 已跑通的实装经验（v0.2.3 新增，来自 GitHub Nikki-SU/PaperAssistant 回扒）**：
  - Vditor `wysiwyg` 编辑器配置（工具栏白名单、`preview.math.engine: "KaTeX"`、`cache.enable: false`、`insertValue` 内嵌 base64 图片）
  - 图片处理：本地选图/粘贴/拖拽 → FileReader → base64 → md 内嵌（>5MB 告警不阻断），沿用到本项目（见 §1.10）
  - 表格插入用**页内网格选择器 overlay**（WPS 风格，hover 预览+点击确认），替代默认硬塞 3×3 的行为——遵守禁止弹窗硬约束
  - LaTeX 编译引擎链：xelatex → pdflatex → lualatex → tectonic 自动探测（见 §5.8）
  - 编译失败解析 `.log` 结构化错误 `!` 开头段 + `l.行号`，回显给用户
  - 1.5s 防抖自动保存 + dirty/saving/saved/error 四态 badge
  - 架构约束 C1-C5（落盘只能 md/csv、SDK/AI 失败必须降级返回 `success=False`、DOI 唯一 primary_key、删除项目不物理删目录）

### 8.2 切断（已知坏味道，本项目不复用）
- Cat 后端 SQLite/JSON → 全部改 md+csv
- Cat 关键词硬编码 → 用户可配关键词组
- Cat 追踪单源 CrossRef → 多源并行
- Cat AI 打分 `Math.random()` 兜底 → 明示"AI 不可用"
- Cat 字段命名不一致（`definition_cn` vs `def_cn`）→ 统一命名
- **Cat 混编辑/预览分栏 → 全部改成内联体验：源码-渲染同框，或至少无编辑/预览切换按钮（v0.2.2 强化，v0.2.3 保留感受硬约束，见 §1.11）**
- **Cat / PaperAssistant 编辑器元素弹窗输入 → 全部内联插入 + 就地编辑（v0.2.2 强化，见 §1.11）**
- 老 PaperAssistant 编辑器混块式/纯 md → 编辑器渲染层 + md 落盘物理分离
- **Cat 输出 md 让用户自己转格式 → 软件对外只交付 PDF + Word 编译产物，md 不出软件边界（v0.2.2 强化，见 §1.10）**
- **PDF/Word 图片留断链 → 图片必须实嵌产物（v0.2.3 新增，见 §1.10）**

### 8.3 方法论教训（v0.2.3 新增，避免第 4 次踩坑）
- **教训 1｜对标产品措辞 ≠ 技术硬约束**：Rosa 提及 Obsidian/WPS 智能文档/Writer-Cat 等对标产品时，是**感受提示**（内联能改、无弹窗），不是**技术栈硬绑定**（不代表必须用 CodeMirror 6 装饰器技术栈）。v0.2.2 曾把"接近 Obsidian"过强判为"必须走 Milkdown/CodeMirror 6，TipTap 淘汰"，v0.2.3 撤回：**上一代 PaperAssistant 用 Vditor `wysiwyg` 满足了同样的感受要求**，反证技术层不该被对标产品名绑架。
- **教训 2｜同一作者上一代项目的实装 > 猜测**：技术选型前**必先扒同一作者上一代已跑通代码**（GitHub Nikki-SU/*），确认哪些方案已实测过、哪些踩过坑；不要凭对话措辞猜技术。v0.2.3 就是这个方法的落地——先扒 PaperAssistant 拿到 Vditor+xelatex 链条+base64 图片方案等一手事实，再落说明书条款。
- **教训 3｜"淘汰"这类不可逆判词要慎用**：编辑器选型这类**未开工的技术决策**不该在需求阶段一刀切"淘汰"某个候选；正确做法是"候选池 + v0.3 原型对比"。真正该"淘汰"的是**已经踩过坑的具体做法**（如 Cat 的 `Math.random()` 兜底、Cat 的字段命名不一致）——这类有真实事实基础的才配"淘汰"。

---

## 9. 决策记录（v0.1 未决问题全部闭环）

v0.1 §9 提出的 7 个未决问题，v0.2 全部关闭。以下是决策与依据。

| # | 议题 | v0.2 决策 | 依据 |
|---|---|---|---|
| 1 | 项目正式名称 | **暂用工作代号 AcademicFlow**；Rosa 尚未起正式名，代码/文档全部以此为占位符，正式命名后全局替换 | 用户未定名，不阻塞 |
| 2 | 移动端优先级 | **跨端功能对等硬需求（非阉割版）**——移动端与桌面端能力完全一致，见 §1.8 | 用户明确"跨端是选 GitHub 后端的初衷，禁止阉割" |
| 3 | 期刊模板出厂预置 | **出厂零具体期刊**，只带 `_sample-generic/` 结构样板；具体期刊全部由用户自建/AI 辅助生成/URL 导入，见 §1.4 & §5.8 | 用户明确"读文献的人有资格自己加期刊"，对齐关键词条款 |
| 4 | 课本粒度 | **默认整本，支持章节级引入**；textbooks.csv 加 `scope` 字段 `full/chapters`，MinerU 输出的 md 按 heading 切片；引用语法 `[[textbook:id]]` / `[[textbook:id#ch3]]`，见 §4.6 | 用户明确"PDF→md 后层级明确，可以支持章节引入" |
| 5 | 词典 API | **默认组合定稿**：Free Dictionary + Wiktionary + Merriam-Webster/Oxford（可选，用户自配 key）+ IUPAC Gold Book；词典返回不足由 AI-2 兜底核查/补充 | 用户认可，"AI-2 可以兜底判断" |
| 6 | UI 语言 | **默认中文，v1.0 不做 i18n 框架**；界面文案直接用中文常量，注释里标 `// i18n: xxx` 备将来抽取，见 §1.7 | 用户明确"本来只想给中国人用，以后再考虑国际化" |
| 7 | 开源许可 | **AGPL-3.0**（软件本体）；词表/CSL/期刊模板等数据资源许可独立处理，见 §1.9 & §11 | 用户明确"不希望被别人闭掉" |
| 8 | 前端布局策略（v0.2.1） | **只维护横屏 + 竖屏两套样板**；组件内部一律相对单位（%/vw/vh/rem/flex-grid 比例），禁用绝对 px；样板按**设备物理方向**路由（横屏形态走横屏样板、竖屏形态走竖屏样板），不按设备类型分档，见 §2.4 | 用户明确"电脑默认横屏样板，平板竖屏或手机默认竖屏样板，其他按相对比例排布" |
| 9 | 编辑器交互（v0.2.2 定感受硬约束，v0.2.3 选型软化） | **感受硬约束**：内联能改、零弹窗、源码-渲染同框或至少无编辑/预览切换按钮。**技术候选池（v0.3 敲定）**：Vditor ^3.10.x 首选（上一代 PaperAssistant 实测跑通）、Milkdown/Crepe、CodeMirror 6+装饰器、TipTap 有条件回归，见 §1.11 & §2.1 & §5.7 & §8.3 | 用户明确"内联能改、零弹窗、可导出带图 PDF"；扒 PaperAssistant 拿到 Vditor 实装事实后撤回 v0.2.2 的"TipTap 淘汰"过强判断 |
| 10 | 对外交付格式（v0.2.2） | **软件对外唯一交付形态 = 编译好的 PDF + 格式正确的 Word（.docx）**；md 只是内部落盘格式，不作为对外产物；PDF 走 Tectonic WASM、Word 走 Pandoc WASM（或等价方案），引用/图表映射一致；写作过程随时可预览，见 §1.10 & §5.8 | 用户明确"不是输出 md，而是输出编译好的 PDF 或格式正确的 Word" |
| 11 | 图片资源嵌入策略（v0.2.3） | **base64 内嵌 md 源文件**（沿用上一代 PaperAssistant 实测方案）；本地选图/粘贴/拖拽都走同一路径；单张 > 5MB 前端提示不阻断；PDF/Word 编译时按标准流程解码写入产物；**绝对不允许 PDF/Word 里出现图片打不开**，见 §1.10 | 用户 22:01 明确"导出带图 PDF 发给别人"；PaperAssistant 已实测该方案跑通 |
| 12 | PDF/Word 编译入口位置（v0.2.3） | **低频功能，不占编辑器工具栏主位**；编辑器与"投稿/预览编译"并列为两个可切换面板；允许编辑器工具栏右侧放一个极简"预览产物"入口图标；禁止在保存路径上强制自动编译，见 §5.8 | 用户 22:01 明确"平时我不这样做" |
| 13 | 技术选型方法论（v0.2.3） | **对标产品措辞是感受提示，不是技术硬约束**；同一作者上一代已跑通代码 > 对话猜测；"淘汰"这类不可逆判词仅用于有真实事实基础的坏味道，未开工的技术决策走"候选池 + v0.3 原型对比"，见 §8.3 | v0.2.2 曾把 Rosa 一句"接近 Obsidian"强判为"必须走 Milkdown/CodeMirror 6，TipTap 淘汰"；扒 PaperAssistant 后发现 Vditor `wysiwyg` 已跑通同类感受要求，反证该判断过强 |
| 14 | DOI 展示形态（v0.2.4） | **存储层**：兼容纯 DOI / `https://doi.org/...` / `dx.doi.org/...` / 末尾斜杠差异，归一化后**存纯 DOI**（`10.xxx/xxx`）作 primary_key。**展示层**：所有 UI 位置（表格列、卡片、追踪推送、单词卡回链、批注元数据、写作稿悬浮预览）**统一渲染为可点击的完整 DOI 链接** `https://doi.org/{doi}`；表格列头文案叫**"DOI 链接"**（不是 "DOI"）。右键菜单同时提供"复制内部引用 `[[doi]]`"和"复制完整 DOI 链接"两种，见 §1.2 / §5.2 | 用户 14:07 明确："从网站抓下来时有 DOI 也有 DOI 链接，兼容；但**展现给人看时默认展现 DOI 链接，因为 DOI 不能直接打开，DOI 链接可以点击跳转，对人类更友好**" |
| 15 | GitHub 私库接入认证方案（v0.2.5） | **Device Flow（主）+ Fine-grained PAT（兜底）双路径平权**；**Token 存 IndexedDB `auth` object store 明文，用 CSP + SRI + 依赖锁死 + 单一发布通道 + 登出物理删除五项补偿**；新增 **§5.0 认证/Onboarding UI 模块**（登录页首屏、user_code 展示、跳转按钮、错误态、右上角认证卡片、登出/切号二次确认、Token 失效全局 modal）；**登出不撤 GitHub 侧 token**（提示使用者去 GitHub 手动 revoke）；**不做多账号并存**（切号 = 登出 + 重新登录）；**PAT 过期 ≤7 天横幅提醒**；见 §1.12 / §2.1 / §2.2 / §2.3 / §5.0 / §7.1 | GitHub Pages 静态 SPA + §2.3 "无自建后端"硬约束下，传统 OAuth Web Flow 需 `client_secret` 不可行；Device Flow 是 GitHub 平台原生的零后端零密钥方案；Fine-grained PAT 提供权限最小化的兜底路径。用户 16:54 询问"GitHub 私库怎么接入，前端有没有登录页"后，17:28 拍板"要写"，采纳双路径 + IndexedDB + §5.0 模块 + 显式化登出/切号/失效流的完整推荐 |

---

## 10. 版本与后续

- v0.1（2026-07-10 16:27）：需求闭环 + 架构定稿
- v0.1.1（2026-07-10 16:30）：AI 立场性工作条款修正
- v0.2（2026-07-10 16:36）：§9 未决问题全部闭环，跨端功能对等定为硬需求，期刊模板出厂零预置，AGPL-3.0
- v0.2.1（2026-07-10 16:41）：前端布局策略精化——横竖两套样板 + 全相对单位 + 物理方向路由，见 §2.4
- v0.2.2（2026-07-10 21:03）：编辑器交互 + 对外交付格式双升硬约束——编辑器改选 Milkdown/Crepe（Obsidian 风 Live Preview），淘汰 TipTap 块式；对外只交付 PDF + Word，md 不作产物，见 §1.10 / §1.11 / §5.7 / §5.8
- **v0.2.3（2026-07-12 13:00）**：基于 GitHub Nikki-SU/PaperAssistant 真实代码回扒的三项修正——① §1.10 加图片资源嵌入细化（base64 内嵌 md 源，沿用 PaperAssistant 已跑通方案）；② §1.11 编辑器选型软化为候选池，Vditor（PaperAssistant 实测）首选、Milkdown/Crepe、CodeMirror 6+装饰器、TipTap 有条件回归，v0.3 原型对比敲定；③ §5.8 补编译入口低频约束（不占工具栏主位、禁止自动编译）+ 补桌面端 LaTeX 引擎链参考（xelatex→pdflatex→lualatex→tectonic）；④ §8 撤回"TipTap 淘汰"反面案例，新增 §8.3 方法论教训（对标产品措辞≠技术硬约束、上一代实装>猜测、慎用"淘汰"判词）
- **v0.2.4（2026-07-12 14:07）**：DOI 展示形态硬约束升级——**存储层**继续按 v0.2.3 归一化兼容纯 DOI 与 DOI 链接（`10.xxx/xxx` 作 primary_key），**展示层**统一渲染为可点击的完整 DOI 链接（`https://doi.org/{doi}`）。覆盖所有 UI 位置：文献表格 `DOI 链接` 列头 + 单元格完整链接渲染、追踪推送卡片、单词卡回链、批注元数据、写作稿引用悬浮预览。右键菜单双选项：复制内部引用 `[[doi]]` / 复制完整链接。见 §1.2 / §5.2 / §5.5 / §5.6 / §9-14
- **v0.2.5（本版本，2026-07-12 17:30）**：GitHub 私库接入认证方案闭环——① 新增 §1.12 GitHub 认证与 Token 存储硬约束（Device Flow 主 + Fine-grained PAT 兜底 + IndexedDB `auth` object store 存 token + CSP/SRI/依赖锁死/单一发布通道/登出物理删除五项补偿 + 登出不撤 GitHub 侧 token + 不做多账号并存 + 401/403 全局 modal + PAT 过期 ≤7 天横幅）；② §2.1 组件表加"认证方式"行；③ §2.2 数据流图具象化 Device Flow 与 PAT 双路径步骤 + 认证态生命周期字段；④ §2.3 硬性禁忌加三条（禁 localStorage/cookie 存敏感凭据、禁 inline script/eval、禁 `client_secret` 型 OAuth Web Flow）；⑤ 新增 §5.0 认证/Onboarding UI 模块（登录页首屏双 tab、Device Flow user_code 展示格式与倒计时、PAT 预填模板、右上角认证卡片、登出二次确认、切号 = 登出重登、Token 失效全局 modal、错误态文案库、横竖端功能对等）；⑥ §7.1 首次初始化第 2 步改写为双路径具体流程 + 新增 §7.1.1 私库创建的最小 API 调用序列 + 跨设备/API key 存储位置修正（localStorage → IndexedDB `settings` object store）；⑦ §9 决策表新增第 15 项；⑧ §4.8 `settings/global.md` 注释同步修正。见 §1.12 / §2.1 / §2.2 / §2.3 / §4.8 / §5.0 / §7.1 / §9-15
- v0.3：交互原型（Figma 或纯 md 线框）+ 技术接口详细定义（每个 API 的 request/response、组件树、路由、状态管理）；编辑器技术选型最终敲定（Vditor / Milkdown / CodeMirror 6 / TipTap 四候选原型对比）
- v1.0：开始写代码

---

## 11. 许可协议与数据资源许可

### 11.1 软件本体
- 许可：**AGPL-3.0**（GNU Affero General Public License v3.0）
- 项目根 `LICENSE` 放全文，`README.md` 顶部醒目位置说明"AGPL 意味着：任何基于本项目改造后对外提供网络服务的实例（含 SaaS 化部署），必须开源修改后的完整代码"
- 目的：保护开源生态，防止被 fork 后闭源商用

### 11.2 分发内置的数据资源许可
以下资源随软件分发到使用者私库，各自许可**独立列出，必要时缺失待补**：

| 资源 | 用途 | 计划许可 | 状态 |
|---|---|---|---|
| 通用高频词表（BNC/COCA 衍生） | 学术词剥离用 | 需选择开源衍生版本或自建替代版本 | **待选型**：BNC/COCA 原始数据商业收费；将采用开源衍生（如 wordfrequency.info 的免费部分）或改用 Google Books Ngrams 免费数据 |
| AWL（Academic Word List, Coxhead 2000） | 学术词识别 | 学术使用公开，需标注原作者 | 计划采用，需在文档标注 Coxhead 原始出处 |
| 化学词表（IUPAC 术语等） | 学科词识别 | 参考 IUPAC Gold Book 公开数据 + 自建补充 | 计划采用，自建部分随本项目走 AGPL |
| CSL 样式 | 引用格式 | CC BY-SA 3.0（来源 citation-style-language/styles） | 出厂只带样板；用户导入的具体样式各自附原许可 |
| 期刊模板 | 投稿排版 | 无 | 出厂零预置；用户导入的各自遵守期刊/共享者许可 |

### 11.3 使用者数据
- 使用者在自己 GitHub 私库中的所有数据（文献、笔记、稿件、单词、模板）**归使用者所有**，本项目不做任何服务器端存储，不采集、不上报、不代理。
- 本项目 AGPL 许可**不覆盖**使用者数据；使用者数据的许可由使用者自己决定。
