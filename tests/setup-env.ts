import os from "node:os";
import path from "node:path";
import { set } from "./helpers/config.js";

/**
 * 测试环境隔离：清除终端/CI 残留的代理配置环境变量。
 *
 * 背景：CLI 初始化器对「显式提供但非法」的环境变量一律抛错阻止启动。
 * 测试应只依赖自身显式设置的 store、env/argv 参数或 CLI，不继承终端/CI 的配置噪音。
 *
 * 维护：本清单与 src/config/schema/fields.ts:FIELDS 的 env 命名保持一致（新增字段时同步）。
 * 账号/名单以独立 JSON 文件给出：`AUTH_USERS_FILE` / `ACL_FILE`。
 *
 * **本清单必须导出**：漏加一项 = 宿主的那个 env 静默漏进测试环境，
 * 而这类污染的表现是「某个用例在有该 env 的机器上红、在 CI 上绿」——比直接失败更难查。
 * `tests/unit/config/quota-fields.test.ts` 断言它与 `FIELDS` 的 env 键集合逐项相同。
 */
export const CONFIG_ENV_KEYS = [
  "HOST",
  "PORT",
  "PROXY_PROTOCOL",
  "AUTH_ENABLED",
  "AUTH_TYPE",
  "AUTH_USERS_FILE",
  // 账号表的数据来源（json=cfg/users.json / sqlite=cfg/users.db）与后者的路径。
  // 三个键都进清单：宿主的这三个 env 一样会被静默漏进测试环境（漏 AUTH_USERS_DRIVER 的
  // 后果最隐蔽——它决定读哪个后端，漏清就等于「测试跑在开发者本机选的那个后端上」）。
  "AUTH_USERS_DRIVER",
  "AUTH_USERS_DB",
  "ACL_FILE",
  "QUOTA_USAGE_DIR",
  "QUOTA_USAGE_DRIVER",
  "ACL_DRIVER",
  "QUOTA_RESET_HOUR",
  "QUOTA_FLUSH_INTERVAL",
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
  "USE_HOME_CONFIG",
  // 管理面五键。MANAGER_TOKEN 清它是因为**真会出事**：集成用例 spawn CLI 时把宿主环境
  // 快照显式传给 loadConfig，而 MANAGER_ENABLED=true + 空 token 是启动期 abort ——
  // 于是开发者终端里的一个 MANAGER_ENABLED 能让整批 spawn 用例红，且错误信息离真因很远。
  // MANAGER_CORS_ORIGINS 同一档：它语法非法也是启动期 abort（见 validate.ts 的
  // CORS_ORIGINS_SHAPE），而它对集成用例毫无用处。
  "MANAGER_ENABLED",
  "MANAGER_HOST",
  "MANAGER_PORT",
  "MANAGER_TOKEN",
  "MANAGER_CORS_ORIGINS",
] as const;

for (const key of CONFIG_ENV_KEYS) {
  delete process.env[key];
}

/**
 * 清除「代理选择变量」：这些不是本项目配置键（故不进 CONFIG_ENV_KEYS，那份与 FIELDS 同步），
 * 而是宿主/CI 终端上的客户端代理选择噪音。必须清的原因（真实坑）：
 * curl 对**显式 `-x`/`--socks5`/`--socks4` 指定的代理同样套用 NO_PROXY**，
 * 名单内的目标（极常见的 `no_proxy=127.0.0.1,localhost,::1`）会被**绕过被测代理直连源站**，
 * 于是「本该被鉴权/ACL 拒绝」的用例拿到 200，表现为**假的放行结果**——静默通过，测不出回归。
 * 不清则任何 spawn("curl") 的用例结果取决于开发者本机的代理设置，CI 与本地行为分叉。
 * 大小写两种形态都清：不同工具（curl/其它客户端）读的名字并不一致。
 */
const PROXY_SELECTION_ENV_KEYS = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "no_proxy",
  "NO_PROXY",
  "ftp_proxy",
  "FTP_PROXY",
] as const;

for (const key of PROXY_SELECTION_ENV_KEYS) {
  delete process.env[key];
}

/**
 * 钉住鉴权开关：删除环境变量挡不住 **env 文件**——CLI 显式调用 `loadConfig()` 时会传入
 * `.env.*` 候选路径（它可能开启鉴权并指向本地账号表）。这里给一个进程级值：
 * 显式 env 优先于文件值，故文件中的同名项失效；库测试继续传自己的 env/envFiles。
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
 * 不钉住则本机跑测试会把本地名单当成测试环境的一部分——表现为「整片假失败」
 * （本地 `cfg/acl.json` 带 target 白名单时，集成用例被本地名单成批拒绝）。
 * 这里指向**不存在**的绝对路径：readJsonCached 对缺失文件回退空配置（名单=全放行、账号=空表），
 * 需要名单/账号的用例自行 `set("aclFile"|"authUsersFile", <temp 文件>)`，
 * 或给子进程传 CLI（CLI 优先于 env，见 http-proxy-chain 的 `--auth-users-file`）。
 */
const TEST_MISSING_ACL = path.join(os.tmpdir(), "proxy-test-nonexistent-acl.json");
const TEST_MISSING_USERS = path.join(os.tmpdir(), "proxy-test-nonexistent-users.json");
process.env.ACL_FILE = TEST_MISSING_ACL;
process.env.AUTH_USERS_FILE = TEST_MISSING_USERS;

/**
 * 同时钉住测试 store：多数 core/库测试直接注入 testConfig，不执行 CLI loader；
 * 仅钉 env 无法改变这些路径的默认值。这里写入显式测试实例，避免落盘/本地名单串入。
 */
set("logFile", "");
set("aclFile", TEST_MISSING_ACL);
set("authUsersFile", TEST_MISSING_USERS);

/**
 * 钉住**流量配额账本目录**：与上面三项同一纪律，**但性质更糟**。
 *
 * 账号表 / 名单 / 日志只是「读到脏数据」；账本目录是**往仓库里写文件**。走 `loadConfig` 的
 * 用例因此在这里被统一钉到 `os.tmpdir()` 下一个**不存在的绝对路径**：账本的 `open()` 会
 * `mkdir` 建它，而那是系统临时目录，测试跑完随系统清理，**不再落在仓库里**。
 * 需要断言账本内容的用例自己给路径（见 `integration/quota/ledger-fixture.ts`：
 * 它的 store 自带全部钉值，不吃这里的 `set(...)`）。
 *
 * ⚠️ **这道防线只覆盖走 `loadConfig` 的用例**，而触发面**不是**「配额用例」这么窄：
 * **任何**走库模式内联 config 的用例都绕开它。`createProxyRuntime({ config: <内联对象> })`
 * 压根不经 `loadConfig`——它 `new ConfigStore(内联)`（一个与 `testConfigStore` 毫无关系的
 * 新实例）补缺省，于是下面两个钉值**两侧全落空**：`process.env.QUOTA_USAGE_DIR` 它不读，
 * `set("quotaUsageDir", …)` 改的是另一个 store；下面的 `QUOTA_USAGE_DRIVER=sqlite` 同理落空，
 * 于是驱动也回到产品缺省 `json`。
 *
 * 三条机制合起来才是完整的那句话：**① 库模式不经 `loadConfig`** → 钉值失效；
 * **② `configDir` 缺省 = `process.cwd()`**（= 仓库根）**且 `quotaUsageDir` 的 FIELDS 缺省是
 * 相对路径 `cfg/usage`** → `createConfigContext` 把它按 `configDir` 绝对化成 `<仓库根>/cfg/usage`；
 * **③ `open()` 在 `start()` 里就跑，与是否真计量无关**（配额为零也照建）→ 于是一条字节都没传的
 * 用例照样在仓库里留下 `cfg/usage/usage.jsonl`。
 *
 * 那类用例**必须逐处自己给 `quotaUsageDir`**（或给仓库外的 `configDir`）。基准档是
 * `integration/quota/`：`inert-and-assembly.test.ts`
 * 继承 4 处，`ledger-*.test.ts` 三档走 `ledger-fixture.ts` 的自带 store。
 * 各档已在自己的内联 config 上钉死的例子见 `runtime/custom-services-wiring.test.ts`。
 */
const TEST_LEDGER_DIR = path.join(os.tmpdir(), "proxy-test-nonexistent-quota-ledger");
process.env.QUOTA_USAGE_DIR = TEST_LEDGER_DIR;
set("quotaUsageDir", TEST_LEDGER_DIR);

/**
 * 钉住两个数据来源的后端：`AUTH_USERS_DRIVER=json` / `QUOTA_USAGE_DRIVER=sqlite`
 *
 * @description 钉值的后果不是「跑错后端」这么轻：绝大多数用例是**围绕某一个后端写的**
 * （如 `unit/datasource/quota/sqlite/layout.test.ts` 直接读 `usage.db`），而宿主/CI 上若恰好设了
 * `QUOTA_USAGE_DRIVER=json`，那些断言会去读 `usage.jsonl`，于是**全部账本用例一起红**
 * 而错误信息完全指不到真正的原因（配置漂移）。
 *
 * ⚠️ **账本这个钉值刻意不跟随产品缺省**（缺省是 `json`）：绝大多数账本用例读的是 `usage.db`，
 * 让它们跟着缺省漂移等于把 90 个文件的行为绑在一个产品决策上。要改产品缺省**不许**改这里。
 *
 * 顺带把 `authUsersDb` 指到临时目录：sqlite 档的账号库绝不能落在仓库里（同 `quotaUsageDir`
 * 的理由，见上面那段）。**故意指向一个不存在的路径** —— 缺省档（json）下它压根不会被打开。
 */
const TEST_ACCOUNTS_DB = path.join(os.tmpdir(), "proxy-test-nonexistent-users.db");
process.env.AUTH_USERS_DRIVER = "json";
set("authUsersDriver", "json");
process.env.AUTH_USERS_DB = TEST_ACCOUNTS_DB;
set("authUsersDb", TEST_ACCOUNTS_DB);
process.env.QUOTA_USAGE_DRIVER = "sqlite";
set("quotaUsageDriver", "sqlite");
