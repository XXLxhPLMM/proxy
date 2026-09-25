/**
 * ProxyService - Cordis 运行时的代理服务端口
 * 只暴露立即返回 Promise 的启停操作，不向运行时泄漏旧 server 类型
 */
export interface ProxyService {
  start(): Promise<void>;
  stop(graceMs?: number): Promise<void>;
}

/**
 * LegacyProxyServerPort - 旧 ProxyServer 的最小结构类型
 * 返回 unknown 隔离具体代理内核类型，同时允许旧 start() 返回 ProxyCore
 */
export interface LegacyProxyServerPort {
  start(): Promise<unknown>;
  stop(graceMs?: number): Promise<void>;
}

/**
 * 将旧代理 server 包装为 Cordis 服务端口
 * async 包装保证即使旧实现同步抛错，调用方拿到的仍是 rejected Promise
 */
export function createProxyService(server: LegacyProxyServerPort): ProxyService {
  return {
    async start(): Promise<void> {
      await server.start();
    },
    async stop(graceMs?: number): Promise<void> {
      await server.stop(graceMs);
    },
  };
}

declare module "cordis" {
  interface Context {
    proxy: ProxyService;
  }
}
