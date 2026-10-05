/**
 * @fileoverview 台账的**落盘**面：台账、会话（含它选的模型）、侧边栏清单、对话，以及给界面看的那份打码形态；⚠️ **token 明文入库是结论不是疏忽**（防线是 `0600` 库 + `0700` 目录 + 位置约定）
 */

import fs from "node:fs";
import type { LogEntry } from "@/lib/log/index.js";
import { decodeTurns, encodeTurns } from "@/lib/log/index.js";
import type { SidebarEntry, SessionRecord } from "@/store/index.js";
import type { LedgerDb } from "./db.js";
import { openLedgerDb } from "./db.js";
import {
  deleteAllMessages,
  deleteMessagesBelow,
  deleteSessionRow,
  deleteSidebarRow,
  insertMessageRow,
  insertSessionRow,
  insertSidebarRow,
  readMessageRows,
  readSelected,
  readSessionModelRow,
  readSessionRows,
  readSidebarRows,
  readTargets,
  renameSessionRow,
  writeSelected,
  writeSessionModelRow,
  writeTargets,
} from "./tables.js";
import { LedgerError, validateLedger, validateSessionModelRef } from "./validate.js";
import type { Ledger, ReasoningEffort, SessionModelRef, Target } from "./types.js";
import { DEFAULT_REASONING_EFFORT } from "./types.js";

/** 打码后的 token 占位符（⚠️ **绝不**返回「前 4 位 + 星号」：短 token 的前 4 位足以让穷举空间小到几次尝试） */
export const REDACTED_TOKEN = "••••";

/**
 * 可以放心显示的端点
 * @description 与 {@link Target} 同形，**除了** `token`：那一位是 {@link REDACTED_TOKEN} 或空串。做成一个
 * 独立类型是为了让「界面拿到的东西」与「真凭据」在类型上就分得开。
 */
export interface TargetView extends Omit<Target, "token"> {
  /**
   * 台账里有凭据时恒为 {@link REDACTED_TOKEN}；**空串保持空串**（不是星号）
   * @description 「没配」与「配了但不给你看」是两种不同的事实，渲染成同一个值等于让用户看不出自己配的东西
   * 到底有没有被读进来。
   */
  readonly token: string;
}

/** 空台账（⚠️ 每次现造：共享同一个对象会让调用方的引用判据失灵） */
function emptyLedger(): Ledger {
  return { version: 1, selected: null, targets: [] };
}

function rejectUnreadable(message: string): never {
  throw new LedgerError("unreadable", message);
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 库里那一行行长什么样 → 台账那份形状（⚠️ **原样透传**：判据点名的是台账上的字段名，故那一步归 `./validate.js`） */
function rawLedger(db: LedgerDb): unknown {
  // ⚠️ 次序 **targets 在 selected 之前**（与 `./validate.js` 的次序一致）：`targets` 先坏时报的是它，不是它下游那个引用
  return { targets: readTargets(db), selected: readSelected(db), version: 1 };
}

/**
 * 读台账
 * @description **库不存在 ⇒ 空台账**（首次启动，且本函数**不**因此创建那个库）；**存在但打不开 / 校验不过 ⇒ 抛**
 * {@link LedgerError} `unreadable`，绝不降级成空台账 —— 那会让下一次写把整份真配置清空。
 * @param file 库文件路径（由 `./path.ts:dbPath` 给出）
 * @throws {LedgerError} `unreadable`：库打不开 / 表的列不对 / 形状不对
 */
export function readLedger(file: string): Ledger {
  // ⚠️ 「看一眼配置」不该在磁盘上留痕迹：痕迹会让下一次「库在不在」这个判断失去意义
  if (!fs.existsSync(file)) return emptyLedger();
  const db = openLedgerDb(file);
  let raw: unknown;
  try {
    raw = rawLedger(db);
  } catch (err) {
    rejectUnreadable(`台账读不出来（${file}）：${why(err)}`);
  }
  try {
    return validateLedger(raw);
  } catch (err) {
    rejectUnreadable(`台账形状不对（${file}）：${why(err)}`);
  }
}

/**
 * 写台账（一个事务）
 * @throws {LedgerError} `unreadable`：形状不对（拒写）/ 库写不出去
 */
export function writeLedger(file: string, ledger: Ledger): void {
  // ⚠️ 落盘的字节恒是校验过的形态，故校验**先**于开事务
  // ⚠️ 一次写里「清单 + `selected`」必须同时生效：分两次提交会留一个「清单换了而 `selected` 还指着
  // 已删的那条」的窗口 —— 那份台账就再也读不出来了
  const checked = validateLedger(ledger);
  const db = openLedgerDb(file);
  try {
    db.run("BEGIN");
  } catch (err) {
    rejectUnreadable(`台账写不出去（${file}）：${why(err)}`);
  }
  try {
    writeTargets(db, checked.targets);
    writeSelected(db, checked.selected);
    db.run("COMMIT");
  } catch (err) {
    try {
      db.run("ROLLBACK");
    } catch {
      // 回滚失败不盖掉原来那个错：它才是这次写真正的原因
    }
    rejectUnreadable(`台账写不出去（${file}）：${why(err)}`);
  }
}

/** 落盘的**全部**历史会话（⚠️ 库不存在 ⇒ 空清单且**不**因此创建那个库；「在不在侧边栏上」是 {@link readSidebar} 那一问） */
export function readSessions(file: string): readonly SessionRecord[] {
  if (!fs.existsSync(file)) return [];
  try {
    return readSessionRows(openLedgerDb(file));
  } catch (err) {
    rejectUnreadable(`会话清单读不出来（${file}）：${why(err)}`);
  }
}

/** 新增一个会话（⚠️ `id` 撞了就是撞了：一个会话被记两遍会让「切到会话 2」有两种答案） */
export function saveSession(file: string, record: SessionRecord): void {
  try {
    insertSessionRow(openLedgerDb(file), record);
  } catch (err) {
    rejectUnreadable(`会话存不进去（${file}）：${why(err)}`);
  }
}

/** 改一个会话的名字（改一个不存在的 `id` 是一次成功的 no-op，与 `removeTarget` 同一条纪律；⚠️ **不动它的对话** —— 改名字不是改内容） */
export function renameSession(file: string, id: string, name: string, at: number): void {
  try {
    renameSessionRow(openLedgerDb(file), id, name, at);
  } catch (err) {
    rejectUnreadable(`会话改名存不进去（${file}）：${why(err)}`);
  }
}

/** 一次事务里做几件事；⚠️ 整个目录里**只有这里**开事务 —— 「几件事必须同时生效」的那个窗口不许散在调用方 */
export function transact(file: string, what: string, work: (db: LedgerDb) => void): void {
  const db = openLedgerDb(file);
  try {
    db.run("BEGIN");
  } catch (err) {
    rejectUnreadable(`${what}（${file}）：${why(err)}`);
  }
  try {
    work(db);
    db.run("COMMIT");
  } catch (err) {
    try {
      db.run("ROLLBACK");
    } catch {
      // 回滚失败不盖掉原来那个错：它才是这次写真正的原因
    }
    rejectUnreadable(`${what}（${file}）：${why(err)}`);
  }
}

/** 删一个会话**连同它在侧边栏上的那一行与它的全部对话**（删一个不存在的 `id` 是一次成功的 no-op） */
// ⚠️ **三张表必须同时消失**：`sessions` / `messages` 的不一致是**可能存在的真实状态**（写盘失败、库被人动过），
// 而只删 `sessions` 那一行的话，库里会攒出一堆指向已删会话的孤儿消息
export function removeSession(file: string, id: string): void {
  transact(file, "会话删不掉", (db) => {
    deleteSidebarRow(db, id);
    deleteAllMessages(db, id);
    deleteSessionRow(db, id);
  });
}

/** 把一个会话激活进侧边栏（⚠️ 再激活同一个 `id` 与一个不存在的 `id` 都是成功的 no-op；⚠️ **不碰 `sessions`** —— 激活不是新建会话，也不动 `updated_at`） */
export function pinSession(file: string, sessionId: string, at: number): void {
  try {
    insertSidebarRow(openLedgerDb(file), sessionId, at);
  } catch (err) {
    rejectUnreadable(`侧边栏存不进去（${file}）：${why(err)}`);
  }
}

/** 把一个会话从侧边栏摘下来（**对话留着**：摘下不是删掉；摘一个不在清单上的 `id` 是一次成功的 no-op） */
export function unpinSession(file: string, sessionId: string): void {
  try {
    deleteSidebarRow(openLedgerDb(file), sessionId);
  } catch (err) {
    rejectUnreadable(`侧边栏删不掉（${file}）：${why(err)}`);
  }
}

/** 落盘的侧边栏清单（⚠️ 顺序恒等于激活顺序；库不存在 ⇒ 空清单，且**不**因此创建那个库） */
export function readSidebar(file: string): readonly SidebarEntry[] {
  if (!fs.existsSync(file)) return [];
  try {
    return readSidebarRows(openLedgerDb(file));
  } catch (err) {
    rejectUnreadable(`侧边栏清单读不出来（${file}）：${why(err)}`);
  }
}

/** 追加若干格对话（⚠️ 一次事务，`entries` 是**新追加**的那几格；`seq` 取 `LogEntry.id`、`at` 取 `LogEntry.at`，本层不读时钟） */
/** ⚠️ 同一个 `seq` 记两遍即抛（新增与覆盖是两个入口，`unreadable`） */
export function appendMessages(file: string, sessionId: string, entries: readonly LogEntry[]): void {
  if (entries.length === 0) return;
  transact(file, "对话存不进去", (db) => {
    for (const one of entries) insertMessageRow(db, sessionId, one, encodeTurns(one.turns));
  });
}

/** 环形缓冲丢掉最老的那些之后收口（`seq < belowSeq` 整条删掉；⚠️ 下界就是桶里第一格的 `id`，落盘这份必须跟着内存那份一起收） */
export function trimMessages(file: string, sessionId: string, belowSeq: number): void {
  transact(file, "对话收口失败", (db) => deleteMessagesBelow(db, sessionId, belowSeq));
}

/** 清掉一个会话的全部对话（结果区被清空，盘上那一份也该空；清一个本来就空的是成功的 no-op） */
export function clearMessages(file: string, sessionId: string): void {
  transact(file, "对话清不掉", (db) => deleteAllMessages(db, sessionId));
}

/**
 * 读回一个会话的全部对话，按 `seq` 升序（@throws {LedgerError} `unreadable`：字节不是校验过的形态时；⚠️ **绝不降级成空对话** —— 一次坏数据会看起来像「这个会话还没说过话」）
 */
export function readMessages(file: string, sessionId: string): readonly LogEntry[] {
  if (!fs.existsSync(file)) return [];
  try {
    return readMessageRows(openLedgerDb(file), sessionId).map((row) => entryOf(row));
  } catch (err) {
    rejectUnreadable(`对话读不出来（${file}）：${why(err)}`);
  }
}

/** 一行 → 一格对话（⚠️ `seq` / `at` 必须是整数，而 `turns` 必须解得出一个 `Turn` —— 三样都拒，绝不猜） */
// ⚠️ 文案**只点名那一列**：载荷可能是一句用户聊天消息，而错误文案会进可滚动的结果区
function entryOf(row: Record<string, unknown>): LogEntry {
  const seq = row["seq"];
  const at = row["at"];
  const turns = row["turns"];
  if (typeof seq !== "number" || !Number.isInteger(seq)) throw new Error("messages.seq 必须是整数");
  if (typeof at !== "number" || !Number.isInteger(at)) throw new Error("messages.at 必须是整数");
  if (typeof turns !== "string") throw new Error("messages.turns 必须是字符串");
  return { id: seq, at, turns: decodeTurns(turns) };
}

/**
 * 一个会话选的模型与推理强度（**单独一查**：那两列不住在会话的身份定义里）
 * @description 库不存在 / 那一行不在 ⇒ 「没选 + 缺省档」；`reasoning` 是闭集里的一档，读出来是别的值就**拒**
 */
export function readSessionModels(file: string, sessionId: string): SessionModelRef {
  const blank: SessionModelRef = { modelRef: null, reasoning: DEFAULT_REASONING_EFFORT };
  if (!fs.existsSync(file)) return blank;
  try {
    const row = readSessionModelRow(openLedgerDb(file), sessionId);
    return row === undefined ? blank : validateSessionModelRef(row);
  } catch (err) {
    rejectUnreadable(`会话的模型选择读不出来（${file}）：${why(err)}`);
  }
}

/** 换掉一个会话选的模型与推理强度（⚠️ 改一个不存在的 `id` 是**成功的一次 no-op**，与 `renameSession` 同族） */
export function writeSessionModel(
  file: string,
  sessionId: string,
  ref: string | null,
  reasoning: ReasoningEffort,
): void {
  // ⚠️ 落盘的字节恒是校验过的形态，故校验**先**于那次写
  const checked = validateSessionModelRef({ modelRef: ref, reasoning });
  try {
    writeSessionModelRow(openLedgerDb(file), sessionId, checked.modelRef, checked.reasoning);
  } catch (err) {
    rejectUnreadable(`会话的模型选择存不进去（${file}）：${why(err)}`);
  }
}

/** 给界面看的那份端点（**唯一的打码出口**，理由见 {@link REDACTED_TOKEN}） */
export function redactTarget(target: Target): TargetView {
  const { token, ...rest } = target;
  return { ...rest, token: token === "" ? "" : REDACTED_TOKEN };
}