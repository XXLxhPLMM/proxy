/**
 * `UsageMirror` 的判定语义：恒 allow 的情形、唯一合计上限、`<=` 边界与按用户分槽
 *
 * @description
 * 主题级不变量与变异表归同目录 `AGENTS.md`（本目录只放「这一档管哪一段 + 指向 `AGENTS.md`」）。
 * 本档只答「**判定本身**对不对」；`consume` 的同步性前提在 `consume-sync.test.ts`，
 * 「这条用量属于哪个窗口」在 `window-key.test.ts` / `window-rollover.test.ts`。
 * 计量落点（`core/quota-meter.ts` 的被动计数护栏）在 `tests/unit/core/quota/meter.test.ts`。
 */

import { describe, expect, it } from "vitest";
import { inertUsageAccount, type UsageQuota } from "@/datasource/quota/index.js";
import { accountWith } from "./_traffic-account.js";

const UNLIMITED: UsageQuota = { bytes: 0 };

describe("@/datasource/quota UsageMirror：恒 allow 的情形（显式分支，不是默认值蒙混）", () => {
  it("用户未配 quota → 恒 allow（但仍照常计量，见下一条）", () => {
    const account = accountWith({});
    for (let i = 0; i < 100; i++) {
      expect(account.consume("ghost", "up", 1_000_000).allow).toBe(true);
      expect(account.consume("ghost", "down", 1_000_000).allow).toBe(true);
    }
  });

  it("未配配额也照常累加 usage（usage 恒为真用量；将来加上限即刻按真账判，不给「从 0 开始」的假象）", () => {
    // 这是与「不计量」刻意的区分：**没有上限** ≠ **不计量**。
    // 唯一「不计量」的情形是**没有身份**（`meterStream` 一个监听器都不挂，见 core/quota 那一档）。
    const account = accountWith({});
    account.consume("ghost", "up", 30);
    account.consume("ghost", "down", 12);
    expect(account.usage("ghost")).toBe(42);
  });

  it("配了但 bytes 为 0 → 恒 allow（0 = 不限流）", () => {
    const account = accountWith({ alice: UNLIMITED });
    expect(account.consume("alice", "up", 2 ** 40).allow).toBe(true);
    expect(account.consume("alice", "down", 2 ** 40).allow).toBe(true);
    // 但**计量照常发生**（这是「不限流」而不是「不计量」）
    expect(account.usage("alice")).toBe(2 ** 41);
  });

  it("用户不存在（表里只有别人）→ 恒 allow", () => {
    const account = accountWith({ bob: { bytes: 1 } });
    expect(account.consume("alice", "up", 10_000).allow).toBe(true);
  });

  it("非正字节数 → 直接放行且不累加（空 chunk 不是「耗尽」，负数是上游 bug 不是用量）", () => {
    const account = accountWith({ alice: { bytes: 10 } });
    expect(account.consume("alice", "up", 0).allow).toBe(true);
    expect(account.consume("alice", "up", -5).allow).toBe(true);
    expect(account.consume("alice", "up", Number.NaN).allow).toBe(true);
    expect(account.usage("alice")).toBe(0);
  });

  it("inertUsageAccount 是显式禁用档：恒 allow 且 usage 恒零", () => {
    const inert = inertUsageAccount();
    expect(inert.consume("alice", "up", 1e12).allow).toBe(true);
    expect(inert.usage("alice")).toBe(0);
  });
});

describe("@/datasource/quota 单个合计上限、边界与「恰好等于上限」", () => {
  it("唯一上限被推过时拒绝，usage / limit 同为合计口径", () => {
    const account = accountWith({ alice: { bytes: 10 } });
    account.consume("alice", "up", 10);
    const v = account.consume("alice", "up", 1);
    expect(v.allow).toBe(false);
    expect(v.reason).toBe("quota");
    // usage / limit 必须是**同一口径的两个数**，消费方才算得出「超了多少」/「还剩多少」
    expect(v.usage).toBe(11);
    expect(v.limit).toBe(10);
  });

  it("两个方向共享同一份额度（上传吃掉的那份把下载也一起算掉）", () => {
    // 裁决：只有**一个**合计上限，故上传与下载是**同一份额度**的两半。
    // 推论：上传撞顶之后**下载同样被拒**（否则可以上传撞顶后改走下载继续白嫖），
    // 代价是该账号在当前窗口内彻底不可用 —— 这也正是**不分方向**的根由：
    // 既然分方向也封不住另一半，「只配一个方向的上限」就只是伪控制力。
    const account = accountWith({ alice: { bytes: 10 } });
    account.consume("alice", "up", 11);
    const v = account.consume("alice", "down", 1);
    expect(v.allow).toBe(false);
    expect(v.usage).toBe(12);
    expect(v.limit).toBe(10);
  });

  it("恰好等于上限 → 放行（裁决：配额是上限，不是「额度 + 1 的坑」）", () => {
    // bytes: 100 允许用户用满 100 字节，第 101 字节才拒
    const account = accountWith({ alice: { bytes: 100 } });
    expect(account.consume("alice", "up", 40).allow).toBe(true);
    expect(account.consume("alice", "down", 60).allow).toBe(true);
    expect(account.usage("alice")).toBe(100);
    const over = account.consume("alice", "down", 1);
    expect(over.allow).toBe(false);
    expect(over.usage).toBe(101);
  });

  it("usage 是合计数：两个方向的消耗加在一起（不按方向切分）", () => {
    // 判据形状是 usage 的**返回值本身**：一个数。上传 5 + 下载 7 = 12。
    // 「剩余 = bytes - usage(user)」这条减法就是靠这个单数成立的。
    const account = accountWith({ alice: { bytes: 100 } });
    account.consume("alice", "up", 5);
    account.consume("alice", "down", 7);
    expect(account.usage("alice")).toBe(12);
  });

  it("超限必须在本次就返回 allow:false（绝不允许「先放行下次再说」）", () => {
    // 上限 10：第 11 字节的那一次调用本身就必须被拒。软化语义（放行这一块、下次再拒）
    // 会让一条长连接隧道永远不触发耗尽判定，配额就成了摆设。
    const account = accountWith({ alice: { bytes: 10 } });
    const first = account.consume("alice", "up", 6);
    expect(first.allow).toBe(true);
    const crossing = account.consume("alice", "up", 100);
    expect(crossing.allow).toBe(false);
    // 累计值照实累加、不截断到上限：日志里的 usage 必须是真用量，否则运维看到的是假数字
    expect(account.usage("alice")).toBe(106);
    expect(crossing.usage).toBe(106);
  });

  it("耗尽后继续传 → 持续拒绝（不会因为「已经超了」而放行）", () => {
    const account = accountWith({ alice: { bytes: 1 } });
    expect(account.consume("alice", "up", 2).allow).toBe(false);
    expect(account.consume("alice", "up", 1).allow).toBe(false);
  });

  it("quota 缺省 month 的消费侧归一不改变本文件任何一条判定语义", () => {
    // 加了窗口之后，`consume` 的 `<=` 边界 / 累计不截断 / 账号级封禁一条未动。
    // 这里重跑一遍核心三条，证明窗口层没有偷换判定语义：
    // 用量在窗口内照常累加、恰好等于上限放行、下一字节拒绝。
    const account = accountWith({ alice: { bytes: 100 } });
    expect(account.consume("alice", "up", 40).allow).toBe(true);
    expect(account.consume("alice", "down", 60).allow).toBe(true);
    const over = account.consume("alice", "down", 1);
    expect(over.allow).toBe(false);
    expect(over.usage).toBe(101);
  });

  it("按用户分槽：两个用户各耗各的，互不影响（锁「user 不得取错」）", () => {
    const account = accountWith({
      alice: { bytes: 10 },
      bob: { bytes: 10 },
    });
    account.consume("alice", "down", 10);
    expect(account.consume("alice", "down", 1).allow).toBe(false);
    // bob 完全不受 alice 的用量影响
    expect(account.consume("bob", "down", 10).allow).toBe(true);
    expect(account.usage("alice")).toBe(11);
    expect(account.usage("bob")).toBe(10);
  });
});
