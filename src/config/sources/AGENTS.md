# src/config/sources/ — 文件与路径说明

- `config-dir.ts` — configDir 的取值与路径解析（`HOME_CONFIG_KEY`、`getConfigDir`）。
- `env-files.ts` — env 文件名候选生成（`defaultEnvFileNames`）与 env 文件读取合并（`readEnvFiles`）。
- `argv.ts` — argv 字符串到键值对的解析（`parseRawArgv`）。
- `index.ts` — 本层出口：`HOME_CONFIG_KEY`、`getConfigDir`、`defaultEnvFileNames`、`readEnvFiles`、`parseRawArgv`。

对外出口路径：`@/config/index.js` 从本层转出 `defaultEnvFileNames`；编排调用方 `../load.ts`。

相关测试：`tests/unit/config-loader-import.test.ts`、`tests/unit/config-loader.test.ts`、`tests/library/entry.test.ts`。
