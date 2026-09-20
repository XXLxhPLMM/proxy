/**
 * 测试环境隔离：清除终端/CI 残留的代理配置环境变量。
 *
 * 背景：loader 对「显式提供但非法」的环境变量一律抛错阻止启动，
 * 终端里遗留的 AUTH_TYPE=pwd / PORT=444 之类脏值会让 loader 在 import 时直接抛错。
 * 测试应只依赖自身显式设置的 store/CLI，不依赖宿主环境。
 *
 * 维护：本清单与 src/config/loader.ts:FIELDS 的 env 命名保持一致（新增字段时同步）。
 */
const CONFIG_ENV_KEYS = [
  "HOST",
  "PORT",
  "CACHE_TYPE",
  "PROXY_PROTOCOL",
  "AUTH_ENABLED",
  "AUTH_TYPE",
  "AUTH_USERNAME",
  "AUTH_PASSWORD",
  "JWT_SECRET",
  "AUTH_LOGGING",
  "LOG_LEVEL",
  "LOG_FILE_LEVEL",
  "LOG_FILE",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_URL",
  "UPSTREAM_HOST",
  "UPSTREAM_PORT",
  "UPSTREAM_SECURE",
  "UPSTREAM_USERNAME",
  "UPSTREAM_PASSWORD",
  "UPSTREAM_CA",
  "UPSTREAM_INSECURE",
  "UPSTREAM_PROTOCOL",
  "TLS_KEY",
  "TLS_CERT",
  "TLS_CA",
  "TLS_PASSPHRASE",
  "PROXY_MODE",
  "CLUSTER_WORKERS",
  "USE_HOME_CONFIG",
] as const;

for (const key of CONFIG_ENV_KEYS) {
  delete process.env[key];
}
