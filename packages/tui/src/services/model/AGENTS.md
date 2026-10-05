# src/services/model/ — 模型 provider 那一侧的拨号点（**不是**控制面那一侧）

这一目录回答「用户自己配的那个 provider 要怎么问」：一句对话 + 一个模型 + 一档推理强度 → 一次出网 → 一段文本。
⚠️ **它与 `manager-client.ts` 是两个拨号点，且不许合并** —— 理由见 `packages/tui/AGENTS.md`「模型」一节。

## 形状分派（一种 API 格式一个模块）

| 模块 | 请求 | 凭据放哪 | 系统提示归位 | 推理强度参数 | 清单端点与 id |
| --- | --- | --- | --- | --- | --- |
| `openai.ts` | `POST {base}/chat/completions` | `Authorization: Bearer` | `messages[0]`（原样） | `reasoning_effort` | `GET {base}/models` ⇒ `data[].id` |
| `anthropic.ts` | `POST {base}/v1/messages` | `x-api-key` + `anthropic-version` | **顶层 `system`**（从数组里拆出来） | `thinking.budget_tokens` | `GET {base}/v1/models` ⇒ `data[].id` |
| `gemini.ts` | `POST {base}/models/{model}:generateContent` | `x-goog-api-key` | **`systemInstruction`** | `generationConfig.thinkingConfig.thinkingBudget` | `GET {base}/models` ⇒ `models[].name`（**剥 `models/` 前缀**） |

- ⚠️ **系统提示的位置三家各不相同**：留在 `messages[0]` 只有 OpenAI 认；Anthropic 认顶层 `system`
  （留在数组里会被当成一条用户消息），而 Gemini 认 `systemInstruction`。
  故**每个方言各自拆**（`anthropic.ts:splitSystem` / `gemini.ts:splitSystem`），**不许共用一份归位**。
- ⚠️ **Gemini 的角色名是 `model` 而不是 `assistant`**，而本包的 `ChatMessage` 用后者 —— 转换只发生在那一处。
- ⚠️ **`off` 那一档是「那个字段整个不发」**，不是「发一个关的取值」：三家都没有关的取值，
  而多余的键会被对面当成非法请求。**逐档对齐 `ReasoningEffort` 的 `Record` 加一档就编译期红**
  （忘了给预算的那一档会静默降级成「没开推理」，而屏上完全看不出来）。
- ⚠️ **Gemini 的清单 id 带资源名前缀**（`models/gemini-x`）而下游拼的是裸 id ⇒ 必须剥（`gemini.ts:NAME_PREFIX`）。
- ⚠️ **凭据只往 provider 去，且只进请求头**：Anthropic 要版本头（它按版本发版），Gemini 的 `x-goog-api-key`
  **刻意不用 `?key=` 查询串** —— URL 会被对面与沿途每一跳的访问日志原样记下。

## 层不变量

- ⚠️ **`ManagerClient` 与 `ENDPOINTS` 一步都不许出现在这个目录的代码里**（注释里提到是在讲纪律，不算）：
  前者会把控制面的 `token` 装进请求头，后者是控制面端点契约的唯一来源，而模型该能打的地址
  **恒等于** `COMMAND_SPECS` 里的那些命令。牙齿：`tests/agent/model-view.test.ts` 不变量 ①（源码级）。
- ⚠️ **`transport.ts` 是这个目录唯一取 `fetch` 的地方**（`DialectInput.fetchImpl` 是**唯一**的注入点，
  缺省真 `fetch`）：替身只可能注入到拨号那一步，而这一条对三个方言是共用的。
- ⚠️ **失败文案绝不转述响应体**：只说「哪个 HTTP 状态」「形状不对在哪一格」，而响应体可能回显请求里的用户输入。
- ⚠️ **URL 与 `apiKey` 都不许进任何失败文案**（URL 里可能有用户敲的地址）。
- ⚠️ **超时由调用方给**（`AbortSignal.timeout`），本目录不读时钟 —— 故「模型慢」与「控制面慢」是两个数。
- ⚠️ **`HISTORY_LIMIT` 与桶的 `LOG_KEEP` 是一对耦合的数**（见 `../AGENTS.md`）：改 `LOG_KEEP` 不要顺手调它。

## 相关

`../AGENTS.md`（两个拨号点为什么不许合并）· `@/services/config/index.js`（`ModelApiFormat` / `ReasoningEffort`
的**规范定义**，本目录只 type-only 引它）· `@/commands/index.js`（工具表与 `parseLine`）·
`@/lib/log/index.js`（`Turn`）· `tests/agent/`（不变量 ①–④）· `tests/model-dialects/`（三种形状逐字段）