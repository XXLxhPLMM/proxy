import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { set, testConfigStore } from "../helpers/config.js";
import { createConfigContext } from "@/config/index.js";
import type { ConfigKey } from "@/config/index.js";
import { ProxyServer } from "@/server/index.js";
import { getFreePort, listen, sleep } from "../helpers/net.js";
import { restoreConfig, snapshotConfig } from "../helpers/config.js";

/**
 * 落盘日志为 JSONL 且带身份维度（走真 ProxyServer，覆盖 core 事件 -> server 日志 -> 落盘全链路）：
 * - 每行可 JSON.parse，含 ts/level/pid/prefix/msg 与结构化字段
 * - 鉴权通过时 [forward] 行带 user，鉴权失败时 [auth] deny 行带 attempted
 * - core 的 route 事件落 [route] info 行（target/route/reason），server 模式短路零条
 * - 文件名按小时切分为 .jsonl
 */

const KEYS: readonly ConfigKey[] = [
  "logFile",
  "logLevel",
  "logFileLevel",
  "authEnabled",
  "authType",
  "authUsersFile",
  "authLogging",
  "host",
  "port",
  "proxyProtocol",
  "proxyMode",
  "upstreamProtocol",
  "upstreamHost",
  "upstreamPort",
  "aclFile",
];

/** 采集一次原始 HTTP 往返（绝对形式请求直发代理） */
function rawRequest(
  port: number,
  requestLine: string,
  headers: string[],
): Promise<{ status: string; raw: string }> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write([requestLine, ...headers, "Connection: close", "", ""].join("\r\n"));
    });
    let buf = "";
    sock.on("data", (c: Buffer) => {
      buf += c.toString();
    });
    sock.on("close", () => resolve({ status: buf.split("\r\n")[0] ?? "", raw: buf }));
    sock.on("error", () => {
      // close 仍会触发
    });
  });
}

/**
 * 等落盘文件出现且满足 `ready` 谓词后返回全部记录。
 * logger 是 fire-and-forget 写入，且启动期 `[config]` 行会先落盘，
 * 故「等到有行」不等于「等到我们要的那行」——必须按谓词轮询，否则读到的快照会缺行。
 */
async function readLogLines(
  dir: string,
  ready?: (lines: Record<string, unknown>[]) => boolean,
): Promise<Record<string, unknown>[]> {
  for (let i = 0; i < 60; i++) {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
    if (files.length > 0) {
      const text = fs.readFileSync(path.join(dir, files[0]), "utf8");
      const lines = text
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      if (lines.length > 0 && (!ready || ready(lines))) {
        return lines;
      }
    }
    await sleep(50);
  }
  return [];
}

describe("integration/log-structured", () => {
  let snap: Record<string, unknown>;
  let dir: string;
  let origin: http.Server;
  let originPort: number;

  beforeEach(async () => {
    snap = snapshotConfig(KEYS);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-log-"));
    // 控制台静音，仅验证落盘通道
    set("logLevel", "silent");
    set("logFileLevel", "info");
    set("logFile", dir);
    set("host", "127.0.0.1");
    set("proxyProtocol", "http");
    set("proxyMode", "server");
    set("authEnabled", true);
    set("authType", "basic");
    set("authLogging", true);
    set("aclFile", path.join(dir, "acl-missing.json"));

    // 账号表来自文件（AUTH_USERS_FILE 语义）：两个账号，用于验证多用户各自的归属
    const usersPath = path.join(dir, "users.json");
    fs.writeFileSync(
      usersPath,
      JSON.stringify([
        { username: "alice", password: "pw1" },
        { username: "bob", password: "pw2" },
      ]),
    );
    set("authUsersFile", usersPath);

    origin = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("origin-ok");
    });
    originPort = await getFreePort();
    await listen(origin, originPort);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      origin.closeAllConnections?.();
      origin.close(() => resolve());
    });
    fs.rmSync(dir, { recursive: true, force: true });
    restoreConfig(snap);
  });

  /** 起真 ProxyServer（日志订阅在此装配），跑完即停 */
  async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
    const port = await getFreePort();
    set("port", port);
    const server = new ProxyServer({
      context: createConfigContext({
        store: testConfigStore,
        configDir: dir,
      }),
    });
    await server.start();
    try {
      await fn(port);
    } finally {
      await server.stop().catch(() => {});
    }
  }

  it("请求头 dump：[http] headers 落 debug 行，敏感头已掩码、原始凭证绝不进日志", async () => {
    // 保护：这条 `[{kind}] headers` debug 行是诊断头 dump 的**唯一**落点。
    // Phase 1.3a 起它的数据源从 `req.headers` 换成 core 侧已掩码的 `forward.request-headers` 事件，
    // 掩码在 core 的 publish 之前完成——本用例锁三件事：
    // ① 文本 `[http] headers` 与 debug 等级一字不变；② 四个字段 client/target/headers/user 齐全；
    // ③ 原始 Proxy-Authorization / Authorization / Cookie 在**整个文件里**都不出现。
    // 事件侧另有 `tests/unit/core-event-bridge.test.ts` 锁「掩码在 publish 前发生 + 该事件有订阅者」。
    set("logFileLevel", "debug");
    const basic = Buffer.from("alice:pw1").toString("base64");
    const cookie = "session=abc123";
    const target = `127.0.0.1:${originPort}`;

    await withServer(async (port) => {
      const res = await rawRequest(port, `GET http://${target}/hdr HTTP/1.1`, [
        `Host: ${target}`,
        `Proxy-Authorization: Basic ${basic}`,
        "Authorization: Bearer target-token-xyz",
        `Cookie: ${cookie}`,
        "X-Trace: trace-1",
      ]);
      expect(res.status.startsWith("HTTP/1.1 200")).toBe(true);
    });

    const lines = await readLogLines(dir, (ls) =>
      ls.some((l) => String(l.msg).startsWith("[http] headers")),
    );
    const dump = lines.find((l) => String(l.msg).startsWith("[http] headers"));
    expect(dump).toBeTruthy();
    // ① 文本与等级
    expect(dump?.msg).toBe("[http] headers");
    expect(dump?.level).toBe("debug");
    expect(dump?.prefix).toBe("[proxy]");
    // ② 四个字段齐全（与改造前同一集合、同一顺序）
    expect(dump?.client).toBe("127.0.0.1");
    expect(String(dump?.target)).toContain(String(originPort));
    expect(dump?.user).toBe("alice");
    const headers = dump?.headers as Record<string, string> | undefined;
    expect(headers).toBeTruthy();
    // ③ 敏感头：键保留（就地掩码），值不再是原值
    expect(String(headers?.["proxy-authorization"])).not.toContain(basic);
    expect(String(headers?.["authorization"])).not.toContain("target-token-xyz");
    expect(String(headers?.["cookie"])).not.toContain(cookie);
    // 非敏感头原样保留，掩码不误伤
    expect(headers?.["x-trace"]).toBe("trace-1");
    expect(String(headers?.host)).toContain(String(originPort));
    // 整份文件里不得出现任何一段原值
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    const whole = files
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
      .join("\n");
    expect(whole).not.toContain(basic);
    expect(whole).not.toContain("target-token-xyz");
    expect(whole).not.toContain(cookie);
  });

  it("鉴权通过：[forward] 行带 user/client/target/kind，文件为按小时的 .jsonl", async () => {
    await withServer(async (port) => {
      const good = Buffer.from("alice:pw1").toString("base64");
      const res = await rawRequest(port, `GET http://127.0.0.1:${originPort}/ok HTTP/1.1`, [
        `Host: 127.0.0.1:${originPort}`,
        `Proxy-Authorization: Basic ${good}`,
      ]);
      expect(res.status.startsWith("HTTP/1.1 200")).toBe(true);
      expect(res.raw).toContain("origin-ok");
    });

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThanOrEqual(1);

    const lines = await readLogLines(dir, (ls) =>
      ls.some((l) => l.msg === "[forward]" && l.user === "alice"),
    );
    expect(lines.length).toBeGreaterThan(0);

    // 每行都是合法 JSON 且带保留键
    for (const rec of lines) {
      expect(typeof rec.ts).toBe("string");
      expect(typeof rec.level).toBe("string");
      expect(rec.pid).toBe(process.pid);
      expect(rec.prefix).toBe("[proxy]");
      expect(typeof rec.msg).toBe("string");
    }

    const forward = lines.find((l) => l.msg === "[forward]");
    expect(forward).toBeTruthy();
    expect(forward?.user).toBe("alice");
    expect(forward?.client).toBe("127.0.0.1");
    expect(forward?.kind).toBe("http");
    expect(String(forward?.target)).toContain(String(originPort));
    expect(forward?.method).toBe("GET");
    expect(forward?.level).toBe("info");
  });

  it("鉴权失败：[auth] deny 行为 info 级 JSONL，带 attempted 与 reason", async () => {
    await withServer(async (port) => {
      const res = await rawRequest(port, `GET http://127.0.0.1:${originPort}/deny HTTP/1.1`, [
        `Host: 127.0.0.1:${originPort}`,
        `Proxy-Authorization: Basic ${Buffer.from("mallory:pw").toString("base64")}`,
      ]);
      expect(res.status.startsWith("HTTP/1.1 407")).toBe(true);
    });

    const lines = await readLogLines(dir, (ls) =>
      ls.some((l) => l.msg === "[auth] deny" && l.attempted === "mallory"),
    );
    const deny = lines.find((l) => l.msg === "[auth] deny");
    expect(deny).toBeTruthy();
    expect(deny?.level).toBe("info");
    expect(deny?.attempted).toBe("mallory");
    expect(deny?.client).toBe("127.0.0.1");
    // 账号表是列表，deny 行不再输出 expected
    expect("expected" in (deny ?? {})).toBe(false);
  });

  it("多账号：两个账号各自登录成功，日志按请求区分 user（不串号）", async () => {
    // 开 debug 落盘：连 [auth] allow 一并验证归属
    set("logFileLevel", "debug");
    const cred = (u: string, p: string): string =>
      `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

    await withServer(async (port) => {
      const a = await rawRequest(port, `GET http://127.0.0.1:${originPort}/a HTTP/1.1`, [
        `Host: 127.0.0.1:${originPort}`,
        `Proxy-Authorization: ${cred("alice", "pw1")}`,
      ]);
      const b = await rawRequest(port, `GET http://127.0.0.1:${originPort}/b HTTP/1.1`, [
        `Host: 127.0.0.1:${originPort}`,
        `Proxy-Authorization: ${cred("bob", "pw2")}`,
      ]);
      // 同名账号配错密码：必须 407，且不得产生 forward 行
      const bad = await rawRequest(port, `GET http://127.0.0.1:${originPort}/c HTTP/1.1`, [
        `Host: 127.0.0.1:${originPort}`,
        `Proxy-Authorization: ${cred("alice", "WRONG")}`,
      ]);

      expect(a.status.startsWith("HTTP/1.1 200")).toBe(true);
      expect(b.status.startsWith("HTTP/1.1 200")).toBe(true);
      expect(bad.status.startsWith("HTTP/1.1 407")).toBe(true);
    });

    const lines = await readLogLines(dir, (ls) => {
      const fw = ls.filter((l) => l.msg === "[forward]");
      return (
        fw.length >= 2 &&
        fw.some((l) => l.user === "alice") &&
        fw.some((l) => l.user === "bob") &&
        ls.some((l) => l.msg === "[auth] deny")
      );
    });

    // 两条 forward 行分属两个账号，且不存在无主（未带 user）的 forward 行
    const forwards = lines.filter((l) => l.msg === "[forward]");
    expect(forwards).toHaveLength(2);
    expect(forwards.filter((l) => l.user === "alice")).toHaveLength(1);
    expect(forwards.filter((l) => l.user === "bob")).toHaveLength(1);

    const allows = lines.filter((l) => l.msg === "[auth] allow");
    expect(allows.map((l) => l.user).sort()).toEqual(["alice", "bob"]);

    const deny = lines.find((l) => l.msg === "[auth] deny");
    expect(deny?.attempted).toBe("alice");
  });

  it("客户端名单拒绝：落 [ip-denied] warn 行（含 client 与 reason）", async () => {
    const aclPath = path.join(dir, "acl.json");
    fs.writeFileSync(aclPath, JSON.stringify({ clientIp: { blacklist: ["127.0.0.1"] } }));
    set("aclFile", aclPath);

    await withServer(async (port) => {
      const res = await rawRequest(port, `GET http://127.0.0.1:${originPort}/blocked HTTP/1.1`, [
        `Host: 127.0.0.1:${originPort}`,
      ]);
      expect(res.status.startsWith("HTTP/1.1 403")).toBe(true);
    });

    const lines = await readLogLines(dir, (ls) =>
      ls.some((l) => String(l.msg).startsWith("[ip-denied]")),
    );
    // 事件码型日志的 msg 形如 `[ip-denied] <detail>`，按前缀匹配
    const denied = lines.find((l) => String(l.msg).startsWith("[ip-denied]"));
    expect(denied).toBeTruthy();
    expect(denied?.level).toBe("warn");
    expect(denied?.client).toBe("127.0.0.1");
    expect(denied?.reason).toBe("blacklist");
  });

  it("路由决策：client 模式 route 事件落 [route] info 行（core 零日志 -> server 落盘）", async () => {
    // upstream 黑名单命中 → 直连 origin：有效模式回落 server 但带 reason，事件照发、行照落
    const aclPath = path.join(dir, "acl.json");
    fs.writeFileSync(aclPath, JSON.stringify({ upstream: { blacklist: ["127.0.0.1"] } }));
    set("aclFile", aclPath);
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", originPort);

    await withServer(async (port) => {
      const res = await rawRequest(port, `GET http://127.0.0.1:${originPort}/route HTTP/1.1`, [
        `Host: 127.0.0.1:${originPort}`,
        `Proxy-Authorization: Basic ${Buffer.from("alice:pw1").toString("base64")}`,
      ]);
      expect(res.status.startsWith("HTTP/1.1 200")).toBe(true);
      expect(res.raw).toContain("origin-ok");
    });

    const lines = await readLogLines(dir, (ls) => ls.some((l) => l.msg === "[route]"));
    const route = lines.find((l) => l.msg === "[route]");
    expect(route).toBeTruthy();
    expect(route?.level).toBe("info");
    expect(route?.route).toBe("direct");
    expect(route?.reason).toBe("blacklist");
    expect(String(route?.target)).toBe(`127.0.0.1:${originPort}`);
  });
});
