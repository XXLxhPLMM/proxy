/**
 * @fileoverview `proxy-cli acl ...`：访问控制名单的呈现面
 * @module admin/acl
 * @description
 * 本文件**只做两件事**：把命令派发到 `@/ops` 的名单操作、把结果排版。条目语法判据、读整份改
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
import { renderSections, type AdminIo } from "./out.js";

/** 三个组在 `user list` 之外按**判定语义**分组呈现（clientIp 看来源、target 看目标、upstream 看路由） */
const GROUP_ORDER = ["clientip", "target", "upstream"] as const;

/** 两个名单方向的呈现顺序（白在前；白名单是常配的那一半，先列它） */
const LIST_ORDER = ["whitelist", "blacklist"] as const;

/** `proxy-cli acl ...` 的执行面 */
export function runAclCommand(
  io: AdminIo,
  sources: OpsSources,
  command: Extract<AdminCommand, { kind: "acl" }>,
): void {
  if (command.op === "show") {
    const acl = readAcl(sources);
    // ⚠️ **小节而不是一张表**：一个格子塞下整份名单时，那行宽过终端就会软换行，而组名列只在**第一**
    // 视觉行上——「这条在哪个名单里」于是答不出来。一条目一行（`renderSections`）时归属就在上面
    // 那一行，且**行宽与名单规模无关**。
    io.write(
      renderSections(
        GROUP_ORDER.flatMap((group) =>
          LIST_ORDER.map((list) => ({
            title: `${group}.${list}`,
            items: acl[aclGroupKey(group)][list],
          })),
        ),
      ),
    );
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