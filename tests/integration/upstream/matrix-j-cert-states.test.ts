/**
 * 矩阵 `J) 上游证书四态（配 CA / 无 CA / CA 文件缺失 / insecure）`：证书四态的判定落点
 *
 * @module tests/integration/upstream
 *
 * 共用的桩 / 端口 / `beforeAll` 在 `./matrix-fixture.ts`；矩阵覆盖目标与分组索引见 `./AGENTS.md`。
 */

import { describe, expect, it } from "vitest";
import {
  CA,
  applyUpstream,
  httpInPort,
  httpViaProxy,
  originPort,
  stub,
  tunnelViaProxy,
} from "./matrix-fixture.js";

describe("J) 上游证书四态（配 CA / 无 CA / CA 文件缺失 / insecure）", () => {
  it("态② 配了 UPSTREAM_CA：https 上游握手成功且拿到 absolute-form（目标 host 正确）", async () => {
    const s = await stub("https", true);
    applyUpstream("https", s.port, CA, false);
    const url = `http://127.0.0.1:${originPort}/ca-ok`;
    const { status, body } = await httpViaProxy(httpInPort, url);
    // http 入站 + https 上游：absolute-form 交上游代理（与 A) 组同一形态，不是 CONNECT）
    expect(status, body).toBe(200);
    expect(body).toBe(`upstream-ok:${url}`);
    // 真的握手成功：协商结果齐全 + 上游收到的是 https 角色的 absolute-form 报文
    const facts = s.last();
    expect(facts?.protocol).toMatch(/^TLSv/);
    expect(facts?.cipher).not.toBe("");
    expect(facts?.servername, "IP 目标按 RFC6066 应置空 SNI").toBe("");
    expect(facts?.requestKind).toBe("absolute-form");
    expect(facts?.requestLine).toBe("GET " + url + " HTTP/1.1");
    expect(facts?.target).toBe(`127.0.0.1:${originPort}`);
  }, 20000);

  it("态③ 无 UPSTREAM_CA：https 上游自签被拒 → 502（不挂死），上游零应用层字节", async () => {
    const s = await stub("https", true);
    applyUpstream("https", s.port, "", false);
    const { status, body } = await httpViaProxy(
      httpInPort,
      `http://127.0.0.1:${originPort}/ca-missing`,
    );
    expect(status, body).toBe(502);
    // 客户端在握手阶段就拒了自签证书：TCP 建链发生过、发出过 ClientHello，
    // 但 TLS 握手未完成 → 上游零应用层会话（证明「失败点在 TLS 校验」而非「没建链」）
    expect(s.connections()).toBe(1);
    expect(s.sessions()).toHaveLength(0);
  }, 20000);

  it("态① CA 文件缺失（回退系统信任库）：https 上游自签被拒 → 502，上游零应用层字节", async () => {
    const s = await stub("https", true);
    // 路径不存在 → readUpstreamCa 返回 undefined → 回退系统信任库
    applyUpstream("https", s.port, "keys/nope-upstream-ca.crt", false);
    const { status, body } = await httpViaProxy(
      httpInPort,
      `http://127.0.0.1:${originPort}/ca-file-missing`,
    );
    expect(status, body).toBe(502);
    expect(s.connections()).toBe(1);
    expect(s.sessions()).toHaveLength(0);
  }, 20000);

  it("态④ UPSTREAM_INSECURE=true：跳过校验，https 上游握手成功且 CONNECT 到源站", async () => {
    const s = await stub("https", true);
    applyUpstream("https", s.port, "", true);
    // 用 CONNECT 走隧道，让「源站真的收到请求」也可断言
    const { status, body } = await tunnelViaProxy(
      httpInPort,
      `127.0.0.1:${originPort}`,
      "/insecure-ok",
    );
    expect(status, body).toBe(200);
    expect(body).toContain("origin-ok:/insecure-ok");
    expect(s.last()?.protocol).toMatch(/^TLSv/);
    expect(s.last()?.requestKind).toBe("connect");
    expect(s.last()?.target).toBe(`127.0.0.1:${originPort}`);
  }, 20000);

  it("态④ sockss5 上游 insecure：跳过校验，SOCKS5 上游握手成功且转发到源站", async () => {
    const s = await stub("socks5", true);
    applyUpstream("sockss5", s.port, "", true);
    const { status, body } = await tunnelViaProxy(
      httpInPort,
      `127.0.0.1:${originPort}`,
      "/insecure-sockss5",
    );
    expect(status, body).toBe(200);
    expect(body).toContain("origin-ok:/insecure-sockss5");
    expect(s.last()?.protocol).toMatch(/^TLSv/);
    expect(s.last()?.requestKind).toBe("socks5-greeting");
    expect(s.last()?.target).toBe(`127.0.0.1:${originPort}`);
  }, 20000);

  it("态② sockss4 上游配 CA：握手成功且上游收到 socks4 CONNECT", async () => {
    const s = await stub("socks4", true);
    applyUpstream("sockss4", s.port, CA, false);
    const { status, body } = await tunnelViaProxy(
      httpInPort,
      `127.0.0.1:${originPort}`,
      "/ca-sockss4",
    );
    expect(status, body).toBe(200);
    expect(body).toContain("origin-ok:/ca-sockss4");
    expect(s.last()?.protocol).toMatch(/^TLSv/);
    expect(s.last()?.requestKind).toBe("socks4-connect");
    expect(s.last()?.target).toBe(`127.0.0.1:${originPort}`);
  }, 20000);

  it("态③ sockss4 上游无 CA：自签被拒 → CONNECT 502（不挂死），上游零应用层字节", async () => {
    const s = await stub("socks4", true);
    applyUpstream("sockss4", s.port, "", false);
    const { status, body } = await tunnelViaProxy(
      httpInPort,
      `127.0.0.1:${originPort}`,
      "/ca-missing-sockss4",
    );
    expect(status, body).toBe(502);
    expect(s.connections()).toBe(1);
    expect(s.sessions()).toHaveLength(0);
  }, 20000);

  it("态④ sockss4 上游 insecure：跳过校验，握手成功且转发到源站", async () => {
    const s = await stub("socks4", true);
    applyUpstream("sockss4", s.port, "", true);
    const { status, body } = await tunnelViaProxy(
      httpInPort,
      `127.0.0.1:${originPort}`,
      "/insecure-sockss4",
    );
    expect(status, body).toBe(200);
    expect(body).toContain("origin-ok:/insecure-sockss4");
    expect(s.last()?.requestKind).toBe("socks4-connect");
    expect(s.last()?.target).toBe(`127.0.0.1:${originPort}`);
  }, 20000);
});
