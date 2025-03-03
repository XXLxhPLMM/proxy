import { getLogger } from '@/utils/log'
import net from 'net'
import { ClientConnectTransform } from '@/utils/transform'
import { ConfigMap } from '@/config/load'
const CLIENT_LOG = getLogger('client')

// 过滤规则

export function runClient() {
    const PORT = Number(process.env.CLIENT_PORT || process.env.PORT || 4456)
    const server = net.createServer((socket) => {
        const authTransform = new ClientConnectTransform(ConfigMap.proxy_secret, ConfigMap.target_host, ConfigMap.target_port)
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