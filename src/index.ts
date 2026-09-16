/**
 * 入口 - 统一导出
 * 双重角色：
 * - 作为库被 import 时，仅暴露 ProxyServer/runServer 与配置读写 API，不产生副作用（除配置初始化）
 * - 作为脚本直接执行时（require.main === module），走 runServer 启动服务
 */

// 副作用导入：加载即完成 env 文件读取与配置校验（见 config/loader.ts:initConfig）
import "./config/loader.js";
import { get } from "./config/store.js";
import { ProxyServer, runServer } from "./server/index.js";
import { logger } from "./utils/logger.js";

export { ProxyServer, runServer };
export { get, getAll, set } from "./config/store.js";

if (require.main === module) {
  runServer().catch((err: unknown) => {
    // EADDRINUSE 单独处理：给出占用排查命令与换端口建议，避免用户面对裸堆栈
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
