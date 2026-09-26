/**
 * 配置路径解析 - 把「配置里写的相对路径」按 cwd 解析成绝对路径
 * 职责：
 * - `resolveFromCwd`：相对路径以 `process.cwd()` 为基准，绝对路径原样返回
 * 设计：
 * - 与 `config/source/dir.ts` 的 `configDir` 语义对齐：`keys/server.key` 这类相对路径
 *   在任何工作目录下都能定位到，TLS 证书/CA 读取全部走这一个实现
 * - 纯字符串运算，不碰文件系统：不存在/不可读由调用方按各自语义处理
 *   （服务端证书缺失即 abort 启动，上游 CA 缺失即回退系统信任库）
 * @param p - 原始路径（可能为相对或绝对）
 * @returns 绝对路径
 * @example
 * ```ts
 * resolveFromCwd("keys/server.crt");      // "/app/proxy/keys/server.crt"
 * resolveFromCwd("/etc/ssl/server.key"); // "/etc/ssl/server.key"
 * ```
 */
import path from "node:path";

export function resolveFromCwd(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}
