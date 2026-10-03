/**
 * @fileoverview `src/cmd/` 的**唯一**出口（barrel，只转发）
 * @module cmd/index
 * @description
 * 本目录是命令层，四件事各答各的问题：命令表（`./specs.js`）、形参值的读法（`./values.js`）、分词与解析
 * （`./parse.js`）、给打字的建议（`./suggest.js`），外加 Tab 补全（`./complete.js`）与命令面板
 * （`./palette.js`）。本文件一行逻辑都没有：为什么要 barrel 与 `@/api/index.js` 同一条理由（本包是独立
 * 子包，目录将来拆分时调用方零改动），代价是多一层转发。
 *
 * 两条跨文件的层不变量：**命令表只有一份**（抄第二份的后果是「补全列表静默少一项而测试全绿」）；
 * **命令名给人看的样子只有一个出口**（`CommandSpec.path` 与 `./suggest.js:withPrefix` —— 呈现侧读 `name`
 * 的话，`help` 里印的是 `/user add` 而回车执行的是 `user add`）。零终端 / 零 React / 零 `@/ui` 与「失败
 * 文案不回显用户输入」写在 `./values.js`，前缀判据写在 `./parse.js`，本目录一律相对路径互引、禁止自我
 * 引用（那会把 barrel 与兄弟模块放进同一个循环依赖图）。
 *
 * @module
 */

export {
  COMMAND_NAMES,
  COMMAND_PREFIX,
  COMMAND_SPECS,
  TOP_LEVEL_NAMES,
  findSpec,
  type Command,
  type CommandSpec,
  type CompletionNames,
} from "./specs.js";
export { UNLIMITED_BYTES, USER_FIELDS, type UserField } from "./values.js";
export {
  parseLine,
  tokenize,
  type ParseResult,
  type TokenizeReason,
  type TokenizeResult,
} from "./parse.js";
export { suggestCommands } from "./suggest.js";
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