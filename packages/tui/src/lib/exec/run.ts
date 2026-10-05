/** @fileoverview 执行层的入口：一条已解析的命令 → 若干输出行 + 一组「上层要应用的动作」 */
/** ⚠️ **不碰状态**：只发请求与读注入进来的东西，台账与弹窗的读写一律走注入的读面或上层的副作用 —— 执行层一旦改状态，它的每一条判据都要起一个真的界面才能断言 */

import type { AccountBody } from "@/api/index.js";
import { ALL_TARGETS, type Command } from "@/commands/index.js";
import { type LogRow } from "@/lib/log/index.js";
import type { TargetView } from "@/services/config/index.js";
import type { ManagerClient } from "@/services/index.js";
import { leavesTrace } from "./echo.js";
import { attempt, noTarget, plain } from "./failures.js";
import {
  aclRows,
  configOne,
  configTable,
  helpRows,
  statusRows,
  usageOneRows,
  usageRows,
  userRows,
} from "./rows.js";

/** 上层要应用的动作；执行层**只说**发生了什么 */
export type Effect =
  /** `clear`：清掉结果区 */
  | { readonly kind: "clear-log" }
  /** `r`：重探当前控制面 */
  | { readonly kind: "reprobe" }
  /** `new`：新开一个会话，并切过去 */
  | { readonly kind: "session-new" }
  /** `rename`：打开改名框（⚠️ 不带名字：名字是**在框里敲**出来的，所以它不是形参而是一段界面状态） */
  | { readonly kind: "open-rename" }
  /** `sessions`：打开历史会话弹窗（⚠️ 弹窗里那几格（激活 / 删除 / 重命名）是**状态层**的事） */
  | { readonly kind: "open-sessions" }
  /** `targets`：打开控制面清单弹窗（⚠️ 弹窗里增删改是**状态层**的事） */
  | { readonly kind: "targets-open" }
  /** `users`：打开账号清单弹窗（⚠️ 同上） */
  | { readonly kind: "users-open" }
  /** `providers`：打开提供商清单弹窗（⚠️ 同上） */
  | { readonly kind: "providers-open" }
  /** `models`：打开按提供商分组的模型选择弹窗（⚠️ 同上） */
  | { readonly kind: "models-open" }
  /** `batch`：⚠️ `command` 是**内层那一条**、`line` 是它的**原文**（回显由扇出那一圈**逐台**加） */
  | { readonly kind: "batch"; readonly command: Command; readonly line: string; readonly peers: readonly BatchPeer[] }
  /** `/exit` 与 `/quit`：**请求**退出（⚠️ 能不能退由上层答 —— 它知道队列与终端，故本层只说「该退了」） */
  | { readonly kind: "request-exit" };

/** 一次执行的结果 */
export interface ExecResult {
  readonly rows: readonly LogRow[];
  readonly effects: readonly Effect[];
}

/** `/accounts` 那一屏的账号清单（⚠️ **注入进来的**：本层不读台账，而一个请求都不许为它发） */
export interface ExecAccounts {
  readonly accounts: readonly AccountBody[];
}

/** 执行一条命令要用的东西（全由上层给，本层不读宿主、不读台账文件） */
export interface ExecDeps {
  /** `null` = **还没选中控制面**（此时需要控制面的命令一个请求都不发，见文件头） */
  readonly client: ManagerClient | null;
  /** 结果区的内容宽度（列数），由组合根采一次传下来；⚠️ 本层**不**读 `process.stdout.columns` */
  readonly width: number;
  /** 用户敲的那一行原文（回显用；⚠️ 留痕的那些命令一条都不带凭据，故它**逐字**上屏） */
  readonly line: string;
  /** `/accounts` 那一格要画的账号清单（⚠️ 注入进来的 —— 执行层不读台账，而 `/users` 弹窗画的是**同一份**） */
  readonly accounts: () => ExecAccounts;
  /** 控制面清单（`/targets` 弹窗画的那一份；⚠️ 与 `accounts` 同一条纪律：清单归上层持有，本层不读台账） */
  readonly targetsView: () => readonly TargetView[];
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

/** 命令种类穷举检查（不是「跑不到」的防御，是**让编译器说话**的锚点：`Command` 多一个成员时 `tsc` 就红） */
function unreachable(command: never): never {
  throw new Error(`执行层不认识这个命令种类：${JSON.stringify(command)}`);
}

/** 执行一条命令（**唯一**的对外入口；回显在这一层的前面统一加上，只加在**留痕的**那些返回值前面） */
export async function exec(command: Command, deps: ExecDeps): Promise<ExecResult> {
  const result = await run(command, deps);
  return {
    // ⚠️ 留痕的那些命令里**没有一条带凭据**（凭据只从弹窗的输入格进来），故那一行**逐字**就是用户敲的那一串
    rows: leavesTrace(command) ? [{ kind: "echo", text: deps.line }, ...result.rows] : result.rows,
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
    // ⚠️ 这一族是**纯界面动作**：一个请求都不发、一个字节都不留，交给上层的那个 `Effect` 就是它们的全部
    // ⚠️ 而弹窗那一族**也**一个字都不留：弹窗自己回答「里面有哪些」，结果区里每一行都只是第二遍
    case "session-new":
      return { rows: [], effects: [{ kind: "session-new" }] };
    case "session-rename":
      return { rows: [], effects: [{ kind: "open-rename" }] };
    case "sessions-open":
      return { rows: [], effects: [{ kind: "open-sessions" }] };
    case "targets-open":
      return { rows: [], effects: [{ kind: "targets-open" }] };
    case "users-open":
      return { rows: [], effects: [{ kind: "users-open" }] };
    case "providers-open":
      return { rows: [], effects: [{ kind: "providers-open" }] };
    case "models-open":
      return { rows: [], effects: [{ kind: "models-open" }] };
    // ⚠️ **零形参、零行、零请求**：`/exit` 与 `/quit` 各产出这一个副作用，而**退出码由组合根定**
    case "exit":
      return { rows: [], effects: [{ kind: "request-exit" }] };
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
            // 「用户敲的是哪一条」
            line: command.line,
            peers: deps.peers(batchTargetNames(command.targets)),
          },
        ],
      };
    // 其余每一条都要控制面
    default:
      return withControlPlane(command, deps);
  }
}

/** 需要控制面的那些分支：先把客户端取出来判空，再穷举每一条读 */
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
    // ⚠️ **注入的那一份**：一个请求都不发，而它与 `/users` 弹窗画的是同一份 ⇒ 两条路不可能对不上。
    // ⚠️ 而它**仍然**要过上面那道「没选中控制面」的闸：账号表属于某一台，而没选中时那份清单要么是空的、
    // 要么是上一台的 —— 两种都是屏上的**一句假事实**
    case "accounts":
      return plain(userRows({ accounts: deps.accounts().accounts }, deps.width));
    case "reprobe":
      return { rows: [], effects: [{ kind: "reprobe" }] };
    // ⚠️ 下面这十一个 `kind` 由 {@link run} 的第一个 `switch` 拦掉了；写成显式的 `case`，那样 {@link unreachable} 就**不是** `never`
    case "help":
    case "clear":
    case "session-new":
    case "session-rename":
    case "sessions-open":
    case "targets-open":
    case "users-open":
    case "providers-open":
    case "models-open":
    case "exit":
    case "batch":
      throw new Error(`执行层的路由有 bug：本地命令 ${command.kind} 不该走到需要控制面的那一支`);
    default:
      return unreachable(command);
  }
}