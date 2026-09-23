/**
 * CLI 入口 - 承载全部副作用与进程启动
 * 职责：
 * - 副作用导入：加载即完成 env 文件读取与配置校验（见 config/loader.ts:initConfig）
 * - 作为脚本直接执行时（require.main === module），走 runServer 启动服务
 * - EADDRINUSE 单独处理：给出占用排查命令与换端口建议，避免用户面对裸堆栈
 *
 * 构建：esbuild 以本文件为 entryPoints 打包出 dist/app.js（+ app-v16/v22），
 * `node dist/app.js` 的启动语义与拆分前完全一致。
 * 库入口（src/index.ts）保持纯导出，本文件是唯一的副作用承载者。
 */

import "./config/loader.js";
import { get, runServer } from "./index.js";
import { logger } from "./utils/logger.js";

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
    // 显式退出会截断在途 appendFile：等齐上面几行 error 再退
    void logger.flush().finally(() => process.exit(1));
  });
}
