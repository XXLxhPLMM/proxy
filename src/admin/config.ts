/**
 * @fileoverview `proxy-cli config show`：此刻**正在操作哪三份数据**
 * @module admin/config
 * @description
 * 「按 env 文件决定操作哪个数据源」这件事**必须可核对**：一条命令改的是哪份文件、哪个库，
 * 不该靠「我以为 `.env` 里是这么写的」。所以本命令把 `@/ops` 取来的那份结构化报告**原样排版**
 * 打出来——驱动名 + 解析后的绝对路径（不是 env 文件里那个相对串）、配置目录、读了哪些 env 文件、
 * 鉴权开关、配额窗口口径与落盘周期。
 *
 * 事实的**取法**（哪份接线、哪个驱动名、为什么账本那行只给目录）在 `../ops/report.ts` 文件头；
 * **键名、顺序、模板与缩进**全在这一侧，因为它们是呈现：换个界面就该重打一遍，而不是让数据层
 * 替界面排版。
 *
 * @module
 */

import { reportConfig, type OpsSources } from "@/ops/index.js";
import type { AdminCommand } from "./args.js";
import { renderPairs, type AdminIo } from "./out.js";

/** `proxy-cli config show` 的执行面 */
export function runConfigCommand(
  io: AdminIo,
  sources: OpsSources,
  command: Extract<AdminCommand, { kind: "config" }>,
): void {
  if (command.op !== "show") {
    return;
  }
  const report = reportConfig(sources);

  const pairs: (readonly [string, string])[] = [
    ["配置目录", report.configDir],
    ["env 文件", report.envFiles.join(", ") || "(无)"],
    ["账号表", `驱动 ${report.accounts.driver} → ${report.accounts.path}`],
    ["名单", `驱动 ${report.acl.driver} → ${report.acl.path}`],
    ["用量账本", `驱动 ${report.usage.driver} → ${report.usage.dir}（文件名由驱动决定，跑 proxy-cli usage show 看确切位置）`],
    ["鉴权", `${report.auth.enabled ? "开" : "关"} / ${report.auth.type}`],
    [
      "配额窗口",
      `quotaResetHour=${report.quotaResetHour}（本地时区），缺省窗口 ${report.defaultQuotaWindow}`,
    ],
    ["落盘周期", `${report.flushIntervalMs}ms`],
  ];
  io.write(renderPairs(pairs));
  io.warn(
    "每用户 quota / expiresAt / disabled 本身写在账号表里，不在本文件（见 proxy-cli user list）",
  );
}