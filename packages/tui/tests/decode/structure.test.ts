/**
 * 容器那一族：`arr` 与 `obj` —— **递归**并逐层拼出错误路径
 *
 * @description
 * 全档只有这两个会递归，故「操作者靠 `body.keys[1].id` 定位到具体那一格」这条不变量只有它们
 * 担得起。叶子在 `scalars.test.ts`，跨族的错误文案纪律在 `error-messages.test.ts`；
 * 判据与不变量在 `./AGENTS.md`。
 *
 * @module tests/decode
 */

import { describe, expect, it } from "vitest";
import { arr, num, obj, optional, str, strArr } from "@/lib/decode.js";
import { REQ, expectShape } from "./_shared.js";

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
