/**
 * @fileoverview `src/` 的**唯一**出口（barrel，只转发）
 * @module index
 * @description
 * 与 `@/api/index.js` / `@/ledger/index.js` / `@/ui/index.js` / `@/view/index.js` 同一条
 * 纪律：本包对外只暴露这一个入口，目录将来拆分时调用方零改动。故**本文件只 `export`，
 * 一行逻辑都不许有** —— 顺手在这里加一个「启动前检查一下终端」是本仓最典型的假绿来源
 * （检查会跑，而跑不跑取决于调用方有没有 import 这个文件）。
 *
 * ⚠️ 它转发 `main` 意味着 `import` 本包会把 `cli.tsx` 一起拉进来，而后者**只在它自己是入口时**
 * 才调 `main()`（ESM 的 `import.meta.url` 判据，见 `./cli.tsx` 文件头）。故 import 是零副作用的，
 * 这条由 `./cli.tsx` 那句 `if` 保证，不由本文件保证。
 *
 * @module
 */

export { App, type AppProps } from "./app.js";
export { main } from "./cli.js";
