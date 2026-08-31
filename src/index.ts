import "./config/loader.js";
import { get, getAll } from "./config/store.js";
import { createAuthFromConfig } from "./core/auth.js";
import { HttpProxy } from "./core/http.js";
import type { ProxyCore } from "./core/types.js";
import { logger } from "./utils/logger.js";

/**
 * 按 proxyProtocol 创建对应代理实例
 * 语义：proxyProtocol 同时决定 服务端 与 客户端 的协议形态
 * - 服务端：决定创建何种 ProxyCore 及底层 Server（http.Server / tls.Server / net.Server + SOCKS 握手）
 * - 客户端：约束客户端应以何种方式连接本代理（浏览器 http 代理设置 vs socks5:// 客户端 vs mTLS 客户端）
 * 当前仅 http 已落地，https/socks/tls 占位抛错，后续按同一 ProxyProtocol 扩展对应类
 */
function createProxy(): ProxyCore {
  const protocol = get("proxyProtocol");
  const port = get("port");
  const auth = createAuthFromConfig();

  switch (protocol) {
    case "http":
      // 双端均为 HTTP：客户端发 GET http://host/ 或 CONNECT host:port，服务端用 HttpProxy 解析
      return new HttpProxy({ port, auth });
    case "https":
      // 双端均为 HTTPS：客户端先 TLS 握手再发 HTTP/CONNECT，服务端需证书；当前复用 HttpProxy 占位
      return new HttpProxy({ port, auth });
    case "socks":
      // 双端均为 SOCKS5：客户端按 RFC1928 帧握手，服务端按 SOCKS5 解析并透传
      throw new Error(`proxyProtocol=${protocol} 尚未实现，请使用 http`);
    case "tls":
      // 双端均为 mTLS 透传：客户端与服务端均需证书校验，握手后透传 TCP
      throw new Error(`proxyProtocol=${protocol} 尚未实现，请使用 http`);
    default:
      throw new Error(`未知代理协议: ${protocol}`);
  }
}

/** 进程级容错：捕获未处理异常，避免代理进程意外退出，统一走 logger */
function setupProcessGuards(): void {
  if ((globalThis as unknown as { __proxyGuardsInstalled?: boolean }).__proxyGuardsInstalled) return;
  (globalThis as unknown as { __proxyGuardsInstalled: boolean }).__proxyGuardsInstalled = true;

  process.on("uncaughtException", (err) => {
    logger.error("[uncaughtException] 代理进程捕获未处理异常，继续运行:", err);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("[unhandledRejection] 代理进程捕获未处理拒绝，继续运行:", reason);
  });
  process.on("warning", (warning) => {
    logger.warn("[warning]", warning.name, warning.message);
  });
}

export async function run(): Promise<void> {
  setupProcessGuards();

  const all = getAll();
  logger.info("=== config ===", all);

  const proxy = createProxy();

  const stop = async () => {
    try {
      await proxy.stop();
      logger.info("[shutdown] 代理已停止");
    } catch (err) {
      logger.error("[shutdown] 停止代理失败:", err);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await proxy.start();
  const stats = proxy.getStats();
  logger.info(`proxy started: ${stats.protocol}://${stats.host}:${stats.port} running=${stats.running}`);

  process.on("uncaughtExceptionMonitor", (err) => {
    logger.error("[monitor] 异常监控:", err);
  });
}

// 直接执行时启动
if (require.main === module) {
  run().catch((err) => {
    const e = err as NodeJS.ErrnoException & { port?: number; address?: string };
    if (e?.code === "EADDRINUSE") {
      const p = e.port ?? get("port");
      const next = Number(p) + 1;
      logger.error(`proxy 启动失败: 端口 ${p} 已被占用 (EADDRINUSE)`);
      logger.error(`解决: 1) 释放端口: netstat -ano | findstr :${p} -> taskkill //PID <pid> //F`);
      logger.error(`     2) 换端口启动: pnpm start -- --port ${next}  或  $env:PORT=${next}; pnpm start`);
      logger.error(`     3) 检查 .env 中 PORT 是否冲突 (当前 PORT=${p}，建议尝试 ${next})`);
    } else {
      logger.error("proxy 启动失败:", err);
    }
    process.exit(1);
  });
}
