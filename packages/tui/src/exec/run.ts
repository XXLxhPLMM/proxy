/**
 * @fileoverview 命令执行层：一条命令 → 若干输出行 + 一组「上层要应用的动作」
 * @module console/exec
 * @description
 * 本模块是命令层与控制面之间**唯一**的执行点。输入是 `@/cmd/index.js` 那张表解析出来的
 * {@link Command}（一个判别联合），输出是 {@link ./log.js:LogRow}（给人看的）与 {@link Effect}
 * （给上层应用状态用的）。两者分开之后，「一条命令做了什么」与「界面怎么反应」互不干涉 ——
 * 加一条命令不必碰界面，界面也不必知道命令是怎么落地的。
 *
 * ## ⚠️ 本层**不碰状态**：不 `setState`、不写台账、不改当前目标
 * @description
 * 它只做两件事：**发请求**与**读注入进来的东西**，然后**说**发生了什么。
 * ⚠️ 理由不是洁癖，是可测性：执行层一旦改状态，它的每一条判据都要起一个真的界面才能断言，
 * 而那会让「`changed: false` 不是失败」这种一句话的规则变成一次端到端渲染。
 * 同理，**台账的写一律走注入的回调**（{@link ExecDeps.onTargetAdd} 等三��）：台账在内存里的那一份
 * 是上层的状态，本层绕过它直接 `writeLedger` 就会造出「内存与磁盘漂移」那类 bug
 * （`src/AGENTS.md` 记着一条同物种的已知缺口，别再添一条）。
 *
 * ## ⚠️ 没有客户端时**不发请求**
 * @description
 * `client === null`（还没选中控制面）时，需要控制面的那些命令只回一句「先在左边选一个控制面」，
 * **一个请求都不发**。对着 `0.0.0.0:0` 发一次连接失败，会把「你没选控制面」显示成「那台机器
 * 连不上」—— 后者是一句**假事实**，且它会把人带去查一台根本没问题的机器。
 * ⚠️ 判据是**穷举的 `switch`**而不是一张「哪些命令要客户端」的清单：清单是可数据，加一条命令时
 * 忘了往里加一项编译期不会红，而那会让新命令默认落到「不需要客户端」那一支 —— 于是它对着
 * `0.0.0.0:0` 发请求而 `pnpm test` 全绿。两个 `switch` 各自带一条 `never` 断言，新增的 `kind`
 * 必在两处都露面。
 *
 * ## 语义规则：为什么每一条都是「不许改写」
 * @description
 * 本包面对的服务端（对面机器上那个进程）已经用**字面量**写下了若干句限定语。把它们改写、翻译
 * 或省掉，本层就成了「显示的东西不真实」的产地，而那正是本仓最恨的一类退化。逐条：
 *
 * 1. **`changed: false` 是成功**（一次成功的 no-op），不是失败也不是「没生效」。渲染成错误会让
 *    操作者以为操作没成；显示成「已改」是一个字节都没动的事实在撒谎。故只显示服务端那句
 *    `message` 加一个「没动」的状态。
 * 2. **`notice` 必须上屏**（`AUTH_TYPE=jwt` 下 `expiresAt` / `disabled` 是失效的）。漏掉它，
 *    「以为把这个账号封住了」会一直活到下一次重启。
 * 3. **`effective` 只在 `changed: true` 时显示**：服务端在该情况下给 `null`（不承诺一件没发生的
 *    事）。本层不补一句自己编的 —— 一个字节都没落盘却承诺生效，是本仓最恨的形状。
 * 4. **账本三段限定逐字上屏**（`lagMs` / `sideEffect` / `note`）。少一段就把「账本此刻记着多少」
 *    显示成「这个账号现在还能用多少」/ 让一次会物化账本文件的读取被当成纯读 / 让「本工具不能清账」
 *    这件事消失。
 * 5. **`status.runningMeans` 逐字上屏**：cluster master 是 `mode: "master"` + `running: false`，
 *    **那是正常的**。本层不替服务端判断该不该显示这一句。
 * 6. **账本只给 `dir` 不给文件名**（{@link StatusData.usage}），而 `fileOrigin` 为 `undefined` 的含义
 *    是「不在任何 env 文件里」。**不编文件名**、**不说「来自缺省」**：那是服务端没有给的结论。
 * 7. **打码是服务端的决定**：本包不重打码、也不造第二份「哪些键是秘密」的清单，只把服务端给的
 *    `secret: true` 如实渲染成 {@link MASKED}。
 * 8. **`quota` 的 `0` 字节是「不限量」**，渲染成 `∞`（{@link percent} / {@link UNLIMITED} 那一份写法）。
 * 9. **凭据不进任何一行**：`user pass` / `user set … password` / `target add` 的密码与 token 既不进
 *    回显行也不进任何失败文案（回显那一行走 {@link ./log.js:maskEcho}）。
 * 10. **失败一律变成一句人读的判据**，不是原始异常：`TuiError` 自带 `code` / `message` /
 *     `requestId`，本层只把它们排版。**非 `TuiError` 的异常一个字都不转述**（见
 *     {@link unknownFailure}）—— 那个 `message` 可能是下层顺手带出来的一串字节。
 *
 * ## 呈现决定归本层，但**只做展示**
 * @description
 * 「字节怎么写」「`0` 显示成什么」「哪一列右对齐」「表头叫什么」都是呈现决定，判据在 `@/ui`；
 * 本层只**选**（选哪些列、什么顺序）并把它们经 {@link planColumns} 排好版。
 * ⚠️ 表格一律经 `planColumns`，本层**一个字节的宽度都不自己算**：{@link ./log.ts} 那一层只认
 * 「已排好版的字符串数组」，所以这里把它的产物**拍平成字符串**再塞进 `head` / `rows`
 * —— 拍平之后表头与每行的列数仍逐字相等（`planColumns` 按同一个 `keep` 生成两者），
 * 而 `log.ts` 明确不替短行对齐。
 * ⚠️ 空集**必须出文案**：一张只有表头的表与「真的没有数据」在屏幕上长得一样。
 *
 * ## 回显为什么在含凭据的那两条上是**重建**的
 * @description
 * 无凭据的命令回显**用户敲的原文**；`user pass` / `user set … password` / `target add` 这三条
 * 回显**由命令重建**、把凭据那一格换成掩码。⚠️ 原因是在原文里做位置替换会打错位置：
 * `user pass bob bob` 里第一个 `bob` 是用户名，替换它就把用户名打了码而**密码留在屏幕上**。
 * 原文里没有「哪个位置是凭据」这件事（引号、空格、引号内空格都会让下标推不出来），
 * 而命令表里有 —— 掩码的判据必须住在有那个信息的地方。
 *
 * @module
 */

import { maskEcho, type LogRow, type LogTone } from "@/log/index.js";
import {
  ACL_LISTS,
  TuiError,
  isRetryable,
  type AclBody,
  type AccountBody,
  type AccountUpdateInput,
  type ChangeBody,
  type ConfigBody,
  type ConfigKeyBody,
  type ManagerClient,
  type StatusBody,
  type TuiCode,
  type UsageBody,
  type UsageOneBody,
  type UsersBody,
} from "@/api/index.js";
import { LedgerError } from "@/ledger/index.js";
import {
  EM_DASH,
  MASKED,
  UNLIMITED,
  bytes,
  duration,
  isoOrNull,
  onOff,
  planColumns,
  uptime,
  type CellValue,
  type ColumnSpec,
} from "@/ui/index.js";
import { COMMAND_PREFIX, COMMAND_SPECS, findSpec, type Command } from "@/cmd/index.js";

/* 本层的类型契约（一条命令 → 若干行 + 一组副作用） */
/**
 * 上层要应用的动作
 * @description
 * 执行层**只说**发生了什么，改状态是上层的事。⚠️ 这四种动作是全部：加一条命令若需要别的副作用，
 * 要么它其实是「命令的效果」不属于这四档之一（那说明它改的是结果区之外的东西，得多想一层），
 * 要么它根本不需要上层动手。
 * ⚠️ `ledger-changed` 与 `target-switched` **刻意不合并**：前者是「目标集合变了，按这份台账重读
 * 内存里那一份」（`target add` 顺带把 `selected` 移到新加的那条上，重读一并带回来），
 * 后者是「当前目标换了，重建客户端」。合成一个动作会让上层必须自己去猜「集合变了还是当前变了」。
 */
export type Effect =
  /** `clear`：清掉结果区 */
  | { readonly kind: "clear-log" }
  /** `r`：重探当前控制面 */
  | { readonly kind: "reprobe" }
  /** `target add` / `target del` 成功：目标集合变了，要重读台账 */
  | { readonly kind: "ledger-changed" }
  /** `target switch` 成功：当前目标换成了哪一个 */
  | { readonly kind: "target-switched"; readonly name: string }
  /** `new`：新开一个会话，并切过去 */
  | { readonly kind: "session-new" }
  /** `managers`：打开控制面清单窗口（选中哪一个由上层那一格高亮决定） */
  | { readonly kind: "show-managers" };

/** 一次执行的结果 */
export interface ExecResult {
  readonly rows: readonly LogRow[];
  readonly effects: readonly Effect[];
}

/**
 * `target add` 递给上层的那份输入
 * @description `timeoutMs: null` 是「没给这个形参」。⚠️ **缺省值不在这里补**：
 * `DEFAULT_TIMEOUT_MS` 与超时的区间判据都在 `@/ledger`（落盘那一层），本层补一份就成了第二处默认值。
 */
export interface TargetAddRequest {
  readonly name: string;
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs: number | null;
}

/**
 * 一次台账写的**成败**通道
 * @description 成功 = resolve（可以是同步的），失败 = 抛 {@link LedgerError}。
 * ⚠️ 刻意用**抛**而不是返回布尔：那正是 `@/ledger` 那一层自己的形状（`upsertTarget` / `setSelected`
 * 抛 `LedgerError`），返回布尔会让「抛了」与「返回了 false」两种失败同时存在，而调用方只查其中一种。
 */
export type LedgerWriteResult = void | Promise<void>;

/** 台账的写入口 */
export type LedgerWrite = () => LedgerWriteResult;

/** 执行一条命令要用的东西（全由上层给，本层不读宿主、不读台账文件） */
export interface ExecDeps {
  /**
   * 当前控制面的客户端；`null` = **还没选中控制面**
   * @description `null` 时需要控制面的命令只回一句「先在左边选一个控制面」，**一个请求都不发**。
   */
  readonly client: ManagerClient | null;
  /**
   * 结果区的内容宽度（列数）
   * @description 由组合根采一次传下来。本层**不**读 `process.stdout.columns`：那会把「宽度快照」
   * 这件事的采集面从一个地方拆成两个（`src/AGENTS.md` 的组合根纪律）。
   */
  readonly width: number;
  /** 用户敲的那一行原文（回显用；含凭据的三条命令按命令重建，见文件头） */
  readonly line: string;
  /** 加一个控制面目标（`target add`） */
  readonly onTargetAdd: (request: TargetAddRequest) => LedgerWriteResult;
  /** 删一个控制面目标（`target del`） */
  readonly onTargetDel: (name: string) => LedgerWriteResult;
  /** 切到某个控制面目标（`target switch`） */
  readonly onTargetSwitch: (name: string) => LedgerWriteResult;
}

/* 小工具（纯函数） */
/** 只有回显、没有副作用的成品 */
function plain(rows: readonly LogRow[]): ExecResult {
  return { rows, effects: [] };
}

/** 什么都没选中时的那一句（⚠️ 不许在这里发请求，见文件头） */
function noTarget(): ExecResult {
  return plain([{ kind: "err", text: NO_TARGET_TEXT }]);
}

const NO_TARGET_TEXT = "先在左边选一个控制面（这一条要访问控制面，现在没有客户端）";

/**
 * 一个**不认识**的异常
 * @description
 * ⚠️ 刻意**不**转述 `err.message`、更不转述堆栈：那个串来自本包自己的某一层，它完全可能
 * 顺手带出下层的字节（地址、名单、乃至一段凭据），而它落进的是**可滚动、可复制**的结果区。
 * 诚实的说法是「这不是控制面的回答」—— 那既是事实，也指出该去查哪一侧。
 */
function unknownFailure(): LogRow {
  return {
    kind: "err",
    text: "本包遇到一个未预期的错误（不是控制面的回答，请查本包的问题）",
  };
}

/** 失败码（{@link TuiCode}）→ 色档（呈现决定，故在本层） */
function toneOfCode(code: TuiCode): LogTone {
  if (code === "unauthorized" || code === "timeout") return "warn";
  return "danger";
}

/**
 * 一次控制面失败 → 人读的判据
 * @description
 * `TuiError` 的三个字段都是**为显示设计的**（`code` 是闭合集、`message` 是服务端的中性事实陈述、
 * `requestId` 是唯一能接上服务端日志的线索），故逐字用上。⚠️ `requestId` 缺省时**不编一个** ——
 * 5xx 少了它才是死路，而编一个 id 比没有更糟（它会让人去 grep 一条不存在的日志）。
 */
function controlFailure(err: unknown): readonly LogRow[] {
  if (!(err instanceof TuiError)) return [unknownFailure()];
  const text =
    err.requestId === null
      ? `${err.code}：${err.message}`
      : `${err.code}：${err.message}（requestId ${err.requestId}）`;
  const rows: LogRow[] = [{ kind: "err", text, tone: toneOfCode(err.code) }];
  if (isRetryable(err)) rows.push({ kind: "note", text: "可重试：按 r 再来一次" });
  return rows;
}

/**
 * 一次台账失败 → 人读的判据
 * @description
 * ⚠️ **与 {@link controlFailure} 分开是硬要求**：`LedgerError` 是「本机那份文件/输入形状不对」，
 * `TuiError` 是「对面没答上」。混用会让「台账里没这个端点」显示成「连不上控制面」，而排查方向
 * 完全相反（`@/ledger/AGENTS.md` 那条不变量）。
 */
function ledgerFailure(err: unknown): readonly LogRow[] {
  if (!(err instanceof LedgerError)) return [unknownFailure()];
  return [{ kind: "err", text: `${err.code}：${err.message}` }];
}

/** 把一次异步动作包成「要么若干行，要么一句判据」 */
async function attempt(work: () => Promise<readonly LogRow[]>): Promise<readonly LogRow[]> {
  try {
    return await work();
  } catch (err) {
    return controlFailure(err);
  }
}

/** 把一次台账动作包成「要么若干行，要么一句判据」 */
async function attemptLedger(work: () => Promise<readonly LogRow[]>): Promise<readonly LogRow[]> {
  try {
    return await work();
  } catch (err) {
    return ledgerFailure(err);
  }
}

/**
 * 一张表：把 {@link planColumns} 的产物**拍平成字符串**塞进 {@link LogRow}
 * @description
 * ⚠️ `planColumns` 的产物是「每列多宽 + 每格显示什么」，而 `./log.ts` 那一层只认「已排好版的字符串
 * 数组」（它不替短行对齐，见 `LogRow` 的 `table` 档注释）。故这里**不许自己算宽度**：
 * 拍平之后的表头与每行**逐字等长**（`planColumns` 用同一个 `keep` 生成两者），而自己按表头补空格
 * 会与 `log.ts` 那一层的裁剪各算各的宽度。
 */
function table(
  specs: readonly ColumnSpec[],
  rows: readonly (readonly CellValue[])[],
  width: number,
): LogRow {
  const plan = planColumns(specs, rows, width);
  const right: number[] = [];
  for (let i = 0; i < plan.columns.length; i += 1) {
    if (plan.columns[i]?.align === "right") right.push(i);
  }
  return {
    kind: "table",
    head: plan.columns.map((column) => column.header),
    rows: plan.rows,
    right,
  };
}

/* 回显（凭据已掩码的那一个出口） */
/**
 * 回显用户敲的那一行（凭据已掩码）
 * @description 见文件头「回显为什么在含凭据的那三条上是重建的」。
 * ⚠️ 掩码判据是「这是哪一类凭据」而不是「哪条命令」：{@link maskEcho} 的第一个形参是凭据类别，
 * 而 `user set <用户名> password <值>` 的值就在第 3 位 —— 与 `user pass` 同一位，故走同一档。
 */
function echoOf(command: Command, line: string): LogRow {
  switch (command.kind) {
    case "user-pass":
      return {
        kind: "echo",
        text: `${COMMAND_PREFIX}user pass ${command.username} ${maskEcho("user-pass", command.password)}`,
      };
    case "target-add": {
      const tail = command.timeoutMs === null ? "" : ` ${String(command.timeoutMs)}`;
      return {
        kind: "echo",
        text: `${COMMAND_PREFIX}target add ${command.name} ${command.baseUrl} ${maskEcho("target-add", command.token)}${tail}`,
      };
    }
    case "user-set":
      if (command.field === "password") {
        return {
          kind: "echo",
          text: `${COMMAND_PREFIX}user set ${command.username} password ${maskEcho("user-pass", command.value)}`,
        };
      }
      return { kind: "echo", text: line };
    default:
      return { kind: "echo", text: line };
  }
}

/**
 * `user add` 建出来的账号是**空密码**，而命令表里没有密码形参
 * @description
 * 说出来是因为「以为账号有密码」的后果是**代理认它而操作者不知道它的口令是什么**。
 * ⚠️ 这不是本层编的结论：命令表（`@/cmd/index.js` 的 `user add` 声明）只有用户名与流量上限两个
 * 形参，故这一次请求里的密码只可能是空串。
 */
const NO_PASSWORD_ARG =
  `${COMMAND_PREFIX}user add 没有密码形参，建出来的是空密码账号（要口令用 ${COMMAND_PREFIX}user pass <用户名> <新密码>）`;

/* 读面（只发请求，不改任何状态） */
/**
 * `config` 的 `value`（`unknown`）→ 一格文本
 * @description ⚠️ 本包**不许猜**服务端配置 schema 的类型（`ConfigKeyBody.value` 是 `opaque` 的理由），
 * 故对象与数组一律 {@link JSON.stringify} 铺开、其余走 `String`。
 * ⚠️ **不判类型**（而不是「那个调用处的类型」）：配置值的类型由服务端的 schema 决定，
 * 而本包**只有一处**把配置值渲染出来（本层 → `@/view/layout.tsx`），故这里就是那**唯一**的
 * 判据。⚠️ 若哪天出现第二个渲染者，**判据要跟着搬过去**，不许在这里再抄一份。
 */
function configValue(value: unknown): string {
  if (value === undefined) return EM_DASH;
  if (typeof value === "string") return value;
  if (value === null || typeof value === "object") return JSON.stringify(value) ?? EM_DASH;
  return String(value);
}

/**
 * `config` 的「来源」那一格
 * @description ⚠️ **`fileOrigin` 为 `undefined` 的含义是「不在任何 env 文件里」**，故那一格写的是
 * 这一点（或服务端自己给的 `fromEnv` / `fromArgv` 两个事实）。⚠️ 刻意**不写「来自缺省」**：
 * 服务端没有给那个结论（它可能来自宿主 env / 命令行 / 缺省，三者不可区分），而本层替它选一个
 * 就是在编。⚠️ 也**不许**在这里补一个文件名：账本的 `UsageRef` 只给 `dir`（给文件名就要造一个数据源）。
 */
function originCell(key: ConfigKeyBody): string {
  if (key.fileOrigin !== undefined) return key.fileOrigin;
  if (key.fromEnv) return "宿主env";
  if (key.fromArgv) return "CLI";
  return "不在 env 文件";
}

/** 账号的「配额」那一格（⚠️ `bytes === 0` 是**不限量**，不是除零也不是「零字节」） */
function quotaCell(account: AccountBody): string {
  const quota = account.quota;
  if (quota === undefined) return `${UNLIMITED}（未配）`;
  const size = quota.bytes === 0 ? UNLIMITED : bytes(quota.bytes);
  return quota.window === undefined ? size : `${size} / ${quota.window}`;
}

/** 账号的个人名单条数（判定在代理的 personal 层，与全局名单是两类语义） */
function personalCell(account: AccountBody): string {
  const white = account.acl?.target.whitelist.length ?? 0;
  const black = account.acl?.target.blacklist.length ?? 0;
  return `白${String(white)}/黑${String(black)}`;
}

/** 列表与详情共用的一格「到期」（服务端两种形态都给，两种都显示，不替操作者选一种） */
function expiresCell(account: AccountBody): string {
  if (account.expiresAt === undefined) return EM_DASH;
  return `${isoOrNull(account.expiresAtIso)}（${String(account.expiresAt)}）`;
}

/** `host:port`；任一为 `null` 就是「没有这个数」，**不拿 0 冒充** */
function listenCell(host: string | null, port: number | null): string {
  if (host === null || port === null) return EM_DASH;
  return `${host}:${String(port)}`;
}

/** `status` 的三个小节：进程 / 数据面 / 账本与名单 */
function statusRows(body: StatusBody): readonly LogRow[] {
  const data = body.data;
  return [
    { kind: "head", text: "进程" },
    { kind: "kv", key: "pid", value: String(body.process.pid) },
    { kind: "kv", key: "node", value: body.process.node },
    { kind: "kv", key: "平台", value: body.process.platform },
    { kind: "kv", key: "cwd", value: body.process.cwd },
    { kind: "kv", key: "进程已跑", value: uptime(body.process.uptimeMs) },
    { kind: "head", text: "数据面" },
    { kind: "kv", key: "模式", value: body.proxy.mode },
    { kind: "kv", key: "协议", value: body.proxy.protocol ?? EM_DASH },
    { kind: "kv", key: "监听", value: listenCell(body.proxy.host, body.proxy.port) },
    { kind: "kv", key: "running", value: onOff(body.proxy.running) },
    // ⚠️ cluster master 的 `uptimeMs` 是 `null`，`uptime` 给 `—`（说「这个进程不持有数据面」），
    // 而不是 `0s`（那等于宣称「它刚起来」）
    { kind: "kv", key: "数据面已跑", value: uptime(body.proxy.uptimeMs) },
    { kind: "head", text: "账本与名单" },
    { kind: "kv", key: "配置目录", value: data.configDir },
    {
      kind: "kv",
      key: "env 文件",
      value: data.envFiles.length === 0 ? EM_DASH : data.envFiles.join(" / "),
    },
    { kind: "kv", key: "账号表", value: `${data.accounts.driver}  ${data.accounts.path}` },
    { kind: "kv", key: "名单", value: `${data.acl.driver}  ${data.acl.path}` },
    // ⚠️ **只有 `dir`**：服务端刻意不给文件名（给了就要造一个数据源），本层不许拼一个出来
    { kind: "kv", key: "用量账本", value: `${data.usage.driver}  ${data.usage.dir}` },
    { kind: "kv", key: "鉴权", value: `${onOff(data.auth.enabled)} / ${data.auth.type}` },
    { kind: "kv", key: "配额重置", value: String(data.quotaResetHour) },
    { kind: "kv", key: "缺省窗口", value: data.defaultQuotaWindow },
    { kind: "kv", key: "写盘间隔", value: duration(data.flushIntervalMs) },
    // ⚠️ 逐字，**不改写也不替服务端判断该不该显示**（cluster master 的 `running: false` 是正常的）
    { kind: "note", text: body.runningMeans },
  ];
}

/**
 * `config`（不带键名）：一张键值表
 * @description ⚠️ **按服务端给的顺序**呈现（它自己按相位分组，那是一份知识，本层不重排）；
 * 同一个键的两种来源（`fileOrigin` 与 `fromEnv` / `fromArgv`）折进**一格**「来源」——
 * 折成两行会让同一件事在屏幕上占两处。
 */
function configTable(body: ConfigBody, width: number): readonly LogRow[] {
  if (body.keys.length === 0) {
    return [
      { kind: "note", text: `控制面没有报出任何配置键（共 ${String(body.summary.total)} 个）` },
    ];
  }
  const specs: readonly ColumnSpec[] = [
    { header: "key", width: "flex", min: 8 },
    { header: "value", width: "flex", min: 8 },
    { header: "来源", width: "auto", min: 6 },
    { header: "重启", width: 4, min: 4 },
  ];
  const rows = body.keys.map((key) => [
    key.key,
    // ⚠️ 打码是服务端的决定：只按它给的 `secret` 标志渲染，不在本层判「哪些键是秘密」
    key.secret ? MASKED : configValue(key.value),
    originCell(key),
    onOff(key.restartRequired),
  ]);
  return [
    table(specs, rows, width),
    {
      kind: "note",
      text: `共 ${String(body.keys.length)} 个键（其中 ${String(body.summary.secrets.length)} 个是密钥，已打码）`,
    },
  ];
}

/** `config <键名>`：一条一个键值对（值可能很长，塞进一格表格会被切） */
function configOne(key: ConfigKeyBody): readonly LogRow[] {
  return [
    { kind: "head", text: key.key },
    { kind: "kv", key: "值", value: key.secret ? MASKED : configValue(key.value) },
    { kind: "kv", key: "来源", value: originCell(key) },
    { kind: "kv", key: "相位", value: key.phase },
    { kind: "kv", key: "重启", value: onOff(key.restartRequired) },
    { kind: "kv", key: "宿主env", value: onOff(key.fromEnv) },
    { kind: "kv", key: "argv", value: onOff(key.fromArgv) },
  ];
}

/** `users` 的列（⚠️ 定值列是**承诺**：`disabled` 有 8 个字符，切成 `dis…` 的表头读不出是什么开关） */
const USER_SPECS: readonly ColumnSpec[] = [
  { header: "username", width: "flex", min: 10 },
  { header: "密码", width: 4, min: 4 },
  { header: "disabled", width: 8, min: 8 },
  { header: "到期", width: 24, min: 24 },
  { header: "配额", width: "auto", min: 8 },
  { header: "个人名单", width: "auto", min: 8 },
];

/** `users`：按 username **升序**（要的是确定性 —— 同一份数据两次渲染出同一个顺序才能对照着看） */
function userRows(body: UsersBody, width: number): readonly LogRow[] {
  if (body.accounts.length === 0) {
    return [{ kind: "note", text: "账号表是空的（user add <用户名> 建第一个账号）" }];
  }
  const sorted = [...body.accounts].sort((a, b) =>
    a.username < b.username ? -1 : a.username > b.username ? 1 : 0,
  );
  return [
    table(
      USER_SPECS,
      sorted.map((account) => [
        account.username,
        onOff(account.password.set),
        onOff(account.disabled),
        expiresCell(account),
        quotaCell(account),
        personalCell(account),
      ]),
      width,
    ),
    { kind: "note", text: `共 ${String(sorted.length)} 个账号` },
  ];
}

/** `usage` 的三段限定（⚠️ `sideEffect` 与 `note` **逐字**，一个字都不改） */
function usageQualifiers(reading: {
  readonly lagMs: number;
  readonly sideEffect: string;
  readonly note: string;
}): readonly LogRow[] {
  return [
    // 人读形态与原值**都**给：人读那一份用来判断严重性，原值那一份用来对账
    {
      kind: "kv",
      key: "账本可能滞后",
      value: `${duration(reading.lagMs)}（${String(reading.lagMs)} ms）`,
    },
    { kind: "note", text: reading.sideEffect },
    { kind: "note", text: reading.note },
  ];
}

/** 账本读失败的旁路（**逐条**显示，不合并成一句） */
function usageErrors(messages: readonly string[]): readonly LogRow[] {
  return messages.map((message) => ({ kind: "note", text: message }));
}

/** `usage`（全量） */
function usageRows(body: UsageBody, width: number): readonly LogRow[] {
  const specs: readonly ColumnSpec[] = [
    { header: "用户", width: "flex", min: 8 },
    { header: "窗口", width: "auto", min: 6 },
    { header: "已用", width: "auto", min: 8, align: "right" },
  ];
  const head: readonly LogRow[] =
    body.usage.length === 0
      ? [{ kind: "note", text: "账本此刻没有记录任何用户的用量" }]
      : [
          table(
            specs,
            body.usage.map((one) => [one.user, one.windowKey, bytes(one.total)]),
            width,
          ),
        ];
  return [...head, ...usageErrors(body.errors), ...usageQualifiers(body)];
}

/** `usage <用户名>`：单条（⚠️ `usage` 字段是**一个对象**不是数组，见 `@/api/wire.ts:usageOneShape`） */
function usageOneRows(body: UsageOneBody): readonly LogRow[] {
  return [
    { kind: "head", text: `用户 ${body.usage.user}` },
    { kind: "kv", key: "窗口", value: body.usage.windowKey },
    { kind: "kv", key: "已用", value: bytes(body.usage.total) },
    // ⚠️ 单条是**对账**的场合，给精确字节数（`@/ui/format.ts:bytes` 文件头指明的那一处）
    { kind: "kv", key: "精确字节", value: String(body.usage.total) },
    ...usageErrors(body.errors),
    // ⚠️ 限定取**这一次**的读：详情是另一次请求，它自带的 `lagMs` 才是那个数的归属
    ...usageQualifiers(body),
  ];
}

/** `acl`：一张表，**归属写在同一行上**（组与方向两列紧挨着条目列） */
function aclRows(body: AclBody, width: number): readonly LogRow[] {
  const cells: CellValue[][] = [];
  // ⚠️ 组名**逐字用服务端给的键**（`clientIp` / `target` / `upstream`），本层不做大小写折算：
  // `ACL_GROUPS` 那份清单是**HTTP 入参**用的名字（`clientip`），拿它去索引响应体是两份词汇混用，
  // 而对面加一组时这一支会静默少一行。
  for (const [group, lists] of Object.entries(body.acl)) {
    for (const list of ACL_LISTS) {
      for (const entry of lists[list]) cells.push([group, list, entry]);
    }
  }
  if (cells.length === 0) {
    return [{ kind: "note", text: "六份名单都是空的（没有白名单条目，也没有黑名单条目）" }];
  }
  const specs: readonly ColumnSpec[] = [
    { header: "组", width: "auto", min: 6 },
    { header: "方向", width: "auto", min: 6 },
    { header: "条目", width: "flex", min: 10 },
  ];
  return [table(specs, cells, width), { kind: "note", text: `共 ${String(cells.length)} 条` }];
}

/* 写面（发写请求） */
/**
 * 一次写的结果（账号写与名单写共用这一个形状）
 * @description
 * ⚠️ 「已改 / 没动」是**本层唯一的本地判断**，而它判的是「服务端说它动没动」—— 不许反过来拿它
 * 覆盖服务端那句 `message`（那句话写的是「哪一条里已经有它」这类具体事实，比「已改」有信息量）。
 * ⚠️ `effective` 只在 `changed` 为真时显示：不承诺一件没发生的事，也不自己补一句。
 */
function changeRows(body: ChangeBody): readonly LogRow[] {
  const rows: LogRow[] = [
    { kind: "kv", key: "写入", value: body.changed ? "已改" : "没动" },
    { kind: "note", text: body.message },
  ];
  if (body.notice !== undefined && body.notice !== null) {
    rows.push({ kind: "note", text: body.notice });
  }
  if (body.changed && body.effective !== undefined && body.effective !== null) {
    rows.push({ kind: "note", text: body.effective });
  }
  return rows;
}

/* 本地命令 */

/** `help`（无主题）：命令表逐行一条（数据源是 `@/cmd` 那**唯一**一份表，本层不另抄） */
function helpRows(topic: string | null, width: number): readonly LogRow[] {
  if (topic !== null) {
    const spec = findSpec(topic);
    if (spec === undefined) {
      return [{ kind: "err", text: `help 里没有这个命令名：${topic}` }];
    }
    // ⚠️ 头一行印的是 **`path`**（`/user add`）而不是 `name`（`user add`）：这一屏上印出来的
    // 就是操作者回车时该敲的那一串，而 `parseLine` 收的是**带斜杠**的那一串。
    const rows: LogRow[] = [
      { kind: "head", text: spec.path },
      { kind: "kv", key: "说明", value: spec.summary },
      { kind: "kv", key: "用法", value: spec.usage },
    ];
    if (spec.subs.length > 0) {
      rows.push({ kind: "kv", key: "子命令", value: spec.subs.join(" / ") });
    }
    for (const one of spec.args) {
      rows.push({ kind: "kv", key: `形参 ${one.label}`, value: one.required ? "必填" : "选填" });
    }
    if (spec.args.length === 0) rows.push({ kind: "note", text: "这一条不带形参" });
    return rows;
  }
  const specs: readonly ColumnSpec[] = [
    { header: "命令", width: "auto", min: 8 },
    { header: "说明", width: "flex", min: 12 },
  ];
  return [
    table(
      specs,
      // ⚠️ 逐行用 `path`：命令面板（`@/cmd/palette.js`）印的也是它，而这两屏必须逐字一致 ——
      // 一屏印 `/user add`、另一屏印 `user add` 时操作者只能靠猜哪个能敲。
      COMMAND_SPECS.map((spec) => [spec.path, spec.summary]),
      width,
    ),
    { kind: "note", text: `${COMMAND_PREFIX}help <命令名> 看用法与形参` },
  ];
}

/* 台账写 */

/**
 * 三条 `target` 命令共用的那一次写入
 * @description
 * ⚠️ **本层不碰台账文件**（理由见文件头）：台账在内存里的那一份是上层状态，绕过它写盘就会造出
 * 「内存与磁盘漂移」那类 bug。故这里只调回调，回调的成败（`LedgerError`）由本层翻译成一句话。
 * ⚠️ 副作用**只在成功后**给：写失败时上层内存里那一份台账没变，而「集合变了 / 目标换了」会让它
 * 重读或重连成一份与屏上矛盾的东西。三条命令共用这一段判据，故「成功才给」在这**一个**地方判，
 * 而不是三处各写一遍。
 */
async function targetWrite(
  command: Extract<Command, { kind: "target-add" | "target-del" | "target-switch" }>,
  deps: ExecDeps,
  work: LedgerWrite,
  label: string,
  effect: Effect,
): Promise<ExecResult> {
  const written = await attemptLedger(async () => {
    await work();
    return [{ kind: "kv", key: "台账", value: label }];
  });
  const failed = written.some((row) => row.kind === "err");
  return { rows: [...written], effects: failed ? [] : [effect] };
}

// ↑ 三条 `target` 命令共用上面那一个 `targetWrite`（见它的文件头：成功才给副作用）

/* 入口 */

/**
 * 命令种类穷举检查
 * @description
 * 这不是「跑不到」的防御，是**让编译器说话**的锚点：`default` 那支里的 `command` 必须是 `never`，
 * 而 {@link Command} 联合多了一个成员时它就变成 `Command`，`tsc` 立刻红。
 * ⚠️ 下面**两个** `switch` 各自带一条：只在一个 `switch` 上放它的话，另一处会静默落到
 * 「本地命令」那一支（那一条要对着 `0.0.0.0:0` 发请求，而 `pnpm test` 全绿）。
 */
function unreachable(command: never): never {
  throw new Error(`执行层不认识这个命令种类：${JSON.stringify(command)}`);
}

/**
 * `user set` 的字段穷举检查（与 {@link unreachable} 同物种的第二条锚点）
 * @description
 * ⚠️ 收口在**自己那一个 `switch`** 上：字段名是命令层那张表的键（`@/cmd/parse.js:UserValueOf`），
 * 而本文件的 `switch` 与那里的那张表是**两份**要同步的东西 —— 少一条分派时 `tsc` 必须红，
 * 而它只在这条 `never` 断言上才会红。
 */
function unreachableField(field: never): never {
  throw new Error(`执行层不认识 user set 的这个字段：${JSON.stringify(field)}`);
}

/**
 * 执行一条命令（**唯一**的对外入口；回显在这一层的前面统一加上）
 * @description
 * 本函数**不抛**（除了本包自己的 bug）：每一种失败都收敛成一条 {@link LogRow} 类型的 `err` 行，
 * 于是调用方不需要 `try` 就能把结果贴进结果区。
 *
 * ## ⚠️ 回显**由这里统一加上**，不是每个分支自己写一行
 * @description
 * 曾经 15 个分支各自 `plain([echoOf(...), …])`，而**漏掉的那一个不吭声**：
 * 「还没选中控制面」那一支（{@link noTarget}）与 `clear` 不带回显，于是命令跑过了、结果区却
 * **没有「你刚才跑了什么」那一行** —— 而那是操作者往上滚回去看的第一件事。
 * ⚠️ 漏一个分支的症状不像「少一行」，像「那条命令没跑过」，极难归因。
 * 故 {@link run} 只负责「发生了什么」，回显是本函数在**每一个**返回值前面无条件加上的一行。
 *
 * @param command - 解析层给的一条命令（`@/cmd/index.js:parseLine` 的 `ok` 那一档）
 * @param deps - 客户端、宽度、原文与三个台账回调
 */
export async function exec(command: Command, deps: ExecDeps): Promise<ExecResult> {
  const result = await run(command, deps);
  // ⚠️ **无条件**：包括「还没选中控制面」与 `clear`（后者加的那一行会被紧随其后的 `clear-log`
  // 一起清掉，而那正是「`clear` 之后结果区是空的」这个期望的来源）。
  return {
    rows: [echoOf(command, deps.line), ...result.rows],
    effects: result.effects,
  };
}

/**
 * 执行一条命令的**本体**（不含回显）
 * @description ⚠️ 它**私有**：对外只有 {@link exec}，而 {@link exec} 负责加回显 ——
 * 让本函数也导出的话，「哪个是入口」就变成了一个需要读注释才知道的事，
 * 而两条路径只差一行回显这件事**正是**上面那个漏分支的成因。
 */
async function run(command: Command, deps: ExecDeps): Promise<ExecResult> {
  switch (command.kind) {
    // 本地命令：一个请求都不发，故 `client === null` 时它们照样能用
    case "help":
      return plain([...helpRows(command.topic, deps.width)]);
    case "clear":
      // ⚠️ 清屏**不带任何行**：新内容会盖住它，给它留一行等于在空结果区里放一句上一条命令
      return { rows: [], effects: [{ kind: "clear-log" }] };
    // ⚠️ `new` / `managers` 两条是**本地动作**：一个请求都不发，故 `client === null` 时照样能用。
    // ⚠️ 那一句文案**不带会话名与控制面名** —— 本层不认识会话（那是上层的状态），
    // 编一个名字进去就是「说了一句它并不知道的事」。名字在侧边栏与窗口里各有一处。
    case "session-new":
      return {
        rows: [{ kind: "note", text: "新会话已建好，并已经切过去（名字见左侧栏）" }],
        effects: [{ kind: "session-new" }],
      };
    case "show-managers":
      return {
        rows: [{ kind: "note", text: "控制面清单 · ↑↓ 选 · Enter 确认 · Esc 关窗" }],
        effects: [{ kind: "show-managers" }],
      };
    case "target-add":
      return targetWrite(
        command,
        deps,
        () =>
          deps.onTargetAdd({
            name: command.name,
            baseUrl: command.baseUrl,
            token: command.token,
            timeoutMs: command.timeoutMs,
          }),
        `已加 ${command.name}`,
        { kind: "ledger-changed" },
      );
    case "target-del":
      return targetWrite(
        command,
        deps,
        () => deps.onTargetDel(command.name),
        `已删 ${command.name}`,
        { kind: "ledger-changed" },
      );
    case "target-switch":
      return targetWrite(
        command,
        deps,
        () => deps.onTargetSwitch(command.name),
        `已切到 ${command.name}`,
        { kind: "target-switched", name: command.name },
      );
    // 其余每一条都要控制面
    default:
      return withControlPlane(command, deps);
  }
}

/** 需要控制面的那些分支：先把客户端取出来判空，再穷举每一条读/写 */
async function withControlPlane(command: Command, deps: ExecDeps): Promise<ExecResult> {
  const client = deps.client;
  // ⚠️ **一个请求都不发**就返回：对 `0.0.0.0:0` 发一次会把「你没选控制面」显示成「那台机器连不上」
  if (client === null) return noTarget();
  switch (command.kind) {
    case "status":
      return plain([
        ...(await attempt(async () => statusRows(await client.status()))),
      ]);
    case "config": {
      if (command.key === null) {
        return plain([
          ...(await attempt(async () => configTable(await client.config(), deps.width))),
        ]);
      }
      const wanted = command.key;
      return plain([
        ...(await attempt(async () => {
          const body = await client.config();
          const found = body.keys.find((one) => one.key === wanted);
          if (found === undefined) {
            return [{ kind: "err", text: `控制面没有报出这个配置键：${wanted}` }];
          }
          return configOne(found);
        })),
      ]);
    }
    case "users":
      return plain([
        ...(await attempt(async () => userRows(await client.users(), deps.width))),
      ]);
    case "usage": {
      if (command.user === null) {
        return plain([
          ...(await attempt(async () => usageRows(await client.usage(), deps.width))),
        ]);
      }
      const wanted = command.user;
      return plain([
        ...(await attempt(async () => usageOneRows(await client.usageFor(wanted)))),
      ]);
    }
    case "acl":
      return plain([
        ...(await attempt(async () => aclRows(await client.acl(), deps.width))),
      ]);
    case "user-add": {
      const { username, quotaBytes } = command;
      return plain([
        ...(await attempt(async () =>
          changeRows(
            await client.createAccount({
              username,
              // ⚠️ 命令表里 `user add` **没有密码形参**，故这里唯一能发出去的是空串；而
              // 「空串密码」与「没给密码」在服务端是**两件不同的事**（前者 200、一个空密码账号；
              // 后者 400）。本层不替用户编一个密码，也不改命令表 —— 只把这件事**说出来**。
              password: "",
              quotaBytes,
            }),
          ),
        )),
        { kind: "note", text: NO_PASSWORD_ARG },
      ]);
    }
    case "user-set": {
      const { username, field, value } = command;
      // ⚠️ **只发这一个键**：带别的键会把「我只想改配额」变成「顺手重写他的密码」。
      // ⚠️ 分派**穷举七个字段**并以一条 `never` 断言收尾，而不是「六个 if + 最后的 else 兜给密码」：
      // 后者在新字段加入时会把值当成密码发出去 —— 那是一次**真的改写了凭据**的静默事故，
      // 而服务端照收（`password` 是合法键）。
      // ⚠️ 值的**域**判据在 `@/cmd/parse.js` 那一层收（`quotaWindow` / 名单条目），本层拿到的
      // 已经是收窄过的形状；这里**不**再判一次，两份判据是会漂的。
      let patch: AccountUpdateInput;
      switch (field) {
        case "quotaBytes":
          patch = { quotaBytes: value };
          break;
        case "quotaWindow":
          patch = { quotaWindow: value };
          break;
        case "expiresAt":
          patch = { expiresAt: value };
          break;
        case "disabled":
          patch = { disabled: value };
          break;
        // ⚠️ 展开成新数组：解析层给的是 `readonly`，而请求体的字段是 `string[]`。
        // 那一次拷贝让「命令是只读的」这件事在类型上成立，而请求体仍然是服务端声明的可变形状。
        case "targetWhitelist":
          patch = { targetWhitelist: [...value] };
          break;
        case "targetBlacklist":
          patch = { targetBlacklist: [...value] };
          break;
        case "password":
          patch = { password: value };
          break;
        default:
          return unreachableField(field);
      }
      return plain([
        ...(await attempt(async () => changeRows(await client.updateAccount(username, patch)))),
      ]);
    }
    case "user-on":
      return plain([
        ...(await attempt(async () =>
          changeRows(await client.updateAccount(command.username, { disabled: false })),
        )),
      ]);
    case "user-off":
      return plain([
        ...(await attempt(async () =>
          changeRows(await client.updateAccount(command.username, { disabled: true })),
        )),
      ]);
    case "user-del":
      return plain([
        ...(await attempt(async () => changeRows(await client.deleteAccount(command.username)))),
      ]);
    case "user-pass":
      return plain([
        ...(await attempt(async () =>
          changeRows(await client.updateAccount(command.username, { password: command.password })),
        )),
      ]);
    case "reprobe":
      return { rows: [], effects: [{ kind: "reprobe" }] };
    // ⚠️ 下面这七个 `kind` **由 `exec` 的第一个 `switch` 拦掉了**，落到这里就是本包的路由有 bug。
    // 写成显式的 `case` 而不是留到 `default`：`default` 拿到的 `command` 仍是整个 `Command` 联合，
    // 那样 {@link unreachable} 就**不是** `never`，`Command` 加成员时 `tsc` 不会红。
    case "help":
    case "clear":
    case "session-new":
    case "show-managers":
    case "target-add":
    case "target-del":
    case "target-switch":
      throw new Error(`执行层的路由有 bug：本地命令 ${command.kind} 不该走到需要控制面的那一支`);
    default:
      return unreachable(command);
  }
}
