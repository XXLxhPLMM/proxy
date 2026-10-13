/**
 * @fileoverview 配置服务：装载出的**活配置**——`get` / `set` / `reload` 三件套 + `onReload` 订阅
 * @module config/store
 * @description `set` 只改内存（回写会吃掉 `.jsonc` 的注释与排版，不干）；`reload` 重读文件，内存改过的一并丢弃。
 * `get` 交出的对象**深冻结**（配置是纯数据）：要改就 `set`，拿着快照乱写会当场报错。
 * 每次 `reload` **成功**后向 `onReload` 的订阅者发一份 {@link ConfigReload}（换前 / 换后快照 + 这次变了的顶层节），
 * 是「重读完再各自动作」的接线点：谁把它转成树上的事件、谁监听，归 `starter/plugins/config/`。
 */

import { deepEqual, deepFreeze } from "@/lib/obj-util.js";
import { loadTuiConfig } from "./loader.js";
import type { TuiConfig } from "./types.js";

/** 一次 `reload` 换掉的东西（订阅者拿到的载荷） */
export interface ConfigReload {
  /** 重读前的配置（冻结快照） */
  prev: TuiConfig;
  /** 重读后的配置（冻结快照；与 `store.get()` 是同一份） */
  next: TuiConfig;
  /** 这次取值有变的顶层节（逐节深比较；空数组 = 文件重读后其实没变化，事件照样发） */
  changed: (keyof TuiConfig)[];
}

export class ConfigStore {
  private current: TuiConfig;
  private sourceFile: string;
  private listeners = new Set<(event: ConfigReload) => void>();

  private constructor(file: string, config: TuiConfig) {
    this.sourceFile = file;
    this.current = deepFreeze(config);
  }

  /** 装载：定位配置文件（缺则建空文件）→ 读 → 校验合并；文件坏了即抛（= 启动失败） */
  static load(): ConfigStore {
    const loaded = loadTuiConfig();
    return new ConfigStore(loaded.file, loaded.config);
  }

  /** 当前配置来自哪个文件（`config.json` 优先、其次 `config.jsonc`） */
  get file(): string {
    return this.sourceFile;
  }

  /** 当前全量配置（冻结快照） */
  get(): TuiConfig;
  /** 取一格（如 `get("database")` → 开库契约 `DbConfig`） */
  get<K extends keyof TuiConfig>(key: K): TuiConfig[K];
  get(key?: keyof TuiConfig): TuiConfig | TuiConfig[keyof TuiConfig] {
    return key === undefined ? this.current : this.current[key];
  }

  /** 改一格（只改内存，不写盘；值此后同样被深冻结）；⚠️ 不发 reload 事件（内存改动，调用方自己知道） */
  set<K extends keyof TuiConfig>(key: K, value: TuiConfig[K]): void {
    this.current = deepFreeze({ ...this.current, [key]: value });
  }

  /** 订阅 `reload`：每次重读**成功**后收到一份 {@link ConfigReload}；返回**取消订阅**。
   * ⚠️ `reload` 抛了（坏文件）不发——当前配置没动；监听里抛的错会直接传给 `reload` 的调用方 */
  onReload(listener: (event: ConfigReload) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 重读文件重算默认（内存里 `set` 过的一并丢弃）；文件坏了即抛，当前配置不动 */
  reload(): void {
    const prev = this.current;
    const loaded = loadTuiConfig();
    const next = deepFreeze(loaded.config);
    this.sourceFile = loaded.file;
    this.current = next;
    const changed = (Object.keys(next) as (keyof TuiConfig)[]).filter(
      (key) => !deepEqual(prev[key], next[key]),
    );
    // 派发时拷一份监听器集合：监听器可以在回调里自行订阅 / 退订
    for (const listener of [...this.listeners]) {
      listener({ prev, next, changed });
    }
  }
}
