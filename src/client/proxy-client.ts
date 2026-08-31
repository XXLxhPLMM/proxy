/**
 * ProxyClient - 代理客户端（http + socks 统一封装）
 * 职责：按 protocol 选择 HttpProxyClient / SocksProxyClient，提供统一 get/connect 入口
 * - http：走 HTTP 代理 GET（path 为完整 URL）或 CONNECT 隧道
 * - socks：走 SOCKS5 over TLS/明文 的握手+CONNECT，中转后 pipe
 * 关联：client/http、client/socks、config/store（fromConfig 读取 remote*）
 */

import { get } from "../config/store.js";
import { logger } from "../utils/logger.js";
import { HttpProxyClient, type HttpProxyClientOptions } from "./http.js";
import { SocksProxyClient, type SocksProxyClientOptions } from "./socks.js";

export interface ProxyClientOptions extends HttpProxyClientOptions, SocksProxyClientOptions {
  protocol: "http" | "socks";
}

export class ProxyClient {
  readonly protocol: "http" | "socks";
  private readonly httpClient: HttpProxyClient;
  private readonly socksClient: SocksProxyClient;

  constructor(opts: ProxyClientOptions) {
    this.protocol = opts.protocol;
    this.httpClient = new HttpProxyClient(opts);
    this.socksClient = new SocksProxyClient(opts);
  }

  /** 从全局 config（store）创建客户端，自动取 remote* 目标服务器地址与鉴权 */
  static fromConfig(protocol?: "http" | "socks"): ProxyClient {
    const p = (protocol ?? (get("proxyProtocol") === "socks" ? "socks" : "http")) as "http" | "socks";
    const host = get("remoteHost");
    const port = get("remotePort");
    const secure = get("remoteSecure");
    const username = get("remoteUsername");
    const password = get("remotePassword");
    const ca = get("remoteCa");
    const insecure = get("remoteInsecure");
    return new ProxyClient({ protocol: p, host, port, secure, username, password, ca, insecure, timeout: get("upstreamTimeout") });
  }

  /** 统一 GET：http 走代理 GET，socks 走隧道后 GET */
  async get(targetUrl: string): Promise<{ statusCode: number; body: Buffer; raw?: Buffer; headers?: unknown }> {
    if (this.protocol === "http") return this.httpClient.get(targetUrl);
    return this.socksClient.get(targetUrl);
  }

  /** 统一隧道：http 发 CONNECT 建管，socks 发 SOCKS5 CONNECT */
  async connect(targetHost: string, targetPort: number) {
    if (this.protocol === "http") return this.httpClient.connect(targetHost, targetPort);
    return this.socksClient.connect(targetHost, targetPort);
  }
}

/** 客户端启动入口（供 src/index.ts 直接执行时调用），仅示例连通性 */
export async function runClient(): Promise<void> {
  const proto = (get("proxyProtocol") === "socks" ? "socks" : "http") as "http" | "socks";
  const client = ProxyClient.fromConfig(proto);
  logger.info(`[client] ready protocol=${proto} remote=${get("remoteHost")}:${get("remotePort")} secure=${get("remoteSecure")} (use new ProxyClient().get(url) 自行请求)`);
  // 不内置固定 target，由调用方按需 client.get(url)，此处仅验证配置可构造
  await Promise.resolve();
  void client;
}
