/**
 * `datasource/users/` 三档共用的**账号表档面**：一份有代表性的账号批 + 一份临时目录上的
 * 两个后端实现器 + 那段「Windows 上 SQLite 句柄未释放」的回收重试。
 *
 * @description
 * 主题级不变量见同目录 `AGENTS.md`。⚠️ **前导留在测试侧，不许上提 `tests/helpers/`**：
 * `ACCOUNTS` 带着三个公网 host 字面量，而 `external-network-scan.ts` 的 `SCAN_DIRS` 排除
 * `helpers/` —— 搬进去等于让那部分覆盖从零外网扫描里静默消失，而 `no-external-network.test.ts`
 * 的下界断言照样绿。**可见的重复优于看不见的失效。**
 *
 * 三个路径是**可变导出**（`beforeEach` 逐例重造目录）：ESM 的导入绑定是活的，而从调用方
 * 赋值非法 —— 所以重造只发生在本模块内，调用方只读。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonAccountSource, SqliteAccountSource, ACCOUNTS_DB_NAME } from "@/datasource/users/index.js";
import type { AccountSource, AuthAccount } from "@/datasource/users/index.js";

/**
 * 一批**刻意覆盖三个最易漂移处**的账号
 * @description
 * - `acl.target`：名单条目（两后端都要经过 `parseHostRule` 同一份实现）
 * - `quota.window`：闭集字面量（sqlite 档最容易「收下然后按 month 跑」的字段）
 * - `expiresAt`：**归一化产物是 epoch 毫秒，而磁盘形态必须带时区偏移的 ISO 8601**。
 *   这一对是抽象层最脆的地方——sqlite 档若直接把 epoch 写进 `doc`，读出来仍是同一个数字
 *   （看起来对），但**磁盘上那份数据换到 json 档就读不了**（`Date.parse(数字)` 会被
 *   `normalizeAccountExpiry` 的正则拒掉）。故往返测试要跨后端验。
 */
export const ACCOUNTS: AuthAccount[] = [
  { username: "alice", password: "pw1" },
  { username: "bob", password: "pw2", quota: { bytes: 1024, window: "day" } },
  {
    username: "carol",
    password: "pw3",
    quota: { bytes: 2048 },
    acl: { target: { whitelist: ["example.com", "*.cdn.io"], blacklist: ["ads.io"] } },
    expiresAt: Date.parse("2026-12-31T23:59:59+08:00"),
  },
  // `window` 缺省的那一档：归一化产物**不写该键**（判据见 `UserQuota.window`）
  { username: "dave", password: "pw4", quota: { bytes: 0 } },
];

export let dir = "";
export let jsonFile = "";
export let dbFile = "";

export const json = (): AccountSource => new JsonAccountSource(() => jsonFile);
export const sqlite = (): AccountSource => new SqliteAccountSource(() => dbFile);

/** 逐例重造一份**独立**的账号表目录（记忆表按接线分槽，故每例互不影响） */
export function makeStoreDir(): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "account-store-"));
  jsonFile = path.join(dir, "users.json");
  dbFile = path.join(dir, ACCOUNTS_DB_NAME);
}

/** 回收那份目录：SQLite 有 `-wal` / `-shm` 旁挂文件，且 Windows 上未释放的句柄让 `rmSync` 报 EBUSY */
export function removeStoreDir(): void {
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      last = undefined;
      break;
    } catch (error) {
      last = error;
    }
  }
  if (last !== undefined) {
    throw last;
  }
}
