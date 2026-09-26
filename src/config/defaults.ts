/**
 * 默认配置种子 - 纯数据，零 IO 零依赖
 *
 * 这里的值是「loader 未运行时 get() 读到的结果」，也是 `schema/fields.ts` 里
 * 省略 `def` 的字段的最终回退。新增字段必须同时在此加一行，否则
 * `store.commitConfig()` 的全量校验会因缺字段而拒绝提交。
 *
 * 魔法值由来：
 * - port/upstreamPort 3000 = 开发惯例非特权端口
 * - upstreamTimeout 10000 = 上游拨号 + 转发的共用容忍上限
 *   （同时是 cluster 停机 grace 基数，见 `src/server/AGENTS.md`）
 * - host 0.0.0.0 = 容器/多网卡默认全监听
 * - logLevel error + logFileLevel info = 终端只报错、文件留全量（两级独立，可各自调整）
 * - tls 系默认 keys 下自签占位路径
 * - 两个 CA 默认都是空串 = 不启用校验（upstreamCa 配了会替换系统信任库；
 *   tlsCa 配了即强制客户端证书 mTLS），拿仓库自带测试 PKI 当默认安全边界属自欺
 *   （其私钥已随仓库提交）
 *
 * 路径类字段（logFile/tlsKey/tlsCert/tlsCa/authUsersFile/aclFile）在此存的是相对
 * 配置目录的路径，`schema/fields.ts` 的 `def` 经 `load.initConfig` 解析成绝对路径后
 * 写回，因此同一个 key 初始化前读相对值、初始化后读绝对值；不跑 initConfig 的
 * 调用方拿到的是相对 cwd 的路径。
 */
import type { AppConfig } from "./types.js";

export const defaults: AppConfig = {
  host: "0.0.0.0",
  port: 3000,
  cacheType: "memory",
  proxyProtocol: "http",
  authEnabled: false,
  authType: "none",
  authUsersFile: "cfg/users.json",
  aclFile: "cfg/acl.json",
  jwtSecret: "",
  authLogging: true,
  logLevel: "error",
  logFileLevel: "info",
  logFile: "log",
  upstreamTimeout: 10000,
  upstreamUrl: "",
  tlsKey: "keys/server.key",
  tlsCert: "keys/server.crt",
  tlsCa: "",
  tlsPassphrase: "",
  upstreamHost: "127.0.0.1",
  upstreamPort: 3000,
  upstreamSecure: false,
  upstreamUsername: "",
  upstreamPassword: "",
  upstreamCa: "",
  upstreamInsecure: false,
  upstreamProtocol: "http",
  proxyMode: "server",
  preset: "",
  clusterWorkers: 1,
  useHomeConfig: false,
};
