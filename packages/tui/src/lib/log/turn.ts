/**
 * @fileoverview 对话模型：输出桶里的一格是**一个 `Turn`**，而 `LogRow` 只是它排版后的形状；⚠️ 变体靠 `kind` 判别，**不许**靠字符串嗅探
 */

import type { LogRow } from "./rows.js";

/** 一格对话（⚠️ **它不是 `LogRow`**：那一层答「画成什么形状」，这一层答「这是什么」） */
export type Turn =
  /** 操作者敲进来的**不以 `/` 开头**的那一行（普通聊天消息） */
  | { readonly kind: "user"; readonly text: string }
  /** 模型的一句话（⚠️ **逐字上屏**：改写它等于让操作者读到一句模型没说过的话） */
  | { readonly kind: "assistant"; readonly text: string }
  /** 模型决定跑的那条命令（⚠️ `echo` 恒为**掩码之后**那一份，由 `@/lib/exec` 的回显边界造） */
  | { readonly kind: "tool-call"; readonly echo: LogRow }
  /** 那条命令的输出行（表 / 键值对都在里面 —— 那是控制面的回答，与「谁说的」无关） */
  | { readonly kind: "tool-result"; readonly rows: readonly LogRow[] }
  /** 本包自己说的一句（存盘结果、显隐结果、「现在没有控制面」） */
  // ⚠️ **不能塞进 `error`**：拒绝不是故障，染上危险色就是一句假事实
  | { readonly kind: "notice"; readonly rows: readonly LogRow[] }
  /** 一次失败（解析 / 逐字段校验 / 对面 / provider） */
  | { readonly kind: "error"; readonly rows: readonly LogRow[] };

/** 一个 `Turn` → 若干 `LogRow`（⚠️ **按 `kind` 穷举**：漏一档时 `tsc` 就红，`default` 那支形参是 `never`） */
export function rowsOfTurn(turn: Turn): readonly LogRow[] {
  switch (turn.kind) {
    case "user":
      // ⚠️ **不并进 `echo`**：屏上必须分得开哪一条**会被执行**，而按字形分就得去嗅探字符串 ——
      // `❯ /providers` 那条命令恰好是**要执行**的那一条。呈现层按 `kind` 分派（气泡 vs 一色一行）
      return [{ kind: "user", text: turn.text }];
    case "assistant":
      return [{ kind: "note", text: turn.text, tone: "ok" }];
    case "tool-call":
      return [turn.echo];
    case "tool-result":
      return turn.rows;
    case "notice":
      return turn.rows;
    case "error":
      return turn.rows;
    default:
      return unrenderableTurn(turn);
  }
}

/** 这个 `Turn` 没有排版形状 —— **一个应该不可达的分支**；形参 `turn: never` 不可省，它是那条编译期锁的**全部**机制 */
function unrenderableTurn(turn: never): never {
  throw new Error(`结果区不认识这个对话变体：${JSON.stringify(turn)}`);
}