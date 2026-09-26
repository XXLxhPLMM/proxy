/**
 * 配置日志打印 - 独立文件避免 index.ts 与 cluster.ts 循环依赖
 * 职责：打印脱敏后的配置快照，对常见误配给出告警
 *
 * **零全局读取**：配置快照一律经调用方注入的 `ConfigProvider` 取
 * （`snapshot()`），落盘一律经注入的 `LoggerProvider`。此前本文件裸调
 * `getAll()` 与模块级 `logger` 单例——同进程多实例时，master 或 A 实例打的
 * 配置摘要用的是 B 实例那份配置/等级/文件，等于把「谁的配置」和「谁的日志」
 * 彻底搅在一起。
 */

import { keysByPhase } from "@/config/schema/fields.js";
import { loadAuthUsers } from "@/config/resources/users/reader.js";
import { accountPolicyCounts } from "@/config/resources/users/policy.js";
import { loadAcl } from "@/config/resources/acl/reader.js";
import type { ConfigProvider, LoggerProvider } from "@/plugins/contracts.js";
import type { Logger } from "@/utils/log/logger.js";

/**
 * 账号级策略摘要（`users.json` 内联的 `acl` / `quota`）
 * @description **只报数、不报内容**：名单条目与配额上限属于策略而非凭证，但启动摘要
 * 的定位是「配置有没有被读进去」，逐条打印会让摘要被策略内容淹没（且账号表可能很长）。
 *
 * 鉴权关闭时打 **warn**：账号级策略需要身份才能定位，没有身份时它**永远不生效**。
 * 这不是 bug 而是契约，不说出来会让人反复排查「为什么配了没用」。
 * @param log - 本实例日志器
 * @param authUsersFile - 账号表路径（由调用方从自己的 scope 取出）
 * @param authEnabled - 本实例是否开启鉴权（决定账号级策略是否可能生效）
 * @param authType - 鉴权类型；`jwt` 下账号表不参与凭证校验但**仍**承载账号级策略
 */
function logAccountPolicies(
  log: Logger,
  authUsersFile: string,
  authEnabled: boolean,
  authType?: string,
): void {
  const counts = accountPolicyCounts(loadAuthUsers(authUsersFile));

  if (counts.withAcl === 0 && counts.withQuota === 0) {
    return;
  }

  const kind = authType === "jwt" ? "（jwt：账号表不参与凭证校验，仅承载账号级策略）" : "";
  log.notice(
    "info",
    `[config] 账号级策略 users-with-acl=${counts.withAcl}/${counts.total} ` +
      `users-with-quota=${counts.withQuota}/${counts.total}${kind}`,
  );

  if (!authEnabled) {
    log.notice(
      "warn",
      "[config] AUTH_ENABLED=false：账号级 acl/quota 不会生效（判定需要一个已鉴权用户名才能定位策略），当前只有全局 ACL_FILE 生效",
    );
  }
}

/**
 * 打印脱敏后的配置快照，对常见误配给出告警
 *
 * master 进程与单进程模式均调用此函数；两份调用点各自传入**自己那份**配置与日志器。
 *
 * @param config - 本次启动所用配置插件（取 `snapshot()` 读值）
 * @param logger - 承载本次输出的日志器（实例级，不落进程级门面）
 */
export function logConfig(config: ConfigProvider, logger: LoggerProvider): void {
  const all = config.snapshot();
  const log = logger.logger;
  const safeAll = {
    ...all,
    jwtSecret: all.jwtSecret ? "***" : "",
    tlsPassphrase: all.tlsPassphrase ? "***" : "",
    // 上游凭证可独立于 upstreamUrl 配置：只脱敏 URL 形态会漏掉 UPSTREAM_PASSWORD 明文
    upstreamPassword: all.upstreamPassword ? "***" : "",
    upstreamUrl: all.upstreamUrl.replace(/\/\/[^@/]*@/, "//***@"),
    // 账号密码不经过配置快照（存于 AUTH_USERS_FILE 指向的文件），快照天然无明文
  };

  // 启动事实摘要：默认控制台 error 级也必须可见（notice 只绕控制台门限，落盘仍归 fileLevel）
  log.notice(
    "info",
    `[config] protocol=${all.proxyProtocol} listen=${all.host}:${all.port} upstream=${safeAll.upstreamUrl || "(none，直连)"}`,
  );

  log.debug("=== config ===", safeAll);
  const { startup, runtime } = keysByPhase();
  log.info(`[config] 启动期字段（改动需重启生效）: ${startup.join(" ")}`);
  log.debug(`[config] 运行时可热改字段: ${runtime.join(" ")}`);
  if (all.authEnabled) {
    if (all.authType === "basic" || all.authType === "uid") {
      const users = loadAuthUsers(all.authUsersFile);
      const names = users.map((u) => u.username).join(",");
      log.notice(
        "info",
        `[config] auth ENABLED type=${all.authType} accounts=${users.length} users=${names || "(none)"} file=${all.authUsersFile}`,
      );
      if (users.length === 0) {
        // 空账号表：auth 侧一律判否（loader 亦会在启动期拦截该配置）
        log.notice("warn", "[config] auth 已开启但账号表为空，鉴权将全部拒绝");
      } else if (all.authType === "basic" && users.some((u) => !u.password)) {
        // 空密码并非"全部拒绝"：Basic 仍接受 `user:` 形态，该账号仅按用户名校验
        log.notice("warn", "[config] auth basic 存在空密码账号，这些账号仅按用户名校验，建议补密码");
      }
      logAccountPolicies(log, all.authUsersFile, all.authEnabled);
    } else if (all.authType === "jwt") {
      log.notice(
        "info",
        `[config] auth ENABLED type=jwt jwtSecret=${all.jwtSecret ? "***已设置" : "(empty)"}`,
      );
      if (!all.jwtSecret)
        log.notice("warn", "[config] auth jwt 已开启但 JWT_SECRET 为空，鉴权将全部拒绝");
      // jwt 模式下账号表**不参与凭证校验**，但仍然承载「按身份的访问控制 / 流量配额」——
      // token 的 sub/username 命中哪个账号，就套那个账号的 acl/quota。这条必须写进启动摘要，
      // 否则「配了却没生效」会被误判成 bug
      logAccountPolicies(log, all.authUsersFile, all.authEnabled, "jwt");
    } else {
      log.notice(
        "warn",
        `[config] auth ENABLED 但 authType=${all.authType} 非 basic/jwt/uid，将视为放行`,
      );
    }
  } else {
    log.notice("info", "[config] auth DISABLED 鉴权关闭，所有请求放行");
    // 鉴权关闭 = 没有身份 = 账号级名单与配额**永远不生效**（判定需要一个用户名才能定位策略）。
    // 这不是 bug 而是契约，静默不响会让人以为「配了没生效」
    logAccountPolicies(log, all.authUsersFile, false);
  }

  const acl = loadAcl(all.aclFile);
  const aclActive =
    acl.clientIp.whitelist.length > 0 ||
    acl.clientIp.blacklist.length > 0 ||
    acl.target.whitelist.length > 0 ||
    acl.target.blacklist.length > 0;
  log.notice(
    "info",
    `[config] acl ${aclActive ? "ACTIVE" : "EMPTY（不拦任何请求）"} file=${all.aclFile} ` +
      `clientIp(whitelist=${acl.clientIp.whitelist.length} blacklist=${acl.clientIp.blacklist.length}) ` +
      `target(whitelist=${acl.target.whitelist.length} blacklist=${acl.target.blacklist.length})`,
  );

  if (all.proxyProtocol === "https" || all.proxyProtocol === "sockss4" || all.proxyProtocol === "sockss5") {
    log.notice(
      "info",
      `[config] tls cert paths key=${all.tlsKey} cert=${all.tlsCert} ca=${all.tlsCa} protocol=${all.proxyProtocol}`,
    );
  }
}
