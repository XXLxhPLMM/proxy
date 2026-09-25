import os from "node:os";
import path from "node:path";
import { set } from "@/config/store.js";

/**
 * 测试环境隔离：清除终端/CI 残留的代理配置环境变量。
 *
 * 背景：CLI 初始化器对「显式提供但非法」的环境变量一律抛错阻止启动。
 * 测试应只依赖自身显式设置的 store、env/argv 参数或 CLI，不继承终端/CI 的配置噪音。
 *
 * 维护：本清单与 src/config/fields.ts:FIELDS 的 env 命名保持一致（新增字段时同步）。
 * 账号/名单已改为独立 JSON 文件：FIELDS 删除了 AUTH_USERNAME/AUTH_PASSWORD，
 * 相应换成 AUTH_USERS_FILE/ACL_FILE。
 */
const CONFIG_ENV_KEYS = [
  "HOST",
  "PORT",
  "CACHE_TYPE",
  "PROXY_PROTOCOL",
  "AUTH_ENABLED",
  "AUTH_TYPE",
  "AUTH_USERS_FILE",
  "ACL_FILE",
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

/**
 * 钉住鉴权开关：删除环境变量挡不住 **env 文件**——显式调用 CLI `initConfig()` 时，
 * `loadEnvFiles()` 会照读仓库里的 `.env.development`（它可能开启鉴权并指向本地账号表）。
 * 这里给一个进程级值：`loadEnvFiles()` 不覆盖终端已有变量，故 env 文件的同名值失效；
 * 库模式测试继续直接使用自己的 `ConfigStore` / 显式 env，不进入 CLI 初始化路径。
 */
process.env.AUTH_ENABLED = "false";

/**
 * 钉住日志落盘目标：默认值 / `.env.development` 都指向仓库的 `log/`，
 * 测试一旦走到 warn 路径（坏配置、ACL 拒绝、上游失败…）就会把用例日志写进真实运行日志目录。
 * 该目录被 .gitignore 忽略，混进去几乎无法察觉，故测试一律不落盘；
 * 需要断言落盘行为的用例自己 `set("logFile", <temp dir>)`（见 log-structured / logger 测试）。
 */
process.env.LOG_FILE = "";

/**
 * 钉住 ACL / 账号文件路径：FIELDS 默认值是 `<cwd>/cfg/acl.json` 与 `<cwd>/cfg/users.json`，
 * 而这两个文件被 .gitignore 忽略、属于开发者本地配置（例如本地 ACL 只放行某几个域名）。
 * 不钉住则本机跑测试会把本地名单当成测试环境的一部分——实测出现过
 * 「本地 cfg/acl.json 带 target 白名单 → 74 个集成用例全被 403」的整片假失败。
 * 这里指向**不存在**的绝对路径：readJsonCached 对缺失文件回退空配置（名单=全放行、账号=空表），
 * 需要名单/账号的用例自行 `set("aclFile"|"authUsersFile", <temp 文件>)`，
 * 或给子进程传 CLI（CLI 优先于 env，见 http-proxy-chain 的 `--auth-users-file`）。
 */
const TEST_MISSING_ACL = path.join(os.tmpdir(), "proxy-test-nonexistent-acl.json");
const TEST_MISSING_USERS = path.join(os.tmpdir(), "proxy-test-nonexistent-users.json");
process.env.ACL_FILE = TEST_MISSING_ACL;
process.env.AUTH_USERS_FILE = TEST_MISSING_USERS;

/**
 * 同时钉住 store：CLI `initConfig()` 现在只会被显式调用，多数 core/库测试始终直接读 defaults；
 * 仅钉 env 无法阻止这些路径按默认 `log` / 仓库 `cfg/*.json` 工作。
 * 这里 `set()` 的值与上面 env 保持一致：若个别用例显式初始化 CLI，写回的也是同一组安全值。
 */
set("logFile", "");
set("aclFile", TEST_MISSING_ACL);
set("authUsersFile", TEST_MISSING_USERS);

