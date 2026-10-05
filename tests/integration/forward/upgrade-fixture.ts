/**
 * 两档 `upgrade-*` 共用的装配面：自建事件总线 + 文件驱动访问控制、真 `HttpProxy` 起停、
 * 手写 Upgrade 请求的那一条客户端、以及配置快照/恢复这一组 hook。
 *
 * 档级不变量（「每请求恰好一条 `route`」与「自环两侧都必须在拨号前拒」各自的判据）归
 * `./AGENTS.md`，本模块只提供两档共用的那一套符号。
 *
 * ⚠️ **hook 一律导出成普通函数、由使用档在自己的 `describe` 里注册**（见
 * {@link prepareEach} / {@link cleanupEach}）—— fixture 的模块顶层 `beforeEach` 虽然在
 * vitest 下也会挂到使用档的根 suite 上（实测有效），但那样档里就看不到「这份配置快照是谁
 * 建的、那些桩是谁收的」，而快照与桩池都归本模块所有，登记点必须与它们同处一档才读得出来。
 *
 * ⚠️ **刻意住在 `tests/integration/forward/` 而不是 `tests/helpers/`**：`external-network-scan.ts`
 * 的 `SCAN_DIRS` 排除 `helpers/`，而 `walk()` 收目录下**全部** `.ts` —— 搬进 `helpers/`
 * 等于让这里这一部分覆盖从零外网扫描里**静默消失**（`no-external-network.test.ts` 的两条
 * 下界断言照样绿）。
 *
 * @module tests/integration/forward
 */
import { HttpProxy } from "@/core/server/http.js";
import { createFileAccessControl } from "@/core/access-control.js";
import type { EventHub, EventSubscription } from "@/core/events/index.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import { EventHub as Hub } from "@/core/events/index.js";
import { getFreePort } from "../../helpers/net.js";
import { makeCollector, tcConnect } from "../../helpers/socks-client.js";
import { startUpstreamStub, type UpstreamStub } from "../../helpers/upstream-stub.js";
import { restoreConfig, set, silenceLogs, snapshotConfig, testConfig, testLogger } from "../../helpers/config.js";
import type { CoreContext } from "@/core/context.js";

/** 本模块自建一条总线（往共享测试总线上挂长期订阅会跨用例累积） */
const bus: EventHub = new Hub({ onListenerError: () => undefined });
const ctx: CoreContext = { config: testConfig, logger: testLogger, events: bus };

/**
 * 文件驱动的访问控制。
 *
 * @description
 * `ProxyOptions.access` 是**必填**的（`access: AccessControl`，无 `?`）：全仓不存在
 * `OPEN_ACCESS_CONTROL` 那个「恒放行」符号，**缺席即全放行**，所以必须编译期拦。
 * 这两档都自建 `HttpProxy`，
 * 故必须显式注入，否则「upstream 路由名单命中 → 回落直连」与「目标命中黑名单 → 恰好一条
 * `target-denied`」两条被测行为整条消失（自环那档则整条 `preDial` → `isSelfLoopAddr`
 * 判定链不会被建起来）。
 *
 * ⚠️ 本应住在 `tests/helpers/proxy.ts` 紧邻 `withProxy`（那里是所有直构 core 的汇聚点）；
 * 它就地定义而没有放进 `tests/helpers/**`（登记在 `tests/AGENTS.md`，待收口）。
 */
const fileAccess = createFileAccessControl(ctx.config);

/** 本模块涉及的配置键（逐键快照/恢复，不依赖生产全局 store） */
const KEYS = [
  "aclFile",
  "authEnabled",
  "authType",
  "host",
  "port",
  "proxyMode",
  "upstreamHost",
  "upstreamPort",
  "upstreamProtocol",
  "upstreamTimeout",
  "logLevel",
  "logFile",
] as const;

/** 客户端请求的目标（非本机，避免与自环判定混淆） */
export const DEST_HOST = "target.example";
export const DEST_PORT = 8443;

/** 跨用例存活的桩池：由 {@link cleanupEach} 负责收干 */
const stubs: UpstreamStub[] = [];
let snap: Record<string, unknown> = {};

/**
 * `beforeEach` 的登记体：配置快照 + 静音 + 两条档级前提（关鉴权、client 模式）
 *
 * @description
 * 由两档各自在自己的 `describe` 里 `beforeEach(prepareEach)` 注册 —— 本模块**不**自己调
 * vitest 的 hook（理由见文件头）。快照键表 {@link KEYS} 含 `aclFile` 与全部 `upstream*`：
 * 两档的用例都逐键 `set` 它们，漏一个键就会把用例的设置泄到下一个文件。
 */
export function prepareEach(): void {
  snap = snapshotConfig(KEYS);
  silenceLogs();
  set("authEnabled", false);
  set("authType", "none");
  set("proxyMode", "client");
}

/**
 * `afterEach` 的登记体：先收干桩池，再恢复配置
 *
 * @description
 * 顺序是**必需**的：桩是在当前配置下起起来的，先 `restoreConfig` 就等于让它们在被回收前
 * 经历一次配置漂移；反过来先收桩则回收与配置无关。两档各自 `afterEach(cleanupEach)`。
 */
export async function cleanupEach(): Promise<void> {
  for (const s of stubs.splice(0)) {
    await s.close();
  }

  restoreConfig(snap);
}

/** 取某一类事件的全部载荷（按 `type` 过滤） */
export function ofType(events: PipeEvent[], type: PipeEvent["type"]): PipeEvent[] {
  return events.filter((e) => e.type === type);
}

/**
 * 起一个真 `HttpProxy` 并把它的 pipe 事实收进数组
 *
 * @description
 * `set("port", port)` 是**必需**的：`isSelfLoopAddr` 的判据是
 * `destHost:destPort` vs 配置里的 `host`/`port`，而真实监听端口由 `withProxy` 内部随机取、
 * 调用方拿不到。这里自己取端口再构造，两边就一致了 —— 自环那档的全部前提就在这一行。
 */
export async function withWsProxy(
  fn: (port: number, events: PipeEvent[]) => Promise<void>,
): Promise<void> {
  const events: PipeEvent[] = [];
  const sub: EventSubscription = bus.subscribe("pipe", (e) => events.push(e.data));
  const port = await getFreePort();

  set("host", "127.0.0.1");
  set("port", port);

  const proxy = new HttpProxy({ host: "127.0.0.1", port, ctx, access: fileAccess });

  await proxy.start();

  try {
    await fn(port, events);
  } finally {
    sub.dispose();
    await proxy.stop().catch(() => undefined);
  }
}

/**
 * 手写一条 Upgrade 请求打给代理，等到**第一个完整响应头**（`CRLFCRLF`）就返回原始字节
 *
 * @description
 * 拒绝路径（400/403/502）与拨号失败路径（502）都由 `refuse` 写一段含 `CRLFCRLF` 的裸状态行，
 * 所以「拿到响应头」这个判据对成功与失败都成立；而成功路径要等 101 之后才有隧道数据，
 * 这两档只关心「守卫/路由事件」不关心载荷，故统一在响应头处收手。
 */
export async function upgradeTo(
  port: number,
  host: string,
  targetPort: number,
  ms = 5000,
): Promise<Buffer> {
  const client = await tcConnect(port);
  const c = makeCollector(client);

  client.write(
    `GET /ws HTTP/1.1\r\nHost: ${host}:${targetPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`,
  );

  try {
    return await c.waitFor((b) => b.includes(Buffer.from("\r\n\r\n")), ms);
  } finally {
    client.destroy();
  }
}

/**
 * 起一个**明文**上游桩并登记进 {@link cleanupEach} 的池
 *
 * @description
 * `secure: false` 是刻意的：这两档要在桩上观测 `firstBytes()` / `connections()`，TLS 承载会把
 * 那两样读数变成握手时序相关的不稳定量。登记进池而不是交给调用点，是因为池归本模块所有、
 * 回收也归本模块 —— 暴露一个 `push` 出口就等于让「谁负责关它」这件事重新散回两档。
 */
export async function upstreamStub(protocol: "socks5" | "https"): Promise<UpstreamStub> {
  const s = await startUpstreamStub(protocol, { secure: false });

  stubs.push(s);

  return s;
}
