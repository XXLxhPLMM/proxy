/**
 * 跨源：缺省一个 CORS 头都不发，配了白名单才逐 origin 放行
 *
 * @description
 * 本档盯 `http/cors.ts` 那一条判据的**线上字节**：预检豁免**绝不进路由表**、**不放宽真实请求的鉴权**、
 * 白名单整串相等、以及 `MANAGER_CORS_ORIGINS` 的语法（`parseCorsPolicy` 那个纯函数）。
 * 跨源规格的收面与回收在本档（每个用例一个独立面）；默认那个面归 `./_manager-http.ts`，
 * 主题级不变量见 `./AGENTS.md`。
 * @module tests/unit/manager/http
 */
import fs from "node:fs";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { parseCorsPolicy } from "@/manager/http/index.js";
import { call, port, routesFor, serve, usersFile } from "./_manager-http.js";

/** 为白名单规格起一个真服务器，并在用例结束时收掉（跨源组每个用例一个独立面） */
async function serveCors(rawOrigins: string): Promise<number> {
  const { port: p, server: s } = await serve(routesFor(), parseCorsPolicy(rawOrigins));
  extraServers.push(s);
  return p;
}

/** {@link serveCors} 起的那些面（默认那个不在其中，由 `_manager-http.ts` 的 `afterEach` 单独关） */
const extraServers: http.Server[] = [];

/**
 * 「两个面逐项相同」的比对面：逐出 `date` 与 `content-length`
 * @description
 * 这两个头的值是**时钟**的函数而不是跨源判据的函数：`date` 由 `node:http` 自动加（秒级分辨率），
 * `content-length` 是响应体字节数 —— 而 `/api/status` 的 `process.uptimeMs` 是**每次请求现算**的
 * （`Date.now() - processFacts.startedAt`），位数一变它就差一字节。留着它们比，这条断言测的就成了
 * 「两次往返有没有跨过时钟边界」，偶尔红而与跨源毫无关系。⚠️ 逐出的集合是断言契约的一部分：
 * 其余每一个头（含全部 `Access-Control-*` 与 `Vary`）仍必须逐项相同。
 */
function stableHeaders(headers: http.IncomingHttpHeaders): [string, string | string[] | undefined][] {
  return Object.entries(headers)
    .filter(([name]) => name !== "date" && name !== "content-length")
    .sort();
}

afterEach(async () => {
  for (const s of extraServers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
    });
  }
});

/** 本组所有断言都锚在**真响应头**上，不锚任何源码符号名（根 `AGENTS.md`「写护栏时」） */
describe("跨源：默认封闭，白名单逐 origin 放行", () => {
  /** 白名单里的 origin（配了它，下面的「放行」行为才有对象） */
  const ALLOWED = "http://gui.example";
  /** 白名单里没有的那个 origin */
  const STRANGER = "http://evil.example";

  /** 一次浏览器发出来的真预检（Fetch 规范：必带 ACRM，且**不带**凭据） */
  function preflightHeaders(origin: string): Record<string, string> {
    return {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type",
    };
  }

  it("缺省（白名单为空）：任何响应都不含任何 access-control-* 头", async () => {
    const p = await serveCors("");
    // 无 Origin、已放行 Origin、未放行 Origin 三种请求都过一遍
    for (const headers of [{}, { Origin: ALLOWED }, { Origin: STRANGER }] as Record<string, string>[]) {
      const reply = await call(p, { headers });
      for (const [name, value] of Object.entries(reply.headers)) {
        expect(name.toLowerCase().startsWith("access-control-"), `${name} 不该出现`).toBe(false);
        expect(value).toBeDefined();
      }
    }
  });

  it("缺省（白名单为空）：带 Origin 的 OPTIONS 仍是 401（**豁免只在配了白名单时存在**）", async () => {
    const p = await serveCors("");
    const reply = await call(p, { method: "OPTIONS", token: null, headers: preflightHeaders(ALLOWED) });
    expect(reply.status).toBe(401);
  });

  it("缺省：加装这一段前后，响应的**头**逐项相同（status 与每个头的值）", async () => {
    // 断言面是 HTTP **头**：那是 CORS 唯一能改动的东西。响应体不比——`/api/status` 带
    // `uptimeMs`，两个不同的面在同一毫秒取值都未必相同，拿它比会把「uptime 变了」误判成回归。
    const p = await serveCors("");
    for (const path of ["/api/status", "/api/config", "/api/nope"]) {
      const a = await call(port, { path });
      const b = await call(p, { path });
      expect(b.status, `${path} 状态码`).toBe(a.status);
      expect(stableHeaders(b.headers), `${path} 响应头`).toEqual(stableHeaders(a.headers));
    }
  });

  it("白名单命中的 origin 预检 ⇒ 204 + 精确 ACAO + Vary + Allow-Headers 含 Authorization", async () => {
    const p = await serveCors(ALLOWED);
    const reply = await call(p, { method: "OPTIONS", token: null, headers: preflightHeaders(ALLOWED) });
    expect(reply.status).toBe(204);
    expect(reply.raw).toBe("");
    expect(reply.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(reply.headers.vary).toContain("Origin");
    expect(reply.headers["access-control-allow-headers"]).toContain("Authorization");
    expect(reply.headers["access-control-allow-headers"]).toContain("Content-Type");
    expect(reply.headers["access-control-allow-methods"]).toContain("POST");
    expect(reply.headers["access-control-max-age"]).toBeDefined();
  });

  it("白名单外的 origin 连豁免都拿不到（401 且零 CORS 头）", async () => {
    const p = await serveCors(ALLOWED);
    const reply = await call(p, { method: "OPTIONS", token: null, headers: preflightHeaders(STRANGER) });
    expect(reply.status).toBe(401);
    expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
    expect(reply.headers.vary).toBeUndefined();
  });

  it("⚠️ 豁免**没有**顺带把鉴权也豁免掉：放行 origin + 错 token 的写请求仍是 401", async () => {
    const p = await serveCors(ALLOWED);
    const reply = await call(p, {
      method: "POST",
      path: "/api/users",
      token: "not-the-token",
      body: { username: "cors-canary" },
      headers: { Origin: ALLOWED },
    });
    expect(reply.status).toBe(401);
    // 而 401 带 ACAO：浏览器能读到 401 的 JSON body（GUI 因此能显示「凭据不对」）
    expect(reply.headers["access-control-allow-origin"]).toBe(ALLOWED);
    // 且账号表一个字节都没变
    expect(JSON.parse(fs.readFileSync(usersFile(), "utf8"))).toEqual([]);
  });

  it("放行 origin 的正常请求：带 ACAO + Vary，且正常鉴权（对 token ⇒ 200）", async () => {
    const p = await serveCors(ALLOWED);
    const reply = await call(p, { headers: { Origin: ALLOWED } });
    expect(reply.status).toBe(200);
    expect(reply.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(reply.headers.vary).toContain("Origin");
  });

  it("⚠️ 预检对**存在与不存在的路径返回逐字节相同**的 204（端点清单没被重新打开）", async () => {
    const p = await serveCors(ALLOWED);
    const existing = await call(p, { method: "OPTIONS", token: null, path: "/api/users", headers: preflightHeaders(ALLOWED) });
    const missing = await call(p, { method: "OPTIONS", token: null, path: "/api/nope", headers: preflightHeaders(ALLOWED) });
    expect(existing.status).toBe(204);
    expect(missing.status).toBe(204);
    expect(missing.raw).toBe(existing.raw);
    expect(Object.keys(missing.headers).sort()).toEqual(Object.keys(existing.headers).sort());
    // 且 Allow 头一次都不许出现（405 的契约部分，那正是「这个端点存在」的证据）
    expect(existing.headers.allow).toBeUndefined();
    expect(missing.headers.allow).toBeUndefined();
  });

  it("预检的 Allow-Methods 是**常量**、逐路径相同（绝不从路由表推导）", async () => {
    const p = await serveCors(ALLOWED);
    const a = await call(p, { method: "OPTIONS", token: null, path: "/api/status", headers: preflightHeaders(ALLOWED) });
    const b = await call(p, { method: "OPTIONS", token: null, path: "/api/users/x/y/z", headers: preflightHeaders(ALLOWED) });
    expect(b.headers["access-control-allow-methods"]).toBe(a.headers["access-control-allow-methods"]);
  });

  it("随手打的 OPTIONS（不带 ACRM）**不**是预检，仍走鉴权 401", async () => {
    const p = await serveCors(ALLOWED);
    const reply = await call(p, { method: "OPTIONS", token: null, headers: { Origin: ALLOWED } });
    expect(reply.status).toBe(401);
    expect(reply.headers["access-control-allow-methods"]).toBeUndefined();
  });

  it("全部响应都不含 Access-Control-Allow-Credentials（控制面用 Bearer，不进那个更严的模式）", async () => {
    const p = await serveCors(ALLOWED);
    const probes = [
      { method: "OPTIONS", token: null, headers: preflightHeaders(ALLOWED) },
      { headers: { Origin: ALLOWED } },
      { headers: { Origin: STRANGER } },
      { token: null, headers: { Origin: ALLOWED } },
      { path: "/api/nope", headers: { Origin: ALLOWED } },
    ];
    for (const probe of probes) {
      const reply = await call(p, probe);
      expect(
        reply.headers["access-control-allow-credentials"],
        `${probe.method ?? "GET"} ${probe.path ?? "/api/status"} 不该带 Allow-Credentials`,
      ).toBeUndefined();
    }
  });

  it("白名单是**整串相等**：同后缀的陌生 origin 拿不到放行", async () => {
    const p = await serveCors("http://a.example");
    for (const stranger of ["http://evil-a.example", "http://a.example.evil.com", "https://a.example"]) {
      const reply = await call(p, { headers: { Origin: stranger } });
      expect(reply.headers["access-control-allow-origin"], `${stranger} 不该被放行`).toBeUndefined();
    }
  });

  it("配置项大小写混写能生效（origin 没有大小写敏感的成分，比对前两侧小写化）", async () => {
    const p = await serveCors("HTTP://Gui.Example");
    const reply = await call(p, { method: "OPTIONS", token: null, headers: preflightHeaders(ALLOWED) });
    // 回显的是**小写**形态：回显原始大小写会让浏览器的 origin 比对失败
    expect(reply.status).toBe(204);
    expect(reply.headers["access-control-allow-origin"]).toBe(ALLOWED);
  });

  it("`parseCorsPolicy`：空串 ⇒ 不放行；逗号分隔容忍空白与重复", () => {
    expect(parseCorsPolicy("")).toEqual({ allowedOrigins: [] });
    expect(parseCorsPolicy("   ")).toEqual({ allowedOrigins: [] });
    expect(parseCorsPolicy(" , ,")).toEqual({ allowedOrigins: [] });
    expect(parseCorsPolicy("http://a.com")).toEqual({ allowedOrigins: ["http://a.com"] });
    expect(parseCorsPolicy(" http://A.com:8080 , http://b.com ,http://a.com:8080 ")).toEqual({
      allowedOrigins: ["http://a.com:8080", "http://b.com"],
    });
  });

  it("白名单里是一条垃圾串时**天然 fail-closed**：任何真实 origin 都匹配不上它", async () => {
    // ⚠️ 语法非法的配置在**启动期**就被 `assertManagerConfig` 拒了（判据只有一个，在那边），
    // 本层不重复一份。故这里要验的是那条**兜底性质**：就算那道闸门被绕过，一个垃圾条目也
    // 匹配不上任何浏览器规范化后的 origin —— 于是它顶多让白名单变短，绝不会变宽。
    const p = await serveCors("not-an-origin");
    // 浏览器可能发出的 origin 全在这儿，逐个都必须拿不到豁免
    for (const origin of ["http://a.com", "https://a.com", "null", "*", "file://", "http://a.com/"]) {
      const reply = await call(p, { method: "OPTIONS", token: null, headers: preflightHeaders(origin) });
      expect(reply.status, `${origin} 不得拿到豁免`).toBe(401);
      expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });
});
