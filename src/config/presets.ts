/**
 * 配置预设：命名好的一组配置片段（纯数据打包，不参与来源解析 / 文件 IO / 字段校验，
 * 值域合法性仍由 ConfigStore / loadConfig 体系负责）。
 *
 * 导入期零副作用：只创建内置字面量，不动态 import 插件、不读 env/argv/文件、不注册进程事件。
 * 注册表是本模块唯一的模块级可变状态。
 */

import type { AppConfig } from "./types.js";

/** 仅在编译期约束内置字面量的键，不承担运行时校验。 */
type PresetConfig = Partial<AppConfig>;

/** 预设元信息 + 配置片段。配置片段为 Partial，缺省键走 defaults。 */
export interface ProxyPreset {
  /** 唯一名（如 "development"/"secure-basic"），注册表 key */
  name: string;
  /** 该 preset 的配置片段（Partial，缺省由 defaults 补） */
  config: Partial<AppConfig>;
  /** 人类可读描述（列出用途） */
  description?: string;
}

/** 定义一个 preset（identity 函数，提供类型推导与链式友好；不做运行时校验） */
export function definePreset(preset: ProxyPreset): ProxyPreset {
  return preset;
}
const developmentPreset = definePreset({
  name: "development",
  config: {
    host: "0.0.0.0",
    proxyProtocol: "http",
    authEnabled: false,
    logLevel: "debug",
  } satisfies PresetConfig,
  description: "开放监听的明文 HTTP 调试代理，启用 debug 日志并关闭鉴权",
});

const socks5BasicPreset = definePreset({
  name: "socks5-basic",
  config: {
    proxyProtocol: "socks5",
    authEnabled: false,
    upstreamTimeout: 10000,
  } satisfies PresetConfig,
  description: "无鉴权 SOCKS5 代理，使用常规的 10 秒上游超时",
});

const secureHttpAuthPreset = definePreset({
  name: "secure-http-auth",
  config: {
    proxyProtocol: "http",
    authEnabled: true,
    authType: "basic",
    logLevel: "info",
  } satisfies PresetConfig,
  description: "启用 Basic 账号密码鉴权的明文 HTTP 代理，控制台日志为 info",
});

const httpsTlsPreset = definePreset({
  name: "https-tls",
  config: {
    proxyProtocol: "https",
    tlsKey: "keys/server.key",
    tlsCert: "keys/server.crt",
    authEnabled: false,
  } satisfies PresetConfig,
  description: "无鉴权 HTTPS 代理，TLS 私钥与证书使用 keys/ 下的占位路径",
});

/** 静态注册表：模块加载期只创建内存 Map，不读文件/env，也不动态加载插件。 */
const presetRegistry = new Map<string, ProxyPreset>([
  [developmentPreset.name, developmentPreset],
  [socks5BasicPreset.name, socks5BasicPreset],
  [secureHttpAuthPreset.name, secureHttpAuthPreset],
  [httpsTlsPreset.name, httpsTlsPreset],
]);

/** 内置 preset 注册表；只读类型是对外的静态视图，实际注册统一走 registerPreset。 */
export const builtinPresets: ReadonlyMap<string, ProxyPreset> = presetRegistry;

/**
 * 供库用户扩展；返回幂等的 unregister 退订函数。
 * 默认禁止重名；`override: true` 时允许替换当前注册项。
 */
export function registerPreset(preset: ProxyPreset, options?: { override?: boolean }): () => void {
  if (options?.override !== true && presetRegistry.has(preset.name)) {
    throw new Error(`Preset already registered: ${preset.name}`);
  }

  presetRegistry.set(preset.name, preset);
  let active = true;
  return () => {
    if (!active) {
      return;
    }
    active = false;
    // 退订只删自己写入的那一项：同名已被覆盖时不删除。
    if (presetRegistry.get(preset.name) === preset) {
      presetRegistry.delete(preset.name);
    }
  };
}

/** 列出所有已注册 preset 名（含内置项）。 */
export function listPresets(): string[] {
  return [...presetRegistry.keys()];
}

/** 按名取得已注册 preset；未注册时返回 undefined。 */
export function getPreset(name: string): ProxyPreset | undefined {
  return presetRegistry.get(name);
}

/**
 * 把 preset 合并进基础配置，产出可直接喂给 createProxyRuntime 的 config。
 * 优先级固定为 base → preset → overrides；始终返回新对象且不改任何入参。
 */
export function applyPreset(
  name: string,
  base?: Partial<AppConfig>,
  overrides?: Partial<AppConfig>,
): Partial<AppConfig> {
  const preset = getPreset(name);
  if (preset === undefined) {
    throw new Error(`Preset not found: ${name}`);
  }
  return {
    ...(base ?? {}),
    ...preset.config,
    ...(overrides ?? {}),
  };
}
