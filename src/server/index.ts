
import { createSocksProxy } from "./socksProxy";
import { createHttpProxy } from "./httpProxy";
import { createHttpsProxy } from './httpsProxy'
import { createTlsProxyServer } from "./tslProxy";
import { getLogger } from "@/utils/log";
import { authHandler } from "./auth";
import { ConfigMap } from "@/config/load";
const SERVER_LOG = getLogger("server");
export function runServer() {
    const runMap: Record<string, () => ReturnType<typeof createSocksProxy | typeof createHttpProxy | typeof createHttpsProxy | typeof createTlsProxyServer>> = {
        "http": () => {
            return createHttpProxy(authHandler)
        },
        "socks": () => {
            return createSocksProxy()
        },
        "https": () => {
            return createHttpsProxy(authHandler)
        },
        "tls": () => {
            return createTlsProxyServer()
        },
    }
    return ((r: () => any) => r ? r().listen(ConfigMap.server_port, () => {
        SERVER_LOG.warn(`${ConfigMap.server_mode}代理服务已启动 端口: ${ConfigMap.server_port}`);
    }) : null)(runMap[ConfigMap.server_mode])
}