# tests/model-dialects/ — 三种请求形状**逐字段**的判据（假 fetch，零网络）

这个目录回答「provider 那一次出网**发出去的东西**对不对」：`@/services/model/` 那一圈按 `api` 分派到三份
形状各不相同的请求，而**这三份不许合并**（系统提示的位置、凭据头的名字、推理强度的参数名、清单端点与 id
抽取，四样全都不同）。

## 用假 fetch 而不是真 `http.Server`

要验的是**请求**：URL、头、体里 system 的位置、`off` 档那个字段出不出现。起一台真 server 的话，
那一层要验的东西（真实的重定向、真实的 header 归一、真实的 HTTP/2 帧）本目录一条都不关心，
却要多付一份端口与生命周期。故注入点是 `DialectInput.fetchImpl` —— ⚠️ **不走 `globalThis.fetch`**：
本包有**两个**拨号点，全局替换会把控制面那一侧一起换掉，症状是「按次数猜的那一档整个错位」。

## 判据是行为，且**负向断言都带正向对照**

- ⚠️ 每一条负向断言（`off` 档那个字段不出现 / system 不在 `messages` 里 / 凭据不在 URL 里 /
  清单 id 被剥了前缀）**同一个 `it` 里都有一个真能过的输入做对照**。原因很直白：「什么都不做」
  同样满足它们 —— 一个从不发请求的实现会在这四条上全绿。
- ⚠️ **判据用 `in` 而不是取值**（`"reasoning_effort" in body`）：发一个空串那一版也要红。
- ⚠️ **「逐档不同」断的是 `new Set(seen).size`**，不是某一档的具体值 —— 具体值是保守缺省，
  改它是正当演进，而「三档一个值」是**缺陷**（强度档会退化成装饰，而屏上分不出那四档）。
- ⚠️ **剥前缀那一条自带正向对照**：先断「对面给的原始那一段确实带 `models/`」，
  否则「本来就没有前缀可剥」也会让它绿。
- ⚠️ **失败文案那几档的探针**：响应体里放 `CANARY-RESPONSE-BODY`，请求里用 `USER_TEXT` 与 `API_KEY`
  两个探针，而文案**三个都不许带**。响应体可能回显请求里的用户输入，故「不转述响应体」不是洁癖。
- ⚠️ **四类失败跑「格式 × 类别」的每一格**，不抽样：收窄那几层是三家共用的，
  而「形状不对在哪一格」是各家自己的，只测一家的话另两家的路径写错了照样绿。

## 档位地图

| 档 | 答什么 |
| --- | --- |
| `openai.test.ts` | `/chat/completions` + `Authorization: Bearer` · system 留在 `messages[0]` · `reasoning_effort` · `GET /models` ⇒ `data[].id` |
| `anthropic.test.ts` | `/v1/messages` + `x-api-key` + 版本头 · **system 拆到顶层** · `max_tokens` 必填 · `thinking.budget_tokens` · `GET /v1/models` |
| `gemini.test.ts` | `:generateContent` + `x-goog-api-key`（**不用 `?key=`**）· **`systemInstruction`** · **角色名 `model`** · `thinkingBudget` · 清单 id **剥 `models/`** |
| `failures.test.ts` | 四类失败（连不上 / 非 2xx / 不是 JSON / 形状不对）× 三种格式 + **文案不带 URL** |
| `_shared.ts` | 假 fetch（记账 + 三种响应包装）、`inputFor`、两个探针常量。⚠️ **不带 `.test.ts` 后缀的不会被 vitest 收集** |

## 相关

`src/services/model/AGENTS.md`（被测模块的不变量与那张形状对照表）· `tests/agent/model-view.test.ts`
（不变量 ①：模型那一侧源码里没有 client / 端点表）· `tests/agent/reply.test.ts`（模型回的那一行怎么变成一条命令）