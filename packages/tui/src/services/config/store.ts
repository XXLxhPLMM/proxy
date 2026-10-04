/**
 * @fileoverview 台账的**落盘**面：读、写、以及给界面看的那份打码形态；⚠️ **token 明文落盘是结论不是疏忽**（防线是 `0600` + `0700` + 位置约定），⚠️ 原子性有真实边界（Windows 的 `rmSync`→`rename` 之间有一个**极短**的「文件不存在」窗口；**并发写会互相覆盖**）
 */

import fs from "node:fs";
import path from "node:path";
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

/** 落盘的权限位：目录只给属主、文件只给属主读写（POSIX） */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** 「这个路径不存在」的那一类 errno（不是所有读失败都是「不存在」，故只看这一个码） */
function isMissing(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** 能收紧就收紧，收紧不了不拦人 */
// ⚠️ **失败一律吞掉**：权限位会被 mount 选项、容器卷、别人的目录挡住，而挡住的是「加固」不是「功能」。
function harden(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // 加固失败不拦人：理由见本函数说明
  }
}

/**
 * 读台账
 * @description **文件不存在 ⇒ 空台账**（首次启动，且本函数**不**因此创建那个文件）；**存在但 parse /
 * 校验失败 ⇒ 抛** {@link LedgerError} `unreadable`，绝不降级成空台账 —— 那会让下一次写把整份真配置清空。
 * @param file 台账文件路径（由 {@link ./path.ts:targetsPath} 给出）
 * @throws {LedgerError} `unreadable`：文件读不出来 / 不是 JSON / 形状不对
 */
export function readLedger(file: string): Ledger {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (isMissing(err)) return { version: 1, selected: null, targets: [] };
    rejectUnreadable(`台账文件读不出来：${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    rejectUnreadable(`台账文件不是合法 JSON：${file}`);
  }
  try {
    return validateLedger(parsed);
  } catch (err) {
    if (err instanceof LedgerError) {
      rejectUnreadable(`台账形状不对（${file}）：${err.message}`);
    }
    rejectUnreadable(`台账形状不对（${file}）：${String(err)}`);
  }
}

/** 抛一个 `unreadable` 档的 {@link LedgerError}，并让控制流分析在该处收窄成 `never` */
function rejectUnreadable(message: string): never {
  throw new LedgerError("unreadable", message);
}

/** 写台账（原子）；⚠️ 次序不是随意的：**先 `chmod` 再 `rename`**，反过来会留一个「文件已是 0644 且 token 已在里面」的窗口 */
export function writeLedger(file: string, ledger: Ledger): void {
  const checked = validateLedger(ledger);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  harden(dir, DIR_MODE);

  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(checked, undefined, 2)}\n`, "utf8");
  try {
    harden(tmp, FILE_MODE);
    try {
      fs.renameSync(tmp, file);
    } catch {
      // Windows 的 rename 不能覆盖已存在的目标；先删再 rename 是那一侧的等价替换（代价见文件头）
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    }
  } finally {
    // 成功时是空操作（tmp 已被 rename 走）；失败时收掉那份**含明文 token**的半成品，
    // 而不是把它留在目录里等人（或备份程序）捡走
    fs.rmSync(tmp, { force: true });
  }
}

/** 给界面看的那份端点（**唯一的打码出口**，理由见 {@link REDACTED_TOKEN}） */
export function redactTarget(target: Target): TargetView {
  const { token, ...rest } = target;
  return { ...rest, token: token === "" ? "" : REDACTED_TOKEN };
}