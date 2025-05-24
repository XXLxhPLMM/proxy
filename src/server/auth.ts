import { getLogger } from "@/utils/log";
import { ConfigMap } from "@/config/load";
import jwt from "jsonwebtoken";
import type { IncomingMessage, ServerResponse } from "http";
import { getIp, ipFilter } from "@/utils/ip-util";
import { type Socket } from "net";
const AUTH_LOG = getLogger("AUTH");


export const offlineKeySet = new Set<string>(); // 用于存储已验证的客户端密钥
export const authHandler = async (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => {
    const ip = getIp(req);
    AUTH_LOG.info(`客户端 ip地址 ${ip}`);
    if (ConfigMap.use_ip_filter && ipFilter(ip)) {
        AUTH_LOG.warn(`IP 地址 ${ip} 已被禁止`);
        res?.setTimeout?.(1);
        res?.socket?.setTimeout?.(1);
        res?.socket?.end?.();
        return false;
    }
    /**
     * 处理鉴权失败的一系列操作
     * @param res 
     */
    function authFail(res: ServerResponse) {
        res?.setTimeout?.(1);
        res?.socket?.setTimeout?.(1);
        res?.socket?.end?.();
        AUTH_LOG.warn("鉴权失败");
    }
    if (!ConfigMap.use_auth) {
        return true; // 如果未启用鉴权，直接返回true
    }
    let authorization: string = req.headers["proxy-authorization"] as string;
    AUTH_LOG.debug(`请求头: ${JSON.stringify(req.headers)}`); // 输出请求头
    if (!authorization) {
        authFail(res);
        return false;
    }
    else {
        try {
            authorization = authorization.trim();
            // jwt 鉴权方式处理
            if (ConfigMap.auth_type === "jwt") {
                authorization = authorization.startsWith("Basic ") || authorization.startsWith("Bearer ") ?
                    atob(authorization.split(" ")[1]) : authorization; // 去除Bearer前缀
                authorization = authorization.split(":")[0];
                AUTH_LOG.debug(`鉴权密钥: ${authorization}`); // 输出鉴权密钥
                const payload = jwt.verify(authorization, ConfigMap.proxy_secret) as { token: string };
                if (!offlineKeySet.has(payload.token)) { // 检测到强制下线key
                    return true;  // 鉴权成功
                }
                AUTH_LOG.warn("密钥已强制下线");
            } // 字符串方式处理
            else if (ConfigMap.auth_type === "string" && authorization === ConfigMap.secret_key) {
                return true; // 鉴权成功
            } // 处理 base64
            else if (ConfigMap.auth_type === "basic") {
                const str = atob(authorization.split(" ")[1]);
                if (str === ConfigMap.secret_key) {
                    return true; // 鉴权成功
                }
            } // 处理使用账号密码的方式 
            else if (ConfigMap.auth_type === "pwd") {
                const [username, password] = atob(authorization.split(" ")[1]).split(":");
                if (username === ConfigMap.username && password === ConfigMap.password) {
                    return true; // 鉴权成功
                }
            }
            authFail(res);
            return false;
        } catch (err) {
            AUTH_LOG.debug(err); // 输出错误信息
            // 如果密钥已验证过，删除
            offlineKeySet.has(authorization) && offlineKeySet.delete(authorization);
            if (err instanceof jwt.TokenExpiredError) {
                const payload = atob(authorization.split(".")[1]) as unknown as { token: string }; // 
                offlineKeySet.delete(payload.token); // 如果密钥已过期，删除强制下线键值
            }
            authFail(res);
            return false; // 鉴权失败
        }
    }
};


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

/**
 * 处理 socket 链接的 ip 是否需要过滤
 * 以及 过滤后自动断开连接
 * @param ip 
 * @param socket 
 * @returns 
 */
export function ipAuth(socket: Socket) {
    if (ConfigMap.use_ip_filter && ipFilter(socket.remoteAddress!)) {
        AUTH_LOG.warn(`IP 地址 ${socket.remoteAddress} 已被socket-connect过滤`);
        socket?.setTimeout?.(1);
        socket?.end?.();
        socket?.destroy?.();
        return false;
    }
    return true;
}