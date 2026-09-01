/**
 * 证书加载 - 统一 https/tls/socks 三处重复
 */

import fs from "node:fs";
import path from "node:path";

export interface CertPaths { key: string; cert: string; ca?: string; passphrase?: string; }

function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * 从 ProxyOptions.tls 提取证书路径，兼容 string / object / undefined
 */
export function extractTlsPaths(
  tls: { key?: string; cert?: string; ca?: string; passphrase?: string } | string | undefined,
): CertPaths {
  const o = typeof tls === "string" ? { key: tls, cert: tls } : tls ?? {};
  return { key: o.key ?? "", cert: o.cert ?? "", ca: o.ca, passphrase: o.passphrase };
}

export function loadCerts(
  paths: CertPaths,
  logger?: { error(msg: string, err?: unknown): void },
  label?: string,
): { key: Buffer; cert: Buffer; ca?: Buffer; passphrase?: string } {
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
