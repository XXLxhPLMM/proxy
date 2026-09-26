import { logger, type Logger } from "@/utils/log/logger.js";

/**
 * Cordis 运行时的日志服务端口。
 *
 * 仅委托现有 `Logger` 对象；日志等级、console/JSONL 输出、文件轮转和
 * 落盘错误处理仍由 `src/utils/log/logger.ts` 负责，本层不复制这些实现。
 */
export interface LoggerService {
  /** 共享的原始 Logger 实例，保留现有完整日志 API。 */
  readonly logger: Logger;

  /** 委托现有 `Logger.child`，返回底层派生日志器。 */
  child(prefix: string): Logger;

  /** 委托现有 `Logger.flush`，等待所有在途落盘完成。 */
  flush(): Promise<void>;
}

/**
 * 创建只做委托的日志服务。
 *
 * @param root 共享的根 Logger，默认使用项目现有单例
 * @returns 不包含日志实现的应用日志服务
 */
export function createLoggerService(root: Logger = logger): LoggerService {
  return {
    logger: root,
    child(prefix: string): Logger {
      return root.child(prefix);
    },
    flush(): Promise<void> {
      return root.flush();
    },
  };
}
