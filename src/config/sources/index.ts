/**
 * sources 层出口：外部输入（配置目录 / env 文件 / CLI argv）→ ENV 风格键值。
 *
 * 全部函数都要求**显式入参**，没有任何一个会去读 `process.env` / `process.argv`。
 */

export { HOME_CONFIG_KEY, getConfigDir } from "./config-dir.js";
export { defaultEnvFileNames, readEnvFiles } from "./env-files.js";
export { parseRawArgv } from "./argv.js";
