/**
 * 配置存放位置 - 全局唯一
 * 职责：定义配置类型 + 持有全局 Map 单例，不做任何 IO
 * 设计要点：
 * - 单例：整个进程仅此一份 Map，所有模块通过 get/set 访问同一份数据
 * - 类型安全：key 受 ConfigKey 约束，value 自动推导为对应字段类型
 * - 默认值：defaults 在模块加载时一次性写入 Map，后续 loader 覆盖
 */

/** 缓存类型，memory=纯内存，redis=Redis（失败自动降级至内存） */
export type CacheType = "memory" | "redis";

/** 权限校验类型，none=无鉴权，basic=账号密码，jwt=Bearer Token */
export type AuthType = "none" | "basic" | "jwt";

/** 日志等级，silent=关闭控制台输出 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

import type { ProxyProtocol } from "@/core/types.js";
export type { ProxyProtocol } from "@/core/types.js";

export interface AppConfig {
  /** 服务监听 IP，默认 0.0.0.0 */
  host: string;
  /** 服务监听端口，默认 3000 */
  port: number;
  /** 缓存实现类型，默认 memory */
  cacheType: CacheType;
  /**
   * 代理协议 - 双端生效的全局开关，默认 http
   * - 服务端侧：决定 src/index.ts 工厂创建何种 ProxyCore（HttpProxy/SocksProxy/TlsProxy）
   *   以及监听的底层 Server 类型（http.Server / net.Server / tls.Server）
   * - 客户端侧：决定下游客户端应使用何种协议与本代理握手（浏览器填 http 代理 vs 客户端填 socks5://）
   * 可选值：http(明文+CONNECT) / https(TLS+HTTP) / socks(SOCKS5) / tls(mTLS透传)
   * 环境变量：PROXY_PROTOCOL（主）兼容 PROXY_TYPE / PROXY_SERVICE_TYPE，CLI：--proxy-protocol
   */
  proxyProtocol: ProxyProtocol;
  /** 鉴权总开关，默认 false（关闭），优先于 authType */
  authEnabled: boolean;
  /** 鉴权类型，默认 none（不校验），authEnabled=true 时生效 */
  authType: AuthType;
  /** Basic 鉴权用户名（AUTH_USERNAME），authType=basic 时生效 */
  authUsername: string;
  /** Basic 鉴权密码（AUTH_PASSWORD），authType=basic 时生效 */
  authPassword: string;
  /** JWT 密钥（JWT_SECRET / PROXY_SECRET / JWT_KEY 兼容），authType=jwt 时生效 */
  jwtSecret: string;
  /** 鉴权日志开关，默认 true，false 时静默 allow/deny 审计日志 */
  authLogging: boolean;
  /** 日志等级，默认 info，可选 debug/info/warn/error/silent */
  logLevel: LogLevel;
  /**
   * 日志持久化路径，默认 log 目录按小时分文件
   * - 设为目录（log/logs）或文件均按小时生成 log/YYYY-MM-DD-HH.log
   * - 控制台始终输出，文件为额外落盘
   * - 环境变量：LOG_FILE（主）兼容 LOGFILE/LOG_PATH，CLI：--log-file
   */
  logFile: string;
  /** 上游目标超时 ms，默认 10000，超时回 504/断开隧道 */
  upstreamTimeout: number;
  /**
   * TLS 私钥路径，默认 keys/server.key
   * - 仅 https/tls 协议生效，http/socks 忽略
   * - 支持绝对路径或相对项目根目录的路径
   * - 环境变量：TLS_KEY（主）兼容 TLS_KEY_PATH / SSL_KEY
   * - CLI：--tls-key
   */
  tlsKey: string;
  /**
   * TLS 证书路径，默认 keys/server.crt
   * - 仅 https/tls 协议生效，需与 tlsKey 配对使用
   * - 环境变量：TLS_CERT（主）兼容 TLS_CERT_PATH / SSL_CERT
   * - CLI：--tls-cert
   */
  tlsCert: string;
  /**
   * CA 证书路径，默认 keys/ca.crt
   * - 仅 tls(mTLS) 协议用于校验客户端证书，https 可选
   * - 为空则不校验客户端证书
   * - 环境变量：TLS_CA（主）兼容 TLS_CA_PATH / SSL_CA
   * - CLI：--tls-ca
   */
  tlsCa: string;
  /**
   * TLS 私钥口令（加密私钥时需）
   * - 仅私钥为 ENCRYPTED PRIVATE KEY 时生效，无口令私钥忽略
   * - 环境变量：TLS_PASSPHRASE（主）兼容 TLS_KEY_PASS / SSL_PASSPHRASE / PASSPHRASE
   * - CLI：--tls-passphrase
   */
  tlsPassphrase: string;
  /** 上游代理地址，默认 127.0.0.1，环境：UPSTREAM_HOST/REMOTE_HOST/PROXY_TARGET_HOST */
  upstreamHost: string;
  /** 上游代理端口，默认 3000，环境：UPSTREAM_PORT/REMOTE_PORT/PROXY_TARGET_PORT */
  upstreamPort: number;
  /** 上游是否 TLS，默认 false，环境：UPSTREAM_SECURE/REMOTE_SECURE */
  upstreamSecure: boolean;
  /** 上游 Basic 用户名，环境：UPSTREAM_USERNAME/REMOTE_USERNAME */
  upstreamUsername: string;
  /** 上游 Basic 密码，环境：UPSTREAM_PASSWORD/REMOTE_PASSWORD */
  upstreamPassword: string;
  /** 上游 CA 路径（校验自签），默认 keys/ca.crt，环境：UPSTREAM_CA/REMOTE_CA */
  upstreamCa: string;
  /** 上游是否忽略证书校验，默认 false，环境：UPSTREAM_INSECURE/REMOTE_INSECURE */
  upstreamInsecure: boolean;
  /**
   * 上游代理协议（client 模式下，本地服务收到请求后向哪个协议的上游转发）
   * - http:  用 HttpProxyClient CONNECT/GET 转发
   * - https: 同 http 但 secure=true 的 TLS 上游
   * - socks: 用 SocksProxyClient（SOCKS5）
   * - tls:   mTLS 透传上游
   * 默认 http，与 proxyProtocol 正交：下游可 http，上游可 socks，实现链式异构
   * 环境：UPSTREAM_PROTOCOL / REMOTE_PROTOCOL / PROXY_UPSTREAM_PROTOCOL，CLI：--upstream-protocol
   */
  upstreamProtocol: ProxyProtocol;
  /** 运行模式：server=启动服务端，client=启动客户端，默认 server，环境：PROXY_MODE/MODE */
  proxyMode: "server" | "client";
  /**
   * cluster worker 进程数，默认 1（不启用 cluster，单进程运行）
   * - 1: 单进程；>1: master fork 指定数量 worker 共享监听端口，崩溃自动重启
   * - 0: 按 CPU 核数 fork
   * 环境变量：CLUSTER_WORKERS，CLI：--cluster-workers
   */
  clusterWorkers: number;
  /**
   * 使用用户主目录作为配置目录，默认 false（使用当前工作目录）
   * - true: 从 ~/.proxy/ 读取 .env、keys/、log/ 等配置
   * - false: 从当前工作目录读取
   * 开启后只需配置一次，全局可用
   * 环境变量：USE_HOME_CONFIG，CLI：--use-home-config
   */
  useHomeConfig: boolean;
}

/** Map 的合法 key 集合，新增 AppConfig 字段时自动扩展 */
export type ConfigKey = keyof AppConfig;

/** 默认配置，作为 Map 初始值 */
const defaults: AppConfig = {
  host: "0.0.0.0",
  port: 3000,
  cacheType: "memory",
  proxyProtocol: "http",
  authEnabled: false,
  authType: "none",
  authUsername: "",
  authPassword: "",
  jwtSecret: "",
  authLogging: true,
  logLevel: "info",
  logFile: "log",
  upstreamTimeout: 10000,
  tlsKey: "keys/server.key",
  tlsCert: "keys/server.crt",
  tlsCa: "keys/ca.crt",
  tlsPassphrase: "",
  upstreamHost: "127.0.0.1",
  upstreamPort: 3000,
  upstreamSecure: false,
  upstreamUsername: "",
  upstreamPassword: "",
  upstreamCa: "keys/ca.crt",
  upstreamInsecure: false,
  upstreamProtocol: "http",
  proxyMode: "server",
  clusterWorkers: 1,
  useHomeConfig: false,
};

/**
 * 全局配置 Map
 * - key 类型受 ConfigKey 约束，非法 key 编译期报错
 * - 初始化时由 defaults 填充，确保 get 调用始终有值
 */
export const config = new Map<ConfigKey, AppConfig[ConfigKey]>(
  Object.entries(defaults) as [ConfigKey, AppConfig[ConfigKey]][],
);

/**
 * 读取配置
 * @param key - 配置键名，受 ConfigKey 类型限制
 * @returns 对应类型的配置值
 */
export function get<K extends ConfigKey>(key: K): AppConfig[K] {
  return config.get(key) as AppConfig[K];
}

/**
 * 写入配置
 * @param key - 配置键名
 * @param value - 与 key 对应的值类型，类型不匹配编译期报错
 */
export function set<K extends ConfigKey>(key: K, value: AppConfig[K]): void {
  config.set(key, value);
}

/**
 * 获取全量配置快照
 * @returns 浅拷贝的 AppConfig 对象
 */
export function getAll(): AppConfig {
  // Object.fromEntries 推断为 {[k:string]:unknown}，需经 unknown 中转至 AppConfig
  return Object.fromEntries(config) as unknown as AppConfig;
}

/**
 * 判断配置是否存在
 * @param key - 配置键名
 */
export function has(key: ConfigKey): boolean {
  return config.has(key);
}
