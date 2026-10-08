# AI Input/Output System

> 一个 VS Code 扩展：**所有 AI 请求都先经过本地 Ollama 模型**，由本地模型自主
> 判断能否胜任——简单请求直接回答，复杂请求主动输出求助标记，由云端专家只回答
> 本地拆解出的子问题，最后仍由本地整合成最终回复。全程展示省下的云端调用量。

## 为什么

每个 AI 问题（"格式化这段代码"、"加个注释"、"重命名变量"）都打到云端，既慢又
花钱。本地模型（如 Qwen3 4B，64K 上下文）完全能在本机处理大多数请求。本扩展
让本地模型站在你 AI 工作流的最前面：它自己决定什么时候需要专家，而不是靠外部
规则替它做选择。

## 工作原理 —— 本地先行，专家按需介入

```
prompt ──▶ 本地 Ollama（附升级协议提示词）
                │
      ┌─────────┴──────────┐
   直接回答            输出 [ESCALATE] + 子问题
      │                        │
      │                        ▼
      │              云端专家只回答子问题
      │                        │
      │                        ▼
      │              本地整合子问题答案，产出最终回复
      │                        │
      └────────────┬───────────┘
                   ▼
        ledger.record(route, tokens)
                   │
         状态栏 + 仪表盘
```

三种实际去向（`RouteKind`）：

| 路由 | 含义 |
| --- | --- |
| `local` | 本地模型直接回答，云端零参与 |
| `escalated` | 本地模型求助：云端只回答本地拆出的子问题，本地整合 |
| `cloud` | 本地服务不可用或出错时，整个请求降级直连云端兜底 |

关键点：

1. **本地模型自判**——升级协议通过 system 提示词注入：复杂任务（大型重构、
   架构、跨文件改动、疑难调试）时不要瞎猜，输出一行 `[ESCALATE]` 加一个让
   远程专家能用最小上下文回答的聚焦子问题。
2. **云端只答子问题**——专家收到的是本地模型拆解后的聚焦问题，不是原始完整
   请求，token 消耗最小化。
3. **本地整合**——子问题答案回传后，本地模型结合它对原始请求的理解给出最终
   回复。
4. **永远有答案**——本地服务挂掉时自动降级到云端，不会丢回答。

统计特征（复杂度评分、意图关键词等）仍由 `requestClassifier` 计算，但只用于
报表分析，不再决定流量去向——决定权在本地模型手里。

详情：[`docs/routing.md`](docs/routing.md) · [`docs/architecture.md`](docs/architecture.md) · [`docs/model.md`](docs/model.md) · [`docs/agent.md`](docs/agent.md)。

## 功能（v0.4）

- **侧边栏 AI 助手**——在活动栏打开 `AI I/O` 视图直接对话。每条回复显示路由
  徽章（`local` / `local+专家`（含子问题摘要）/ `cloud`）、复杂度、耗时与模型，
  可插入光标处、替换选区或复制。快速动作（解释选区 / 加注释 / 重构选区）走
  同一条管线。
- **编辑器右键动作**——选中代码后执行 *AI I/O: 解释选区 / 给选区加注释 /
  重构选区*。
- **首次运行引导**——云端端点不可达时提供配置向导（`AI I/O: Configure Cloud`）：
  可选 Ollama、OpenAI 或任意 OpenAI 兼容地址，并列出端点提供的模型。
- **无需 API Key**——本地 OpenAI 兼容端点（`http://localhost:11434/v1` 的
  Ollama、llama.cpp、LM Studio）完全不需要密钥。
- **交互式仪表盘**——测试云端/本地连通性、重新配置、打开设置、清空统计。
- **自动 Ollama 检测**——配置的本地端点不可达且 Ollama 正在运行时，自动改写
  `localServerUrl` 为 Ollama 端口；未安装时引导一键启动/下载。

## 安装

### 从 VSIX

```bash
npm install
npm run package          # 生成 ai-input-output-system-0.4.0.vsix
code --install-extension ai-input-output-system-0.4.0.vsix
```

### 从源码（开发调试）

```bash
npm install
npm run compile
# 在 VS Code 中按 F5 启动 Extension Development Host
```

本地模型**不随扩展打包**。需要先安装 Ollama（`https://ollama.com/download`）
或手动启动 llama-server：

```bash
node scripts/download-model.mjs --url <mirror-url> --sha256 <hex>
llama-server -m models/Qwen3-4B-Instruct-Q8_0.gguf --ctx-size 65536 -ngl 99
```

## 配置

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `aiio.cloudBaseUrl` | string | `https://api.openai.com/v1` | 云端请求使用的 OpenAI 兼容 base URL。 |
| `aiio.cloudApiKey` | string | `""` | 云端端点的 API key。 |
| `aiio.cloudModel` | string | `gpt-4o-mini` | 云端使用的模型名。 |
| `aiio.localServerUrl` | string | `http://127.0.0.1:8080` | 本地服务地址（Ollama 通常为 `http://127.0.0.1:11434`）。 |
| `aiio.localModelPath` | string | `""` | 本地 GGUF 模型绝对路径；留空表示 `<workspace>/models`。 |
| `aiio.escalationEnabled` | boolean | `true` | 允许本地模型向云端专家求助（`[ESCALATE]` 协议）；关闭后本地答不好也不再升级。 |
| `aiio.enableLocalRouting` | boolean | `true` | 总开关；`false` 时所有请求直接走云端。 |
| `aiio.collectRoutingFeedback` | boolean | `true` | 本地回答后请求反馈，用于决策质量统计。 |
| `aiio.localHealthAware` | boolean | `true` | 让本地服务可用性 / 延迟参与降级判断。 |
| `aiio.classifierWeights` | object | `{}` | 高级：覆盖分类器系数（仅影响统计特征）。 |
| `aiio.autonomousOnStartup` | boolean | `false` | 激活时根据 `aiio.autonomousRequirement` 自动创建文件。 |
| `aiio.autonomousRequirement` | string | `""` | 启动创建用的自然语言需求；留空禁用。 |
| `aiio.targetSubdirectory` | string | `aiio-generated` | 生成文件落盘的工作区相对目录。 |

## 命令

| 命令 | ID | 作用 |
| --- | --- | --- |
| AI I/O: Route Prompt | `aiio.routePrompt` | 输入提示词，经本地模型（必要时升级专家）返回答案。 |
| AI I/O: Show Savings Dashboard | `aiio.showDashboard` | 打开节省仪表盘（状态栏也可点击）。 |
| AI I/O: Manage Local Model | `aiio.manageModel` | 查看 / 下载 / 启动 / 停止本地模型。 |
| AI I/O: Create Files From Requirement | `aiio.createFromRequirement` | 把自然语言需求变成工作区里的文件。 |

## 节省量怎么算

每个请求往账本追加一条记录：

```ts
{ timestamp: number, route: 'local' | 'escalated' | 'cloud', estimatedTokens: number }
```

统计口径：

| 指标 | 公式 |
| --- | --- |
| `savingsRatio()` | `local 请求数 ÷ 总请求数`（仅完全未触云的请求） |
| `tokenSavingsRatio()` | `local tokens ÷ 总 tokens` |
| `estimatedCloudCostAvoidedUsd` | `localTokens ÷ 1000 × 0.002`（单价可配） |

`escalated` 请求按实际云端参与计入云端流量；本地失败降级（`cloud`）同样按
实际路由记录，虚高的节省不会被记进去。token 数为估算值：中日韩字符按 1 个
token 计，其余约 4 字符 1 token。

## 自主文件创建

用自然语言描述需求，扩展自己写文件。规划依次尝试三个来源——**本地模型 →
云端模型 → 离线启发式**——然后把结果写入
`<workspace>/<aiio.targetSubdirectory>`。离线启发式是真实兜底：从需求推断
文件名并嵌入类型合适的骨架，即使没有本地服务和云端 key 也一定产出文件。
完整流程见 [`docs/agent.md`](docs/agent.md)。

## 开发

```bash
npm install        # 安装开发依赖
npm run compile    # esbuild 打包 -> dist/extension.js
npm run watch      # 变更时重新打包
npm run typecheck  # tsc --noEmit
npm run lint       # eslint src
npm test           # vitest run
npm run package    # 通过 @vscode/vsce 构建 .vsix
```

代码评审强制执行的架构规则：每个源文件**不超过 600 行**，文件名**语义化**
（禁止 `utils.ts` / `common.ts` / `helpers.ts`），依赖方向单向
（`ui → routing/metrics → local/cloud`），领域层不 import `vscode`。

## License

[MIT](LICENSE) © AI Input/Output System contributors
