/**
 * **数据源可脱离代理单独使用** —— 主人那句「数据源就算不启动代理也能够工作」的机器护栏
 *
 * @description
 * 这份档在**运行期**证明三件事，其余护栏都是源码级的：
 *
 * 1. **不构造任何代理对象**就能 import 到数据源门面并跑起来——文件里出现的只有三个
 *    `register*` / `list*` / `resolve*`、平值接线 `accountLocatorFrom` 与纯函数 `validateAuthUsers`。
 *    **刻意不 import** `createProxyRuntime` / `createProxy`：一旦 import 进来，「不启动代理」
 *    这句话就成了「import 了代理但没调用」，那证明不了独立性。
 * 2. **驱动名是开放集合**：注册一个内置项之外的名字，`resolve` 立刻拿到它；未注册的名字**抛错
 *    且错误文本列出全部已注册项**（fail-fast，判据从类型层挪到注册表这个运行时事实）。
 * 3. **工厂吃平值闭包**：`accountLocatorFrom(driver, file)` 造出的是两个闭包，不认识
 *    `ConfigAccessor`——故一个不跑代理的库调用方能自己造数据源，不需要 `ConfigStore`。
 *
 * ## 为什么「用完退订」
 *
 * 注册表是**模块级可变全局状态**，不留痕迹会让后面那些档看到被本档污染过的驱动清单。
 * 退订闭包是幂等的，且只删自己写的那一项（`override` 覆盖过的项不被误删）。
 *
 * @see tests/library/entry.test.ts 包入口的导出面契约（值名清单 + 运行期存在性）
 * @see src/datasource/AGENTS.md 层不变量
 */

import { describe, expect, it } from "vitest";
import {
  accountLocatorFrom,
  listAccountSourceDrivers,
  listAclSourceDrivers,
  listUsageSourceDrivers,
  registerAccountSource,
  registerAclSource,
  registerUsageSource,
  resolveAccountSource,
  resolveAclSource,
  resolveUsageSource,
  validateAcl,
  validateAuthUsers,
} from "@/index.js";

describe("数据源脱离代理单独使用", () => {
  it("三张注册表在无代理状态下各自已含内置驱动", () => {
    // 内置驱动是**构造注册表时**写进去的，故首次 `list()` 即含它们。
    // 三张表形状同形（`createSourceRegistry` 是唯一构造入口）——这个断言就是那条同形性的证据。
    expect([...listAccountSourceDrivers()].sort()).toEqual(["json", "sqlite"]);
    expect([...listAclSourceDrivers()].sort()).toEqual(["json"]);
    expect([...listUsageSourceDrivers()].sort()).toEqual(["json", "sqlite"]);
  });

  it("注册一个内置项之外的驱动后 resolve 立刻拿到它（开放集合）", () => {
    // 驱动名刻意不像任何内置档：命中内置分支的实现会让这条恒真。
    const CUSTOM = "standalone-custom";
    const off = registerAccountSource(CUSTOM, () => ({ kind: CUSTOM }) as never);
    try {
      expect(listAccountSourceDrivers()).toContain(CUSTOM);
      // 同一份注册表，三种取法必须一致
      expect(resolveAccountSource(CUSTOM)).toBeTypeOf("function");
    } finally {
      off();
    }
    expect(listAccountSourceDrivers()).not.toContain(CUSTOM);
  });

  it("三张表都能插自定义驱动（判据是注册表逐字同形，不是只对账号表成立）", () => {
    const a = registerAccountSource("dup-acct", () => ({}) as never);
    const b = registerAclSource("dup-acl", () => ({}) as never);
    const c = registerUsageSource("dup-usage", () => ({}) as never);
    try {
      expect(resolveAccountSource("dup-acct")).toBeTypeOf("function");
      expect(resolveAclSource("dup-acl")).toBeTypeOf("function");
      expect(resolveUsageSource("dup-usage")).toBeTypeOf("function");
    } finally {
      a();
      b();
      c();
    }
  });

  it("未注册的驱动名抛错且错误文本列出全部已注册项（绝不静默回落到内置档）", () => {
    // ⚠️ 正面形态的判据：静默回落（`else → json`）**不会抛错**，所以这条在退化时红。
    let thrown: unknown;
    try {
      resolveAccountSource("definitely-not-registered");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // 列出已注册项：部署出错最常见的成因是**拼错**，只说「未知驱动」等于让人去翻源码
    expect(message).toContain("definitely-not-registered");
    expect(message).toContain("json");
    expect(message).toContain("sqlite");
  });

  it("平值接线不需要 ConfigStore（工厂签名吃闭包，故库调用方可自行装配）", () => {
    const locator = accountLocatorFrom("json", "cfg/users.json", "cfg/users.db");
    // 两个闭包，没有第三个字段：多一个字段就意味着「接线」开始携带配置层的概念
    expect(Object.keys(locator).sort()).toEqual(["driver", "pathFor"]);
    expect(locator.driver()).toBe("json");
    // `pathFor(driver)` 按**问的人**答，故同一份接线能服务两个后端（少一个字段的另一面：
    // 一个只带单一路径的接线要么在换驱动时重建、要么就得自己认识两个配置键名）
    expect(locator.pathFor("json")).toBe("cfg/users.json");
    expect(locator.pathFor("sqlite")).toBe("cfg/users.db");
  });

  it("形状校验是纯函数、零 IO（自定义驱动可直接复用，不必重新实现判据）", () => {
    // 合法 → 通过；缺 password → 整表作废（fail-closed，不是一个字段被忽略）
    const ok = validateAuthUsers([{ username: "alice", password: "pw" }]);
    expect(ok).toHaveLength(1);
    expect(validateAuthUsers([{ username: "alice" }])).toBeUndefined();
    // 名单同理
    expect(validateAcl({ clientIp: { whitelist: ["1.2.3.4"] } })).toBeDefined();
    expect(validateAcl({ clientIp: { whitelist: ["not an ip"] } })).toBeUndefined();
  });

  it("退订是幂等的，且只删自己写的那一项", () => {
    const off = registerAccountSource("idempotent-driver", () => ({}) as never);
    off();
    off(); // 第二次不许抛错
    expect(listAccountSourceDrivers()).not.toContain("idempotent-driver");
  });
});
