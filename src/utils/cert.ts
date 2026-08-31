/**
 * 证书加载 - 统一 https/tls/socks 三处重复
 */

import fs from "node:fs";
import path from "node:path";

export interface CertPaths { key: string; cert: string; ca?: string; passphrase?: string; }

function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

export function loadCerts(paths: CertPaths): { key: Buffer; cert: Buffer; ca?: Buffer; passphrase?: string } {
  const keyPath = resolvePath(paths.key);
  const certPath = resolvePath(paths.cert);
  const key = fs.readFileSync(keyPath);
  const cert = fs.readFileSync(certPath);
  let ca: Buffer | undefined;
  if (paths.ca) {
    const caPath = resolvePath(paths.ca);
    if (fs.existsSync(caPath)) ca = fs.readFileSync(caPath);
  }
  return { key, cert, ca, passphrase: paths.passphrase || undefined };
}
