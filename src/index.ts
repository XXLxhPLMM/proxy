/**
 * 入口 - 统一导出
 */

import "./config/loader.js";
import { get } from "./config/store.js";
import { ProxyServer, runServer } from "./server/index.js";
import { logger } from "./utils/logger.js";

export { ProxyServer, runServer };
export { get, getAll, set, config } from "./config/store.js";

if (require.main === module) {
  runServer().catch((err: unknown) => {
    const e = err as NodeJS.ErrnoException & { port?: number };
    if (e?.code === "EADDRINUSE") {
      const p = e.port ?? get("port");
      const next = Number(p) + 1;
      logger.error(`proxy 启动失败: 端口 ${p} 已被占用 (EADDRINUSE)`);
      logger.error(`解决: netstat -ano | findstr :${p} -> taskkill //PID <pid> //F`);
      logger.error(`换端口: pnpm start -- --port ${next}`);
    } else {
      logger.error("proxy 启动失败:", err);
    }
    process.exit(1);
  });
}
