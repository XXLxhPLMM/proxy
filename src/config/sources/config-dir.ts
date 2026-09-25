/**
 * 配置目录解析：`~/.proxy` 还是显式 cwd。
 *
 * 必须在读 env 文件**之前**确定，因为 env 文件的相对路径与各 path 字段默认值都以它为锚。
 * 只解析路径、绝不创建目录。
 */

import os from "node:os";
import path from "node:path";

const CONFIG_DIR_NAME = ".proxy";

/** useHomeConfig 环境变量名（决定 env 文件读取目录，需在加载 env 文件前单独解析） */
export const HOME_CONFIG_KEY = "USE_HOME_CONFIG";

/** 主目录 ~/.proxy 路径（Windows 取 %USERPROFILE%）。 */
function getHomeConfigDir(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

/**
 * 解析配置根目录。
 *
 * @param useHome - 是否使用用户主目录作为配置目录
 * @param cwd - 非 home 模式下的显式配置目录；缺省使用进程 cwd
 */
export function getConfigDir(useHome: boolean, cwd?: string): string {
  if (useHome) {
    return getHomeConfigDir();
  }
  return cwd === undefined ? process.cwd() : path.resolve(cwd);
}
