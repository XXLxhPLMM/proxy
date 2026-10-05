/**
 * `GET /api/config` 的相位与打码、`/api/users` / `/api/acl` / `/api/usage` 的成功路径、
 * 以及 `accountPatchFrom` 的 JSON 形状判据
 *
 * @description
 * 本档盯三样：① 逐键的 `phase` / `restartRequired` / 打码值与「哪份 env 文件来的」（三份清单不许漂）；
 * ② 写族的字段保全与**幂等 no-op 是 200 + `changed:false`**；③ ops 词汇的前置收窄 ——
 * 未知键与类型不符一律 invalid，而静默忽略会给出「改了却什么都没改」的假绿。
 * 共用 fixture 与主题级不变量见 `./_manager-http.ts` / `./AGENTS.md`。
 * @module tests/unit/manager/http
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AclConfig } from "@/datasource/acl/index.js";
import { OpsError, resolveOpsSources } from "@/ops/index.js";
import { accountPatchFrom } from "@/manager/routes/patch.js";
import { codeOf } from "../../../helpers/source-scan.js";
import {
  JWT_SECRET,
  PASSPHRASE,
  TOKEN,
  UPSTREAM_PASSWORD,
  call,
  dir,
  port,
  routesFor,
  serve,
  usersFile,
  writeUsers,
} from "./_manager-http.js";

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
    const logSource = codeOf("server", "log", "config-log.ts");
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
