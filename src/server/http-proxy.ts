import http from "http";
import https from "https";
import net from "net";
import { getLogger } from "@/utils/log";
import { ipAuth } from "./auth";
import { getFile } from "@/utils/file-util";
import { ConfigMap } from "@/config/load";
let PROXY_LOG: ReturnType<typeof getLogger>;

/**
 * 处理客户端发送的https 请求 的 connect请求
 * @param server
 * @param auth
 */
function httpsConnectHandler(
  server: http.Server | https.Server,
  auth: (req: any, res: any) => Promise<boolean> = async () => true,
) {
  server.on("connect", async (req, res) => {
    // 验证身份
    if (!(await auth(req!, res!))) {
      return;
    }
    // 处理 https 请求代理
    PROXY_LOG.info("https 代理", [req.headers.host, req.method]);
    PROXY_LOG.debug(req.headers);
    const [host, port] = req.url!.split(":");
    const target = net.createConnection(
      {
        host,
        port: Number(port),
      },
      () => {
        PROXY_LOG.warn(`目标服务器连接成功 --- ${host}`);
        req.socket.write(`HTTP/${req.httpVersion} 200 OK\r\n\r\n`);
        req.socket.pipe(target);
        target.pipe(res);
      },
    );
    req.socket.on("close", () => {
      PROXY_LOG.warn(`客户端关闭连接 --- ${host}`);
      target.destroy();
    });
    target.on("error", () => {
      PROXY_LOG.error(`目标服务器发生错误 --- ${host}`);
      req.socket.destroy();
    });
    target.on("close", () => {
      PROXY_LOG.warn(`目标服务器关闭连接 --- ${host}`);
      req.socket.destroy();
    });
  });
}

function errorHandler(server: http.Server | https.Server) {
  server.on("connection", (socket) => {
    ipAuth(socket); // 过滤ip
    socket.on("error", (e: Error) => {
      PROXY_LOG.error("客户端连接出错");
      PROXY_LOG.debug(e);
      socket?.setTimeout(0);
      socket?.destroy();
      socket?.end();
    });
  });
  // 处理 服务器错误
  server.on("error", (e) => {
    PROXY_LOG.error("服务器发生错误");
    PROXY_LOG.debug(e);
  });
}

/**
 * 处理 普通http请求
 * @param req
 * @param res
 * @param auth
 * @returns
 */
function httpConnectHandler(
  auth: (req: any, res: any) => Promise<boolean> = async () => true,
): (
  req: http.IncomingMessage,
  res: http.ServerResponse<http.IncomingMessage> & {
    req: http.IncomingMessage;
  },
) => void {
  return async (req, res) => {
    // 验证身份
    if (!(await auth(req!, res!))) {
      return;
    }
    const [host, method] = [req.headers.host, req.method];
    PROXY_LOG.info("http 代理", [host, method]);
    delete req.headers["proxy-authorization"];
    delete req.headers["proxy-connection"];
    // 更据请求转发到目标服务器
    const proxyReq = http.request(
      `http://${host}`,
      {
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (targetRes) => {
        targetRes.pipe(res);
      },
    );
    proxyReq.on("socket", () => {
      PROXY_LOG.warn(`目标服务器连接成功 --- ${[host, method]}`);
    });
    req.pipe(proxyReq);
    proxyReq.on("error", (e) => {
      PROXY_LOG.error(`目标服务器发生错误 --- ${[host, method]}`);
      PROXY_LOG.debug(e);
      req.socket?.destroy();
    });
    proxyReq.on("close", () => {
      PROXY_LOG.warn(`目标服务器关闭连接 --- ${[host, method]}`);
      req.socket?.destroy();
    });
    req.socket.on("close", () => {
      PROXY_LOG.warn(`客户端关闭连接 --- ${[host, method]}`);
      proxyReq.socket?.destroy();
    });
  };
}

/**
 * 处理 http 代理
 * @param auth
 * @returns
 */
export function createHttpProxy(
  auth: (req: any, res: any) => Promise<boolean> = async () => true,
) {
  // 日志设置
  PROXY_LOG = getLogger("HTTP_PROXY");
  // 处理 普通客户端http请求
  const server = http.createServer({}, httpConnectHandler(auth));
  // 处理普通客户端https请求
  httpsConnectHandler(server, auth);
  //错误处理
  errorHandler(server);
  return server;
}

/**
 * 处理https 代理
 * @param auth
 * @returns
 */
export function createHttpsProxy(
  auth: (req: any, res: any) => Promise<boolean> = async () => true,
) {
  // 日志设置
  PROXY_LOG = getLogger("HTTPS_PROXY");
  // 处理 普通客户端http请求
  const server = https.createServer(
    {
      ca: getFile(ConfigMap.s_ca_cert),
      cert: getFile(ConfigMap.s_server_cert),
      key: getFile(ConfigMap.s_server_key),
      passphrase: ConfigMap.s_server_password,
      requestCert: ConfigMap.app_bothway_auth,
      rejectUnauthorized: ConfigMap.app_auth_cert,
    },
    httpConnectHandler(auth),
  );
  // 处理普通客户端https请求
  httpsConnectHandler(server, auth);
  //错误处理
  errorHandler(server);
  return server;
}
