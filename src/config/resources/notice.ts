/**
 * 配置 JSON 热加载事件 → 日志呈现
 *
 * 这里是唯一的配置资源 notice 订阅者：`users/` 与 `acl/` 只把已提交的 JSON
 * 事件桥到 `events.ts` 的总线，本模块统一渲染一次。资源总线本身不依赖 logger，
 * 因而 ConfigService/config-plugin 可以独立订阅而不会形成日志副作用。
 */

import { getLogger } from "@/utils/log/logger.js";
import { sanitizeJsonFileErrorText } from "@/utils/file/json.js";
import { subscribeConfigResourceEvents, type ConfigResource, type ConfigResourceEvent, type ConfigResourceOutcome } from "./events.js";

/** 配置热加载日志（模块级单例，前缀 [proxy]:config） */
const log = getLogger("config");

/**
 * 生效值来源的中文后缀：`retained` = 沿用上一份（**仍在生效**），其余 = 回退空配置（**当前不生效**）。
 */
function outcomeSuffix(outcome: ConfigResourceOutcome): string {
  return outcome === "retained" ? "沿用上一份有效配置" : "回退空配置";
}

/**
 * 「该资源当前不生效」的可操作说明：说清安全语义变了什么、期望路径来自哪个配置键、怎么恢复。
 * @param resource - 资源身份（决定缺的是哪个文件、以及不生效意味着放行还是全拒）
 * @param filePath - 期望的文件路径（来自 store 的 `ACL_FILE` / `AUTH_USERS_FILE`）
 */
function inactiveResourceClause(resource: ConfigResource, filePath: string): string {
  if (resource === "acl") {
    // ACL 语义是 fail-open：文件没了不拦任何请求，运维必须一眼看出「名单没在生效」
    return `访问控制当前未生效（所有请求全部放行）；恢复办法：按 ACL_FILE=${filePath} 重新创建该文件（模板 cfg/acl.json.example），恢复后 1s 内自动热加载，无需重启`;
  }
  return `账号表当前为空表（启用 basic/uid 鉴权时所有请求都会被拒绝）；恢复办法：按 AUTH_USERS_FILE=${filePath} 重新创建该文件（模板 cfg/users.json.example），恢复后 1s 内自动热加载，无需重启`;
}

/**
 * 把一个资源事件渲染为 notice 日志。
 *
 * 严重度只由**生效值来源**决定，不与「哪个资源」混在一起：
 * - `retained`（沿用上一份）：名单/账号表仍在生效，warn 足够；
 * - 回退空配置：该资源**当前不生效**，一律 error——ACL 侧等于访问控制静默全放行，
 *   账号表侧等于空表全拒，两种都是必须立刻处置的状态，必须带可操作说明。
 * 读取失败（`error` 迁移）与文件消失（`missing` 迁移）各走各的文案，不混成一条。
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

  const suffix = outcomeSuffix(evt.outcome);
  /** 当前生效值来自空配置 = 该资源不生效（ACL 全放行 / 账号表全拒） */
  const inactive = evt.outcome !== "retained";
  const level = inactive ? "error" : "warn";
  /** 不生效时才追加可操作说明；沿用上一份时重复说明只会稀释日志 */
  const clause = inactive ? `；${inactiveResourceClause(evt.resource, evt.path)}` : "";

  if (evt.transition === "error") {
    const error = evt.error === undefined ? "未知错误" : sanitizeJsonFileErrorText(evt.error);
    log.notice(level, `[config] ${evt.label} 读取失败: ${evt.path}: ${error}（${suffix}）${clause}`, fields);
  } else if (evt.transition === "missing") {
    log.notice(level, `[config] ${evt.label} 文件消失: ${evt.path}（${suffix}）${clause}`, fields);
  } else if (evt.transition === "recovered") {
    log.notice("info", `[config] ${evt.label} 已恢复: ${evt.path}`, fields);
  } else {
    log.notice("info", `[config] ${evt.label} 已热加载: ${evt.path}`, fields);
  }
}

// 唯一日志订阅：模块加载时安装一次，事件总线的其它观察者不会触发第二条日志。
subscribeConfigResourceEvents(logJsonFileEvent);
