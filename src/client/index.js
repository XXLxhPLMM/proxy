import net from 'net'
import { DecoderPipe, EncoderPipe } from '../utils/crypt.js';

export function runServer(port = 443, proxyHost = 'localhost', proxyPort = 444) {
    const server = net.createServer((client) => {
        // 解密管道
        let dePipe = new DecoderPipe()
        // 加密管道
        let enPipe = new EncoderPipe()
        // 加密
        client.pipe(enPipe)

        // 链接代理服务器
        const serverSocket = net.connect({ host: proxyHost, port: proxyPort }, () => {
            console.warn('连接上目标服务器');
            // 加密完成的数据给 代理服务器
            // serverSocket.write(data)
        });
        enPipe.pipe(serverSocket)
        serverSocket.on('data', (data) => {
            console.log('服务器数据', data.toString());
        })
        // 解密数据
        serverSocket.pipe(dePipe)
        // 解密数据返回给客户端
        dePipe.pipe(client)
        // 监听目标服务器断开连接事件
        // -------------------------- 监听 关闭 和错误事件 及时释放连接 ---------------------
        serverSocket.on('end', () => {
            console.log('与目标服务器断开连接');
            dePipe.end()
            enPipe.end()
            client.end();
        });

        // 监听目标服务器连接错误
        serverSocket.on('error', (err) => {
            console.error('目标服务器连接错误:', err);
            client.end();
        });

        // -------------------------- 监听 关闭 和错误事件 及时释放连接 ---------------------
        client.on('end', () => {
            dePipe.end()
            enPipe.end()
            serverSocket.end()
        })
        client.on('error', () => {
            dePipe.end()
            enPipe.end()
            serverSocket.end()
        })
        enPipe.on('data', (data) => {
            console.log(data.toString());
            // 创建一个与目标服务器的 TCP 连接

        })
    })

    server.listen(port, () => {
        console.log('客户端已启动 端口:' + port);
    })
}