/** `@/services/config` 的唯一出口：本机那一份 SQLite 存着台账与会话，长什么样、怎么改、怎么变成一个能发请求的客户端 */

export {
  DEFAULT_TIMEOUT_MS,
  NAME_MAX_LEN,
  TIMEOUT_BOUNDS,
  type Ledger,
  type ProviderInput,
  type ProviderSettings,
  type Target,
  type TargetInput,
  type TimeoutBounds,
  type UpsertInput,
} from "./types.js";
export {
  LedgerError,
  validateLedger,
  validateProviderInput,
  validateTargetInput,
  type LedgerErrorCode,
} from "./validate.js";
export {
  REDACTED_PROVIDER_KEY,
  readProvider,
  redactProvider,
  writeProvider,
} from "./provider.js";
export { closeLedgerDb } from "./db.js";
export {
  REDACTED_TOKEN,
  readLedger,
  readSessions,
  redactTarget,
  removeSession,
  renameSession,
  saveSession,
  setSessionVisible,
  writeLedger,
  type TargetView,
} from "./store.js";
export { idFor, removeTarget, selectedTarget, setSelected, slugify, upsertTarget } from "./edit.js";
export { clientFor, probeTarget, type ProbeResult } from "./connect.js";
export { dbPath, resolveConfigDir } from "./path.js";