# dsh-reme 使用说明

面向日常使用；安装、配置和开发见 [README.md](../README.md)。

## 1. 它为你做什么

| 方向 | 行为 | 你要做什么 |
|---|---|---|
| **读**（自动召回） | 你每次提问，自动检索长期记忆，把相关片段作为"引用数据"注入上下文 | 无 |
| **写**（自动沉淀） | 对话到一定量，自动把持久事实抽成笔记写入记忆 | 无 |
| 手动 | 模型可调用 `reme_search`（查）/ `reme_write`（记） | 说"查一下以前的决定"或"记住这个" |
| 诊断 | `reme_memory_status` 只读状态 | 让模型汇报 |

一句话：平时不用管；该记的它会记，问到相关的它会想起来。

## 2. 会用到的东西

| 名称 | 位置 / 值 | 说明 |
|---|---|---|
| 记忆服务 | `http://127.0.0.1:2333` | ReMe，必须运行 |
| 记忆文件 | `<ReMe 工作区>\.reme\digest\*.md` | 人类可读，可直接编辑 |
| 索引 | `<ReMe 工作区>\.reme\metadata\` | 自动维护 |
| 诊断工具 | `reme_memory_status` | 本 bundle 默认开启 |

## 3. 怎么知道它在工作

1. 回答里出现你没重新说过的信息。
2. `digest\` 出现新文件，且 frontmatter 带 `source: auto-extract`。
3. `reme_memory_status` 里 `searches` / `injected` / `written` 在增长。

注意区分两种"没反应"：**没召回**（`skipped` 有原因）和**召回了但没命中**（`no-hits`）。

## 4. 诊断输出怎么读

```text
recall: timeout=400ms agents=1
  rules: minQueryChars=4 limit=4 minScore=0.3 maxChars=1500
  feed: sessionEvents=… userMessages=… | inboxClaimed=… userTexts=…
  all-time: searches=… injected=… skipped={…}
  - session-…: assemblies=… injected=… memoHits=… searches=… failures=… timeouts=…
    skipped={…} lastSkip=…
    lastUserText="…"

extract: sessions=1 model=<provider>/<model> llm=ok maxTokens=4000 dedupeCircuit=closed
  - session-…: runs=… candidates=… written=… pending=…/…ch trigger=…
    skipped: lowConfidence=… duplicate=… secret=… rateLimit=…
    failures: llm=… parse=… dedupe=… write=… abandoned=… circuitOpen=… truncated=…
    lastWritten=… lastError=…
    lastReply=…ch "…"
```

**召回 half（读）**

| 字段 | 含义 |
|---|---|
| `rules` | 实际生效的阈值（补丁可能覆盖代码默认值） |
| `inboxClaimed` / `userTexts` | 收到的输入次数 / 其中解析出文本的次数 |
| `searches` / `injected` | 实际检索次数 / 成功注入次数 |
| `skipped` | 跳过原因，见下表 |
| `lastQuery` / `lastLatency` / `lastInjectedChars` | 最近一次查询、耗时、注入字符数 |

`skipped` 原因：`no-query`（还没收到输入）/ `too-short`（短于阈值）/ `small-talk`（语气词）/
`no-content`（只有标点）/ `no-hits`（检索了但没命中）。

**沉淀 half（写）**

| 字段 | 含义 |
|---|---|
| `model` / `llm` / `maxTokens` | 抽取路由、LLM 服务是否可用、输出预算 |
| `runs` / `candidates` / `written` | 抽取次数 / 候选数 / 实际写入数 |
| `pending` / `trigger` | 未抽取的缓冲 / 触发原因（`turns` / `chars` / `idle` / `disposed`） |
| `skipped` | `lowConfidence` / `duplicate` / `secret` / `rateLimit` |
| `failures` | `llm` / `parse` / `dedupe` / `write` / `abandoned` / `circuitOpen` / `truncated` |
| `truncated` | 模型以 `max-tokens` 结束的次数；salvage 仍可能救回，持续增长才说明预算偏小 |
| `lastReply` | 模型原始回复的字数与开头（解析失败时唯一的排查依据） |

## 5. 常见问题

### 感觉它不记得我

1. 记忆库是不是空的？看 `digest\` 有几个文件。
2. 是否被跳过？看 `skipped`；常用短句可把 `recallMinQueryChars` 调到 3–4。
3. 是否检索了但没命中？`no-hits` 说明词面不匹配（ReMe 没有 embedding，检索是关键词 + BM25），
   编辑记忆时把可能的说法都写进去（中英双写、加别名）。

### 刚说的事它记不住

抽取是批量的：默认每 4 个用户回合、或缓冲 800 字、或空闲 90 秒才触发。即使写了，ReMe 的后台
watcher 也要约 5–10 秒收进索引。想立刻记住，直接说"记住：……"让模型调 `reme_write`，过几秒再搜。

### 写进来的记忆不对

- 太宽松：提高 `extractConfidence`（如 0.7）。
- 重复多：降低 `dedupeThreshold`（如 0.5）。
- 单条错了：直接编辑 `digest\` 里的 `.md`，然后重建索引。

> 记忆库被污染后召回质量会下降。一期只做"相似即跳过"，不合并更新。

### 想省 token

- 用 `extractModel` 指定更便宜的模型。
- 调大 `extractEveryTurns` / `extractMinChars`。
- `autoExtract: false` 或 `autoRecall: false`。

### ReMe 没开

功能静默消失，对话不受影响；启动 ReMe 即恢复。

## 6. 维护

编辑记忆后必须重建索引：

```powershell
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:2333/reindex' `
  -ContentType 'application/json' -Body '{"scope":"bm25"}'
```

改配置：

| 改哪里 | 生效方式 |
|---|---|
| profile 的 `cordis.patch.yml`（`id: reme`） | 立即生效（HMR） |
| 插件自带的 `cordis.patch.yml` | 需要一次重新组合，或重启 |

## 7. 已知限制

- 没有向量检索：同义改写、跨语言可能匹配不上。
- 最终一致：写入后不是立刻可搜。
- 一期不合并：相似候选直接跳过；写错的条目不会自动修正。
- 抽取质量取决于模型，靠置信度、去重、限流兜底。
- 不替代上下文压缩，只补跨会话的关键事实。

## 8. 排查顺序

1. `rules:` 对不对？阈值没生效是首要嫌疑。
2. `feed` 有没有数？`inboxClaimed` 为 0 说明输入没到。
3. `skipped` 是什么原因？按表处理。
4. 沉淀侧：`runs=0` 看触发；`written=0` 看 `skipped`；`parse` 失败看 `lastReply`。
