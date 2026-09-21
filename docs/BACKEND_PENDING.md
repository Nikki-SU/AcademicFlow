# 后端待办（备忘）

> 这份文档记的是**必须动 `academicflow-workspace` 私库才能做完**的事。
> 前端能做的部分（嵌入副本对齐、安装清单补齐）已经在 2026-09-21 这一轮做完了，
> 剩下的都写在这里，等一次「大任务」集中收口。
>
> 最后更新：2026-09-21

---

## 0. 一句话结论

前端的「安装后端」按钮是**无条件覆盖**：它会把 `src/constants/skeleton.ts` 里
base64 嵌的那几个 runner 原样 PUT 到私库。所以本地嵌入副本和私库线上版本
**任何一边单独改动，都会在下次安装时把另一边打回去**。

当前（2026-09-21）实测的分叉：

| 文件 | 前端嵌入 | 私库线上 | 判定 |
|------|---------|---------|------|
| `.github/scripts/ai_call.mjs` | 60112 B | 60112 B | ✅ 本轮已对齐（之前本地只有 54273 B） |
| `.github/scripts/dual_engine_runner.mjs` | 21818 B | 21818 B | ✅ 本轮补上了（之前前端**根本没有**这个文件） |
| `.github/scripts/paper_convert.mjs` | 83217 B | 82357 B | ⚠️ **本地比线上新 860 B**，线上还没这份改进 |
| `.github/scripts/blocks.mjs` | 14196 B | 14196 B | ✅ 一致 |
| `.github/workflows/ai_call.yml` | 2268 B | 2268 B | ✅ 一致 |
| `book_convert.mjs` / `book_convert.yml` / `latex_compile.yml` | — | — | ✅ 一致（这三个走 `?raw` 直引，不是 base64） |

---

## 1. 链路先摆清楚（免得改错地方）

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
                                  ↓ runDualEngine(input)
                                  ↓ 真正 fetch 模型 API（用 Secrets 里的 Key）
                              写 temp/ai/dual_engine/<taskType>_<ts>.json 并 commit
```

关键点：**模型调用只发生在私库 runner 里**，前端不直连模型。
所以「前端报错」时，真正的原因八成在 runner 的日志里
（Actions 页面 → 对应 run → Run AI service 这一步）。

---

## 2. 坑 ①：`dual_engine_runner.mjs` 曾不在安装清单里（前端已修，线上需确认）

**现象**：新用户 / 新私库点完「安装后端」，检测页显示「已安装」，但**每一次双引擎调用都当场挂掉**。

**根因**：`PIPELINE_FILES` 里没有这个文件，而 `ai_call.mjs` 在 dual_engine 分支里
`await import('./dual_engine_runner.mjs')` —— 动态 import，只在真的调双引擎时才炸。
检测函数 `checkPipelineInstalled` 也只是逐个读 `PIPELINE_FILES`，所以**检不出来**。

**本轮已做（前端）**：
- 新增常量 `DUAL_ENGINE_RUNNER_MJS_B64`（内容取自私库线上版）
- `PIPELINE_FILES` 补上 `{ path: '.github/scripts/dual_engine_runner.mjs', b64Key: 'DUAL_ENGINE_RUNNER_MJS_B64' }`
- `repoBootstrap.ts` 的 `b64Map` 补上对应项

**还需要做（后端/私库）**：
- [ ] 确认 `Nikki-SU/academicflow-workspace` 上这个文件确实在（实测在，21818 B）
- [ ] 用别的账号/新库走一遍「安装后端」，确认三个双引擎入口（写作页 / 学习页 / 阅读页问 AI）都能跑通

---

## 3. 坑 ②：前端嵌入的 `ai_call.mjs` 一度落后线上 5.8 KB（前端已修）

**线上比本地多的东西**（`2026-09-21` 私库三个提交）：

```
feat(ai): 支持按 AI 槽位开关推理模式（thinking）
feat(ai): thinking 参数留痕 + 清理临时探针
```

具体是线上多了 `thinkingParams(level)` 并把 `input.thinking` 透传进请求体
（`{ thinking: {type:'enabled'}, reasoning_effort: level }`）。
本地旧副本**没有这个函数**，也就是说：只要「重装后端」一次，
Settings 页配的「推理强度」对 chat handler 就会静默失效。

**本轮已做（前端）**：把 `AI_CALL_MJS_B64` 换成私库线上版（54273 B → 60112 B，
解码后确认含 `function thinkingParams`）。

**还需要做（后端/私库）**：无需改动。但**以后改 runner 必须两边一起改**，见第 6 节。

---

## 4. 坑 ③：`paper_convert.mjs` 本地比线上新 —— 线上缺一个续跑修复

这是**反方向**的分叉，必须单独记，别以为「本地总是旧的」。

**差异**（线上 82357 B / 本地 83217 B，只差两处）：

线上在 step 4「提交所有变更」之前就把阶段存档（`.tmp_cleaned` / `.tmp_tagged` /
`.tmp_enumerated` / `.tmp_translated` / `.tmp_words`）删掉，并把删除动作一起提交。
问题在于**后面还有 step 4.5 / step 5**：写 `stage=done`、写 `md_status=done`、
提交一次 CSV、删 `.progress.json`。这几步任何一步失败，
**存档已经没了，`describeResume` 记的断点也就没法续跑**。

本地版本把删除挪到全部成功之后（独立一次 commit），并加了注释说明清理规则：
中途失败一个都不删、全流程成功才清理、`.tmp_meta.json` 永不删（留着它下次才能
复用 `full.md` + `images/`，不白烧 MinerU 额度）。

**还需要做（后端/私库）**：
- [ ] 把本地 `src/constants/skeleton.ts` 里 `PAPER_CONVERT_MJS_B64` 解码后的内容推回
      `academicflow-workspace@main:.github/scripts/paper_convert.mjs`
      （本地版是线上版 + 这一个修复，是干净的超集，可直接覆盖）
- [ ] 顺手把仓库根目录那个同内容的明文副本 `.tmp_paper_convert.edit.mjs` 清掉或改名
      （它和嵌入版逐字节相同，留着只会让人以为是另一份源码）
- [ ] 推完之后**反过来**再确认一次前端嵌入副本 == 线上版本

---

## 5. 坑 ④：模型调用没有单次超时；输出预算和推理共用

这两条是「写作页很慢 / 后台像静默失败」的后端侧根因。

1. **没有单次调用超时**。`dual_engine_runner.mjs` 里 `aiCall()` 的 `fetch` 没有
   `AbortController`，也没有超时。模型端挂住 → 一直等 → GitHub job 自己
   `timeout-minutes: 15` 到点被砍 → **不会写结果文件** → 前端只能干等到
   20 分钟轮询上限才报「超时」。前端比 job 多等 5 分钟，纯浪费。

2. **`MAX_TOKENS = 32000` 是「推理 + 正文」共用一个额度**。推理型模型（thinking 开）
   会把额度烧在 reasoning 上，正文吐空。`dual_engine_runner.mjs` 顶部注释自己
   就写了这件事，但只把 16000 抬到 32000，**没有把两者拆开**。
   后果：AI-2 返回空串 → 前端旧逻辑把它当「审阅未通过」报出去，用户看到的是
   「AI 判定不忠实」而不是「根本没输出」。

**本轮已做（前端，缓解）**：
- `runDualEngine` 调用处传 `maxAttempts: 2`（原来后端默认 5，最坏 10 次模型调用）
- AI-2 **空输出**与「判定不忠实」分成两种提示，不再混为一谈
- loading 区显示「已等 N 分 MM 秒」，并说明后端要排队跑 Actions
- 源材料读取失败不再静默 `return ''`，改成显式列出「哪几篇没读到」

**还需要做（后端/私库）**：
- [ ] `dual_engine_runner.mjs` 的 `aiCall()` 加 `AbortController` + 单次超时
      （建议 180s，超时按可重试错误处理，不要当成审阅失败）
- [ ] 输出预算与推理预算分开：要么 thinking 走独立额度，要么 prompt 里明确要求
      「正文必须完整输出」，要么按 `finish_reason === 'length'` 检测截断并自动重试
- [ ] 前端轮询上限（20 min）与 job `timeout-minutes`（15 min）对齐，或者让 runner
      在超时/异常时**一定**写一份带 `error` 的结果文件，别让前端空等
- [ ] 前端 `pollResultFile` 目前 `catch {}` 吞掉一切（`dual-engine.ts`），
      建议至少把「结果文件写了 error」和「文件压根没出现」区分开

---

## 6. 坑 ⑤：写作页源材料「最多 5 篇全文 × 每轮重传」

`Writing.tsx` 的可信检索会取前 5 篇有 DOI 的引用，每篇取**全文**（`loadAiSourceText`），
然后 `runDualEngine` 每一轮重试都把这坨原文**重新传一次**给模型。

`maxAttempts` 已经降到 2，所以最坏是 2 倍而不是 5 倍，但**根上还是全文重传**。

**现状**：前端没有截断，后端也没有。策略未定 —— 需要用户拍板：

- 选项 A：只取每篇的摘要 + 前 N 段（便宜，但可能丢掉要引的证据）
- 选项 B：保留全文，但把「轮次」变成「同一次会话的多轮对话」，只传增量
- 选项 C：保留全文，接受成本，只把 `maxAttempts` 卡在 2（当前状态）

> ⚠️ 这条属于功能逻辑，**不要自行拍板**，要先问。

---

## 7. 坑 ⑥：长难句的「自动提取」还差后端那一半

学习页的长难句/摘要翻译**练习闭环前端已经做完了**（作答、踩分点判分、双方向、
历史批量补提）。但用户原本的设想是「长难句在 pipeline 里单词后面顺手提取」，
这一半必须动后端。

现状：`paper_convert.mjs` 在节点 3 跑完 `runWordsExtraction`（提词 → `vocabulary.csv`）
之后就没有学习相关的动作了，长难句一条都不产生。前端只能靠"批量补提"事后追。

要做：
- [ ] 在 `runWordsExtraction` 之后加一个 `runSentencesExtraction`：
      输入 = 清洗后的原文块 + 官方译文块，输出 = `sentences/sentences.csv`
      的增量行，字段照前端新结构来（`scoring_points` / `difficulty_note` /
      `latest_user_translation` / `latest_ai_feedback` / `latest_error_words` /
      `practice_count` / `last_practice`，新列在末尾，旧行留空）
- [ ] 条数从 `settings/global.md` 读（前端已经写进去 `sentence_gen_count`，范围 3-30，默认 8）
- [ ] 抽题范围、去重口径（同一句不要重复入库）由用户拍板后照做，别自己定
- [ ] 摘要翻译**不需要后端**：题面与参考答案就是 `literatures.csv` 里的
      `abstractEn` / `abstractCn`，前端已经能直接出两个方向的题

⚠️ 改这个文件的同时**必须**按第 4 节把那处续跑修复一起带上，别用旧副本覆盖。

---

## 8. 正确姿势：怎么把改动装进后端

### 8.1 改 runner（在私库里改）

1. 直接改 `Nikki-SU/academicflow-workspace` 里的 `.github/scripts/*.mjs`
2. commit + push 到 `main`（**必须是 main**，workflow 从 main 取脚本）
3. 去 Actions 手动跑一次 `ai_connectivity_test`，确认 secret / 端点没被改坏
4. 回到前端仓库，把同一份文件的 base64 重新嵌进 `src/constants/skeleton.ts`

### 8.2 改前端嵌入副本（把线上版本拉下来重新编码）

没有现成的生成脚本，用这个（需要 `gh` 已登录）：

```bash
cd /tmp && mkdir -p sync && cd sync
for f in ai_call.mjs paper_convert.mjs dual_engine_runner.mjs blocks.mjs; do
  gh api "repos/Nikki-SU/academicflow-workspace/contents/.github/scripts/$f" \
    --jq '.content' | base64 -d > "$f"
done
# 然后按各文件生成 base64，替换 skeleton.ts 里对应的 XXX_B64 常量
```

替换后用这个自检（解码长度必须与线上一致）：

```bash
node -e "
const fs=require('fs');const s=fs.readFileSync('src/constants/skeleton.ts','utf8');
for(const n of ['AI_CALL_MJS_B64','PAPER_CONVERT_MJS_B64','DUAL_ENGINE_RUNNER_MJS_B64','BLOCKS_MJS_B64']){
  const m=s.match(new RegExp(n+'\\\\s*=\\\\s*\x27([A-Za-z0-9+/=\\\\s]+)\x27'));
  console.log(n, Buffer.from(m[1].replace(/\s/g,''),'base64').length);
}"
```

### 8.3 绝对不要做的事

- ❌ **不要在副本落后时点「重装后端」** —— 会把线上新版本覆盖回旧版
- ❌ 不要用 `git push --force` 推私库
- ❌ 不要把 runner 源码贴进公开仓库（`AcademicFlow` 是 **public**，私库是 private；
      本文档只写「哪个文件、多少字节、什么行为」，不含密钥与原文）

---

## 9. 大任务清单（收口用）

- [ ] `paper_convert.mjs`：把本地的续跑修复推上私库（第 4 节）
- [ ] `dual_engine_runner.mjs`：加单次调用超时 / 截断检测（第 5 节）
- [ ] 结果文件契约：runner 异常时也写一份带 `error` 的结果（第 5 节）
- [ ] 前端轮询上限与 job `timeout-minutes` 对齐（第 5 节）
- [ ] 源材料收敛策略按用户拍板执行（第 6 节）
- [ ] 端到端回归：新库安装后端 → 写作页可信检索 → 学习页 AI 补例句 → 阅读页问 AI
- [ ] 长难句在 pipeline 里预提取（第 7 节）
- [ ] 清掉 `.tmp_paper_convert.edit.mjs` 这类明文冗余副本
