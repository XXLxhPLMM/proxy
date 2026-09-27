import net from "node:net";

/** 取一个空闲端口（先 listen(0) 再关闭） */
export function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** 定时等待 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 在 127.0.0.1 上监听端口并等待 listening 就绪（net/tls/http/https Server 通用） */
export function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
}
