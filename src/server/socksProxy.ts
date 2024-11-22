import net from 'net';
// import { DecoderPipe, EncoderPipe } from '@/utils/crypt.js';
import { HTTP_Target_Resolver } from '@/utils/reslover';

export function createSocksProxy() {
    const server = net.createServer(async (client) => {
        // 解析 目标 
        try {
            const target = await HTTP_Target_Resolver(client)
            // 处理http 请求
            if (target.isHTTP) {
                const targetSocket = net.connect(target.target)
                targetSocket.on('connect', () => {
                    targetSocket.write(target.data)
                    targetSocket.pipe(client)
                })
                targetSocket.on('error', (e) => {
                    console.log('目标服务器连接错误')
                    console.log(e);
                    // 断开 双方连接
                    targetSocket.destroy()
                    client.destroy()
                })
                // 处理 https 请求
            } else {
                const targetSocket = net.connect(target.target)
                targetSocket.on('connect', () => {
                    // targetSocket.write(target.data)
                    // // client.write('HTTP/1.1 200 ok\r\n\r\n')
                    // client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
                })
                // console.log('客户端数据', target.data.toString());
                // client.pipe(targetSocket)
                // targetSocket.pipe(client)
                // targetSocket.on('data', (data) => {
                //     console.log('目标服务器数据', data.toString());
                // })
                targetSocket.on('error', (e) => {
                    console.log('目标服务器连接错误')
                    console.log(e);
                    // 断开 双方连接
                    targetSocket.destroy()
                    client.destroy()
                })
                client.on('close', () => {
                    console.log('客户端关闭');

                    targetSocket.destroy()
                })
            }
        }
        catch (e) {
            console.error(e)
        }
        client.on('error', (e) => {
            console.log('客户端发生错误')
            console.log(e);
            client.destroy()
        })
    })
    server.on('error', (e) => {
        console.log('服务器发生错误');
        console.error(e)
    })
    return server
}

