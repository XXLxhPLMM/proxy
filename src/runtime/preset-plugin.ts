import type { Context, Plugin } from "cordis";
import type { ConfigKey } from "@/config/store.js";
import { PRESET_APPLIED_EVENT, type PresetSelectedEvent } from "./events.js";
import type { EventDispatcher } from "./event-dispatch.js";
import type { ConfigService } from "./config-service.js";
import type { PresetService } from "./preset-service.js";

function canPublish(ctx: Context, dispatcher: EventDispatcher): boolean {
  try {
    if (!dispatcher.active) {
      return false;
    }
    ctx.fiber.assertActive();
    return dispatcher.active;
  } catch {
    return false;
  }
}

function publishSafely(dispatcher: EventDispatcher, event: PresetSelectedEvent): void {
  try {
    void Promise.resolve(dispatcher.dispatch(PRESET_APPLIED_EVENT, event)).catch(() => {
      // 失败由 runtime failure observer 统一消费；不得递归发布 error/observed。
      // preset 观察者失败不能阻止已经完成的配置启动。
    });
  } catch {
    // 防御第三方 dispatcher 违反非拒绝契约。
  }
}

/**
 * 暴露当前 preset 服务，并通过组合根注入的 EventDispatcher 发布一次配置事实。
 * preset 的读取和校验由 ConfigService/loader 完成，本 plugin 不加载插件列表。
 */
export function createPresetPlugin(
  config: ConfigService,
  preset: PresetService,
  dispatcher: EventDispatcher,
): Plugin.Object<void> {
  return {
    name: "preset-service",
    inject: ["config"],
    apply(ctx: Context) {
      if (config.state !== "ready") {
        throw new Error("config service must be loaded before preset registration");
      }
      ctx.provide("preset", preset);
      // 一次性语义限定在本次 plugin apply/root Context；不做进程级去重。
      let applied = false;
      const applyOnce = (): void => {
        if (applied) {
          return;
        }
        const definition = preset.get();
        if (!definition || !canPublish(ctx, dispatcher)) {
          return;
        }
        const event = {
          name: definition.name,
          keys: Object.keys(definition.config) as ConfigKey[],
          plugins: [...definition.plugins],
        } satisfies PresetSelectedEvent;
        applied = true;
        publishSafely(dispatcher, event);
      };
      applyOnce();
    },
  };
}

declare module "cordis" {
  interface Context {
    preset: PresetService;
  }
}
