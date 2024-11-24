import http from 'http';
import net from 'net';
import { getLogger } from '@/utils/log';
const PROXY_LOG = getLogger('PROXY');
export function createHttpProxy(auth: (req: any, res: any) => Promise<boolean> = async () => true) {
    const server = http.createServer(async (req, res) => {
        // 验证身份
        if (!await auth(req!, res!)) {
            return
        }
        const [host, method] = [req.headers.host, req.method]
        PROXY_LOG.info('http 代理', [host, method]);
        // 更据请求转发到目标服务器
        const proxyReq = http.request(`http://${host}`, {
            method: req.method,
            path: req.url,
            headers: req.headers,
        }, (targetRes) => {
            targetRes.pipe(res);
        })
        req.pipe(proxyReq)
        proxyReq.on('error', (e) => {
            PROXY_LOG.error(`目标服务器发生错误 --- ${[host, method]}`)
            PROXY_LOG.debug(e)
            req.socket?.destroy();
        })
        proxyReq.on('close', () => {
            PROXY_LOG.warn(`目标服务器关闭连接 --- ${[host, method]}`);
            req.socket?.destroy();
        })
        req.socket.on('close', () => {
            PROXY_LOG.warn(`客户端关闭连接 --- ${[host, method]}`);
            proxyReq.socket?.destroy();
        })
    })
    server.on('connect', async (req, res) => {
        // 验证身份
        if (!await auth(req!, res!)) {
            return
        }
        // 处理 https 请求代理
        PROXY_LOG.info('https 代理', [req.headers.host, req.method]);
        const [host, port] = req.url!.split(':');
        const target = net.createConnection({
            host,
            port: Number(port)
        }, () => {
            PROXY_LOG.warn(`目标服务器连接成功 --- ${host}`);
            req.socket.pipe(target)
            req.socket.write(`HTTP/1.1 200 OK\r\n\r\n`);
            target.pipe(res)
        })
        req.socket.on('close', () => {
            PROXY_LOG.warn(`客户端关闭连接 --- ${host}`);
            target.destroy();
        })
        target.on('error', () => {
            PROXY_LOG.error(`目标服务器发生错误 --- ${host}`);
            req.socket.destroy();
        })
        target.on('close', () => {
            PROXY_LOG.warn(`目标服务器关闭连接 --- ${host}`);
            req.socket.destroy();
        })
    })
    server.on('connection', (socket) => {
        PROXY_LOG.warn(`客户端连接 ${socket.remoteAddress}`);
        socket.on('error', () => {
            PROXY_LOG.error(`客户端连接出错`);
        })
    })
    // 处理 服务器错误
    server.on('error', (e) => {
        PROXY_LOG.error('服务器发生错误');
        PROXY_LOG.debug(e)
    })
    return server
}