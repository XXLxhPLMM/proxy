/**
 * @fileoverview `proxy-cli config show`：这份 CLI 此刻**正在操作哪三份数据**
 * @module admin/config
 * @description
 * 「按 env 文件决定操作哪个数据源」这件事**必须可核对**：一条命令改的是哪份文件、哪个库，
 * 不该靠「我以为 `.env` 里是这么写的」。所以本命令把三份数据的**驱动名 + 解析后的绝对路径**
 * 原样打出来——路径是 `resolveConfigPaths` 归一之后的最终值，而不是 env 文件里那个相对串。
 *
 * 它打的是**接线**（`accountLocatorFor` / `aclLocatorFor` 现取的那两个闭包），与代理运行时
 * 用的是同一份接线对象。**未注册的驱动在这一步就会抛错**（注册表判据，fail-fast）——那正是
 * 「以为接上了数据库、实际读的是 users.json」这件事唯一能提前暴露的地方。
 *
 * @module
 */

import { quotaWindow } from "@/datasource/quota/index.js";
import type { AdminCommand } from "./args.js";
import type { AdminSources } from "./context.js";
import { renderPairs, type AdminIo } from "./out.js";

/** `proxy-cli config show` 的执行面 */
export function runConfigCommand(
  io: AdminIo,
  sources: AdminSources,
  command: Extract<AdminCommand, { kind: "config" }>,
): void {
  if (command.op !== "show") {
    return;
  }
  const config = sources.config;
  const accountsLocator = sources.accountsLocator;
  const usersDriver = accountsLocator.driver();

  const pairs: (readonly [string, string])[] = [
    ["配置目录", sources.context.configDir],
    ["env 文件", sources.context.sources.envFiles.join(", ") || "(无)"],
    ["账号表", `驱动 ${usersDriver} → ${accountsLocator.pathFor(usersDriver)}`],
    ["名单", `驱动 ${sources.acl.driver} → ${sources.acl.locator()}`],
    ["用量账本", `驱动 ${config.get("quotaUsageDriver")} → ${usageFileHint(sources)}`],
    ["鉴权", `${config.get("authEnabled") ? "开" : "关"} / ${config.get("authType")}`],
    [
      "配额窗口",
      `quotaResetHour=${config.get("quotaResetHour")}（本地时区），缺省窗口 ${quotaWindow(undefined)}`,
    ],
    ["落盘周期", `${config.get("quotaFlushInterval")}ms`],
  ];
  io.write(renderPairs(pairs));
  io.warn(
    "每用户 quota / expiresAt / disabled 本身写在账号表里，不在本文件（见 proxy-cli user list）",
  );
}

/**
 * 账本位置
 * @description
 * ⚠️ **这里只给目录，不给文件名**：文件名的算法住在两个数据源实现器里
 * （`usageDbFileName` / `sharedUsageFileName`），而本工具**不造**那个数据源（造它会带上一整套
 * 规格闭包，而 `config show` 要的只是路径）。要确切文件名就跑一次 `proxy-cli usage show`——
 * 那条命令会真的造出数据源，而账本构造期就纯算出了 `file`。
 *
 * 这条限制是刻意的：为了多打一行而在 `config show` 里造一个数据源，等于让「看一眼配置」这个
 * 无副作用的动作变成「可能建出一个账本文件」。
 */
function usageFileHint(sources: AdminSources): string {
  return `${sources.config.get("quotaUsageDir")}（文件名由驱动决定，跑 proxy-cli usage show 看确切位置）`;
}
