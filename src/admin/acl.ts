/**
 * @fileoverview `proxy-cli acl ...`：访问控制名单的读与改
 * @module admin/acl
 * @description
 * 名单是**一份文档、一次判定的量**（`@/datasource/acl/types.ts` 的定位），所以本模块**没有**
 * 「加一条 / 删一条」这种接口——它做的是：读整份 → 在内存里改一个格子 → 整份写回。
 *
 * 写回之前那份整份结果会再过一次 `validateAcl`（在 `JsonAclSource.write` 里），因此
 * **「写得进去、读不出来」在这条路径上不存在**。这也正是本工具相对「人手编辑 acl.json」的全部
 * 价值：后者要等到下一个请求周期（最多 1s 后）才发现写坏了，而那时候的表现是
 * 「保留上一份有效值 + 一条告警」——**错误是在运行期、而不是在按回车那一刻**被发现的。
 *
 * ⚠️ **写不是事务**：`AclSource.write` 的实现是「读-改-整份重写」，两个 `proxy-cli` 同时跑，
 * 或一个 CLI 与一次人工编辑同时发生，后落盘的那份不含前一份的改动。这是「用文本文件当数据库」
 * 的固有代价，`@/utils/json-file:writeJsonAtomic` 的文件头有完整论证。
 *
 * @module
 */

import type { AclConfig } from "@/datasource/acl/index.js";
import { parseHostRule, parseIpRule } from "@/config/files/rules/index.js";
import { aclGroupKey, type AclGroupName, type AdminCommand } from "./args.js";
import { readAclOrFail, requireAclWrite, type AdminSources } from "./context.js";
import { AdminError, renderTable, type AdminIo } from "./out.js";

/** 三个组在 `user list` 之外按**判定语义**分组呈现（clientIp 看来源、target 看目标、upstream 看路由） */
const GROUP_ORDER = ["clientip", "target", "upstream"] as const;

/**
 * 这一个组收哪种条目语法
 * @description
 * 与 `validateAcl` 内部那份**逐字相同**的分派（`clientIp` 只收 IP/CIDR，另两组收 IP/CIDR/域名/
 * `*.通配域名`）——判据本体是 `parseIpRule` / `parseHostRule` 这两个共用原语，**本模块不重写它**。
 *
 * 这份分派存在的理由只有一个：**让错误信息能点名是哪个条目**。整份校验（`AclSource.write` 里那次）
 * 只会说「形状非法」，而命令行的用户需要知道**他刚敲的那一串**哪里不对。
 */
function entryRule(group: AclGroupName): (entry: string) => boolean {
  return group === "clientip"
    ? (entry) => parseIpRule(entry) !== undefined
    : (entry) => parseHostRule(entry) !== undefined;
}

/** 那个组可用的条目语法的一句话说明（错误信息里要给「正确写法长什么样」） */
function syntaxHint(group: AclGroupName): string {
  return group === "clientip"
    ? "clientip 只收 IP 或 CIDR（如 10.0.0.0/8、1.2.3.4），不收域名"
    : "收 IP / CIDR / 域名 / *.通配域名（如 example.com、*.cdn.io），不支持端口、不做 DNS";
}

/** `proxy-cli acl ...` 的执行面 */
export function runAclCommand(
  io: AdminIo,
  sources: AdminSources,
  command: Extract<AdminCommand, { kind: "acl" }>,
): void {
  if (command.op === "show") {
    const acl = readAclOrFail(sources.acl);
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

  // ── 写 ──
  // ⚠️ **先校验那一个条目、再取写面**：顺序是刻意的。条目判据必须在**任何 IO 与写入之前**给出一条
  // 点名到「你刚敲的那一串」的错误；等整份名单被判非法才报错的话，用户拿到的是
  // 「形状非法」四个字，对着三个组的六个数组猜是哪个错。
  if (!entryRule(command.group)(command.entry)) {
    throw new AdminError(`条目 ${command.entry} 不合法：${syntaxHint(command.group)}`);
  }
  // 只读驱动在这里拒绝：那份名单改不了，说这句话比「先读一遍发现名单也是坏的」更切题
  const write = requireAclWrite(sources.acl);
  const current = readAclOrFail(sources.acl);

  // ⚠️ **不原地改 `readAclOrFail` 的返回值**。文件缺失 / 读不到时它返回的是模块级**冻结哨兵**
  // `EMPTY_ACL`，对它做 `group[list] = [...]` 在严格模式（ESM 与打包产物都是严格模式）下直接抛
  // `TypeError`。造一份新对象顺带让「本次改动只影响那一个格子」在类型上成立。
  const acl: AclConfig = {
    clientIp: { ...current.clientIp },
    target: { ...current.target },
    upstream: { ...current.upstream },
  };
  const group = acl[aclGroupKey(command.group)];
  const entries = group[command.list];

  if (command.op === "add") {
    if (entries.includes(command.entry)) {
      io.changed(`${command.group}.${command.list} 里已经有 ${command.entry}，没动`);
      return;
    }
    group[command.list] = [...entries, command.entry];
  } else {
    if (!entries.includes(command.entry)) {
      io.changed(`${command.group}.${command.list} 里没有 ${command.entry}，没动`);
      return;
    }
    group[command.list] = entries.filter((e) => e !== command.entry);
  }

  write(acl);
  io.changed(
    `已${command.op === "add" ? "加入" : "移出"} ${command.group}.${command.list}: ${command.entry}`,
  );
  io.warn("生效时间：运行中的代理最迟 1 秒后读到（判定期走 mtime 节流），无需重启");
}
