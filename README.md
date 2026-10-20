# dsh-reme

ReMe 长期记忆插件，用于 **DeepSeek Harness (dsh)**。

它把 ReMe 的 HTTP 接口封装成模型可见的工具，并在对话过程中自动召回、自动沉淀记忆：

| 工具 / 行为 | 作用 |
|---|---|
| `reme_search` | 混合检索 ReMe 工作区记忆，逐字返回命中片段 |
| `reme_write` | 把一条 Markdown 记忆写入 `digest/`，并请求重建索引 |
| 自动召回 | 每次装配提示词时，用当前输入检索并注入相关片段 |
| 自动沉淀 | 每若干轮把对话中持久的事实抽成笔记写入 ReMe |
| `reme_memory_status` | 只读诊断（本仓库的 bundle 默认开启） |

> 召回内容是**引用的文件数据**，不是指令；插件在工具描述和注入框架里都明确要求模型不要执行其中的指示。

## 安装

前置：ReMe 已在本机运行（默认 `http://127.0.0.1:2333`），DSH 使用 `desktop` 或其它 profile。

1. 在 profile 的 `package.json` 里加依赖和 bundle：

```jsonc
{
  "dependencies": {
    "dsh-reme": "link:<仓库绝对路径>"   // 指向本仓库
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-reme"
      ]
    }
  }
}
```

2. 在 profile 目录安装一次（使用 DSH 自带的 node/pnpm）：

```powershell
$deps = '<DSH 安装目录>\resources\runtime\primary-runtime\dependencies'
& "$deps\node\bin\node.exe" "$deps\pnpm\bin\pnpm.mjs" install --no-frozen-lockfile
```

3. 修改 `dsh.profile.bundles` 后，支持 HMR 的 profile 会立即重新组合；没有 HMR 时重启 DSH。
   工具出现后可用 `reme_memory_status` 确认挂载。

桌面版的包操作由桌面外壳管理；上面的手动方式适合本地开发和本机使用。

### 可选：改代码后自动热重载

在 profile 的 `cordis.patch.yml` 加：

```yaml
- id: hmr
  name: "@deepseek-ai/dsh-hmr"
  config:
    root:
      - node_modules/dsh-reme/dist
    ignored:
      - cache
      - data
```

之后 `pnpm build` 会触发插件重载，不需要重启 DSH。

## 配置

所有字段都有默认值，空配置也能挂载。完整字段和默认值见 [cordis.patch.yml](cordis.patch.yml)；也可以用环境变量覆盖。

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:2333` | ReMe 地址，结尾的 `/api` 会被折叠 |
| `searchPath` / `writePath` / `reindexPath` | `/search` / `/write` / `/reindex` | 路由；404 时会自动换一种拼写重试一次 |
| `defaultDigestDir` | `digest` | 只给标题时记忆落盘的目录 |
| `reindexAfterWrite` | `true` | 写入后请求重建索引 |
| `reindexScope` | `bm25` | 重建范围：`all` / `bm25` / `embedding` / `tag` |
| `requestTimeoutMs` | `30000` | 单次请求超时 |
| `autoRecall` | `true` | 是否自动召回 |
| `recallTimeoutMs` | `400` | 召回检索硬超时（在提示词装配路径上） |
| `autoExtract` | `true` | 是否自动沉淀 |
| `extractEveryTurns` | `4` | 每 N 个用户回合触发一次抽取 |
| `extractConfidence` | `0.6` | 候选置信度门槛 |
| `extractMaxTokens` | `4000` | 抽取输出预算（推理与 JSON 共享） |
| `extractModel` | 跟随会话 | 抽取用的模型，可指定更便宜的 |
| `debugStatusTool` | `false`（本 bundle 为 `true`） | 是否注册 `reme_memory_status` |

环境变量：`REME_BASE_URL`、`REME_SEARCH_PATH`、`REME_WRITE_PATH`、`REME_REINDEX_PATH`、
`REME_DIGEST_DIR`、`REME_REINDEX_AFTER_WRITE`、`REME_REINDEX_SCOPE`、`REME_REQUEST_TIMEOUT_MS`、
`REME_AUTO_RECALL`、`REME_RECALL_TIMEOUT_MS`、`REME_AUTO_EXTRACT`、`REME_EXTRACT_EVERY_TURNS`、
`REME_EXTRACT_MODEL`、`REME_DEBUG_STATUS_TOOL`。

## 工具

### `reme_search`

```jsonc
{
  "query": "用户偏好的提交信息风格",   // 必填，自然语言整句效果最好
  "limit": 8,                         // 可选，1..50
  "min_score": 0.5,                   // 可选
  "start_date": "2026-09-01",         // 可选，YYYY-MM-DD
  "end_date": "2026-10-01"            // 可选
}
```

返回 `{ query, count, results[], notes[] }`，每条结果带 `rank / path / lines / score / text / truncated`。

### `reme_write`

```jsonc
{
  "name": "ReMe DSH 插件契约",         // 必填
  "content": "# ...",                  // 必填，Markdown 正文
  "description": "一句话摘要",          // 可选
  "path": "digest/20261001-topic.md",  // 可选；不带目录时落到 defaultDigestDir
  "metadata": { "memory_tags": ["dsh"] }, // 可选
  "reindex": true                      // 可选，默认跟随配置
}
```

`path` 规则：带目录按原样；只有文件名则落到 `defaultDigestDir`；不传则生成
`digest/<YYYYMMDD>-<slug>.md`。

## 自动记忆

- **召回**：在 `system-prompt/assemble` 里按 agent 作用域注册，用最新用户输入检索；有硬超时，
  失败或无命中就静默跳过，不影响对话。
- **沉淀**：从耐久会话事件缓冲 user/assistant 转录，在 `agent/turn-stopping` 触发（每 N 轮 /
  字符阈值 / 空闲）；失败一律向"少写"倾斜：置信度过滤、本地相似度去重、凭据过滤、每小时限流、
  去重失败熔断。
- **诊断**：`reme_memory_status` 报告召回与沉淀两半的计数、跳过原因、失败原因和最后写入路径。
  用法和排查看 [使用说明](docs/USAGE.md)。

### 已知限制

- ReMe 没配 embedding 时检索是**关键词 + BM25**，同义改写可能匹配不上。
- 写入后要等 ReMe 的后台 watcher 收进索引（约 5–10 秒），不保证"写完立刻可搜"。
- 自动沉淀可能误收噪声；相似条目只跳过、不合并，记忆库被污染后召回质量会下降。
- 本轮写入的记忆不保证下一轮立刻可检索（最终一致）。

## 开发

```powershell
pnpm install
pnpm build       # tsc -> dist/
pnpm typecheck
pnpm test        # 80 条自测
```

源码结构：

| 文件 | 作用 |
|---|---|
| `src/index.ts` | 插件入口：`name` / `inject` / `apply` |
| `src/config.ts` | 配置、默认值、校验 |
| `src/client.ts` | ReMe HTTP 传输与响应归一化 |
| `src/tools.ts` | 两个工具的定义与执行 |
| `src/auto.ts` | 自动召回 |
| `src/extract.ts` | 自动沉淀 |
| `src/status.ts` | 只读诊断工具 |
| `src/harness.ts` | dsh 工具契约与本地 `defineTool` |

## License

MIT
