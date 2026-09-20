/**
 * 配置日志打印 - 独立文件避免 index.ts 与 cluster.ts 循环依赖
 * 职责：打印脱敏后的配置快照，对常见误配给出告警
 */

import { getAll } from "@/config/store.js";
import { keysByPhase } from "@/config/loader.js";
import { logger } from "@/utils/logger.js";

/**
 * 打印脱敏后的配置快照，对常见误配给出告警
 * master 进程与单进程模式均调用此函数
 */
export function logConfig(): void {
  const all = getAll();
  const safeAll = {
    ...all,
    authPassword: all.authPassword ? "***" : "",
    jwtSecret: all.jwtSecret ? "***" : "",
    tlsPassphrase: all.tlsPassphrase ? "***" : "",
    upstreamUrl: all.upstreamUrl.replace(/\/\/[^@/]*@/, "//***@"),
  };
  logger.debug("=== config ===", safeAll);
  const { startup, runtime } = keysByPhase();
  logger.info(`[config] 启动期字段（改动需重启生效）: ${startup.join(" ")}`);
  logger.debug(`[config] 运行时可热改字段: ${runtime.join(" ")}`);
  if (all.authEnabled) {
    if (all.authType === "basic") {
      logger.info(
        `[config] auth ENABLED type=basic username=${all.authUsername || "(empty)"} password=${all.authPassword ? "***已设置" : "(empty)"}`,
      );
      if (!all.authUsername) {
        // 空用户名：auth 侧纵深防御会一律判否（loader 亦会在启动期拦截该配置）
        logger.warn("[config] auth basic 已开启但用户名为空，鉴权将全部拒绝");
      } else if (!all.authPassword) {
        // 密码为空时并非"全部拒绝"：Basic 仍接受 `user:` 形态，仅按用户名校验
        logger.warn("[config] auth basic 密码为空，仅按用户名校验，建议设置密码");
      }
    } else if (all.authType === "jwt") {
      logger.info(
        `[config] auth ENABLED type=jwt jwtSecret=${all.jwtSecret ? "***已设置" : "(empty)"}`,
      );
      if (!all.jwtSecret)
        logger.warn(
          "[config] auth jwt 已开启但 JWT_SECRET 为空，鉴权将全部拒绝",
        );
    } else if (all.authType === "uid") {
      logger.info(`[config] auth ENABLED type=uid username=${all.authUsername || "(empty)"}`);
      if (!all.authUsername) logger.warn("[config] auth uid 已开启但用户名为空，鉴权将全部拒绝");
    } else {
      logger.warn(
        `[config] auth ENABLED 但 authType=${all.authType} 非 basic/jwt/uid，将视为放行`,
      );
    }
  } else {
    logger.info("[config] auth DISABLED 鉴权关闭，所有请求放行");
  }
  if (all.proxyProtocol === "https" || all.proxyProtocol === "sockss4" || all.proxyProtocol === "sockss5") {
    logger.info(
      `[config] tls cert paths key=${all.tlsKey} cert=${all.tlsCert} ca=${all.tlsCa} protocol=${all.proxyProtocol}`,
    );
  }
}
