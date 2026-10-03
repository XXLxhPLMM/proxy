/**
 * @fileoverview `src/exec/` 的**唯一**出口（barrel，只转发）
 * @module exec/index
 * @description
 * 执行层：**一条已解析的命令 → 若干行 + 一组副作用**。四件事各答一个问题：`./run.js`（入口与两个穷举的
 * 分派）、`./failures.js`（失败 → 那几句话）、`./rows.js`（控制面回的东西 → 那些行）、`./echo.js`（回显
 * 那一行与凭据掩码）。层不变量写在 `./run.js` 的文件头。
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