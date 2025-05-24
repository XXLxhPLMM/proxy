import net from "net";
// import { DecoderPipe, EncoderPipe } from '@/utils/crypt.js';
import { HTTP_Target_Resolver } from "@/utils/reslover";
import { getLogger } from "@/utils/log";
import { ConfigMap } from "@/config/load";
import { getFile } from "@/utils/file-util";
import tls from "tls";
import { ipAuth } from "./auth";
const PROXY_LOG = getLogger("TLS_PROXY");

/**
 * 销毁封装
 * @param client 
 * @param target 
 */
function destroy(client: net.Socket, target?: net.Socket) {
    target?.setTimeout(1);
    target?.end();
    target?.destroy();
    client.end();
    client.setTimeout(1);
    client.destroy();
}
export function createTlsProxyServer(auth: (req: any, res: any) => Promise<boolean> = async () => true) {
    const server = tls.createServer({
        // 读取ca证书 主要用于双向验证 验证客户端
        ca: getFile(ConfigMap.s_ca_cert),
        // 读取证书 发送给客户端使用
        cert: getFile(ConfigMap.s_server_cert),
        // 读取私钥
        key: getFile(ConfigMap.s_server_key),
        // 私钥密码
        passphrase: ConfigMap.s_server_password,
        // 是否验证客户端证书
        requestCert: ConfigMap.app_bothway_auth,
        // 
        rejectUnauthorized: ConfigMap.app_auth_cert,
    }, async (client) => {

        // 解析 目标 
        try {
            const target = await HTTP_Target_Resolver(client);
            const req = { // 构建请求对象
                ...target.info,
                socket: client,
            };
            const res = { // 构建响应对象
                ...target.info,
                socket: client,
            };
            // 验证身份
            if (!await auth(req!, res!)) {
                return;
            }
            // 处理http 请求
            if (target.isHTTP) {
                const socket = net.connect(target.target);
                socket.on("connect", () => {
                    socket.write(target.data);
                    socket.pipe(client);
                });
                socket.on("error", (e) => {
                    PROXY_LOG.info("目标服务器连接错误");
                    PROXY_LOG.error(e);
                    // 断开 双方连接
                    destroy(client, socket);
                });
                // 处理 https 请求
            } else {
                const socket = net.connect(target.target);
                socket.on("connect", () => {
                    client.write("HTTP/1.1 200 ok\r\n\r\n");
                });
                client.pipe(socket).pipe(client);
                socket.on("error", (e) => {
                    PROXY_LOG.warn("目标服务器连接错误");
                    PROXY_LOG.error(e);
                    // 断开 双方连接
                    destroy(client, socket);
                });
                client.on("close", () => {
                    PROXY_LOG.info("客户端主动关闭连接");
                    destroy(client, socket);
                });
            }
        }
        catch (e) {
            PROXY_LOG.error(e);
        }
    });
    server.on(
        "secureConnection", (client) => {
        // 验证IP地址
        ipAuth(client);
        client.on("error", (e) => {
            PROXY_LOG.warn("客户端发生错误");
            PROXY_LOG.error(e);
            destroy(client);
        });
    });
    server.on("error", (e) => {
        PROXY_LOG.warn("服务器发生错误");
        PROXY_LOG.error(e);
    });
    return server;
}

