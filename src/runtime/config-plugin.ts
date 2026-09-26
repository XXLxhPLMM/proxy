import type { Context, Plugin } from "cordis";
import { sanitizeJsonFileErrorText } from "@/utils/file/json.js";
import type { EventDispatcher, EventPayload } from "./event-dispatch.js";
import {
  CONFIG_FAILED_EVENT,
  CONFIG_LOADED_EVENT,
  CONFIG_RELOADED_EVENT,
  CONFIG_RESOURCE_EVENT,
  type ConfigFailedEvent,
  type ConfigResourceEvent,
  type RuntimeEventName,
} from "./events.js";
import type { ConfigService, ConfigServiceEvent } from "./config-service.js";
import {
  subscribeConfigResourceEvents,
  type ConfigResourceEvent as DomainConfigResourceEvent,
} from "@/config/resources/events.js";

function toConfigResourceEvent(event: DomainConfigResourceEvent): ConfigResourceEvent {
  const error = event.error === undefined ? undefined : sanitizeJsonFileErrorText(event.error);
  return {
    resource: event.resource,
    path: event.path,
    transition: event.transition,
    outcome: event.outcome,
    ...(event.mtimeMs === undefined ? {} : { mtimeMs: event.mtimeMs }),
    ...(event.size === undefined ? {} : { size: event.size }),
    ...(error === undefined ? {} : { error }),
  };
}

function toConfigFailedEvent(
  event: Extract<ConfigServiceEvent, { type: "failed" }>,
): ConfigFailedEvent {
  const { failure } = event;
  return {
    operation: failure.operation,
    error: {
      name: failure.name,
      ...(failure.code === undefined ? {} : { code: failure.code }),
      message: failure.message,
    },
    retained: failure.retained,
  };
}

function canPublish(ctx: Context, dispatcher: EventDispatcher, active: () => boolean): boolean {
  try {
    if (!active() || !dispatcher.active) {
      return false;
    }
    ctx.fiber.assertActive();
    return dispatcher.active;
  } catch {
    return false;
  }
}

function publishSafely<K extends RuntimeEventName>(
  dispatcher: EventDispatcher,
  event: K,
  payload: EventPayload<K>,
): void {
  try {
    void Promise.resolve(dispatcher.dispatch(event, payload)).catch(() => {
      // 失败由 runtime failure observer 统一消费；不得递归发布 error/observed。
      // 观察者失败不得反噬已经提交的配置事实。
    });
  } catch {
    // 防御第三方 dispatcher 违反非拒绝契约。
  }
}

function publishResource(
  ctx: Context,
  dispatcher: EventDispatcher,
  active: () => boolean,
  event: ConfigResourceEvent,
): void {
  if (!canPublish(ctx, dispatcher, active)) {
    return;
  }
  publishSafely(dispatcher, CONFIG_RESOURCE_EVENT, event);
}

function publishServiceEvent(
  ctx: Context,
  dispatcher: EventDispatcher,
  active: () => boolean,
  event: ConfigServiceEvent,
): void {
  if (!canPublish(ctx, dispatcher, active)) {
    return;
  }
  switch (event.type) {
    case "reloaded":
      publishSafely(dispatcher, CONFIG_RELOADED_EVENT, {
        scope: "runtime",
        changed: event.changed,
      });
      return;
    case "failed":
      publishSafely(dispatcher, CONFIG_FAILED_EVENT, toConfigFailedEvent(event));
      return;
    case "loaded":
      // loaded 由 plugin mount 根据 service 的真实 load 状态补发；服务事件
      // 订阅不会重放历史事件，避免把 mount 伪装成一次新的 load。
      return;
  }
}

/**
 * 提供已经完成初始化的配置服务，并把配置领域事实接到 Cordis。
 *
 * `config/resources/events` 是 pull 模型的通知总线；本 plugin 只转发安全元数据，资源
 * 消费方仍通过 reader/ConfigService 按需读取。所有 Cordis 发布都交给组合根
 * 注入的 EventDispatcher；订阅和 service 事件桥都登记在 ctx.effect 中，
 * Context 停止后不会向已销毁的 Context 发布。
 */
export function createConfigPlugin(
  service: ConfigService,
  dispatcher: EventDispatcher,
): Plugin.Object<void> {
  return {
    name: "config-service",
    apply(ctx: Context) {
      if (service.state !== "ready") {
        throw new Error("config service must be loaded before plugin registration");
      }
      ctx.provide("config", service);

      let active = true;
      // 标记属于本次 plugin apply（因而属于当前 root Context），不做进程级去重。
      let loadedPublished = false;
      ctx.effect(() => {
        const disposeServiceEvents = service.subscribe((event) => {
          publishServiceEvent(ctx, dispatcher, () => active, event);
        });
        const disposeResourceEvents = subscribeConfigResourceEvents((event) => {
          publishResource(ctx, dispatcher, () => active, toConfigResourceEvent(event));
        });
        return () => {
          active = false;
          disposeServiceEvents();
          disposeResourceEvents();
        };
      }, "config event subscriptions");

      if (!loadedPublished && canPublish(ctx, dispatcher, () => active)) {
        const preset = service.activePreset();
        loadedPublished = true;
        publishSafely(dispatcher, CONFIG_LOADED_EVENT, {
          operation: "load",
          ...(preset === "" ? {} : { preset }),
        });
      }
    },
  };
}

declare module "cordis" {
  interface Context {
    config: ConfigService;
  }
}
