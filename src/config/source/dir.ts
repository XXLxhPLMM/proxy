/**
 * 配置目录解析 - 决定「从哪读配置」
 *
 * 只回答路径问题：配置根目录是 `~/.proxy` 还是当前工作目录，以及该目录是否需要
 * 创建。`.env` 文件怎么读在 `env-file.ts`，字段路径怎么由目录推导在
 * `schema/fields.ts` 的 `def`。
 *
 * 依赖方向：零 config 内部依赖。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR_NAME = ".proxy";

/**
 * useHomeConfig 的环境变量名。
 *
 * 刻意以字符串常量而非字段表推导：它决定 env 文件从哪里读，必须在 env 文件
 * 加载**之前**单独解析，那时 `schema/fields.ts` 还不该被当作可用来源。
 */
export const HOME_CONFIG_KEY = "USE_HOME_CONFIG";

/** 主目录 ~/.proxy 路径（Windows 取 %USERPROFILE%） */
function getHomeConfigDir(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

/** 解析配置根目录 */
export function getConfigDir(useHome: boolean): string {
  if (useHome) {
    return getHomeConfigDir();
  }
  return process.cwd();
}

/** 目录缺失时创建 */
export function ensureConfigDir(useHome: boolean): void {
  const dir = getConfigDir(useHome);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
