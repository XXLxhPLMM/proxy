
import { createSocksProxy } from "./socksProxy";
import { createHttpProxy } from "./httpProxy";
import { createHttpsProxy } from './httpsProxy'
import { createTlsProxyServer } from "./tslProxy";
import { getLogger } from "@/utils/log";
const SERVER_LOG = getLogger("server");
import { authHandler } from "./auth";
export function runServer() {
    const PORT = process.env.SERVER_PORT || process.env.PORT || 444;
    const SERVER_MODE = process.env.SERVER_MODE || "http";
    if (SERVER_MODE === "socks") {
        createSocksProxy().listen(PORT, () => {
            SERVER_LOG.warn('服务已启动 端口:', PORT);
        });
    } else if (SERVER_MODE === "http") {
        createHttpProxy(authHandler).listen(PORT, () => {
            SERVER_LOG.warn('http服务已启动 端口:', PORT);
        });
    } else if (SERVER_MODE === "https") {
        createHttpsProxy(authHandler).listen(PORT, () => {
            SERVER_LOG.warn('https服务已启动 端口:', PORT);
        });
    } else if (SERVER_MODE === "tls") {
        createTlsProxyServer().listen(PORT, () => {
            SERVER_LOG.warn('tls服务已启动 端口:', PORT);
        });
    } else {
        SERVER_LOG.error("未知的服务类型:", SERVER_MODE);
    }
}