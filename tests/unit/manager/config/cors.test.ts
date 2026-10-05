/**
 * 跨源白名单 `MANAGER_CORS_ORIGINS` 的**启动期**语法判据：非法即启动中止（判据不看 enabled）
 *
 * @description
 * 锁的是「不 fail-fast 的代价」：一个永不命中的白名单与「没配」在浏览器那侧的**症状完全一样**
 * （一句 `CORS policy`），运维没有任何线索指向那个环境变量。目录级不变量（fail-closed 由配置层
 * 自己保证、报错必须逐字给修法、正向对照组）归 `./AGENTS.md`，不复制进本文件。
 *
 * ⚠️ 判据**只有这一份**，在 `src/config/schema/validate.ts`（`CORS_ORIGINS_SHAPE`）；运行期的
 * `parseCorsPolicy` 不重复语法校验——它天然 fail-closed（见 `../http/cors.test.ts` 那条
 * 「白名单里是一条垃圾串时天然 fail-closed」）。
 */

import { describe, expect, it } from "vitest";
import { assertManagerConfig } from "@/config/schema/index.js";
import { TOKEN, load, rejectionMessage, withTmpDir } from "./_manager-config.js";

describe("MANAGER_CORS_ORIGINS：语法非法即启动期 abort（判据不看 enabled）", () => {
  /** 通过校验的基准组合（端口错开、token 非空） */
  const ok = {
    port: 3000,
    managerEnabled: true,
    managerPort: 3010,
    managerToken: TOKEN,
  };

  it("逐条非法形态全部 abort，且报错逐字点名那个键", () => {
    const bad = [
      "*",                                  // 通配：等于对任意网页开放
      "null",                               // file:// 与 sandbox iframe 的 origin
      "http://a.com/",                      // 尾斜杠：URL 规范化会去掉它，于是永不命中
      "http://a.com/panel",                 // 带路径：origin 压根没有路径这一段
      "http://u:pw@a.com",                  // 带凭据
      "file:///srv/gui/index.html",          // 本地文件
      "ws://a.com",                         // 非 http(s) scheme
      "http://a.com:99999",                 // 端口越界
      "http://a.com:0",                     // 端口 0 不是 origin 的合法端口
      "http://a.com:08080",                 // 前导零：URL 规范化成 8080，于是永不命中
      "http://a.example,http://b.example/", // 列表里混进一条非法的
      "a.com",                              // 缺 scheme
      "://a.com",
    ];
    for (const value of bad) {
      expect(
        () => assertManagerConfig({ ...ok, managerCorsOrigins: value }),
        `MANAGER_CORS_ORIGINS=${JSON.stringify(value)} 应当 abort`,
      ).toThrow(/MANAGER_CORS_ORIGINS/);
    }
  });

  it("⚠️ 判据**不看** `managerEnabled`（藏着它 = 开关打开那天才炸，运维会归因成「我今天开了个开关」）", () => {
    expect(() =>
      assertManagerConfig({ ...ok, managerEnabled: false, managerCorsOrigins: "*" }),
    ).toThrow(/MANAGER_CORS_ORIGINS/);
  });

  it("合法形态放行：空 / 单条 / 多条 / 逗号周围带空白 / 大小写混写 / IPv6 / 端口边界", () => {
    const good = [
      "",                                    // 缺省 = 不放行（合法）
      "   ",
      "http://127.0.0.1:5173",
      "https://ops.example.com",
      "http://a.com:1",                     // 端口下界
      "http://a.com:65535",                 // 端口上界
      "http://a.com,https://b.com",
      " http://a.com , https://b.com ",     // 空白容忍（startup 与运行期各切一次、trim 一次）
      "HTTP://A.Example",                   // origin 没有大小写敏感的成分（RFC 6454）
      "http://[::1]:5173",                  // IPv6 字面量
    ];
    for (const value of good) {
      expect(
        () => assertManagerConfig({ ...ok, managerCorsOrigins: value }),
        `MANAGER_CORS_ORIGINS=${JSON.stringify(value)} 应当放行`,
      ).not.toThrow();
    }
  });

  it("报错逐字给出修法与一条可抄的示例（「不能为空/不合法」等于让运维猜）", async () => {
    await withTmpDir(async (cwd) => {
      const message = await rejectionMessage(
        load(cwd, { env: { MANAGER_CORS_ORIGINS: "*" } }),
      );
      expect(message).toContain("MANAGER_CORS_ORIGINS");
      expect(message).toContain("MANAGER_CORS_ORIGINS=http://127.0.0.1:5173,https://ops.example.com");
      // 三条最容易被踩的形态各自点名（不是一句「格式不对」）
      expect(message).toContain("*");
      expect(message).toContain("null");
      expect(message).toContain("http://a.com/");
    });
  });

  it("通过 loadConfig 时合法值逐字落到 store（运行期拿到的就是运维写的那串）", async () => {
    await withTmpDir(async (cwd) => {
      const { store } = await load(cwd, {
        env: { MANAGER_CORS_ORIGINS: "http://127.0.0.1:5173, https://ops.example.com" },
      });
      expect(store.get("managerCorsOrigins")).toBe("http://127.0.0.1:5173, https://ops.example.com");
    });
  });
});