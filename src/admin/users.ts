/**
 * @fileoverview `proxy-cli user ...`：账号表的呈现面
 * @module admin/users
 * @description
 * 本文件**只做三件事**：把解析出来的命令派发到 `@/ops` 的账号操作、把结构化结果排成表、把
 * `OpsChange.message` 打到「改完了」那条通道。字段保全、`add` 撞名拒绝、`--expires` 的判据
 * 来源、以及「为什么只有整条替换」全部在 `../ops/accounts.ts` 文件头——这里**一个字都不重写**。
 *
 * `user show` 里那些**不止一行**的字段（账号自己的 `acl.target.*` 两张名单）走 `renderSections`
 * 而不是表格的一格，理由与 `acl show` 相同：整份名单挤进一格时行宽随数据规模增长，一软换行
 * 字段列就落在别的视觉行上，「这条免的是哪个目标」当场答不出来。
 *
 * ## 为什么这里仍然有一张「密码怎么显示」的表
 *
 * 打码是**呈现决定**（不是数据事实）：数据源与 ops 交出的是明文密码本身，因为账号表里存的就是
 * 明文，而「怎么不让人在终端里看见」是界面该管的事。把它塞进 ops 就等于让数据层替界面做决定，
 * 而 HTTP 面与 JSON 面都不打码。
 *
 * @module
 */

import type { AuthAccount } from "@/datasource/users/index.js";
import {
  addAccount,
  getAccount,
  listAccounts,
  passwdAccount,
  removeAccount,
  setAccount,
  setAccountEnabled,
  type OpsChange,
  type OpsSources,
} from "@/ops/index.js";
import type { AdminCommand, UserWriteCommand } from "./args.js";
import { formatBytes, renderSections, renderTable, type AdminIo } from "./out.js";

/** 密码的呈现形态：空密码（uid 模式）如实说「空」，非空一律打码 */
function maskPassword(password: string): string {
  return password.length === 0 ? "(空)" : "******";
}

/** 一条账号的**当前生效限制**的可读摘要（`user list` 的表体） */
function limitsOf(account: AuthAccount): string {
  const parts: string[] = [];
  if (account.quota !== undefined) {
    parts.push(`quota=${formatBytes(account.quota.bytes)}/${account.quota.window ?? "month"}`);
  } else {
    parts.push("quota=无限制");
  }
  if (account.expiresAt !== undefined) {
    parts.push(`expires=${new Date(account.expiresAt).toISOString()}`);
  }
  const rules = account.acl?.target;
  const wl = rules?.whitelist.length ?? 0;
  const bl = rules?.blacklist.length ?? 0;
  if (wl > 0 || bl > 0) {
    parts.push(`acl=白${wl}/黑${bl}`);
  }
  return parts.join(" ");
}

/** `user show <name>` 的字段表（**只有单个账号才有**；不存在的名字在 ops 层已抛错） */
function showOne(io: AdminIo, target: AuthAccount): void {
  io.write(
    renderTable(
      ["字段", "值"],
      [
        ["username", target.username],
        ["password", maskPassword(target.password)],
        ["状态", target.disabled === true ? "已禁用" : "启用"],
        [
          "quota",
          target.quota === undefined ? "(未配 = 不限流)" : formatBytes(target.quota.bytes),
        ],
        [
          "quota.window",
          target.quota === undefined ? "-" : (target.quota.window ?? "month（缺省）"),
        ],
        [
          "expiresAt",
          target.expiresAt === undefined
            ? "(永不过期)"
            : new Date(target.expiresAt).toISOString(),
        ],
      ],
    ),
  );
  // ⚠️ **个人名单走小节、不进上面的表**：整份名单塞进一个格子时那行宽过终端就会软换行，而字段列只在
  // 第一视觉行上——「这条免的是哪个目标」于是答不出来。与 `acl show` 同一份排版（`renderSections`）。
  io.write(
    renderSections([
      { title: "acl.target.whitelist", items: target.acl?.target.whitelist ?? [] },
      { title: "acl.target.blacklist", items: target.acl?.target.blacklist ?? [] },
    ]),
  );
}

/** `user list` / `user show` */
function readOnly(io: AdminIo, sources: OpsSources, name: string | undefined): void {
  if (name !== undefined) {
    showOne(io, getAccount(sources, name));
    return;
  }

  const accounts = listAccounts(sources);
  if (accounts.length === 0) {
    io.write("(账号表为空)");
    return;
  }
  io.write(
    renderTable(
      ["USERNAME", "状态", "限制"],
      accounts.map((a) => [a.username, a.disabled === true ? "禁用" : "启用", limitsOf(a)]),
    ),
  );
}

/**
 * 把一个写子命令派发到 `@/ops` 的对应写面
 * @description
 * ⚠️ **六个成员逐个列出**，而不是「排除掉只读那几条再落到最后一段」：`command.patch` 只在
 * `add` / `set` 两个成员上存在，联合类型按「排除其余四个」是收不出它的，而一个漏掉的成员
 * 会静默变成「什么都不改却报成功」。
 */
function writeAccount(sources: OpsSources, command: UserWriteCommand): OpsChange {
  switch (command.op) {
    case "remove":
      return removeAccount(sources, command.name);
    case "disable":
      return setAccountEnabled(sources, command.name, true);
    case "enable":
      return setAccountEnabled(sources, command.name, false);
    case "passwd":
      return passwdAccount(sources, command.name, command.password);
    case "add":
      return addAccount(sources, command.name, command.password, command.patch);
    case "set":
      return setAccount(sources, command.name, command.patch);
  }
}

/** `proxy-cli user ...` 的执行面 */
export function runUserCommand(
  io: AdminIo,
  sources: OpsSources,
  command: Extract<AdminCommand, { kind: "user" }>,
): void {
  if (command.op === "list" || command.op === "show") {
    readOnly(io, sources, command.op === "show" ? command.name : undefined);
    return;
  }
  io.changed(writeAccount(sources, command).message);
}