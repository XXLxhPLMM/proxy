import { config } from "dotenv";
import { getLogger, setLog } from "@/utils/log";
import { atob, btoa } from 'buffer'
const EVN_LOG = getLogger("CONFIG_ENV");
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
    if (arg.match(/\w+=.+/)) {
      const [key, value] = arg.split("=");
      process.env[key] = value;
      EVN_LOG.warn(`ENV:${key} - ${value}`);
    }
  })
  process.env.APP_MODE || (process.env.APP_MODE = "server")
  EVN_LOG.info(`APP_MODE: ${process.env.APP_MODE}`);
  setLog()
}


loadConfig()

type ConfigMapKeys = 'username' |
  'password' |
  'server_mode' |
  'intermediary_port' |
  'client_port' |
  'server_port' |
  'client_exclude_domain' |
  'client_include_domain' |
  'target_host' |
  'target_port' |
  'target_type' |
  'proxy_secret' |
  'use_auth' |
  'auth_type' |
  'secret_key' |
  'port' |
  "handle_compress" |
  "white_list" |
  'black_list' |
  'use_ip_filter' |
  'version' |
  's_ca_cert' |
  's_server_key' |
  's_server_cert' |
  's_server_password' |
  's_client_cert' |
  's_client_key' |
  's_client_password' |
  'app_bothway_auth' |
  'app_auth_cert'
const ConfigMap: Record<ConfigMapKeys, any> = {
  version: process.env.APP_VERSION || '1.0.0',
  client_exclude_domain: process.env.CLIENT_EXCLUDE_DOMAIN ? process.env.CLIENT_EXCLUDE_DOMAIN.split(",") : [], // 客户端排除域名列表
  client_include_domain: process.env.CLIENT_INCLUDE_DOMAIN ? process.env.CLIENT_INCLUDE_DOMAIN.split(",") : [], // 客户端包含域名列表
  port: process.env.PORT || 444, // 服务器监听端口
  client_port: process.env.CLIENT_PORT || process.env.PORT || 4456, // 客户端监听端口
  server_port: process.env.SERVER_PORT || process.env.PORT || 4455,  // 服务器服务端口
  intermediary_port: process.env.INTERMEDIARY_PORT || process.env.PORT || 3000, // 中转代理端口
  target_host: process.env.TARGET_HOST || 'localhost', // 目标地址
  target_port: process.env.TARGET_PORT || 4455, // 服务器服务端口 
  target_type: process.env.TARGET_TYPE || 'http',
  proxy_secret: process.env.PROXY_SECRET || '9f7ff6cf29ae441cad0da4e6d6843ec3', // 密钥
  auth_type: process.env.AUTH_TYPE || 'jwt', // 密钥类型  jwt | string | pwd
  secret_key: process.env.KEY || '9f7ff6cf29ae441cad0da4e6d6843ec3', // 密钥
  use_auth: process.env.APP_USE_AUTH === 'true', // 是否使用鉴权
  server_mode: process.env.SERVER_MODE || "http", // 服务器模式 http | https 
  username: process.env.AUTH_USERNAME || 'xxlAdmin',  // 链接验证账号
  password: process.env.AUTH_PASSWORD || 'xxl123456', //  链接验证密码
  handle_compress: (process.env.HANDLE_COMPRESS || "true") === 'true', // 是否处理压缩  默认启用
  white_list: process.env.WHITE_LIST ? process.env.WHITE_LIST.split(",") : [],// 白名单
  black_list: process.env.BLACK_LIST ? process.env.BLACK_LIST.split(",") : [], // 黑名单
  use_ip_filter: (process.env.USE_IP_FILTER || "true") === 'true', // 是否使用 IP 过滤  默认启用
  s_ca_cert: process.env.S_CA_CERT || './keys/ca.crt', // 服务器 ca 证书
  s_server_key: process.env.S_SERVER_KEY || './keys/server.key', // 服务器私钥
  s_server_cert: process.env.S_SERVER_CERT || './keys/server.crt', // 服务器证书
  s_client_cert: process.env.S_CLIENT_CERT || './keys/client.crt', // 客户端证书
  s_client_key: process.env.S_CLIENT_KEY || './keys/client.key', // 客户端私钥
  s_client_password: process.env.S_CLIENT_PASSWORD || '123456', // 客户端私钥密码
  s_server_password: process.env.S_SERVER_PASSWORD || '123456', // 服务器私钥密码
  app_bothway_auth: process.env.APP_BOTHWAY_AUTH === "true", // 双向验证
  app_auth_cert: process.env.APP_AUTH_CERT ? process.env.APP_AUTH_CERT === "true" : true  // 是否验证证书
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


// 适配 低版本 node 没有 atob 和 btoa 方法
if (!global.atob) {
  (global.atob as any) = atob
}
if (!global.btoa) {
  (global.btoa as any) = btoa
}