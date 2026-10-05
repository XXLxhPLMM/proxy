/**
 * 请求体上限、`OpsError.code` → 状态码的查表、以及错误响应与落盘日志的零泄露
 *
 * @description
 * 本档盯 `respond.ts` 与请求体上限那一圈：状态码**只**由 `code` 决定（表外 / 缺失一律 500 且
 * **不回 message**）、非 `OpsError` 降级成「500 + requestId + 固定文案」而细节只进 logger、
 * 四个密钥与 token 明文一个字都不许出响应或进落盘日志。
 * `logText()` 与内部路径探针只本档用，故住在这里；共用 fixture 见 `./_manager-http.ts`，
 * 主题级不变量见 `./AGENTS.md`。
 * @module tests/unit/manager/http
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerAclSource, type AclConfig, type AclSource } from "@/datasource/acl/index.js";
import { OpsError, resolveOpsSources } from "@/ops/index.js";
import { MAX_BODY_BYTES, type Route } from "@/manager/http/index.js";
import {
  EMPTY_ACL_DOC,
  TOKEN,
  call,
  dir,
  logger,
  port,
  routesFor,
  serve,
  usersFile,
  writeUsers,
} from "./_manager-http.js";

/** 只出现在那条「炸了」的 message 里的内部路径 —— 断言它**一个字都不许**出现在响应里 */
const INTERNAL_SECRET_PATH = path.join(os.tmpdir(), "manager-http-internal-only");

/**
 * 读回落盘的日志原文（**断言的是日志文件里真实写了什么**）
 * @description
 * 日志目录是共用 fixture 的形状（`<dir>/logs`），而 `logger` 由那一档的 `beforeEach` 注入 ——
 * 这条读面只有本档用，故连目录推导一起留在这里，不进共用模块。
 */
async function logText(): Promise<string> {
  await logger.flush();
  const logDir = path.join(dir, "logs");
  const names = fs.readdirSync(logDir).filter((n) => n.endsWith(".jsonl"));
  return (
    await Promise.all(names.map(async (n) => fs.promises.readFile(path.join(logDir, n), "utf8")))
  ).join("");
}

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
