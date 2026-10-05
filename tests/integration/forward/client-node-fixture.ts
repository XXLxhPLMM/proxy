/**
 * 两档 `http-client-node*` 共用的装配面：那份起真 `HttpProxy` 的 `startProxy`、
 * 两档 `beforeAll` 共用的基础配置、以及快照用的配置键表。
 *
 * 档级不变量（明文 / CONNECT / Upgrade 三条通道各自的判据）归 `./AGENTS.md`，本模块只提供
 * 两档共用的那一套符号。
 *
 * ⚠️ **刻意住在 `tests/integration/forward/` 而不是 `tests/helpers/`**：`external-network-scan.ts`
 * 的 `SCAN_DIRS` 排除 `helpers/`，而 `walk()` 收目录下**全部** `.ts` —— 搬进 `helpers/`
 * 等于让这里这一部分覆盖从零外网扫描里**静默消失**（`no-external-network.test.ts` 的两条
 * 下界断言照样绿）。
 *
 * @module tests/integration/forward
 */
import { set, silenceLogs, testContext } from "../../helpers/config.js";
import { HttpProxy } from "@/core/server/http.js";
import type { IdentityProvider } from "@/core/types/identity.js";
import { getFreePort } from "../../helpers/net.js";
import { openAccessControl } from "../../helpers/access.js";

/** 本模块涉及的配置键（逐键快照/恢复） */
export const KEYS = ["host", "port", "proxyMode", "logLevel", "logFile"] as const;

/**
 * 两档 `beforeAll` 共用的那段基础配置
 *
 * @description 静音 + 钉死监听地址与 server 模式；两档的源站（明文 http / ws 回声）各自不同，
 * 留在各自档里。
 */
export function serverBaseConfig(): void {
  silenceLogs();
  set("host", "127.0.0.1");
  set("proxyMode", "server");
}

/**
 * 起一个真 `HttpProxy`（server 模式）并等它 listening
 *
 * @description
 * `set("port", port)` 是**必需**的：`isSelfLoopAddr` 拿配置里的 `host` / `port` 当被环目标，
 * 不钉住它，客户端请求的目标恰是本机端口时会被自环守卫拦掉。
 * 返回句柄让调用点自己 `stop()` —— 两档的用例都是「起一条、断言完就停」，中间还要换身份。
 */
export async function startProxy(identity: IdentityProvider): Promise<{ proxy: HttpProxy; port: number }> {
  const port = await getFreePort();
  set("port", port);
  // 鉴权用例与名单无关 → 显式点名「不判名单」（core 侧已无 access 缺省）
  const proxy = new HttpProxy({
      ctx: testContext, host: "127.0.0.1", port, identity, access: openAccessControl() });
  await proxy.start();
  return { proxy, port };
}
