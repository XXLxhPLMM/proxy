/**
 * 地址层出口：地址与主机文本的**字面量手术**与**条目语法**。
 *
 * 跨目录只引本 barrel（`@/utils/addr/index.js`）、层内用相对路径不自我引用 barrel。
 * 判定（黑白名单优先级、整组缺失回退、命中后动作）在 `src/core/access-control.ts`。
 *
 * 目录内两档，**不变量都在各文件的头注释里**：
 * - `text.ts` — 字符级原子，无业务语义，`config` / `core` / `datasource` 都直接用
 * - `ip.ts` / `host.ts` — 名单条目语法（回答「一条名单条目怎么写」），零 IO、零配置、零日志
 * - `inbound.ts` — 入站请求 / 套接字 → 对端地址与 authority，请求期现算不进缓存
 */

export * from "./text.js";
export * from "./ip.js";
export * from "./host.js";
export * from "./inbound.js";