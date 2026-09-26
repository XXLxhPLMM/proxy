/**
 * 建服 IO 收敛 - 把「listen 并等待就绪」的同一段 Promise 包装收到一处
 * 职责：供 http/https/net/tls 各 Server 复用（net.Server 为共同基类）
 * 约束：只做 listen-and-wait，不绑定任何 Server 具体类型，不处理就绪后的 server error
 * （那由各代理的 bindServer/onListenerReady 接管）
 */

/**
 * 可监听 server 的最小形状：net.Server / tls.Server / http.Server 均结构满足
 * 只声明实际用到的三个方法，避免绑定具体 Server 类型
 */
export interface ListenableServer {
  listen(port: number, host: string, cb: () => void): unknown;
  once(event: "error", cb: (e: Error) => void): unknown;
  off(event: "error", cb: (e: Error) => void): unknown;
}

/**
 * 监听端口并等待就绪
 * @description 监听期 error（如 EADDRINUSE）直接 reject；就绪后解绑临时 error 监听，
 * 避免启动失败监听器常驻（后续 server error 由各代理的 bindServer/onListenerReady 接管）
 * @param server - 任何具备 listen/once/off 的 Server 实例
 * @param port - 监听端口
 * @param host - 监听地址
 * @throws listen 失败时抛错，由调用方转 error 态
 * @example
 * ```ts
 * const s = net.createServer(onConn);
 * await listenAsync(s, 1080, "0.0.0.0");
 * ```
 */
export function listenAsync(server: ListenableServer, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
