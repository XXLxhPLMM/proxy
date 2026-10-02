/**
 * `@/client/decode` — 声明式收窄组合子的真值表
 *
 * @description
 * ## 本档盯的事故
 *
 * 服务端是**另一个进程**（甚至另一台机器），它的响应不经过本包任何一行类型检查。故
 * `unknown` → 声明形状之间必须有一次显式收窄；这一档收窄漏掉的字段会以「界面上某个格子莫名
 * 妙空白」的形态出现，而栈里一个有用的帧都没有。故本档盯三件：
 *
 * 1. **类型不符一律抛 `shape`**（不是放过、不是 `undefined` 顶替）。`kind` 必须落在
 *    `shape` 那一档：把「对面版本对不上」显示成「内部错误」会让人去翻服务端日志里一行根本不
 *    存在的东西。
 * 2. **`nullable` 与 `optional` 严格分工**。`JSON.stringify({a: undefined})` 产出 `{}`，故
 *    服务端「没这个字段」在线上是**键不存在**而不是 `null`；用 `nullable` 去收会让「服务端没配
 *    配额」被判成「配了个坏配额」。而 `undefined` **必须**在 `optional` 才合法 —— 把两者写成
 *    都接受，「服务端没给这个字段」就会被当成「服务端给了 null」。
 * 3. **错误文案里一个字节的值都不许带**。形状不对的那串字节来自一个本包不认识版本的进程，
 *    它既可能是凭据也可能是名单；把它打印到终端等于把对面的数据抄进本机的滚动缓冲。
 *
 * ## 判据为什么这么定
 *
 * - 判「抛不抛」与「抛的是什么」分开断言：判 `kind` / `code` 是契约（界面据此分档），
 *   判文案里的路径与期望类型是**可用性**判据（操作者要靠它知道该去看哪个字段）。
 * - 「文案不含原值」这条**必须**与「文案确实说了点别的」成对断言：单独一条 `not.toContain`
 *   在文案为空串时也会绿，而空文案正是这条纪律失效后的样子。
 *
 * ## 防假绿的位置
 *
 * - `caught()` 在「没抛」时显式抛错并说明该抛什么 —— 用 `expect(fn).toThrow()` 之外的手段取到
 *   错误对象，避免「断言的是包装后的 message 而真值恰好不含那句 secret」这种错位。
 * - `arr` 的元素收窄那条断言错误路径里带**下标**：只断言「抛了」的话，`arr` 退化成
 *   `Array.isArray(v) ? v : bad(...)` 也照样绿，而那正是「收窄了容器、忘了元素」那条事故。
 *
 * @module tests/decode
 */

import { describe, expect, it } from "vitest";
import { TuiError } from "@/client/index.js";
// ⚠️ 收窄组合子**不从 barrel 取**：`src/client/index.ts` 只转发了端点表 / 错误 / 客户端 /
// wire 的出口，没有转发 `decode.ts` 的那九件零件。故本档经深层路径取它们 —— 与根仓
// `tests/unit/manager-http.test.ts` 直接 import `@/manager/routes/patch.js` 同一口径。
import {
  arr,
  bool,
  nullable,
  num,
  obj,
  oneOf,
  opaque,
  optional,
  str,
  strArr,
} from "@/client/decode.js";

/** 请求标签：收窄器的第三个参数，用于错误里的「是哪个请求」 */
const REQ = "GET /api/status";

/**
 * 跑一次收窄并取回抛出的 `TuiError`
 * @description 没抛时**显式失败**：返回一个假错误会让下游断言对着空对象判绿。
 */
function caught(run: () => unknown): TuiError {
  try {
    run();
  } catch (err) {
    expect(err, "收窄失败必须抛 TuiError 而不是别的").toBeInstanceOf(TuiError);
    return err as TuiError;
  }
  throw new Error("判据：本次调用应当抛 TuiError（实际没抛）");
}

/** 断言「这确实是一档 `shape` 失败」 */
function expectShape(run: () => unknown): TuiError {
  const err = caught(run);
  expect(err.kind).toBe("shape");
  expect(err.code).toBe("bad-shape");
  return err;
}

/** 一条会被抄进终端就出事的内容：来自对面响应体的凭据形态 */
const SECRET = "s3cr3t-token-value";

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

describe("arr", () => {
  it("空数组通过（空名单是合法状态，不是缺失）", () => {
    expect(arr(str)([], "p", REQ)).toEqual([]);
    expect(strArr([], "p", REQ)).toEqual([]);
  });

  it("非数组抛（含 `{}`：服务端漏发一个数组时那是形状错，不是空列表）", () => {
    for (const bad of [{}, "a", 1, null, undefined, true]) {
      expectShape(() => arr(str)(bad, "p", REQ));
    }
  });

  it("元素**逐个**收窄，且错误路径里带下标", () => {
    // 只断言「抛了」的话，`arr` 退化成「只判 Array.isArray」也照样绿
    const err = expectShape(() => arr(str)([1, 2], "entries", REQ));
    expect(err.message).toContain("entries[0]");
    const second = expectShape(() => arr(str)(["a", 2], "entries", REQ));
    expect(second.message).toContain("entries[1]");
  });

  it("嵌套的路径是逐层拼出来的（操作者要靠它定位到具体那一格）", () => {
    const err = expectShape(() =>
      obj({ keys: arr(obj({ id: num })) })({ keys: [{ id: 1 }, { id: "2" }] }, "body", REQ),
    );
    expect(err.message).toContain("body.keys[1].id");
  });

  it("元素收窄后逐字通过（判据不许把合法值改写）", () => {
    expect(arr(num)([1, 2, 3], "p", REQ)).toEqual([1, 2, 3]);
  });
});

describe("obj", () => {
  const shape = obj({ a: num, b: str });

  it("声明的键逐个收窄，输出逐字保留", () => {
    expect(shape({ a: 1, b: "x" }, "root", REQ)).toEqual({ a: 1, b: "x" });
  });

  it("**缺字段抛**（缺的是 `undefined`，内层判据接住；这是「忘了收窄第四个字段」那类事故）", () => {
    const err = expectShape(() => shape({ a: 1 }, "root", REQ));
    expect(err.message).toContain("root.b");
    expectShape(() => shape({ b: "x" }, "root", REQ));
  });

  it("非对象抛（`null` 与数组都不算对象）", () => {
    for (const bad of [null, [], "x", 1, true, undefined]) {
      expectShape(() => shape(bad as unknown, "root", REQ));
    }
  });

  it("**未知键放行**：服务端加字段是它的自由，而判「不许加字段」会让对面每次加字段都打挂老客户端", () => {
    const out = obj({ a: num })({ a: 1, extra: 2, nested: { z: 1 } }, "root", REQ);
    // 放行指的是「不因未知键失败」；输出仍只含声明的键（本包按需读，不替对面保存）
    expect(out).toEqual({ a: 1 });
    expect(Object.keys(out)).toEqual(["a"]);
  });

  it("可缺省键在键不存在时给出 `undefined`，而键存在但类型错时抛", () => {
    const withOptional = obj({ quota: optional(obj({ bytes: num })) });
    expect(withOptional({}, "root", REQ)).toEqual({ quota: undefined });
    expect(withOptional({ quota: { bytes: 1 } }, "root", REQ)).toEqual({
      quota: { bytes: 1 },
    });
    expectShape(() => withOptional({ quota: { bytes: "1" } }, "root", REQ));
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

describe("错误文案：一个字节的值都不许带", () => {
  it("文案里只有**字段路径**与期望类型，不含输入的字符串值", () => {
    // 输入值必须真的**触发**失败才有意义 —— 一个「类型就对」的输入压根不会产生文案，
    // 那时 `not.toContain` 是对着空气判绿
    const err = expectShape(() => num(SECRET, "root.password", REQ));
    expect(err.message).not.toContain(SECRET);
    // 防假绿：只断言 `not.toContain` 时，文案变成空串也会绿 —— 故同时要求它真的说了点东西
    expect(err.message).toContain("root.password");
    expect(err.message).toContain("有限数字");
    expect(err.message.length).toBeGreaterThan(0);
  });

  it("嵌套路径与下标也不许带值（路径可以带 —— 那是本包自己的字段名）", () => {
    const err = expectShape(() =>
      arr(obj({ token: num }))([{ token: 1 }, { token: SECRET }], "body.items", REQ),
    );
    expect(err.message).not.toContain(SECRET);
    expect(err.message).toContain("body.items[1].token");
  });

  it("错误对象带的是**请求标签**（界面上同时有多个 manager 在飞时，「哪个请求失败」比「失败了」有用）", () => {
    const err = expectShape(() => str(1, "p", "PUT /api/users/alice"));
    expect(err.request).toBe("PUT /api/users/alice");
    // `shape` 档没有 HTTP 状态码可言 —— 没收到响应就是没有，别拿 0 冒充
    expect(err.status).toBeNull();
    expect(err.requestId).toBeNull();
  });
});
