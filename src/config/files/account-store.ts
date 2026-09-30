/**
 * @fileoverview 账号表的**存储抽象层**：一个端口 + 两个实现器（JSON / SQLite）
 * @module config/files/account-store
 * @description
 * 账号表是本仓唯一一份「既是配置、又要支持两种存放方式」的数据。本模块把它拆成
 * **一个端口 + 两个实现器**，`AUTH_USERS_DRIVER` 决定装配哪一个：
 *
 * ```
 * AccountStore（端口，只答「给我整张表」）
 * ├─ JsonAccountStore   → cfg/users.json   （默认；运维能手改、能 diff、能进版本库）
 * └─ SqliteAccountStore → cfg/users.db     （同一份数据，换一种容器）
 * ```
 *
 * ## 抽象落在「**数据从哪来**」，不落在「数据是什么意思」
 *
 * 这是本层唯一的设计决策，也是它能同时服务两个实现器的原因：**形状校验只有一份**
 * （`users.ts:validateAuthUsers`），两个实现器都把原始值交给它。SQLite 档因此**不重新实现
 * 任何校验**——它把每行账号读成一条 JSON 文档、拼回数组、丢给同一个 `validateAuthUsers`。
 *
 * 换来的硬性质：**两个后端不可能对「什么是合法账号」有分歧**。若让 SQLite 档自己逐列判
 * （`quota_bytes` 是不是非负安全整数、`expiresAt` 有没有时区偏移……），那份判据就是第二份
 * 真相源，而它与 JSON 档漂移的那一天，就是「配了 sqlite、行为悄悄不同」的开始。
 *
 * 代价要认：**SQLite 档放弃了一部分查询能力**（不能 `WHERE quota_bytes > 0`）。但账号表是
 * **只读**的、规模是「几百到几千行」，整表读进内存与读 JSON 文件是同一个量级。为了
 * 「能不能在 SQL 里筛」去复制一份校验，代价远大于收益。
 *
 * ## 为什么 SQLite 档仍走 mtime 节流 + 四态事件
 *
 * 热加载语义是账号表的一部分（改完 1s 内生效、坏内容不接管、恢复时报 `recovered`）。
 * SQLite 库文件**改一次写就动一次 mtime**，所以同一套 `readCachedSource` 机制逐字适用。
 * **刻意复用而不是另写一份节流**：两份节流缓存一旦撞上同一个 `label + path` 键就会互相
 * 污染出无法解释的观察结果（而且「哪个实现的缓存」这件事在调用方那里根本不可见）。
 *
 * ## `write` 族方法：给「怎么往 SQLite 里放账号」一条正路
 *
 * 手改 SQLite 需要装工具、记表结构、还得自己保证 JSON 文档合法——这正是「手改 users.json」
 * 被换掉的原因。所以端口带 `put` / `delete`：**插入路径与读取路径共用同一个驱动与同一份
 * 校验**，不可能出现「写进去的形状与读出来认的形状不一致」。
 *
 * ⚠️ **写方法不在判定热路径上**，且**不承诺并发安全**：它服务的是「运维/脚本一次性改数据」。
 * 多进程同时写同一个账号库时靠 `busy_timeout` 退让（实测 4 进程 × 200 次 UPSERT `busy=0`）。
 *
 * @example
 * // 读取（判定路径，零分配地复用缓存）
 * const store = accountStoreFor(config);
 * const accounts = store.list({ onEvent }).value;
 * @example
 * // 写入（运维/脚本路径）
 * const db = accountStoreFor(config);
 * db.put({ username: "alice", password: "pw1", quota: { bytes: 1024 } });
 * db.delete("bob");
 */

import fs from "node:fs";
import path from "node:path";
import type { ConfigAccessor } from "../context.js";
import type { StoreDriver } from "../types.js";
import { openSqliteDriver } from "@/utils/sqlite/index.js";
import type { SqliteDriver } from "@/utils/sqlite/index.js";
import { readCachedSource, readJsonCached, type JsonFileEvent, type JsonFileRead } from "@/utils/json-file/index.js";
import { validateAuthUsers, type AuthAccount } from "./users.js";

/** 账号库文件名（**只算路径，不碰磁盘**）。与账本库（`core/traffic:LEDGER_DB_NAME`）分开。 */
export const ACCOUNTS_DB_NAME = "users.db";

/** 账号表空值（文件缺失 / 库表不存在时的兜底；**冻结只读哨兵**） */
const EMPTY_ACCOUNTS: readonly AuthAccount[] = Object.freeze([]);

/** 读取选项（与 JSON 档同形，故调用方无需知道后端） */
export interface AccountListOptions {
  /** 跳过节流强制重读（启动期校验用） */
  readonly force?: boolean;
  /** 状态迁移事件回调（`error` / `missing` / `recovered` / `reloaded`） */
  readonly onEvent?: (event: JsonFileEvent) => void;
}

/**
 * 账号表的**存储端口**
 * @description
 * 只暴露「整张表」这一个读出口，**刻意不做按用户取单条**：`loadUserPolicy` / `loadUserQuota`
 * 已经是「读整张表 + 内存线性扫」的实现（每请求 / 每 chunk 调用，靠零分配与对象身份记忆
 * 摊平成本，见 `users.ts` 那两处的注释），而它拿到的是**同一份数组对象**（内容未变时
 * `readCachedSource` 返回缓存里那一个），所以按用户取单条并不会更省——只会让「同一时刻
 * 读两次可能读到两个不同快照」成为可能。
 */
export interface AccountStore {
  /** 本实现器对应的后端（诊断与测试断言用；**不参与任何判据**） */
  readonly kind: StoreDriver;
  /**
   * 取整张账号表
   * @description 语义（两个后端**逐条一致**）：缺失 = 空表且不算错误；坏内容 = **保留上一份
   * 有效值**并给出 `error`（不接管）；内容未变 = 返回**同一个数组对象**（热路径靠它零分配）。
   */
  list(options?: AccountListOptions): JsonFileRead<AuthAccount[]>;
  /**
   * 写入 / 覆盖一个账号（**upsert**，按 `username`）
   * @returns 写入后该账号的归一化形态（`validateAuthUsers` 的产物，非你传进去的那份）
   * @throws 形状非法时抛错（**不**静默丢字段）——调用方拿到的是「这份数据配不了」的明确答案
   * @description
   * ⚠️ **整条替换，不是字段级合并**。只影响**该 `username` 这一条**（别的账号逐字不动），
   * 但这条账号的**其它可选键会被一起清掉**：想给 alice 加一条 `acl` 而漏传了她的 `quota` /
   * `expiresAt` / 旧 `acl`，那三项就**消失了**（且消失是静默的——那正是 upsert 该有的样子，
   * 但它是本仓最容易造成「配额莫名其妙没了」的一个动作）。
   *
   * **要改一个字段就先读出来、改、再写回**：
   * `const cur = s.list().value.find(a => a.username === "alice"); s.put({ ...cur, acl })`。
   * 没有「patch 一个键」的接口是刻意的：patch 语义要在两个后端上各实现一遍（JSON 档读-改-重写、
   * sqlite 档 `UPDATE` 单列），而单列 `UPDATE` 出来的记录**未必还过 `validateAuthUsers`** ——
   * 那正是「写得进去、读不出来」的来源。整条替换让「落盘 = 校验过的字节」这条性质对每个入口
   * 都成立。
   *
   * @note 写完**不**主动清读缓存：下一次 `list()` 最迟 1s（`maxAgeMs`）后自然看到新值。
   *   主动清缓存需要一个跨后端统一的 cache key 反查，那是「缓存归读取器管」这条纪律的破口。
   */
  put(account: AuthAccount): AuthAccount;
  /** 删除一个账号；`username` 不存在时**静默成功**（upsert 语义下的 delete 无需区分） */
  delete(username: string): void;
}

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

/** 账号文档的**磁盘形态**：epoch 毫秒换回 ISO 8601（带偏移），其余原样 */
function toDoc(account: AuthAccount): string {
  const out: Record<string, unknown> = {
    username: account.username,
    password: account.password,
  };
  if (account.acl !== undefined) {
    out.acl = account.acl;
  }
  if (account.quota !== undefined) {
    out.quota = account.quota;
  }
  if (account.expiresAt !== undefined) {
    // 归一化产物里 `expiresAt` 是 epoch 毫秒（`normalizeAccountExpiry` 的产物），
    // 而 JSON 档要求磁盘上写**带时区偏移的 ISO 8601** —— 这里必须换回去，否则同一个账号
    // 在两个后端里的磁盘形态不同（而 `expiresAt` 的偏移强制正是它存在的理由之一）。
    out.expiresAt = new Date(account.expiresAt).toISOString();
  }
  return JSON.stringify(out);
}

/**
 * 把一条**归一化**账号转成**磁盘形态**并交给 `validateAuthUsers` 校验
 * @description
 * 走**整表**的 `validateAuthUsers` 而不是自己判一遍：单条判据必须是整表判据的子集，否则会出现
 * 「单条合法但整表非法」（如与别的账号重名）这种只有落库时才发现的错。
 *
 * ⚠️ **关键：先转磁盘形态、再校验**。`AuthAccount.expiresAt` 是 **epoch 毫秒**（归一化产物），
 * 而 `validateAuthUsers` / `normalizeAccountExpiry` 判的是**磁盘形态**（带时区偏移的 ISO 8601
 * 串）。两者在 TS 上是同一个类型、在运行期是两种值——这正是本仓最容易踩的一个形状
 * （本模块最初把归一化对象直接丢给 `validateAuthUsers`，于是**任何带 `expiresAt` 的账号
 * 都写不进去**）。
 *
 * 顺带得到一条强性质：**校验过的字节就是落盘的字节**（`toDoc` 的输出即校验输入），
 * 所以「写得进去但读不出来」这件事在本档不存在。
 */
function normalizeOne(account: AuthAccount): AuthAccount {
  const doc = JSON.parse(toDoc(account)) as unknown;
  const validated = validateAuthUsers([doc]);
  if (validated === undefined) {
    throw new Error(
      `账号 ${JSON.stringify(account.username)} 形状非法（字段缺失、类型不符或存在未知键）`,
    );
  }
  return validated[0];
}

/**
 * 解析出**路径**（`AUTH_USERS_FILE` 是 runtime 相位，可热改 → 必须现取）
 * @description **不是**构造期烤进去的字符串。这是本模块修掉的一个真 bug 的形状：
 * 实现器若持有固定路径、而 `accountStoreFor` 又记忆化了实现器实例，那么「改配置指向另一个
 * 账号文件」就**永远不生效**——而 `AUTH_USERS_FILE` 恰恰是文档写明可热改的字段。
 * 记忆的必须是「不可变的东西」（哪个实现器），路径交给闭包现取，两者不混。
 */
type PathResolver = () => string;

/** JSON 实现器：读 `cfg/users.json`（**行为与本层存在之前逐字一致**） */
export class JsonAccountStore implements AccountStore {
  public readonly kind = "json" as const;

  public constructor(private readonly resolvePath: PathResolver) {}

  public list(options: AccountListOptions = {}): JsonFileRead<AuthAccount[]> {
    return readJsonCached(this.resolvePath(), validateAuthUsers, {
      label: "用户账号文件",
      fallback: EMPTY_ACCOUNTS as AuthAccount[],
      force: options.force,
      maxBytes: 1024 * 1024,
      onEvent: options.onEvent,
    });
  }

  /**
   * 写入（`upsert`）：读整表 → 替换/追加同名项 → 整表重写
   * @description 文本文件没有「就地改一列」这回事，故写**必然**是「读-改-整文件重写」。
   * 原子性靠 `json-file` 之外的 `.tmp` + `rename`（Windows 上 `rename` 不能覆盖已存在文件，
   * 故先删旧文件再 rename——那两步之间有一个极短的窗口，**并发写会互相覆盖**）。
   * 这不是本层能修的：它就是「用文本文件当数据库」的固有代价，也正是 `sqlite` 档存在的理由。
   */
  public put(account: AuthAccount): AuthAccount {
    const normalized = normalizeOne(account);
    const current = this.list({ force: true }).value;
    const next = current.filter((a) => a.username !== normalized.username);
    next.push(normalized);
    // ⚠️ 写的是**磁盘形态**（`toDoc`），不是归一化对象：`expiresAt` 必须是带偏移的 ISO 串，
    // 写 epoch 会让这份文件在**下一次读**时被 `normalizeAccountExpiry` 判非法。
    writeWholeFile(
      this.resolvePath(),
      next.map((a) => JSON.parse(toDoc(a)) as unknown),
    );
    return normalized;
  }

  public delete(username: string): void {
    const current = this.list({ force: true }).value;
    const next = current.filter((a) => a.username !== username);
    if (next.length === current.length) {
      return;
    }
    writeWholeFile(this.resolvePath(), next);
  }
}

/**
 * 整文件重写：`.tmp` + `rename`（JSON 档唯一的写原语）
 * @description
 * 收的是**磁盘形态**（未归一化的 `unknown` 数组），不是 `AuthAccount[]` —— 落盘的每一个字节
 * 都与读侧 `validateAuthUsers` 判的是同一份形态。
 *
 * 缩进 2 + 尾换行：**刻意保持与仓库里那份 `cfg/users.json` 一致的形态**——这个后端存在的
 * 首要理由就是「运维能手改」，那么它写出来的文件就必须是人能读、能 diff、能进版本库的形态。
 * 一台机器的 JSON 档被脚本改过之后，那份文件长什么样，决定了运维下次还认不认得它。
 */
function writeWholeFile(file: string, accounts: readonly unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(accounts, undefined, 2)}\n`, "utf8");
  // ⚠️ **先删后 rename**：Windows 的 `rename` 不能覆盖已存在的目标（`EPERM`/`EEXIST`），
  // 而「先 unlink」在 POSIX 上会造出一个「文件短暂不存在」的窗口。两个平台各有一处
  // 不完美，这正是「用文本文件当数据库」的固有代价 —— 也是 `sqlite` 档存在的理由。
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  }
}

/** SQLite 实现器：读 `cfg/users.db` 的 `accounts` 表 */
export class SqliteAccountStore implements AccountStore {
  public readonly kind = "sqlite" as const;

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
        toDoc(normalized),
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

/** 实现器记忆表：`(accessor, driver) → 实现器`（见 {@link accountStoreFor} 的理由） */
const storeCache = new WeakMap<ConfigAccessor, Map<StoreDriver, AccountStore>>();

/**
 * 按 `ConfigAccessor` 解析出该用哪个实现器（**带记忆**）
 * @description
 * 用 `WeakMap<ConfigAccessor, Map<StoreDriver, AccountStore>>` 而不是 `Map<string, …>`：
 * 缓存跟着 accessor 的生命周期走，accessor 被回收时条目一起消失，不留悬垂引用
 * （与 `users.ts:frozenPolicies` 同一手法）。
 *
 * **记忆的只有「实现器是哪一个」**——路径由闭包现取（见 {@link PathResolver}）。反过来做
 * （把路径烤进实现器再记忆）会让「热改 `AUTH_USERS_FILE`」静默失效：那正是本模块最初写成
 * 那样时被测试当场抓住的 bug（换文件后仍读旧文件，表现为「账号表读出来是空的」）。
 *
 * @param config - 配置访问器（驱动与路径都从它现读）
 * @param forceDriver - 显式指定后端（**`path` 覆盖与启动期校验用**：那两处要在一个明确的
 *   后端上读，不该被热改影响）。缺省 = 按 `config` 现读
 * @param path - 显式路径覆盖。⚠️ **只对 JSON 档有意义**（它就是「换个文件读」）；
 *   SQLite 档下会被忽略——要指定库路径请用 `config` 的 `authUsersDb`。
 *   传了它就**不进记忆表**（那个实现器带着一次性的路径，不该被后续调用复用）。
 */
export function accountStoreFor(
  config: ConfigAccessor,
  forceDriver?: StoreDriver,
  path?: string,
): AccountStore {
  const driver: StoreDriver = forceDriver ?? config.get("authUsersDriver");
  let byDriver = storeCache.get(config);
  if (byDriver === undefined) {
    byDriver = new Map<StoreDriver, AccountStore>();
    storeCache.set(config, byDriver);
  }
  const cached = byDriver.get(driver);
  if (cached !== undefined && path === undefined) {
    return cached;
  }
  const created =
    driver === "sqlite"
      ? new SqliteAccountStore(() => config.get("authUsersDb"))
      : new JsonAccountStore(() => path ?? config.get("authUsersFile"));
  if (path === undefined) {
    byDriver.set(driver, created);
  }
  return created;
}
