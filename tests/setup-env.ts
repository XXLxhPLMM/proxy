import os from "node:os";
import path from "node:path";
import { set } from "@/config/store.js";

/**
 * 测试环境隔离：清除终端/CI 残留的代理配置环境变量。
 *
 * 背景：loader 对「显式提供但非法」的环境变量一律抛错阻止启动，
 * 终端里遗留的 AUTH_TYPE=pwd / PORT=444 之类脏值会让 loader 在 import 时直接抛错。
 * 测试应只依赖自身显式设置的 store/CLI，不依赖宿主环境。
 *
 * 维护：本清单与 src/config/loader.ts:FIELDS 的 env 命名保持一致（新增字段时同步）。
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
 * 钉住鉴权开关：删除环境变量挡不住 **env 文件**——`loadEnvFiles()` 会照读仓库里的
 * `.env.development`（它开着 `AUTH_ENABLED=true` 且账号表指向 ./cfg/users.json）。
 * 该文件是开发者的本地配置，可能不存在 users.json，而 `initConfig()` 会在**模块 import 期**
 * 执行并因「账号表为空」直接 abort，导致任何 import 了 loader 的测试整个文件加载失败。
 * 这里给一个终端级值：`loadEnvFiles()` 不覆盖终端已有变量，故 env 文件的同名值失效，
 * 测试从此只依赖自己显式 `set()` 的 store 值（要测鉴权请直接 `set("authEnabled", true)` 并注入 Auth）。
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
 * 同时钉住 store：vitest 直跑 TS 源码时 `loader.initConfig()` 可能从未执行
 * （多数用例只 import core，不经 `src/server/index.ts` 的 loader side-import），
 * 此时 `get()` 读到的是 store 的相对路径默认值，仅钉 env 无效
 * （`logFile` 同理——`get("logFile")` 恒为 `"log"`，只钉 `LOG_FILE` 挡不住落盘）。
 * 这里 `set()` 的值与上面 env 保持一致：真有用例链 import 了 loader，
 * `initConfig()` 写回的同为这些值，不存在覆盖竞态。
 */
set("logFile", "");
set("aclFile", TEST_MISSING_ACL);
set("authUsersFile", TEST_MISSING_USERS);

