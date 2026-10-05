/**
 * 事件面：`access.target-denied` 的 `source` 怎么被 bridge 转述
 *
 * 这一族是「分层信息只走独立 `source` 字段」那条纪律的**消费者那一半**：bridge 对 `reason`
 * 原样透传、`source` 缺失即跳过（**绝不倒填成 `global`**）。生产者那一半（内置引擎不产
 * `"user:blacklist"` 之类拼接式 reason）在 `user-merge-matrix.test.ts` 的源码级断言 ——
 * 两半合起来才是「缺失即跳过、绝不臆造」，任何一半失效另一半都还在。
 *
 * @module tests/unit/core/access-control/user-merge-event
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventHub } from "@/core/events/index.js";
import type { EventEnvelope, EventName } from "@/core/events/index.js";
import type { CoreContext } from "@/core/context.js";
import type { PipeEvent } from "@/core/types/proxy.js";
import { CoreEventBridge } from "@/runtime/bridge.js";
import { testConfig, testLogger } from "../../../helpers/config.js";
import { USER } from "./_user-acl-merge.js";

describe("事件面/access.target-denied 的 source", () => {
  const PROTOCOL = "http";
  let hub: EventHub;
  let ctx: CoreContext;
  let bridge: CoreEventBridge;
  let events: EventEnvelope<EventName>[];

  beforeEach(() => {
    hub = new EventHub({ onListenerError: () => undefined });
    ctx = { config: testConfig, logger: testLogger, events: hub };
    events = [];
    for (const name of ["access.target-denied"] as const) {
      hub.subscribe(name, (e) => {
        events.push(e as EventEnvelope<EventName>);
      });
    }
    bridge = new CoreEventBridge({ hub, protocol: PROTOCOL });
    bridge.attach(ctx);
  });

  afterEach(() => {
    bridge.subscription.dispose();
  });

  it("personal 拒绝的 source=user 原样透传（且 reason 仍是闭合集合那一档）", () => {
    hub.publish("pipe", {
      type: "target-denied",
      target: "target.test:80",
      host: "target.test",
      reason: "blacklist",
      source: "user",
      user: USER,
    } satisfies PipeEvent);

    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("access.target-denied");
    expect(events[0].data).toEqual({
      host: "target.test",
      target: "target.test:80",
      reason: "blacklist",
      source: "user",
    });
  });

  it("分层信息仍不许塞进 reason：内置引擎不产这种值，bridge 也原样透传不加工", () => {
    // bridge 对 reason 是**原样透传**（`runtime/bridge.ts:passthroughReason`）：静默丢事件比字段
    // 缺失更坏——字段缺失至少还有一条已发布事件可查，整条不发布连「发生过一次拒绝」都没了，
    // 且没有任何报错。所以「分层信息不许塞进 reason」这条纪律的**落点在生产者，不在消费者**：
    // ① `user-merge-matrix.test.ts` 的源码级断言锁住生产者（`hostDenied` 只返回两个字面量、
    //    不出现拼接式 reason、写出的 `source:` 恰为 {global,user}）；
    // ② 下面这两条锁住消费者只做「缺失即跳过、绝不臆造」，对表外值**不加工**。
    // 换句话说：内置引擎做不到的事，由源码断言拦；外部引擎做的事，bridge 忠实转述。
    hub.publish("pipe", {
      type: "target-denied",
      target: "target.test:80",
      host: "target.test",
      reason: "user:blacklist",
    } as unknown as PipeEvent);
    hub.publish("pipe", {
      type: "target-denied",
      target: "target.test:80",
      host: "target.test",
      reason: "blacklist",
      source: "user",
    } satisfies PipeEvent);

    // 两条输入产出两条事件，reason **逐字原样**到达（bridge 不改写、不丢弃）
    expect(events).toHaveLength(2);
    expect(events[0].data).toMatchObject({ reason: "user:blacklist" });
    expect(events[0].data).not.toHaveProperty("source");
    expect(events[1].data).toMatchObject({ reason: "blacklist", source: "user" });
  });

  it("source 缺失就不写该键、绝不倒填成 global（宁可让订阅者知道「未知」）", () => {
    hub.publish("pipe", {
      type: "target-denied",
      target: "target.test:80",
      host: "target.test",
      reason: "blacklist",
    } satisfies PipeEvent);
    hub.publish("pipe", {
      type: "target-denied",
      target: "target.test:80",
      host: "target.test",
      reason: "blacklist",
      source: "geoip",
    } as unknown as PipeEvent);

    expect(events).toHaveLength(2);
    // 缺失 → 键不存在（**不是** `"global"`、也不是 `undefined` 占位）
    expect(events[0].data).not.toHaveProperty("source");
    // 表外来源原样透传，但同样绝不被改写成 global —— 运维去改错文件的代价太高
    expect(events[1].data).toMatchObject({ source: "geoip" });
    expect(events[1].data).not.toMatchObject({ source: "global" });
  });
});