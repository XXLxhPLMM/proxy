# src/utils/logger — 日志端口与实现

跨目录只引 `@/utils/logger/index.js`；层内相对引用，**禁止自引 barrel**（目录内部不得出现 `@/utils/logger/index.js`）。

## 职责表

| 文件          | 只负责                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `port.ts`     | 契约层：`Logger` 最小可注入端口、`LogFields`、透传 `LogLevel`、等级权重 `ORDER`（**两实现共用**）与终端色码 `COLOR`（**仅 `impl.ts` 消费**——`console.ts` 不着色，只 import `ORDER`） |
| `sanitize.ts` | 文本净化与参数拆分：`sanitizeLogText`/`renderErrorText`/`isPlainObject`/`splitFields`/`renderFieldValue`/`renderFields`/`stringifyValue` |
| `jsonl.ts`    | 落盘子系统：`toHourlyFile`、模块级在途集合、`persistLine`、`flushPendingWrites`（**barrel 不导出**，只被 `impl.ts` 用） |
| `impl.ts`     | `LoggerImpl` + `createLogger` + `LoggerOptions`：唯一「双通道」实现，只做编排                                       |
| `console.ts`  | `createConsoleLogger`：只按显式 level 门控的轻量实现（库模式给第三方用）                                           |
| `noop.ts`     | `createNoopLogger`：库 runtime 默认，零副作用                                                                       |

## 构造与类型

- **`Logger` 是类型，`LoggerImpl` 是值。** 历史上还有 `export const Logger = LoggerImpl` 这个类构造别名，**已删除**（破坏性变更，不留兼容层）：值位置一律 `new LoggerImpl({...})`，类型位置写 `Logger`。护栏见 `tests/unit/logger.test.ts`（断言 barrel 不导出 `Logger` 值）。
- `Logger` 是最小端口：`debug/info/warn/error` + 可选 `flush`。除本目录与 CLI 组合层外，core/config/runtime/server 都**只使用当前实例显式注入**的 logger，不读全局 logger。

## 双通道门控

- console 与文件是**两道独立门限**：`impl.ts` 的 `level()`/`fileLevel()` 各自现读（`resolveLevel`/`resolveFileLevel`）。
- 显式 `setLevel`/`setFileLevel`（记在 `forcedLevel`/`forcedFileLevel`）**优先于** config 现读值。
- **`createLogger` 省略 `config` 时用固定默认**：console=`error`、file=`info`、**无 logFile 因而不落盘**；不读 env/store。`createLogger({ config })` 是 CLI 的正式入口，`LoggerOptions.config` 绑定一个 `ConfigAccessor`，每次输出现读 `logLevel`/`logFileLevel`/`logFile`。
- 绕过常规门限的通道：`raw()`（banner，原样输出）、`file()`（只落盘）、`both()`（双通道）、`notice()`（生命周期/配置通知，**绕控制台等级**但 `silent` 仍硬关闭；落盘仍按 fileLevel）、`infoSync()`（**同步写 stdout、受控制台等级门控、无落盘通道**，专供启动期配置快照在退出前可见）。file/both/notice 共用同一 JSONL schema、保留键、净化与小时轮转。

## 永不抛的不变量

`logger.*` 的任何调用都不许抛。三层兜底：`persistLine` 内部吞掉 mkdir/append/时间/路径全部异常；`plain()` 的 `JSON.stringify` 抛错被外层 try/catch 吞掉；console 与文件两通道**分别**隔离，一个通道故障不拖累另一个。序列化对循环引用/BigInt/Symbol 都有回退。

## flush 必须等齐所有实例

在途落盘集合是**模块级**而非实例级（`jsonl.ts:pendingWrites`）：`child()` 派生的子 logger 各自持有自己的 `fileBase`，若按实例登记，父 logger 的 `flush()` 会漏掉子 logger 的写入。

`process.exit` 会截断在途 `appendFile`——**显式退出路径必须先 `await logger.flush()`**（`ProxyServer.stop()`/CLI 致命路径/cluster master 收尾都这么做）；正常事件循环退出则无需调用。

## 落盘格式

- 小时轮转：`log/YYYY-MM-DD-HH.jsonl`（`toHourlyFile`；`base` 是目录就 join，是带文件名的路径就取 dirname 后换名）。
- 权限：目录 `0o700`、文件 `0o600`。理由写在代码注释里——日志含审计行（鉴权失败、转发目标），不对其他用户开放。
- **保留键恰好 5 个**：`ts`/`level`/`pid`/`prefix`/`msg`，合并顺序即优先级，调用方不能覆盖。
- console 文本格式：`<ISO> <LEVEL> <prefix> <msg> k=v`。

## 结构化字段

- 只识别**最后一个** plain object 参数作为 fields（前面的 plain object 仍按普通参数进 msg）。
- `isPlainObject` 的判据是两条：先 `Array.isArray` 显式排除数组，再要求 `Object.getPrototypeOf(v)` 等于 `Object.prototype` 或 `null`——所以 `Error`/`Buffer`/`Date`/`Map`/类实例都被拒（数组不是靠原型被拒的）。`Error` 另有专门分支走 `renderErrorText`。
- 文件通道把 fields 合并到记录顶层，console 渲染 `k=v`。
- 查询示例：`jq -r 'select(.user=="alice") | .msg, .target' log/*.jsonl`。

## 渲染只允许一份实现

历史上存在逐行同构的 `renderPortableFields`/`LoggerImpl.renderFields`、`formatPortableArgs`/`LoggerImpl.stringify` 两份副本，已合并为 `sanitize.ts` 的两个唯一入口：

- **`renderFields`**：控制台双通道共用（`impl.fmt` 与 `console.ts` 都调）。
- **`stringifyValue`**：落盘通道 `plain()` 与 `console.ts` 用；**`impl.fmt` 刻意不用**（非字符串参数原样透传）。

`impl.fmt`（配置绑定的完整实现）与 `console.ts`（轻量实现）共有 4 处差异，其中**只有 Error 处理是刻意保留的**：

1. `impl.fmt` 着色 + 带 `prefix`；`console.ts` 无色无 prefix。
2. `impl.fmt` 把参数 spread 给 `console.*`（保留 console 对对象的检视能力）；`console.ts` 全部 join 成一行。
3. `console.ts` 的 warn/error 走 stderr；`impl` 走 `console.warn/error`。
4. `impl.fmt` **不**把 Error 转单行，Error 原样交给 `console.*` 以保留原生堆栈可读性；`console.ts` 经 `stringifyValue` 压成单行。

## 不属本目录的东西

- **事件码**（`[ip-denied]`/`[target-denied]`/`[tls-client-error]` 等）：词汇表在 `@/core/log-events.js`，落盘 switch 在 `src/server/index.ts:bindProxyEventLogs`。`logger/` 只负责把给定文本写出去，不拥有事件码词汇。
- **启动配置快照打印**：`src/server/log/config-log.ts`。
- **热加载事件的 logger 来源**：`readJsonCached` 本身零日志（见 `../json-file/AGENTS.md`）；runtime 显式造 `createJsonFileEventHandler(runtime.logger)` 回调注入，`config/files/event-log.ts` 只接受 logger 参数。
