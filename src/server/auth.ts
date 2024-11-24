import { getLogger } from "@/utils/log";
import jwt from "jsonwebtoken";
import type { IncomingMessage, ServerResponse } from 'http'

const CLIENT_LOG = getLogger("client");
const SECRET_KEY = process.env.KEY || '9f7ff6cf29ae441cad0da4e6d6843ec3'; // Replace with your actual secret key
let USE_AUTH = process.env.APP_USE_AUTH === 'true'; // 是否启用鉴权
export const offlineKeySet = new Set<string>(); // 用于存储已验证的客户端密钥
export const authHandler = async (req: IncomingMessage, res: ServerResponse) => {
    if (!USE_AUTH) {
        return true; // 如果未启用鉴权，直接返回true
    }
    let authorization = req.headers['proxy-authorization']
    if (!authorization) {
        CLIENT_LOG.warn('鉴权失败')
        return false
    }
    else {
        try {
            authorization = authorization.trim()
            authorization = authorization.startsWith('Basic ') ? atob(authorization.split(' ')[1]) : authorization; // 去除Bearer前缀
            authorization = authorization.split(':')[0]
            CLIENT_LOG.debug(`鉴权密钥: ${authorization}`) // 输出鉴权密钥
            const payload = jwt.verify(authorization, SECRET_KEY) as { token: string }
            if (offlineKeySet.has(payload.token)) { // 检测到强制下线key
                CLIENT_LOG.warn('密钥已强制下线')
                return false;
            }
            return true;  // 鉴权成功
        } catch (err) {
            CLIENT_LOG.warn('鉴权失败')
            CLIENT_LOG.debug(err) // 输出错误信息
            offlineKeySet.has(authorization) && offlineKeySet.delete(authorization) // 如果密钥已验证过，删除
            res.writeHead(401, { 'Content-Type': 'application/json', 'Proxy-Auth-Status': "err" })
            res.end()
            if (err instanceof jwt.TokenExpiredError) {
                const payload = atob(authorization.split('.')[1]) as unknown as { token: string } // 
                offlineKeySet.delete(payload.token) // 如果密钥已过期，删除强制下线键值
            }
            return false // 鉴权失败
        }
    }
}


/**
 * 关闭鉴权
 */
export function offAuth() {
    USE_AUTH = false;
}
/**
 * 开启鉴权
 */
export function onAuth() {
    USE_AUTH = true;
}