/**
 * 两档 `admission-order-*` 共用的装配面：临时 `acl.json`、真源站、真 runtime + 一条**专属**事件总线、
 * 真 `FileAccountIdentity`，以及那三样跨用例存活的东西的回收。
 *
 * @description
 * 档级不变量（关卡 ①②③ 的定义与顺序理由、两条准入结构的决策、以及「名单拒那两档必须开着鉴权」
 * 这个已实测的假绿）归 `./AGENTS.md`，本模块只提供两档共用的那一套符号。
 *
 * ⚠️ 收件门槛是「**两个以上文件真用到**」，不是「看起来通用」：`httpViaProxy`（只发 absolute-form
 * 明文请求）与 `socks5Greeting`（只发 SOCKS5 greeting）各自只服务一个档，因此留在那个档里。
 * 搬进来就成了一份没人能单独删掉、也没人说得清谁在用的间接层。
 *
 * ⚠️ **回收是导出的函数而不是模块级 `afterEach`**：模块顶层的 hook 会**静默**挂到每一个 import 它的
 * 档上，于是「这一档到底回收了什么」在档里读不出来（读的人只看见自己少了一件事要管）。显式导出、
 * 由两档各自在自己的 `afterEach` 里调一次，归属写在明处。
 *
 * ⚠️ **刻意住在 `tests/integration/inbound/` 而不是 `tests/helpers/`**：`external-network-scan.ts` 的
 * `SCAN_DIRS` 排除 `helpers/`，而 `walk()` 收目录下**全部** `.ts` —— 搬进 `helpers/` 等于让这里这一
 * 部分覆盖从零外网扫描里**静默消失**（`no-external-network.test.ts` 的两条下界断言照样绿）。
 *
 * @module tests/integration/inbound
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { FileAccountIdentity } from "@/core/identity.js";
import type { IdentityProvider } from "@/core/types/identity.js";
import { EventHub } from "@/core/events/index.js";
import { createProxyRuntime } from "@/runtime/index.js";
import type { AppConfig } from "@/config/index.js";
import type { ProxyRuntime } from "@/runtime/index.js";
import { getFreePort, listen } from "../../helpers/net.js";

export interface Mark {
  name: string;
  detail?: unknown;
}

const runtimes: ProxyRuntime[] = [];
const origins: { server: http.Server; port: number }[] = [];
const tempDirs: string[] = [];

/** 停掉两档起过的全部 runtime、关掉全部源站、删掉全部临时目录（两档的 `afterEach` 各自调它一次） */
export async function stopAll(): Promise<void> {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop().catch(() => undefined);
  }
  for (const origin of origins.splice(0)) {
    await new Promise<void>((r) => {
      origin.server.closeAllConnections?.();
      origin.server.close(() => r());
    });
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function writeAcl(acl: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-admission-acl-"));
  tempDirs.push(dir);
  const file = path.join(dir, "acl.json");
  fs.writeFileSync(file, JSON.stringify(acl));
  return file;
}

export async function startOrigin(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("origin-ok");
  });
  const port = await getFreePort();
  await listen(server, port);
  const origin = { server, port };
  origins.push(origin);
  return origin;
}

/** 起一个真 runtime + 一条专属事件总线，把准入相关事实按发生顺序记成时间线 */
export async function startProxy(
  config: Partial<AppConfig>,
  services?: { identity?: IdentityProvider },
): Promise<{ port: number; marks: Mark[]; events: EventHub }> {
  const port = await getFreePort();
  const events = new EventHub({ onListenerError: () => undefined });
  const marks: Mark[] = [];
  events.subscribe("pipe", (e) => {
    marks.push({ name: `pipe:${(e.data as { type: string }).type}` });
  });
  events.subscribe("auth.decided", (e) => {
    marks.push({ name: "auth.decided", detail: (e.data as { passed: boolean }).passed });
  });
  events.subscribe("access.client-denied", () => {
    marks.push({ name: "access.client-denied" });
  });
  events.subscribe("access.target-denied", () => {
    marks.push({ name: "access.target-denied" });
  });
  events.subscribe("request.rejected", (e) => {
    marks.push({
      name: "request.rejected",
      detail: `${(e.data as { stage: string }).stage}/${(e.data as { status?: number }).status ?? "-"}`,
    });
  });
  const runtime = createProxyRuntime({
    config: {
      host: "127.0.0.1",
      port,
      authEnabled: false,
      aclFile: path.join(os.tmpdir(), `proxy-admission-missing-${process.pid}-${port}.json`),
      // 账本目录同样必须显式给：库模式不经 `loadConfig`，`setup-env.ts` 的 `QUOTA_USAGE_DIR`
      // 钉值两侧都落空（`new ConfigStore(内联)` 与宿主 env 无关），缺省相对路径 `cfg/usage`
      // 会按 `configDir = process.cwd()` 绝对化到仓库里。与「是否真计量」无关：`start()`
      // 无条件 `open()` 用量数据源。
      quotaUsageDir: path.join(os.tmpdir(), `proxy-admission-usage-${process.pid}`),
      ...config,
    },
    events,
    ...(services !== undefined ? { services } : {}),
  });
  runtimes.push(runtime);
  await runtime.start();
  return { port, marks, events };
}

export const timeline = (marks: Mark[]): string[] => marks.map((m) => m.name);
export const authDecided = (marks: Mark[]): Mark[] => marks.filter((m) => m.name === "auth.decided");

export const ACCOUNT = { username: "alice", password: "secret" };

/**
 * 真 `FileAccountIdentity`（basic），**必须开 `enableLogging`**：审计事件是经
 * `IdentityContext.onAuthEvent` 上抛、再由 `BaseProxy.authorize` 转成公共 `auth.decided` 的
 * ——关掉它就等于把「鉴权发生过」这条事实从事件面上抹掉，两档要观察的正是那条事实。
 */
export function basicAuth(): IdentityProvider {
  return new FileAccountIdentity({
    enabled: true,
    type: "basic",
    accounts: [ACCOUNT],
    enableLogging: true,
  });
}