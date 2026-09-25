/**
 * rules 层出口：acl.json 名单条目的**数据层**契约（解析 / 编译 / 匹配）。
 *
 * 引用规约：
 * - **跨目录只引 `@/config/files/rules/index.js`**（core 侧判定层从本 barrel 取名单原语）；
 * - config 目录内部其它位置用**相对路径**（`./rules/ip.js`），不自我引用 barrel，避免循环依赖。
 *
 * 边界：本层零配置依赖（不引 `@/config/index.js`）、零 IO、零日志，只做纯数据变换；
 * 请求期判定（黑白名单优先级、整组缺失回退、命中后动作）在 `src/core/access-control.ts`。
 */

export * from "./ip.js";
export * from "./host.js";
