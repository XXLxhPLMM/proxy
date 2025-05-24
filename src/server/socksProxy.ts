import net from "net";
// import { DecoderPipe, EncoderPipe } from '@/utils/crypt.js';
import { HTTP_Target_Resolver } from "@/utils/reslover";
import { getLogger } from "@/utils/log";
const SOCKS_LOG = getLogger("SOCKS_LOG");
export function createSocksProxy() {
    const server = net.createServer(async (client) => {
        // 解析 目标 
        try {
            const target = await HTTP_Target_Resolver(client);
            // 处理http 请求
            if (target.isHTTP) {
                const targetSocket = net.connect(target.target);
                targetSocket.on("connect", () => {
                    targetSocket.write(target.data);
                    targetSocket.pipe(client);
                });
                targetSocket.on("error", (e) => {
                    SOCKS_LOG.info("目标服务器连接错误");
                    SOCKS_LOG.error(e);
                    // 断开 双方连接
                    targetSocket.destroy();
                    client.destroy();
                });
                // 处理 https 请求
            } else {
                const targetSocket = net.connect(target.target);
                targetSocket.on("connect", () => {
                    // targetSocket.write(target.data)
                    // // client.write('HTTP/1.1 200 ok\r\n\r\n')
                    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                });
                // console.log('客户端数据', target.data.toString());
                client.pipe(targetSocket);
                targetSocket.pipe(client);
                // targetSocket.on('data', (data) => {
                //     console.log('目标服务器数据', data.toString());
                // })
                targetSocket.on("error", (e) => {
                    SOCKS_LOG.warn("目标服务器连接错误");
                    SOCKS_LOG.error(e);
                    // 断开 双方连接
                    targetSocket.destroy();
                    client.destroy();
                });
                client.on("close", () => {
                    SOCKS_LOG.info("客户端关闭");
                    targetSocket.destroy();
                });
            }
        }
        catch (e) {
            SOCKS_LOG.error(e);
        }
        client.on("error", (e) => {
            SOCKS_LOG.warn("客户端发生错误");
            SOCKS_LOG.error(e);
            client.destroy();
        });
    });
    server.on("error", (e) => {
        SOCKS_LOG.warn("服务器发生错误");
        SOCKS_LOG.error(e);
    });
    return server;
}

