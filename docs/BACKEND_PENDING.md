# 后端状态与运维须知

> AcademicFlow 的后端 runner 跑在私库 `Nikki-SU/academicflow-workspace` 的 GitHub Actions 上，
> 前端通过 Contents API 把 base64 嵌在 `src/constants/skeleton.ts` 里的副本「安装」进去。
> 本文档记三件事：**现在两边是否一致**、**改后端必须遵守什么**、**还剩什么没做**。
>
> 最后更新：2026-09-24

---

## 0. 当前状态（2026-09-21）

**前端嵌入副本与私库线上：全部逐字节一致。** 13 个文件（10 个 base64 + 3 个 `?raw`）实测通过。

| 文件 | 字节 | 本轮变化 |
|------|------|---------|
| `scripts/ai_call.mjs` | 60112 | ✅ 之前前端落后 5.8KB（缺 `thinkingParams`），已拉齐 |
| `scripts/dual_engine_runner.mjs` | 29183 | ✅ 之前前端**根本没有**这个文件；现已补进安装清单并修了超时/预算；【源材料】改为共享稳定前缀 |
| `scripts/paper_convert.mjs` | 97061 | ✅ 之前前端本地版比线上新（续跑修复没推上去）；现已推上去并加了长难句提取 |
| `scripts/blocks.mjs` | 14196 | 一致 |
| `workflows/ai_call.yml` | 2572 | ✅ job timeout 15 → 25 分钟 |
| `workflows/paper_convert.yml` | 2450 | 一致 |
| `mineru_connectivity_test` / `ai_connectivity_test`（yml+mjs） | — | 一致 |
| `book_convert.mjs` / `book_convert.yml` / `latex_compile.yml` | — | 一致（走 `?raw` 引源文件） |

私库侧的本轮提交：

```
perf(dual_engine): 源材料做成同引擎各次调用共享的稳定前缀 —— 每篇文章只被真正处理一次
feat(pipeline): 长难句提取落到 sentences.csv + 延迟清理断点存档 + CSV 读取认引号
fix(dual_engine): 单次调用超时 + 总预算 + 空输出/截断重试关思考；AI-2 哑掉不再丢掉 AI-1 成果
fix(ai_call): job timeout 15→25 分钟，给 runner 的 18 分钟预算留收尾余量
```

---

## 1. 链路（免得改错地方）

```
前端                          私库（academicflow-workspace）
──────────────────────────    ──────────────────────────────────────────
runDualEngine()          ──▶  repository_dispatch: ai_call
   ↓ dispatchAiCall()          ↓
   轮询 temp/ai/dual_engine/*.json
                          ◀── .github/workflows/ai_call.yml
                                ↓ node .github/scripts/ai_call.mjs
                                  ↓ task_type === 'dual_engine'
                                  await import('./dual_engine_runner.mjs')
                                  ↓ runDualEngine(input) → 真正 fetch 模型 API
                              写 temp/ai/dual_engine/<taskType>_<ts>.json 并 commit
```

**模型调用只发生在私库 runner 里**，前端不直连模型。前端报错时，真正的原因八成在
Actions 日志里（对应 run → Run AI service 这一步）。`ai_call.mjs` 已经保证：
handler 抛错也会写一份 `{ error: "..." }` 的结果文件，前端 `parseBackendResult` 会把它抛出来。

---

## 2. ⚠️ 四条时间线必须维持的大小关系

它们互相咬合，**单独改一个就会出问题**：

| 位置 | 值 | 作用 |
|------|-----|------|
| `dual_engine_runner.mjs` `CALL_TIMEOUT_MS` | 300 s | 单次模型调用的硬超时（AbortController） |
| `dual_engine_runner.mjs` `TOTAL_BUDGET_MS` | 18 min | 整个任务的总预算，到点不再发起调用、带着已有结果正常返回 |
| `ai_call.yml` `timeout-minutes` | 25 min | GitHub job 上限，**必须大于总预算**（给收尾留余量） |
| `src/services/ai/dual-engine.ts` `maxAttempts` | 520 × 3s = 26 min | 前端轮询上限，**必须大于 job 上限** |

**为什么这么在意**：job 被 `timeout-minutes` 砍掉 = SIGKILL，runner 连结果文件都写不出来，
前端只能干等到轮询超时 —— 用户看到的就是「非常慢、后台像静默失败了」。
改了任意一个值，请顺手把其余三个一起核对。

---

## 3. 改 runner 的正确姿势

### 3.1 在私库里改

1. 改 `Nikki-SU/academicflow-workspace` 的 `.github/scripts/*.mjs` 或 `.github/workflows/*.yml`
2. commit + push 到 `main`（**必须 main**，workflow 从 main 取脚本）
3. Actions 手动跑一次 `ai_connectivity_test`，确认 secrets / 端点没被改坏
4. 回来把同一份文件重新嵌进 `src/constants/skeleton.ts`

### 3.2 重新嵌 base64

没有生成脚本，用这个（`gh` 需已登录）：

```bash
cd /tmp && mkdir -p sync && cd sync
for f in ai_call.mjs paper_convert.mjs dual_engine_runner.mjs blocks.mjs; do
  gh api "repos/Nikki-SU/academicflow-workspace/contents/.github/scripts/$f" \
    --jq '.content' | base64 -d > "$f"
done
# 按各文件重新生成 base64，替换 skeleton.ts 里对应的 XXX_B64 常量
```

### 3.3 改完必须核对一致性

```bash
cd /workspace && node -e "
const fs=require('fs');const s=fs.readFileSync('src/constants/skeleton.ts','utf8');
for(const n of ['AI_CALL_MJS_B64','PAPER_CONVERT_MJS_B64','DUAL_ENGINE_RUNNER_MJS_B64','BLOCKS_MJS_B64','AI_CALL_YML_B64']){
  const m=s.match(new RegExp(n+'\\\\s*=\\\\s*\x27([A-Za-z0-9+/=\\\\s]+)\x27'));
  console.log(n, Buffer.from(m[1].replace(/\s/g,''),'base64').length+' B');
}"
```

长度要和私库线上一致。另外确认 `PIPELINE_FILES` 里每个 `b64Key` 都有对应常量
（**加文件必须同时改三处**：常量、`PIPELINE_FILES`、`repoBootstrap.ts` 的 `b64Map`）。

### 3.4 绝对不要做的事

- ❌ **不要在嵌入副本落后时点「重装后端」** —— `writePipelineFiles` 是**无条件覆盖**，
  会把线上新版本打回旧版（本轮踩过的就是 `ai_call.mjs` 落后 5.8KB 这个坑）
- ❌ **不要把「每轮才变」的文案改进 system** —— 【源材料】是同一引擎各次调用共享的缓存前缀
  （详见 §6.1），system 差一个字节整段前缀就作废，同一篇文章被完整重算一遍
- ❌ 不要用 `git push --force` 推私库
- ❌ 不要把 runner 源码贴进公开仓库（`AcademicFlow` 是 public，私库是 private）

---

## 4. 长难句提取（bug#4 的后端那一半，已完成）

`paper_convert.mjs` 在节点 3 跑完 `runWordsExtraction`（提词）之后新增 `runSentencesExtraction`：

- **条数**来自 `settings/global.md` 的 `sentence_gen_count`（前端设置页「长难句提取数量」写入，3-30，默认 8）
- **输入**：`postResult.enItems`（该块英文 + 官方中文译文成对给出）
- **逐字回贴**（`snapToSource`）：AI 挑句子时一定会顺手润色，而这句话是给学生看的参考答案 ——
  所以**不接受 AI 的字符串**，只在原文里定位它、切出原文那一段（归一化压空白 + 小写后匹配，
  前缀 60→24 字符退让）。定位不到就整条丢掉，绝不写进 CSV
- **踩分点**由 AI-1 一并给出并落库（`scoring_points`，JSON 数组字符串），前端可编辑、判分时当唯一评分标准
- **官方译文**进 `sentence_cn`，AI 自译进 `ai_reference_cn`（前端展示 `sentence_cn || ai_reference_cn`）
- **去重**：按归一化后的 `sentence_en` 全局去重
- 没有加 AI-2 复核：逐字性由代码机械保证，"这句值不值得练"是 AI-1 已经做过的判断，
  多一轮复核只加成本。若日后发现踩分点质量差，再加复核
- 摘要翻译**不需要后端**：题面与参考答案就是 `literatures.csv` 的 `abstractEn` / `abstractCn`

### CSV 契约（前后端共享，改列必须两边同步）

`sentences/sentences.csv` 的列必须与前端 `src/services/learningData.ts` 的 `SENTENCE_HEADERS`
**完全一致（顺序也一致）**。新列一律**追加在末尾**，旧行缺列给安全默认。

`loadLocalCsv` 已升级为**认引号**的解析器（`parseCsvLine`）—— 因为 `scoring_points` 是 JSON、
`example_context` 含逗号，简单 `split(',')` 会让去重时读到的字段错位。

---

## 5. dual_engine_runner 的容错（已完成）

- **单次调用超时**（`AbortController`，300s）：provider 挂住不再无限等
- **总预算 18 分钟**：到点停止发起调用，带着已有结果正常返回（`stopReason: 'budget_exceeded'`）
- **空正文 / `finish_reason === 'length'` 当可重试错误**，并且**从第二次重试起把思考关掉**
  （32k 输出预算 reasoning 与正文共用，推理型模型容易把预算烧在思考上、正文吐空）
- **AI-2 哑掉不再丢掉 AI-1 的成果**：降级返回正文 + `ai2Silent: true` + `stopReason: 'ai2_silent'`，
  并**停止后续轮次**（再让 AI-1 重写一遍也换不来复核，纯白花钱）。
  例外：401/403/404 鉴权错误照旧抛出，不伪装成"AI-2 没说话"
- **任意一轮失败但前面已有结果 → 带着结果返回**（`stopReason: 'call_failed'`），
  不再因为最后一轮失败把整份结果丢掉
- 结果里新增 `ai2Silent` / `stopReason`，前端（`types.ts` 的 `DualEngineResult`）已同步；
  旧结果文件没有这两个字段，前端用 `ai2Silent ?? !ai2RawOutput.trim()` 兜底

---

## 6. 仍然待办

### 6.1 写作页源材料「最多 5 篇全文」—— 已定：每篇文章只被真正处理一次

**前端**（`Writing.tsx` 可信检索）：取引用里前 5 篇**不同 DOI** 的文献全文。
同一篇文献在正文里常被引注多次，所以按 DOI 去重**之后**再截 5 篇 ——
不去重的话同一篇文章会被读两遍、在【源材料】里出现两份，既白烧 token，又让 AI 在同一段重复证据上反复引证。

**后端**（`dual_engine_runner.mjs`）：模型端点是无状态的 —— AI-1 首轮 / AI-1 重写 / AI-2 核查 /
AI-2 自纠错，每一次请求都必须自己带上【源材料】，没有别的地方能让模型拿到原文。
所以「每个文章只传一次」在无状态 API 上唯一能落地的形态是：
把【源材料】做成同一引擎各次调用**逐字节相同的最长前缀**，支持前缀缓存的端点
（DeepSeek / 硅基流动等）只会真正处理它一次，后续调用按缓存命中算；前缀差一个字节就整段作废。

为此 runner 里立了三条硬规矩：

1. `buildSourcePrefix()` / `buildAI2SourcePrefix()` 是**唯一**构造【源材料】的地方，各次调用共用；
2. `buildAI1System()` / `AI2_SYSTEM` 被首轮与重发轮共用 —— **任何「每轮才变」的文案
   （重写要求、纠错要求、「第 N 轮」）都必须放在源材料之后，不得进 system**；
   旧实现把重写轮的 system 换成另一段（`roleDesc.replace(...)`），前缀从第一个 token 就分叉，等于每轮重算；
3. 前端取文献时按 DOI 去重。

不变量测试（`t_prefix.mjs`，26 项）钉住这三条：同一引擎首轮/重发轮的 `system` 逐字节一致、
两条 user 的公共前缀**包含完整源材料**、源材料在单条消息里只出现一次、差异文案没混进 system。

**跨引擎共享（AI-1 与 AI-2 之间）做不到**：两边 system 不同（总结助手 / 核查助手），前缀从第一个
token 就分叉。要共享就得把两个角色提示都挪到源材料之后 —— 那是动提示语义，不做。

`maxAttempts` 仍是 2（AI-2 打回后自动重写的次数），最坏 4 次调用；
`aiCall` 内部失败重试时 payload 完全不变，属于满缓存命中。

### 6.2 端到端回归（需要真机跑一次）

- [ ] 新库走一遍「安装后端」→ 确认 `dual_engine_runner.mjs` 被写进去、检测页显示已安装
- [ ] 写作页可信检索（长材料，验证 18 分钟预算内能出结果、AI-2 哑掉时提示正确）
- [ ] 学习页 AI 补例句 + 历史批量补提
- [ ] 阅读页问 AI
- [ ] 转一篇新 PDF，确认 `sentences/sentences.csv` 收到新行且列对齐、逐字回贴生效
- [ ] 写作页选一个期刊模板 → 「正式编译（后端）」→ 确认 0 TeX/bibtex 报错、参考文献有年份

---

## 7. LaTeX 云端编译（正式编译）

### 7.1 链路

```
写作页「正式编译（后端）」
  ├─ saveCloudSource()  写 projects/<id>/latex-cloud/{main.tex, references.bib} + extraFiles
  │                     extraFiles = collectTemplateAssets()（模板 assets 里该挂的那些）
  ├─ repository_dispatch: latex_compile {project_id, run_id}
  │     ↓ 私库 .github/workflows/latex_compile.yml
  │       docker: texlive/texlive:latest
  │       latexmk -xelatex -interaction=nonstopmode -file-line-error main.tex
  └─ 轮询 projects/<id>/latex-cloud/build.json（status/log_tail），产物 main.pdf

输入  projects/<id>/latex-cloud/main.tex, references.bib（+ 模板资源，同目录）
附加搜索路径  projects/<id>/latex-packages/（用户导入的宏包）
输出  build.json（status + 日志尾部） / main.pdf / main.log
```

**工作目录就是 `main.tex` 所在目录**，所以 `extraFiles` 一律按相对 `main.tex` 的路径落位。

### 7.2 模板资源该挂哪些（`src/services/latex-assets.ts`）

| 类别 | 规则 | 为什么 |
|------|------|--------|
| 图片、`\input`/`\include` | 只挂源码**引用到的**，缺了就在界面上点名 | Wiley 整包 14MB，全量拉没意义 |
| `.sty/.cls/.clo/.def/.bst` | **无条件全挂**，哪怕主 `.tex` 一个字没提 | 出版社整包是自洽的一套，依赖藏在类文件内部 |
| 类文件内部引用的文件 | 读 `.cls/.sty` 再顺着找一遍，按**引用写的路径**落位 | `USG.cls` 里既有 `images/ORCID_Logo` 也有裸文件名引用 |
| `references.bib` | 应用自己提供，不算模板缺件 | 否则每次编译都误报 |

### 7.3 这一轮后端编译踩过的坑（全部已修并真机验证）

1. **`! LaTeX Error: File 'lettersp.sty' not found`** —— 模板自带的 `.sty/.cls/.bst` 一件都没挂，
   而 `USG.cls` 内部 `\usepackage{lettersp}`（实际文件名是 `LETTERSP.STY`，靠 kpathsea 大小写折叠命中）。
   → 见 7.2 第 2 行。
2. **类文件内部引用图片找不到** —— `USG.cls` 按裸文件名引 `images/` 下的图。
   → 读类文件顺着找 + 按引用写的路径落位（`resolveTexFileRef`）。
3. **编译不幂等** —— `main.log` 会被提交回仓库（失败时给用户看日志），runner 一检出就带着旧日志；
   latexmk 先读它、据此决定先跑 bibtex 还是 xelatex，旧日志写着 `No file main.bbl` 就会在还没有
   `.aux` 时先跑 bibtex，报 `I found no \bibstyle command` 直接中断，xelatex 一次都没跑。
   → workflow 编译前 `rm -f` 清掉 `main.aux/.log/.blg/.bbl/.xdv/.pdf/.fdb_latexmk/.fls`。
4. **bibtex 160+ 报错、每条文献丢年份** —— 出版社给的 `wileyNJD-Chicago.bst`（1992 年的老 chicago）
   头部声明的函数与文件尾实际用的（`label` / `short.list`）对不上，label 栈损坏 → 年份全空。
   **注意**：bibtex **只认 aux 里第一条 `\bibstyle`**（后续的报 `Illegal, another \bibstyle command` 被丢掉），
   所以**在稿子里加 `\bibliographystyle` 永远赢不过类文件** —— 必须改类文件点名的那个名字。
   → 把 `USG.cls` 里的 `{wileyNJD-Chicago}` 换成同包里健康的 `{wileyNJD-Chicago-lastoo}`
     （natbib `plainnat` 衍生）。**这是模板数据，不是前端代码**，落点在私库
     `templates/journals/wiley-njd-optimal-design-twocolumn/assets/USG.cls`。

### 7.4 真机验证结果（run #10，2026-09-24）

`build.json` = `ok`，`main.pdf` 10 页，`The style file: wileyNJD-Chicago-lastoo.bst`，
bibtex 只剩 5 条**数据性** warning（`empty year in Hoch2009` / `empty booktitle in Burton2013` ——
出版社自己的示例 `.bib` 里这些条目确实没写这两个字段，属真实的源数据缺口，不是样式错误），
无未解析引用，参考文献每条都有年份。

### 7.5 仍然待办

- ⚠️ **`回写结果` 的 push 竞态**：编译期间前端在自动保存稿件（也是 push），`回写结果` 被拒后
  走 `pull --rebase` 重试。原本只重试 4 次、间隔固定 3s —— 那次自动保存正好压在窗口里时
  4 次会全废，**编译结果整份丢掉**（实测出现过一次，用户表现为「等了十分钟什么都没有」）。
  已改成 **10 次、退避 + 抖动**（`sleep $(( i * 2 + RANDOM % 3 ))`，窗口约 110s 起），
  并在 `pull --rebase` 自身失败时 `git rebase --abort`，避免仓库停在半截 rebase 状态。
- 其他模板（`rsc-article-template` / `science-family-templates` / `wiley-vch-chemistry-europe`）
  各自带的 `.bst` **未在本地逐一验证**；真机编译验证见 7.6。

### 7.6 其余三个模板的真机验证

> 复刻前端 `collectTemplateAssets` 的落盘（`main.tex` = 模板 `template.tex`，其余 = plan 出来的那批），
> 每个模板单独一个项目目录，避免上一个模板残留的 `.cls/.sty` 把 not found 盖掉。临时目录验证完已删。

| 模板 | 结果 | 参考文献样式 | bibtex |
|------|------|------------|--------|
| `rsc-article-template` | ✅ `ok` / 有 PDF / 0 报错 | `rsc.bst` | 无 warning |
| `science-family-templates` | ✅ `ok` / 有 PDF / 0 报错 | `sciencemag.bst` | 1 条源数据 warning |
| `wiley-vch-chemistry-europe` | ⚠️ 首轮失败，修后 ✅ `ok` | `Wiley-chemistry.bst` | 2 条源数据 warning |
| `wiley-njd-optimal-design-twocolumn` | ✅ `ok`（见 7.4） | `wileyNJD-Chicago-lastoo.bst` | 5 条源数据 warning |

**Wiley-VCH 首轮暴露的问题（已修）**：`! LaTeX Error: File 'wiley-vch.eps' not found.`
—— 包里真实文件名是 `Wiley-VCH.eps`（大写），而 `WileyChemistry-template.cls` 第 20 行的页眉里写的是
`wiley-vch.eps`（小写）。出版社在 macOS / Windows 上打包，大小写无所谓；Linux runner 上是按字面找的。
kpathsea 的大小写折叠只在 texmf 树上生效，编译目录里不兜这个底。

修法在 `src/services/latex-assets.ts`（**不是**改模板数据 —— 数据侧的改动重装模板就会被冲掉）：

- `lookup` / `lookupByBasename` 的比对**忽略大小写**；
- 新增 `placementFor()`：**目录与文件名取引用的写法，扩展名取真实文件的**。
  `\includegraphics{wiley-vch.eps}` 就得落成 `wiley-vch.eps`（连大小写都对），
  而 `\includegraphics{head_foot/LOGO}` 要保留真实扩展名（graphicx 自己会试 `.pdf/.eps…`）；
- `planTemplateAssets` 的 `files` 由 `string[]` 改成 `{from,to}[]`，与「顺着类文件找图」共用同一套
  解析，主 `.tex` 与类文件两条路径不再各有一套规则。

### 7.7 重新导入模板会冲掉数据侧修复

出版社原包留在 `templates/packages/`（例如 `Wiley-NJD-Optimal-Design-TwoColumn.zip`），
重新导入会重新解包、把 `assets/` 覆盖回去 —— `USG.cls` 里被我们改掉的 `-lastoo` 会变回
有缺陷的 `wileyNJD-Chicago`。已在对应模板的 `meta.md` 里记了一笔，重装后需重做。

> 这也是 7.6 那个修法放在**前端代码**而不是模板数据里的原因：数据侧的修复活不过一次重装。
