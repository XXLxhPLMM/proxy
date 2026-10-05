/**
 * 「身份不串号」那一面：转发器是**跨请求 / 跨会话共享**的，而 `user` / `requestId` /
 * `connectionId` 是**逐请求**的 —— 这两件事凑在一起就是「A 的请求被记到 B 头上」那个雷。
 *
 * 做法：两个不同身份的请求（或两个不同用户的并发 SOCKS 会话）共享同一个转发器实例，
 * 收集 `PipeEvent`，按 `requestId` 分组后逐组断言身份维度自洽、且与该请求的
 * `request.started` context 完全一致。实例复用那一面在 `instance-reuse.test.ts`，
 * 两档共用的装配面归 `./instance-reuse-fixture.ts`，主题级判据与本目录清单见 `./AGENTS.md`。
 *
 * @module tests/integration/forward
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { HttpProxy } from "@/core/server/http.js";
import { FileAccountIdentity } from "@/core/identity.js";
import type { EventEnvelope, EventName, EventSubscription } from "@/core/events/index.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import { getFreePort } from "../../helpers/net.js";
import { rfc1929, socks5ConnectIpv4, tcConnect } from "../../helpers/socks-client.js";
import { restoreConfig, set, snapshotConfig } from "../../helpers/config.js";
import { openAccessControl } from "../../helpers/access.js";
import {
  KEYS,
  ProbeSocks5Proxy,
  bus,
  ctx,
  discardOpenSockets,
  openSockets,
  proxyGet,
  readBytes,
  sentinelBaseConfig,
  startRawTarget,
} from "./instance-reuse-fixture.js";

interface Recorded {
  name: EventName;
  context: EventEnvelope["context"];
  pipe?: PipeEvent;
}

describe("forward · instance-reuse-identity（身份维度绝不串号）", () => {
  const prev = snapshotConfig(KEYS);
  const subs: EventSubscription[] = [];
  let rawTarget: Awaited<ReturnType<typeof startRawTarget>>;

  function record(...names: EventName[]): Recorded[] {
    const out: Recorded[] = [];
    for (const name of names) {
      subs.push(
        bus.subscribe(name, (e) => {
          out.push({
            name,
            context: e.context,
            ...(name === "pipe" ? { pipe: e.data as unknown as PipeEvent } : {}),
          });
        }),
      );
    }

    return out;
  }

  beforeAll(async () => {
    sentinelBaseConfig();
    rawTarget = await startRawTarget();
  });

  afterEach(() => {
    for (const s of subs.splice(0)) {
      s.dispose();
    }
    discardOpenSockets();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await rawTarget.close();
    restoreConfig(prev);
  });

  it("Http：同一条连接上两个不同用户的请求，PipeEvent 上的 user/requestId 各自正确、互不串", async () => {
    set("proxyMode", "server");
    // 目标是一个**没人监听**的端口：每个请求稳定地产生一条 `upstream-error` pipe 事件，
    // 且不依赖任何上游协议桩（server 模式直连，回落语义最简）
    const dead = await getFreePort();
    const port = await getFreePort();
    const identity = new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [
        { username: "alice", password: "pw1" },
        { username: "bob", password: "pw2" },
      ],
      enableLogging: false,
    });
    // 身份不串号用例与名单无关 → 显式点名「不判名单」
    const proxy = new HttpProxy({ host: "127.0.0.1", port, identity, ctx, access: openAccessControl() });
    const seen = record("pipe", "request.started");

    await proxy.start();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const basic = (u: string, p: string): string =>
      `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

    try {
      const asAlice = await proxyGet(port, dead, "/alice", {
        agent,
        headers: { "Proxy-Authorization": basic("alice", "pw1") },
      });
      const asBob = await proxyGet(port, dead, "/bob", {
        agent,
        headers: { "Proxy-Authorization": basic("bob", "pw2") },
      });

      expect([asAlice.status, asBob.status], "两个请求都真的走到了转发层（上游拨不通 → 502）").toEqual([
        502, 502,
      ]);
      expect(
        asBob.conn,
        "两个请求跑在同一条入站连接上（connectionId 相同、requestId 不同）",
      ).toBe(asAlice.conn);

      // requestId → user 的权威映射取自 `request.started` 的 context（它与终态同 requestId）
      const userOf = new Map<string, string | undefined>();
      const connectionIds = new Set<string>();
      for (const r of seen) {
        if (r.name === "request.started") {
          userOf.set(r.context.requestId ?? "", r.context.user);
          connectionIds.add(r.context.connectionId ?? "");
        }
      }

      expect(userOf.size, "两个请求各自带 requestId").toBe(2);
      expect([...userOf.values()].sort()).toEqual(["alice", "bob"]);
      expect(connectionIds.size, "同一条入站连接 → 同一个 connectionId").toBe(1);

      // 逐条 pipe 事件断言：身份维度必须与该 requestId 的真实归属完全一致
      const pipes = seen.filter((r) => r.name === "pipe" && r.pipe !== undefined);
      expect(pipes.length, "两个请求都应产生 pipe 事件（上游拨不通的 upstream-error）").toBeGreaterThan(1);

      for (const p of pipes) {
        const rid = p.pipe?.requestId;
        expect(rid, "每条 pipe 事件都必须带 requestId").toBeTruthy();
        expect(
          p.pipe?.user,
          `requestId=${rid} 的 pipe 事件 user 必须与该请求的真实身份一致（不串号）`,
        ).toBe(userOf.get(rid ?? ""));
        // 载荷与 context 同源，不是两套事实
        expect(p.context.user).toBe(p.pipe?.user);
        expect(p.context.requestId).toBe(rid);
      }

      // 反向也锁一道：两个身份各自都被自己的 pipe 事件覆盖（防止「全都串成同一个」也被上面放过）
      for (const [rid, user] of userOf) {
        expect(
          pipes.filter((p) => p.pipe?.requestId === rid && p.pipe?.user === user).length,
          `requestId=${rid} 至少要有一条属于 ${user} 的 pipe 事件`,
        ).toBeGreaterThan(0);
      }
    } finally {
      agent.destroy();
      await proxy.stop();
    }
  });

  it("Socks：两个不同用户的并发会话共享同一个 SocksForwarder，[socks] 事件各自带对的用户名", async () => {
    set("proxyMode", "server");
    const port = await getFreePort();
    const identity = new FileAccountIdentity({
      enabled: true,
      type: "basic",
      accounts: [
        { username: "alice", password: "pw1" },
        { username: "bob", password: "pw2" },
      ],
      enableLogging: false,
    });
    // 身份不串号用例与名单无关 → 显式点名「不判名单」
    const proxy = new ProbeSocks5Proxy({ host: "127.0.0.1", port, identity, ctx, access: openAccessControl() });
    const seen = record("pipe");

    await proxy.start();

    try {
      // 两条会话**同时**在飞（SOCKS 共享单例最容易串号的形态）
      const socks = await Promise.all(
        (
          [
            ["alice", "pw1"],
            ["bob", "pw2"],
          ] as const
        ).map(async ([u, p]) => {
          const sock = await tcConnect(port);
          openSockets.push(sock);
          sock.write(Buffer.from([0x05, 0x01, 0x02]));
          expect((await readBytes(sock, 2)).toString("hex"), "只提供 USER_PASS → 选 0x02").toBe("0502");
          sock.write(rfc1929(u, p));
          expect((await readBytes(sock, 2)).toString("hex"), `${u} 的 RFC1929 子协商通过`).toBe("0100");
          sock.write(socks5ConnectIpv4("127.0.0.1", rawTarget.port));
          expect((await readBytes(sock, 10)).toString("hex"), "建隧成功应答").toBe("05000001000000000000");
          return u;
        }),
      );

      expect(socks).toEqual(["alice", "bob"]);

      // 每个用户名都必须看到**带自己身份**的 CONNECT 描述行，且行内目标与身份同源
      const described = seen
        .filter((r) => r.pipe?.type === "socks" && typeof r.pipe.message === "string")
        .map((r) => r.pipe as PipeEvent & { message: string; user?: string });

      for (const user of socks) {
        const line = described.find(
          (e) => e.user === user && e.message.includes("CONNECT (socks5)"),
        );
        expect(line, `${user} 必须有一条带自己身份的 CONNECT 描述行`).toBeTruthy();
        expect(line?.message).toContain(`-> 127.0.0.1:${rawTarget.port} CONNECT (socks5)`);
      }
      // 反向锁一道：会话事件上的身份集合恰好是这两个用户名（不多、不少、不串）
      expect(
        [...new Set(described.map((e) => e.user))].sort(),
        "共享单例上的会话事件不许出现第三个身份",
      ).toEqual(["alice", "bob"]);
    } finally {
      await proxy.stop();
    }
  });
});
