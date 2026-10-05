# tests/unit/utils/json-file/

本目录只答一件事：`readJsonCached` 的**读面**（缓存 / 节流 / 坏内容 / stat 失败）与**同一份事件流的两级呈现**。
三档分工：`read` 管读面（什么算 missing、缓存与观察者隔离、相对路径绝对化）、`events` 管事件面
（四态、去重、绝不外抛、节流、大小上限）、`event-rendering` 管 `logJsonFileEvent` 把同一条事件流
映射成 `info` / `warn` 两级 + 版本字段。

## 锁什么（每条括号里是牙齿所在的档）

① ⚠️ **四态事件是这一族共用的词汇**（`read` / `events` / `event-rendering` 三份）：`missing`（存在 → 缺失，
   ACL 场景下等于「静默变全放行」）/ `error`（内容或状态读不成）/ `recovered`（恢复并采用新值）/
   `reloaded`（内容变更且校验通过）。**首次加载静默**（`read` / `events` 各一份 `toHaveLength(0)`）——
   一条好内容被读出来不是「变更」，那件事归启动摘要报一次。
② ⚠️ **去重状态按 `onEvent` 回调隔离，不是模块级共享表**：否则第二个观察者**永远收不到**自己那份观察面
   （第一个观察者已经把这条 `error` 标成「已报过」）。缓存条目可以共享，**事件去重状态不能**
   （牙齿：`read` 的「共享文件缓存不吞掉其它观察者」、`events` 的「坏文件持续期间只抛一次」）。
③ **版本字段契约**：`reloaded` / `recovered` / `error` 三态带 `mtimeMs` + `size`，而 `missing` **不带**
   （无文件可 stat）—— 于是「日志层据此区分『同版本被多进程加载』与『文件被多次修改』」这条路才走得通
   （牙齿：`events` 的两条、`event-rendering` 的逐字比对）。`pid` 恒带（`event-rendering`）。
④ ⚠️ **「读不到」不等于「没配」**：只有 `ENOENT` / `ENOTDIR` / 非普通文件算 `missing`，其它 stat 错误
   保留上一份有效值并发 `error`；没有「上一份」可保留时用 `fallback`，但**仍必须报 `error`**
   （两半都在 `read`）。⚠️ **绝不外抛**：订阅回调抛错不许影响读取（`events`）。
   ⚠️ **超过 `maxBytes` 给出 `error` 且不采用该内容**（`events`）——被截断的半份 JSON 绝不许进判定；
   调用方给的具体上限（`acl.json` / `users.json` 各自 1MiB）在数据源侧那几档，不在本目录。
⑤ **1s stat 节流是双向的**：窗口内返回缓存，越过 `maxAgeMs` 自动重读。这是「`consume` 每 chunk 调一次
   也不碰盘」那条性能论证的兑现点，牙齿用 fake timers（`events`）。**「每次都重读」会红同一条。**

## ⚠️ Windows 上「内容已变」必须让 `size` 也变

同一时间戳 tick 内的两次写入可能拿到**相同的 `mtime` + `size`**，而缓存键正是这两个字段。
于是 `events` 档每处「内容已变」都改数字位数（`n: 1` → `n: 22`）：等长内容会被「mtime/size 未变 →
复用缓存」误判，而症状是「改了却不生效」——一条比直接报错更难查的失效。

## 每档独占一个临时目录

`readJsonCached` 的缓存是**模块级**、按解析后的绝对路径 keyed 且带节流窗口。故沙箱（`dir` / `events` /
`opts` / `validateSample` / `FALLBACK`）在本目录三档之间**共享代码、不共享实例**：
`_json-file.ts` 是模块，`dir` 是导出绑定（档自己那条 `beforeAll` 赋不了值），所以唯一入口是 `useSandbox()`
—— 调一次即装好「建目录 → 每例清事件 → 收尾删目录」三个钩子，而每档各拿自己那一份。
共享代码的门槛是「两档以上真用到」；`parseLines` 那类只有一档用的东西**留在那一档里**。

## 防假绿的位置

- **`stat` 失败用 `statSync` 属性访问注入，不用 `chmod`**：本仓主战场是 Windows，那里 `chmod` 只切只读属性、
  造不出稳定的 `EACCES`。判据上「保留上一份有效值」与「有 `error` 事件」必须**一起**断 ——
  只断一条的实现（回退 fallback、或发 missing）都还红着一半。
- **「不伪装 missing」要显式钉住**：每条 stat 错误那几格都额外断言 `events.some(type === "missing")` 为假，
  否则「`missing` 与 `error` 都发」的实现照样全绿。
- **同一路径按配置类别隔离缓存那一条是交叉防线**：两个不同 `validator` 读同一个绝对路径不许串型。
- **`event-rendering` 只断言渲染，不起真 logger**（替身是 `vi.fn()`）：真 logger 会把 notice 落进仓库 `log/`。
- ⚠️ **零外网白名单本目录零条目**：三档都没有公网 host 字面量，按纪律②不建条目（建了会被判 stale）。

## 文件

- `read.test.ts` — 读面 7 格：缺失 / 目录 / `EACCES` 两半 / 观察者隔离 / 按配置类别隔离缓存 / 相对路径绝对化。
- `events.test.ts` — 事件面 10 格：四态 × 去重 × 绝不外抛 × 校验不过 × 节流 × `maxBytes`。
- `event-rendering.test.ts` — `logJsonFileEvent` 的四态呈现（`info` 两级 + `warn` 两级 + 逐字文案与字段）。
- `_json-file.ts` — `read` / `events` 两档共用的沙箱（`dir` / `events` / `opts` / `validateSample` / `FALLBACK` / `useSandbox`）。
- `AGENTS.md` — 本文件。

## 相关路径

- `../../../../src/utils/json-file/` — 被测模块（`readJsonCached` 与 `logJsonFileEvent`）。
- `../../config/auth-users/` / `../../datasource/acl/` — 调用方那两处（1MiB 上限与真实名单文件）。
- `../../../helpers/public-hosts/unit-utils.ts` — 零外网白名单片（**本目录零条目**）。
- `../../AGENTS.md`、`../../../AGENTS.md`、`../../../../AGENTS.md`。