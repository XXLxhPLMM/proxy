/**
 * 这一档钉合同①：`targetForm === "absolute"`（经 http/https 上游）—— request-target 保留客户端
 * absolute-form 原样、注入上游凭证、**不改写**客户端 Host（对端是代理，客户端 Host 就是凭据）。
 *
 * @module tests/integration/forward/contract
 * 目录级合同（出站形态那张表与三条决策）与目录清单见 `../AGENTS.md`；装配面见 `./fixture.js`。
 */
import { describe, expect, it } from "vitest";
import net from "node:net";
import tls from "node:tls";
import { set } from "../../../helpers/config.js";
import { TEST_CA_PATH, TEST_TLS_CERTS } from "../../../helpers/certs.js";
import {
  headers,
  ORIGIN_REPLY,
  rawRequest,
  requestLine,
  setup,
  startProxy,
  startRaw,
  trackRaw,
  UPSTREAM_BASIC,
  UPSTREAM_PASS,
  UPSTREAM_USER,
} from "./fixture.js";

describe("contract · ① absolute-form（经 http/https 上游）", () => {
  it("http 上游：request-target 保留客户端 absolute-form，Host 原样不改，且注入上游凭证", async () => {
    setup();
    const upstream = await startRaw(ORIGIN_REPLY);
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", upstream.port);
    set("upstreamUsername", UPSTREAM_USER);
    set("upstreamPassword", UPSTREAM_PASS);

    const proxyPort = await startProxy();
    // 客户端 Host 故意与 request-target 的 authority 不一致：改写就会被本用例抓住
    const { status } = await rawRequest(
      proxyPort,
      "GET http://example.com/abs?x=1 HTTP/1.1\r\nHost: client-host.example\r\n\r\n",
    );

    expect(status).toBe(200);

    const head = upstream.received().toString();
    expect(requestLine(head)).toBe("GET http://example.com/abs?x=1 HTTP/1.1");

    const h = headers(head);
    // 绝不改写：对端是代理，客户端 Host 就是「客户端本来要访问谁」的凭据
    expect(h.host).toBe("client-host.example");
    expect(h["proxy-authorization"]).toBe(UPSTREAM_BASIC);
    // 出站净化：强制 close
    expect(h.connection).toBe("close");
  });

  it("https 上游：TLS 完全由连接器承担，上游在 TLS 里看到的是同一份 absolute-form 报文", async () => {
    setup();
    const chunks: Buffer[] = [];
    const sockets = new Set<net.Socket>();
    const server = tls.createServer(TEST_TLS_CERTS, (sock) => {
      sockets.add(sock as unknown as net.Socket);
      sock.on("error", () => {});
      sock.on("data", (c: Buffer) => {
        chunks.push(c);

        if (Buffer.concat(chunks).includes("\r\n\r\n")) {
          sock.write(ORIGIN_REPLY);
        }
      });
    });
    const upstreamPort = await new Promise<number>((r) => {
      server.listen(0, "127.0.0.1", () => r((server.address() as net.AddressInfo).port));
    });
    trackRaw({
      port: upstreamPort,
      received: () => Buffer.concat(chunks),
      close: async () => {
        for (const s of sockets) {
          s.destroy();
        }
        await new Promise<void>((r) => server.close(() => r()));
      },
    });

    set("proxyMode", "client");
    set("upstreamProtocol", "https");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", upstreamPort);
    set("upstreamCa", TEST_CA_PATH);
    set("upstreamInsecure", false);

    const proxyPort = await startProxy();
    const { status } = await rawRequest(
      proxyPort,
      "GET http://example.com/tls-abs HTTP/1.1\r\nHost: client-host.example\r\n\r\n",
    );

    expect(status).toBe(200);

    const head = Buffer.concat(chunks).toString();
    expect(requestLine(head)).toBe("GET http://example.com/tls-abs HTTP/1.1");
    expect(headers(head).host).toBe("client-host.example");
  });

  it("未配上游账号即不注入 Proxy-Authorization（防 client 头透传泄漏）", async () => {
    setup();
    const upstream = await startRaw(ORIGIN_REPLY);
    set("proxyMode", "client");
    set("upstreamProtocol", "http");
    set("upstreamHost", "127.0.0.1");
    set("upstreamPort", upstream.port);

    const proxyPort = await startProxy();
    await rawRequest(proxyPort, "GET http://example.com/no-auth HTTP/1.1\r\nHost: h.example\r\n\r\n");

    const head = upstream.received().toString().toLowerCase();
    expect(head).toContain("get http://example.com/no-auth http/1.1");
    expect(head).not.toContain("proxy-authorization");
  });
});