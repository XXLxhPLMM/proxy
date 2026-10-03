/**
 * @fileoverview `src/cmd/` 的**唯一**出口（barrel，只转发）
 * @module cmd/index
 * @description
 * 本目录是命令层：一行文本 → 一条命令（{@link ./parse.ts}）与给打字的建议
 * （{@link ./complete.ts}）。它对目录外只暴露这两件事的全部承诺，本文件一行逻辑都没有。
 *
 * 为什么要 barrel：与 `@/api/index.js` / `@/ledger/index.js` / `@/ui/index.js` 同一条理由
 * （本包是独立子包，目录将来拆分时调用方零改动），代价是多一层转发，故**本文件只 `export`**。
 *
 * ## 本目录的层不变量
 * @description
 * - **零终端、零 React、零 `@/ui`、零 HTTP、零 `fs`、零 `process.*`、零 `console`**：
 *   一台没有终端的机器上就能把这两层的每一条判据单测掉。执行（发请求、读台账、清屏）
 *   全在别的层，故本目录能被人独立审。
 * - **命令表只有一份**（`./parse.ts` 里的那张表），解析 / `help` / 补全 / 命令面板四处共读它；
 *   抄第二份的后果是「补全列表静默少一项而测试全绿」。
 * - **命令名给人看的样子只有一个出口**：`CommandSpec.path`（= `/` + `name`，算出���）与
 *   `parse.ts:withPrefix`。⚠️ 呈现侧读 `name` 的话，`help` 里印的是 `/user add` 而回车执行的是
 *   `user add` —— 一屏两句话，且 `parseLine` 只认后者。
 * - ⚠️ **任何失败分支的文案都不回显用户输入**：凭据（`user pass` 的密码、`target add` 的
 *   token）会被敲错，而「你输入错了：…」那句话会把凭据抄进可滚动、可复制的结果区。
 * - 本目录内部一律用**相对路径**互引，**禁止自我引用**（`./parse.ts` 不引 `./index.js`）——
 *   那会把 barrel 与它的兄弟模块放进同一个循环依赖图。
 *
 * @module
 */

export {
  COMMAND_NAMES,
  COMMAND_PREFIX,
  COMMAND_SPECS,
  TOP_LEVEL_NAMES,
  UNLIMITED_BYTES,
  USER_FIELDS,
  findSpec,
  parseLine,
  suggestCommands,
  tokenize,
  type Command,
  type CommandSpec,
  type CompletionNames,
  type ParseResult,
  type TokenizeReason,
  type TokenizeResult,
  type UserField,
} from "./parse.js";
export { complete, type Completion, type CompletionRequest } from "./complete.js";
export {
  PALETTE_ROWS,
  commandHead,
  paletteFill,
  paletteOf,
  paletteOpen,
  paletteStep,
  paletteWindow,
  type Palette,
  type PaletteRow,
} from "./palette.js";
