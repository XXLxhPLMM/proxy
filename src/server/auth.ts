import { getLogger } from "@/utils/log";
import { ConfigMap } from "@/config/load";
import jwt from "jsonwebtoken";
import type { IncomingMessage, ServerResponse } from 'http'

const CLIENT_LOG = getLogger("client");
export const offlineKeySet = new Set<string>(); // 用于存储已验证的客户端密钥
export const authHandler = async (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => {
    function authFail(res: ServerResponse) {
        res?.socket?.write(`HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nAuthentication failed\r\n`)
        res?.end()
        CLIENT_LOG.warn('鉴权失败')
        // req.socket?.destroy()
    }
    if (!ConfigMap.use_auth) {
        return true; // 如果未启用鉴权，直接返回true
    }
    let authorization = req.headers['proxy-authorization']
    CLIENT_LOG.debug(`请求头: ${JSON.stringify(req.headers)}`) // 输出请求头
    if (!authorization) {
        authFail(res)
        return false
    }
    else {
        try {
            authorization = authorization.trim()
            if (ConfigMap.auth_type === 'jwt') {
                authorization = authorization.startsWith('Basic ') || authorization.startsWith('Bearer ') ?
                    atob(authorization.split(' ')[1]) : authorization; // 去除Bearer前缀
                authorization = authorization.split(':')[0]
                CLIENT_LOG.debug(`鉴权密钥: ${authorization}`) // 输出鉴权密钥
                const payload = jwt.verify(authorization, ConfigMap.secret_key) as { token: string }
                if (!offlineKeySet.has(payload.token)) { // 检测到强制下线key
                    return true;  // 鉴权成功
                }
                CLIENT_LOG.warn('密钥已强制下线')
            } else if (ConfigMap.auth_type === 'string' && authorization === ConfigMap.secret_key) {
                return true; // 鉴权成功
            } else if (ConfigMap.auth_type === 'basic') {
                const str = atob(authorization.split(' ')[1])
                if (str === ConfigMap.secret_key) {
                    return true; // 鉴权成功
                }
            } else if (ConfigMap.auth_type === 'pwd') {
                const [username, password] = atob(authorization.split(' ')[1]).split(':');
                if (username === ConfigMap.username && password === ConfigMap.password) {
                    return true; // 鉴权成功
                }
            }
            authFail(res)
            return false;
        } catch (err) {
            CLIENT_LOG.debug(err) // 输出错误信息
            offlineKeySet.has(authorization) && offlineKeySet.delete(authorization) // 如果密钥已验证过，删除
            if (err instanceof jwt.TokenExpiredError) {
                const payload = atob(authorization.split('.')[1]) as unknown as { token: string } // 
                offlineKeySet.delete(payload.token) // 如果密钥已过期，删除强制下线键值
            }
            authFail(res)
            return false // 鉴权失败
        }
    }
}


/**
 * 关闭鉴权
 */
export function offAuth() {
    ConfigMap.use_auth = false;
}
/**
 * 开启鉴权
 */
export function onAuth() {
    ConfigMap.use_auth = true;
}
