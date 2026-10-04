/** 执行层的唯一出口（barrel，只转发）：一条已解析的命令 → 若干行 + 一组副作用 */

export {
  batchTargetNames,
  exec,
  type BatchPeer,
  type BatchReport,
  type Effect,
  type ExecDeps,
  type ExecResult,
  type LedgerWrite,
  type TargetAddRequest,
} from "./run.js";
export { fanOut } from "./batch.js";
export { echoOf, leavesTrace } from "./echo.js";