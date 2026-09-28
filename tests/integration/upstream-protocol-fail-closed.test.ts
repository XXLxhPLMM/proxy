/**
 * @fileoverview 安全属性护栏：非法 `upstreamProtocol` 必须 fail-closed，绝不静默直连
 * @description
 * 非法 `upstreamProtocol` 的兜底形态**只有 fail-closed 抛错一种**：
 * `forward/upstream/connector/registry.ts:resolveUpstream`（经 `ConnectorSource.upstream()`
 * 暴露）在请求期抛。
 *
 * **理由是「静默降级直连 = 流量旁路」**：对一个代理服务，「上游协议配错 → 全部静默直连」意味着
 * 流量绕过上游直出，外部表现是「服务还在跑、请求还成功、但根本没走你配的链路」——
 * 比直接报错糟糕得多：报错至少让运维知道配置错了。
 *
 * **非法值在库路径上真的可达**：CLI 路径的 `upstreamProtocol` 确实经 `FIELDS.parseEnum`
 * fail-fast，但**库路径不经**——`createProxyRuntime({ config })` 走 `new ConfigStore(...)`，
 * 而 `ConfigStore` **零校验**（不跑 FIELDS 的解析/范围/交叉校验），非法值能被直接注入。
 * 本文件就从库路径注入 `"ftp"`，把「可达」这件事变成可执行的事实。
 *
 * **不要以「增强健壮性 / 保持连通」为名把静默兜底加回来。** 想要健壮，正确的位置是
 * **配置校验层**（`loadConfig` / 纯内存 runtime 的构造期校验），让它启动就报错，
 * 而不是让请求期偷偷换一个上游形态。
 *
 * ## 它与「入站协议构造期抛」是**两个**出口，不是一个决策的两半
 *
 * `ConfigStore` **零校验**是这件事的前提，于是非法枚举在库路径上有两个落点，各留各的：
 * ① **入站 `proxyProtocol` 由 `runtime.ts:protocolFor(config)` 在构造期抛**（覆盖只改变**用哪个
 * 值**、不改变**是否校验**）——那半边的判据在 `tests/unit/startup-preset.test.ts` 第 5 组，
 * 包括「`protocolFor(config)` 必须排在 `assembly?.protocol` 判定之前」这条源码级次序断言；
 * ② **上游 `upstreamProtocol` 由本文件在请求期抛**（fail-closed，即本档）。
 *
 * 为什么不让 `ConfigStore` 跑 FIELDS 校验：它是纯存储，跑校验就得引入解析 / 范围 /
 * 交叉校验那整套，让「存」与「验」耦在一起。而**两个出口都要留着**，因为它们覆盖的是**不同
 * 的值**（一个决定建哪种服，一个决定怎么到达 dest），漏掉任一个就是一条静默旁路。
 *
 * ⚠️ **别把「① 已经启动就报」误读成「② 也可以前移」**——前移会让 `forward.error` 这条安全
 * 事实从事件流里消失：静默降级直连 = 流量旁路，报错至少让运维知道配置错了。
 * 反过来也别把 ② 挪到别处「顺手统一」——本档每一条用例都从库路径注入非法值并断言「源站零字节、
 * 客户端拿不到 200、表现为 `forward.error`」，改判据位置或恢复兜底任一条都立刻红。
 *
 * ## 本档锁住的两条决策（结论 — 为什么）
 *
 * **① 未知 `upstreamProtocol` 的兜底形态只有抛错一种。** 为什么不「降级 direct 保连通」——
 * 对一个代理服务，「上游协议配错 → 全部静默直连」意味着流量**绕过上游直出**，外部表现是
 * 「服务还在跑、请求还成功、但根本没走你配的链路」。这比直接报错糟糕得多。牙齿 = 「库路径
 * 注入非法协议」那条的后两行：`expect(origin.received()).toBe(0)` 与
 * `expect(status).not.toBe(200)`——**静默直连的外部表现恰恰就是源站收到字节、客户端拿到
 * 200**，那两行就是「不许降级」的可执行形式。（成因那一侧另有一行
 * `String((e as Error)?.message ?? "").includes("unsupported upstream protocol")`。）
 *
 * **② fail-closed 的抛点固定在请求期**（裁决：**不**前移到装配期）。理由三条各自成立：
 * ① 前移会让本档断言的 `forward.error` 事实**消失**、变成启动期异常——**那是换掉一个安全
 * 属性，不是加固它**（一条都没发出去的代理比一条 `forward.error` 更难定位是哪个请求撞上了
 * 完整配置）。**这条的牙齿就是 `await startRuntime({ … upstreamProtocol: "ftp" })` 那一行
 * 本身**：`startRuntime` 走 `createProxyRuntime({ config })`，抛点一旦前移到那里，这条用例会在
 * 拿到任何断言之前就 reject。② `proxyMode: "server"` 下有效路由恒 direct、`upstream()` 一次都
 * 不会被调，装配期就为它抛等于让「上游字段填错」打挂一个压根不上游的服务。③
 * `createConnectorSource` 拿不到 `configDir`、也不该知道「这是一个 runtime 的装配根」。
 */
import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EventSubscription } from "@/core/events/index.js";
import type { ProxyProtocol } from "@/core/types/proxy.js";
import { createProxyRuntime, type ProxyRuntime } from "@/index.js";
import { getFreePort, listen } from "../helpers/net.js";

/** 自持 socket 集合的裸 TCP 桩：afterEach 逐条销毁后 close（net.Server 没有 closeAllConnections） */
interface Stub {
  port: number;
  received: () => number;
}

const SERVERS: net.Server[] = [];
const RUNTIMES: ProxyRuntime[] = [];
const SUBS: EventSubscription[] = [];
const CLIENTS: net.Socket[] = [];
const DIRS: string[] = [];

afterEach(async () => {
  for (const s of SUBS.splice(0)) {
    s.dispose();
  }

  for (const c of CLIENTS.splice(0)) {
    if (!c.destroyed) {
      c.destroy();
    }
  }

  for (const r of RUNTIMES.splice(0)) {
    await r.stop().catch(() => undefined);
  }

  for (const s of SERVERS.splice(0)) {
    (s as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();

    await new Promise<void>((r) => s.close(() => r()));
  }

  for (const d of DIRS.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-bad-proto-"));
  DIRS.push(dir);
  return dir;
}

/** 源站：记录收到的字节数（判「有没有被静默直连」） */
async function startOrigin(): Promise<Stub> {
  let bytes = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    sock.on("data", (c: Buffer) => {
      bytes += c.length;
      sock.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    });
  });
  const port = await getFreePort();

  await listen(server, port);
  SERVERS.push(server);
  Object.defineProperty(server, "closeAllConnections", {
    value: () => {
      for (const s of sockets) {
        s.destroy();
      }
    },
  });

  return { port, received: () => bytes };
}

/** 最小 SOCKS5 上游：greeting → CONNECT 真隧道（对照组用） */
async function startSocks5(): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    let stage: "method" | "connect" = "method";

    sockets.add(sock);
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    sock.on("data", (req: Buffer) => {
      // 注意：greeting 与 CONNECT 的头两字节都是 05 01，必须靠 stage 区分，
      // 只看字节会把 CONNECT 也当成 greeting 应答（上游状态机直接错位）
      if (stage === "method") {
        stage = "connect";
        sock.write(Buffer.from([0x05, 0x00]));
        return;
      }

      const len = req[4];
      const host = req.subarray(5, 5 + len).toString();
      const port = req.readUInt16BE(5 + len);
      // 建隧后必须摘掉 data 监听：否则隧内字节会再次进入本回调、被当成第二个 CONNECT 解包
      sock.removeAllListeners("data");
      const target = net.connect(port, host, () => {
        sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        sock.pipe(target);
        target.pipe(sock);
      });

      target.on("error", () => sock.destroy());
    });
  });
  const port = await getFreePort();

  await listen(server, port);
  SERVERS.push(server);
  Object.defineProperty(server, "closeAllConnections", {
    value: () => {
      for (const s of sockets) {
        s.destroy();
      }
    },
  });

  return port;
}

/** 走代理发一次请求，返回状态码（读满到对端关闭或 3s 超时） */
function viaProxy(port: number, url: string, hostHeader: string): Promise<number> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`GET ${url} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    });

    CLIENTS.push(sock);

    let text = "";
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(Number(text.split(" ")[1]) || 0);
    }, 3000);

    sock.on("data", (c: Buffer) => {
      text += c.toString();
    });
    sock.on("close", () => {
      clearTimeout(timer);
      resolve(Number(text.split(" ")[1]) || 0);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(0);
    });
  });
}

/** 起一个纯内存 runtime（库路径：`config` 模式 → 私有 `ConfigStore`，零校验） */
async function startRuntime(config: Record<string, unknown>): Promise<ProxyRuntime> {
  const configDir = tmpDir();
  const runtime = createProxyRuntime({
    config: {
      host: "127.0.0.1",
      proxyProtocol: "http",
      proxyMode: "client",
      authEnabled: false,
      authType: "none",
      logLevel: "silent",
      logFile: "",
      aclFile: path.join(configDir, "no-such-acl.json"),
      authUsersFile: path.join(configDir, "no-such-users.json"),
      upstreamHost: "127.0.0.1",
      ...config,
    } as never,
    configDir,
  });

  RUNTIMES.push(runtime);
  await runtime.start();
  return runtime;
}

describe("安全属性：非法 upstreamProtocol 必须 fail-closed（绝不静默直连）", () => {
  it("库路径注入非法协议：请求表现为 forward.error，源站零字节、客户端拿不到 200", async () => {
    const origin = await startOrigin();
    const proxyPort = await getFreePort();
    const runtime = await startRuntime({
      port: proxyPort,
      // 上游地址指向一个**死端口**：即便有人加回「降级 direct」，它也只会拨这个死端口，
      // 于是「静默直连」不可能表现为成功 —— 断言落在「源站零字节 + forward.error」上。
      upstreamPort: await getFreePort(),
      // 非法值：ConfigStore 零校验，故能被注进去（CLI 路径会被 FIELDS.parseEnum 拦在启动期）
      upstreamProtocol: "ftp" as ProxyProtocol,
    });

    const forwardErrors: unknown[] = [];
    SUBS.push(
      runtime.events.subscribe("forward.error", (e) => {
        forwardErrors.push(e.data.error);
      }),
    );

    const status = await viaProxy(proxyPort, `http://127.0.0.1:${origin.port}/bypass`, "h.example");

    // ① 事实层：必须是一次**服务端错误事实**（forward.error），成因指明协议不合法
    expect(
      forwardErrors.length,
      `未观察到 forward.error；客户端状态码=${status}`,
    ).toBeGreaterThan(0);
    expect(
      forwardErrors.some((e) =>
        String((e as Error)?.message ?? "").includes("unsupported upstream protocol"),
      ),
      `成因应指明协议未登记；实得：${JSON.stringify(
        forwardErrors.map((e) => String((e as Error)?.message ?? e)),
      )}`,
    ).toBe(true);

    // ② 安全属性：源站**一个字节都没收到** —— 绝不能「配错协议 → 静默直连出去」
    expect(origin.received()).toBe(0);
    // ③ 客户端也没拿到 200（静默直连的表现恰恰就是 200）
    expect(status).not.toBe(200);
  }, 20000);

  it("对照：合法协议（socks5）时同一形状的请求会真的走上游并命中源站（证明上条不是「怎么都不通」）", async () => {
    const origin = await startOrigin();
    const socksPort = await startSocks5();
    const proxyPort = await getFreePort();
    await startRuntime({ port: proxyPort, upstreamPort: socksPort, upstreamProtocol: "socks5" });

    const status = await viaProxy(proxyPort, `http://127.0.0.1:${origin.port}/ok`, "h.example");

    expect(status).toBe(200);
    expect(origin.received()).toBeGreaterThan(0);
  }, 20000);
});
