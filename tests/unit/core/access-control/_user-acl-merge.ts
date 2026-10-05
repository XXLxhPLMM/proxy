/**
 * 每用户名单（`users.json` 的 `acl`）与全局 `acl.json` **合流判定**那一族的共用装配面
 *
 * @description
 * 只放**两个以上档真用到**的东西：账号表接线 `acc`、判定面工厂 `newAccess`、三个目标
 * 域名/账号常量、两层名单的六个档位常量、`accounts()` 构造器、`writeLists()` 写盘器与
 * `cleanupMergeDirs()` 回收器。**只被一档用到的形状刻意留在那个档里**：`writeUsers`
 * （连带它自己的 `clock`）与 `user-merge-runtime.test.ts` 里那份 `GLOBAL` 夹具。
 *
 * ⚠️ **为什么 `access` 是工厂而不是一个 `let`**：它每例都被 `beforeEach` 重新赋值，
 * 而 ES 模块的导入绑定**不可从外部赋值**。所以共用面给的是**构造器**，可变的那个
 * `let access` 由每档自己声明 —— 这不是「少共用一点」，而是「可变状态必须归拥有它的那一档」。
 *
 * ⚠️ **本目录不许有 `.test.ts` 后缀**（否则 vitest 会把它收集成一个空跑的空档）；
 * **共用面绝不许搬进 `tests/helpers/`**（零外网扫描的 `SCAN_DIRS` 排除那个目录，搬进去
 * 等于让其中的公网字面量从扫描里静默消失）。见 `./AGENTS.md`。
 *
 * @module tests/unit/core/access-control/_user-acl-merge
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountLocatorFor, aclLocatorFor } from "@/config/index.js";
import { readAcl } from "@/datasource/acl/index.js";
import { readAuthUsers } from "@/datasource/users/index.js";
import { createFileAccessControl } from "@/core/access-control.js";
import type { AccessControl } from "@/core/types/proxy.js";
import { set, testConfig } from "../../../helpers/config.js";

/**
 * 账号表接线（读面收的是平值，不收 `ConfigAccessor`）
 * @description 恒返回**同一个**对象（`accountLocatorFor` 按 accessor 记忆），故下游
 * 实现器记忆跨调用命中——这正是「热路径零分配」的前提。
 */
export const acc = (): ReturnType<typeof accountLocatorFor> => accountLocatorFor(testConfig);

/** 判定对象固定用这一个域名（名单按 host 字符串匹配，不做 DNS） */
export const HOST = "target.test";
/** 用来构造「白名单非空但未命中」的另一个域名 */
export const OTHER = "other.test";
export const USER = "alice";

/** 本族两档共用的配置快照键（每档各自挂 `beforeEach` / `afterEach`，钩子不外提） */
export const MERGE_KEYS = ["aclFile", "authUsersFile", "logLevel", "logFile"] as const;

/** 全局 target 组对 HOST 的三种结果 */
export const GLOBAL_ALLOW = {};
export const GLOBAL_BLACKLIST = { target: { blacklist: [HOST] } };
export const GLOBAL_WHITELIST_MISS = { target: { whitelist: [OTHER] } };

/** 个人 target 组对 HOST 的三种结果（「放行」用**显式白名单命中**，不留「没配 acl」的模糊空间） */
export const USER_ALLOW = { target: { whitelist: [HOST] } };
export const USER_BLACKLIST = { target: { blacklist: [HOST] } };
export const USER_WHITELIST_MISS = { target: { whitelist: [OTHER] } };

/**
 * 判定面收成 `AccessControl` 端口后，每例建一份、共用 `testConfig` 访问器。
 *
 * @description 「每例新建」不影响任何一条热加载用例：编译结果按 accessor 记忆、名单快照
 * 未变即复用，变的是 `aclFile` / `authUsersFile` 指向的文件**内容**，`readAcl` /
 * `loadUserPolicy` 现读 + 快照身份变化自然触发重编译。
 */
export function newAccess(): AccessControl {
  return createFileAccessControl(testConfig);
}

/** 每例用**独立的一对文件**：绕开 `readJsonCached` 的 1s 节流与缓存键复用，例与例之间零耦合 */
const dirs: string[] = [];

/** 写 acl.json + users.json 并各强制读一次（让两个读取器立刻建好缓存条目） */
export function writeLists(acl: unknown, users: unknown): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-acl-merge-"));
  dirs.push(dir);
  const aclPath = path.join(dir, "acl.json");
  const usersPath = path.join(dir, "users.json");
  fs.writeFileSync(aclPath, JSON.stringify(acl));
  fs.writeFileSync(usersPath, JSON.stringify(users));
  set("aclFile", aclPath);
  set("authUsersFile", usersPath);
  readAcl({ locator: aclLocatorFor(testConfig), force: true });
  readAuthUsers({ locator: acc(), force: true });
}

/** 回收 `writeLists` 建过的全部临时目录（排空靠 `splice(0)`，第二次调用是同一份实现的空转） */
export function cleanupMergeDirs(): void {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 账号表：alice 的个人名单由用例给；bob 恒为「白名单圈住 HOST」（对照组：证明判定确实是按用户的） */
export function accounts(aliceAcl?: unknown): unknown[] {
  return [
    ...(aliceAcl === undefined ? [] : [{ username: USER, password: "pw1", acl: aliceAcl }]),
    { username: "bob", password: "pw2", acl: { target: { whitelist: [HOST] } } },
  ];
}