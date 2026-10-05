import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { resolveOpsSources, type OpsSources } from "@/ops/index.js";
import type { AuthAccount } from "@/datasource/users/index.js";

/**
 * `tests/unit/ops/` 三档共用的数据源目录与账号夹具
 *
 * @description
 * 目录生命周期（`beforeEach` 建临时目录 / `afterEach` 回收）与「磁盘形态 ↔ 归一形态」那一对账号
 * 夹具住在三档都要用的地方；只用一档的东西（`usersPath` / `aclPath` / `treeFiles` / `countingAcl`）
 * 留在那一档里 —— 判据是「几档真用到」，不是「搬进去比较整齐」。
 * `dir` 必须以 **live binding** 的形式导出（各档在用例执行时才读它），别在调用点取快照。
 * 主题级不变量（`@/ops` 的五条）见 `./AGENTS.md`。
 */

/** 磁盘形态（`users.json` 里那个样子）：`expiresAt` 是带时区偏移的 ISO 串 */
export const ACCOUNT_DOC = {
  username: "alice",
  password: "pw1",
  quota: { bytes: 1073741824, window: "day" },
  // 落盘恒为带 `.000Z` 的 UTC 串（`toAccountDoc` 用 `toISOString()`，正则同样收 `Z`）。
  expiresAt: "2030-01-01T00:00:00.000Z",
  disabled: false,
  acl: { target: { whitelist: ["example.com"], blacklist: ["evil.com"] } },
};

/** 归一化形态（ops 交出的那种）：`expiresAt` 已是 epoch 毫秒 */
export const ACCOUNT: AuthAccount = {
  username: "alice",
  password: "pw1",
  quota: { bytes: 1073741824, window: "day" },
  expiresAt: 1893456000000,
  disabled: false,
  acl: { target: { whitelist: ["example.com"], blacklist: ["evil.com"] } },
};

export let dir = "";

/** 装一份数据源：`NODE_ENV` 只为让 `configDir` 落到这个临时目录上 */
export async function ops(): Promise<OpsSources> {
  return resolveOpsSources({ NODE_ENV: "development" }, dir);
}

export function writeUsers(body: unknown): void {
  fs.mkdirSync(path.join(dir, "cfg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "cfg", "users.json"), JSON.stringify(body, null, 2));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-ops-"));
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不应遮蔽用例结论
  }
});