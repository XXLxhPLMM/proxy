/**
 * 接线面：台账 → 客户端 → 探活（三档判别 + 「非 `TuiError` 照旧上抛」）
 * @description
 * ⚠️ `Target` 是**可能被手改 / 内存里直接构造**的，故 `clientFor` 要**再过一次**地址归一 ——
 * 判据只由纯函数那一圈给是不够的。
 *
 * `probeTarget` 的契约是**三档判别原样交出去、由界面决定怎么显示**（transport / wire / shape），
 * 而**不** re-throw；唯一的例外是**非 `TuiError` 的异常照旧往上抛** —— 那是本包的 bug，
 * 不该伪装成网络失败。
 *
 * ⚠️ 这一档**完全不碰真网络**：注入的 `fetch` 替身在文件末尾。
 *
 * 目录级不变量见 `AGENTS.md`。
 *
 * @module tests/ledger
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { clientFor, probeTarget } from "@/services/config/index.js";
import { firstTarget } from "./_shared.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("台账 → 客户端", () => {
  it("clientFor 再过一次地址归一（Target 是可能被手改 / 内存里直接构造的）", () => {
    const client = clientFor({ ...firstTarget(), baseUrl: "http://127.0.0.1:3010/" });
    expect(client.info.baseUrl).toBe("http://127.0.0.1:3010");
    expect(client.info.token).toBe(firstTarget().token);
    expect(client.info.timeoutMs).toBe(firstTarget().timeoutMs);
  });

  it("clientFor 对不可用的地址抛（那是输入 / 台账的错，不是「连不上」）", () => {
    expect(() => clientFor({ ...firstTarget(), baseUrl: "http://u:p@h:1" })).toThrow();
  });

  it("probeTarget：连上了 ⇒ ok:true 带状态", async () => {
    stubFetch({ status: 200, body: STATUS_BODY });
    const result = await probeTarget(clientFor(firstTarget()));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status.data.configDir).toBe("/srv/cfg");
  });

  it("probeTarget：连不上 ⇒ ok:false 带 TuiError，**不**抛", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const result = await probeTarget(clientFor(firstTarget()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("transport");
  });

  it("probeTarget：401 也只是 ok:false（三档判别原样交出去，由界面决定怎么显示）", async () => {
    stubFetch({
      status: 401,
      body: { error: { code: "unauthorized", message: "凭据不对", requestId: "req-1" } },
    });
    const result = await probeTarget(clientFor(firstTarget()));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("wire");
      expect(result.error.code).toBe("unauthorized");
    }
  });

  it("probeTarget：答了但形状不对 ⇒ ok:false 的 shape 档（对面版本与本包不一致）", async () => {
    stubFetch({ status: 200, body: { 不像: "status" } });
    const result = await probeTarget(clientFor(firstTarget()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("shape");
  });

  it("probeTarget：非 TuiError 的异常**照旧往上抛**（那是本包的 bug，不该伪装成网络失败）", async () => {
    const broken = {
      status: async () => {
        throw new RangeError("本包自己的 bug");
      },
    };
    await expect(probeTarget(broken as never)).rejects.toThrowError(RangeError);
  });
});

/* ── 本档的小工具（放在末尾，便于上面读起来像规格） ───────────────────────── */

/** 一份形状正确的 `GET /api/status` 响应（探活成功那档要读到它） */
const STATUS_BODY = {
  process: { pid: 42, startedAt: 0, uptimeMs: 1, node: "node", platform: "linux", cwd: "/srv" },
  proxy: {
    mode: "running",
    protocol: "http",
    host: "0.0.0.0",
    port: 8080,
    running: true,
    startedAt: 0,
    uptimeMs: 1,
  },
  runningMeans: "数据面在监听",
  data: {
    configDir: "/srv/cfg",
    envFiles: ["/srv/.env"],
    accounts: { driver: "json", path: "/srv/cfg/users.json" },
    acl: { driver: "json", path: "/srv/cfg/acl.json" },
    usage: { driver: "json", dir: "/srv/log" },
    auth: { enabled: true, type: "uid" },
    quotaResetHour: 1,
    defaultQuotaWindow: "month",
    flushIntervalMs: 1000,
  },
};

/** 注入一个 `fetch` 替身（探活那几组用它，**不**碰真网络） */
function stubFetch(response: { status: number; body: unknown }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(response.body), { status: response.status })),
  );
}
