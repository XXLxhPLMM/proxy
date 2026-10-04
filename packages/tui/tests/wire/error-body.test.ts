/**
 * 失败码闭合集与错误体的宽松读法
 *
 * @description
 * `WIRE_CODES` 与 `WireCode` 联合**双向**锁死（编译期与运行期各一道牙），以及 `readErrorBody` 对错误体
 * 的**宽松**读法：认得出的 code 原样透传，认不出的降级成 `internal` 而**保留** `message` 与
 * `requestId`。
 *
 * 共享的不变量（事故单、判据取舍、防假绿的位置）在 `./AGENTS.md`，不复制进本文件。
 *
 * @module tests/wire
 */

import { describe, expect, it } from "vitest";
import { WIRE_CODES, readErrorBody, type WireCode } from "@/api/index.js";
/* ── 失败码闭合集 ────────────────────────────────────────────────────────── */

/** 与服务端两处互为镜像的那九档（ops 五档 + 传输层四档） */
const WIRE_CODE_TABLE = [
  "not-found",
  "already-exists",
  "invalid",
  "read-only-driver",
  "source-unreadable",
  "internal",
  "unauthorized",
  "method-not-allowed",
  "bad-request",
] as const;

/**
 * 「表与联合**双向**相等」的类型断言
 * @description 两个 `Exclude` 都为空集才成立；任一侧多一档，另一侧那一支就不是 `never`，
 * 于是 `const` 的类型不成立 → `tsc` 红。
 */
type UnionMatchesTable<Table extends readonly string[], Union extends string> = [
  Exclude<Table[number], Union>,
] extends [never]
  ? [Exclude<Union, Table[number]>] extends [never]
    ? true
    : never
  : never;

/** 编译期牙齿（被下面那条用例引用，否则 eslint 会把判据判死 —— 判据被判死等于没有判据） */
const WIRE_CODES_MATCH_TYPE: UnionMatchesTable<typeof WIRE_CODE_TABLE, WireCode> = true;

describe("失败码闭合集：`WIRE_CODES` 与 `WireCode` 双向锁死", () => {
  it("恰好 9 档（ops 五档 + 传输层四档）", () => {
    expect(WIRE_CODES.size).toBe(9);
  });

  it("运行期集合与本档抄的那张表逐个相等（不多不少不少重复）", () => {
    expect([...WIRE_CODES].sort()).toEqual([...WIRE_CODE_TABLE].sort());
  });

  it("编译期：`WireCode` 联合与那张表**双向**相等（改了一边没改另一边，`tsc` 红）", () => {
    // `WIRE_CODES_MATCH_TYPE` 的类型就是那条双向断言；它为 `never` 时这一行编译不过
    expect(WIRE_CODES_MATCH_TYPE).toBe(true);
    // 防假绿：集合为空时上面两条仍在跑，这里要求它真的能逐档透传
    expect(WIRE_CODES.has("not-found")).toBe(true);
    expect(WIRE_CODES.has("brand-new-code")).toBe(false);
  });

  it("九个码逐个被 `readErrorBody` **原样**透传（表与行为不许脱节）", () => {
    for (const code of WIRE_CODES) {
      const read = readErrorBody({ error: { code, message: "中性事实陈述", requestId: "r-1" } });
      expect(read?.code, `${code} 被降级了`).toBe(code);
    }
  });
});

describe("readErrorBody：错误体的宽松读法", () => {
  it("表内 code：code / message / requestId 三个字段逐字透传", () => {
    const read = readErrorBody({
      error: { code: "not-found", message: "账号表里没有 bob", requestId: "r-9" },
    });
    expect(read).toEqual({
      code: "not-found",
      message: "账号表里没有 bob",
      requestId: "r-9",
    });
  });

  it("**表外 code 降级成 `internal`，而 `message` 与 `requestId` 都保留**", () => {
    // 降级的是「分类」不是「信息」：那句中性事实陈述是服务端为它的语义写的，原样丢掉等于
    // 让操作者拿到的信息严格变少；而 requestId 是唯一还能接上服务端日志的线索
    const read = readErrorBody({
      error: { code: "brand-new-code", message: "quotaBytes 只能是非负整数", requestId: "r-7" },
    });
    expect(read).toEqual({
      code: "internal",
      message: "quotaBytes 只能是非负整数",
      requestId: "r-7",
    });
  });

  it("`code` 整个缺失时同样降级成 `internal`（缺省不许当成某个已知分类）", () => {
    expect(readErrorBody({ error: { message: "某句话", requestId: "r-2" } })).toEqual({
      code: "internal",
      message: "某句话",
      requestId: "r-2",
    });
  });

  it("`requestId` 缺失 ⇒ `null`（而不是 `undefined`：界面读的是一个有值的东西）", () => {
    expect(readErrorBody({ error: { code: "invalid", message: "x" } })?.requestId).toBeNull();
    expect(readErrorBody({ error: { code: "invalid", message: "x" } })?.code).toBe("invalid");
  });

  it("`message` 不是字符串 ⇒ 整个 body 读不出来（返回 `null`，交给调用方降级）", () => {
    // message 是人读的那一句，缺了它剩下的 code 与 requestId 没有呈现价值：
    // 只回一个分类而不说发生了什么，比说「响应体不是它自己的错误格式」更让人困惑
    for (const message of [undefined, null, 42, {}, [], ["x"]]) {
      expect(readErrorBody({ error: { code: "invalid", message } })).toBeNull();
    }
  });

  it("顶层没有 `error` ⇒ `null`", () => {
    for (const body of [{}, { errors: [] }, { error: undefined }, { error: null }]) {
      expect(readErrorBody(body)).toBeNull();
    }
  });

  it("`error` 不是对象 ⇒ `null`（数组与标量都不算）", () => {
    for (const error of ["boom", 42, true, [], [{ code: "invalid", message: "x" }]]) {
      expect(readErrorBody({ error })).toBeNull();
    }
  });

  it("整个 body 不是对象 ⇒ `null`", () => {
    for (const body of [null, undefined, "boom", 42, [1, 2], true]) {
      expect(readErrorBody(body)).toBeNull();
    }
  });
});
