/**
 * 接线面：台账 → 请求参数 → 探活（三档判别 + 「非 `TuiError` 照旧上抛」）
 * @description
 * ⚠️ `targetOf` 的存在理由是**类型**而不是行为：`Target` 已经是 `{baseUrl, token, timeoutMs}`，
 * 而端点函数吃的就是那三格 ⇒ 这一步是**原样透传**。真正有牙齿的是**探活那一圈**。
 *
 * `probeTarget` 的契约是**三档判别原样交出去、由界面决定怎么显示**（transport / wire / shape），
 * 而**不** re-throw；唯一的例外是**非 `TuiError` 的异常照旧往上抛** —— 那是本包的 bug，
 * 不该伪装成网络失败。
 *
 * ⚠️ 这一档**完全不碰真网络**：传输由 `axios.defaults.adapter` 那一格替身接管
 * （端点函数自己 axios，而 axios 的 Node adapter 是全局那一格）。
 * 请求头与请求行的真形归 `tests/client/` 那些对着**真 `http.Server`** 的档。
 *
 * 目录级不变量见 `AGENTS.md`。
 *
 * @module tests/ledger/client
 */

import { afterEach, describe, expect, it } from "vitest";
import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from "axios";

import { probeTarget, targetOf } from "@/services/config/index.js";
import type { ManagerTarget } from "@/api/index.js";
import { firstTarget } from "./_shared.js";

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

/** 连接层失败：抛一个带 axios `code` 的错（超时/连不上的判据读的是 `code` 而不是 message） */
type Transport = { readonly code: string; readonly message: string };

/** 一台对着替身传输的控制面（台账那一份 `firstTarget` 的三格逐字沿用） */
const THROUGH = (): ManagerTarget => targetOf(firstTarget());

/** 让传输**恒定**回一份响应（`probeTarget` 三档里前两档都靠它造） */
function answering(status: number, data: unknown): () => void {
  return swap(async (config) => ({ status, statusText: String(status), data, headers: {}, config }));
}

/** 让传输**抛**一个连接层的错 */
function failing(fault: Transport): () => void {
  return swap(() => Promise.reject(Object.assign(new Error(fault.message), { code: fault.code })));
}

/**
 * 换掉 axios 的适配器，返回一个还原函数
 * @description ⚠️ **必须原样还回 `original` 而不是 `delete`**：`axios.defaults.adapter` 的缺省值
 * 是 `["xhr","http","fetch"]` 那个**数组**，删掉它会让下一个请求抛 `Unknown adapter 'undefined'`。
 */
function swap(
  adapter: (config: InternalAxiosRequestConfig) => Promise<AxiosResponse>,
): () => void {
  const original = axios.defaults.adapter;
  axios.defaults.adapter = adapter;
  return (): void => {
    axios.defaults.adapter = original;
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("台账 → 请求参数", () => {
  it("targetOf **原样透传**那三格（端点函数吃的就是它，故这一层没有第二次转换）", () => {
    const one = firstTarget();
    expect(targetOf(one)).toEqual({
      baseUrl: one.baseUrl,
      token: one.token,
      timeoutMs: one.timeoutMs,
    });
  });
});

describe("probeTarget：三档判别原样交出去、不 re-throw", () => {
  it("连上了 ⇒ ok:true 带状态", async () => {
    restore = answering(200, STATUS_BODY);
    const result = await probeTarget(THROUGH());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status.data.configDir).toBe("/srv/cfg");
  });

  it("连不上 ⇒ ok:false 带 TuiError，**不**抛", async () => {
    restore = failing({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:3010" });
    const result = await probeTarget(THROUGH());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("transport");
      expect(result.error.code).toBe("unreachable");
    }
  });

  it("401 也只是 ok:false（三档判别原样交出去，由界面决定怎么显示）", async () => {
    restore = answering(401, {
      error: { code: "unauthorized", message: "凭据不对", requestId: "req-1" },
    });
    const result = await probeTarget(THROUGH());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("wire");
      expect(result.error.code).toBe("unauthorized");
      expect(result.error.requestId).toBe("req-1");
    }
  });

  it("答了但形状不对 ⇒ ok:false 的 shape 档（对面版本与本包不一致）", async () => {
    restore = answering(200, { 不像: "status" });
    const result = await probeTarget(THROUGH());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("shape");
  });

  it("非 TuiError 的异常**照旧往上抛**（那是本包的 bug，不该伪装成网络失败）", async () => {
    // ⚠️ 正向对照：上面四档之所以成立，是因为**上一层真的把 TuiError 收成了 ok:false** ——
    // 一个「一律 catch 成 TuiError」的实现会让这一条照样绿，而界面就再也分不出「本包坏了」。
    //
    // ⚠️ 触发它靠一个**会在归一那一步炸掉**的 `baseUrl`：端点函数自己 axios，而请求出门前要过一次
    // `normalizeBaseUrl` —— 那一步读 `raw.trim()`，读到一半抛出来的是本包调用方自己的 `RangeError`，
    // **不是** `TuiError`，故它**不该**被装成「连不上那一台」。今天控制面那一侧的每一种真失败
    // （传输 / wire / shape）都被翻译成了 `TuiError`，所以「非 TuiError」只剩「本包自己崩了」这一种 ——
    // 而那恰恰是最该原样冒出去的那一种。
    const exploding = new Proxy(
      {},
      {
        get(): never {
          throw new RangeError("本包调用方自己的 bug");
        },
      },
    ) as unknown as string;
    await expect(probeTarget({ baseUrl: exploding, token: "t", timeoutMs: 1000 })).rejects.toThrowError(
      RangeError,
    );
  });
});