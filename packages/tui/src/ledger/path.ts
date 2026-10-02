/**
 * @fileoverview 台账的**路径**：一份 JSON 落在哪儿（纯函数，宿主环境由调用方注入）
 * @module ledger/path
 * @description
 * 本模块只算路径，不读也不写。它把「宿主环境」做成**两个入参**（`env` 与 `homedir`），不是读
 * `process.env` / 不调 `os.homedir()` —— 理由是本层要守住「零 `process.*`」这条纪律（呈现归 UI
 * 层，而路径是纯计算），而「同一段算路逻辑在不同宿主上跑出同一份结果」也只有注入才测得出来。
 *
 * ## ⚠️ Windows 也走 `XDG_CONFIG_HOME` / `~/.config`，**不接 `APPDATA`**
 * @description
 * 这是本目录最重要的一条设计决定，也是最容易被「按平台惯例」推翻的一条。接 `APPDATA` 的理由只能
 * 说出「Windows 用户在那儿找得到」，但代价是**台账分裂成两份**：在 WSL 里加的 manager，Windows
 * 侧的 TUI 看不见；在 Windows 侧加的，WSL 里看不见。而本工具的现实用法恰恰横跨这两侧 —— 它连的是
 * 别的机器上的控制面，**它自己跑在哪台机器上与被代理的服务毫无关系**，人只是顺手在两个环境里都
 * 开过它。分裂的后果不是「多点两下」，而是「我明明加过了，怎么又没了」—— 于是人会去重新敲一份
 * 凭据，而重新敲的往往是另一份（错的）。
 *
 * 代价是 Windows 上它不在「最顺手」的位置。这是真的代价，故写在这里而不是藏起来：约定写在
 * {@link ./AGENTS.md} 与界面上（初始化时把路径原样显示出来），让「位置不对」是一个**看得见**的
 * 事实，而不是「配置好像没生效」。
 *
 * ## 相对 `XDG_CONFIG_HOME` 一律忽略
 * @description
 * XDG 基础目录规范要求其中的路径是绝对的，而一个相对值会被解析到**当前工作目录** —— 于是台账位置
 * 取决于「你是从哪个目录敲的 `proxy-tui`」，同一台机器上敲两次能读出两份台账。规范对这种情况的
 * 处置就是「忽略」，本模块照办。
 */

import path from "node:path";

/**
 * 宿主环境的一个**收窄**切片
 * @description
 * 刻意不写 `NodeJS.ProcessEnv`：那个类型会把「本层知道有个进程」这件事写进签名，而本层的纪律正是
 * 不认识进程。调用方（组合根）手里有什么给什么。
 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/** 台账配置目录名（挂在配置根下的一层） */
const CONFIG_DIR_NAME = "proxy-tui";

/** 台账文件名 */
const TARGETS_FILE = "targets.json";

/**
 * 台账的配置目录
 * @description
 * 纯函数：`env` 与 `homedir` 都是入参，本模块不碰进程。
 *
 * @param env - 宿主环境（读 `XDG_CONFIG_HOME`，缺省 / 空 / 非绝对值都回落到 `homedir`）
 * @param homedir - 用户主目录
 * @returns 台账配置目录的绝对路径
 * @example resolveConfigDir({ XDG_CONFIG_HOME: "/etc/xdg" }, "/home/u") // => "/etc/xdg/proxy-tui"
 * @example resolveConfigDir({}, "/home/u") // => "/home/u/.config/proxy-tui"
 */
export function resolveConfigDir(env: EnvLike, homedir: string): string {
  const configured = env["XDG_CONFIG_HOME"]?.trim() ?? "";
  const root =
    configured !== "" && path.isAbsolute(configured) ? configured : path.join(homedir, ".config");
  return path.join(root, CONFIG_DIR_NAME);
}

/**
 * 台账文件路径
 * @description
 * 唯一的台账文件。它叫 `targets.json` 而不是 `ledger.json`：这个文件里除了端点清单就只有
 * 「上次选中哪个」—— 而那本身就是端点清单上的一个引用。
 *
 * @param env - 宿主环境
 * @param homedir - 用户主目录
 * @returns 台账文件的绝对路径
 */
export function targetsPath(env: EnvLike, homedir: string): string {
  return path.join(resolveConfigDir(env, homedir), TARGETS_FILE);
}
