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
import { loadAcl } from "@/config/resources/acl/reader.js";
import type { ConfigProvider, LoggerProvider } from "@/plugins/contracts.js";

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
    } else if (all.authType === "jwt") {
      log.notice(
        "info",
        `[config] auth ENABLED type=jwt jwtSecret=${all.jwtSecret ? "***已设置" : "(empty)"}`,
      );
      if (!all.jwtSecret)
        log.notice("warn", "[config] auth jwt 已开启但 JWT_SECRET 为空，鉴权将全部拒绝");
    } else {
      log.notice(
        "warn",
        `[config] auth ENABLED 但 authType=${all.authType} 非 basic/jwt/uid，将视为放行`,
      );
    }
  } else {
    log.notice("info", "[config] auth DISABLED 鉴权关闭，所有请求放行");
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
