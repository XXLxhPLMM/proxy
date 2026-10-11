/**
 * @fileoverview 配置的落点：全部住在 `<home>/.config/swain-proxy/tui/` 下（各节的默认落点归自家文件夹）
 * @module config/paths
 * @description 位置固定、不读环境变量——宿主差异只在 `homedir()` 这一处出；配置文件候选
 * `config.json` 优先、其次 `config.jsonc`（两个都在时 `.json` 生效）。
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** 配置与数据的总目录：`~/.config/swain-proxy/tui` */
export function configRootDir(): string {
  return join(homedir(), ".config", "swain-proxy", "tui");
}

/** 配置文件候选（按优先级）：`config.json` → `config.jsonc` */
export function configFileCandidates(): readonly string[] {
  return [join(configRootDir(), "config.json"), join(configRootDir(), "config.jsonc")];
}

/** 展开开头的 `~`（配置里允许写 `~/…` / `~\…`）；其余原样返回 */
export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(homedir(), input.slice(2));
  return input;
}
