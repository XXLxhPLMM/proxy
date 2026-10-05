/**
 * 失败档：一次控制面失败 → 屏上那一句话（逐字、不转述、不带凭据）
 *
 * @description
 * 执行层**只读**控制面（增删改全在弹窗里，而弹窗由状态层直接调读写面）—— 于是本目录的失败
 * 只有三档可判：`TuiError`（对面答了「不」）逐字转述、`TuiError` 的可重试那一档多给一句
 * 「按 r」、**不是** `TuiError` 的异常一个字都不转述。而「值域收窄归解析层」那条搬家的判据
 * 也在这里：解析层拒掉的行压根到不了执行层。
 *
 * 共享的不变量（语义规则与各自的变异、替身纪律、拆档纪律）在 `./AGENTS.md`，不复制进本文件。
 *
 * @module tests/exec
 */

import { describe, expect, it } from "vitest";
import { exec } from "@/lib/exec/run.js";
import { TuiError } from "@/lib/errors.js";
import { commandOf, deps, errsOf, fakeClient, joined, notesOf, statusBody } from "./_shared.js";

describe("一次控制面失败 → 一句人读的判据", () => {
  it("TuiError → 逐字 code + message（带 requestId），且不塞原始异常", async () => {
    const { client } = fakeClient({
      status: async () => {
        throw TuiError.wire({
          code: "unauthorized",
          message: "令牌不对",
          status: 401,
          requestId: "req-42",
          request: "GET /api/status",
        });
      },
    });
    const result = await exec(commandOf("status"), deps({ client }));

    expect(errsOf(result)).toHaveLength(1);
    expect(errsOf(result)[0]).toBe("unauthorized：令牌不对（requestId req-42）");
  });

  it("⚠️ `requestId` 缺省时**不编一个**（编一个比没有更糟：人会去 grep 一条不存在的日志）", async () => {
    const { client } = fakeClient({
      config: async () => {
        throw TuiError.transport({
          code: "unreachable",
          message: "连不上那一台",
          request: "GET /api/config",
        });
      },
    });
    const result = await exec(commandOf("config"), deps({ client }));

    expect(errsOf(result)).toEqual(["unreachable：连不上那一台"]);
  });

  it("可重试的失败（timeout）多给一句「按 r」", async () => {
    const { client } = fakeClient({
      usage: async () => {
        throw TuiError.transport({
          code: "timeout",
          message: "请求超时（5000ms）",
          request: "GET /api/usage",
        });
      },
    });
    const result = await exec(commandOf("usage"), deps({ client }));

    expect(errsOf(result)[0]).toContain("timeout");
    expect(notesOf(result)).toContain("可重试：按 r 再来一次");
  });

  it("⚠️ 非 TuiError 的异常一个字都不转述（那个 message 可能带得出下层的字节）", async () => {
    const { client } = fakeClient({
      status: async () => {
        throw new Error("token=s3cret 挂在某个下层");
      },
    });
    const result = await exec(commandOf("status"), deps({ client }));

    expect(joined(result)).not.toContain("s3cret");
    expect(errsOf(result)).toHaveLength(1);
    expect(errsOf(result)[0]).toContain("未预期");
  });

  it("⚠️ **正向对照**：真的答上了的时候那一档是空（否则上面四条只是「一律失败」）", async () => {
    const { client, calls } = fakeClient({ status: async () => statusBody() });
    const result = await exec(commandOf("status"), deps({ client }));

    expect(calls).toEqual(["status"]);
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