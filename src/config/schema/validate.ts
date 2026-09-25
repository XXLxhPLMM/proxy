/**
 * 字段值校验：范围约束 + 交叉字段组合。
 *
 * 只做「已经解析成标量之后还差什么」的判断，因此只依赖字段表的 `int` 元数据，
 * 不认识 env 文件与 argv。所有函数是纯函数且**不抛业务异常以外的意外**：
 * 非法一律抛 `配置校验失败: ...`，调用方（loadConfig）无需再翻译错误。
 */

import { FIELDS } from "./fields.js";

/**
 * 整数范围校验（loadConfig 在解析完成后调用）
 * @description 遍历 FIELDS 的 `int` 约束，对已出现在 resolved 表中的字段检查整数性与上下界，
 * 返回 `ENV=value` 形式的越界清单（空数组表示全部合法）；未出现在表中的字段跳过（只校验显式给出的键）
 * @param resolved - 已解析的字段表（键为 `ConfigKey`）
 * @returns 越界字段的 `ENV=value` 列表
 * @example collectIntRangeErrors({ port: 70000 }) // => ["PORT=70000"]
 */
export function collectIntRangeErrors(resolved: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const d of FIELDS) {
    if (d.int === undefined || !(d.key in resolved)) {
      continue;
    }
    const v = resolved[d.key] as number;
    const { min, max } = d.int;
    if (!Number.isInteger(v) || (min !== undefined && v < min) || (max !== undefined && v > max)) {
      bad.push(`${d.env}=${v}`);
    }
  }
  return bad;
}

/**
 * 按 FIELDS 逐字段解析一组原始 env 键值
 * @description 遍历 `FIELDS`，对 `source(env)` 返回的每个已给出的原始值调用字段的 `parse`：
 * 成功写入 `resolved[d.key]`，失败记入 `bad`（`ENV=value` 形式，空数组表示全部合法）；
 * 只收录显式提供的键——默认值回退与抛错留给调用方各自的后处理
 * （loadConfig 补 def/defaults 并另带文件错误消息）
 * @param source - 按 env 名取原始值的回调（返回 undefined 表示未提供）
 * @returns 已解析字段表 `resolved` 与非法项清单 `bad`
 * @example resolveFieldEntries((env) => rawCli[env] ?? explicitEnv[env] ?? fileEnv[env])
 */
export function resolveFieldEntries(source: (env: string) => string | undefined): {
  resolved: Record<string, unknown>;
  bad: string[];
} {
  const resolved: Record<string, unknown> = {};
  const bad: string[] = [];
  for (const d of FIELDS) {
    // 显式给出的值（CLI 优先于 env）一律不允许静默丢弃：解析失败记入 bad，由调用方统一抛错
    const raw = source(d.env);
    if (raw === undefined) {
      continue;
    }
    const parsed = d.parse(raw);
    if (parsed === undefined) {
      bad.push(`${d.env}=${raw}`);
      continue;
    }
    resolved[d.key] = parsed;
  }
  return { resolved, bad };
}

/**
 * 交叉字段校验：开启鉴权时的组合必须能真正拦人（fail-closed，任一项不成立即阻止启动）
 * @description
 * - `authEnabled + none`：开了鉴权却不选方式 = 全部放行，属自相矛盾配置
 * - `authEnabled + basic/uid + 账号表为空`：无账号可比对时一律判否是徒劳的「拒绝一切」，
 *   真正原因是 AUTH_USERS_FILE 没配好（路径写错/文件为空），必须让启动失败而不是静默全拒
 * - `authEnabled + jwt + 空 JWT_SECRET`：无密钥的 JWT 校验没有意义
 * 抽成导出的纯函数便于单测（无需起子进程）。
 * @param cfg - 待校验组合（authEnabled / authType / accountCount / jwtSecret）
 * @throws {Error} 配置非法时抛 `配置校验失败: ...`
 * @example assertAuthConfig({ authEnabled: true, authType: "basic", accountCount: 0 }); // throws
 * @example assertAuthConfig({ authEnabled: true, authType: "basic", accountCount: 2 }); // ok
 */
export function assertAuthConfig(cfg: {
  authEnabled: boolean;
  authType: string;
  accountCount: number;
  jwtSecret?: string;
}): void {
  if (!cfg.authEnabled) {
    return;
  }
  if (cfg.authType === "none") {
    throw new Error(
      "配置校验失败: AUTH_ENABLED=true 但 AUTH_TYPE=none（不会校验任何凭证）；确需关闭鉴权请设 AUTH_ENABLED=false",
    );
  }
  if ((cfg.authType === "basic" || cfg.authType === "uid") && cfg.accountCount === 0) {
    throw new Error(
      `配置校验失败: 账号表为空（AUTH_ENABLED=true 且 AUTH_TYPE=${cfg.authType}）；请检查 AUTH_USERS_FILE 指向的文件是否存在且至少配置一个账号`,
    );
  }
  if (cfg.authType === "jwt" && !cfg.jwtSecret) {
    throw new Error("配置校验失败: JWT_SECRET 为空（AUTH_ENABLED=true 且 AUTH_TYPE=jwt）");
  }
}
