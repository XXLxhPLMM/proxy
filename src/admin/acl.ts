/**
 * @fileoverview `proxy-cli acl ...`：访问控制名单的呈现面
 * @module admin/acl
 * @description
 * 本文件**只做两件事**：把命令派发到 `@/ops` 的名单操作、把结果排成表。条目语法判据、读整份改
 * 一格再整份写回、以及「写不是事务」全部在 `../ops/acl.ts` 文件头。
 *
 * ## 为什么 `GROUP_ORDER` 留在这一侧
 *
 * 组的**呈现顺序**（先 clientIp 看来源、再 target 看目标、最后 upstream 看路由）是**给人看的**
 * 编排，不是数据属性：`AclConfig` 三个键的顺序不构成任何语义，把它搬进 ops 等于让数据层替界面
 * 决定读法。数据侧的词汇（组名、组名 → 键的映射）在 ops，**各只有一份**。
 *
 * @module
 */

import {
  aclGroupKey,
  addAclEntry,
  readAcl,
  removeAclEntry,
  type OpsSources,
} from "@/ops/index.js";
import type { AdminCommand } from "./args.js";
import { renderTable, type AdminIo } from "./out.js";

/** 三个组在 `user list` 之外按**判定语义**分组呈现（clientIp 看来源、target 看目标、upstream 看路由） */
const GROUP_ORDER = ["clientip", "target", "upstream"] as const;

/** `proxy-cli acl ...` 的执行面 */
export function runAclCommand(
  io: AdminIo,
  sources: OpsSources,
  command: Extract<AdminCommand, { kind: "acl" }>,
): void {
  if (command.op === "show") {
    const acl = readAcl(sources);
    const rows: string[][] = [];
    for (const group of GROUP_ORDER) {
      const list = acl[aclGroupKey(group)];
      rows.push([
        group,
        "whitelist",
        list.whitelist.length > 0 ? list.whitelist.join(", ") : "-",
        String(list.whitelist.length),
      ]);
      rows.push([
        group,
        "blacklist",
        list.blacklist.length > 0 ? list.blacklist.join(", ") : "-",
        String(list.blacklist.length),
      ]);
    }
    io.write(renderTable(["组", "方向", "条目", "条数"], rows));
    io.warn(`位置：${sources.acl.locator()}（驱动 ${sources.acl.driver}）`);
    return;
  }

  const change =
    command.op === "add"
      ? addAclEntry(sources, command.group, command.list, command.entry)
      : removeAclEntry(sources, command.group, command.list, command.entry);
  io.changed(change.message);
  // ⚠️ **只在真变了的时候说「多久生效」**：幂等 no-op（那条已经在 / 本来就不在）一个字节都没
  // 落盘，说「最迟 1 秒后读到」是在承诺一件没发生的事。
  if (change.changed) {
    io.warn("生效时间：运行中的代理最迟 1 秒后读到（判定期走 mtime 节流），无需重启");
  }
}