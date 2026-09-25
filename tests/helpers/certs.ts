import fs from "node:fs";

/**
 * 测试自签证书的相对路径（相对项目根）。
 * 说明：`loadCerts` 不再自己绝对化（绝对化由配置层按 configDir 负责），相对路径由
 * Node 的 fs 按 cwd 解析 —— vitest 的 cwd 即项目根，所以这里用相对路径是有效的。
 */
export const TEST_TLS_PATHS = { key: "keys/server.key", cert: "keys/server.crt" } as const;

/** 测试 CA 证书路径 */
export const TEST_CA_PATH = "keys/ca.crt";

/** 测试客户端证书路径（mTLS 用例专用，由 keys/ca.crt 签发） */
export const TEST_CLIENT_CERT_PATHS = { key: "keys/client.key", cert: "keys/client.crt" } as const;

/** 读取测试私钥内容 */
export function readTestKey(): Buffer {
  return fs.readFileSync(TEST_TLS_PATHS.key);
}

/** 读取测试证书内容 */
export function readTestCert(): Buffer {
  return fs.readFileSync(TEST_TLS_PATHS.cert);
}

/** 已读取的测试证书（供 tls.createServer / https.createServer 直接使用） */
export const TEST_TLS_CERTS = { key: readTestKey(), cert: readTestCert() };

/** 已读取的测试客户端证书（供 tls.connect / https.request 作为 mTLS 客户端使用） */
export const TEST_CLIENT_CERTS = {
  key: fs.readFileSync(TEST_CLIENT_CERT_PATHS.key),
  cert: fs.readFileSync(TEST_CLIENT_CERT_PATHS.cert),
};
