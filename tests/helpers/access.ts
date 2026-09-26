/**
 * 测试侧的**显式放行档**：`AccessControl` 端口的「这个部署不判名单」档。
 *
 * @description
 * ⚠️ **在 core 里它不许有缺省档**（`ProxyOptions.access` 是必填的，core 侧零缺省解析）：
 * 缺席走到全放行是安全语义的静默失败，必须编译期拦住。**在测试里它必须以「调用点名写出来」
 * 的形态存在**——原因同向：一条忘了注入 `access` 的名单用例会「配了黑名单、请求照过、
 * 测试全绿」，那正是本仓反复吃亏的最坏失败形态（已真实发生过一次：某次迁移中 5 个
 * integration 文件因「直构 core 不注入 `access`」而整组名单护栏失效，且**全绿**）。
 * ⚠️ **但它绝不能被无脑铺开**：判据是「显式放行档**只许出现在「这个测试与访问控制无关」
 * 的位置**」，每个调用点都必须把这句话写在 import/调用处附近。**凡是断言名单语义的测试
 * 一律不许用它**——那些位置要 `createFileAccessControl(config)`（`tests/AGENTS.md` 登记的
 * 那几个文件）。
 *
 * **本文件确立的判据**：显式放行档**只许出现在「这个测试与访问控制无关」的位置**，且每个
 * 调用点都必须把这句话写在 import/调用处附近。**凡是断言名单语义的测试一律不许用它**——
 * 那些位置要 `createFileAccessControl(config)`（`tests/AGENTS.md` 登记的那几个文件）。
 *
 * @example
 * ```ts
 * // 这个用例只测连接复用，与名单无关 → 显式点名「不判名单」
 * await withProxy(HttpProxy, { ctx, access: openAccessControl() }, async () => { … });
 * ```
 */
import type { AccessControl } from "@/core/types/proxy.js";

/**
 * 显式放行档：入站对端恒准入、出站目标恒准入、路由判定恒「不因名单回落直连」。
 *
 * @description **三个方法的答案逐字照抄被删掉的 `OPEN_ACCESS_CONTROL`**，一档不多一档不少。
 * 其中 `checkRoute` 的答案最容易写反，故在这里写死原因：
 *
 * ⚠️ **恒 `{ direct: false }` 而不是 `{ direct: true }`**。`direct` 的语义是「**这个目标该
 * 直连吗**」（client 模式的路由名单命中即回落直连），`false` = 「没有名单说它该直连」=
 * **保持既有路由决策**。写成 `true` 会让一个「不判名单」的 client 模式部署把**所有**流量
 * 静默改成直连——那是**流量旁路**，比拒绝更坏，且同样零信号。
 *
 * `checkClient` / `checkTarget` 的放行**不写 `reason` / `source` 键**：端口注释里
 * 「放行恒为 `{allowed:true}`」是承重的——「哪一层放的」对放行没有意义，写了会让
 * 「两关都过」与「上层不存在」在载荷上无法区分。
 *
 * @returns 一份**新对象**（每次调用现造，便于测试按需覆写某几个方法）
 */
export function openAccessControl(): AccessControl {
  return {
    checkClient: () => ({ allowed: true }),
    checkTarget: () => ({ allowed: true }),
    checkRoute: () => ({ direct: false }),
  };
}
