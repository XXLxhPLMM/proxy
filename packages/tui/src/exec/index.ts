/**
 * @fileoverview `src/exec/` 的**唯一**出口（barrel，只转发）
 * @module exec/index
 * @description
 * 执行层：**一条已解析的命令 → 若干行 + 一组副作用**（{@link ./run.ts}）。
 *
 * 本目录的层不变量写在 `@/exec/run.ts` 的文件头（零 Ink / 零 React / 不碰状态 / 逐字限定不许改写 /
 * 凭据不进任何一行）。barrel 只转发，一行逻辑都不许有。
 *
 * @module
 */

export {
  exec,
  type Effect,
  type ExecDeps,
  type ExecResult,
  type LedgerWrite,
  type TargetAddRequest,
} from "./run.js";