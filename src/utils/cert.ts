/**
 * 证书加载
 */

import fs from "node:fs";
import path from "node:path";

/** TLS 输入形态：对象 / 单路径字符串（key 与 cert 同值）/ 未传 */
export interface TlsKeyCert { key?: string; cert?: string; ca?: string; passphrase?: string; }
export type TlsInput = TlsKeyCert | string | undefined;

/** 已加载的证书上下文 */
export interface LoadedTlsCerts { key: Buffer; cert: Buffer; ca?: Buffer; passphrase?: string; }

function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * 同步读取证书文件为 Buffer
 * - key/cert 缺失会抛错（调用方在 onBeforeStart 阶段处理，阻止启动）
 * - ca 可选：路径存在才读取
 */
export function loadCerts(
  tls: TlsInput,
  logger?: { error(msg: string, err?: unknown): void },
  label?: string,
): LoadedTlsCerts {
  const o = typeof tls === "string" ? { key: tls, cert: tls } : tls ?? {};
  const keyPath = resolvePath(o.key ?? "");
  const certPath = resolvePath(o.cert ?? "");
  try {
    const key = fs.readFileSync(keyPath);
    const cert = fs.readFileSync(certPath);
    let ca: Buffer | undefined;
    if (o.ca) {
      const caPath = resolvePath(o.ca);
      if (fs.existsSync(caPath)) ca = fs.readFileSync(caPath);
    }
    return { key, cert, ca, passphrase: o.passphrase || undefined };
  } catch (e) {
    const caInfo = o.ca ? ` ca=${resolvePath(o.ca)}` : "";
    const prefix = label ? `${label} ` : "";
    logger?.error(`${prefix}证书加载失败 key=${keyPath} cert=${certPath}${caInfo}`, e);
    throw e;
  }
}
