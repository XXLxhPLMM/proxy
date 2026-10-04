/** `@/services/config` 的唯一出口：本机一份台账的存在哪儿、长什么样、怎么改、怎么变成一个能发请求的客户端 */

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