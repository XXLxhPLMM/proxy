import { config } from "dotenv";
import { logger } from "@/utils/log";
const EVN_LOG = logger.getLogger("CONFIG_ENV");
export default function loadConfig() {
  // 获取命令行参数
  const args = process.argv.slice(2);
  const modeArg = args.find((arg) => arg.startsWith("mode=")); // 查找以 'mode=' 开头的参数
  // 提取 mode 的值
  const mode = modeArg ? modeArg.split("=")[1] : "dev"; // 默认使用 'dev'
  // 定义加载的 .env 文件
  const envFile = `.env.${mode}`;
  // 加载对应的 .env 文件
  config({ path: [envFile, ".env"] });
  args.forEach((arg) => {
    if (arg.match(/\w+=\w+/)) {
      const [key, value] = arg.split("=");
      process.env[key] = value;
      EVN_LOG.info(`ENV:${key} - ${value}`);
    }
  })
  process.env.APP_MODE || (process.env.APP_MODE = "server")
  EVN_LOG.info(`APP_MODE: ${process.env.APP_MODE}`);
}
loadConfig()


const ConfigMap: Record<'client_exclude_domain' | 'client_include_domain' | 'target_host' | 'target_port' | 'proxy_secret' | 'use_auth' | 'secret_type' | 'secret_key', any> = {
  client_exclude_domain: [], // 客户端排除域名列表
  client_include_domain: ["open-api.dianba6.com", "apipdd.dianba6.com","pkg.chenran0791.cn"], // 客户端包含域名列表
  target_host: 'localhost', // 目标地址
  target_port: 4455, // 服务器服务端口 
  proxy_secret: '9f7ff6cf29ae441cad0da4e6d6843ec3', // 密钥
  secret_type: process.env.AUTH_TYPE || 'jwt', // 密钥类型  jwt | string
  secret_key: process.env.KEY || '9f7ff6cf29ae441cad0da4e6d6843ec3', // 密钥
  use_auth: process.env.APP_USE_AUTH === 'true', // 是否使用鉴权
}

// 监听客户端排除域名列表的变化
process.on("proxy_change:client_exclude_domain", setClientExcludeDomain)
// 监听客户端包含域名列表的变化
process.on("proxy_change:client_include_domain", setClientIncludeDomain)
// 监听鉴权使用变化
process.on("proxy_change:use_auth", (data: boolean) => {
  ConfigMap.use_auth = data;
})

// 监听目标地址和端口的变化
process.on("proxy_change:target_host", (data: string) => {
  ConfigMap.target_host = data
})
process.on("proxy_change:target_port", (data: number) => {
  ConfigMap.target_port = data
})
// 监听密钥的变化
process.on("proxy_change:proxy_secret", (data: string) => {
  ConfigMap.proxy_secret = data
})

/**
 * 设置客户端排除域名列表
 * @param data 客户端排除域名列表
 */
function setClientExcludeDomain(data: string[]): void {
  Array.isArray(data) && (ConfigMap.client_exclude_domain = data)
}
/**
 * 
 * @param data 客户端包含域名列表
 */
function setClientIncludeDomain(data: string[]): void {
  Array.isArray(data) && (ConfigMap.client_include_domain = data)
}

function setConfig(key: keyof typeof ConfigMap, value: any): void {
  ConfigMap[key] = value
}

export { loadConfig, ConfigMap, setConfig, setClientExcludeDomain, setClientIncludeDomain }


/**
 * 域名验证函数  用于判断是否允许连接
 * @param host 域名
 * @returns boolean
 */
export function verdictDomain(host: string) {
  const { client_exclude_domain, client_include_domain }: { client_exclude_domain: string[], client_include_domain: string[] } = ConfigMap
  if (client_include_domain.length > 0) {
      if (client_include_domain.includes(host)) {
          return true
      }
      return false
  }
  if (client_exclude_domain.length > 0 && client_exclude_domain.includes(host)) {
      return false
  }
  return true
}