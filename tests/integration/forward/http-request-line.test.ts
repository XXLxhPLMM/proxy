/**
 * server 模式下**客户端发来的请求行**在源站那一侧长什么样：absolute-form 被归一为 origin-form
 * （`GET /hello?x=1 HTTP/1.1`），origin-form 原样透传。断言的是**源站收到的请求行原文**，不是 `req.url`。
 *
 * ⚠️ 源站必须是**裸 `net.Server`**：`http.Server` 会把畸形 target 也塞进 `req.url`，归一化一旦坏掉
 * 缺陷会被它藏住。客户端侧用 `http.request` 打绝对 URL 的 `path` 来发 absolute-form，故「客户端发的
 * 是什么」由构造方式保证，不靠字符串拼。
 *
 * ⚠️ **本目录唯一 spawn 子进程的档**（另两档 spawn 两对，是 `http-chain-*`）：子进程那两道隔离与
 * 构建保鲜的**唯一真相在 `../../helpers/child-proxy.ts` 的文件头**，本文件只申报自己会传的 CLI 覆盖
 * 对应的 env 键（下面 `STRIPPED_ENV`）并调 `disposeSpawnCwd()`。
 *
 * 与 `./contract/absolute-form.test.ts` 的分工：那档锁「经 http 上游时 request-target **保留**
 * absolute-form」，这档锁「server 模式直连时**归一为** origin-form」—— 两个方向，别互相顶替。
 * 主题级判据与本目录清单见 `./AGENTS.md`。
 *
 * @module tests/integration/forward
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import {
  baseArgs,
  disposeSpawnCwd,
  ensureDistBuilt,
  spawnProxy,
  stopChild,
  waitForPort,
} from "../../helpers/child-proxy.js";
import { getFreePort } from "../../helpers/net.js";

/**
 * 本档会传的 CLI 覆盖所对应的 env 键：它们必须在 spawn 前从继承来的 `process.env` 里剔掉
 * （理由见 `helpers/child-proxy.ts` 的隔离 ② —— cwd 挪出仓库挡不住继承来的 env）。
 */
const STRIPPED_ENV = ["AUTH_TYPE", "PROXY_MODE", "UPSTREAM_PROTOCOL", "PORT"] as const;

/** 裸 TCP 源站收到的请求行原文，按到达顺序追加 */
const seen: string[] = [];

/**
 * 经 server 模式代理发一次请求，返回源站收到的请求行原文
 * 源站是裸 TCP：http.Server 会把畸形 target 也塞进 req.url，缺陷会被它藏住
 */
function requestLineViaProxy(proxyPort: number, originPort: number, clientPath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: clientPath,
        headers: { Host: `127.0.0.1:${originPort}` },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(seen.at(-1) ?? ""));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("forward · http-request-line（请求行形态）", () => {
  let proxyPort = 0;
  let originPort = 0;
  let proxy: ChildProcess | null = null;
  let origin: net.Server | null = null;

  beforeAll(async () => {
    await ensureDistBuilt();
    proxyPort = await getFreePort();
    originPort = await getFreePort();

    origin = net.createServer((sock) => {
      sock.on("error", () => {});
      sock.once("data", (d) => {
        seen.push(d.toString().split("\r\n")[0] ?? "");
        sock.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
      });
    });
    await new Promise<void>((r) => origin!.listen(originPort, "127.0.0.1", () => r()));

    proxy = spawnProxy([...baseArgs(proxyPort), "--proxy-mode", "server"], {
      stripEnv: STRIPPED_ENV,
    });
    await waitForPort(proxyPort);
  }, 30000);

  afterAll(async () => {
    if (proxy) await stopChild(proxy);
    await new Promise<void>((r) => origin?.close(() => r()));
    disposeSpawnCwd();
  });

  it("server 模式：客户端 absolute-form 归一为 origin-form 交源站", async () => {
    const line = await requestLineViaProxy(
      proxyPort,
      originPort,
      `http://127.0.0.1:${originPort}/hello?x=1`,
    );
    expect(line).toBe("GET /hello?x=1 HTTP/1.1");
  });

  it("server 模式：客户端 origin-form 原样透传", async () => {
    const line = await requestLineViaProxy(proxyPort, originPort, "/plain?y=2");
    expect(line).toBe("GET /plain?y=2 HTTP/1.1");
  });
});
