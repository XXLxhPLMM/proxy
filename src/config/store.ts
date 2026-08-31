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

/**
 * 代理协议 - 同时约束 服务端监听 与 客户端握手 两个方向
 * - http:  服务端以 http.Server 监听 request/connect，客户端用 HTTP 明文 + CONNECT 隧道
 * - https: 服务端在 http 之上叠加 TLS（需证书），客户端先 TLS 握手再发 HTTP/CONNECT
 * - socks: 服务端走 SOCKS5 握手（RFC1928），客户端按 SOCKS5 帧格式发起连接
 * - tls:   mTLS 双向认证的透传隧道，服务端/客户端均需证书校验
 * 与 src/core/types.ts 的 ProxyProtocol 同源，修改时需同步
 */
export type ProxyProtocol = "http" | "https" | "socks" | "tls";

export interface AppConfig {
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
  /** 客户端目标代理地址（直连目标代理服务器），默认 127.0.0.1，环境：REMOTE_HOST/PROXY_TARGET_HOST */
  remoteHost: string;
  /** 客户端目标代理端口，默认 3000，环境：REMOTE_PORT/PROXY_TARGET_PORT */
  remotePort: number;
  /** 客户端目标是否 TLS（https/socks over TLS），默认 false，环境：REMOTE_SECURE */
  remoteSecure: boolean;
  /** 客户端目标 Basic 用户名，环境：REMOTE_USERNAME/PROXY_TARGET_USERNAME */
  remoteUsername: string;
  /** 客户端目标 Basic 密码，环境：REMOTE_PASSWORD/PROXY_TARGET_PASSWORD */
  remotePassword: string;
  /** 客户端目标 CA 路径（校验自签），默认 keys/ca.crt，环境：REMOTE_CA */
  remoteCa: string;
    /** 客户端是否忽略证书校验（自签场景），默认 false，环境：REMOTE_INSECURE */
  remoteInsecure: boolean;
  /** 运行模式：server=启动服务端，client=启动客户端，默认 server，环境：PROXY_MODE/MODE */
  proxyMode: "server" | "client";
}

/** Map 的合法 key 集合，新增 AppConfig 字段时自动扩展 */
export type ConfigKey = keyof AppConfig;

/** 默认配置，作为 Map 初始值 */
const defaults: AppConfig = {
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
  remoteHost: "127.0.0.1",
  remotePort: 3000,
  remoteSecure: false,
  remoteUsername: "",
  remotePassword: "",
  remoteCa: "keys/ca.crt",
  remoteInsecure: false,
  proxyMode: "server",
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
