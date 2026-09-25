import { randomUUID } from "node:crypto";
import type { EventContext, EventData, EventEnvelope, EventListener, EventName } from "./types.js";

export interface EventSubscription {
  readonly disposed: boolean;
  dispose(): void;
}

export interface EventHubOptions {
  runtimeId?: string;
  onListenerError?: (err: unknown, name: EventName) => void;
  /** 显式开启 Node warning 诊断；缺省完全静默，不读取 process.env.NODE_ENV。 */
  reportListenerErrors?: boolean;
}

interface StoredEvent {
  readonly name: EventName;
  readonly context: EventContext;
  readonly data: unknown;
  readonly timestamp: number;
}

type StoredListener = (event: StoredEvent) => void;

interface ListenerRecord {
  readonly name: EventName;
  readonly once: boolean;
  active: boolean;
  readonly listener: StoredListener;
}

function reportListenerError(err: unknown, name: EventName): void {
  // 只有调用方显式开启诊断时才走 Node warning；默认不读宿主环境、不产生进程级副作用。
  try {
    const message = err instanceof Error ? err.message : "event listener failed";
    const warning = err instanceof Error ? err : new Error(message);
    process.emitWarning(warning, {
      type: "EventListenerError",
      code: "PROXY_EVENT_LISTENER_ERROR",
      detail: `listener for ${name} failed`,
    });
  } catch {
    // 诊断通道自身故障也不能影响事件发布。
  }
}

export class EventHub {
  public readonly runtimeId: string;
  private readonly listeners = new Map<EventName, Set<ListenerRecord>>();
  private readonly onListenerError: (err: unknown, name: EventName) => void;

  constructor(options: EventHubOptions = {}) {
    this.runtimeId = options.runtimeId ?? randomUUID();
    this.onListenerError =
      options.onListenerError ?? (options.reportListenerErrors ? reportListenerError : () => undefined);
  }

  /** 发布事实。listener 抛错绝不影响 publish 返回、也绝不影响其它 listener。 */
  public publish<K extends EventName>(
    name: K,
    data: EventData<K>,
    context?: Partial<EventContext>,
  ): void {
    const event: StoredEvent = {
      name,
      context: {
        ...(context ?? {}),
        runtimeId: context?.runtimeId ?? this.runtimeId,
      },
      data,
      timestamp: Date.now(),
    };
    const snapshot = [...(this.listeners.get(name) ?? [])];

    for (const record of snapshot) {
      // once 在调用前摘链，避免重入 publish 再次命中同一个 listener。
      if (record.once) {
        this.disposeRecord(record);
      }
      try {
        record.listener(event);
      } catch (err) {
        try {
          this.onListenerError(err, name);
        } catch {
          // 错误处理器也不能把发布路径变成抛错路径。
        }
      }
    }
  }

  /** 订阅。返回的 subscription 可重复 dispose，幂等 */
  public subscribe<K extends EventName>(name: K, listener: EventListener<K>): EventSubscription {
    return this.addListener(name, listener, false);
  }

  /** 一次性订阅：首次触发后自动 dispose */
  public once<K extends EventName>(name: K, listener: EventListener<K>): EventSubscription {
    return this.addListener(name, listener, true);
  }

  public listenerCount(name?: EventName): number {
    if (name !== undefined) {
      return this.listeners.get(name)?.size ?? 0;
    }
    let count = 0;
    for (const records of this.listeners.values()) {
      count += records.size;
    }
    return count;
  }

  /** 释放全部订阅。runtime.stop() 调用 */
  public removeAll(): void {
    for (const records of this.listeners.values()) {
      for (const record of records) {
        record.active = false;
      }
    }
    this.listeners.clear();
  }

  /** 组合订阅：把多个 subscription 合成一个统一 dispose */
  public static merge(subs: readonly EventSubscription[]): EventSubscription {
    const subscriptions = [...subs];
    let disposed = false;

    return {
      get disposed(): boolean {
        return disposed;
      },
      dispose(): void {
        if (disposed) {
          return;
        }
        disposed = true;
        for (const subscription of subscriptions) {
          try {
            subscription.dispose();
          } catch {
            // 一个坏掉的子订阅不能阻止其它订阅释放。
          }
        }
      },
    };
  }

  private addListener<K extends EventName>(
    name: K,
    listener: EventListener<K>,
    once: boolean,
  ): EventSubscription {
    const record: ListenerRecord = {
      name,
      once,
      active: true,
      listener: (event): void => listener(event as unknown as EventEnvelope<K>),
    };
    let records = this.listeners.get(name);
    if (records === undefined) {
      records = new Set<ListenerRecord>();
      this.listeners.set(name, records);
    }
    records.add(record);

    return {
      get disposed(): boolean {
        return !record.active;
      },
      dispose: (): void => {
        this.disposeRecord(record);
      },
    };
  }

  private disposeRecord(record: ListenerRecord): void {
    if (!record.active) {
      return;
    }
    record.active = false;
    const records = this.listeners.get(record.name);
    if (records === undefined) {
      return;
    }
    records.delete(record);
    if (records.size === 0) {
      this.listeners.delete(record.name);
    }
  }
}
