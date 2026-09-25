import type { AppConfig, ConfigKey } from "./store.js";

/** 仅用于在编译期约束内置字面量的键集合，不承担运行时校验。 */
type PresetConfig = Partial<Pick<AppConfig, ConfigKey>>;

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

/** 开发调试：开放监听的明文 HTTP，输出 debug 日志且不启用鉴权。 */
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

/** 常规 SOCKS5：不启用鉴权，沿用默认上游超时。 */
const socks5BasicPreset = definePreset({
  name: "socks5-basic",
  config: {
    proxyProtocol: "socks5",
    authEnabled: false,
    upstreamTimeout: 10000,
  } satisfies PresetConfig,
  description: "无鉴权 SOCKS5 代理，使用常规的 10 秒上游超时",
});

/** 基础认证：明文 HTTP + Basic 鉴权，使用 info 控制台日志。 */
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

/** TLS 占位：HTTPS 协议，证书路径指向仓库 keys/ 下的占位文件。 */
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
 * 注册/覆盖一个 preset（供库用户扩展；返回幂等的 unregister 退订函数）。
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
    // 旧退订函数不能误删后来覆盖同一名字的新注册项。
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
