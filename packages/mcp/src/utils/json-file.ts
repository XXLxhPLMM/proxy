/**
 * @fileoverview `~/.swain-proxy/` 下两份 JSON 台账的位置与读写
 * @module utils/json-file
 * @description
 * ## 为什么不读环境变量
 * 认 `XDG_CONFIG_HOME` / `APPDATA` 等于让「东西在哪儿」取决于从哪里敲起这个进程，
 * 而那种分裂的部署比一个固定位置难查得多。函数签名上只有 `homedir` 一个入参。
 *
 * ## 坏内容即拒，绝不降级成空台账
 * 文件**不存在** ⇒ 空台账（首次运行）。文件**存在但形状不对** ⇒ 抛 `local`。
 * 降级成空台账是最坏的一种「体贴」：调用方「重新加一遍」就会拿那份空台账覆盖掉
 * 存着凭据的那一份 —— 而 `key` 是明文存的，覆盖掉等于凭据蒸发且无人察觉。
 */

import fs from "node:fs";
import path from "node:path";
import { McpError } from "./errors.js";

/** 配置目录名（Windows 与 POSIX 同一个字面量，接 `APPDATA` 会让 WSL 与 Windows 各有一份） */
export const CONFIG_DIR_NAME = ".swain-proxy";

/** 控制面清单文件名 */
export const MANAGERS_FILE = "managers.json";

/** 环境清单文件名 */
export const ENVS_FILE = "envs.json";

/** 目录 `0700` / 文件 `0600` —— token 与 key 就落在这些文件里 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function configDir(homedir: string): string {
  return path.join(homedir, CONFIG_DIR_NAME);
}

export function managersPath(homedir: string): string {
  return path.join(configDir(homedir), MANAGERS_FILE);
}

export function envsPath(homedir: string): string {
  return path.join(configDir(homedir), ENVS_FILE);
}

/** 建目录（`0700`）——⚠️ 递归建时 `mode` 只作用于**新建**的那几层，已存在的不改 */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

/**
 * 读一份 JSON 台账
 * @param fallback 文件**不存在**时给什么；⚠️ 存在而解析失败/形状不对 ⇒ 抛，不走这里
 */
export function readJsonFile<T>(file: string, fallback: T, validate: (value: unknown) => T): T {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (isNotFound(err)) {
      return fallback;
    }
    throw McpError.local(`读不到 ${file}：${errText(err)}`, err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw McpError.local(`${file} 不是合法 JSON（内容坏了，拒读而不是当成空台账）`, err);
  }

  try {
    return validate(parsed);
  } catch (err) {
    throw McpError.local(`${file} 的内容形状不对：${errText(err)}`, err);
  }
}

/**
 * 落盘一份 JSON 台账
 * @description
 * ⚠️ **先写临时文件再 rename**：直接 `writeFileSync` 到目标时，进程在写到一半被杀会留下
 * 一个截断的 JSON —— 而「下次读时拒读」正是上面那条纪律要保护的东西。rename 在同一目录内
 * 是原子的，故那份临时文件要么整体成为目标，要么什么都不成为。
 */
export function writeJsonFile(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const temp = `${file}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    // 先以 `0600` 建临时文件再写：默认创建模式受 umask 影响，写完再 chmod 有一个窗口期
    fs.writeFileSync(temp, text, { encoding: "utf8", mode: FILE_MODE });
    fs.chmodSync(temp, FILE_MODE);
    fs.renameSync(temp, file);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // 临时文件删不掉不该盖掉原始失败 —— 它的症状（目录里有个 .tmp）已是可查的
    }
    throw McpError.local(`写不到 ${file}：${errText(err)}`, err);
  }
}

/** `ENOENT` 判据（⚠️ 用 `code` 而不是 `instanceof`，那在跨 realm 时不成立） */
export function isNotFound(err: unknown): boolean {
  return isErrno(err, "ENOENT");
}

export function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === code;
}

/** 错误文本（⚠️ 只取 `message`，绝不取 `String(err)` —— 那会把栈整段带出去） */
export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
