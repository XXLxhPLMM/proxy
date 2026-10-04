/**
 * @fileoverview 对话那一圈：用户说一句话 → 模型挑一条 `Command` → 走**现有**的 `exec()` → 结果回到模型那里
 * @description **模型绝不许拿到 HTTP client** —— 两条理由写在 `packages/tui/AGENTS.md`「模型」一节
 */

import { COMMAND_SPECS, type Command, type CommandSpec } from "@/commands/index.js";
import { exec, type Effect, type ExecDeps } from "@/lib/exec/index.js";
import type { LogRow, Turn } from "@/lib/log/index.js";
import { ModelError, askModel, commandOfReply, messagesOf } from "@/services/model.js";
import type { ChatMessage, ModelEndpoint, ModelReply } from "@/services/model.js";

/** 往返轮数上限（⚠️ **必须有**：模型每轮都能再挑一条命令，而没有上限的那一版是一个会自己烧钱的循环） */
export const MAX_ROUNDS = 4;

/** 模型看得见的命令表（⚠️ **从 `COMMAND_SPECS` 现算**：另抄一份就是第二份真相源，而模型会照着那份错的挑命令） */
export function toolSpecs(): readonly CommandSpec[] {
  // ⚠️ 组（`user` / `target` / `session`）不进这份表：它们不是命令，模型挑了必然过不了解析
  return COMMAND_SPECS.filter((spec) => spec.subs.length === 0);
}

/** 那份命令表的**一行一条**形态（⚠️ 形参**带着标签**，而模型填参数时最常错的就是「第二个形参叫什么」） */
export function toolDigest(): string {
  return toolSpecs()
    .map((spec) => `- ${spec.usage}：${spec.summary}`)
    .join("\n");
}

/** 这一圈要用的东西（全由上层给；本层不读时钟、不读配置） */
export interface AgentDeps {
  /** provider 三样东西（`null` = **没配**：那句话只留在这一屏，见 {@link ask}） */
  readonly endpoint: ModelEndpoint | null;
  /** 一次模型往返的超时毫秒（⚠️ 与控制面那一份**分开**：模型慢，而控制面慢是另一回事） */
  readonly timeoutMs: number;
  /** 执行层要用的依赖（⚠️ **注入进来的**——模型只给 `Command`，那些依赖与它无关） */
  readonly execDeps: ExecDeps;
}

/** 这一圈的结果（判别联合；⚠️ `turns` 恒是**这一次多出来的那几格**，调用方负责追加到桶里） */
export type AgentResult =
  | { readonly kind: "ok"; readonly turns: readonly Turn[]; readonly effects: readonly Effect[] }
  | { readonly kind: "no-provider"; readonly turns: readonly Turn[]; readonly rows: readonly LogRow[] }
  | { readonly kind: "failed"; readonly turns: readonly Turn[]; readonly rows: readonly LogRow[] };

/** 一句话 → 这一圈（⚠️ 唯一的对外入口；**没有 provider 就一个请求都不发**） */
export async function ask(text: string, history: readonly Turn[], deps: AgentDeps): Promise<AgentResult> {
  const question: Turn = { kind: "user", text };
  if (deps.endpoint === null) {
    // ⚠️ 用户那句话**仍然进桶**（那是他敲的，不该因为没配 provider 就消失），后面跟一句为什么没执行
    return { kind: "no-provider", turns: [question], rows: NO_PROVIDER };
  }
  const seen: Turn[] = [...history, question];
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    // ⚠️ 每一次往返都**重新**从对话算消息：上一轮的结果要进去，否则模型看不到自己刚跑过什么
    const messages: readonly ChatMessage[] = messagesOf(seen, toolDigest());
    let reply: ModelReply;
    try {
      reply = await askModel(deps.endpoint, messages, AbortSignal.timeout(deps.timeoutMs));
    } catch (err) {
      return { kind: "failed", turns: [question], rows: rowsOfError(err) };
    }
    if (reply.kind === "text") {
      return { kind: "ok", turns: [...seen.slice(-1), { kind: "assistant", text: reply.text }], effects: [] };
    }
    // ⚠️ **校验失败要说出来**而不是当作没听见：模型挑了一条本包没有的命令时，
    // 静默丢掉的话屏上只有一句「模型没有挑出任何命令」，而用户不知道自己那句问话被谁驳回了
    let command: Command;
    try {
      command = commandOfReply(reply.line);
    } catch (err) {
      return { kind: "failed", turns: [question], rows: rowsOfError(err) };
    }
    const result = await exec(command, deps.execDeps);
    // ⚠️ **只把结果**放回对话（**不放那条命令**）：`messagesOf` 刻意只取 `user`/`assistant` 两档
    seen.push({ kind: "tool-result", rows: result.rows });
    if (result.rows.length === 0) {
      // ⚠️ 一条**没有输出**的命令（纯界面动作，如 `/new`）就此打住：再问一轮模型只会让它重挑同一条
      return {
        kind: "ok",
        turns: [...seen.slice(-2), { kind: "assistant", text: roundLine(result.effects) }],
        effects: result.effects,
      };
    }
  }
  return { kind: "failed", turns: [question], rows: TOO_MANY_ROUNDS };
}

/** 「没配 provider」那一档（⚠️ 文案里说清楚怎么配，而不是只说「失败了」） */
const NO_PROVIDER: readonly LogRow[] = [
  { kind: "note", text: "还没配模型 provider —— /provider set <地址> <模型名> <凭据> 配一个再问" },
];

/** 一条命令跑完、而模型**没再接着说话**时的那一句（⚠️ 判据是**屏上此刻真的有什么**） */
// ⚠️ 那一格**先于**副作用落桶（`turns` 在 `effects` 之前 push），故它只能指向**下面**或说「没有输出」
function roundLine(effects: readonly Effect[]): string {
  return effects.some((one) => one.kind === "batch") ? BATCH_ROUND : QUIET_ROUND;
}

/** `/batch` 那一档（⚠️ 它是**唯一一个零行却异步产出 N 份行**的命令，而那 N 份在**这句之后**才落桶） */
const BATCH_ROUND = "（这条命令在每一台控制面上的结果在下面几行）";

/** 纯界面动作那一档（⚠️ 零行**且不留痕** ⇒ 上面本来就没有任何输出，说「上面是结果」是假事实） */
const QUIET_ROUND = "（这条命令没有输出行 —— 它做的事直接体现在界面上）";

/** 转了 {@link MAX_ROUNDS} 圈还没停（⚠️ **必须说出来**：否则屏上只有一条命令的结果，而用户以为是模型放弃了） */
const TOO_MANY_ROUNDS: readonly LogRow[] = [
  { kind: "err", text: `模型连着挑了 ${String(MAX_ROUNDS)} 轮命令还没给出答案，这一圈到此为止` },
];

function rowsOfError(err: unknown): readonly LogRow[] {
  if (err instanceof ModelError) {
    return [
      { kind: "err", text: `模型这一侧失败（${err.code}）：${err.message}` },
      { kind: "note", text: "这句话没有被执行成任何命令" },
    ];
  }
  // ⚠️ **刻意不转述 `err.message`**：那串来自某一层，可能顺手带出请求体里的用户输入
  return [{ kind: "err", text: "这一圈出了本包未预期的错误（不是模型的回答，请查本包的问题）" }];
}