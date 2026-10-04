/**
 * `normalizeBaseUrl`：把用户敲的地址收窄成可用的基址
 *
 * @description
 * 地址文本在**出门之前**就被判掉的那一部分 —— 零 IO、零替身、零服务器，故本档不起 `http.Server`
 * （也就没有那对 `beforeEach` / `afterEach`）。
 *
 * - **「敲错地址」不是「网络层失败」**：把它算成 transport 会让界面提示「检查网络与地址」，而操作者敲错的
 *   正是地址文本本身。故地址形状不合法 ⇒ `wire` / `invalid` / `LOCAL_REQUEST`，**不是** transport 档 ——
 *   服务端对同样的坏输入回的**就是** `invalid`（`routes/input.ts`），同一种失败在两端同一个 code，界面只
 *   需要认一个（`error.ts` 的 `TuiError.local` 刻意挂在 `wire` 档 + `invalid` 码上）。
 * - ⚠️ `request` 恒为 `LOCAL_REQUEST` 且 `status` 恒为 `null`：界面上要把「地址敲错了、请求没出门」与
 *   「出了门被 401」显示成两件事，而后者一定有 status 与一个真实路径。本地输入错**不该**被提示重试。
 * - ⚠️ **`http:///x`（协议头后多一个斜杠）必须在 `new URL` 之前按原始文本拒掉**：WHATWG 解析把三个斜杠
 *   消解成「一个斜杠 + 主机分隔符」，`new URL("http:///x").hostname === "x"`（实测），而判
 *   `url.hostname === ""` 那一支对 http/https 不可达。⚠️ 不拦的后果不是「连不上」，而是**连上一台无关的
 *   机器**：用户敲 `http:///api/status` 想连本机，实际会去连一台叫 `api` 的公网主机。
 * - **只保留 origin**：尾路径被丢掉（那不是控制面基址的一部分）；去尾斜杠（否则拼出 `//api/status`，
 *   服务端逐段比对 ⇒ 404）；首尾空白被吃掉（复制粘贴带进来的那个看不见的字符）。
 * - **错误文案里不许含 userinfo**：文案本身含「user:pass」四个字，故凭据刻意不叫 `user` —— 否则
 *   「文案不含凭据」与「文案确实说了这件事」两条判据会互相打架。
 *
 * 目录级不变量在 `AGENTS.md`。
 *
 * @module tests/client/normalize-base-url
 */

import { describe, expect, it } from "vitest";
import { LOCAL_REQUEST, TuiError, isRetryable } from "@/lib/index.js";
import { normalizeBaseUrl } from "@/lib/http.js";
import { caught } from "./_double.js";

describe("normalizeBaseUrl：把用户敲的地址收窄成可用的基址", () => {
  it("去尾斜杠（否则 `/api/status` 拼出 `//api/status`，服务端逐段比对 ⇒ 404）", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:3010/")).toBe("http://127.0.0.1:3010");
  });

  it("**只保留 origin**：尾路径被丢掉（那不是控制面的基址的一部分）", () => {
    expect(normalizeBaseUrl("http://h:3010/api")).toBe("http://h:3010");
    expect(normalizeBaseUrl("https://h/api/status/")).toBe("https://h");
  });

  it("首尾空白被吃掉（复制粘贴带进来的那个看不见的字符）", () => {
    expect(normalizeBaseUrl("  http://127.0.0.1:3010  ")).toBe("http://127.0.0.1:3010");
  });

  it("拒绝空串", () => {
    for (const raw of ["", "   "]) {
      expect(() => normalizeBaseUrl(raw), `${JSON.stringify(raw)} 必须被拒`).toThrow(TuiError);
    }
  });

  it("拒绝不是 URL 的文本", () => {
    for (const raw of ["not a url", "127.0.0.1:3010", "://h", "h:3010"]) {
      expect(() => normalizeBaseUrl(raw), `${JSON.stringify(raw)} 必须被拒`).toThrow(TuiError);
    }
  });

  it("拒绝非 http/https（`file:` / `ws:` 抛的是一句与地址无关的错）", () => {
    for (const raw of ["ftp://h", "ws://h:3010", "file:///etc/passwd"]) {
      const err = (() => {
        try {
          normalizeBaseUrl(raw);
          return null;
        } catch (e) {
          return e as TuiError;
        }
      })();
      expect(err, `${raw} 必须被拒`).toBeInstanceOf(TuiError);
      expect(err?.status).toBeNull(); // 本地判出来的失败没有 HTTP 状态码
    }
  });

  it("拒绝带 userinfo 的地址，且**错误文案里不含那段凭据**", async () => {
    // `fetch` 对带凭据的 URL 直接抛 TypeError，而那句话把密码印在栈里 ——
    // 故要在本地拦下，且拦下时的文案不许把那串 user:pass 重打一遍。
    // 用户名刻意不叫 `user`：错误文案里那句话本身含「user:pass」四个字，
    // 用 `user` 当凭据会让「文案不含凭据」这条判据与「文案确实说了这件事」那条互相打架。
    const err = await caught(async () => normalizeBaseUrl("http://alice:s3cr3t-pass@h:3010"));
    expect(err.message).not.toContain("alice");
    expect(err.message).not.toContain("s3cr3t-pass");
    expect(err.message).not.toContain("alice:s3cr3t-pass");
    expect(err.message).not.toContain("h:3010");
    // 防假绿：文案变成空串也绿 —— 故要求它真的说了「不许带 user:pass」这件事
    expect(err.message).toContain("user:pass");
  });

  it("`http:///x`（协议头后多一个斜杠）⇒ **拒掉**，不静默去连一台叫 `x` 的机器", () => {
    // ⚠️ 这条判据**必须在 `new URL` 之前按原始文本做**：WHATWG 解析把三个斜杠消解成
    // 「一个斜杠 + 主机分隔符」，`new URL("http:///x").hostname === "x"`（实测）。判
    // `url.hostname === ""` 那一支对 http/https 不可达（`http://:3010` / `http://@` /
    // `http://#f` 都在 `new URL()` 那里就抛了）。
    // 不拦的后果不是「连不上」，而是**连上一台无关的机器**：用户敲 `http:///api/status` 想连
    // 本机，实际会去连一台叫 `api` 的公网主机。
    for (const bad of ["http:///x", "http:///api/status", "https:///x", "HTTP:///x"]) {
      let caughtErr: TuiError | null = null;
      try {
        normalizeBaseUrl(bad);
      } catch (e) {
        caughtErr = e as TuiError;
      }
      expect(caughtErr, `${bad} 应当被拒`).toBeInstanceOf(TuiError);
      expect(caughtErr?.message).toContain("主机名");
    }
  });

  it("地址形状不合法 ⇒ `wire` / `invalid` / `LOCAL_REQUEST`（**不是** transport 档）", () => {
    // 「敲错地址」不是「网络层失败」：把它算成 transport 会让界面提示「检查网络与地址」，
    // 而操作者敲错的正是地址文本本身。`error.ts` 的 `TuiError.local` 刻意挂在 `wire` 档 +
    // `invalid` 码上——服务端对同样的坏输入回的**就是** `invalid`（`routes/input.ts`），
    // 同一种失败在两端同一个 code，界面只需要认一个。
    // ⚠️ `request` 恒为 `LOCAL_REQUEST` 且 `status` 恒为 `null`：界面上要把「地址敲错了、
    // 请求没出门」与「出了门被 401」显示成两件事，而后者一定有 status 与一个真实路径。
    for (const bad of ["", "   ", "not a url", "ftp://h:3010", "ws://h:3010", "file:///x"]) {
      const err = (() => {
        try {
          normalizeBaseUrl(bad);
          return null;
        } catch (e) {
          return e as TuiError;
        }
      })();
      expect(err, `${JSON.stringify(bad)} 应当抛 TuiError`).toBeInstanceOf(TuiError);
      expect(err?.kind).toBe("wire");
      expect(err?.code).toBe("invalid");
      expect(err?.status).toBeNull();
      expect(err?.request).toBe(LOCAL_REQUEST);
      // 本地输入错**不该**被提示重试
      expect(isRetryable(err as TuiError)).toBe(false);
    }
  });
});
