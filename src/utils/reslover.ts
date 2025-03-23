
import type { Socket, NetConnectOpts } from "net";
import { HeaderInfo, HTTPParser } from "http-parser-js";


/**
 * 目标解析器 判断是否为 http报文并返回目标信息
 * @param socket 
 * @returns 
 */
export function HTTP_Target_Resolver(socket: Socket): Promise<{ isHTTP: boolean, data: Buffer, target: NetConnectOpts, info: HeaderInfo<Record<string, string>> }> {
    return new Promise((res, rej) => {
        const handle = (data: Buffer) => {
            // 解析
            try {
                // 初始化解析器
                const HTTP_PARSER = new HTTPParser(HTTPParser.REQUEST);
                // HTTP 协议类型
                let isHTTP = false
                HTTP_PARSER.onHeadersComplete = (info) => {
                    const target: NetConnectOpts = (() => {
                        const method = info.method as any
                        // 判断 http 代理连接请求
                        if (method === 'CONNECT' || method === 'connect') {
                            const url = info.url.split(':')
                            isHTTP = false
                            return {
                                // 解析 目标的连接信息
                                host: url[0],
                                port: Number(url[1])
                            }
                        } else {
                            isHTTP = true
                            // 解析 url
                            const url = new URL(info.url)
                            return {
                                // 解析 目标的连接信息
                                host: url.hostname,
                                port: url.port ? Number(url.port) : 80
                            }
                        }
                    })()
                    const headers: Record<string, string> = {}
                    for (let i = 0; i < info.headers.length; i++) {
                        if (i % 2 === 0) {
                            headers[info.headers[i].toLocaleLowerCase()] = info.headers[i + 1]
                        }
                    }
                    res({
                        isHTTP,
                        data,
                        target,
                        info: {
                            ...info,
                            headers
                        }
                    })
                }
                HTTP_PARSER.execute(data)
                // 去除监听器
                socket.off('data', handle)
            } catch (e) {
                rej(e)
            }
        }
        socket.on('data', handle)
    })
}