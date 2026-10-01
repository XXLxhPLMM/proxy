/**
 * addr 层出口：地址与主机文本的**语法层**（解析 / 编译 / 匹配）。
 *
 * 跨目录只引本 barrel（`@/addr/index.js`）、层内用相对路径不自我引用 barrel。判定
 * （黑白名单优先级、整组缺失回退、命中后动作）在 `src/core/access-control.ts`。
 */

export * from "./ip.js";
export * from "./host.js";
