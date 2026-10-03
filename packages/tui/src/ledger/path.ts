/**
 * @fileoverview 台账的**路径**：一份 JSON 落在哪儿（纯函数，宿主环境由调用方注入）
 * @module ledger/path
 * @description
 * 本模块只算路径，不读也不写，也不碰进程 —— `env` 与 `homedir` 都是**入参**。
 *
 * ⚠️ Windows 也走 `XDG_CONFIG_HOME` / `~/.config`，**不接 `APPDATA`**：接了会让台账分裂成 WSL 与 Windows 两
 * 份（在一边加的 manager 另一边看不见），而本工具连的是别的机器上的控制面、**自己跑在哪台机器上与被代理的服
 * 务毫无关系**。代价是 Windows 上它不在最顺手的位置 —— 真的代价，故路径在初始化时原样显示。
 *
 * ⚠️ 相对 `XDG_CONFIG_HOME` 一律忽略：它会被解析到**当前工作目录**，于是台账位置取决于「你是从哪个目录敲的
 * `proxy-tui`」。
 *
 * @module
 */

import path from "node:path";

/**
 * 宿主环境的一个**收窄**切片
 * @description 刻意不写 `NodeJS.ProcessEnv`：那个类型会把「本层知道有个进程」写进签名，而本层的纪律正是不认识
 * 进程。
 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

const CONFIG_DIR_NAME = "proxy-tui";

const TARGETS_FILE = "targets.json";

/**
 * 台账的配置目录
 * @param env - 宿主环境（读 `XDG_CONFIG_HOME`，缺省 / 空 / 非绝对值都回落到 `homedir`）
 * @param homedir - 用户主目录
 * @example resolveConfigDir({ XDG_CONFIG_HOME: "/etc/xdg" }, "/home/u") // => "/etc/xdg/proxy-tui"
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