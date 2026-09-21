# 后端状态与运维须知

> AcademicFlow 的后端 runner 跑在私库 `Nikki-SU/academicflow-workspace` 的 GitHub Actions 上，
> 前端通过 Contents API 把 base64 嵌在 `src/constants/skeleton.ts` 里的副本「安装」进去。
> 本文档记三件事：**现在两边是否一致**、**改后端必须遵守什么**、**还剩什么没做**。
>
> 最后更新：2026-09-21

---

## 0. 当前状态（2026-09-21）

**前端嵌入副本与私库线上：全部逐字节一致。** 13 个文件（10 个 base64 + 3 个 `?raw`）实测通过。

| 文件 | 字节 | 本轮变化 |
|------|------|---------|
| `scripts/ai_call.mjs` | 60112 | ✅ 之前前端落后 5.8KB（缺 `thinkingParams`），已拉齐 |
| `scripts/dual_engine_runner.mjs` | 27859 | ✅ 之前前端**根本没有**这个文件；现已补进安装清单并修了超时/预算 |
| `scripts/paper_convert.mjs` | 97061 | ✅ 之前前端本地版比线上新（续跑修复没推上去）；现已推上去并加了长难句提取 |
| `scripts/blocks.mjs` | 14196 | 一致 |
| `workflows/ai_call.yml` | 2572 | ✅ job timeout 15 → 25 分钟 |
| `workflows/paper_convert.yml` | 2450 | 一致 |
| `mineru_connectivity_test` / `ai_connectivity_test`（yml+mjs） | — | 一致 |
| `book_convert.mjs` / `book_convert.yml` / `latex_compile.yml` | — | 一致（走 `?raw` 引源文件） |

私库侧的本轮提交：

```
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

### 6.1 写作页源材料「最多 5 篇全文 × 每轮重传」（**等用户拍板**）

`Writing.tsx` 的可信检索取前 5 篇有 DOI 的引用、每篇取全文（`loadAiSourceText`），
`runDualEngine` 每一轮重试都把这坨原文重新传一次。`maxAttempts` 已降到 2，但根上还是全文重传。

前端不截断，后端也不截断。策略未定：

- 选项 A：只取每篇的摘要 + 前 N 段（便宜，但可能丢掉要引的证据）
- 选项 B：保留全文，但把「轮次」变成同一次会话的多轮对话，只传增量
- 选项 C：保留全文，接受成本，只把 `maxAttempts` 卡在 2（当前状态）

> ⚠️ 这条属于功能逻辑，**不要自行拍板**。

### 6.2 端到端回归（需要真机跑一次）

- [ ] 新库走一遍「安装后端」→ 确认 `dual_engine_runner.mjs` 被写进去、检测页显示已安装
- [ ] 写作页可信检索（长材料，验证 18 分钟预算内能出结果、AI-2 哑掉时提示正确）
- [ ] 学习页 AI 补例句 + 历史批量补提
- [ ] 阅读页问 AI
- [ ] 转一篇新 PDF，确认 `sentences/sentences.csv` 收到新行且列对齐、逐字回贴生效
