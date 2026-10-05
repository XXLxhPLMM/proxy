import { EventHub } from "@/core/events/index.js";
import type { EventContext, EventName } from "@/core/events/index.js";
import type { CoreContext } from "@/core/context.js";
import { testConfig, testLogger } from "../../../helpers/config.js";

/**
 * 桥接三档共用的观测面：一条协议常量 + 一个记录器 + 两个依赖/总线工厂
 *
 * @description
 * 三档钉的是**同一张事件契约的不同半边**（core 直发的事实 / 桥接映射 / 边界与清理），
 * 所以「记哪些名字」「context 从哪来」「runtimeId 是哪个」必须逐字一致 —— 三份拷贝里
 * 只要有一份漂了（改了 runtimeId、少记一个名字），三档就会在不同的观测面上互相打架，
 * 而那种不一致在单档视角下完全看不出来。
 *
 * ⚠️ `PROTOCOL` 是**构造期**那个值：桥接器重建 context 时恒取它，不是载荷里的
 * `protocol`（载荷那个是 pipe 变体自报的，见 `bridge.ts`）。
 */
export const PROTOCOL = "http";

/** 本目录里 bridge 仍会发布的公共事件（core 直发的那几类不在其中）。 */
export const BRIDGED: readonly EventName[] = [
  "access.client-denied",
  "access.target-denied",
  "route.selected",
  "request.rejected",
];

export interface Recorded {
  name: EventName;
  data: unknown;
  context: EventContext;
}

/** 逐个订阅并把信封摊平成可 `toEqual` 的三元组（断言要逐键比 data 与 context）。 */
export function recordAll(hub: EventHub, names: readonly EventName[] = BRIDGED): Recorded[] {
  const events: Recorded[] = [];
  for (const name of names) {
    hub.subscribe(name, (event) => {
      events.push({ name: event.name, data: event.data, context: event.context });
    });
  }
  return events;
}

/** 依赖上下文：配置/日志用测试共享实例（setup-env 已钉死名单与账号路径），总线每例独立。 */
export function contextFor(hub: EventHub): CoreContext {
  return Object.freeze({ config: testConfig, logger: testLogger, events: hub });
}

export function newHub(): EventHub {
  return new EventHub({ runtimeId: "runtime-bridge", onListenerError: () => undefined });
}