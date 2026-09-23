/**
 * 配置 JSON 热加载事件 → 日志呈现
 * 职责：
 * - 把 utils/json-file 抛出的状态迁移事件（error/missing/recovered/reloaded）渲染为 notice 日志
 * 设计：
 * - 呈现层留在 config：utils/json-file 不依赖 logger，文案/等级只在这里定义，订阅方式 = 直接传函数引用
 * - 一律走 logger.notice：配置可见性是操作者必须看见的事实（默认 error 级控制台也可见，silent 硬关闭）
 * - 兜底可见性：ACL 文件「存在 → 缺失」等于静默全放行，missing 事件必须至少留一条 warn
 * - 每行带 pid 与 mtimeMs/size：cluster 下每个 worker 独立热加载、各打一行（不去重不聚合），
 *   pid 区分进程，版本字段区分「同版本被 N 进程加载」与「文件被改了 N 次」
 */

import { getLogger } from "@/utils/logger.js";
import type { JsonFileEvent } from "@/utils/json-file.js";

/** 配置热加载日志（模块级单例，前缀 [proxy]:config） */
const log = getLogger("config");

/**
 * 订阅 readJsonCached 的状态迁移事件并落日志
 * @param evt - 状态迁移事件
 * @example readJsonCached(p, validate, { label, fallback, onEvent: logJsonFileEvent })
 */
export function logJsonFileEvent(evt: JsonFileEvent): void {
  // pid 供控制台区分进程；落盘通道 pid 是保留键（logger 自动写真实进程号），同值覆盖无副作用
  const fields: Record<string, unknown> = { pid: process.pid };
  if (evt.mtimeMs !== undefined) {
    fields.mtimeMs = evt.mtimeMs;
  }
  if (evt.size !== undefined) {
    fields.size = evt.size;
  }

  if (evt.type === "error") {
    log.notice(
      "warn",
      `[config] ${evt.label} 读取失败: ${evt.path}: ${evt.error}（沿用上一份有效配置）`,
      fields,
    );
  } else if (evt.type === "missing") {
    log.notice("warn", `[config] ${evt.label} 文件消失: ${evt.path}（回退空配置）`, fields);
  } else if (evt.type === "recovered") {
    log.notice("info", `[config] ${evt.label} 已恢复: ${evt.path}`, fields);
  } else {
    log.notice("info", `[config] ${evt.label} 已热加载: ${evt.path}`, fields);
  }
}
