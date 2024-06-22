import net from 'net'
import { DecoderPipe, EncoderPipe } from '../utils/crypt.js';
// function connectionListener

export function runServer(port) {
    /**
     * 创建服务
     */
    const server = net.createServer((client) => {

        client.on('error', (e) => {
            console.log('客户端错误');
        })
        // 解密管道
        let dePipe = new DecoderPipe()
        client.pipe(dePipe)

        // 加密管道
        let enPipe = new EncoderPipe()
        dePipe.on('data', (data) => {
            // 处理到目标链接的转发
            // 解析客户端发来的 HTTP 请求头
            const requestData = data.toString('utf-8');
            const reqL = requestData.split('\r\n')[0].split(' ')
            const method = reqL[0]
            const target = reqL[1]
            // 解析目标服务器的主机名和端口号
            let serverHostname = ''
            let serverPort = 80
            if (method != 'connect' && method != 'CONNECT') {
                const url = new URL(target)
                serverHostname = url.hostname;
                serverPort = url.port || 80
                // console.log(url);
            } else {
                serverHostname = target.split(':')[0]
                serverPort = target.split(':')[1] || 443
            }
            console.log(`请求: ${method}  ${target}:${port}`);
            // return
            // 创建一个与目标服务器的 TCP 连接
            const serverSocket = net.connect({ host: serverHostname, port: serverPort }, () => {
                // 如果是 CONNECT 方法，向客户端发送确认
                if (method === 'CONNECT' || method === 'connect') {
                    // serverSocket.write(requestData)
                    enPipe.write('HTTP/1.1 200 Connection Established\r\n\r\n')
                    dePipe.pipe(serverSocket)
                } else {
                    // 向目标服务器发送客户端的请求数据
                    serverSocket.write(data);
                }
            });

            // 数据给加密管道
            serverSocket.pipe(enPipe)
            // 加密数据返回客户端
            enPipe.pipe(client)
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
        })
    })

    server.listen(port, () => {
        console.warn('加密通道已启动 端口:', port);
    })
}