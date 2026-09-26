/**
 * 配置资源事件总线（Cordis-free）
 *
 * JSON 文件读取器只负责按需读取、节流和缓存；本模块把已经提交到缓存的
 * 状态迁移转成可被未来 ConfigService/config-plugin 订阅的领域事件。这里不
 * 依赖 runtime、Cordis、logger，也不携带配置值、快照或原始 Error。
 */

import {
  sanitizeJsonFileErrorText,
  type JsonFileEvent,
  type JsonFileOutcome,
  type JsonFileTransition,
} from "@/utils/file/json.js";

/** 当前可热加载的配置资源身份；同一路径的不同资源不得共享缓存/错误状态。 */
export type ConfigResource = "authUsers" | "acl";

/** 资源状态迁移。 */
export type ConfigResourceTransition = JsonFileTransition;

/** 资源状态迁移后的生效值来源。 */
export type ConfigResourceOutcome = JsonFileOutcome;

/**
 * 配置资源事件。
 *
 * 事件只描述文件状态，不携带 users/ACL 内容、密码、配置快照或原始异常。
 * `error` 已经由 JSON 读取层去敏；转换时再次做纯文本净化，避免未来发布者
 * 不小心把敏感错误原文带入总线。
 */
export interface ConfigResourceEvent {
  readonly resource: ConfigResource;
  readonly label: string;
  readonly path: string;
  readonly transition: ConfigResourceTransition;
  readonly outcome: ConfigResourceOutcome;
  readonly mtimeMs?: number;
  readonly size?: number;
  readonly error?: string;
}

/** 资源事件订阅者。异步返回也会被观察，但总线不等待它。 */
export type ConfigResourceEventListener = (event: ConfigResourceEvent) => void | Promise<void>;

/** 取消订阅；重复调用无副作用。 */
export type ConfigResourceDisposer = () => void;

/** 可注入到未来配置服务/插件的最小事件总线接口。 */
export interface ConfigResourceEventBus {
  /** 订阅全部资源，或只订阅指定资源。 */
  subscribe(
    listener: ConfigResourceEventListener,
    resource?: ConfigResource,
  ): ConfigResourceDisposer;
  /** 同步发布事实；订阅者异常不会影响发布者。 */
  emit(event: ConfigResourceEvent): void;
}

interface Subscription {
  readonly listener: ConfigResourceEventListener;
  readonly resource?: ConfigResource;
}

/** 重建事件白名单，确保总线不会转发调用者夹带的值、快照或原始 Error。 */
function sanitizeConfigResourceEvent(event: ConfigResourceEvent): ConfigResourceEvent {
  const error =
    typeof event.error === "string" ? sanitizeJsonFileErrorText(event.error) : undefined;
  return {
    resource: event.resource,
    label: event.label,
    path: event.path,
    transition: event.transition,
    outcome: event.outcome,
    ...(event.mtimeMs === undefined ? {} : { mtimeMs: event.mtimeMs }),
    ...(event.size === undefined ? {} : { size: event.size }),
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * 创建隔离的配置资源事件总线。
 *
 * 监听器集合在发布时做快照，允许订阅者在回调内取消自己或新增订阅者；异步
 * 拒绝会被吞掉，避免配置读取/请求路径产生未处理 rejection。
 */
export function createConfigResourceEventBus(): ConfigResourceEventBus {
  const subscriptions = new Set<Subscription>();

  return {
    subscribe(listener, resource) {
      const subscription: Subscription = { listener, resource };
      subscriptions.add(subscription);
      let active = true;

      return () => {
        if (!active) {
          return;
        }
        active = false;
        subscriptions.delete(subscription);
      };
    },

    emit(event) {
      const safeEvent = sanitizeConfigResourceEvent(event);
      for (const subscription of [...subscriptions]) {
        if (subscription.resource !== undefined && subscription.resource !== safeEvent.resource) {
          continue;
        }
        try {
          const result = subscription.listener(safeEvent);
          if (result !== undefined) {
            void Promise.resolve(result).catch(() => {
              // 观察者失败只影响本次观察，不得反噬配置读取。
            });
          }
        } catch {
          // 观察者失败与资源状态迁移无关，隔离在此处。
        }
      }
    },
  };
}

/** 进程内单例总线；不跨 worker/IPC 传播。 */
export const configResourceEvents = createConfigResourceEventBus();

/** 发布一个已经由读取层提交到缓存的资源事件。 */
export function publishConfigResourceEvent(event: ConfigResourceEvent): void {
  configResourceEvents.emit(event);
}

/**
 * 订阅配置资源事件。
 *
 * @param listener 事件观察者
 * @param resource 可选的资源过滤条件；省略时接收全部资源
 * @returns 幂等取消订阅函数
 */
export function subscribeConfigResourceEvents(
  listener: ConfigResourceEventListener,
  resource?: ConfigResource,
): ConfigResourceDisposer {
  return configResourceEvents.subscribe(listener, resource);
}

/** 将通用 JSON 文件事件转换为带资源身份的领域事件。 */
export function toConfigResourceEvent(
  resource: ConfigResource,
  event: JsonFileEvent,
): ConfigResourceEvent {
  const error = event.error === undefined ? undefined : sanitizeJsonFileErrorText(event.error);

  return {
    resource,
    label: event.label,
    path: event.path,
    transition: event.transition,
    outcome: event.outcome,
    ...(event.mtimeMs === undefined ? {} : { mtimeMs: event.mtimeMs }),
    ...(event.size === undefined ? {} : { size: event.size }),
    ...(error === undefined ? {} : { error }),
  };
}
