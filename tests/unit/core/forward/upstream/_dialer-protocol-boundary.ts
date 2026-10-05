/**
 * `upstream/` 四档 + `channel/` 一档共用的「读 `src/core/forward/` 原文」那一面
 *
 * @description
 * 收件门槛是「**两个以上档真用到**」：`forwardSourceOf` 被 `dial-boundary` /
 * `socks-reply-text` / `channel/no-protocol-branch` 三档用，`SOCKS_REPLY_ERRORS` 被前两档用。
 * 只被一档用到的常量留在那一档文件头（`PUBLIC_METHODS` / `OWN_METHODS` / `MOVED_OUT` /
 * `NODE_TRANSPORT_API` / `PROTOCOL_WORDS` / `CHANNEL_PROTOCOL_CALLS` 各只服务一档）。
 * ⚠️ `channel/` 那一档经 `../upstream/…` 引本模块 —— 方向与 `src/` 一致（channel → upstream），
 * 且本模块是测试内部的 `_` 前导件、不对外承诺任何面。
 * ⚠️ 本模块刻意住在 `tests/unit/` 里面而不是 `tests/helpers/`：后者不在零外网扫描的
 * `SCAN_DIRS` 里，前导搬进去等于让那道护栏对这部分代码彻底失效且一声不吭。
 */
import fs from "node:fs";
import path from "node:path";
import { SRC_DIR } from "../../../../helpers/source-scan.js";

/**
 * `src/core/forward/` 下某个文件的原文（按轴分目录：`channel/` 与 `upstream/`）
 *
 * @description 路径从 `SRC_DIR` 派生，**不数 `..`**：多一个 `..` 会让源码扫描枚举到空集而恒绿，
 * 而这三条负向断言的判据面正是这些源码（扫空了就全绿）。
 */
export function forwardSourceOf(...segments: string[]): string {
  return fs.readFileSync(path.join(SRC_DIR, "core", "forward", ...segments), "utf8");
}

/** `readReply` 的两条报错文案：**落盘日志文本的一部分，逐字不可改** */
export const SOCKS_REPLY_ERRORS = ["socks upstream closed before reply", "socks reply timeout"];
