import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createUsageMirror } from "@/datasource/quota/index.js";
import type { UsageAccount, UsageQuota } from "@/datasource/quota/index.js";
import { meterStream, openLinkMeter } from "@/core/quota-meter.js";
import { codeOf } from "../../../helpers/source-scan.js";

/**
 * core 侧的**计量落点**：在源流上挂被动 `data` 监听器，只读 `chunk.length`（不得整形）。
 *
 * 零 `Transform` / 零 `pause(` / 零 `resume(` / 零 `push(` / 零 `pipe(` 且 `data` 监听器恰好 1 处
 * —— 插整形会与 `guardDialing` 的半关闭联动纠缠成第三层流控；「无身份时一个监听器都不挂」是关
 * 鉴权部署的零开销保证。⚠️ 本目录**只有这一档**故无 `AGENTS.md`：判定侧（allow / 上限 / 同步性）
 * 在 `tests/unit/datasource/quota/`，本档只答「计量在哪条流上数、怎么数」。
 */

/** 用一张表当 `QuotaResolver` 替身：查不到即 undefined（= 不限流） */
function accountWith(quotas: Record<string, UsageQuota>): UsageAccount {
  return createUsageMirror((user) => quotas[user]);
}

describe("@/datasource/quota 计量落点是被动计数（护栏：不得整形）", () => {
  it("meterStream 只挂一个 data 监听器：不 push / 不 pause / 不 resume / 不改管道", () => {
    const code = codeOf("core", "quota-meter.ts");
    // 插 Transform / pause-resume 整形会与 guardDialing 的半关闭联动纠缠成第三层流控
    expect(code).not.toMatch(/\bTransform\b/);
    expect(code).not.toMatch(/\.pause\(/);
    expect(code).not.toMatch(/\.resume\(/);
    expect(code).not.toMatch(/\.push\(/);
    expect(code).not.toMatch(/\.pipe\(/);
    // 唯一允许的挂点是 data 监听器
    expect((code.match(/\.on\(\s*"data"/g) ?? []).length).toBe(1);
  });

  it("无身份 → 一个监听器都不挂、charge 恒放行（关鉴权的部署零开销）", () => {
    const account = accountWith({ alice: { bytes: 1 } });
    const client = new PassThrough();
    const onExceeded = vi.fn();
    meterStream(account, undefined, "up", client, onExceeded);
    expect(client.listenerCount("data")).toBe(0);

    const link = openLinkMeter(account, undefined, new PassThrough(), new PassThrough(), onExceeded);
    expect(link.inert).toBe(true);
    expect(link.charge("up", 1_000_000).allow).toBe(true);
    expect(account.usage("alice")).toBe(0);
    expect(onExceeded).not.toHaveBeenCalled();
  });

  it("有身份 → 两端各挂一个 data 监听器，字节逐块累加到账本", async () => {
    const account = accountWith({ alice: { bytes: 0 } });
    const client = new PassThrough();
    const upstream = new PassThrough();
    openLinkMeter(account, "alice", client, upstream, () => undefined);
    expect(client.listenerCount("data")).toBe(1);
    expect(upstream.listenerCount("data")).toBe(1);

    client.write(Buffer.alloc(10));
    upstream.write(Buffer.alloc(7));
    await new Promise((r) => setImmediate(r));
    expect(account.usage("alice")).toBe(17);
  });

  it("charge 是建隧后首批载荷的补记口（不经 data 事件的字节靠它计入）", () => {
    const account = accountWith({ alice: { bytes: 100 } });
    const link = openLinkMeter(account, "alice", new PassThrough(), new PassThrough(), () => undefined);
    expect(link.inert).toBe(false);
    // 客户端 CONNECT/SOCKS 之后的首包：不经 data 事件，由 charge 显式补记
    expect(link.charge("up", 30).allow).toBe(true);
    expect(link.charge("down", 70).allow).toBe(true);
    expect(account.usage("alice")).toBe(100);
  });

  it("耗尽回调带上方向（由挂点如实上报，两个挂点各报各的）", () => {
    // 只有一个上限 → **任一方向都能撞破它**，所以「本次是哪个方向」只有挂点知道
    // （它清楚自己在数哪条流）。两个挂点分别上报自己的方向，谁也不许反推。
    const seen: Array<[string, number, number]> = [];
    const account = accountWith({ alice: { bytes: 10 } });
    openLinkMeter(
      account,
      "alice",
      new PassThrough(),
      new PassThrough(),
      (dir, verdict) => {
        seen.push([dir, verdict.usage ?? 0, verdict.limit ?? 0]);
      },
    );
    const client = new PassThrough();
    const upstream = new PassThrough();
    openLinkMeter(account, "alice", client, upstream, (dir, verdict) => {
      seen.push([dir, verdict.usage ?? 0, verdict.limit ?? 0]);
    });
    client.write(Buffer.alloc(4));
    client.write(Buffer.alloc(9));
    // 第二块把合计推到 13 > 10：dir 是 up（真实流动方向），usage/limit 是合计口径
    expect(seen).toEqual([["up", 13, 10]]);

    // 另一条流撞顶时报的是 down，且 usage 仍是**合计**数（11 + 9 = 20）
    upstream.write(Buffer.alloc(9));
    expect(seen[1]).toEqual(["down", 22, 10]);
  });
});