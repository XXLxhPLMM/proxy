/**
 * @fileoverview 台账的**路径**（纯函数，宿主环境由调用方注入）；⚠️ Windows 也走 `XDG_CONFIG_HOME` / `~/.config` 而**不接 `APPDATA`**（接了会让台账分裂成 WSL 与 Windows 两份），⚠️ 相对 `XDG_CONFIG_HOME` 一律忽略
 */

import path from "node:path";

/** 宿主环境的一个**收窄**切片（⚠️ 刻意不写 `NodeJS.ProcessEnv`：本层的纪律是不认识进程） */
export type EnvLike = Readonly<Record<string, string | undefined>>;

const CONFIG_DIR_NAME = "proxy-tui";

const TARGETS_FILE = "targets.json";

/**
 * 台账的配置目录
 * @param env 宿主环境（读 `XDG_CONFIG_HOME`，缺省 / 空 / 非绝对值都回落到 `homedir`）
 * @param homedir 用户主目录
 */
export function resolveConfigDir(env: EnvLike, homedir: string): string {
  const configured = env["XDG_CONFIG_HOME"]?.trim() ?? "";
  const root =
    configured !== "" && path.isAbsolute(configured) ? configured : path.join(homedir, ".config");
  return path.join(root, CONFIG_DIR_NAME);
}

export function targetsPath(env: EnvLike, homedir: string): string {
  return path.join(resolveConfigDir(env, homedir), TARGETS_FILE);
}