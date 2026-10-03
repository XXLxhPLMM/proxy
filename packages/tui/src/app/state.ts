/**
 * @fileoverview 应用状态层的**形状与常量**（零逻辑、零 React、零终端）
 * @module app/state
 * @description
 * 「一个跨帧状态由哪些字段组成」与几个数字常量。改这些字段等于改屏上的形状，故每条都带为什么。
 */

import type { Command } from "@/cmd/index.js";
import type { LogEntry } from "@/log/index.js";

/** 每个会话里保留多少条输出条目（**环形缓冲**，不是审计日志）：理由在 `@/log/index.js:trim` 文件头 */
export const LOG_KEEP = 2000;

/** 滚轮 / 翻页一次滚几行（三行 ≈ 一段话，且不至于一滚就穿过整个屏幕） */
export const SCROLL_STEP = 3;

/** 输入区中间那一行给一条瞬时消息停留多久（毫秒）。⚠️ 它必须会自己消失，且**不是**历史的唯一去处 */
export const MESSAGE_TTL_MS = 8000;

/** 兜底的终端行数（`process.stdout.rows` 拿不到时；`24` 是几乎所有终端都至少有的高度） */
export const FALLBACK_ROWS = 24;

/**
 * 一个输出桶：条目 + 滚动位置 + 「贴不贴底」
 * @description 三个字段住在**同一个对象**里：贴底判定需要追加前与追加后两个高度，而它们必须与
 * 那一次追加**原子地**算出来。
 */
export interface Bucket {
  readonly entries: readonly LogEntry[];
  /** 顶行号（行，0 起）。**读的时候还要再夹一次**，改窗口高度会让它越界 */
  readonly top: number;
  /** 是否贴底。`false` = 操作者往上翻过，于是新输出**不**把他拽回去 */
  readonly follow: boolean;
}

/** 空的桶（**每个会话一个**，不能共享同一个对象：`setState` 靠引用变化判断） */
export function emptyBucket(): Bucket {
  return { entries: [], top: 0, follow: true };
}

/**
 * 一个会话（本包**唯一的**「上下文」单元）
 * @description ⚠️ 输出桶、输入行、`targetId` **三样同生共死**：反过来（把当前控制面做成全局状态、
 * 只按会话切输出桶）会造出一个**说谎的组合** ——「切到会话 2，看到的是会话 1 那台机器的结果」，
 * 而结果区里那些行**不显示**打给谁。
 * ⚠️ **台账本身不在会话里**（`./app.tsx:ledgerRef` / `@/ledger`）：它是所有会话共享的「一份链接
 * 清单」，在会话里存第二份就是「两个会话各自有一份台账」这个整类 bug 的产地。
 */
export interface Session {
  readonly id: string;
  readonly name: string;
  /** 这个会话连的是哪个控制面（`null` = 还没选；⚠️ **不认台账的 `selected`**，那是「上次用的」） */
  readonly targetId: string | null;
  readonly bucket: Bucket;
  readonly input: string;
  /** 插入符位置（**UTF-16 code unit 下标**，与 `./input-line.js` 同一套） */
  readonly cursor: number;
}

/** 造一个新会话（⚠️ 每个键一个全新的对象：`setState` 靠引用变化判断） */
export function newSession(id: string, name: string): Session {
  return { id, name, targetId: null, bucket: emptyBucket(), input: "", cursor: 0 };
}

/** 一条排队中的命令（**已经解析完**，故队列里不含任何需要 `try` 的东西） */
export interface Job {
  /** 这一条属于哪个会话（⚠️ 落盘与渲染都按它，故它必须在**排队那一刻**定下来） */
  readonly sessionId: string;
  /** 用户敲的原文（回显用） */
  readonly line: string;
  readonly command: Command;
}

/** 模态窗口当前是哪一个（`null` = 没开）。⚠️ 只有一个窗口而它是**联合**，不是 `boolean` */
export type WindowKind = "managers" | null;

/** 只改当前会话的输入行 / 插入符（键位与鼠标**分头写**同一个会话，故它们共用这三个写入口） */
export type InputPatch = Partial<Pick<Session, "input" | "cursor">>;

/** 拿**最新**状态算出来的那一改 */
export type EditActive = (
  change: (text: string, cursor: number) => { text: string; cursor: number },
) => void;

/** 同 {@link EditActive}，但只改插入符（`←` `→` `Home` `End`） */
export type CaretActive = (pick: (text: string, cursor: number) => number) => void;

/** 写死的那一改（补全已算好的结果 / `Esc` 清行 / 鼠标点输入行定位插入符） */
export type FillActive = (patch: InputPatch) => void;
