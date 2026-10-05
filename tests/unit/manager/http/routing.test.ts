/**
 * 路由：404 / 405 分开、路径参数防穿越、以及「没有重启端点」这一条负向契约
 *
 * @description
 * 本档盯 `http/router.ts` 与路径参数那一圈：方法与路径段的三态（404 / 405 + `Allow` / 400）、
 * decode 之后才判穿越、以及「控制面没有重启进程这类端点、`routes/` 里也不留任何 restart 残留」。
 * 真 server 起在端口 0 上；共用 fixture 与主题级不变量见 `./_manager-http.ts` / `./AGENTS.md`。
 * @module tests/unit/manager/http
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OpsError } from "@/ops/index.js";
import { requireSafeUsername } from "@/manager/routes/input.js";
import { SRC_DIR, codeOnly } from "../../../helpers/source-scan.js";
import { call, port, usersFile } from "./_manager-http.js";

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

describe("没有「重启进程」这一类端点", () => {
  it("POST /api/restart ⇒ 404（进程归宿主；startup 相位配置只能靠重启进程生效）", async () => {
    expect((await call(port, { method: "POST", path: "/api/restart" })).status).toBe(404);
  });

  it("routes/ 里不残留任何 restart 实现（防「删了端点、留了实现」）", () => {
    const routesDir = path.join(SRC_DIR, "manager", "routes");
    const mentions = fs
      .readdirSync(routesDir)
      .filter((n) => n.endsWith(".ts"))
      .filter((n) =>
        /api\/restart|restartRoute/.test(codeOnly(fs.readFileSync(path.join(routesDir, n), "utf8"))),
      );
    expect(mentions, `这些文件仍在提 restart：${mentions.join(", ")}`).toEqual([]);
  });
});
