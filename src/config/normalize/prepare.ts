/**
 * 纯内存 runtime 的配置准备：路径归一化 + UPSTREAM_URL 拆项。
 *
 * 与 `loadConfig` 共用同一套归一化实现（`paths.ts` / `upstream.ts`），差别只在这里
 * 不接触任何 env/argv/文件。全部计算先落在副本上，成功后才按需 merge 回 store。
 */

import { FIELDS } from "../schema/fields.js";
import type { ConfigStore } from "../store.js";
import type { AppConfig, ConfigKey } from "../types.js";
import { resolveConfigPaths } from "./paths.js";
import { asRecord } from "./record.js";
import { applyUpstreamUrlToConfig, type ExplicitlyProvided } from "./upstream.js";

/** `prepareRuntimeConfig` 的结果；config 是调用后得到的独立副本。 */
export interface PreparedRuntimeConfig<T extends object = AppConfig> {
  readonly config: T;
  readonly warnings: readonly string[];
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
