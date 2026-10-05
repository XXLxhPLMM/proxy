/**
 * 账号 `expiresAt`（ISO 时刻形态）与 `disabled`（布尔形态）的 `fail-closed` 归一。
 *
 * 两个字段的**判定**在认证点（`core/identity/` 那几档），本目录只答「磁盘上这个值能不能被读成
 * 一个时刻 / 一个布尔」；每个字段各自锁的件事逐字写在它的 `describe` 上方。
 *
 * @module tests/unit/config/auth-users
 */

import { describe, expect, it } from "vitest";
import { normalizeOne, toAccountDoc, validateAuthUsers } from "@/datasource/users/index.js";

/**
 * `users.json` 的账号 `expiresAt`（数据层：ISO 形态的 fail-closed 归一）
 *
 * @description
 * 判定在 `src/core/identity/`（认证点）；本档只答「磁盘上这个字符串能不能被读成一个时刻」。
 *
 * ⚠️ **两条 fail-closed 推导见 `./AGENTS.md`**：① **形态必须带时区偏移** —— `Date.parse` 把
 * `"2026-10-01"` 读成 **UTC 午夜**、把 `"2026-10-01 00:00"` 读成**本地午夜**，同一份配置在 UTC
 * 机器与 `+08:00` 机器上差 8 小时；② **日历上不存在的日必须拒** ——
 * `Date.parse("2026-02-30T00:00:00Z")` 实测返回**有限值**（静默滚成 3 月 2 日）。
 */
describe("config/auth-users 账号 expiresAt", () => {
  /** 判据：归一后是 epoch 毫秒 */
  const at = (iso: unknown): unknown =>
    (validateAuthUsers([{ username: "a", password: "x", expiresAt: iso }]) ?? [])[0];

  it("白名单联动：带 expiresAt 的文件校验通过并归一成 epoch 毫秒", () => {
    expect(validateAuthUsers([{ username: "a", password: "x", expiresAt: "2026-10-01T00:00:00Z" }])).toEqual([
      { username: "a", password: "x", expiresAt: Date.parse("2026-10-01T00:00:00Z") },
    ]);
    // 偏移被如实尊重：同一时刻的两种写法归一到同一个毫秒数
    expect(
      validateAuthUsers([
        { username: "a", password: "x", expiresAt: "2026-10-01T08:00:00+08:00" },
        { username: "b", password: "x", expiresAt: "2026-10-01T00:00:00Z" },
      ]),
    ).toEqual([
      { username: "a", password: "x", expiresAt: Date.parse("2026-10-01T00:00:00Z") },
      { username: "b", password: "x", expiresAt: Date.parse("2026-10-01T00:00:00Z") },
    ]);
  });

  it("缺省不写 expiresAt 键（最小账号产物逐字不变）", () => {
    expect(Object.keys(validateAuthUsers([{ username: "a", password: "x" }])![0]!)).toEqual([
      "username",
      "password",
    ]);
  });

  it("必须带时区偏移：无偏移 / 空格分隔 / 只有日期一律整份文件非法", () => {
    // `Date.parse` 会给前三个都返回一个数（分别按 UTC 午夜 / 本地午夜 / 本地午夜猜），
    // 那是「看起来配了、实际是另一个时刻」的假安全感。
    expect(at("2026-10-01")).toBeUndefined();
    expect(at("2026-10-01 00:00")).toBeUndefined();
    expect(at("2026-10-01T00:00:00")).toBeUndefined();
    expect(at("2026-10-01T00:00:00+08")).toBeUndefined();
    // 毫秒只允许出现在**秒之后**（`…T00:00:00.5Z` 合法；`…T00:00.5Z` 是别的形态，拒）
    expect(at("2026-10-01T00:00:00.5Z")).toBeDefined();
    expect(at("2026-10-01T00:00.5Z")).toBeUndefined();
  });

  it("日历上不存在的日非法（Date.parse 会静默滚成下个月）", () => {
    // 实测 `Date.parse("2026-02-30T00:00:00Z")` = 1772409600000（= 3 月 2 日），有限值
    expect(Date.parse("2026-02-30T00:00:00Z")).not.toBeNaN();
    expect(at("2026-02-30T00:00:00Z")).toBeUndefined();
    expect(at("2026-04-31T00:00:00Z")).toBeUndefined();
    expect(at("2027-02-29T00:00:00Z")).toBeUndefined(); // 2027 不是闰年
    // 合法闰日仍然通过（别把判据写太紧）
    expect(at("2028-02-29T00:00:00Z")).toBeDefined();
  });

  it("非字符串 / 月 13 / 时 24 非法", () => {
    expect(at(1234567890)).toBeUndefined();
    expect(at(null)).toBeUndefined();
    expect(at("")).toBeUndefined();
    expect(at("2026-13-01T00:00:00Z")).toBeUndefined();
    expect(at("2026-10-01T24:00:00Z")).toBeUndefined();
  });

  it("已过期是合法值（只有形态非法才作废整份文件）", () => {
    // 判它非法等于「把账号设成过期 → 整个服务起不来」
    expect(at("2020-01-01T00:00:00Z")).toEqual({
      username: "a",
      password: "x",
      expiresAt: Date.parse("2020-01-01T00:00:00Z"),
    });
  });

  it("与 quota / acl 各自独立：expiresAt 非法让整份文件作废（同表其它账号也救不回）", () => {
    expect(
      validateAuthUsers([
        { username: "ok", password: "x", quota: { bytes: 10 } },
        { username: "bad", password: "x", expiresAt: "2026-10-01" },
      ]),
    ).toBeUndefined();
  });
});

/**
 * `users.json` 的账号 `disabled`（数据层：布尔形态的 fail-closed 归一）
 *
 * @description
 * 判定在 `src/core/identity/`（认证点）；本档只答「磁盘上这个值能不能被读成一个布尔」。
 *
 * ⚠️ **三条推导见 `./AGENTS.md`「`disabled` 的判据为什么是 `typeof`」一节**：必须真的是布尔
 * （与 `expiresAt` 的 fail-closed 同源但**没有例外**）／判据不得写成 `disabled === true`／
 * 归一化**保留 `false` 本身**而不压成缺省键。本档另有 `ACCOUNT_KEYS` 联动那条（闭合白名单）。
 */
describe("config/auth-users 账号 disabled", () => {
  /** 判据：带 `disabled` 的单账号文件能否通过校验、产物长什么样 */
  const withDisabled = (value: unknown): unknown =>
    (validateAuthUsers([{ username: "a", password: "x", disabled: value }]) ?? [])[0];

  it("白名单联动：带 disabled 的文件校验通过，true / false 原样保留", () => {
    expect(withDisabled(true)).toEqual({ username: "a", password: "x", disabled: true });
    // ⚠️ `false` **不被压成缺省键**：那是运维刚写下的意图，替他擦掉等于让「我明明开了」与
    // 「我明明关了」在文件里长得一样
    expect(withDisabled(false)).toEqual({ username: "a", password: "x", disabled: false });
  });

  it("缺省不写 disabled 键（最小账号产物逐字不变）", () => {
    expect(Object.keys(validateAuthUsers([{ username: "a", password: "x" }])![0]!)).toEqual([
      "username",
      "password",
    ]);
  });

  it("必须真的是布尔：\"true\" / 1 / null / 对象 / 数组一律整份文件非法", () => {
    expect(withDisabled("true")).toBeUndefined();
    expect(withDisabled("yes")).toBeUndefined();
    expect(withDisabled(1)).toBeUndefined();
    expect(withDisabled(0)).toBeUndefined();
    expect(withDisabled(null)).toBeUndefined();
    expect(withDisabled({})).toBeUndefined();
    expect(withDisabled([])).toBeUndefined();
  });

  it("「非布尔绝不被静默归一成 false」——这是本档最重要的一条方向断言", () => {
    // 判据写成 `disabled === true` 的话，上面五个非法值会全部变成 `disabled: false`
    // （= 启用）且**整份文件仍然通过**。那种实现的外部表现是：运维在 users.json 里写了
    // `disabled: "true"`，服务照跑、账号照常能用、日志里一条线索都没有。
    // 反过来说，本条一旦红就说明 fail-closed 被换成了「静默回落缺省值」。
    for (const bad of ["true", 1, 0, null, {}]) {
      expect(
        validateAuthUsers([{ username: "a", password: "x", disabled: bad }]),
        `disabled=${JSON.stringify(bad)} 必须让整份表作废`,
      ).toBeUndefined();
    }
  });

  it("与 quota / acl / expiresAt 各自独立：disabled 非法让整份表作废（同表其它账号也救不回）", () => {
    expect(
      validateAuthUsers([
        { username: "ok", password: "x", quota: { bytes: 10 }, disabled: false },
        { username: "bad", password: "x", disabled: "true" },
      ]),
    ).toBeUndefined();
  });

  it("落盘形态往返：normalizeOne(toAccountDoc 的输入) 之后 disabled 仍在", () => {
    // `AccountSource.put` 走 `normalizeOne` → `toAccountDoc` → 磁盘形态 → `validateAuthUsers`。
    // 这一条锁「写进去读得出来」：布尔原样透传、不被 `toAccountDoc` 吞掉。
    const doc = JSON.parse(toAccountDoc({ username: "a", password: "x", disabled: true })) as {
      disabled?: unknown;
    };
    expect(doc.disabled).toBe(true);
    expect(normalizeOne({ username: "a", password: "x", disabled: false })).toEqual({
      username: "a",
      password: "x",
      disabled: false,
    });
  });
});
