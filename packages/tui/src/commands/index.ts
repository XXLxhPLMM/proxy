/** 命令层的唯一出口（barrel，只转发）：命令表 / 值的读法 / 分词与解析 / 建议 / Tab 补全 / 命令面板 */

export {
  COMMAND_NAMES,
  COMMAND_PREFIX,
  COMMAND_SPECS,
  findSpec,
  type BatchDraft,
  type Command,
  type CommandSpec,
  type CompletionNames,
} from "./specs.js";
export {
  ALL_TARGETS,
  UNLIMITED_BYTES,
  readTraffic,
  ValueError,
} from "./values.js";
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
  enterOutcomeOf,
  paletteFill,
  paletteOf,
  paletteOpen,
  paletteStep,
  paletteWindow,
  type EnterOutcome,
  type Palette,
  type PaletteRow,
} from "./palette.js";