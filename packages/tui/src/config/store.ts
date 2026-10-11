/**
 * @fileoverview 配置服务：装载出的**活配置**——`get` / `set` / `reload` 三件套
 * @module config/store
 * @description `set` 只改内存（回写会吃掉 `.jsonc` 的注释与排版，不干）；`reload` 重读文件，内存改过的一并丢弃。
 * `get` 交出的对象**深冻结**（配置是纯数据）：要改就 `set`，拿着快照乱写会当场报错。
 */

import { loadTuiConfig } from "./loader.js";
import type { TuiConfig } from "./types.js";

/** 深冻结（纯数据，冻到叶子） */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export class ConfigStore {
  private current: TuiConfig;
  private sourceFile: string;

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

  /** 改一格（只改内存，不写盘；值此后同样被深冻结） */
  set<K extends keyof TuiConfig>(key: K, value: TuiConfig[K]): void {
    this.current = deepFreeze({ ...this.current, [key]: value });
  }

  /** 重读文件重算默认（内存里 `set` 过的一并丢弃）；文件坏了即抛，当前配置不动 */
  reload(): void {
    const loaded = loadTuiConfig();
    this.sourceFile = loaded.file;
    this.current = deepFreeze(loaded.config);
  }
}
