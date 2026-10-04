/**
 * 错误文案：一个字节的值都不许带
 *
 * @description
 * **跨族**的一条不变量，逐族各来一份样本：`num`（叶子）、`arr(obj(...))`（容器）、
 * `str`（叶子）。判据与不变量在 `./AGENTS.md`。
 *
 * @module tests/decode
 */

import { describe, expect, it } from "vitest";
import { arr, num, obj, str } from "@/lib/decode.js";
import { REQ, SECRET, expectShape } from "./_shared.js";

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
