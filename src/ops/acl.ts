/**
 * @fileoverview 访问控制名单的读与改（**结构化结果，零渲染**）
 * @module ops/acl
 * @description
 * 名单是**一份文档、一次判定的量**（`@/datasource/acl/types.ts` 的定位），所以本模块**没有**
 * 「加一条 / 删一条」这种数据库语义的**端口**——它做的是：读整份 → 在内存里改一个格子 → 整份写回。
 *
 * 写回之前那份整份结果会再过一次 `validateAcl`（在 `JsonAclSource.write` 里），因此
 * **「写得进去、读不出来」在这条路径上不存在**。这也正是这份工具相对「人手编辑 acl.json」的
 * 全部价值：后者要等到下一个请求周期（最多 1s 后）才发现写坏了，而那时候的表现是
 * 「保留上一份有效值 + 一条告警」——**错误是在运行期、而不是在按回车那一刻**被发现的。
 *
 * ⚠️ **写不是事务**：`AclSource.write` 的实现是「读-改-整份重写」，两个管理工具同时跑，
 * 或一个工具与一次人工编辑同时发生，后落盘的那份不含前一份的改动。这是「用文本文件当数据库」
 * 的固有代价，`@/utils/json-file:writeJsonAtomic` 的文件头有完整论证。
 *
 * ## 组名词汇为什么住在这里
 *
 * 「三组名单 + 两个方向」是**这份数据的词汇**，不是某个界面的词汇：读写两面都要用它，而把它们
 * 各写一份就是「两处对不上」那条事故的原料。故它归本模块，`@/admin/args.ts` 从这里取。
 *
 * @module
 */

import type { AclConfig } from "@/datasource/acl/index.js";
import { parseHostRule, parseIpRule } from "@/utils/addr/index.js";
import type { OpsChange } from "./change.js";
import { OpsError } from "./error.js";
import { readAclOrFail, requireAclWrite, type OpsSources } from "./sources.js";

/** 名单的三个组（与 `AclConfig` 的键同名，只是 `clientIp` 在命令面上全小写） */
export type AclGroupName = "clientip" | "target" | "upstream";

/** 名单的两个名单方向 */
export type AclListName = "whitelist" | "blacklist";

/** 三组名单名 → `AclConfig` 的键。**唯一**一份映射，两个方向共用它。 */
const GROUP_KEYS: Readonly<Record<AclGroupName, "clientIp" | "target" | "upstream">> = {
  clientip: "clientIp",
  target: "target",
  upstream: "upstream",
};

/** 名单组名 → `AclConfig` 的键 */
export function aclGroupKey(group: AclGroupName): "clientIp" | "target" | "upstream" {
  return GROUP_KEYS[group];
}

/**
 * 这一个组收哪种条目语法
 * @description
 * 与 `validateAcl` 内部那份**逐字相同**的分派（`clientIp` 只收 IP/CIDR，另两组收 IP/CIDR/域名/
 * `*.通配域名`）——判据本体是 `parseIpRule` / `parseHostRule` 这两个共用原语，**本模块不重写它**。
 *
 * 这份分派存在的理由只有一个：**让错误信息能点名是哪个条目**。整份校验（`AclSource.write` 里那次）
 * 只会说「形状非法」，而操作者需要知道**他刚敲的那一串**哪里不对。
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

/** 整份名单（归一化形态，三组两个方向都补齐） */
export function readAcl(sources: OpsSources): AclConfig {
  return readAclOrFail(sources.acl);
}

/** 往一个格子里加一条（**幂等**：已经有了就是 `changed: false`，不报错也不假装成功） */
export function addAclEntry(
  sources: OpsSources,
  group: AclGroupName,
  list: AclListName,
  entry: string,
): OpsChange {
  return mutate(sources, group, list, entry, "add");
}

/** 从一个格子里移走一条（**幂等**：本来就没有就是 `changed: false`，不报错也不假装成功） */
export function removeAclEntry(
  sources: OpsSources,
  group: AclGroupName,
  list: AclListName,
  entry: string,
): OpsChange {
  return mutate(sources, group, list, entry, "remove");
}

/** 加 / 移出共用的一条通路（读-改-整份写回） */
function mutate(
  sources: OpsSources,
  group: AclGroupName,
  list: AclListName,
  entry: string,
  op: "add" | "remove",
): OpsChange {
  // ⚠️ **先校验那一个条目、再取写面**：顺序是刻意的。条目判据必须在**任何 IO 与写入之前**给出一条
  // 点名到「你刚敲的那一串」的错误；等整份名单被判非法才报错的话，操作者拿到的是
  // 「形状非法」四个字，对着三个组的六个数组猜是哪个错。
  if (!entryRule(group)(entry)) {
    throw new OpsError("invalid", `条目 ${entry} 不合法：${syntaxHint(group)}`);
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
  const entries = acl[aclGroupKey(group)][list];

  if (op === "add") {
    if (entries.includes(entry)) {
      return { changed: false, message: `${group}.${list} 里已经有 ${entry}，没动` };
    }
    acl[aclGroupKey(group)][list] = [...entries, entry];
  } else {
    if (!entries.includes(entry)) {
      return { changed: false, message: `${group}.${list} 里没有 ${entry}，没动` };
    }
    acl[aclGroupKey(group)][list] = entries.filter((e) => e !== entry);
  }

  write(acl);
  return {
    changed: true,
    message: `已${op === "add" ? "加入" : "移出"} ${group}.${list}: ${entry}`,
  };
}