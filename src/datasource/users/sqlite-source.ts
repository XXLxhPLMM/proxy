/**
 * @fileoverview 账号表的 **SQLite 档**：读 `cfg/users.db` 的 `accounts` 表
 * @module datasource/users/sqlite-source
 * @description
 * 同一份数据换一种容器。`doc` 列存**整条账号的 JSON 文档**，读出来拼回数组后交给
 * `validateAuthUsers`——因此本档**零字段判据**，「什么是合法账号」只有一份。
 *
 * ## 为什么仍走 mtime 节流 + 四态事件
 *
 * 热加载语义是账号表的一部分（改完 1s 内生效、坏内容不接管、恢复时报 `recovered`）。
 * SQLite 库文件**改一次写就动一次 mtime**，所以同一套 `readCachedSource` 机制逐字适用。
 * **刻意复用而不是另写一份节流**：两份节流缓存一旦撞上同一个 `label + path` 键就会互相
 * 污染出无法解释的观察结果（而且「哪个实现的缓存」这件事在调用方那里根本不可见）。
 */

import fs from "node:fs";
import path from "node:path";
import { openSqliteDriver } from "@/utils/sqlite/index.js";
import type { SqliteDriver } from "@/utils/sqlite/index.js";
import { readCachedSource, type JsonFileRead } from "@/utils/json-file/index.js";
import { normalizeOne, toAccountDoc, validateAuthUsers } from "./validate.js";
import type { AccountListOptions, AccountSource, AuthAccount, PathResolver } from "./types.js";
import { BUILTIN_ACCOUNT_DRIVERS } from "../driver.js";

/** 账号库文件名（**只算路径，不碰磁盘**）。与账本库（`core/traffic:LEDGER_DB_NAME`）分开。 */
export const ACCOUNTS_DB_NAME = "users.db";

/** 账号表空值（库文件不存在时的兜底；**冻结只读哨兵**） */
const EMPTY_ACCOUNTS: readonly AuthAccount[] = Object.freeze([]);

/**
 * 建账号表（**表结构的唯一真相源**）
 * @description
 * `doc` 存**整条账号的 JSON 文档**（含 `password` / `acl` / `quota` / `expiresAt` 原形），
 * 而不是把每个可选字段摊成列。这个选择就是为了让 `read` 侧能**原样拼回数组**交给
 * `validateAuthUsers`——摊成列就得在读侧反向拼装，而反向拼装的过程正是「两档形状漂移」
 * 的发生地（读出来的 `expiresAt` 是 epoch 还是带偏移的 ISO？只有 `doc` 形态没有这个问题）。
 *
 * `WITHOUT ROWID`：主键就是全部列，再存一份行号纯属浪费。代价是**没有插入顺序**
 * （`rowid` 不存在），故 `SELECT` 必须显式 `ORDER BY` 才能得到稳定顺序。
 */
const CREATE_ACCOUNTS_TABLE = `
CREATE TABLE IF NOT EXISTS accounts (
  username TEXT NOT NULL,
  doc      TEXT NOT NULL,
  PRIMARY KEY (username)
) WITHOUT ROWID
`;

/** 把 SQLite 一行读回一条候选账号（`doc` 解析失败由上层吞成 error，不在这里抛） */
interface AccountRow {
  readonly username: string;
  readonly doc: string;
}

/** 打开一个账号库连接（**建目录 + 建表**）并交给调用方；调用方负责 `close()` */
function openAccountsDb(file: string): SqliteDriver {
  // 建父目录：**与 json 档的 `writeWholeFile` 逐字同形**。同一个端口的两个实现器在
  // 「父目录还不存在时 `put` 会不会成功」上必须一致 —— sqlite 驱动**不会**自己 mkdir，
  // 于是「配了个还没建过的 AUTH_USERS_DB 路径」在 json 档成功、在 sqlite 档抛
  // `unable to open database file`。那是**只随驱动变化的偶发失败**，比两边都失败更难查。
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openSqliteDriver()(file);
  db.exec(CREATE_ACCOUNTS_TABLE);
  return db;
}

/** SQLite 实现器：读 `cfg/users.db` 的 `accounts` 表 */
export class SqliteAccountSource implements AccountSource {
  public readonly kind = BUILTIN_ACCOUNT_DRIVERS.sqlite;

  public constructor(private readonly resolvePath: PathResolver) {}

  public list(options: AccountListOptions = {}): JsonFileRead<AuthAccount[]> {
    // 走 `readCachedSource`（与 JSON 档**同一套**节流 / 缓存 / 四态事件），只把「怎么读」
    // 换成「开库 SELECT」。`load` 抛错或返回 undefined 都被吞成 error + 沿用上一份，
    // 与 JSON 档的坏内容处理逐字同形。
    return readCachedSource<AuthAccount[]>(
      this.resolvePath(),
      (absolutePath) => {
        const db = openSqliteDriver()(absolutePath);
        try {
          const rows = db.all<AccountRow>("SELECT username, doc FROM accounts ORDER BY username");
          return validateAuthUsers(
            rows.map((row) => JSON.parse(row.doc) as unknown),
          );
        } finally {
          db.close();
        }
      },
      {
        // 事件 label **刻意不同**（`用户账号库` vs `用户账号文件`）：缓存键是 `label + path`，
        // 同名会让两个后端在「切了驱动但路径恰好相同」时共用一份缓存条目。
        label: "用户账号库",
        fallback: EMPTY_ACCOUNTS as AuthAccount[],
        force: options.force,
        maxBytes: 64 * 1024 * 1024,
        onEvent: options.onEvent,
      },
    );
  }

  public put(account: AuthAccount): AuthAccount {
    const normalized = normalizeOne(account);
    const db = openAccountsDb(this.resolvePath());
    try {
      db.run("INSERT INTO accounts (username, doc) VALUES (?, ?) ON CONFLICT (username) DO UPDATE SET doc = excluded.doc", [
        normalized.username,
        toAccountDoc(normalized),
      ]);
    } finally {
      db.close();
    }
    return normalized;
  }

  public delete(username: string): void {
    const db = openAccountsDb(this.resolvePath());
    try {
      db.run("DELETE FROM accounts WHERE username = ?", [username]);
    } finally {
      db.close();
    }
  }
}
