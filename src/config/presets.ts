/**
 * 配置预设目录 - 纯数据定义
 *
 * 预设只提供配置片段与插件标识，不在模块加载时读取环境、访问 store 或动态加载插件。
 * 最终生效顺序仍由 loader 统一处理：默认值 < 预设 < CLI / 环境变量。
 */
import type { AppConfig } from "./store.js";

/** 预设名称白名单；FIELDS 的 PRESET 解析器与目录共用这份列表。 */
export const PRESET_NAMES = [
  "http-server-basic",
  "http-client-chain",
  "socks5-server",
  "sockss5-mtls",
  "strict-acl",
] as const;

export type PresetName = (typeof PRESET_NAMES)[number];

/** 一个可枚举的预设定义，plugins 暂作为纯数据保存。 */
export interface PresetDefinition {
  readonly name: PresetName;
  readonly summary: string;
  readonly config: Partial<AppConfig>;
  readonly plugins: readonly string[];
}

/**
 * 首批预设目录。
 * 配置字段只写合法的 Partial<AppConfig>；运行时是否加载插件由后续组合根决定。
 */
export const PRESETS: Readonly<Record<PresetName, PresetDefinition>> = {
  "http-server-basic": {
    name: "http-server-basic",
    summary: "基础 HTTP 代理服务端",
    config: {
      proxyProtocol: "http",
      proxyMode: "server",
    },
    plugins: ["http-proxy", "auth", "access-control", "logger"],
  },
  "http-client-chain": {
    name: "http-client-chain",
    summary: "通过上游代理转发的 HTTP 客户端链路",
    config: {
      proxyProtocol: "http",
      proxyMode: "client",
    },
    plugins: ["http-proxy", "routing", "forwarding", "logger"],
  },
  "socks5-server": {
    name: "socks5-server",
    summary: "基础 SOCKS5 代理服务端",
    config: {
      proxyProtocol: "socks5",
      proxyMode: "server",
    },
    plugins: ["socks5-proxy", "auth", "access-control", "logger"],
  },
  "sockss5-mtls": {
    name: "sockss5-mtls",
    summary: "启用客户端证书校验的 SOCKS5 over TLS 服务端",
    config: {
      proxyProtocol: "sockss5",
      proxyMode: "server",
      tlsCa: "keys/ca.crt",
    },
    plugins: ["sockss5-proxy", "mtls", "auth", "access-control", "logger"],
  },
  "strict-acl": {
    name: "strict-acl",
    summary: "启用访问控制名单的严格 HTTP 服务端",
    config: {
      proxyProtocol: "http",
      proxyMode: "server",
      aclFile: "cfg/acl.json",
      authLogging: true,
    },
    plugins: ["http-proxy", "access-control", "logger"],
  },
};

/** 解析预设；目录中不存在时按配置错误处理，不静默回退。 */
export function resolvePreset(name: string): PresetDefinition {
  if (!(PRESET_NAMES as readonly string[]).includes(name)) {
    throw new Error(`配置错误: 未知 preset "${name}"`);
  }
  return PRESETS[name as PresetName];
}
