/**
 * 配置资源强制 pull 端口 - ConfigService 的对外读法
 *
 * 原先这段逻辑混在 `loader.ts` 里，但它和「加载配置」无关：它只做一件事——
 * 强制重读一个 JSON 资源，并把结果降级成**脱敏的状态元数据**（路径、存在性、
 * transition/outcome、mtime/size、去敏错误），不返回 users/ACL 内容。
 *
 * 归属 resources/ 而不是 load.ts，是因为它消费的是资源的 force 读取语义
 * （last-good/fallback + 事件），与启动期候选构造、runtime patch 校验无关。
 */
import { sanitizeJsonFileErrorText } from "@/utils/file/json.js";

import { readAcl } from "./acl/reader.js";
import { readAuthUsers } from "./users/reader.js";
import {
  subscribeConfigResourceEvents,
  type ConfigResource,
  type ConfigResourceEvent,
  type ConfigResourceOutcome,
  type ConfigResourceTransition,
} from "./events.js";

/** force pull 的安全结果；不把 reader 返回的 users/ACL 值带到 runtime。 */
export interface ConfigResourceReadResult {
  readonly resource: ConfigResource;
  readonly path: string;
  readonly exists: boolean;
  readonly transition?: ConfigResourceTransition;
  readonly outcome?: ConfigResourceOutcome;
  readonly mtimeMs?: number;
  readonly size?: number;
  readonly error?: string;
}

function safeResourceError(value: unknown): string {
  return typeof value === "string" ? sanitizeJsonFileErrorText(value) : "未知错误";
}

function readErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    try {
      const message = (error as { message?: unknown }).message;
      return typeof message === "string" ? message : "未知错误";
    } catch {
      return "未知错误";
    }
  }
  return "未知错误";
}

/** 观察到的本轮状态元数据展开成 DTO 字段。 */
function observedFields(observed: ConfigResourceEvent | undefined): Partial<ConfigResourceReadResult> {
  return {
    ...(observed === undefined
      ? {}
      : { transition: observed.transition, outcome: observed.outcome }),
    ...(observed?.mtimeMs === undefined ? {} : { mtimeMs: observed.mtimeMs }),
    ...(observed?.size === undefined ? {} : { size: observed.size }),
  };
}

/**
 * 强制 pull 一个配置资源并返回脱敏状态元数据。
 *
 * 读取仍完全委托 users/acl 的 force 路径；这里只临时观察 resource
 * bridge 以保留本轮 transition/version，且在返回前取消订阅，不创建 watcher。
 */
export function refreshConfigResource(
  resource: ConfigResource,
  path: string,
): ConfigResourceReadResult {
  let observed: ConfigResourceEvent | undefined;
  const dispose = subscribeConfigResourceEvents((event) => {
    if (event.resource === resource && event.path === path) {
      observed = event;
    }
  }, resource);

  try {
    if (resource === "authUsers") {
      const read = readAuthUsers({ force: true, path });
      const error = read.error ?? observed?.error;
      return {
        resource,
        path: read.path,
        exists: read.exists,
        ...(error === undefined ? {} : { error: safeResourceError(error) }),
        ...observedFields(observed),
      };
    }

    const read = readAcl({ force: true, path });
    const error = read.error ?? observed?.error;
    return {
      resource,
      path: read.path,
      exists: read.exists,
      ...(error === undefined ? {} : { error: safeResourceError(error) }),
      ...observedFields(observed),
    };
  } catch (error) {
    // reader 当前设计为不抛；保留安全兜底，避免未来实现泄漏原始异常。
    return {
      resource,
      path,
      exists: false,
      error: safeResourceError(readErrorMessage(error)),
      ...observedFields(observed),
    };
  } finally {
    dispose();
  }
}
