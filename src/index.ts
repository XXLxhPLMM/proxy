/**
 * 入口 - 代理服务编排与进程生命周期
 * 文件职责：
 * - 工厂 createProxy：按 store.get("proxyProtocol") 创建 HttpProxy/HttpsProxy/TlsProxy，注入 createAuthFromConfig() 统一鉴权，所有实例遵循 ProxyCore/Lifecycle 状态机
 * - 进程守卫 setupProcessGuards：捕获 uncaughtException/unhandledRejection/warning 仅日志不退出，防止单连接异常击穿常驻进程
 * - 编排器 ProxyApp：封装 config 脱敏打印/鉴权专项日志/TLS 路径日志、stateChange 监听、优雅启停（grace 10s）、SIGINT/SIGTERM 绑定、EADDRINUSE 下一端口提示
 * - 导出 run()/ProxyApp 供直接执行或测试注入
 * 关联：依赖 config/loader 副作用初始化、core 各 doStart、utils/logger 单例
 */
import "./config/loader.js";
import { get, getAll } from "./config/store.js";
import { createAuthFromConfig } from "./core/auth.js";
import { HttpProxy } from "./core/http.js";
import { HttpsProxy } from "./core/https.js";
import { TlsProxy } from "./core/tls.js";
import { SocksProxy } from "./core/socks/index.js";
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
      // 双端均为 HTTPS：客户端先 TLS 握手再发 HTTP/CONNECT，服务端为 https.Server（需 keys/server.crt/key，覆盖 TLS_CERT/TLS_KEY）
      return new HttpsProxy({ port, auth });
    case "socks":
      return new SocksProxy({ port, auth });
    case "tls":
      // 双端均为 mTLS 透传：tls.Server 握手后按 CONNECT 透传 TCP，客户端需 client.crt/key，服务端校验 ca.crt（覆盖 TLS_CA）
      return new TlsProxy({ port, auth });
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

/**
 * ProxyApp - 服务生命周期编排器
 * 职责：配置校验 -> 创建代理 -> 状态机流转 -> 优雅启停 -> 探针
 */
export class ProxyApp {
  private proxy: ProxyCore | null = null;
  private shuttingDown = false;

  /** 启动流程：守卫 -> 校验 -> 建实例 -> 监听 -> 绑定信号 */
  async start(): Promise<ProxyCore> {
    setupProcessGuards();
    const all = getAll();
    const safeAll = { ...all, authPassword: all.authPassword ? "***" : "", jwtSecret: all.jwtSecret ? "***" : "" };
    logger.debug("=== config ===", safeAll);
    if (all.authEnabled) {
      if (all.authType === "basic") {
        logger.info(`[config] auth ENABLED type=basic username=${all.authUsername || "(empty)"} password=${all.authPassword ? "***已设置" : "(empty)"}`);
        if (!all.authUsername || !all.authPassword) logger.warn("[config] auth basic 已开启但用户名或密码为空，鉴权将全部拒绝");
      } else if (all.authType === "jwt") {
        logger.info(`[config] auth ENABLED type=jwt jwtSecret=${all.jwtSecret ? "***已设置" : "(empty)"}`);
        if (!all.jwtSecret) logger.warn("[config] auth jwt 已开启但 JWT_SECRET 为空，鉴权将全部拒绝");
      } else {
        logger.warn(`[config] auth ENABLED 但 authType=${all.authType} 非 basic/jwt，将视为放行`);
      }
    } else {
      logger.info("[config] auth DISABLED 鉴权关闭，所有请求放行");
    }
    if (all.proxyProtocol === "https" || all.proxyProtocol === "tls") {
      logger.info(`[config] tls cert paths key=${all.tlsKey} cert=${all.tlsCert} ca=${all.tlsCa} protocol=${all.proxyProtocol}`);
    }

    this.proxy = createProxy();
    // 状态变更可观测
    (this.proxy as unknown as import("node:events").EventEmitter).on?.("stateChange", (next: string, prev: string) => {
      logger.info(`[lifecycle] state ${prev} -> ${next} protocol=${this.proxy?.protocol}`);
    });

    this.bindSignals();
    await this.proxy.start();
    const stats = this.proxy.getStats();
    logger.info(`proxy started: ${stats.protocol}://${stats.host}:${stats.port} running=${stats.running} state=${this.proxy.state}`);
    process.on("uncaughtExceptionMonitor", (err) => {
      logger.error("[monitor] 异常监控:", err);
    });
    return this.proxy;
  }

  /** 优雅停止：beforeStop -> doStop -> stopped，超时强制退出 */
  async stop(graceMs = 10000): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (!this.proxy) return;
    const timer = setTimeout(() => {
      logger.warn(`[shutdown] 优雅停止超时 ${graceMs}ms，强制退出`);
      process.exit(1);
    }, graceMs);
    timer.unref();
    try {
      await this.proxy.stop();
      logger.info("[shutdown] 代理已停止");
    } catch (err) {
      logger.error("[shutdown] 停止代理失败:", err);
    } finally {
      clearTimeout(timer);
    }
  }

  getProxy(): ProxyCore | null {
    return this.proxy;
  }

  private bindSignals(): void {
    const handler = async () => {
      await this.stop();
      process.exit(0);
    };
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
  }
}

export async function run(): Promise<void> {
  const app = new ProxyApp();
  await app.start();
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
