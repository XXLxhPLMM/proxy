/**
 * 证书加载 - 统一 http-server/socks/tls 三处重复
 */

import fs from "node:fs";
import path from "node:path";

/** TLS 证书文件路径集合，ca/passphrase 可选 */
export interface CertPaths { key: string; cert: string; ca?: string; passphrase?: string; }

/** TLS 输入形态：对象 / 单路径字符串（key 与 cert 同值）/ 未传；各处 tls 字段统一用它，别再手写内联对象 */
export interface TlsKeyCert { key?: string; cert?: string; ca?: string; passphrase?: string; }
export type TlsInput = TlsKeyCert | string | undefined;

/** 已加载的证书上下文：loadCerts/loadTlsContext 出品 + 各处缓存字段统一用它，别再手写内联 Buffer 对象 */
export interface LoadedTlsCerts { key: Buffer; cert: Buffer; ca?: Buffer; passphrase?: string; }

/** 相对路径按进程工作目录解析为绝对路径，绝对路径原样返回 */
function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * 从 ProxyOptions.tls 提取证书路径，兼容 string / object / undefined
 */
export function extractTlsPaths(tls: TlsInput): CertPaths {
  const o = typeof tls === "string" ? { key: tls, cert: tls } : tls ?? {};
  return { key: o.key ?? "", cert: o.cert ?? "", ca: o.ca, passphrase: o.passphrase };
}

/**
 * 一站式加载 TLS 上下文：extractTlsPaths + loadCerts 二合一
 * 收敛 https-server/socks/tls 三处重复的证书四连招首步
 * @param tls - ProxyOptions.tls 或 HttpsServerOptions.tls 形态
 */
export function loadTlsContext(
  tls: TlsInput,
  logger?: { error(msg: string, err?: unknown): void },
  label?: string,
): LoadedTlsCerts {
  return loadCerts(extractTlsPaths(tls), logger, label);
}
/**
 * 同步读取证书文件为 Buffer
 * - key/cert 缺失会抛错（调用方在 onBeforeStart 阶段处理，阻止启动）
 * - ca 为可选：路径存在才读取，用于 mTLS 校验客户端证书
 * @param paths - 证书路径集合
 * @param logger - 出错时的日志器（可选），用于打印实际解析到的绝对路径
 * @param label - 日志前缀标签，如 "TLS"/"SOCKS"，区分多协议场景
 */
export function loadCerts(
  paths: CertPaths,
  logger?: { error(msg: string, err?: unknown): void },
  label?: string,
): LoadedTlsCerts {
  const keyPath = resolvePath(paths.key);
  const certPath = resolvePath(paths.cert);
  try {
    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);
    let ca: Buffer | undefined;
    if (paths.ca) {
      const caPath = resolvePath(paths.ca);
      if (fs.existsSync(caPath)) ca = fs.readFileSync(caPath);
    }
    return { key, cert, ca, passphrase: paths.passphrase || undefined };
  } catch (e) {
    const caInfo = paths.ca ? ` ca=${resolvePath(paths.ca)}` : "";
    const prefix = label ? `${label} ` : "";
    logger?.error(`${prefix}证书加载失败 key=${keyPath} cert=${certPath}${caInfo}`, e);
    throw e;
  }
}
