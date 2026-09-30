# src/config/sources/ — 文件与路径说明

- `config-dir.ts` — configDir 的取值与路径解析（`HOME_CONFIG_KEY`、`getConfigDir`）。
- `env-files.ts` — env 文件名候选生成（`defaultEnvFileNames`）与 env 文件读取合并（`readEnvFiles`）。`readEnvFiles` 返回 `EnvFilesRead`：`merged` 是合并后的键值表，`fileOrigins` 只收**文件带来的**键（显式 env 已有的键不归文件）→ 值是提供该值的文件路径，供编排层的未知键报错指名来源。归属只在这里算得出，调用方重读文件会与合并结果漂移。
- `argv.ts` — argv 字符串到键值对的解析（`parseRawArgv`）。
- `index.ts` — 本层出口：`HOME_CONFIG_KEY`、`getConfigDir`、`defaultEnvFileNames`、`readEnvFiles`、`EnvFilesRead`、`parseRawArgv`。

对外出口路径：`@/config/index.js` 从本层转出 `defaultEnvFileNames`；编排调用方 `../load.ts`。

本层**只采集、不判合法**：它不认识任何字段名，故「某个键是否合法」的判据在 `../load.ts`（那里 `FIELDS` 与宿主快照同时可见）。

相关测试：`tests/unit/config-loader-import.test.ts`、`tests/unit/config-loader.test.ts`、`tests/unit/config-unknown-keys.test.ts`、`tests/library/entry.test.ts`。
