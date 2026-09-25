/**
 * 运行期配置归一化。
 *
 * 这里只接收已经拿到的内存配置，不读取 env、argv、env 文件或任何其它文件。
 * 路径字段的真源是 `FIELDS` 的 `path` 元数据；UPSTREAM_URL 的校验与拆项也集中
 * 在本模块，避免 loader、context 和 runtime 各自维护一套容易漂移的规则。
 */

import path from "node:path";
import { FIELDS } from "./fields.js";
import type { AppConfig, ConfigKey, ConfigStore } from "./store.js";
import { applyUpstreamUrl, parseUpstreamUrl } from "@/utils/upstream-url.js";

/** 运行时显式提供键的表示：环境变量名或配置键均可。 */
export type ExplicitlyProvided = ReadonlySet<string> | readonly string[];

/** `prepareRuntimeConfig` 的结果；config 是调用后得到的独立副本。 */
export interface PreparedRuntimeConfig<T extends object = AppConfig> {
  readonly config: T;
  readonly warnings: readonly string[];
}

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

function asRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/**
 * 复制配置并按 `configDir` 归一化所有标记为 path 的字段。
 *
 * 规则刻意保持简单：空串仍为空，绝对路径原样保留，只有相对路径才调用
 * `path.resolve(configDir, value)`。本函数不触碰输入对象，也不做任何 IO。
 */
export function resolveConfigPaths<T extends object>(config: T, configDir: string): T {
  const copy = { ...config };
  const values = asRecord(copy);
  for (const field of FIELDS) {
    if (field.path !== true) {
      continue;
    }
    const value = values[field.key];
    if (typeof value !== "string" || value === "" || path.isAbsolute(value)) {
      continue;
    }
    values[field.key] = path.resolve(configDir, value);
  }
  return copy;
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

function inferExplicitlyProvided(config: object): ExplicitlyProvided | undefined {
  const keys = new Set(Object.keys(config));
  // 完整 AppConfig 没有来源信息，不能把默认值误报成“显式提供”；部分配置则可
  // 合理地把调用方实际给出的键视为显式来源。store 版本通常走这个完整配置分支。
  if (FIELDS.every((field) => keys.has(field.key))) {
    return undefined;
  }
  return FIELDS.filter((field) => keys.has(field.key)).map((field) => field.env);
}

/**
 * 准备一份供 runtime 使用的配置副本：路径归一化后再应用 UPSTREAM_URL。
 *
 * 该函数是纯内存操作，不读取 env/argv/文件。`explicitlyProvided` 主要供需要保留
 * 来源警告的调用方使用；传入部分配置且省略它时，会把部分配置中实际出现的字段视为
 * 显式提供，完整 AppConfig 则不猜测来源。
 */
export function prepareRuntimeConfig<T extends object>(
  config: T,
  configDir: string,
  explicitlyProvided?: ExplicitlyProvided,
): PreparedRuntimeConfig<T> {
  const copy = resolveConfigPaths(config, configDir);
  const values = asRecord(copy);
  const rawValue = values.upstreamUrl;
  const raw =
    typeof rawValue === "string" ? rawValue : rawValue === undefined ? "" : String(rawValue);

  if (raw === "") {
    return { config: copy, warnings: [] };
  }

  const provided = explicitlyProvided ?? inferExplicitlyProvided(config);
  const warnings = applyUpstreamUrlToConfig(copy, raw, provided);
  return { config: copy, warnings };
}

/**
 * 准备 store 的 runtime 配置：只把归一化后真正发生变化的字段 merge 回 store。
 *
 * 先在副本上完成全部校验，因而非法 URL 或任何其它归一化失败都不会半写 store。
 * 返回的 config 是 merge 后的 store 快照，调用方可直接用于创建 context。
 */
export function prepareRuntimeConfigStore(
  store: ConfigStore,
  configDir: string,
  explicitlyProvided?: ExplicitlyProvided,
): PreparedRuntimeConfig<AppConfig> {
  const current = store.getAll();
  const prepared = prepareRuntimeConfig(current, configDir, explicitlyProvided);
  const next = prepared.config;
  const patch: Partial<AppConfig> = {};
  const patchRecord = patch as Record<ConfigKey, unknown>;

  for (const field of FIELDS) {
    const key = field.key;
    if (!Object.is(current[key], next[key])) {
      patchRecord[key] = next[key];
    }
  }
  if (Object.keys(patch).length > 0) {
    store.merge(patch);
  }

  return { config: store.getAll(), warnings: prepared.warnings };
}
