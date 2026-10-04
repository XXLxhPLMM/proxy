/**
 * 叶子那一族：`str` / `num` / `bool` / `oneOf` 与只改 `null`、`undefined` 处理的那两个包装
 *
 * @description
 * 一个值进、一个值出，且**不递归**：它们是 `@/lib/decode` 的叶子，容器在 `structure.test.ts`，
 * 跨族的错误文案纪律在 `error-messages.test.ts`。判据与不变量在 `./AGENTS.md`。
 *
 * @module tests/decode
 */

import { describe, expect, it } from "vitest";
import { arr, bool, nullable, num, obj, oneOf, opaque, optional, str } from "@/lib/decode.js";
import { REQ, SECRET, expectShape } from "./_shared.js";

describe("标量收窄", () => {
  it("str：字符串原样通过，其余一律 `shape`", () => {
    expect(str("alice", "p", REQ)).toBe("alice");
    expect(str("", "p", REQ)).toBe("");
    for (const bad of [1, true, null, undefined, {}, [], ["a"], Symbol.iterator]) {
      expectShape(() => str(bad, "p", REQ));
    }
  });

  it("num：有限数字通过（0 与负数都是合法量），`NaN` / `Infinity` 被拒", () => {
    expect(num(0, "p", REQ)).toBe(0);
    expect(num(-1, "p", REQ)).toBe(-1);
    expect(num(1.5, "p", REQ)).toBe(1.5);
    // 非有限数会让下游算术产出 NaN 并一路流到界面；JSON 线上它来不了，但手工构造的替身能来
    for (const bad of [NaN, Infinity, -Infinity, "42", null, undefined, true, {}]) {
      expectShape(() => num(bad, "p", REQ));
    }
  });

  it('bool：只认真布尔；`"true"` / `1` 绝不归一成「启用」', () => {
    expect(bool(false, "p", REQ)).toBe(false);
    expect(bool(true, "p", REQ)).toBe(true);
    for (const bad of ["true", "false", 1, 0, null, undefined, {}]) {
      expectShape(() => bool(bad, "p", REQ));
    }
  });
});

describe("nullable 与 optional 是两件不同的事", () => {
  it("nullable：**只**把 `null` 当空；`undefined` 走内层判据并抛", () => {
    expect(nullable(str)(null, "p", REQ)).toBeNull();
    // 这条最容易被人「顺手」改成两者都接受 —— 那会让「服务端没给这个字段」被当成「给了 null」
    const err = expectShape(() => nullable(str)(undefined, "p", REQ));
    expect(err.message).toContain("p");
  });

  it("nullable：内层判据仍然生效（`null` 通过不代表内层是死的）", () => {
    expectShape(() => nullable(num)("1", "p", REQ));
    expectShape(() => nullable(arr(str))({ length: 0 }, "p", REQ));
    expect(nullable(arr(str))(["a"], "p", REQ)).toEqual(["a"]);
  });

  it("optional：`undefined` → `undefined`；其余值仍要过内层判据", () => {
    expect(optional(str)(undefined, "p", REQ)).toBeUndefined();
    expect(optional(str)("x", "p", REQ)).toBe("x");
    // ⚠️ 「可选」不是「不判」：`"42"` 绝不能因为字段可选就放过
    expectShape(() => optional(num)("42", "p", REQ));
  });

  it("optional：`null` **不**是「缺省」——它必须过内层判据（`optional(str)` 因此抛）", () => {
    // JSON 线上「显式 null」与「键不存在」是两种事实；把它们抹成一种的那个方向就是这条
    expectShape(() => optional(str)(null, "p", REQ));
    expect(nullable(str)(null, "p", REQ)).toBeNull();
  });
});

describe("oneOf", () => {
  const PHASE = oneOf(["startup", "runtime"]);

  it("表内值通过", () => {
    expect(PHASE("startup", "p", REQ)).toBe("startup");
    expect(PHASE("runtime", "p", REQ)).toBe("runtime");
  });

  it("表外值抛（闭合集；服务端加了新相位时本包会显式看到，而不是默默当旧相位渲染）", () => {
    for (const bad of ["Startup", "start", "", "runtim", 1, null, undefined]) {
      expectShape(() => PHASE(bad, "p", REQ));
    }
  });

  it("错误文案点名**全集**（操作者要能一眼看出合法值有哪些）", () => {
    const err = expectShape(() => PHASE("nope", "phase", REQ));
    expect(err.message).toContain("startup / runtime");
  });
});

describe("opaque：刻意透传", () => {
  it("原样返回（含 `undefined`、对象、数组、原始值）", () => {
    const value = { nested: [1, 2, 3] };
    expect(opaque(value, "p", REQ)).toBe(value);
    expect(opaque(undefined, "p", REQ)).toBeUndefined();
    expect(opaque(null, "p", REQ)).toBeNull();
    expect(opaque("s", "p", REQ)).toBe("s");
    expect(opaque(0, "p", REQ)).toBe(0);
  });

  it("透传的**唯一**合法用法是「类型由对面决定」的那个字段（`configKey.value`），故这里不提供逃逸口", () => {
    // 若 `opaque` 变成一个「什么都能过的判据」，全仓每个 `unknown` 都会变成合法值；
    // 判据是**只有一个调用点**（见 `wire.ts:configKeyShape`）这件事，而不是判据本身有多严。
    const anyValue = obj({ value: opaque })({ value: SECRET }, "key", REQ);
    expect(anyValue.value).toBe(SECRET);
  });
});
