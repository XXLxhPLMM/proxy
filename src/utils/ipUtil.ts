import { ConfigMap } from "@/config/load";
import { IncomingMessage } from "http";
import { getLogger } from "./log";

const IP_UTIL_LOGGER = getLogger("IPUtil")
/**
 * ip 匹配规则缓存
 */
const ipRuleMap = new Map<string, RegExp>()

/**
 * ip 匹配 缓存 编译规则
 * 自动处理 * 匹配
 * @param ip 
 * @param list 
 * @returns 
 */
function ipMatch(ip: string, list: string[]): boolean {
    for (const item of list) {
        let rule: RegExp | undefined = ipRuleMap.get(item)
        if (!rule) {
            // 编译规则
            const reg = item.trim().replaceAll("*", "\\d+");
            rule = new RegExp(reg, "i");
            // 缓存规则
            ipRuleMap.set(item, rule)
        }
        // IP_UTIL_LOGGER.debug(`ipMatch ${item} ${rule} ${list} ${ip}`)
        if (rule.test(ip))
            return true;
    }
    // 去除未使用的规则
    const needDelKeys: string[] = []
    ipRuleMap.forEach((_, key) => {
        if (!list.includes(key)) {
            needDelKeys.push(key)
        }
    })
    needDelKeys.forEach(key => {
        ipRuleMap.delete(key)
    })
    return false;
}


/**
 * ip白名单黑名单访问过滤
 * 检测出需要被过滤的ip
 * @param req 
 * @returns boolean true 表示 过滤掉 false 表示 允许访问
 */
export function ipFilter(ip?: string): boolean {
    // 获取客户端ip
    let clientIp;
    ip && (clientIp = ip.split(",")) // 取第地址
    const whiteList: string[] = ConfigMap.white_list;
    const blackList: string[] = ConfigMap.black_list;
    // IP_UTIL_LOGGER.debug(`clientIp:\n ${clientIp} ${Array.isArray(clientIp)}`)
    // IP_UTIL_LOGGER.debug(`whiteList:\n ${whiteList}`)
    // IP_UTIL_LOGGER.debug(`blackList:\n ${blackList}`)
    // 检查是否白名单里允许所有ip访问
    const isAll = ["*", "0.0.0.0", "*.*.*.*", "::", "0:0"].find(i => whiteList.includes(i))

    if (whiteList.length > 0 && !isAll && Array.isArray(clientIp)) {
        for (const ip of clientIp) {
            // IP_UTIL_LOGGER.debug(`验证白名单 ${ip} ${clientIp.length}`)
            // 如果在 白名单里 就允许访问 不用过滤
            if (ipMatch(ip, whiteList)) {
                return false
            }
        }
        // 不在白名单里 就禁止访问
        return true
        // 检查是否黑名单里禁止所有ip访问 过滤掉
    } else if (blackList.length > 0 && Array.isArray(clientIp)) {
        for (const ip of clientIp) {
            if (ipMatch(ip, blackList)) {
                return true
            }
        }
    }
    return false
}


/**
 * 客户端 ip地址
 * @param req 
 * @returns 
 */
export function getIp(req: IncomingMessage): string | undefined {
    const ip = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress) as string | undefined;
    if (ip) {
        return ip.replaceAll(" ", "")
    }
    return ip
}

/**
 * 域名规则缓存
 */
const hostRuleMap = new Map<string, RegExp>()

export function hostMatch(host: string, list: string[]): boolean {
    for (const item of list) {
        if (/([a-zA-Z0-9-]{1,63}\*)|(\*[a-zA-Z0-9-]{1,63})|\*\*/.test(item)) {
            // 不符合规范的域名规则
            continue
        }
        let rule: RegExp | undefined = hostRuleMap.get(item)
        if (!rule) {
            // 编译规则
            const reg = item.trim().replaceAll("*", "([a-zA-Z0-9-]{1,63})");
            rule = new RegExp(reg, "i");
            // 缓存规则
            hostRuleMap.set(item, rule)
        }
        // IP_UTIL_LOGGER.debug(`hostMatch ${item} ${rule} ${list} ${host}`)
        if (rule.test(host))
            return true;
    }
    // 去除未使用的规则
    const needDelKeys: string[] = []
    hostRuleMap.forEach((_, key) => {
        if (!list.includes(key)) {
            needDelKeys.push(key)
        }
    })
    needDelKeys.forEach(key => {
        hostRuleMap.delete(key)
    })
    return false;
}

/**
 * 域名验证函数  用于判断是否允许连接
 * @param host 域名
 * @returns boolean
 */
export function verdictDomain(host: string) {
    const { client_exclude_domain, client_include_domain }: { client_exclude_domain: string[], client_include_domain: string[] } = ConfigMap
    // 白名单优先级更高 符合白名单的域名直接允许连接
    // 白名单验证过后就不验证后续规则了
    if (client_include_domain.length > 0) {
        if (hostMatch(host, client_include_domain)) {
            return true
        }
        return false
    }
    //符合黑名单的域名直接禁止连接
    else if (client_exclude_domain.length > 0 && hostMatch(host, client_exclude_domain)) {
        return false
    }
    return false
}