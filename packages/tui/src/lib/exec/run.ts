/** @fileoverview 执行层的入口：一条已解析的命令 → 若干输出行 + 一组「上层要应用的动作」 */
/** ⚠️ **不碰状态**：只发请求与读注入进来的东西，台账的写一律走注入的回调 —— 执行层一旦改状态，它的每一条判据都要起一个真的界面才能断言 */

import type { AccountUpdateInput } from "@/api/index.js";
import { ALL_TARGETS, type Command } from "@/commands/index.js";
import { type LogRow } from "@/lib/log/index.js";
import type { ManagerClient } from "@/services/index.js";
import type { ProviderInput, ProviderSettings } from "@/services/config/index.js";
import { NO_PASSWORD_ARG, echoOf, leavesTrace } from "./echo.js";
import { attempt, attemptLedger, noTarget, plain } from "./failures.js";
import {
  aclRows,
  changeRows,
  configOne,
  configTable,
  helpRows,
  providerRows,
  statusRows,
  usageOneRows,
  usageRows,
  userRows,
} from "./rows.js";

/** 上层要应用的动作；执行层**只说**发生了什么 */
/** ⚠️ `ledger-changed` 与 `target-switched` **刻意不合并**：合成一个动作会让上层必须自己去猜是哪一种 */
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
  /** `rename`：打开改名框（⚠️ 不带名字：名字是**在框里敲**出来的，所以它不是形参而是一段界面状态） */
  | { readonly kind: "open-rename" }
  /** `session hide`：把哪一个从侧边栏藏起来（成败由上层说一句，理由见 `leavesTrace`） */
  | { readonly kind: "session-hide"; readonly name: string }
  /** `session show`：把哪一个放回侧边栏 */
  | { readonly kind: "session-show"; readonly name: string }
  /** `managers`：打开控制面清单窗口（选中哪一个由上层那一格高亮决定） */
  | { readonly kind: "show-managers" }
  /** `batch`：⚠️ `command` 是**内层那一条**、`line` 是它的**原文**（回显由扇出那一圈**逐台**加） */
  | { readonly kind: "batch"; readonly command: Command; readonly line: string; readonly peers: readonly BatchPeer[] }
  /** `provider show`：把 provider 那三样打在结果区（⚠️ 凭据由上层经 `redactProvider` 打码后才轮到本层） */
  | { readonly kind: "provider-show" }
  /** `provider set`：三样一起落库（⚠️ 写台账那一面由上层做 —— 执行层不碰状态） */
  | { readonly kind: "provider-set"; readonly baseUrl: string; readonly model: string; readonly apiKey: string }
  /** `provider key`：只换凭据（地址与模型名由上层从库里读出来一起写回） */
  | { readonly kind: "provider-key"; readonly apiKey: string };

/** 一次执行的结果 */
export interface ExecResult {
  readonly rows: readonly LogRow[];
  readonly effects: readonly Effect[];
}

/** `target add` 递给上层的那份输入（⚠️ 缺省值**不在这里补**：`DEFAULT_TIMEOUT_MS` 与区间判据都在 `@/services/config`） */
export interface TargetAddRequest {
  readonly name: string;
  readonly baseUrl: string;
  readonly token: string;
  /** `null` = 没给这个形参 */
  readonly timeoutMs: number | null;
}

/** 一次台账写的**成败**通道：成功 = resolve，失败 = 抛 `LedgerError` */
/** ⚠️ 刻意用**抛**而不是返回布尔：返回布尔会让「抛了」与「返回了 `false`」两种失败同时存在，而调用方只查其中一种 */
export type LedgerWriteResult = void | Promise<void>;

export type LedgerWrite = () => LedgerWriteResult;

/** 执行一条命令要用的东西（全由上层给，本层不读宿主、不读台账文件） */
export interface ExecDeps {
  /** `null` = **还没选中控制面**（此时需要控制面的命令一个请求都不发，见文件头） */
  readonly client: ManagerClient | null;
  /** 结果区的内容宽度（列数），由组合根采一次传下来；⚠️ 本层**不**读 `process.stdout.columns` */
  readonly width: number;
  /** 用户敲的那一行原文（回显用；含凭据的三条命令按命令重建，见 `./echo.js`） */
  readonly line: string;
  readonly onTargetAdd: (request: TargetAddRequest) => LedgerWriteResult;
  readonly onTargetDel: (name: string) => LedgerWriteResult;
  readonly onTargetSwitch: (name: string) => LedgerWriteResult;
  /** provider 三样一起落库 */
  readonly onProviderSet: (input: ProviderInput) => LedgerWriteResult;
  /** 只换 provider 的凭据（⚠️ 上层先读出另外两样，整体写回 —— 「配了一半」在库里不存在） */
  readonly onProviderKey: (apiKey: string) => LedgerWriteResult;
  /**
   * provider 此刻的样子（**只给界面看的那一份**：调用方必须先过 `redactProvider`，
   * 而那是**唯一**的打码出口 —— 与 `targets` 那一条同规格）
   */
  readonly provider: () => ProviderSettings;
  /**
   * `/batch` 的那些名字 → **已解析的客户端**（⚠️ 这一格是**唯一**能看见台账的地方，而它在**上层**）
   */
  readonly peers: (names: readonly string[]) => readonly BatchPeer[];
}

/** `/batch` 的那些目标（⚠️ **由上层从台账解析出来**：执行层不读台账、也不认目标名；`client` 为 `null` = 那台还没选） */
export interface BatchPeer {
  readonly name: string;
  readonly client: ManagerClient | null;
}

/** 一个目标的结果（⚠️ **成败分开记**；`ok` 是**判据** —— 屏上「三台里两台成功」那句话就是数它数出来的） */
export interface BatchReport {
  readonly name: string;
  readonly ok: boolean;
  readonly rows: readonly LogRow[];
}

/** `/batch` 那一格 → 台账里要发的那几台（⚠️ **`all` 保留成一个词**，由上层对着台账展开） */
export function batchTargetNames(raw: string): readonly string[] {
  return raw === ALL_TARGETS ? [ALL_TARGETS] : raw.split(",");
}

/** 一次台账写的公共尾巴；⚠️ 副作用**只在成功后**给（写失败时上层那份台账没变），判据在这**一个**地方判 */
async function targetWrite(
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

/** `user set` 的字段穷举检查（与 {@link unreachable} 同物种的第二条锚点） */
/** ⚠️ 收口在**自己那一个 `switch`** 上：本文件的 `switch` 与 `./specs.js` 那张表是**两份**要同步的东西，少一条分派时 `tsc` 只在这条断言上会红 */
function unreachableField(field: never): never {
  throw new Error(`执行层不认识 user set 的这个字段：${JSON.stringify(field)}`);
}

/** 执行一条命令（**唯一**的对外入口；回显在这一层的前面统一加上，只加在**留痕的**那些返回值前面） */
export async function exec(command: Command, deps: ExecDeps): Promise<ExecResult> {
  const result = await run(command, deps);
  return {
    rows: leavesTrace(command) ? [echoOf(command, deps.line), ...result.rows] : result.rows,
    effects: result.effects,
  };
}

/** 执行一条命令的**本体**（回显由 {@link exec} 那一层决定；⚠️ 私有 —— 两条路径只差回显那一句） */
async function run(command: Command, deps: ExecDeps): Promise<ExecResult> {
  switch (command.kind) {
    // 本地命令：一个请求都不发，故 `client === null` 时它们照样能用
    case "help":
      return plain([...helpRows(command.topic, deps.width)]);
    case "clear":
      // ⚠️ 清屏**不带任何行**：新内容会盖住它，给它留一行等于在空结果区里放一句上一条命令
      return { rows: [], effects: [{ kind: "clear-log" }] };
    // ⚠️ `new` / `managers` 是**纯界面动作**：一个请求都不发、一个字节都不留，两支留给上层的 `Effect` 就是它们的全部
    case "session-new":
      return { rows: [], effects: [{ kind: "session-new" }] };
    // ⚠️ 这三条**也**一个字都不留：改名框自己回答「改成什么了」，而藏/放出来由侧边栏那一列回答（多一项或少一项）
    case "session-rename":
      return { rows: [], effects: [{ kind: "open-rename" }] };
    case "session-hide":
      return { rows: [], effects: [{ kind: "session-hide", name: command.name }] };
    case "session-show":
      return { rows: [], effects: [{ kind: "session-show", name: command.name }] };
    case "show-managers":
      return { rows: [], effects: [{ kind: "show-managers" }] };
    // ⚠️ `provider show` 是个**纯读**：一个请求都不发，而那一格打码由调用方给的那个回调先做过了
    case "provider-show":
      return plain(providerRows(deps.provider()));
    // ⚠️ `/batch` **不调端点**：它只把「内层那一条命令 + 那一批目标」交给上层，由上层逐个跑
    // （串行还是并发、以及为什么，见 `@/lib/exec/batch.ts` 的文件头）
    case "batch":
      return {
        rows: [],
        effects: [
          {
            kind: "batch",
            command: command.command,
            // ⚠️ 内层那一行的**原文**逐字带上来：回显在扇出那一圈逐台加，而那一圈只有它能给出
            // 「用户敲的是哪一条」（掩码也靠它 —— `echoOf` 按命令重建，凭据那一格靠原文定位）
            line: command.line,
            peers: deps.peers(batchTargetNames(command.targets)),
          },
        ],
      };
    case "target-add":
      return targetWrite(
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
        deps,
        () => deps.onTargetDel(command.name),
        `已删 ${command.name}`,
        { kind: "ledger-changed" },
      );
    case "target-switch":
      return targetWrite(
        deps,
        () => deps.onTargetSwitch(command.name),
        `已切到 ${command.name}`,
        { kind: "target-switched", name: command.name },
      );
    case "provider-set":
      return targetWrite(
        deps,
        () =>
          deps.onProviderSet({
            baseUrl: command.baseUrl,
            model: command.model,
            apiKey: command.apiKey,
          }),
        `provider 已配成 ${command.model}`,
        { kind: "provider-set", baseUrl: command.baseUrl, model: command.model, apiKey: command.apiKey },
      );
    case "provider-key":
      return targetWrite(
        deps,
        () => deps.onProviderKey(command.apiKey),
        "provider 凭据已换",
        { kind: "provider-key", apiKey: command.apiKey },
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
              // ⚠️ 命令表里 `user add` **没有密码形参**，故这里唯一能发出去的是空串，而「空串密码」与「没给密码」在服务端是两件不同的事
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
      // ⚠️ **只发这一个键**：带别的键会把「我只想改配额」变成「顺手重写他的密码」。分派**穷举七个字段**并以一条 `never` 断言收尾
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
        // ⚠️ 展开成新数组：解析层给的是 `readonly`，而请求体的字段是 `string[]`
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
    // ⚠️ 下面这七个 `kind` 由 {@link run} 的第一个 `switch` 拦掉了；写成显式的 `case`，那样 {@link unreachable} 就**不是** `never`
    case "help":
    case "clear":
    case "session-new":
    case "session-rename":
    case "session-hide":
    case "session-show":
    case "show-managers":
    case "provider-show":
    case "batch":
    case "target-add":
    case "target-del":
    case "target-switch":
    case "provider-set":
    case "provider-key":
      throw new Error(`执行层的路由有 bug：本地命令 ${command.kind} 不该走到需要控制面的那一支`);
    default:
      return unreachable(command);
  }
}