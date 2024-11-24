// import net from 'net'
// import { DecoderPipe, EncoderPipe } from '../utils/crypt.js';

// export function runServer(port = 443, proxyHost = 'localhost', proxyPort = 444) {
//     const server = net.createServer((client) => {
//         // 解密管道
//         let dePipe = new DecoderPipe()
//         // 加密管道
//         let enPipe = new EncoderPipe()

//         // 链接代理服务器
//         const serverSocket = net.connect({ host: proxyHost, port: proxyPort }, () => {
//             console.warn('连接上目标服务器');
//             // 加密完成的数据给 代理服务器
//             // serverSocket.write(data)
//         });

//         // 转发加密
//         client.pipe(enPipe).pipe(serverSocket)

//         // 不解密
//         // serverSocket.pipe(client)
//         // // 解密数据
//         serverSocket.pipe(dePipe).pipe(client)

//         function destroy() {
//             dePipe?.destroy()
//             enPipe?.destroy()
//             client?.destroy();
//             serverSocket?.destroy()
//         }
//         // 监听目标服务器断开连接事件
//         // -------------------------- 监听 关闭 和错误事件 及时释放连接 ---------------------
//         serverSocket.on('end', () => {
//             console.log('与目标服务器断开连接');
//             destroy()
//         });

//         // 监听目标服务器连接错误
//         serverSocket.on('error', (err) => {
//             console.error('目标服务器连接错误:', err);
//             destroy()
//         });

//         // -------------------------- 监听 关闭 和错误事件 及时释放连接 ---------------------
//         client.on('end', () => {
//             destroy()
//         })
//         client.on('error', () => {
//             destroy()
//         })
//         enPipe.on('data', (data) => {
//             // console.log(data.toString());
//             // 创建一个与目标服务器的 TCP 连接

//         })
//     })

//     server.listen(port, () => {
//         console.log('客户端已启动 端口:' + port);
//     })
// }

import { getLogger } from '@/utils/log'
import net from 'net'
import { ClientConnectTransform } from '@/utils/transform'

const CLIENT_LOG = getLogger('client')



// 根据 对象 构造httt报文
function buildHttp(method: string, url: string, headers: any, body: any): string {
    let http = `${method} ${url} HTTP/1.1\r\n`
    return http
}

export function runClient() {
    const PORT = Number(process.env.CLIENT_PORT || 4456)
    const TARGET = {
        host: 'localhost',
        port: 4455,
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjEyMywidG9rZW4iOiIxMjM0NTYiLCJpYXQiOjE3MzI0NzcyOTIsImV4cCI6MTczMjQ4MDg5Mn0.qNNuiPTrMvktR8FjGsIIvgBiQFvitLnkVN-ZflHBK-w'
    }
    const server = net.createServer((socket) => {
        const authTransform = new ClientConnectTransform(TARGET.token, TARGET.host, TARGET.port)
        socket.pipe(authTransform).getSocket().pipe(socket)
        authTransform.on('close', () => {
            CLIENT_LOG.warn('与目标服务器断开连接')
            socket.destroy()
        })
        authTransform.on('error', (err) => {
            CLIENT_LOG.error('与目标服务器连接错误')
            CLIENT_LOG.debug(err)
            socket.destroy()
        })
        socket.on('close', () => {
            CLIENT_LOG.warn('与客户端断开连接')
            authTransform.destroy()
        })
        socket.on('error', (err) => {
            CLIENT_LOG.error('与客户端连接错误')
            CLIENT_LOG.debug(err)
            authTransform.destroy()
        })
    })
    server.on('error', (err) => {
        CLIENT_LOG.error('客户端服务出错')
        CLIENT_LOG.debug(err)
    })
    server.listen(PORT, () => {
        CLIENT_LOG.info('客户端已启动 端口:' + PORT)
    })
    return server
}