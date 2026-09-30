# src/config/files/ — 文件与路径说明

## 层不变量

**本节只列不变式，理由留在各文件的头注释里**（理由会随代码一起改，搬进本文件就变成第二份要维护的真相）。

- **三层互不越界**：**条目规则层** `rules/`（条目语法的解析/编译/匹配，改语法动那里）→ **本目录**（读文件 + 校验顶层形状，**不做任何判定**）→ **策略层**（全局与账号级名单的请求期判定在 `src/core/access-control.ts`，配额计量与耗尽判定在 `src/core/traffic/`）。
- **fail-closed，一律到底**：任一条目非法即**整份文件作废**（不是一个字段被忽略）。`acl` 与 `quota` 各自独立校验、各自独立决定整份文件的合法性——不是「只丢非法的那一个、另一个照常生效」。
- **账号表只有一个端口、两个后端**：`AccountStore`（`account-store.ts`）由 `AUTH_USERS_DRIVER` 选实现器（`JsonAccountStore` / `SqliteAccountStore`）。**形状校验只有一份**（`users.ts:validateAuthUsers`），SQLite 档把每行读成 JSON 文档后交同一个校验，故两后端不可能对「什么是合法账号」有分歧。路径由闭包现取（`AUTH_USERS_FILE` 是 runtime 相位，烤进实现器会让热改静默失效）。
- **绝不许另开第二个读取点**：账号表经 `readAuthUsers` → `accountStoreFor(...).list()`，账号级 `acl` / `quota`、`acl.json` 各走自己那一个。两个后端**共用** `utils/json-file` 的节流 / 缓存 / 四态事件（json 档 `readJsonCached`、sqlite 档 `readCachedSource`），缓存键仍是 `label + path`。

## 文件

子目录：`rules/`。

- `account-store.ts` — 账号表的**存储抽象层**：`AccountStore` 端口 + `JsonAccountStore` / `SqliteAccountStore` 两个实现器、`accountStoreFor`（按驱动解析，带记忆）、`ACCOUNTS_DB_NAME` 与建表语句。
- `users.ts` — 账号表的**形状校验**与读取面转发（`AuthAccount`、`validateAuthUsers`、`readAuthUsers` / `loadAuthUsers` / `loadUserPolicy` / `loadUserQuota` / `hasAccountExpiry`）。**零直接读取器**。
- `acl.ts` — `acl.json` 访问控制配置的读取与形状校验，含「是否配置了访问控制」的文件事实判定（`hasConfiguredAcl`）。
- `event-log.ts` — JSON 文件读取状态迁移（`error` / `missing` / `recovered` / `reloaded`）到日志与事件的渲染。
- `index.ts` — 本层出口（users / acl / event-log 的再导出）。
- `rules/` — 名单条目语法层 → [`rules/AGENTS.md`](./rules/AGENTS.md)

对外出口路径：`@/config/index.js` 从本层转出 users / acl / event-log 的读取与校验符号；第二出口 `@/config/files/rules/index.js`。

磁盘文件：`cfg/users.json`（json 档）、`cfg/users.db`（sqlite 档）、`cfg/acl.json`（`.gitignore` 忽略）、`cfg/users.json.example`、`cfg/users.json.example.md`、`cfg/acl.json.example`。

相关路径：`src/core/access-control.ts`（请求期名单判定）、`src/core/traffic/`（配额计量）。

相关测试：`tests/unit/account-store.test.ts`（两个后端的等价性与切换）、`tests/unit/auth-users.test.ts`、`tests/unit/user-quota.test.ts`、`tests/unit/acl-configured.test.ts`、`tests/unit/json-file.test.ts`、`tests/unit/pack-contents.test.ts`。
