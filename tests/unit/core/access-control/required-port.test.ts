/**
 * `ProxyOptions.access` **必填**这件事：core 侧零缺省解析，以及它的源码级形态
 *
 * 锁的是「一个事实不许被悄悄改回去」：把 `?` 加回 `access` 并顺手把 20+ 处构造补成显式
 * 放行，是一次**能通过全部检查**的改动。两条声明行断言 + 一条正向证据（唯一组装根仍
 * 解析默认实现）合起来才闭合，否则就退化成「把功能删了也算过」。
 * 端口的六条硬裁决与源码级判据口径归 `./AGENTS.md`。
 *
 * @module tests/unit/core/access-control/required-port
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HttpProxy } from "@/core/server/http.js";
import { EventHub } from "@/core/events/index.js";
import { noneIdentity } from "@/core/identity.js";
import type { AccessControl } from "@/core/types/proxy.js";
import { openAccessControl } from "../../../helpers/access.js";
import { testConfig, testLogger } from "../../../helpers/config.js";
import { codeOnly, codeOf, sourceOf } from "../../../helpers/source-scan.js";
import { HOST, countingAccess } from "./_access-control-port.js";

describe("ProxyOptions.access 必填：core 侧零缺省解析（access 没有 inert 档）", () => {
  /** 直构 core 并显式注入一份放行档 → 取归一后的那份（core 零二次解析，应原样同一对象） */
  function normalizedAccess(injected: AccessControl = openAccessControl()): AccessControl {
    const proxy = new HttpProxy({
      ctx: {
        config: testConfig,
        logger: testLogger,
        events: new EventHub({ onListenerError: () => undefined }),
      },
      host: "127.0.0.1",
      port: 0,
      access: injected,
    });
    return proxy.options.access;
  }

  it("显式注入的 access 原样落进 options（core 侧零 `??` 二次解析）", () => {
    // ⚠️ **core 侧没有「不注入 → 恒放行」的缺省档**：那个档让「忘注入」变成「配了名单却全放行、
    // 且零信号」，必须由编译期拦住，故 `ProxyOptions.access` 没有 `?`。
    // 本条锁的是剩下那一半不变式：**注入什么就用什么**（不许 core 悄悄换一份）。
    const access = countingAccess();
    expect(normalizedAccess(access)).toBe(access);
  });

  it("注入一份放行档 → 三方法恒放行、checkRoute 恒 { direct: false }（显式写出来的那个答案）", () => {
    const access = normalizedAccess();

    // `checkRoute` 恒 `{ direct: false }`（走上游）——**注意这不是「放行」**：它说的是
    // 「client 模式别回落直连」。不判名单，所以它不给出任何回落理由（无 reason）。
    expect(access.checkClient({ client: "203.0.113.9" })).toEqual({ allowed: true });
    expect(access.checkClient({ client: "unknown" })).toEqual({ allowed: true });
    expect(access.checkTarget({ host: HOST })).toEqual({ allowed: true });
    expect(access.checkTarget({ host: HOST, user: "anyone" })).toEqual({ allowed: true });
    expect(access.checkRoute({ host: HOST })).toEqual({ direct: false });
  });

  it("两个缺省档的语义各不相同：identity 缺省=不判人，traffic 缺省=不计量（access 没有缺省档）", () => {
    // 另两个端口的缺席读作**关闭一项功能**，所以各有一个语义明确的 inert 档；`access` 的缺席
    // 读作的是**取消防护**（全放行），方向相反，所以走「编译期必填」而不是「缺省档」那套。
    // 把三者混成同一个「关闭」正是本条要防的误读。
    const proxy = new HttpProxy({
      ctx: { config: testConfig, logger: testLogger, events: new EventHub({ onListenerError: () => undefined }) },
      host: "127.0.0.1",
      port: 0,
      access: openAccessControl(),
    });

    expect(proxy.options.identity.isEnabled).toBe(false);
    // 不计量：显式禁用档的 consume 恒 allow 且不累计（usage 恒零）
    expect(proxy.options.traffic.consume("nobody", "up", 1024).allow).toBe(true);
    expect(proxy.options.traffic.usage("nobody")).toBe(0);
  });

  it("直构 core 时 identity 仍是同一个缺省档单例（access 侧已无此形态）", () => {
    // 顺带钉住 identity 侧的同构：直构 core 的默认身份是恒放行、恒不剥凭证的 inert 档。
    const a = new HttpProxy({
      ctx: { config: testConfig, logger: testLogger, events: new EventHub({ onListenerError: () => undefined }) },
      host: "127.0.0.1",
      port: 0,
      access: openAccessControl(),
    });
    const b = new HttpProxy({
      ctx: { config: testConfig, logger: testLogger, events: new EventHub({ onListenerError: () => undefined }) },
      host: "127.0.0.1",
      port: 0,
      access: openAccessControl(),
    });

    // `toBe` 而不是 `toEqual`：后者对「每次新建一个行为相同的新对象」照样通过，锁不住共享
    expect(a.options.identity).toBe(b.options.identity);
    expect(Object.isFrozen(a.options.identity)).toBe(true);
    expect(a.options.identity.isEnabled).toBe(false);
    expect(a.options.identity.kind).toBe("none");
    expect(noneIdentity().isEnabled).toBe(false);
  });
});

describe("源码级：`access` 的必填性与缺省档删除（防复活）", () => {
  it("ProxyOptions 的 `access` 声明行不带 `?`（编译期护栏的机器可读形态）", () => {
    // 这条是「`access` 必填」这个**事实**的源码级形态。类型面本身由 `pnpm typecheck`
    // 兜着（少一个 `?` 就有 20+ 处构造点立刻红），但「有人把 `?` 加回去、顺手把 20+ 处
    // 补成显式放行」是一次**能通过全部检查**的改动——只有本条会红。
    const code = codeOnly(sourceOf(path.join("core", "types", "proxy.ts")));
    const decl = code.split("\n").filter((l) => /^\s*access\s*:/.test(l));
    expect(decl, "types/proxy.ts 必须恰好一处 `access:` 顶层声明").toHaveLength(1);
    expect(decl[0]).toMatch(/^\s*access\s*:\s*AccessControl\s*;/);
    expect(decl[0], "`access` 不许带 `?`（缺席 = 取消防护，必须编译期强制）").not.toContain("?");
  });

  it("`src/core/server/base.ts` 零 `OPEN_ACCESS_CONTROL`（那个缺省档已整体删除）", () => {
    // ⚠️ **锚在符号名上会不会是恒真的空断言？** 不会：那个符号**今天还存在于本文件**，
    // 我们正要删它；一旦它被复活，本条立刻红。而「core 的 `access` 缺省解析」这件事
    // 删掉之后在运行期已无任何形态可测（编译器先拦住了），所以源码级是唯一有牙齿的判据。
    const raw = sourceOf(path.join("core", "server", "base.ts"));
    expect(codeOnly(raw), "缺省放行档（及任何提到它的注释）不许出现在 base.ts").not.toContain(
      "OPEN_ACCESS_CONTROL",
    );
    // 归一表达式也不许把 access 重新接回 `??`
    expect(codeOnly(raw)).toMatch(/access\s*:\s*options\.access\s*,/);
    expect(codeOnly(raw), "`access` 不许再有缺省解析").not.toMatch(/access\s*:\s*options\.access\s*\?\?/);
  });

  it("`createProxyRuntime` 路径恒解析出 access（故 `access` 必填不影响它）", () => {
    // 正向证据（防上面两条变成「把功能删了也算过」）：唯一组装根仍然解析默认实现。
    const code = codeOf("runtime", "services.ts");
    expect(code).toMatch(/overrides\.access\s*\?\?\s*createFileAccessControl\(/);
  });
});