/**
 * 配置日志打印 - 独立文件避免 index.ts 与 cluster.ts 循环依赖
 * 职责：打印脱敏后的配置快照，对常见误配给出告警
 */

import { getAll } from "@/config/store.js";
// 直接引 fields（纯表工具）：经 loader.js 转发会把 CLI 的 initConfig() 自执行拖进库路径
import { keysByPhase } from "@/config/fields.js";
import { loadAuthUsers } from "@/config/auth-users.js";
import { loadAcl } from "@/config/acl.js";
import { logger } from "@/utils/logger.js";

/**
 * 打印脱敏后的配置快照，对常见误配给出告警
 * master 进程与单进程模式均调用此函数
 */
export function logConfig(): void {
  const all = getAll();
  const safeAll = {
    ...all,
    jwtSecret: all.jwtSecret ? "***" : "",
    tlsPassphrase: all.tlsPassphrase ? "***" : "",
    // 上游凭证可独立于 upstreamUrl 配置：只脱敏 URL 形态会漏掉 UPSTREAM_PASSWORD 明文
    upstreamPassword: all.upstreamPassword ? "***" : "",
    upstreamUrl: all.upstreamUrl.replace(/\/\/[^@/]*@/, "//***@"),
    // 账号密码不经过 store（存于 AUTH_USERS_FILE 指向的文件），快照天然无明文
  };

  // 启动事实摘要：默认控制台 error 级也必须可见（notice 只绕控制台门限，落盘仍归 fileLevel）
  logger.notice(
    "info",
    `[config] protocol=${all.proxyProtocol} listen=${all.host}:${all.port} upstream=${safeAll.upstreamUrl || "(none，直连)"}`,
  );

  logger.debug("=== config ===", safeAll);
  const { startup, runtime } = keysByPhase();
  logger.info(`[config] 启动期字段（改动需重启生效）: ${startup.join(" ")}`);
  logger.debug(`[config] 运行时可热改字段: ${runtime.join(" ")}`);
  if (all.authEnabled) {
    if (all.authType === "basic" || all.authType === "uid") {
      const users = loadAuthUsers();
      const names = users.map((u) => u.username).join(",");
      logger.notice(
        "info",
        `[config] auth ENABLED type=${all.authType} accounts=${users.length} users=${names || "(none)"} file=${all.authUsersFile}`,
      );
      if (users.length === 0) {
        // 空账号表：auth 侧一律判否（loader 亦会在启动期拦截该配置）
        logger.notice("warn", "[config] auth 已开启但账号表为空，鉴权将全部拒绝");
      } else if (all.authType === "basic" && users.some((u) => !u.password)) {
        // 空密码并非"全部拒绝"：Basic 仍接受 `user:` 形态，该账号仅按用户名校验
        logger.notice("warn", "[config] auth basic 存在空密码账号，这些账号仅按用户名校验，建议补密码");
      }
    } else if (all.authType === "jwt") {
      logger.notice(
        "info",
        `[config] auth ENABLED type=jwt jwtSecret=${all.jwtSecret ? "***已设置" : "(empty)"}`,
      );
      if (!all.jwtSecret)
        logger.notice(
          "warn",
          "[config] auth jwt 已开启但 JWT_SECRET 为空，鉴权将全部拒绝",
        );
    } else {
      logger.notice(
        "warn",
        `[config] auth ENABLED 但 authType=${all.authType} 非 basic/jwt/uid，将视为放行`,
      );
    }
  } else {
    logger.notice("info", "[config] auth DISABLED 鉴权关闭，所有请求放行");
  }

  const acl = loadAcl();
  const aclActive =
    acl.clientIp.whitelist.length > 0 ||
    acl.clientIp.blacklist.length > 0 ||
    acl.target.whitelist.length > 0 ||
    acl.target.blacklist.length > 0;
  logger.notice(
    "info",
    `[config] acl ${aclActive ? "ACTIVE" : "EMPTY（不拦任何请求）"} file=${all.aclFile} ` +
      `clientIp(whitelist=${acl.clientIp.whitelist.length} blacklist=${acl.clientIp.blacklist.length}) ` +
      `target(whitelist=${acl.target.whitelist.length} blacklist=${acl.target.blacklist.length})`,
  );

  if (all.proxyProtocol === "https" || all.proxyProtocol === "sockss4" || all.proxyProtocol === "sockss5") {
    logger.notice(
      "info",
      `[config] tls cert paths key=${all.tlsKey} cert=${all.tlsCert} ca=${all.tlsCa} protocol=${all.proxyProtocol}`,
    );
  }
}
