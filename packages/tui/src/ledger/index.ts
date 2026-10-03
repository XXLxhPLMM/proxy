/**
 * @fileoverview `src/ledger/` 的**唯一出口**（barrel，只转发）
 * @module ledger/index
 * @description
 * 与 `@/api/index.js` 同一条纪律：目录对外只暴露这一个入口，界面层（`src/ui/`）一律从
 * `@/ledger/index.js` 取东西，不引 `@/ledger/store.js` 这类深路径。目录将来拆分时调用方零改动，
 * 代价是多一层转发，故**本文件只 `export`，一行逻辑都不许有**。
 *
 * 本目录内部一律用**相对路径**互引，**禁止自我引用**（`store.ts` 不引 `@/ledger/index.js`）——
 * 那会把 barrel 与它的兄弟模块放进同一个循环依赖图。
 *
 * @module
 */

export {
  DEFAULT_TIMEOUT_MS,
  NAME_MAX_LEN,
  TIMEOUT_BOUNDS,
  type Ledger,
  type Target,
  type TargetInput,
  type TimeoutBounds,
  type UpsertInput,
} from "./types.js";
export {
  LedgerError,
  validateLedger,
  validateTargetInput,
  type LedgerErrorCode,
} from "./validate.js";
export { REDACTED_TOKEN, readLedger, redactTarget, writeLedger, type TargetView } from "./store.js";
export { idFor, removeTarget, selectedTarget, setSelected, slugify, upsertTarget } from "./edit.js";
export { clientFor, probeTarget, type ProbeResult } from "./connect.js";
export { resolveConfigDir, targetsPath, type EnvLike } from "./path.js";
