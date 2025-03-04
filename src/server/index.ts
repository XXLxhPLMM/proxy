
import { createSocksProxy } from "./socksProxy";
import { createHttpProxy } from "./httpProxy";
import { createHttpsProxy } from './httpsProxy'
import { createTlsProxyServer } from "./tslProxy";
import { getLogger } from "@/utils/log";
import { authHandler } from "./auth";
import { ConfigMap } from "@/config/load";
const SERVER_LOG = getLogger("server");
export function runServer() {
    const SERVER_MODE = process.env.SERVER_MODE || "http";
    const runMap: Record<string, () => ReturnType<typeof createSocksProxy | typeof createHttpProxy | typeof createHttpsProxy | typeof createTlsProxyServer>> = {
        "http": () => {
            return createSocksProxy().listen(ConfigMap.server_port, () => {
                SERVER_LOG.warn('服务已启动 端口:', ConfigMap.server_port);
            });
        },
        "socks": () => {
            return createSocksProxy().listen(ConfigMap.server_port, () => {
                SERVER_LOG.warn('服务已启动 端口:', ConfigMap.server_port);
            });
        },
        "https": () => {
            return createHttpsProxy(authHandler).listen(ConfigMap.server_port, () => {
                SERVER_LOG.warn('服务已启动 端口:', ConfigMap.server_port);
            });
        },
        "tls": () => {
            return createTlsProxyServer().listen(ConfigMap.server_port, () => {
                SERVER_LOG.warn('服务已启动 端口:', ConfigMap.server_port);
            });
        },
    }
    return ((r: () => any) => r ? r() : null)(runMap[SERVER_MODE])
}