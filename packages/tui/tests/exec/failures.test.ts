/**
 * 失败档：一次控制面失败 → 屏上那一句话（逐字、不转述、不带凭据）
 *
 * @description
 * 执行层**只读**控制面（增删改全在弹窗里，而弹窗由状态层直接调读写面）—— 于是本目录的失败
 * 只有三档可判：`TuiError`（对面答了「不」）逐字转述、`TuiError` 的可重试那一档多给一句
 * 「按 r」、**不是** `TuiError` 的异常一个字都不转述。而「值域收窄归解析层」那条搬家的判据
 * 也在这里：解析层拒掉的行压根到不了执行层。
 *
 * ⚠️ **三档是在传输那一格制造的**（`axios.defaults.adapter`），而不是「让替身抛一个 `TuiError`」——
 * 后者在旧的注入点下可行（`request()` 直接抛），而今天端点函数自己 axios ⇒ 一条控制面失败**必然**
 * 先被 `@/api/send.ts` 翻成一档 `TuiError`。于是这一档能造的三种失败都是**真实**成因：
 * 非 2xx（`wire`）、适配器抛 `ECONNABORTED`（`timeout`）、以及**渲染那一层自己崩了**（非 `TuiError`）。
 *
 * 共享的不变量（语义规则与各自的变异、替身纪律、拆档纪律）在 `./AGENTS.md`，不复制进本文件。
 *
 * @module tests/exec
 */

import { afterEach, describe, expect, it } from "vitest";
import axios from "axios";
import { exec } from "@/lib/exec/run.js";
import { commandOf, deps, errsOf, fakeClient, joined, notesOf, statusBody } from "./_shared.js";

/** 一个**真的会拨号**的请求参数（⚠️ 缺省 `deps()` 给的是 `target: null` ⇒ 一个请求都不发，
 *  而本档测的恰恰是「发出去了然后失败」那一半，故三档都得显式递一份） */
const LIVE = { baseUrl: "http://127.0.0.1:3010", token: "tok", timeoutMs: 5000 };

/**
 * 让传输**恒定**回一个状态码 + 那一份响应体
 * @description 造 `wire` 那一档用（对面答了「不」）。⚠️ 必须原样还回 `original` 而不是 `delete`：
 * `axios.defaults.adapter` 的缺省值是 `["xhr","http","fetch"]` 那个**数组**，删掉它会让下一个
 * 请求抛 `Unknown adapter 'undefined'`。
 */
function answering(status: number, data: unknown): () => void {
  const original = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => ({ status, statusText: String(status), data, headers: {}, config });
  return (): void => {
    axios.defaults.adapter = original;
  };
}

/** 本档每个用例自己装、自己拆 */
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("一次控制面失败 → 一句人读的判据", () => {
  it("对面答了「不」→ 逐字 code + message（带 requestId），且不塞原始异常", async () => {
    restore = answering(401, {
      error: { code: "unauthorized", message: "令牌不对", requestId: "req-42" },
    });
    const result = await exec(commandOf("status"), deps({ target: LIVE }));

    expect(errsOf(result)).toHaveLength(1);
    expect(errsOf(result)[0]).toBe("unauthorized：令牌不对（requestId req-42）");
  });

  it("⚠️ `requestId` 缺省时**不编一个**（编一个比没有更糟：人会去 grep 一条不存在的日志）", async () => {
    restore = answering(404, { error: { code: "not-found", message: "没有这个端点" } });
    const result = await exec(commandOf("config"), deps({ target: LIVE }));

    expect(errsOf(result)).toEqual(["not-found：没有这个端点"]);
  });

  it("可重试的失败（timeout）多给一句「按 r」", async () => {
    const original = axios.defaults.adapter;
    axios.defaults.adapter = () =>
      Promise.reject(Object.assign(new Error("timeout of 5000ms exceeded"), { code: "ECONNABORTED" }));
    restore = (): void => {
      axios.defaults.adapter = original;
    };
    const result = await exec(commandOf("usage"), deps({ target: LIVE }));

    expect(errsOf(result)[0]).toContain("timeout");
    expect(notesOf(result)).toContain("可重试：按 r 再来一次");
  });

  it("⚠️ 非 TuiError 的异常一个字都不转述（那个 message 可能带得出下层的字节）", async () => {
    // ⚠️ 这一条现在测的是**渲染那一层自己崩了**：线上给回来一个 `total: -1` 的用量，
    // 而 `bytes()` 对负数抛一个**普通 `Error`** —— 它不是 `TuiError`，故执行层不许转述它。
    // 触发它靠**真数据**而不是「让替身抛一个异常」：后者在旧注入点下能造，今天造不出来了
    // （端点函数自己 axios ⇒ 控制面那一侧的失败必然先被翻成 `TuiError`）。
    const { target } = fakeClient({
      "GET /api/usage": async () => ({
        ...usageLike(),
        usage: [{ user: "alice", windowKey: "2026-10", total: -1 }],
      }),
    });
    const result = await exec(commandOf("usage"), deps({ target }));

    expect(joined(result)).toContain("未预期");
    expect(joined(result)).not.toContain("字节数");
    expect(errsOf(result)).toHaveLength(1);
  });

  it("⚠️ **正向对照**：真的答上了的时候那一档是空（否则上面四条只是「一律失败」）", async () => {
    const { target, calls } = fakeClient({ "GET /api/status": async () => statusBody() });
    const result = await exec(commandOf("status"), deps({ target }));

    expect(calls).toEqual(["GET /api/status"]);
    expect(errsOf(result)).toEqual([]);
    expect(joined(result).length).toBeGreaterThan(20);
  });

  it("⚠️ 值域收窄归**解析层**了：解析层拒掉的行压根到不了执行层", () => {
    // ⚠️ 这一条曾经住在执行层（值域本地拒绝 + 一个请求都不发）。它搬到了
    // `@/commands/parse.js` 的各 reader，理由是「值的域」是**解析**的判据，而执行层那份是**第二份**
    // —— 两份会漂，且漂了的后果是把一个对面早就拒了的输入发出去。故这里断言的是**搬走之后
    // 仍然成立的那一半**：解析层拒掉的行压根到不了执行层（`commandOf` 抛的就是证据）。
    expect(() => commandOf("batch a,,b /status")).toThrow();
  });
});

/** 一份形状正确、值正常的用量（只把 `total` 换成非法的那个，故它自己得是「合法基线」） */
function usageLike(): {
  usage: readonly { user: string; windowKey: string; total: number }[];
  errors: readonly string[];
  lagMs: number;
  sideEffect: string;
  note: string;
} {
  return {
    usage: [{ user: "alice", windowKey: "2026-10", total: 1024 }],
    errors: [],
    lagMs: 0,
    sideEffect: "这次读取会物化账本文件",
    note: "本工具不能清账",
  };
}