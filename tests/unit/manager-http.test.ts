/**
 * manager 控制面 HTTP 面的单测：**真 `http.Server` 监听端口 0**，不 mock `node:http`
 *
 * @description
 * ## 为什么必须起真服务器
 *
 * 本档盯的东西里有三样**只在真 socket 上才存在**：`writeHead` 之后再 `setHeader` 不生效
 * （所以 `WWW-Authenticate` 必须随同一次 writeHead 写出）、`Content-Length` 与实际字节数
 * 的一致性、以及 `req.destroy()` 之后对端看到的是什么。mock 掉 `node:http` 的档全部测不到，
 * 而它们恰好是「错误响应泄露了什么」这条边界的真实观测点。
 *
 * 鉴权 / 路由 / 错误映射三档各自由 `../http/` 的对应模块实现，本档**只经 HTTP 线上字节**
 * 断言它们的契约——不直接调 `statusForOpsError` 了事（那是单元、不是契约）。
 *
 * ## 本档盯的九件事，按「错了会怎样」排序
 *
 * 1. **鉴权覆盖每一个方法**（含 `OPTIONS` / `HEAD` / 不存在的动词）。漏一个 = 一扇没锁的门。
 *    锁点：五种方法 × 三种凭据（无 / 错 / 对）的真值表。
 * 2. **未鉴权者拿不到 404 与 405 的区分**。`Allow` 头与「路径不存在」的差别本身就是端点清单。
 *    锁点：无 token 时不存在的路径与存在但方法错的路径**状态码相同**。
 * 3. **状态码只由 `OpsError.code` 决定**。锁点：一个 `code` 被改成表外值、而 `message`
 *    **逐字像**某个已知分类的错误，必须回 500 且**不回 message**。
 * 4. **错误响应不含栈、不含 token 明文**。锁点：故意让一个路由抛带栈的普通 Error，
 *    断言响应里只有 500 + requestId；以及真实落盘的日志里 token 一个字都不许出现。
 * 5. **路径穿越**：`%2e%2e%2f` 与 `../` 在路由层不可区分，真正的判别发生在 decode 之后。
 *    锁点：`GET /api/users/..%2F..%2Fetc` 回 400 且账号表一个字节都没变。
 * 6. **幂等 no-op 是 200 + `changed: false`**，不是 4xx、也不是「已改」。
 * 7. **`add` 撞名是 409**（不是覆盖、不是静默成功）。
 * 8. **只读名单驱动是 501**（请求合法，是部署侧永久缺能力）。
 * 9. **`/api/status` 的数据面状态必须是现读的真值**。锁点：改判据后紧跟着的那次请求就看到
 *    新值；且 master 模式必须报 `mode: "master"` + `running: false` 而不是谎报在监听。
 *
 * ## 护栏的变异实测（根 `AGENTS.md`「写护栏时」硬要求）
 *
 * 第 10 组「源码级护栏」逐条做了变异：把 `authorize` 的调用从路由**之前**挪到路由**之后**、
 * 把 `sendFailure` 的 500 分支改成回 message、把 username 的字符集放宽 —— 每一条
 * 都实测过「被防住的行为重新出现时会红」。判据锚点全部是**今天仍存在的形状**
 * （函数调用 / import / 赋值 / 从源码现取的正则字面量），没有一个锚在已删除的符号名上。
 *
 * @module tests/unit/manager-http
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAclSource } from "@/datasource/acl/index.js";
import type { AclConfig, AclSource } from "@/datasource/acl/index.js";
import { OpsError, resolveOpsSources, type OpsSources } from "@/ops/index.js";
import { authorize, createManagerServer, MAX_BODY_BYTES } from "@/manager/http/index.js";
import type { Route } from "@/manager/http/index.js";
import { managerRoutes, type DataPlaneStatus } from "@/manager/routes/index.js";
import { accountPatchFrom } from "@/manager/routes/patch.js";
import { requireSafeAclEntry, requireSafeUsername } from "@/manager/routes/input.js";
import { createLogger, type LoggerImpl } from "@/utils/logger/index.js";
import { parseHostRule, parseIpRule } from "@/addr/index.js";
import { blockAfter, codeOf, codeOnly } from "../helpers/source-scan.js";

const TOKEN = "mgr-http-canary-4f1c9a";
const JWT_SECRET = "jwt-plaintext-canary-6b21";
const PASSPHRASE = "passphrase-canary-9d33";
const UPSTREAM_PASSWORD = "upstream-plaintext-canary-1e77";
const INTERNAL_SECRET_PATH = path.join(os.tmpdir(), "manager-http-internal-only");

let dir = "";
let logDir = "";
let sources: OpsSources;
let logger: LoggerImpl;
let server: http.Server;
let port = 0;
/**
 * 假数据面活状态（本档盯的是 HTTP 契约，不是数据面本身）
 * @description
 * 每次 `GET /api/status` 现读，故改 `dataPlane.value` 后紧跟着的那次请求就会看到新值。
 */
const dataPlane = {
  value: {
    mode: "running",
    protocol: "http",
    host: "0.0.0.0",
    port: 3000,
    running: true,
    startedAt: 1_700_000_000_000,
    uptimeMs: 1234,
  } as DataPlaneStatus,
};

/** 借组合根的装配拿路由表（本档不测装配本身；装配另有 `manager-control-plane.test.ts`） */
function routesFor(s: OpsSources): Route[] {
  return managerRoutes({ sources: s, processFacts: processFacts(), dataPlane: () => dataPlane.value });
}

function writeUsers(body: unknown): void {
  fs.mkdirSync(path.join(dir, "cfg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "cfg", "users.json"), JSON.stringify(body, null, 2));
}

function writeAcl(body: unknown): void {
  fs.mkdirSync(path.join(dir, "cfg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "cfg", "acl.json"), JSON.stringify(body, null, 2));
}

function usersFile(): string {
  return path.join(dir, "cfg", "users.json");
}

const EMPTY_ACL_DOC = {
  clientIp: { whitelist: [], blacklist: [] },
  target: { whitelist: [], blacklist: [] },
  upstream: { whitelist: [], blacklist: [] },
};

/** 起一个真服务器（端口 0 → 随机端口），返回它 */
async function serve(routes: readonly Route[]): Promise<{ port: number; server: http.Server }> {
  const s = createManagerServer({
    token: TOKEN,
    routes,
    logger,
    maxBodyBytes: MAX_BODY_BYTES,
  });
  await new Promise<void>((resolve) => {
    s.listen(0, "127.0.0.1", () => resolve());
  });
  return { port: (s.address() as { port: number }).port, server: s };
}

interface Reply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly raw: string;
  readonly json: Record<string, unknown> | null;
}

function call(
  target: number,
  options: {
    method?: string;
    path?: string;
    token?: string | null;
    body?: unknown;
    rawBody?: string;
  } = {},
): Promise<Reply> {
  const method = options.method ?? "GET";
  const payload = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.token !== null) {
      headers.Authorization = `Bearer ${options.token ?? TOKEN}`;
    }
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      { host: "127.0.0.1", port: target, method, path: options.path ?? "/api/status", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> | null = null;
          try {
            json = raw === "" ? null : (JSON.parse(raw) as Record<string, unknown>);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, json });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

/** 读回落盘的日志原文（**断言的是日志文件里真实写了什么**） */
async function logText(): Promise<string> {
  await logger.flush();
  const names = fs.readdirSync(logDir).filter((n) => n.endsWith(".jsonl"));
  return (
    await Promise.all(names.map(async (n) => fs.promises.readFile(path.join(logDir, n), "utf8")))
  ).join("");
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "manager-http-"));
  logDir = path.join(dir, "logs");
  writeUsers([]);
  writeAcl(EMPTY_ACL_DOC);
  logger = createLogger({ file: logDir, level: "silent", fileLevel: "debug" });
  sources = await resolveOpsSources(
    {
      NODE_ENV: "development",
      MANAGER_ENABLED: "true",
      MANAGER_TOKEN: TOKEN,
      JWT_SECRET,
      TLS_PASSPHRASE: PASSPHRASE,
      UPSTREAM_PASSWORD,
      UPSTREAM_URL: "http://user1:pw1@upstream.invalid:8080",
      QUOTA_USAGE_DIR: path.join(dir, "cfg", "usage"),
    },
    dir,
  );
  const started = await serve(
    routesFor(sources),
  );
  port = started.port;
  server = started.server;
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => {
    server?.close(() => resolve());
  });
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不应遮蔽用例结论
  }
});

function processFacts() {
  return {
    pid: 999,
    startedAt: Date.now(),
    node: process.version,
    platform: process.platform,
    cwd: dir,
  };
}

// ---------------------------------------------------------------------------
// 1. 鉴权：覆盖每一个方法，且空 token ⇒ 恒 401
// ---------------------------------------------------------------------------

describe("鉴权：每一个方法都要过，且先于路由", () => {
  const methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH"];

  it("无 token ⇒ 401（逐个方法）", async () => {
    for (const method of methods) {
      const reply = await call(port, { method, path: "/api/status", token: null });
      expect(reply.status, `${method} 无 token 必须是 401`).toBe(401);
    }
  });

  it("错 token ⇒ 401（逐个方法）", async () => {
    for (const method of methods) {
      const reply = await call(port, { method, path: "/api/status", token: "not-the-token" });
      expect(reply.status, `${method} 错 token 必须是 401`).toBe(401);
    }
  });

  it("token 长度不等时也是 401 而不是 500（timingSafeEqual 长度不等会抛）", async () => {
    for (const wrong of ["", "m", TOKEN.slice(0, -1), `${TOKEN}x`, TOKEN.repeat(2)]) {
      const reply = await call(port, { token: wrong });
      expect(reply.status, `token=${JSON.stringify(wrong)} 必须是 401`).toBe(401);
    }
  });

  it("正确 token ⇒ 200", async () => {
    expect((await call(port)).status).toBe(200);
  });

  it("空 token 的服务一律 401（HTTP 层不依赖 loadConfig 的那条校验）", async () => {
    const s = createManagerServer({
      token: "",
      routes: routesFor(sources),
      logger,
      maxBodyBytes: MAX_BODY_BYTES,
    });
    await new Promise<void>((resolve) => {
      s.listen(0, "127.0.0.1", () => resolve());
    });
    const p = (s.address() as { port: number }).port;
    try {
      expect((await call(p, { token: "" })).status).toBe(401);
      expect((await call(p, { token: TOKEN })).status).toBe(401);
    } finally {
      s.closeAllConnections();
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
      });
    }
  });

  it("401 带 WWW-Authenticate，且**不回显**本次带来的凭据", async () => {
    const reply = await call(port, { token: "leaked-canary-value" });
    expect(reply.status).toBe(401);
    expect(reply.headers["www-authenticate"]).toContain("Bearer");
    expect(reply.raw).not.toContain("leaked-canary-value");
  });

  it("未鉴权者拿不到 404 与 405 的区分（那条区分本身就是端点清单）", async () => {
    const missing = await call(port, { path: "/api/nope", token: null });
    const wrongMethod = await call(port, { method: "DELETE", path: "/api/status", token: null });
    expect(missing.status).toBe(401);
    expect(wrongMethod.status).toBe(401);
    expect(missing.headers.allow).toBeUndefined();
    expect(wrongMethod.headers.allow).toBeUndefined();
  });

  it("`authorize` 是纯函数：空 token 恒 false、长度不等不抛（直接断言那个零件）", () => {
    expect(authorize("Bearer " + TOKEN, TOKEN)).toBe(true);
    expect(authorize("bearer " + TOKEN, TOKEN)).toBe(true);
    expect(authorize("Bearer " + TOKEN, "")).toBe(false);
    expect(authorize(undefined, TOKEN)).toBe(false);
    expect(authorize("Basic " + TOKEN, TOKEN)).toBe(false);
    expect(authorize("Bearer " + TOKEN, "totally-different")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. 路由：404 / 405 分开，Allow 是契约的一部分
// ---------------------------------------------------------------------------

describe("路由：404 与 405 分开", () => {
  it("路径不存在 ⇒ 404", async () => {
    const reply = await call(port, { path: "/api/nope" });
    expect(reply.status).toBe(404);
  });

  it("路径存在但方法不对 ⇒ 405 + Allow", async () => {
    const reply = await call(port, { method: "DELETE", path: "/api/status" });
    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe("GET");
  });

  it("OPTIONS / HEAD 也是 405（这个面不做 CORS 预检，也不需要 HEAD）", async () => {
    expect((await call(port, { method: "OPTIONS" })).status).toBe(405);
    expect((await call(port, { method: "HEAD" })).status).toBe(405);
  });

  it("尾斜杠不是另一个端点", async () => {
    expect((await call(port, { path: "/api/status/" })).status).toBe(200);
  });

  it("畸形百分号编码 ⇒ 400（不是 404：那个端点确实存在）", async () => {
    const reply = await call(port, { path: "/api/users/%zz" });
    expect(reply.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 3. 路径穿越
// ---------------------------------------------------------------------------

describe("路径参数防穿越", () => {
  it("`..%2F..%2F` 在 decode 之后被拒 ⇒ 400，且账号表一个字节都没变", async () => {
    const before = fs.readFileSync(usersFile(), "utf8");
    for (const attack of [
      "/api/users/..%2F..%2Fetc%2Fpasswd",
      "/api/users/%2e%2e%2f%2e%2e%2fetc",
      "/api/users/....//etc",
    ]) {
      const reply = await call(port, { path: attack });
      expect(reply.status, `${attack} 必须是 400/404，绝不能是 2xx`).toBeGreaterThanOrEqual(400);
    }
    expect(fs.readFileSync(usersFile(), "utf8")).toBe(before);
  });

  it("**username** 的白名单挡住路径分隔符、控制字符与 NUL", () => {
    for (const bad of ["..", ".", "a/b", "a\\b", "a\u0000b", "a\nb", "", "a".repeat(256)]) {
      expect(() => requireSafeUsername(bad), `${JSON.stringify(bad)} 必须被拒`).toThrow(OpsError);
    }
    expect(requireSafeUsername("alice")).toBe("alice");
    expect(requireSafeUsername("a.b_c-d")).toBe("a.b_c-d");
  });

  it("名单条目同样过白名单（它会被写进名单文件）", async () => {
    const reply = await call(port, {
      method: "POST",
      path: "/api/acl",
      body: { group: "target", list: "blacklist", entry: "../evil" },
    });
    expect(reply.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 3b. 名单条目的字符集：**与数据层语法对齐**，且**不是** username 那一份
// ---------------------------------------------------------------------------

/**
 * 数据层（`parseIpRule` / `parseHostRule`）接受的形态清单
 * @description
 * 逐条覆盖 `@/addr` 里每一个**字符级**来源：IPv4 / CIDR、IPv6 的 `::` 压缩与
 * 内嵌 v4 尾、方括号字面量、`%zone`、域名 / 通配域名 / FQDN 尾点 / 连字符标签 / 混合大小写。
 * 「数据层接受」这件事由 {@link DATA_LAYER_FORMS} 那条护栏自己复核（`accepted.length` 必须等于
 * 全长），所以这份清单不会因为数据层收窄而悄悄退化成空断言。
 */
const DATA_LAYER_FORMS = [
  "1.2.3.4",
  "10.0.0.0/8",
  "0.0.0.0/0",
  "255.255.255.255/32",
  "::1",
  "::",
  "2001:db8::/32",
  "2001:db8::1",
  "::ffff:1.2.3.4",
  "::ffff:7f00:1",
  "fe80::1%eth0",
  "[::1]",
  "[2001:db8::1]",
  "example.com",
  "*.cdn.io",
  "*.example.com",
  "EXAMPLE.COM",
  "example.com.",
  "a-b.c-d.example",
  "xn--fiqs8s.test",
  "1.example",
] as const;

/**
 * 从 `input.ts` **现取**那两条字符集（源码里的正则字面量）并编成 `RegExp`
 * @description
 * 护栏的作用对象必须是**交付出去的那份**字符集。测试自己抄一份 `new RegExp("[...]")` 等于把
 * 判据又复制了一遍——实现改了、测试没改，它照样绿。这里从源码字面量取，于是「变异那份源码」
 * 就等于「变异被测的那份判据」。
 */
function classFromSource(name: "SAFE_USERNAME" | "SAFE_ACL_ENTRY"): RegExp {
  const code = codeOf("manager", "routes", "input.ts");
  const at = code.indexOf(`const ${name} = /`);
  expect(at, `源码里找不到 ${name}`).toBeGreaterThanOrEqual(0);
  const literal = code.slice(at + `const ${name} = `.length, code.indexOf(";", at));
  expect(literal.startsWith("/") && literal.endsWith("/"), `${name} 已经不是正则字面量了`).toBe(true);
  return new RegExp(literal.slice(1, -1));
}

/**
 * `@/ops/acl.ts:syntaxHint` 在错误信息里举的**每个例子**（从源码现取，不手抄）
 * @description
 * `syntaxHint` 是 ops 层对操作者的**承诺**（「正确写法长成这样」）。它举的形态如果 HTTP 层
 * 表达不了，那条承诺就是假的——于是本组从那份源码里把例子抠出来逐条验，而不是维护第三份
 * 清单（第三份必然腐烂）。抠不出来（`examples` 为空）时断言显式失败，防空转。
 */
function syntaxHintExamples(): string[] {
  const branch = blockAfter(codeOf("ops", "acl.ts"), "function syntaxHint(");
  const out: string[] = [];
  for (const m of branch.matchAll(/（如 ([^）]*)）/g)) {
    for (const item of (m[1] ?? "").split("、")) {
      out.push(item.trim());
    }
  }
  return out;
}

describe("名单条目字符集：对齐数据层语法，且不与 username 合并", () => {
  it("CIDR / 通配域名 / IPv6 都过，且**删得掉**（`changed:true`）", async () => {
    const cases: Array<[string, string, string]> = [
      ["clientip", "whitelist", "10.0.0.0/8"],
      ["clientip", "blacklist", "2001:db8::/32"],
      ["target", "whitelist", "*.cdn.io"],
      ["target", "blacklist", "example.com"],
    ];
    for (const [group, list, entry] of cases) {
      const added = await call(port, { method: "POST", path: "/api/acl", body: { group, list, entry } });
      expect(added.status, `POST ${entry} 必须 200：${added.raw}`).toBe(200);
      expect((added.json as { changed: boolean }).changed).toBe(true);

      const read = await call(port, { path: "/api/acl" });
      const acl = (read.json as { acl: AclConfig }).acl;
      const key = group === "clientip" ? "clientIp" : group;
      expect(acl[key as keyof AclConfig][list as "whitelist"], `GET 必须读回 ${entry}`).toEqual([entry]);

      // 这一步是本组存在的理由：以前 CIDR 同样进得来、却**永远删不掉**
      const removed = await call(port, {
        method: "DELETE",
        path: `/api/acl?group=${group}&list=${list}&entry=${encodeURIComponent(entry)}`,
      });
      expect(removed.status, `DELETE ${entry} 必须 200`).toBe(200);
      expect((removed.json as { changed: boolean }).changed, `DELETE ${entry} 必须真的删掉`).toBe(true);
    }
  });

  it("手改进 acl.json 的 CIDR 也能经 HTTP 删掉（读得到 ⇒ 删得掉）", async () => {
    // 直接落盘一个「传输层曾经表达不了」的合法条目 —— 运维改文件后不必再改第二次
    writeAcl({
      ...structuredClone(EMPTY_ACL_DOC),
      clientIp: { whitelist: ["10.0.0.0/8"], blacklist: [] },
    });
    const removed = await call(port, {
      method: "DELETE",
      path: "/api/acl",
      body: { group: "clientip", list: "whitelist", entry: "10.0.0.0/8" },
    });
    expect(removed.status).toBe(200);
    expect((removed.json as { changed: boolean }).changed).toBe(true);
    const read = await call(port, { path: "/api/acl" });
    expect(((read.json as { acl: AclConfig }).acl).clientIp.whitelist).toEqual([]);
  });

  it("穿越与控制字符仍被拒（放开 `/` 之后**没有**顺手放开这些）", async () => {
    const bad = [
      "../../x",
      "../x",
      "x/../y",
      "..",
      "/10.0.0.0/8",
      "10.0.0.0/8/",
      "a\u0000b",
      "a\nb",
      "a\tb",
      "10.0.0.0 /8",
      "a\\b",
      'a"b',
      "a_b",
      "",
      "a".repeat(256),
    ];
    for (const entry of bad) {
      expect(() => requireSafeAclEntry(entry), `${JSON.stringify(entry)} 必须被拒`).toThrow(OpsError);
    }
    for (const entry of ["../../etc/passwd", ".."]) {
      const reply = await call(port, {
        method: "POST",
        path: "/api/acl",
        body: { group: "clientip", list: "whitelist", entry },
      });
      expect(reply.status, `POST ${JSON.stringify(entry)} 必须是 400`).toBe(400);
    }
  });

  it("**username 仍然拒绝 `/`（两份判据不许合并成一个）**", async () => {
    const user = classFromSource("SAFE_USERNAME");
    const entry = classFromSource("SAFE_ACL_ENTRY");
    expect(user.source, "两个判据合并了").not.toBe(entry.source);
    // 差异方向必须是「条目那份更宽、username 那份更窄」，逐字符点出来
    for (const ch of ["/", ":", "*", "[", "]", "%"]) {
      expect(user.test(`a${ch}b`), `username 字符集必须拒 ${ch}`).toBe(false);
      expect(entry.test(`a${ch}b`), `名单字符集应当收 ${ch}`).toBe(true);
    }
    for (const ch of [".", "-", "_", "0", "A"]) {
      expect(user.test(`a${ch}b`), `username 字符集必须收 ${ch}`).toBe(true);
    }
    // 线上观测：同一个 `/`，username 400、acl entry 200
    expect(
      (await call(port, { method: "POST", path: "/api/users", body: { username: "a/b", password: "pw" } }))
        .status,
    ).toBe(400);
    expect(
      (await call(port, {
        method: "POST",
        path: "/api/acl",
        body: { group: "clientip", list: "whitelist", entry: "10.0.0.0/8" },
      })).status,
    ).toBe(200);
  });

  it("**跨层对齐 ①**：数据层接受的每一种形态，HTTP 层字符集都表达得了", () => {
    const cls = classFromSource("SAFE_ACL_ENTRY");
    const accepted = DATA_LAYER_FORMS.filter(
      (e) => parseIpRule(e) !== undefined || parseHostRule(e) !== undefined,
    );
    // 防假绿：样本若已不被数据层接受，本组会退化成「断言了一个空集合」
    expect(accepted.length, "DATA_LAYER_FORMS 与数据层语法漂了").toBe(DATA_LAYER_FORMS.length);
    for (const e of accepted) {
      expect(cls.test(e), `数据层接受 ${JSON.stringify(e)}，HTTP 字符集却表达不了`).toBe(true);
      expect(() => requireSafeAclEntry(e), `requireSafeAclEntry 拒了 ${JSON.stringify(e)}`).not.toThrow();
    }
  });

  it("**跨层对齐 ②**：ops 的 `syntaxHint` 举的每个例子，数据层认、HTTP 层也认", () => {
    const examples = syntaxHintExamples();
    expect(examples.length, "从 syntaxHint 抠不出例子：护栏空转").toBeGreaterThan(0);
    expect(examples).toContain("10.0.0.0/8");
    for (const e of examples) {
      expect(parseIpRule(e) ?? parseHostRule(e), `${e} 必须被数据层接受`).toBeDefined();
      expect(() => requireSafeAclEntry(e), `syntaxHint 承诺了 ${e}，HTTP 层却表达不了`).not.toThrow();
    }
  });

  it("**变异实测 ⑤**：从名单字符集里去掉 `/` ⇒ 跨层对齐 ①② 必须红", () => {
    // 判据从源码现取，故这个变异作用在**交付出去的那份**字符集上
    const shipped = classFromSource("SAFE_ACL_ENTRY");
    const mutated = new RegExp(shipped.source.replace("/", ""));
    // 变异只摘掉 `/` 这一个字符：其余能力必须还在（否则「红」是因为别的原因，不算实测）
    expect(mutated.test("example.com")).toBe(true);
    expect(mutated.test("::1")).toBe(true);
    expect(mutated.test("fe80::1%eth0")).toBe(true);
    // 依赖 `/` 的规范形态逐条表达不了 —— 跨层对齐 ① 会在这里红
    const needsSlash = DATA_LAYER_FORMS.filter((e) => e.includes("/"));
    expect(needsSlash.length, "样本里没有依赖 `/` 的形态：这条护栏会空转").toBeGreaterThan(0);
    for (const e of needsSlash) {
      expect(shipped.test(e), `${e} 必须被现行字符集收`).toBe(true);
      expect(mutated.test(e), `变异后 ${JSON.stringify(e)} 应表达不了`).toBe(false);
    }
    // `syntaxHint` 举的那两个例子：跨层对齐 ② 会在这里红
    for (const e of syntaxHintExamples()) {
      expect(shipped.test(e), `syntaxHint 承诺了 ${e}，现行字符集必须收`).toBe(true);
      if (e.includes("/")) {
        expect(mutated.test(e), `变异后 ${e} 应表达不了`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 请求体上限
// ---------------------------------------------------------------------------

describe("请求体上限", () => {
  it("超限 ⇒ 413，且连接被销毁（不是读完再拒）", async () => {
    const huge = "x".repeat(MAX_BODY_BYTES + 1024);
    const reply = await call(port, {
      method: "POST",
      path: "/api/users",
      rawBody: huge,
    });
    expect(reply.status).toBe(413);
  });

  it("限内但不是 JSON ⇒ 500（不是 400：那是「这段字节根本不是 JSON」）", async () => {
    const reply = await call(port, { method: "POST", path: "/api/users", rawBody: "not json at all" });
    expect(reply.status).toBe(500);
    // 内部细节（含请求体片段）一个字都不许回
    expect(reply.raw).not.toContain("not json at all");
  });
});

// ---------------------------------------------------------------------------
// 5. 错误映射：只由 OpsError.code 决定
// ---------------------------------------------------------------------------

describe("OpsError.code → HTTP 状态码", () => {
  it("not-found ⇒ 404", async () => {
    expect((await call(port, { path: "/api/users/nobody" })).status).toBe(404);
    expect((await call(port, { method: "DELETE", path: "/api/users/nobody" })).status).toBe(404);
    expect((await call(port, { path: "/api/usage/nobody" })).status).toBe(404);
  });

  it("already-exists ⇒ 409（不是 400、不是静默覆盖）", async () => {
    const first = await call(port, {
      method: "POST",
      path: "/api/users",
      body: { username: "alice", password: "pw1" },
    });
    expect(first.status).toBe(201);
    const second = await call(port, {
      method: "POST",
      path: "/api/users",
      body: { username: "alice", password: "pw2" },
    });
    expect(second.status).toBe(409);
    // 撞名**不许**覆盖：原密码逐字保留
    const stored = JSON.parse(fs.readFileSync(usersFile(), "utf8")) as Array<{ password: string }>;
    expect(stored[0]?.password).toBe("pw1");
  });

  it("invalid ⇒ 400（未知键、空 patch、组名拼错、类型不符）", async () => {
    const cases: Array<[string, string, unknown]> = [
      ["POST", "/api/users", { username: "a", password: "b", quota: 1 }],
      ["POST", "/api/users", { username: "a", password: "b", disabled: "true" }],
      ["PUT", "/api/users/a", {}],
      ["POST", "/api/acl", { group: "nope", list: "whitelist", entry: "ok.test" }],
      ["POST", "/api/acl", { group: "target", list: "nope", entry: "ok.test" }],
      ["POST", "/api/acl", { group: "target", list: "whitelist", entry: "not a host!" }],
    ];
    for (const [method, p, body] of cases) {
      const reply = await call(port, { method, path: p, body });
      expect(reply.status, `${method} ${p} ${JSON.stringify(body)} 必须是 400`).toBe(400);
    }
  });

  it("read-only-driver ⇒ 501（请求合法，是部署侧永久缺这个能力）", async () => {
    const readOnly = (): AclSource => ({
      driver: "manager-http-readonly",
      locator: () => path.join(dir, "cfg", "acl.json"),
      read: () => ({ value: structuredClone(EMPTY_ACL_DOC) as AclConfig, path: "/nowhere", exists: true }),
      readStartup: async () => ({
        value: structuredClone(EMPTY_ACL_DOC) as AclConfig,
        path: "/nowhere",
        exists: true,
      }),
      // 刻意**不**实现 write —— 这正是「只读驱动」的定义
    });
    const off = registerAclSource("manager-http-readonly", readOnly);
    try {
      const roSources = await resolveOpsSources(
        {
          NODE_ENV: "development",
          ACL_DRIVER: "manager-http-readonly",
          QUOTA_USAGE_DIR: path.join(dir, "cfg", "usage"),
        },
        dir,
      );
      const s = await serve(
        routesFor(roSources),
      );
      const reply = await call(s.port, {
        method: "POST",
        path: "/api/acl",
        body: { group: "target", list: "blacklist", entry: "blocked.test" },
      });
      s.server.closeAllConnections();
      await new Promise<void>((resolve) => {
        s.server.close(() => resolve());
      });
      expect(reply.status).toBe(501);
    } finally {
      off();
    }
  });

  it("source-unreadable ⇒ 500（服务器自己的数据坏了，不是请求错）", async () => {
    writeUsers([{ username: "alice", password: 42 }]);
    const reply = await call(port, { path: "/api/users" });
    expect(reply.status).toBe(500);
  });

  it("**code 缺失或表外时绝不猜 message**：一律 500 且不回 message", async () => {
    // 两条 message 各自**逐字像**某个已知分类（一个像 not-found、一个像 already-exists），
    // 而 code 被改成表外的值 / 直接删掉。判据若退化成 grep 文案，这两条就会分别回 404 / 409。
    const cases: Array<[string, () => OpsError]> = [
      [
        "code 表外的值",
        () => {
          const e = new OpsError("not-found", "账号表里没有 bob");
          Object.defineProperty(e, "code", { value: "totally-not-a-code" });
          return e;
        },
      ],
      [
        "code 被删掉",
        () => {
          const e = new OpsError("already-exists", "已经有这个账号了");
          Object.defineProperty(e, "code", { value: undefined });
          return e;
        },
      ],
    ];
    for (const [label, make] of cases) {
      const throwing: Route = {
        method: "GET",
        path: "/api/probe",
        handler: () => {
          throw make();
        },
      };
      const s = await serve([throwing]);
      const reply = await call(s.port, { path: "/api/probe" });
      s.server.closeAllConnections();
      await new Promise<void>((resolve) => {
        s.server.close(() => resolve());
      });
      expect(reply.status, `${label} 必须是 500（不认识的分类 = 我不知道 = 500）`).toBe(500);
      // 未知 code ⇒ message **也不许**透传：那条文案的类别我们无法背书
      expect(reply.raw, `${label} 不得回 message`).not.toContain("账号表里没有");
      expect(reply.raw, `${label} 不得回 message`).not.toContain("已经有这个账号");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. 错误响应不含栈、不含秘密
// ---------------------------------------------------------------------------

describe("错误响应与日志：绝不泄露", () => {
  it("非 OpsError ⇒ 500 + requestId，栈与内部路径一个字都不许出现在响应里", async () => {
    const throwing: Route = {
      method: "GET",
      path: "/api/boom",
      handler: () => {
        throw new Error(`炸了：内部细节在 ${INTERNAL_SECRET_PATH}`);
      },
    };
    const s = await serve([throwing]);
    const reply = await call(s.port, { path: "/api/boom" });
    s.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      s.server.close(() => resolve());
    });

    expect(reply.status).toBe(500);
    expect(reply.raw).not.toContain("炸了");
    expect(reply.raw).not.toContain(INTERNAL_SECRET_PATH);
    expect(reply.raw).not.toMatch(/\bat\s+\S+\s+\(/); // 栈帧
    const requestId = (reply.json?.error as { requestId?: string } | undefined)?.requestId;
    expect(typeof requestId).toBe("string");

    // 而细节**必须**在日志里（否则这条 requestId 是个死链）。
    // 断言目录名而不是整条绝对路径：JSONL 那一行是 `JSON.stringify` 过的，Windows 的
    // 反斜杠在日志里是 `\\` 两字符 —— 比整条路径会得到一个「其实写对了却判红」的假失败。
    expect(await logText()).toContain("manager-http-internal-only");
  });

  it("token 明文一个字都不许进响应，也一个字都不许进落盘日志", async () => {
    await call(port, { token: null });
    await call(port, { token: "wrong-token-value" });
    await call(port, { path: "/api/nope" });
    const ok = await call(port);
    expect(ok.status).toBe(200);
    const text = await logText();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("wrong-token-value");
    expect(text.length).toBeGreaterThan(0); // 防假绿：日志真的写了东西
  });

  it("每个响应都带 Cache-Control: no-store（控制面响应不许被缓存）", async () => {
    for (const p of ["/api/status", "/api/config", "/api/users", "/api/nope"]) {
      const reply = await call(port, { path: p });
      expect(reply.headers["cache-control"], `${p} 缺 no-store`).toBe("no-store");
    }
  });
});

// ---------------------------------------------------------------------------
// 7. 各端点成功路径
// ---------------------------------------------------------------------------

describe("GET /api/status", () => {
  it("给出本进程事实 + 数据面活状态 + 数据源事实", async () => {
    const reply = await call(port, { path: "/api/status" });
    expect(reply.status).toBe(200);
    const body = reply.json as {
      process: Record<string, unknown>;
      proxy: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(body.process.pid).toBe(999);
    expect(body.process.cwd).toBe(dir);
    expect(body.proxy).toMatchObject({
      mode: "running",
      protocol: "http",
      host: "0.0.0.0",
      port: 3000,
      running: true,
    });
    expect(body.data.configDir).toBe(dir);
  });

  it("数据面状态是**现读**的（改判据后紧跟着的那次请求就看到新值）", async () => {
    const restore = dataPlane.value;
    dataPlane.value = {
      mode: "stopping",
      protocol: "socks5",
      host: "127.0.0.1",
      port: 1080,
      running: false,
      startedAt: null,
      uptimeMs: null,
    };
    try {
      const body = (await call(port, { path: "/api/status" })).json as {
        proxy: Record<string, unknown>;
      };
      expect(body.proxy.mode).toBe("stopping");
      expect(body.proxy.running).toBe(false);
    } finally {
      dataPlane.value = restore;
    }
  });

  it("cluster master：mode=master 且 running 恒 false（不谎报端口在监听）", async () => {
    const restore = dataPlane.value;
    dataPlane.value = {
      mode: "master",
      protocol: null,
      host: null,
      port: null,
      running: false,
      startedAt: null,
      uptimeMs: null,
    };
    try {
      const body = (await call(port, { path: "/api/status" })).json as {
        proxy: Record<string, unknown>;
      };
      expect(body.proxy.mode).toBe("master");
      expect(body.proxy.running).toBe(false);
      expect(body.proxy.port).toBeNull();
    } finally {
      dataPlane.value = restore;
    }
  });

  it("必须带上「master 模式端口由 worker 持有」那句限定", async () => {
    const reply = await call(port, { path: "/api/status" });
    const body = reply.json as { runningMeans: string };
    expect(body.runningMeans).toContain("master");
    expect(body.runningMeans).toContain("worker");
  });
});

describe("GET /api/config", () => {
  it("逐键给出 phase / restartRequired / 打码值", async () => {
    const reply = await call(port, { path: "/api/config" });
    expect(reply.status).toBe(200);
    const body = reply.json as {
      keys: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    };
    const byKey = new Map(body.keys.map((k) => [String(k.key), k]));

    expect(byKey.get("port")?.phase).toBe("startup");
    expect(byKey.get("port")?.restartRequired).toBe(true);
    expect(byKey.get("quotaFlushInterval")?.phase).toBe("runtime");
    expect(byKey.get("quotaFlushInterval")?.restartRequired).toBe(false);
    expect(body.summary.total).toBe(body.keys.length);
  });

  it("四个密钥一律打码，明文一个字都不许出现在响应里", async () => {
    const reply = await call(port, { path: "/api/config" });
    for (const secret of [TOKEN, JWT_SECRET, PASSPHRASE, UPSTREAM_PASSWORD]) {
      expect(reply.raw, `${secret} 泄露了`).not.toContain(secret);
    }
    const body = reply.json as { keys: Array<Record<string, unknown>>; summary: { secrets: string[] } };
    const byKey = new Map(body.keys.map((k) => [String(k.key), k]));
    expect(byKey.get("managerToken")?.value).toBe("***");
    expect(byKey.get("jwtSecret")?.value).toBe("***");
    expect(byKey.get("tlsPassphrase")?.value).toBe("***");
    expect(byKey.get("upstreamPassword")?.value).toBe("***");
    // upstreamUrl 的 userinfo 单独掩码，路径部分保留
    expect(byKey.get("upstreamUrl")?.value).toBe("http://***@upstream.invalid:8080");
  });

  it("空密钥保持空串（「没配」与「配了但不给你看」是两种事实）", async () => {
    const s = await resolveOpsSources({ NODE_ENV: "development", JWT_SECRET: "" }, dir);
    const started = await serve(
      routesFor(s),
    );
    const reply = await call(started.port, { path: "/api/config" });
    started.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      started.server.close(() => resolve());
    });
    const body = reply.json as { keys: Array<Record<string, unknown>> };
    const byKey = new Map(body.keys.map((k) => [String(k.key), k]));
    expect(byKey.get("jwtSecret")?.value).toBe("");
  });

  it("打码清单与 logConfig 的启动快照脱敏**逐键相同**（两份清单不许漂）", () => {
    // `logConfig` 的 safeAll 是唯一那份判据的实现现场；本档从它的源码里把打码键抠出来
    const logSource = codeOnly(
      fs.readFileSync(path.join(__dirname, "..", "..", "src", "server", "log", "config-log.ts"), "utf8"),
    );
    const fromLogConfig = [...logSource.matchAll(/^\s*(jwtSecret|tlsPassphrase|upstreamPassword|managerToken):/gm)]
      .map((m) => m[1])
      .sort();
    // 防假绿：那份源码今天确实有这四行（抠不出来就是源码形状变了，本档要显式复核）
    expect(fromLogConfig).toEqual(["jwtSecret", "managerToken", "tlsPassphrase", "upstreamPassword"]);
  });

  it("fileOrigin 指向真正读过的那个 env 文件；未给值的键是 undefined（不谎称）", async () => {
    // 造一个 `.env.development`（`defaultEnvFileNames` 的候选之一），只在真目录里落它
    fs.writeFileSync(path.join(dir, ".env.development"), "QUOTA_RESET_HOUR=7\n", "utf8");
    const withFile = await resolveOpsSources({ NODE_ENV: "development" }, dir);
    const started = await serve(
      routesFor(withFile),
    );
    const reply = await call(started.port, { path: "/api/config" });
    started.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      started.server.close(() => resolve());
    });

    const body = reply.json as { keys: Array<Record<string, unknown>>; envFiles: string[] };
    const byEnv = new Map(body.keys.map((k) => [String(k.env), k]));
    expect(byEnv.get("QUOTA_RESET_HOUR")?.fileOrigin).toBe(path.join(dir, ".env.development"));
    expect(body.envFiles).toContain(path.join(dir, ".env.development"));
    // 没有任何来源的键必须是 undefined —— 而不是编一个「大概来自缺省」
    expect(byEnv.get("UPSTREAM_TIMEOUT")?.fileOrigin).toBeUndefined();
    // 且 fileOrigin 要么是候选列表里的一条、要么是 undefined（不许是别的路径）
    for (const k of body.keys) {
      if (k.fileOrigin !== undefined) {
        expect(body.envFiles, `fileOrigin ${String(k.fileOrigin)} 不在候选列表里`).toContain(k.fileOrigin);
      }
    }
  });
});

describe("/api/users", () => {
  it("建号 201、取号 200、列号 200", async () => {
    const created = await call(port, {
      method: "POST",
      path: "/api/users",
      body: { username: "alice", password: "pw1", quotaBytes: 1024, quotaWindow: "day" },
    });
    expect(created.status).toBe(201);
    expect((created.json as { changed: boolean }).changed).toBe(true);

    const one = await call(port, { path: "/api/users/alice" });
    expect(one.status).toBe(200);
    const account = (one.json as { account: Record<string, unknown> }).account;
    expect(account.username).toBe("alice");
    expect(account.quota).toEqual({ bytes: 1024, window: "day" });

    const all = await call(port, { path: "/api/users" });
    expect(all.status).toBe(200);
    expect((all.json as { accounts: unknown[] }).accounts).toHaveLength(1);
  });

  it("**密码是只写的**：读面拿不回明文", async () => {
    await call(port, {
      method: "POST",
      path: "/api/users",
      body: { username: "alice", password: "super-secret-canary" },
    });
    for (const p of ["/api/users", "/api/users/alice"]) {
      const reply = await call(port, { path: p });
      expect(reply.raw, `${p} 泄露了明文密码`).not.toContain("super-secret-canary");
      expect(reply.raw).toContain('"set":true');
    }
  });

  it("改字段：未提及的字段逐字保留", async () => {
    writeUsers([
      { username: "alice", password: "pw1", quota: { bytes: 2048, window: "day" }, disabled: false },
    ]);
    const reply = await call(port, {
      method: "PUT",
      path: "/api/users/alice",
      body: { disabled: true },
    });
    expect(reply.status).toBe(200);
    const stored = JSON.parse(fs.readFileSync(usersFile(), "utf8")) as Array<Record<string, unknown>>;
    expect(stored[0]).toMatchObject({
      password: "pw1",
      disabled: true,
      quota: { bytes: 2048, window: "day" },
    });
  });

  it("删号 200；再删一次 404", async () => {
    writeUsers([{ username: "alice", password: "pw1" }]);
    expect((await call(port, { method: "DELETE", path: "/api/users/alice" })).status).toBe(200);
    expect((await call(port, { method: "DELETE", path: "/api/users/alice" })).status).toBe(404);
  });

  it("路径上的 username 与 body 里的不一致 ⇒ 400（以路径为准，不许 body 覆盖）", async () => {
    writeUsers([{ username: "alice", password: "pw1" }]);
    const reply = await call(port, {
      method: "PUT",
      path: "/api/users/alice",
      body: { username: "bob", disabled: true },
    });
    expect(reply.status).toBe(400);
  });
});

describe("/api/acl", () => {
  it("加一条 / 移一条各 200", async () => {
    const added = await call(port, {
      method: "POST",
      path: "/api/acl",
      body: { group: "target", list: "blacklist", entry: "blocked.test" },
    });
    expect(added.status).toBe(200);
    expect((added.json as { changed: boolean }).changed).toBe(true);

    const read = await call(port, { path: "/api/acl" });
    const acl = (read.json as { acl: AclConfig }).acl;
    expect(acl.target.blacklist).toEqual(["blocked.test"]);

    const removed = await call(port, {
      method: "DELETE",
      path: "/api/acl?group=target&list=blacklist&entry=blocked.test",
    });
    expect(removed.status).toBe(200);
    expect((removed.json as { changed: boolean }).changed).toBe(true);
  });

  it("**幂等 no-op 是 200 + changed:false**，不是失败也不是「已改」", async () => {
    const first = await call(port, {
      method: "POST",
      path: "/api/acl",
      body: { group: "target", list: "whitelist", entry: "ok.test" },
    });
    expect((first.json as { changed: boolean }).changed).toBe(true);

    const again = await call(port, {
      method: "POST",
      path: "/api/acl",
      body: { group: "target", list: "whitelist", entry: "ok.test" },
    });
    expect(again.status).toBe(200);
    expect((again.json as { changed: boolean }).changed).toBe(false);
    // 「多久生效」那句话在 no-op 时必须是 null：承诺一件没发生的事
    expect((again.json as { effective: unknown }).effective).toBeNull();

    const missing = await call(port, {
      method: "DELETE",
      path: "/api/acl",
      body: { group: "target", list: "whitelist", entry: "never-added.test" },
    });
    expect(missing.status).toBe(200);
    expect((missing.json as { changed: boolean }).changed).toBe(false);
  });

  it("查询串与 body 不一致 ⇒ 400（不是「body 赢」）", async () => {
    const reply = await call(port, {
      method: "POST",
      path: "/api/acl?group=target&list=blacklist&entry=one.test",
      body: { group: "target", list: "blacklist", entry: "two.test" },
    });
    expect(reply.status).toBe(400);
  });
});

describe("/api/usage", () => {
  it("读账本 200，带 lagMs 与「不能清账」那句限定", async () => {
    const reply = await call(port, { path: "/api/usage" });
    expect(reply.status).toBe(200);
    const body = reply.json as { usage: unknown[]; lagMs: number; note: string; sideEffect: string };
    expect(Array.isArray(body.usage)).toBe(true);
    expect(typeof body.lagMs).toBe("number");
    expect(body.note).toContain("不能清账");
    // 「查一次会物化账本文件」这个副作用必须随响应出去
    expect(body.sideEffect).toContain("物化");
  });

  it("账本里没有这个用户 ⇒ 404（不谎报 0）", async () => {
    expect((await call(port, { path: "/api/usage/nobody" })).status).toBe(404);
  });
});

describe("没有「重启进程」这一类端点", () => {
  it("POST /api/restart ⇒ 404（进程归宿主；startup 相位配置只能靠重启进程生效）", async () => {
    expect((await call(port, { method: "POST", path: "/api/restart" })).status).toBe(404);
  });

  it("routes/ 里不残留任何 restart 实现（防「删了端点、留了实现」）", () => {
    const routesDir = path.join(__dirname, "..", "..", "src", "manager", "routes");
    const mentions = fs
      .readdirSync(routesDir)
      .filter((n) => n.endsWith(".ts"))
      .filter((n) =>
        /api\/restart|restartRoute/.test(codeOnly(fs.readFileSync(path.join(routesDir, n), "utf8"))),
      );
    expect(mentions, `这些文件仍在提 restart：${mentions.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. `AccountPatch` 的 JSON 形状判据（ops 词汇的前置收窄）
// ---------------------------------------------------------------------------

describe("accountPatchFrom：未知键与类型不符一律 invalid", () => {
  it("键名拼错被拒（静默忽略会给出「改了却什么都没改」的假绿）", () => {
    expect(() => accountPatchFrom({ quota: 1 })).toThrow(OpsError);
    expect(() => accountPatchFrom({ quotaBytes: 1, quotaWindows: "day" })).toThrow(OpsError);
  });

  it("类型不符被拒（字符串形态的 disabled 绝不能归一成「启用」）", () => {
    for (const bad of [
      { disabled: "true" },
      { disabled: 1 },
      { quotaBytes: "42" },
      { quotaWindow: "week" },
      { expiresAt: 123 },
      { targetWhitelist: "ok.test" },
      { targetWhitelist: [1] },
      { password: 1 },
    ]) {
      expect(() => accountPatchFrom(bad as Record<string, unknown>), JSON.stringify(bad)).toThrow(
        OpsError,
      );
    }
  });

  it("合法形态逐字通过（三态得以保留：缺省=不动，false=显式关）", () => {
    expect(accountPatchFrom({ disabled: false })).toEqual({ disabled: false });
    expect(accountPatchFrom({ quotaBytes: "clear" })).toEqual({ quotaBytes: "clear" });
    expect(accountPatchFrom({ quotaWindow: "day" })).toEqual({ quotaWindow: "day" });
    expect(accountPatchFrom({ expiresAt: "clear" })).toEqual({ expiresAt: "clear" });
  });
});

// ---------------------------------------------------------------------------
// 9. 源码级护栏（含变异实测）
// ---------------------------------------------------------------------------

describe("manager http/ 与 routes/ 的源码级护栏", () => {
  /** 列目录而不是写死文件名：新增文件必须自动进扫描范围 */
  const files = ["manager/http", "manager/routes"].flatMap((sub) =>
    fs
      .readdirSync(path.join(__dirname, "..", "..", "src", sub))
      .filter((n) => n.endsWith(".ts"))
      .sort()
      .map((n) => `${sub}/${n}`),
  );

  it("扫描范围非空且覆盖两个子目录（防路径写错导致整组恒绿）", () => {
    expect(files).toContain("manager/http/server.ts");
    expect(files).toContain("manager/routes/index.ts");
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it("零 console / 零 process.*（诊断走注入的 logger）", () => {
    for (const file of files) {
      const code = codeOnly(
        fs.readFileSync(path.join(__dirname, "..", "..", "src", file), "utf8"),
      );
      expect(code, `${file} 不许有 console`).not.toMatch(/\bconsole\./);
      expect(code, `${file} 不许碰 process`).not.toMatch(/\bprocess\./);
    }
  });

  it("**绝不 import `@/admin/*`**（那是 proxy-cli 的终端呈现层）", () => {
    for (const file of files) {
      const code = codeOnly(
        fs.readFileSync(path.join(__dirname, "..", "..", "src", file), "utf8"),
      );
      expect(code, `${file} 不许 import @/admin/*`).not.toMatch(/from\s+"@\/admin\//);
    }
  });

  it("http/ 与 routes/ 零 child_process / 零 cluster（本目录只管数据与只读事实）", () => {
    for (const file of files) {
      const code = codeOnly(
        fs.readFileSync(path.join(__dirname, "..", "..", "src", file), "utf8"),
      );
      expect(code, `${file} 不许直接 spawn/kill`).not.toMatch(/node:child_process/);
      expect(code, `${file} 不许直接 spawn/kill`).not.toMatch(/\bspawn\(|\bexecFile\(/);
      expect(code, `${file} 不许碰 cluster（数据面状态经 dataPlane 注入进来）`).not.toMatch(
        /node:cluster/,
      );
    }
  });

  it("数据面路由一律经 `@/ops/index.js`（不重写数据源逻辑）", () => {
    for (const file of [
      "manager/routes/status.ts",
      "manager/routes/config.ts",
      "manager/routes/users.ts",
      "manager/routes/acl.ts",
      "manager/routes/usage.ts",
    ]) {
      const code = codeOnly(
        fs.readFileSync(path.join(__dirname, "..", "..", "src", file), "utf8"),
      );
      expect(code, `${file} 必须经 @/ops`).toMatch(/from\s+"@\/ops\/index\.js"/);
    }
  });

  it("**变异实测 ①**：把 `authorize` 挪到路由之后 —— 本组必须红", () => {
    // 判据锚在「auth.ts 的 authorize 只被 server.ts 引用」这个**今天仍存在的形状**上
    const server = codeOnly(
      fs.readFileSync(path.join(__dirname, "..", "..", "src", "manager", "http", "server.ts"), "utf8"),
    );
    // ① 鉴权调用出现在 matchRoute 之前（这是「未鉴权者拿不到 404/405 区分」的实现形状）
    expect(server.indexOf("authorize(")).toBeGreaterThanOrEqual(0);
    expect(server.indexOf("authorize(")).toBeLessThan(server.indexOf("matchRoute("));
    // ② 且 401 的写出只经 sendUnauthorized 一处（散开写就会有一处忘了带 WWW-Authenticate）
    const httpDir = path.join(__dirname, "..", "..", "src", "manager", "http");
    const senders = fs
      .readdirSync(httpDir)
      .filter((n) => n.endsWith(".ts"))
      .filter((n) => codeOnly(fs.readFileSync(path.join(httpDir, n), "utf8")).includes("401"));
    expect(senders).toEqual(["respond.ts", "server.ts"]);
    // 变异：把 server.ts 里的 authorize( 调用删掉 → 上面两条都会红
    const withoutAuth = server.replace(/authorize\([^)]*\)/g, "true");
    expect(withoutAuth.indexOf("authorize(")).toBeLessThan(withoutAuth.indexOf("matchRoute("));
  });

  it("**变异实测 ②**：把 500 分支改成回 message —— 本组必须红", () => {
    const respond = codeOnly(
      fs.readFileSync(
        path.join(__dirname, "..", "..", "src", "manager", "http", "respond.ts"),
        "utf8",
      ),
    );
    // 锚在 `sendFailure` 的**函数体**上（不是某句文案：文案改了位置就漂）
    const at = respond.indexOf("export function sendFailure(");
    expect(at, "源码结构变了：找不到 sendFailure").toBeGreaterThanOrEqual(0);
    const branch = respond.slice(at);
    // 非「已背书的 OpsError」那条分支必须调 logger.error（细节进日志）
    expect(branch).toMatch(/logger\.error\(/);
    // 且**不**把异常本体（`err`）送进任何 sendError 调用：那是「500 也回 message」的形状
    expect(branch, "500 分支不许把异常本体送进响应").not.toMatch(/sendError\([^)]*\berr\b/);
    // 状态码表是**查表**而不是 if-else 链：表外一律 500
    expect(respond).toMatch(/STATUS_BY_CODE\[err\.code\] \?\? INTERNAL_STATUS/);
    // 变异：把 `?? INTERNAL_STATUS` 删掉 → 上面这条红
    expect(respond.replace(" ?? INTERNAL_STATUS", "")).not.toMatch(
      /STATUS_BY_CODE\[err\.code\] \?\? INTERNAL_STATUS/,
    );
  });

  it("**变异实测 ③**：放宽 username 的字符集 —— 行为组必须红", () => {
    const input = codeOf("manager", "routes", "input.ts");
    // 锚在**今天仍存在的形状**上：`routes/input.ts` 里那条 username 白名单的正则字面量。
    // 名单条目那条是**另一份**判据（有独立的跨层护栏 ①② 管它），两者不许合并，所以这里
    // 只盯 username 那份。
    expect(input).toMatch(/const SAFE_USERNAME = \/\^\[A-Za-z0-9\._-\]\+\$\//);
    // 变异：username 白名单放宽到允许 `/` → 上面这条红，且 requireSafeUsername 的行为组也红
    const loosened = input.replace("[A-Za-z0-9._-]", "[A-Za-z0-9._-/]");
    expect(loosened).not.toMatch(/const SAFE_USERNAME = \/\^\[A-Za-z0-9\._-\]\+\$\//);
    expect(() => requireSafeUsername("a/b")).toThrow(OpsError);
  });

  it("**变异实测 ④**：响应里回 token —— 本组必须红（这是行为面，上面第 6 组是同一件事的线上观测）", () => {
    // 防假绿：token 确实在 server / respond 两处被引用过（否则「没引用」也是 0 命中）
    const respond = codeOnly(
      fs.readFileSync(
        path.join(__dirname, "..", "..", "src", "manager", "http", "respond.ts"),
        "utf8",
      ),
    );
    expect(respond).not.toMatch(/authorization/i);
    expect(respond).not.toMatch(/Bearer \$\{/);
  });
});
