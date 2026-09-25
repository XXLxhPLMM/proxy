/**
 * UPSTREAM_URL 归一化：校验并把标准 URL 拆成六个 endpoint 字段。
 *
 * 唯一的拆项实现：`loadConfig`（带来源）与纯内存 runtime（无来源）都走这里，
 * 因此两条路径永远不会对同一 URL 得出不同结果。非法 URL 在**触碰 target 之前**拒绝。
 */

import { applyUpstreamUrl, parseUpstreamUrl } from "../schema/upstream-url.js";
import { FIELDS } from "../schema/fields.js";
import { asRecord } from "./record.js";

/** 运行时显式提供键的表示：环境变量名或配置键均可。 */
export type ExplicitlyProvided = ReadonlySet<string> | readonly string[];

/** URL 实际会覆盖的六个 granular 字段。 */
const UPSTREAM_SPLIT_KEYS = new Set<string>([
  "upstreamProtocol",
  "upstreamSecure",
  "upstreamHost",
  "upstreamPort",
  "upstreamUsername",
  "upstreamPassword",
]);

function hasExplicitlyProvided(
  explicitlyProvided: ExplicitlyProvided | undefined,
  key: string,
): boolean {
  if (explicitlyProvided === undefined) {
    return false;
  }
  if (Array.isArray(explicitlyProvided)) {
    return explicitlyProvided.includes(key);
  }
  return (explicitlyProvided as ReadonlySet<string>).has(key);
}

/**
 * 校验并应用 `UPSTREAM_URL`，返回因显式拆项被覆盖而产生的 warning。
 *
 * 解析必须先于任何写入；因此非法 URL 不会部分改写 target。空串代表未配置，返回
 * 空 warning；非空但非法的原始值按统一配置错误格式拒绝。
 */
export function applyUpstreamUrlToConfig<T extends object>(
  target: T,
  raw: string,
  explicitlyProvided?: ExplicitlyProvided,
): string[] {
  // 先 parse，再触碰 target，确保失败时不会留下半份 URL 拆项。
  const parsed = parseUpstreamUrl(raw);
  if (raw === "") {
    return [];
  }
  if (parsed === undefined) {
    throw new Error(`配置校验失败: UPSTREAM_URL=${raw} 非法`);
  }

  const values = asRecord(target);
  const before = new Map<string, unknown>();
  for (const key of UPSTREAM_SPLIT_KEYS) {
    before.set(key, values[key]);
  }

  applyUpstreamUrl(values, parsed);

  const clobbered = FIELDS.filter(
    (field) =>
      UPSTREAM_SPLIT_KEYS.has(field.key) &&
      (hasExplicitlyProvided(explicitlyProvided, field.env) ||
        hasExplicitlyProvided(explicitlyProvided, field.key)) &&
      !Object.is(before.get(field.key), values[field.key]),
  ).map((field) => field.env);

  if (clobbered.length === 0) {
    return [];
  }
  return [`[config] UPSTREAM_URL 已设置，覆盖了同时提供的拆项: ${clobbered.join(", ")}`];
}
