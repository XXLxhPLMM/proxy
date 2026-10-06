# tests/unit/utils/logger/

本目录只答一件事：**logger 的分级与渲染** —— 哪些参数算结构化字段、两条通道各自怎么落、
不可序列化的输入怎么变可读、以及端口为什么没有全局状态。
四档分工：`levels` 管双通道分级矩阵与继承/覆写，`serialization` 管转义、单行与落盘键集，
`fields` 管结构化字段的识别与两条渲染管线，`accessor-port` 管可注入端口与显式配置绑定。

## 锁什么（每条括号里是牙齿所在的档）

① ⚠️ **`level`（控制台）与 `fileLevel`（落盘）是两个互相独立的门控**，各自一整套档位。
   `child` 继承父级的双通道等级、`setLevel` / `setFileLevel` 运行时分别覆写（`levels` 四格正反咬住：
   「控制台 error + 落盘 debug」与「控制台 debug + 落盘 silent」互为镜像）。
② ⚠️ **`file` / `both` / `notice` 三个方法各有一套门控语义**，别把它们当 `info` 的别名：
   `file()` 只入盘且**不受 `fileLevel` 门控**；`both()` 不受**双门控**（门控内的 `info` 静默而它照常输出并落盘）；
   `notice()` 控制台必达（`silent` 才是硬关闭）但落盘**按 `fileLevel` 门控**（`serialization` 三格）。
③ ⚠️ **落盘键集唯一**：四条通道（`info` / `file` / `both` / `notice`）走同一条 plain 管线，
   落盘键集**逐字相同** = fields 合并 + 五个保留键 `ts` / `level` / `pid` / `prefix` / `msg`，
   而**保留键优先**（同名字段被覆盖，`keep` 那类自定义字段原样留下）。牙齿两半：
   `serialization` 的「键集完全一致」（`new Set(keySets).size === 1` + 逐字列出那六个键）
   与 `fields` 的「保留键优先」—— 只钉其中一半的话，给 `both` 单独拼一份记录的实现照样全绿。
④ ⚠️ **不可序列化的参数不许抛，且要变可读**：循环引用 / `BigInt` / `Symbol` / 函数，两条通道都不许抛；
   `Error` 渲染成 `name` / `message` / `code` 的文本而**不是 `{}`**（旧行为 `JSON.stringify(Error)`
   只剩 `{}`，502 成因就丢了）。牙齿：`levels` 四格（落盘 + 控制台）与 `fields` 的「控制台字段中的 Error」。
⑤ ⚠️ **单条日志恒为单行**：控制字符（`\r\n` / ESC）必须转义成**可见文本**而不是漏成真换行 ——
   漏出去就等于允许在日志文件里伪造一条 `INFO` 行。牙齿：`serialization` 的「控制字符转义」
   与 `levels` 的「Error 参数…单行」（stack 首帧的换行）。
   ⇒ 落盘断言一律 `await vi.waitFor(...)` 或 `await log.flush()`：`appendFile` 是异步的，不等就是竞态；
   而「`flush` 等齐在途落盘」那一格正是**不轮询**也能断言的那条（它还顺带钉住「模块级在途集合覆盖 child 实例」）。
⑥ ⚠️ **端口没有全局状态**：可注入的最小 `Logger` 端口（四个方法 + `flush`）、`createLogger()` /
   `createNoopLogger()` / `createConsoleLogger()` 三个工厂、显式注入 accessor 后**热改无需重建**、
   以及**不再导出历史类构造别名 `Logger`**（破坏性变更，不留兼容层）—— 这 8 格合起来才是那条论断
   （`accessor-port`）。

## 落盘基址无扩展名 ⇒ 目录内按小时切片

`file` 给一个**无扩展名的目录**时，落盘走 `YYYY-MM-DD-HH.jsonl` 的小时切片（`levels` 第一格钉住文件名形态）。
这要求每一档的落盘断言都先有自己那个 `mkdtemp` 出来的目录 —— 故四档共用 `_logger.ts` 的
`tmpDir()` + `tmpDirs` 登记簿。⚠️ **`readPersistedRaw` 读的是目录里第一个文件**，所以
「一个用例一个目录」是正确性前提而不是卫生：两个用例共用一个目录时，它读到的是上一次那条记录。

## 防假绿的位置

- ⚠️ **每一档都必须自带 `afterEach` 的 `vi.restoreAllMocks()`**：`console.info` / `console.debug` / `stdout.write`
  这几个替身在档内被反复装，`vi.spyOn` 装在已装的同一个方法上会**复用并累计**同一个 spy，
  于是后一档的 `expect(spy).not.toHaveBeenCalled()` 会因为**上一档的调用**而红 —— 那是档间串扰不是被测行为。
  拆档时把这一行漏掉，报错会指向一条完全无关的断言。
- **`tmpDirs.splice(0)` 而不是 `forEach` 删除**：回收要连登记簿一起清，否则下一次 `tmpDir()`
  拿到的是上一轮已删的路径。用完 `splice` 是「读出来即清空」的一步到位形态。
- **门控矩阵要成正反两格**：「debug 只进文件不进终端」与「debug 只进终端不落盘」缺一不可 ——
  只钉前者的话，「两个门控其实是一个」的实现照样全绿。
- **`fields` 的「非 plain object 不作为 fields」钉的是 `toHaveLength(3)` 而非字段文案**：
  判据是「那个参数原样出现在第三个实参位」，所以 `Error` / `Array` / `Date` / `Map` / `Buffer` / 类实例
  六种形态各自都不会被误吞。
- ⚠️ **零外网白名单只有 `levels` 一条**（`connect ECONNREFUSED 1.2.3.4:443` 那个 client host 占位符），
  另三档零公网字面量 ⇒ 按纪律②不建条目（建了会被判 stale）。

## 文件

- `levels.test.ts` — 双门控分级矩阵（9 格）：落盘 JSONL 形态、两组镜像门控、`child` 继承、运行时覆写、不可序列化与 `Error` 参数、控制台不抛。
- `serialization.test.ts` — 转义与落盘键集（7 格）：控制字符转义、非法落盘路径兜底、`flush` 等齐、`file` / `both` / `notice` 三个方法的门控语义、键集逐字一致。
- `fields.test.ts` — 结构化字段（8 格）：末位 plain object 识别、保留键优先、`undefined` / `null` 的不同命运、非 plain object 不吞、控制台 `k=v` 渲染与其中的 `Error`、`infoSync`。
- `accessor-port.test.ts` — 端口与配置绑定（8 格）：可注入最小端口三个工厂 + 显式 accessor 热改 + 无历史别名。
- `_logger.ts` — 四档共用的落盘沙箱（`tmpDir` / `tmpDirs` / `readPersistedRaw` / `readPersistedJson` / `parseLines`）。
- `AGENTS.md` — 本文件。

## 相关路径

- `../../../../src/utils/logger/` — 被测模块（`LoggerImpl` / `createLogger` / `createConsoleLogger` / `createNoopLogger` 与 `Logger` 端口类型）。
- `../../../../src/utils/AGENTS.md` — 「叶子层」与 logger 不得回指 `@/core/*` 那条裁决。
- `../../config/` — 显式配置绑定那一格注入的 `ConfigStore` 与 `configAccessorFromStore` 的出处。
- `../../../helpers/public-hosts/unit-utils.ts` — 本目录的零外网白名单片（**只有 `levels` 一条**）。
- `../../AGENTS.md`、`../../../AGENTS.md`、`../../../../AGENTS.md`。