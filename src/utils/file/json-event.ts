/**
 * JSON 资源状态迁移事件 - 对外契约（config 层订阅、runtime 资源事件桥消费）
 * 职责：
 * - 定义四种状态迁移（`error`/`missing`/`recovered`/`reloaded`）与三种生效值来源
 *   （`adopted`/`retained`/`fallback`）的**唯一**类型源
 * - `makeJsonFileEvent` 构造事件对象、`emitJsonFileEvent` 发布（订阅方抛错被吞）
 * 设计：
 * - 事件只携带**标量元数据**（路径、状态、版本、去敏错误文本），绝不携带解析值、密码、
 *   配置快照或原始 `Error`——这是「事件不外泄内容」的机器可查边界
 * - 版本标识（`mtimeMs`/`size`）只在能 stat 到内容时带；`missing` 无版本号
 * - **发布发生在缓存条目提交之后**：订阅者回调内再次 pull 必须看到本轮已提交状态
 * - 绝不抛：订阅方同步异常与异步拒绝都吞掉，保证读取路径不外溢
 */

/** 状态迁移事件类型：读失败 / 文件消失 / 恢复 / 热加载 */
export type JsonFileTransition = "error" | "missing" | "recovered" | "reloaded";

/** 状态迁移后生效值的来源。 */
export type JsonFileOutcome = "adopted" | "retained" | "fallback";

/**
 * 状态迁移事件（仅在变化时触发一次；节流命中与首次成功加载不触发）。
 * @param transition - 迁移类型，见 JsonFileTransition
 * @param label - 配置名（原样回传 opts.label，供订阅方呈现）
 * @param path - 文件路径
 * @param outcome - 本轮生效值是采用新值、保留旧值还是回退 fallback
 * @param error - transition === "error" 时的去敏失败文本
 * @param mtimeMs - 触发事件的这份内容的 mtime（毫秒）；missing 或无法 stat 时无值
 * @param size - 触发事件的这份内容的字节数；missing 或无法 stat 时无值
 * @param resource - 可选资源身份；由 config 资源桥补齐
 */
export interface JsonFileEvent {
  readonly transition: JsonFileTransition;
  readonly label: string;
  readonly path: string;
  readonly outcome: JsonFileOutcome;
  readonly error?: string;
  readonly mtimeMs?: number;
  readonly size?: number;
  readonly resource?: string;
}

/** 事件订阅回调；返回 Promise 也会被隔离（异步拒绝不得影响读取）。 */
export type JsonFileEventSink = (event: JsonFileEvent) => void | Promise<void>;

/** 构造事件所需的最小元数据（避免事件模块反向依赖读取选项的泛型）。 */
export interface JsonFileEventMeta {
  label: string;
  resource?: string;
}

/** 事件可用的版本标识（来自 stat）。 */
export interface JsonFileVersion {
  mtimeMs: number;
  size: number;
}

/**
 * 构造事件对象。事件只接收标量元数据，避免把解析值或原始异常带出缓存层。
 * @param meta - label 与可选 resource（原样回传，不做加工）
 * @param path - 文件路径
 * @param transition - 迁移类型
 * @param outcome - 本轮生效值来源
 * @param error - 已去敏的失败文本（可选）
 * @param version - stat 得到的版本标识；`missing` 或无法 stat 时省略
 */
export function makeJsonFileEvent(
  meta: JsonFileEventMeta,
  path: string,
  transition: JsonFileTransition,
  outcome: JsonFileOutcome,
  error?: string,
  version?: JsonFileVersion,
): JsonFileEvent {
  return {
    transition,
    label: meta.label,
    path,
    outcome,
    ...(meta.resource === undefined ? {} : { resource: meta.resource }),
    ...(error === undefined ? {} : { error }),
    ...(version === undefined ? {} : { mtimeMs: version.mtimeMs, size: version.size }),
  };
}

/**
 * 抛出状态迁移事件；订阅方回调抛错或异步拒绝不得影响读取。
 * @param onEvent - 订阅回调（可选）
 * @param event - 事件
 */
export function emitJsonFileEvent(
  onEvent: JsonFileEventSink | undefined,
  event: JsonFileEvent,
): void {
  if (onEvent === undefined) {
    return;
  }
  try {
    const result = onEvent(event);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {
        // 订阅方故障与读取无关：吞掉，保证读取路径绝不外抛。
      });
    }
  } catch {
    // 订阅方故障与读取无关：吞掉，保证读取路径绝不外抛。
  }
}
