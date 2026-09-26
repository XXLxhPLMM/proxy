/**
 * @fileoverview 安全属性护栏：非法 `upstreamProtocol` 必须 fail-closed，绝不静默直连
 * @description
 * `tunnel.handle` 曾有一条「未知上游协议 → 降级 direct 保连通」的兜底，2b-1 删掉了它，
 * 改由 `forward/connector/registry.ts:connectorFor` fail-closed 抛错。
 *
 * **删除的理由不是「那条分支不可达」**（那个论证是错的，见下），而是：
 * **静默降级直连 = 流量旁路**。对一个代理服务，「上游协议配错 → 全部静默直连」意味着
 * 流量绕过上游直出，外部表现是「服务还在跑、请求还成功、但根本没走你配的链路」——
 * 比直接报错糟糕得多：报错至少让运维知道配置错了。
 *
 * **「不可达」那个论证错在哪**：CLI 路径的 `upstreamProtocol` 确实经 `FIELDS.parseEnum`
 * fail-fast，但**库路径不经**——`createProxyRuntime({ config })` 走 `new ConfigStore(...)`，
 * 而 `ConfigStore` **零校验**（不跑 FIELDS 的解析/范围/交叉校验），非法值能被直接注入。
 * 本文件就从库路径注入 `"ftp"`，把「可达」这件事变成可执行的事实。
 *
 * **不要以「增强健壮性 / 保持连通」为名把静默兜底加回来。** 想要健壮，正确的位置是
 * **配置校验层**（`loadConfig` / 纯内存 runtime 的构造期校验），让它启动就报错，
 * 而不是让请求期偷偷换一个上游形态。
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
