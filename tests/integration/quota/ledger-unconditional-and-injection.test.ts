/**
 * 真 runtime 侧的「落盘无条件」与 `services.usageSource` 那个**曾经是死注入点**的注入位。
 *
 * @description
 * 「在判定 ⇒ 一定在记账」为什么必须走真请求（拆掉启用门之后 `enabled` 恒成立，标志成了摆设）、
 * 注入位为什么曾经两条 return 分支都不读 `overrides.usageSource`，归 `./AGENTS.md`。
 *
 * @module tests/integration/quota
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { accountLocatorFor, createConfigContext } from "@/config/index.js";
import { readAuthUsers } from "@/datasource/users/index.js";
import type { UsageSource, UsageSourceController } from "@/datasource/quota/index.js";
import { createProxyRuntime } from "@/runtime/index.js";
import { LoggerImpl } from "@/utils/logger/index.js";
import { getFreePort } from "../../helpers/net.js";
import { blockAfter, codeOf } from "../../helpers/source-scan.js";
import {
  ALICE,
  ALICE_PW,
  accessor,
  dir,
  ledgerDir,
  ledgerFile,
  originPort,
  proxyRequest,
  runtimes,
  startRuntime,
  store,
  writeUsers,
} from "./ledger-fixture.js";

/**
 * 真 runtime 侧的「落盘无条件」：**在判定 ⇒ 一定在记账**。
 * @description 判据是**代理真的在跑**（走一次转发），不是只查 `enabled` 标志 —— 拆掉
 * `open()` 里那道「没人配配额就不启用」的门之后，标志照样是 true，只有「真发一次请求、
 * 再真读一次库」能分辨出账到底记没记。
 */
describe("quota/ledger-unconditional（落盘无条件：真 runtime 侧）", () => {
  it("没有配任何 quota → 照样建目录建表，转发 512B 后账里真有这 512B", async () => {
    writeUsers([{ username: ALICE, password: ALICE_PW }]); // 完全没有 quota
    readAuthUsers({ locator: accountLocatorFor(accessor), force: true });

    const runtime = await startRuntime();
    expect(runtime.services.usageSource, "账本对象存在").toBeDefined();
    expect(runtime.services.usageSource?.enabled, "无配额也启用（否则判定与落盘脱钩）").toBe(true);
    expect(fs.existsSync(ledgerDir), "账本目录建出来了").toBe(true);

    // 判定照常：无限流账号一路放行
    const r = await proxyRequest(store.get("port"), originPort, {
      method: "POST",
      body: Buffer.alloc(512, 0x47),
    });
    expect(r.status).toBe(200);
    await runtime.stop(); // 停机必须落盘（这是正确性要求：丢掉队列里的量等于能刷额度）

    // ⚠️ 判据落在**真读库**上。锚点是这个文件路径而不是「enabled 为 true」——
    // 后者在门被拆掉之后恒成立，护栏就成了摆设。
    const db = new DatabaseSync(ledgerFile(), { readOnly: true });
    try {
      const row = db.prepare("SELECT v FROM usage WHERE u = ?").get(ALICE) as { v: number } | undefined;
      expect(row?.v, "无配额账号的用量也落库了（「没有上限」≠「不计量」）").toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("全 0 的 quota 同样记账（bytes=0 按契约等于「不限流」，但仍计量）", async () => {
    writeUsers([
      { username: ALICE, password: ALICE_PW, quota: { bytes: 0 } },
    ]);
    readAuthUsers({ locator: accountLocatorFor(accessor), force: true });
    const runtime = await startRuntime();
    expect(runtime.services.usageSource?.enabled).toBe(true);
    expect(fs.existsSync(ledgerDir)).toBe(true);
    await runtime.stop();
  });

  it("注入 services.traffic 替身 → 完全不建账本（那一本账归调用方管）", async () => {
    // ⚠️ 「不建」指的是**默认那一份**（`QUOTA_USAGE_DRIVER` 选出来的）：调用方若**同时**注入了
    // `usageSource` 替身，那个替身是原样生效的（见下一组 describe）。本例只注入 `traffic`，
    // 所以 `usageSource` 恒 undefined。
    const sentinel = {
      consume: () => ({ allow: true as const }),
      usage: () => 0,
    };
    const port = await getFreePort();
    store.set("port", port);
    const runtime = createProxyRuntime({
      context: createConfigContext({ store, configDir: dir }),
      logger: new LoggerImpl({ level: "silent" }),
      services: { traffic: sentinel },
    });
    await runtime.start();
    runtimes.push(runtime);
    expect(runtime.services.traffic).toBe(sentinel);
    expect(runtime.services.usageSource, "注入替身时不解析默认账本").toBeUndefined();
    expect(fs.existsSync(ledgerDir), "注入替身时不建目录").toBe(false);
    await runtime.stop();
  });
});

/** 账本替身自报状态：`openCalls` / `closeCalls` 让「生命周期真被 runtime 驱动」可断言 */
interface LedgerSentinel extends UsageSource {
  readonly openCalls: number;
  readonly closeCalls: number;
}

interface Recorded {
  user: string;
  dir: string;
  bytes: number;
}

/**
 * 一份**只记账不落盘**的账本替身（满足 `UsageSource` 全形状：数据面 + 生命周期面）
 * @description `enabled` 跟着 `open`/`close` 翻，于是「建不了存储」与「已启用」在替身上同样可区分。
 * `file` 恒为哨兵串：真账本的路径在诊断里有意义，替身没有文件，故给一个一眼看出不是路径的值。
 */
function ledgerSentinel(recorded: Recorded[]): LedgerSentinel {
  const calls = { open: 0, close: 0 };
  let enabled = false;
  return {
    file: "<sentinel:no-file>",
    get openCalls() {
      return calls.open;
    },
    get closeCalls() {
      return calls.close;
    },
    get enabled() {
      return enabled;
    },
    get queued() {
      return recorded.length;
    },
    async open() {
      enabled = true;
      calls.open += 1;
    },
    async close() {
      enabled = false;
      calls.close += 1;
    },
    record(user, dir, bytes) {
      recorded.push({ user, dir, bytes });
    },
  };
}

describe("quota/ledger-injection（注入位是**真**注入位：它曾经是个死注入点）", () => {
  // ⚠️ 本组存在的理由：`RuntimeServices` 上**一直**有那个数据源字段，而
  // `buildDefaultServices(overrides: Partial<RuntimeServices>)` 的签名因此**放行**
  // `services: { usageSource: 替身 }` —— 可那个函数从头到尾**没读过这个字段**：两条 return
  // 分支分别写死 `usageSource: undefined` 与内置那一份（且不带 `UsageSource` 全形状）。
  //
  // 于是「传了等于没传」，**且零告警、零报错、全绿**。这比「没有这个位」更坏：类型系统在替
  // 一个空壳背书，库调用方会以为持久化后端换掉了。
  //
  // 本组三条都在**行为面**钉住，末条再钉一层源码面。

  it("只注入账本 → 替身原样生效，且**数据面真的接上了**（record 收得到）", async () => {
    // 保护：只断言 `services.usageSource === 替身` 证明的只是「赋值发生」——一份没人调用的替身
    // 照样通过（`countingAccess()` 那条纪律同源）。真正要锁的是 `bindSink` 那一步，所以数 record。
    const recorded: Recorded[] = [];
    const substitute = ledgerSentinel(recorded);

    const port = await getFreePort();
    store.set("port", port);
    const runtime = createProxyRuntime({
      context: createConfigContext({ store, configDir: dir }),
      logger: new LoggerImpl({ level: "silent" }),
      services: { usageSource: substitute },
    });
    await runtime.start();
    runtimes.push(runtime);

    // 保护：此前这里是内置那一份，替身被静默丢弃
    expect(runtime.services.usageSource, "注入的账本替身原样生效").toBe(substitute);
    expect(fs.existsSync(ledgerDir), "注入账本时默认那份不建（连目录都不建）").toBe(false);

    const sent = await proxyRequest(port, originPort, {
      method: "POST",
      body: Buffer.alloc(256, 0x41),
    });
    expect(sent.status).toBe(200);

    // 判定侧照走：仍是默认内存账本，usage 涨了
    expect(runtime.services.traffic.usage(ALICE)).toBeGreaterThan(0);
    // 数据面：同一次计量**同时**落进替身。少 `bindSink` 那一步时这里是空数组，而上面两条全过。
    expect(recorded.length, "bindSink 把替身接进了数据面").toBeGreaterThan(0);
    expect(recorded.every((r) => r.user === ALICE)).toBe(true);
    expect(new Set(recorded.map((r) => r.dir)), "按方向记（上传 + 下载各一条）").toEqual(
      new Set(["up", "down"]),
    );

    // 生命周期仍由 runtime 驱动（这一半此前也不成立：替身压根没被读，`open()` 永不发生）
    expect(substitute.openCalls, "runtime.start() 真的调了替身的 open()").toBe(1);
    expect(runtime.services.usageSource?.enabled).toBe(true);
    await runtime.stop();
    expect(substitute.closeCalls, "runtime.stop() 真的调了替身的 close()").toBe(1);
  });

  it("traffic 与账本都注入 → 替身原样生效（此前恒 undefined），生命周期照常、数据接线归调用方", async () => {
    // 保护：早返回分支曾经写死那个字段为 `undefined`，于是注入的账本连 `open()` 都不会被调
    // ——「注入 = 传了个没人读的对象」。
    const recorded: Recorded[] = [];
    const substitute = ledgerSentinel(recorded);
    const trafficSentinel = { consume: () => ({ allow: true as const }), usage: () => 0 };

    const port = await getFreePort();
    store.set("port", port);
    const runtime = createProxyRuntime({
      context: createConfigContext({ store, configDir: dir }),
      logger: new LoggerImpl({ level: "silent" }),
      services: { traffic: trafficSentinel, usageSource: substitute },
    });
    await runtime.start();
    runtimes.push(runtime);

    expect(runtime.services.traffic).toBe(trafficSentinel);
    expect(runtime.services.usageSource, "注入的账本替身原样生效（此前恒 undefined）").toBe(substitute);
    expect(substitute.openCalls, "生命周期仍由 runtime 驱动").toBe(1);
    expect(substitute.enabled).toBe(true);

    // **数据面刻意不接**，并把这个「不接」钉成契约而不是让它读起来像 bug：`UsageAccount` 端口上
    // 没有 `bindSink`（它是内存实现的具体方法），我们无法给一个陌生的 traffic 挂 sink。
    const sent = await proxyRequest(port, originPort, {
      method: "POST",
      body: Buffer.alloc(64, 0x42),
    });
    expect(sent.status).toBe(200);
    expect(recorded, "traffic 是替身时数据接线归调用方，我们不挂 sink").toEqual([]);

    await runtime.stop();
    expect(substitute.closeCalls).toBe(1);
  });

  it("源码级：两条 return 分支都真的读 `overrides.usageSource`，且不许回到写死 undefined", () => {
    // 行为面已钉住，但**死回去的方式**恰好有一半是行为面钉不住的：把注入换成另一个硬编码值，
    // 上面两条会红；可「读的是 `overrides.usageSource`、而不是某个局部常量」这件事只有源码
    // 断言能说。锚点是**今天仍然存在**的形状（`overrides.usageSource`），不是被删掉的符号名
    // ——点名已删符号的负向断言会恒真而不是失败。
    //
    // ⚠️ 锚点是**返回类型那一行**而不是 `export function buildDefaultServices(`：后者后面第一个
    // `{` 是**参数里** `Partial<RuntimeServices>` 的花括号，`blockAfter` 会切出 `RuntimeServices`
    // 这一个词、然后下面所有计数恒为 0 —— 切错块的表现是「零命中」而不是「报错」，所以下面
    // 先用一条正向断言证明切对了块。
    const fn = blockAfter(codeOf("runtime", "services.ts"), "): RuntimeServices");
    expect(fn, "锚点失效：没切到 buildDefaultServices 的函数体（签名或返回类型变了）").toContain(
      "overrides.usageSource",
    );

    const reads = (fn.match(/overrides\.usageSource/g) ?? []).length;
    expect(reads, "两条 return 分支各读一次 `overrides.usageSource`").toBe(2);
    expect(fn, "早返回分支不许写死 `usageSource: undefined`（那正是它曾经的样子）").not.toMatch(
      /usageSource:\s*undefined/,
    );
    // 正向：注入必须**真的**参与 `bindSink`，否则又回到「只认生命周期、不认数据面」的半截子形状
    expect(fn, "注入的数据源与内置数据源走同一条 `??` 汇流，因而同样被 bindSink").toMatch(
      /overrides\.usageSource\s*\?\?/,
    );
  });

  it("类型面：只实现生命周期面的账本，编译期就过不去注入位", () => {
    // 真正的牙齿在**编译期**：`@ts-expect-error` 一旦变成「未使用」，`pnpm typecheck` 会报
    // TS2578（而 `.cnb.yml` 只做 Docker build、不跑 typecheck，所以本地那四条收尾是唯一关口）。
    // 这也是本档不能只留行为断言的原因：把 `RuntimeServices.usageSource` 的类型悄悄改回
    // `UsageSourceController`，行为面**一条都不会红**——那只账本照样 open/close、照样
    // `enabled: true`、照样一个像模像样的 `file`，只是一辈子收不到 `record`。
    const lifecycleOnly: UsageSourceController = ledgerSentinel([]);
    // @ts-expect-error 只满足生命周期面的对象不能当注入位：它会 open/close 却收不到任何 record
    const asSource: UsageSource = lifecycleOnly;
    expect(asSource).toBeDefined();
  });
});
