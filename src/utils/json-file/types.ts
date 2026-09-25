/**
 * @fileoverview JSON 配置文件读取器的公共类型契约
 * @module utils/json-file/types
 * @description
 * `readJsonCached` 与订阅方（config/runtime/core）之间的全部约定都收在这里：
 * 事件类型、事件载荷、读取选项、读取结果。
 *
 * 职责：
 * - 只声明**公共**契约：`JsonFileEventType` / `JsonFileEvent` /
 *   `JsonFileOptions` / `JsonFileRead`
 *
 * 不负责：
 * - **零运行时值**：本文件构建后完全擦除（与 `config/types.ts` 同约定），
 *   默认值常量住 `json-file.ts`，缓存条目与订阅者状态住 `cache.ts` / `subscriber.ts`
 * - 不做事件去重判定（`subscriber.ts`）、不做 stat 分类（`probe.ts`）、
 *   不读文件（`read-validate.ts`）、不编排（`json-file.ts`）
 */

/** 状态迁移事件类型：读失败 / 文件消失 / 恢复 / 热加载 */
export type JsonFileEventType = "error" | "missing" | "recovered" | "reloaded";

/**
 * 状态迁移事件（仅在变化时触发一次；节流命中与首次成功加载不触发）
 * @param type - 迁移类型，见 JsonFileEventType
 * @param label - 配置名（原样回传 opts.label，供订阅方呈现）
 * @param path - 文件路径
 * @param error - type === "error" 时的失败原因
 * @param mtimeMs - 触发事件的这份内容的 mtime（毫秒）；missing 事件无值（文件不存在）
 * @param size - 触发事件的这份内容的字节数；missing 事件无值
 */
export interface JsonFileEvent {
  type: JsonFileEventType;
  label: string;
  path: string;
  error?: string;
  mtimeMs?: number;
  size?: number;
}

/**
 * 读取选项
 * @param label - 配置名（事件回传用，如 `acl.json`）
 * @param fallback - 文件缺失时使用的空配置值（必须与 T 同型，且视为只读）
 * @param maxAgeMs - stat 节流窗口，默认 1000
 * @param maxBytes - 文件大小上限，默认 1MiB
 * @param force - 跳过节流强制重读（启动期校验用）
 * @param onEvent - 状态迁移事件回调；只在变化时调用。回调抛错被吞掉，绝不影响读取
 */
export interface JsonFileOptions<T> {
  label: string;
  fallback: T;
  maxAgeMs?: number;
  maxBytes?: number;
  force?: boolean;
  onEvent?: (event: JsonFileEvent) => void;
}

/**
 * 读取结果
 * @param value - 生效值（文件内容或上一份有效值或 fallback）
 * @param path - 文件路径
 * @param exists - 本轮检测时文件是否存在
 * @param error - 最近一次读取/校验失败原因；无错误为 undefined
 */
export interface JsonFileRead<T> {
  value: T;
  path: string;
  exists: boolean;
  error?: string;
}
