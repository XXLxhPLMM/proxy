/**
 * @fileoverview 执行层的入口：一条已解析的命令 → 若干输出行 + 一组「上层要应用的动作」
 * @module exec/run
 * @description
 * 本模块是命令层与控制面之间**唯一**的执行点：输入是 {@link Command}（判别联合），输出是给人看的
 * {@link LogRow} 与给上层的 {@link Effect}。行的排版在 `./rows.js`、凭据掩码在 `./echo.js`、失败的那些句
 * 在 `./failures.js`。
 *
 * ⚠️ **不碰状态**：不 `setState`、不写台账、不改当前目标，只**发请求**与**读注入进来的东西**，然后**说**
 * 发生了什么 —— 执行层一旦改状态，它的每一条判据都要起一个真的界面才能断言。**台账的写一律走注入的回调**
 * （{@link ExecDeps.onTargetAdd} 等三个），否则内存里那一份与磁盘会漂。
 * ⚠️ **回显由 {@link exec} 统一加**（每个返回值前面无条件一行），不归各分支：曾经漏掉的那一支不吭声，
 * 而症状像「那条命令没跑过」。⚠️ **没选中控制面时一个请求都不发**（`./failures.js:noTarget`）。
 * ⚠️ 「哪些命令要客户端」判据是**两个穷举的 `switch`**（各带一条 `never` 断言）而不是一张清单：清单是
 * 可数据，加一条命令忘了加一项编译期不会红，那会让它默认落到「不需要客户端」那一支而测试全绿。
 */

import type { AccountUpdateInput } from "@/api/index.js";
import { type Command } from "@/cmd/index.js";
import { type LogRow } from "@/log/index.js";
import type { ManagerClient } from "@/utils/index.js";
import { NO_PASSWORD_ARG, echoOf } from "./echo.js";
import { attempt, attemptLedger, noTarget, plain } from "./failures.js";
import {
  aclRows,
  changeRows,
  configOne,
  configTable,
  helpRows,
  statusRows,
  usageOneRows,
  usageRows,
  userRows,
} from "./rows.js";

/**
 * 上层要应用的动作
 * @description 执行层**只说**发生了什么，改状态是上层的事，而这就是全部。⚠️ `ledger-changed` 与
 * `target-switched` **刻意不合并**：前者是「目标集合变了，重读内存里那一份」，后者是「当前目标换了，
 * 重建客户端」—— 合成一个动作会让上层必须自己去猜是哪一种。
 */
export type Effect =
  /** `clear`：清掉结果区 */
  | { readonly kind: "clear-log" }
  /** `r`：重探当前控制面 */
  | { readonly kind: "reprobe" }
  /** 目标集合变了，要按那份台账重读内存里的一份 */
  | { readonly kind: "ledger-changed" }
  /** 当前目标换成了哪一个（重建客户端） */
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

/** `target add` 递给上层的那份输入（⚠️ 缺省值**不在这里补**：`DEFAULT_TIMEOUT_MS` 与区间判据都在 `@/ledger`） */
export interface TargetAddRequest {
  readonly name: string;
  readonly baseUrl: string;
  readonly token: string;
  /** `null` = 没给这个形参 */
  readonly timeoutMs: number | null;
}

/**
 * 一次台账写的**成败**通道
 * @description 成功 = resolve（可以是同步的），失败 = 抛 `LedgerError`。⚠️ 刻意用**抛**而不是返回布尔：
 * 返回布尔会让「抛了」与「返回了 `false`」两种失败同时存在，而调用方只查其中一种。
 */
export type LedgerWriteResult = void | Promise<void>;

export type LedgerWrite = () => LedgerWriteResult;

/** 执行一条命令要用的东西（全由上层给，本层不读宿主、不读台账文件） */
export interface ExecDeps {
  /** `null` = **还没选中控制面**（此时需要控制面的命令一个请求都不发，见文件头） */
  readonly client: ManagerClient | null;
  /**
   * 结果区的内容宽度（列数），由组合根采一次传下来
   * @description 本层**不**读 `process.stdout.columns`：那会把「宽度快照」的采集面从一个地方拆成两个。
   */
  readonly width: number;
  /** 用户敲的那一行原文（回显用；含凭据的三条命令按命令重建，见 `./echo.js`） */
  readonly line: string;
  readonly onTargetAdd: (request: TargetAddRequest) => LedgerWriteResult;
  readonly onTargetDel: (name: string) => LedgerWriteResult;
  readonly onTargetSwitch: (name: string) => LedgerWriteResult;
}

/**
 * 三条 `target` 命令共用的那一次写入
 * @description ⚠️ 副作用**只在成功后**给（写失败时上层那份台账没变，而「集合变了 / 目标换了」会让它重读
 * 或重连成一份与屏上矛盾的东西）—— 故这条判据在这**一个**地方判，而不是三处各写一遍。
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

/** 命令种类穷举检查（不是「跑不到」的防御，是**让编译器说话**的锚点：`Command` 多一个成员时 `tsc` 就红） */
function unreachable(command: never): never {
  throw new Error(`执行层不认识这个命令种类：${JSON.stringify(command)}`);
}

/**
 * `user set` 的字段穷举检查（与 {@link unreachable} 同物种的第二条锚点）
 * @description ⚠️ 收口在**自己那一个 `switch`** 上：字段名是 `./specs.js` 那张表的键，而本文件的 `switch`
 * 与它是**两份**要同步的东西 —— 少一条分派时 `tsc` 只在这条断言上会红。
 */
function unreachableField(field: never): never {
  throw new Error(`执行层不认识 user set 的这个字段：${JSON.stringify(field)}`);
}

/**
 * 执行一条命令（**唯一**的对外入口；回显在这一层的前面统一加上）
 * @description 本函数**不抛**（除了本包自己的 bug）：每一种失败都收敛成一条 `err` 行。⚠️ 回显是**无条件**
 * 加上的，包括「还没选中控制面」与 `clear`（后者那一行会被紧随其后的 `clear-log` 一起清掉）。
 *
 * @param command - 解析层给的一条命令（`@/cmd/index.js:parseLine` 的 `ok` 那一档）
 * @param deps - 客户端、宽度、原文与三个台账回调
 */
export async function exec(command: Command, deps: ExecDeps): Promise<ExecResult> {
  const result = await run(command, deps);
  return {
    rows: [echoOf(command, deps.line), ...result.rows],
    effects: result.effects,
  };
}

/** 执行一条命令的**本体**（不含回显；⚠️ 私有 —— 两条路径只差一行回显，正是文件头那个漏分支的成因） */
async function run(command: Command, deps: ExecDeps): Promise<ExecResult> {
  switch (command.kind) {
    // 本地命令：一个请求都不发，故 `client === null` 时它们照样能用
    case "help":
      return plain([...helpRows(command.topic, deps.width)]);
    case "clear":
      // ⚠️ 清屏**不带任何行**：新内容会盖住它，给它留一行等于在空结果区里放一句上一条命令
      return { rows: [], effects: [{ kind: "clear-log" }] };
    // ⚠️ `new` / `managers` 两条是**本地动作**：那一句文案**不带会话名与控制面名** —— 本层不认识会话。
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
  // ⚠️ 一个请求都不发就返回（对 `0.0.0.0:0` 发一次会把「你没选控制面」说成「那台机器连不上」）
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
              // ⚠️ 命令表里 `user add` **没有密码形参**，故这里唯一能发出去的是空串，而「空串密码」
              // 与「没给密码」在服务端是两件不同的事（前者 200、一个空密码账号；后者 400）。本层
              // 不编一个密码，只把这件事**说出来**（见 `./echo.js:NO_PASSWORD_ARG`）。
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
      // ⚠️ **只发这一个键**：带别的键会把「我只想改配额」变成「顺手重写他的密码」。分派**穷举七个字段**
      // 并以一条 `never` 断言收尾，而不是「六个 if + 最后的 else 兜给密码」—— 后者会把新字段的值当成密码
      // 发出去，而服务端照收。值的**域**判据在 `@/cmd/values.js` 收，这里**不**再判一次。
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
        // ⚠️ 展开成新数组：解析层给的是 `readonly`，而请求体的字段是 `string[]`（那一次拷贝让「命令是
        // 只读的」在类型上成立）
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
    // ⚠️ 下面这七个 `kind` 由 {@link run} 的第一个 `switch` 拦掉了，落到这里就是本包的路由有 bug。
    // 写成显式的 `case` 而不是留到 `default`：那样 {@link unreachable} 就**不是** `never`。
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