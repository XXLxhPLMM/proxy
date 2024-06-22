import net from 'net'
import { DecoderPipe, EncoderPipe } from '../utils/crypt.js';
// function connectionListener

// export function runServer(port = 444) {
//     const server = net.createServer((client) => {
//         // 解密管道
//         let dePipe = new DecoderPipe()
//         client.pipe(dePipe)
//         dePipe.on('data',(data)=>{
//             console.log('客户端解密数据',data.toString());
//         })
//     })

//     server.listen(port, () => {
//         console.log('客户端已启动 端口:' + port);
//     })

// }



export function runServer(port = 444) {
    /**
     * 创建服务
     */
    const server = net.createServer((client) => {
        client.on('data', (data) => {
            // console.log('客户端数据',data.toString());
        })
        client.on('error', (e) => {
            console.log('客户端错误');
        })
        // 解密管道
        let dePipe = new DecoderPipe()
        client.pipe(dePipe)
        // 目标服务器链接 tcp 对象
        let serverSocket = null
        // 加密管道
        let enPipe = new EncoderPipe()
        dePipe.on('data', (data) => {
            // 链接若是已经建立直接退出
            if (serverSocket) {
                return
            }
            // 处理到目标链接的转发
            // 解析客户端发来的 HTTP 请求头
            const requestData = data.toString('utf-8');
            const reqL = requestData.split('\r\n')[0].split(' ')
            const method = reqL[0]
            const target = reqL[1]
            // 解析目标服务器的主机名和端口号
            let serverHostname = ''
            let serverPort = 80
            try {
                if (method != 'connect' && method != 'CONNECT') {
                    const url = new URL(target)
                    serverHostname = url.hostname;
                    serverPort = url.port || 80

                    // console.log(url);
                } else {
                    serverHostname = target.split(':')[0]
                    serverPort = target.split(':')[1] || 443
                }
                console.log(`请求: ${method}  ${target}  ${serverPort}`);
                // return
                // 创建一个与目标服务器的 TCP 连接
                serverSocket = net.connect({ host: serverHostname, port: serverPort }, () => {
                    // 如果是 CONNECT 方法，向客户端发送确认
                    if (method === 'CONNECT' || method === 'connect') {
                        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
                        // enPipe.write('HTTP/1.1 200 Connection Established\r\n\r\n')
                        dePipe.pipe(serverSocket)
                    } else {
                        // 向目标服务器发送客户端的请求数据
                        serverSocket.write(data);
                    }
                });
                // dePipe.pipe(serverSocket)
                // 不加密
                serverSocket.pipe(client)
                // // 数据给加密管道
                // serverSocket.pipe(enPipe).pipe(client)
                // 监听目标服务器断开连接事件
                // -------------------------- 监听 关闭 和错误事件 及时释放连接 ---------------------
                function destroy() {
                    dePipe?.end()
                    enPipe?.end()
                    client?.end();
                    serverSocket?.end()
                    serverSocket = null
                }
                serverSocket.on('end', () => {
                    console.warn('与目标服务器断开连接');
                    destroy()
                });

                // 监听目标服务器连接错误
                serverSocket.on('error', (err) => {
                    console.error('目标服务器连接错误:', err);
                    destroy()
                });

                // -------------------------- 监听 关闭 和错误事件 及时释放连接 ---------------------
                client.on('end', () => {
                    console.warn('与客户端断开连接');
                    destroy()
                })
                client.on('error', () => {
                    destroy()
                })
            } catch {

            }

        })
    })

    server.listen(port, () => {
        console.warn('加密通道已启动 端口:', port);
    })
}