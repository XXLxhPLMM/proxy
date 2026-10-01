/**
 * 配置契约：字段全集与派生类型。
 *
 * 本模块**只有类型**，零运行时值、零 IO、零环境依赖，因此可以被任何层安全地
 * type-only 引用（含 `src/core/**` 与 `src/utils/**`）。
 *
 * 职责边界：
 * - 字段「是什么」由本模块定义（`AppConfig`）
 * - 字段「默认值是多少」由 `store.ts:defaults` 给出
 * - 字段「叫什么 env / 怎么解析 / 什么相位」由 `schema/fields.ts:FIELDS` 给出
 * 三者互不混装；改字段名要同时动这三处。
 */

import type { ProxyProtocol } from "@/core/types/proxy.js";
import type { DataSourceDriver } from "@/datasource/driver.js";

/** 权限校验类型，none=无鉴权，basic=账号密码，jwt=Bearer Token，uid=仅用户名（socks4 USERID） */
export type AuthType = "none" | "basic" | "jwt" | "uid";

/**
 * **数据来源**（存储后端）：`json` = 文本文件 / `sqlite` = SQLite 库
 *
 * @description
 * 这是「账号表」与「配额账本」共用的**后端选择**。两个字段各自独立取这个值
 * （`AUTH_USERS_DRIVER` / `QUOTA_USAGE_DRIVER`），故可以「账号走 JSON、账本走 SQLite」
 * 这类组合——**刻意不给「一个开关统管两者」**：两者的读写语义与生命周期都不同
 * （账号表只读、账本热路径写），绑死在一个开关上会让「只换一边」根本做不到。
 *
 * **非法值启动期 abort**（不回落默认值）：回落等于「配了个不存在的后端、悄悄按另一个跑」，
 * 正是本仓最恨的假安全感。⚠️ **判据不在本文件，在数据源层的注册表**——驱动名是**开放集合**
 * （`datasource/driver.ts`），「有没有这一项」是运行时事实，而**配置层只校验它是个非空字符串**：
 * 让配置层持有一份驱动清单，就等于把「有哪些驱动」这个部署事实复制成第二份要维护的真相。
 * 未注册驱动在**装配时**抛错并列出全部已注册项（`datasource/registry.ts:resolve`）。
 */

/**
 * 数据源驱动名（**开放集合**：`string`，不是字面量联合）
 * @description 闭合性由 `datasource/registry.ts` 的注册表保证，不由类型系统保证——理由全文见
 *   `datasource/driver.ts` 文件头。
 */
export type StoreDriver = DataSourceDriver;

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface AppConfig {
  /** 服务监听 IP，默认 0.0.0.0 */
  host: string;
  /** 服务监听端口，默认 3000 */
  port: number;
  /**
   * 代理协议 - 双端生效的全局开关，默认 http
   * - 服务端侧：决定 `@/core/server/factory.js:createProxy` 创建何种 ProxyCore
   *   （HttpProxy / HttpsProxy / Socks4Proxy / Socks5Proxy / Sockss4Proxy / Sockss5Proxy）
   *   以及监听的底层 Server 类型
   *   （http.Server / net.Server / tls.Server）
   * - 客户端侧：决定下游客户端应使用何种协议与本代理握手
   *   （浏览器填 http 代理 vs 客户端填 socks5://）
   * 可选值：http(明文+CONNECT) / https(TLS+HTTP)
   * / socks4 / socks5(明文 SOCKS) / sockss4 / sockss5(SOCKS over TLS)
   * 环境变量：PROXY_PROTOCOL，CLI：--proxy-protocol
   */
  proxyProtocol: ProxyProtocol;
  /** 鉴权总开关，默认 false（关闭），优先于 authType */
  authEnabled: boolean;
  /** 鉴权类型，默认 none（不校验），authEnabled=true 时生效 */
  authType: AuthType;
  /**
   * 用户账号文件路径（AUTH_USERS_FILE，默认 <配置目录>/cfg/users.json）
   * - 内容为 `[{ "username": "alice", "password": "pw1" }]`，多账号即多项
   * - 文件缺失 = 无账号；内容非法 = 保留上一份有效值并告警；改动最多 1s 内热生效
   * - 路径本身为 runtime 相位：可 set() 热改指向
   */
  authUsersFile: string;
  /**
   * 账号表的**数据来源**：`json` 读 `AUTH_USERS_FILE`（默认）/ `sqlite` 读 `AUTH_USERS_DB`
   * - runtime 相位：热改立即生效（下一个请求就走新后端）
   * - `json` = 本仓的默认与长期形态（运维能手改、能进版本库、能 diff）
   * - `sqlite` = 同一份账号表的另一种存放方式，**表结构与校验规则完全一致**
   *   （`AuthAccount` 形状 + `validateAuthUsers` 同一份判据），两档可互换
   */
  authUsersDriver: StoreDriver;
  /**
   * `authUsersDriver=sqlite` 时的账号库路径（默认 `<配置目录>/cfg/users.db`）
   * - `authUsersDriver=json` 时**完全不读**这个字段（配错也不影响运行）
   * - startup 相位：与 `quotaUsageDir` 同理，改路径 = 换一份数据源，热改没有意义
   */
  authUsersDb: string;
  /**
   * 访问控制名单文件路径（ACL_FILE，默认 <配置目录>/cfg/acl.json）
   * - 内容为 `{ clientIp: {whitelist, blacklist}, target: {whitelist, blacklist} }`
   * - clientIp 只收 IP/CIDR（按 TCP 对端地址判定，不看 XFF）；target 收 IP/CIDR/域名/`*.域名`
   * - 文件缺失 = 全部放行；内容非法 = 保留上一份有效值并告警；改动最多 1s 内热生效
   */
  aclFile: string;
  /**
   * 访问控制名单的数据来源（**开放集合**，判据是 `datasource/registry.ts` 里有没有注册）
   * @description 名单是**数据**不是配置：它决定「谁被放行」，而这一层不该由「配置文件长什么样」
   * 来决定。startup 相位（换驱动 = 换一份实现，必须重建 runtime）。
   */
  aclDriver: DataSourceDriver;
  /**
   * 流量配额账本目录（QUOTA_USAGE_DIR，默认 <配置目录>/cfg/usage）
   * - **startup 相位**：运行中改目录等于「改了等于没改」（已打开的账本 append 句柄仍指向旧文件），
   *   要改必须重建 runtime / 重启进程
   * - 相对路径按配置目录绝对化（与 aclFile/authUsersFile 同一套 path 归一）
   */
  quotaUsageDir: string;
  /**
   * 配额账本的**数据来源**：`sqlite`（默认，多进程共享）/ `json`（单进程用）
   * - startup 相位：后端选择是**结构性**的，构造期就要定死（与 `quotaUsageDir` 同相位）
   * - ⚠️ **`json` 在 `CLUSTER_WORKERS > 1` 下有已知的语义缺口**：文本文件没有事务与
   *   写锁，多个 worker 追加同一文件时「读取求和」会看到彼此的增量，但**判定侧**只恢复
   *   自己进程内的快照——即账号级封禁退化为每进程一份。`sqlite` 档没有这个缺口
   *   （库里那一行是全局唯一真相）。启动期会为此发一条告警，见 `runtime/log-events`。
   * - 选 `json` 的正当场景：**单进程**部署，或需要「账本可人肉阅读 / 用 shell 工具统计」。
   */
  quotaUsageDriver: StoreDriver;
  /**
   * 配额窗口重置小时（QUOTA_RESET_HOUR，默认 0，取 0..23，**本地时区**）
   * - `window=day` 时该小时是「新一天的第一刻」：resetHour=3 表示 01:00 仍算前一天
   * - runtime 相位：每请求现读，改了不重启即生效
   */
  quotaResetHour: number;
  /**
   * 配额 delta 落盘间隔 ms（QUOTA_FLUSH_INTERVAL，默认 5000，int min 1）
   * - runtime 相位：热改即生效
   */
  quotaFlushInterval: number;
  /** JWT 密钥（JWT_SECRET），authType=jwt 时生效 */
  jwtSecret: string;
  /** 鉴权日志开关，默认 true，false 时静默 allow/deny 审计日志 */
  authLogging: boolean;
  /**
   * 控制台日志等级，默认 error，可选 debug/info/warn/error/silent
   * - 与 logFileLevel 独立：终端求安静、文件求详尽，两边各调各的
   * - 环境变量：LOG_LEVEL，CLI：--log-level
   */
  logLevel: LogLevel;
  /**
   * 落盘日志等级，默认 info，可选 debug/info/warn/error/silent
   * - 与 logLevel 独立，仅 logFile 配了路径时生效
   * - 环境变量：LOG_FILE_LEVEL，CLI：--log-file-level
   */
  logFileLevel: LogLevel;
  /**
   * 日志持久化路径，默认 log 目录按小时分文件
   * - 设为目录（log/logs）或文件均按小时生成
   *   log/YYYY-MM-DD-HH.jsonl（每行一个 JSON 对象，可直接 jq/grep 查询）
   * - 落盘等级由 logFileLevel 单独控制，留空则完全不落盘
   * - 环境变量：LOG_FILE，CLI：--log-file
   */
  logFile: string;
  /** 上游目标超时 ms，默认 10000，超时回 504/断开隧道 */
  upstreamTimeout: number;
  /**
   * TLS 私钥路径，默认 keys/server.key
   * - 仅 https/sockss4/sockss5 协议生效，http/socks4/socks5 忽略
   * - 支持绝对路径或相对项目根目录的路径
   * - 环境变量：TLS_KEY，CLI：--tls-key
   */
  tlsKey: string;
  /**
   * TLS 证书路径，默认 keys/server.crt
   * - 仅 https/sockss4/sockss5 协议生效，需与 tlsKey 配对使用
   * - 环境变量：TLS_CERT，CLI：--tls-cert
   */
  tlsCert: string;
  /**
   * 客户端证书 CA 路径（mTLS），默认空串 = 不校验客户端证书
   * - 仅 https/sockss4/sockss5 生效：配置即强制校验客户端证书（要求由该 CA 签发），留空则只做服务端 TLS
   * - 配置后文件缺失/不可读会在启动时 abort（fail-closed），绝不静默降级为不校验
   * - 默认必须为空串：keys/ 下是仓库自带的测试 PKI（私钥已提交），不能当安全边界
   * - 环境变量：TLS_CA，CLI：--tls-ca
   */
  tlsCa: string;
  /**
   * TLS 私钥口令（加密私钥时需）
   * - 仅私钥为 ENCRYPTED PRIVATE KEY 时生效，无口令私钥忽略
   * - 环境变量：TLS_PASSPHRASE，CLI：--tls-passphrase
   */
  tlsPassphrase: string;
  /**
   * 上游代理标准 URL（可选，替代逐项 granular 配置）
   * - 形式：scheme://[user:pass@]host[:port]，
   *   scheme ∈ http/https/socks4/socks5/sockss4/sockss5（大小写不敏感）
   * - 配置后整体生效，覆盖
   *   upstreamProtocol/Secure/Host/Port/Username/Password 拆项；
   *   缺省端口按 scheme 补齐
   *   （http:80 / https,sockss4,sockss5:443 / socks4,socks5:1080）
   * - 拒绝携带 path/query/hash（代理端点无路径语义）；
   *   upstreamCa/upstreamInsecure 仍为独立配置
   * - 环境：UPSTREAM_URL，CLI：--upstream-url；
   *   快照打印时自动脱敏 userinfo
   */
  upstreamUrl: string;
  /** 上游地址；配 UPSTREAM_URL 时被整体覆盖 */
  upstreamHost: string;
  /** 上游端口；配 UPSTREAM_URL 时同样被覆盖 */
  upstreamPort: number;
  /** 上游是否 TLS；配 UPSTREAM_URL 时被覆盖 */
  upstreamSecure: boolean;
  /** 上游用户名；配 UPSTREAM_URL 时被覆盖 */
  upstreamUsername: string;
  /** 上游密码；配 UPSTREAM_URL 时被覆盖 */
  upstreamPassword: string;
  /**
   * 上游 CA 路径；独立配置，不受 UPSTREAM_URL 覆盖
   * 默认空串 = 用系统信任库校验上游证书；配了则**整体替换**系统信任库（只信任该 CA）
   */
  upstreamCa: string;
  /** 上游是否跳过证书校验；独立配置，不受 UPSTREAM_URL 覆盖 */
  upstreamInsecure: boolean;
  /**
   * 上游代理协议（client 模式下，本地服务收到请求后向哪个协议的上游转发）
   * 取值与 proxyProtocol 相同（http/https/socks4/socks5/sockss4/sockss5），
   * 与 proxyProtocol 正交：下游可 http，上游可 sockss5，实现链式异构
   * 环境：UPSTREAM_PROTOCOL，CLI：--upstream-protocol
   */
  upstreamProtocol: ProxyProtocol;
  /** 运行模式：server=服务端，client=客户端 */
  proxyMode: "server" | "client";
  /**
   * cluster worker 进程数，默认 1（不启用 cluster，单进程运行）
   * - 1: 单进程；>1: master fork 指定数量 worker 共享监听端口，
   *   崩溃自动重启
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
  /**
   * 管理面（控制面）总开关，默认 false（**不监听任何管理端口**）
   * - 这个面能改配置、重启进程、增删账号，等价于主机上的 root shell，
   *   所以缺省是「没有这个面」而不是「有一个关着的面」
   * - true 时 `managerToken` 为空一律拒绝启动：空 token = 谁连上谁就是管理员
   * 环境变量：MANAGER_ENABLED，CLI：--manager-enabled
   */
  managerEnabled: boolean;
  /**
   * 管理面监听地址，默认 127.0.0.1
   * - **永远默认只听本机**：暴露到 0.0.0.0 是运维自己的决定，不是缺省值的副作用
   * - `useHomeConfig` 只换「配置目录在哪」，不换「谁能连上来」，故不因它改成全网卡
   * 环境变量：MANAGER_HOST，CLI：--manager-host
   */
  managerHost: string;
  /**
   * 管理面监听端口，默认 3010（与数据面 `port` 默认 3000 错开）
   * - 与 `port` 相等一律拒绝启动：同一个端口上 bind 两次必然 EADDRINUSE，
   *   而那会在数据面已经在服务之后才炸出来
   * 环境变量：MANAGER_PORT，CLI：--manager-port
   */
  managerPort: number;
  /**
   * 管理面 Bearer token，默认空串（= 未启用鉴权形态）
   * - `managerEnabled=true` 时为空一律拒绝启动（fail-closed）
   * - 与 `jwtSecret` 同一档：进配置快照的打印一律打码
   * 环境变量：MANAGER_TOKEN，CLI：--manager-token
   */
  managerToken: string;
}

export type ConfigKey = keyof AppConfig;

/**
 * @param changed - 本次**实际**变更的键（写同值不触发，故每项都是真变更）
 * @param snapshot - 变更后的全量浅拷贝快照；只读语义，mutate 它不会影响 store
 */
export type ConfigChangeListener = (
  changed: readonly ConfigKey[],
  snapshot: Readonly<AppConfig>,
) => void;
