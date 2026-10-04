/**
 * @fileoverview 台账的**落盘**面：读、写、会话记账、以及给界面看的那份打码形态；⚠️ **token 明文入库是结论不是疏忽**（防线是 `0600` 库 + `0700` 目录 + 位置约定）
 */

import fs from "node:fs";
import type { SessionRecord } from "@/store/index.js";
import type { LedgerDb } from "./db.js";
import { openLedgerDb } from "./db.js";
import {
  deleteSessionRow,
  insertSessionRow,
  readSelected,
  readSessionRows,
  readTargets,
  renameSessionRow,
  writeSelected,
  writeTargets,
} from "./tables.js";
import { LedgerError, validateLedger } from "./validate.js";
import type { Ledger, Target } from "./types.js";

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

/** 落盘的会话清单（⚠️ 库不存在 ⇒ 空清单，且**不**因此创建那个库） */
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

/** 改一个会话的名字（改一个不存在的 `id` 是一次成功的 no-op，与 `removeTarget` 同一条纪律） */
export function renameSession(file: string, id: string, name: string, at: number): void {
  try {
    renameSessionRow(openLedgerDb(file), id, name, at);
  } catch (err) {
    rejectUnreadable(`会话改名存不进去（${file}）：${why(err)}`);
  }
}

/** 删一个会话（删一个不存在的 `id` 是一次成功的 no-op） */
export function removeSession(file: string, id: string): void {
  try {
    deleteSessionRow(openLedgerDb(file), id);
  } catch (err) {
    rejectUnreadable(`会话删不掉（${file}）：${why(err)}`);
  }
}

/** 给界面看的那份端点（**唯一的打码出口**，理由见 {@link REDACTED_TOKEN}） */
export function redactTarget(target: Target): TargetView {
  const { token, ...rest } = target;
  return { ...rest, token: token === "" ? "" : REDACTED_TOKEN };
}