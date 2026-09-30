/**
 * 全部函数都要求**显式入参**，没有任何一个会去读 `process.env` / `process.argv`。
 */

export { HOME_CONFIG_KEY, getConfigDir } from "./config-dir.js";
export { defaultEnvFileNames, readEnvFiles } from "./env-files.js";
export type { EnvFilesRead } from "./env-files.js";
export { parseRawArgv } from "./argv.js";
