/**
 * @fileoverview JSON 配置文件读取器的公共类型契约
 * @module utils/json-file/types
 * @description
 * `readJsonCached` 与订阅方（config/runtime/core）之间的全部约定都收在这里：
 * 事件类型、事件载荷、读取选项、读取结果——**只声明公共契约**，零实现细节。
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
 * @param onMissing - **判定为「文件不存在」那一刻**的回调（节流命中路径不调，故同一次缺失只调一次）。
 *   存在的理由是「缺失」在不同后端有**不同含义**：json 档的缺失就是「没配」，而 sqlite 档的缺失
 *   意味着「库还没建表」——后者需要有人把目标物化出来。读层只负责如实报告这个事实，
 *   **绝不自己创建**：骨架内容是业务知识，属于数据源层。
 *
 *   回调可以**返回一句错误说明**：物化失败（只读文件系统 / 父路径是普通文件 / 权限不足）时它
 *   会被挂到读取结果的 `error` 上，而读取**照常返回 fallback**。这条是为了不把「配了一个
 *   建不出来的库」伪装成「就是没有账号」——两者的返回值完全一样，只有 error 能分开。
 *   回调抛错等价于返回错误说明（同样不打断读取）。
 */
export interface JsonFileOptions<T> {
  label: string;
  fallback: T;
  maxAgeMs?: number;
  maxBytes?: number;
  force?: boolean;
  onEvent?: (event: JsonFileEvent) => void;
  onMissing?: (absolutePath: string) => string | void;
}

/**
 * 读取结果
 * @param value - 生效值（文件内容或上一份有效值或 fallback）
 * @param error - 最近一次读取/校验失败原因；无错误为 undefined
 */
export interface JsonFileRead<T> {
  value: T;
  path: string;
  exists: boolean;
  error?: string;
}
