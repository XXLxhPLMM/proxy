/**
 * 配置 JSON 热加载事件 → 日志呈现
 *
 * 这里是唯一的配置资源 notice 订阅者：auth-users/acl 只把已提交的 JSON
 * 事件桥到 resource-events，本模块统一渲染一次。资源总线本身不依赖 logger，
 * 因而未来 ConfigService/config-plugin 可以独立订阅而不会形成日志副作用。
 */

import { getLogger } from "@/utils/logger.js";
import { sanitizeJsonFileErrorText, type JsonFileEvent } from "@/utils/json-file.js";
import {
  publishConfigResourceEvent,
  subscribeConfigResourceEvents,
  toConfigResourceEvent,
  type ConfigResource,
  type ConfigResourceEvent,
} from "./resource-events.js";

/** 配置热加载日志（模块级单例，前缀 [proxy]:config） */
const log = getLogger("config");

/**
 * 把一个资源事件渲染为 notice 日志。
 *
 * @param evt - 已经去敏的资源状态事件
 */
export function logJsonFileEvent(evt: ConfigResourceEvent): void {
  // pid 供控制台区分进程；落盘通道 pid 是保留键（logger 自动写真实进程号），同值覆盖无副作用
  const fields: Record<string, unknown> = { pid: process.pid };
  if (evt.mtimeMs !== undefined) {
    fields.mtimeMs = evt.mtimeMs;
  }
  if (evt.size !== undefined) {
    fields.size = evt.size;
  }

  if (evt.transition === "error") {
    const suffix = evt.outcome === "retained" ? "沿用上一份有效配置" : "回退空配置";
    const error = evt.error === undefined ? "未知错误" : sanitizeJsonFileErrorText(evt.error);
    log.notice(
      "warn",
      `[config] ${evt.label} 读取失败: ${evt.path}: ${error}（${suffix}）`,
      fields,
    );
  } else if (evt.transition === "missing") {
    const suffix = evt.outcome === "retained" ? "沿用上一份有效配置" : "回退空配置";
    log.notice("warn", `[config] ${evt.label} 文件消失: ${evt.path}（${suffix}）`, fields);
  } else if (evt.transition === "recovered") {
    log.notice("info", `[config] ${evt.label} 已恢复: ${evt.path}`, fields);
  } else {
    log.notice("info", `[config] ${evt.label} 已热加载: ${evt.path}`, fields);
  }
}

/**
 * 创建 JSON 读取器到配置资源总线的桥。
 *
 * 读取器已经先提交缓存；这里只发布元数据，不直接写日志，因此未来其它订阅者
 * 与现有 notice 观察者看到的是同一份事实，且不会产生第二条日志路径。
 */
export function createJsonFileEventBridge(
  resource: ConfigResource,
): (event: JsonFileEvent) => void {
  return (event) => {
    publishConfigResourceEvent(toConfigResourceEvent(resource, event));
  };
}

// 唯一日志订阅：模块加载时安装一次，事件总线的其它观察者不会触发第二条日志。
subscribeConfigResourceEvents(logJsonFileEvent);
