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
    const PORT = Number(process.env.CLIENT_PORT || process.env.PORT || 4456)
    const TARGET = {
        host: '47.109.98.196',
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