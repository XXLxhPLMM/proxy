import { getLogger } from "@/utils/log";
import net from "net";
import { ClientConnectTransform } from "@/utils/transform";
import { ConfigMap } from "@/config/load";
import { HTTPParser } from "http-parser-js";
import { verdictDomain } from "@/utils/ip-util";
const CLIENT_LOG = getLogger("CLIENT");

// 过滤规则
export const secrtMap = {
  jwt: (key?: string): string => key || ConfigMap.proxy_secret,
  pwd: (key?: string): string =>
    "Basic " + btoa(key || ConfigMap.username + ":" + ConfigMap.password),
  basic: (key?: string): string => key || "Basic " + btoa(ConfigMap.secret_key),
  string: (key?: string): string => key || ConfigMap.secret_key,
};

export function runClient() {
  const server = net.createServer((socket) => {
    let isConnect = false;
    let needProxy = true;
    const parser = new HTTPParser(HTTPParser.REQUEST);
    socket.on("data", (data) => {
      // CLIENT_LOG.debug("客户端" + data.toString());
      parser.onHeadersComplete = (info) => {
        const h = info.headers;
        CLIENT_LOG.debug(info.versionMajor, info.versionMinor);
        const [host, port = "80"] = h[h.indexOf("Host") + 1].split(":");
        // 拦截过滤后的请求
        if (!verdictDomain(host)) {
          needProxy = false;
          CLIENT_LOG.info(`过滤请求: ${host}:${port}`);
          //  过滤后链接目标 服务器 只需传输数据 不需要处理 ssl链接等等
          const target = net.connect(Number(port), host, () => {
            if (data.toString().startsWith("CONNECT ")) {
              socket.write("HTTP/1.1 200 OK\r\n\r\n");
              isConnect = true;
            } else {
              target.write(data);
            }
            socket.pipe(target).pipe(socket);
          });
          target.on("close", () => {
            CLIENT_LOG.warn("与目标服务器断开连接");
            socket.destroy();
          });
          target.on("error", (err) => {
            CLIENT_LOG.error("与目标服务器连接错误");
            CLIENT_LOG.debug(err);
            socket.destroy();
          });
          socket.on("close", () => {
            CLIENT_LOG.warn("客户端断开连接");
            target.destroy();
          });
          socket.on("error", (err) => {
            CLIENT_LOG.error("客户端连接错误");
            CLIENT_LOG.debug(err);
            target.destroy();
          });
        } else {
          CLIENT_LOG.info(`通过请求: ${host}:${port}`);
        }
      };
      parser.execute(data);
      if (!isConnect && needProxy) {
        const authTransform = new ClientConnectTransform(
          secrtMap[ConfigMap.auth_type as keyof typeof secrtMap](),
          ConfigMap.target_host,
          ConfigMap.target_port,
        );
        authTransform.getSocket().on("connect", () => {
          authTransform.write(data);
          socket.pipe(authTransform).getSocket().pipe(socket);
        });
        authTransform.on("close", () => {
          CLIENT_LOG.warn("与目标服务器断开连接");
          socket?.destroy();
        });
        authTransform.on("error", (err) => {
          CLIENT_LOG.error("与目标服务器连接错误");
          CLIENT_LOG.debug(err);
          socket?.destroy();
        });
        socket.on("close", () => {
          CLIENT_LOG.warn("客户端断开连接");
          authTransform?.destroy();
        });
        socket.on("error", (err) => {
          CLIENT_LOG.error("客户端连接错误");
          CLIENT_LOG.debug(err);
          authTransform?.destroy();
        });
        isConnect = true;
      }
    });
  });
  server.on("error", (err) => {
    CLIENT_LOG.error("客户端服务出错");
    CLIENT_LOG.debug(err);
  });
  server.listen(ConfigMap.client_port, () => {
    CLIENT_LOG.info("客户端已启动 端口:" + ConfigMap.client_port);
  });
  return server;
}
