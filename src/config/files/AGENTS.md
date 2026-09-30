# src/config/files/ — 文件与路径说明

## 层不变量

**本节只列不变式，理由留在各文件的头注释里**（理由会随代码一起改，搬进本文件就变成第二份要维护的真相）。

- **三层互不越界**：**条目规则层** `rules/`（条目语法的解析/编译/匹配，改语法动那里）→ **数据源层** `@/datasource/{acl,users}/`（读数据 + 校验顶层形状，**不做任何判定**）→ **策略层**（全局与账号级名单的请求期判定在 `src/core/access-control.ts`，配额计量与耗尽判定在 `src/datasource/quota/`）。本目录只剩条目规则层与状态迁移渲染。
- **fail-closed，一律到底**：任一条目非法即**整份数据作废**（不是一个字段被忽略）。全局名单与账号配额各自独立校验、各自独立决定整份数据的合法性——不是「只丢非法的那一个、另一个照常生效」。判据本体在数据源层，本目录不持有。
- **绝不许另开第二个读取点**：账号表经 `readAuthUsers` → `accountSourceFor(locator).list()`，账号级 `acl` / `quota` 与全局 `acl` 名单各走自己那一个。数据源层各后端**共用** `utils/json-file` 的节流 / 缓存 / 四态事件，缓存键仍是 `label + path`。

## 文件

子目录：`rules/`。

- `event-log.ts` — JSON 文件读取状态迁移（`error` / `missing` / `recovered` / `reloaded`）到日志与事件的渲染。
- `index.ts` — 本层出口（event-log 的再导出）。
- `rules/` — 名单条目语法层 → [`rules/AGENTS.md`](./rules/AGENTS.md)

对外出口路径：`@/config/index.js` 从本层转出 event-log 符号；账号表与全局名单的读取面在 `@/datasource/{users,acl}/index.js`，第二出口 `@/config/files/rules/index.js`（数据源层引用名单条目语法的**唯一**合法路径）。

磁盘文件：`cfg/acl.json`（`.gitignore` 忽略）、`cfg/acl.json.example`。账号表的磁盘文件（`cfg/users.json` / `cfg/users.db` / 示例文件）随数据源层住在 `src/datasource/users/`。

相关路径：`src/datasource/acl/`（全局名单读面与驱动注册表）、`src/datasource/users/`（账号表数据源）、`src/core/access-control.ts`（请求期名单判定）、`src/datasource/quota/`（配额计量与账本）。

相关测试：`tests/unit/acl-configured.test.ts`、`tests/unit/acl-rule-host.test.ts`、`tests/unit/acl-rule-ip.test.ts`、`tests/unit/json-file.test.ts`、`tests/unit/pack-contents.test.ts`。账号表的断言在 `tests/unit/account-store.test.ts` / `auth-users.test.ts` / `user-quota.test.ts`。
