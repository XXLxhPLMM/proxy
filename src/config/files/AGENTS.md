# src/config/files/ — 文件与路径说明

子目录：`rules/`。

- `users.ts` — `users.json` 账号表的读取与形状校验（`AuthAccount`、policy / quota 读取面）。
- `acl.ts` — `acl.json` 访问控制配置的读取与形状校验，含「是否配置了访问控制」的文件事实判定（`hasConfiguredAcl`）。
- `event-log.ts` — JSON 文件读取状态迁移（`error` / `missing` / `recovered` / `reloaded`）到日志与事件的渲染。
- `index.ts` — 本层出口（users / acl / event-log 的再导出）。
- `rules/` — 名单条目语法层 → [`rules/AGENTS.md`](./rules/AGENTS.md)

对外出口路径：`@/config/index.js` 从本层转出 users / acl / event-log 的读取与校验符号；第二出口 `@/config/files/rules/index.js`。

磁盘文件：`cfg/users.json`、`cfg/acl.json`（`.gitignore` 忽略）、`cfg/users.json.example`、`cfg/users.json.example.md`、`cfg/acl.json.example`。

相关路径：`src/core/access-control.ts`（请求期名单判定）、`src/core/traffic/`（配额计量）。

相关测试：`tests/unit/auth-users.test.ts`、`tests/unit/user-quota.test.ts`、`tests/unit/acl-configured.test.ts`、`tests/unit/json-file.test.ts`、`tests/unit/pack-contents.test.ts`。
