import type { ProxyCore, ProxyOptions } from "@/core/types/proxy.js";
import { createFileAccessControl } from "@/core/access-control.js";
import { getFreePort } from "./net.js";
import { testContext } from "./config.js";

/**
 * 在空闲端口起真代理，显式注入测试依赖上下文，运行完自动 stop。
 *
 * @description
 * `ctx` 缺省吃共享的 `testContext`（56 个调用点都吃这个默认值；需要自定义
 * logger/accessor 的用例显式传 `ctx`）。
 *
 * ### `access` 为什么是**唯一**一个有缺省档的注入位，且那个缺省**不是**放行桩
 *
 * `ProxyOptions.access` 在类型上是**必填**的、core 侧**零缺省解析**——「忘了注入 → 全放行
 * 且零信号」必须在编译期被拦住。
 * 但 `withProxy` 收的是 `Partial<ProxyOptions>`，若这里什么都不做，TypeScript 不会逼每个
 * 调用点表态，于是同一个坑会**从 core 搬到脚手架**：`access` 变成 `undefined`，
 * `services.access` 跟着是 `undefined`，第一个请求上炸 `undefined is not a function`
 * ——或者更坏：某个调用点「顺手补一个恒放行桩」，名单护栏就静默失效且全绿（本仓真发生过）。
 *
 * 所以缺省给的是 **`createFileAccessControl(ctx.config)`，即生产上的那一份默认实现**：
 * - 它**不可能比生产更安全**——它就是生产的默认装配（`createProxyRuntime` →
 *   `buildDefaultServices` 解析的就是它）。`tests/AGENTS.md` 当年否决「把缺省做进
 *   `withProxy`」的理由是「那会让测试环境比生产更安全」；**那个理由只对「一律放行桩」成立**，
 *   对「配置驱动的真实实现」不成立，本条裁决随之改向。
 * - 于是「忘注入」的后果从「护栏静默失效」变成「按配置真的判」：写名单的用例即使忘了
 *   注入 `access` 也会被拦住（而不是全绿），不写名单的用例因 `setup-env.ts` 把 `aclFile`
 *   钉成不存在的绝对路径而恒放行。
 * - **断言名单语义的测试仍然必须显式注入** `createFileAccessControl(ctx.config)`
 *   （`tests/AGENTS.md` 登记的那几个文件）——那让「这个文件在测名单」这件事在代码里可见，
 *   而不是靠「碰巧生效」。
 *
 * ⚠️ **不要把这里换成 `openAccessControl()`**（`helpers/access.ts` 那份显式放行桩）。
 * 那正是本条纪律要消灭的东西：它让「忘注入」重新变成「静默失效」。
 * 需要「这个测试不判名单」时，**在调用点显式写 `access: openAccessControl()`**。
 */
export async function withProxy<T extends ProxyCore>(
  Cls: new (opts: ProxyOptions) => T,
  opts: Partial<ProxyOptions>,
  fn: (port: number, proxy: T) => Promise<void>,
): Promise<void> {
  const port = await getFreePort();
  const ctx = opts.ctx ?? testContext;
  const p = new Cls({
    host: "127.0.0.1",
    port,
    ...opts,
    ctx,
    // 唯一一个有缺省档的注入位：给的是**生产上的那一份**（配置驱动的名单判定），
    // 不是放行桩。理由与代价见上方 `withProxy` 的 @description。
    access: opts.access ?? createFileAccessControl(ctx.config),
  });
  await p.start();
  try {
    await fn(port, p);
  } finally {
    await p.stop().catch(() => {});
  }
}
