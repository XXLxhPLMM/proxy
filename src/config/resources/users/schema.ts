/**
 * users.json 结构校验 - 纯函数，零 IO
 *
 * 只回答「这份 JSON.parse 结果是不是合法的账号表」，不认识路径、不读文件、
 * 不做缓存。读盘与缓存语义在 `reader.ts`。
 *
 * 校验规则：
 * - 用户名必须非空且不含 `:`（Basic 凭证是 `user:pass`，含冒号会产生歧义）
 * - 密码允许空串：uid 模式（socks4 USERID）只用用户名
 * - 只允许 username/password 两个键，出现未知键即非法（避免拼写错误被静默忽略）
 * - 用户名不得重复（重复账号表在鉴权时只会命中第一条，是配置错误而非可容忍的输入）
 */
import type { AuthAccount } from "@/core/types/proxy.js";

/** users.json 允许的字段名 */
const ACCOUNT_KEYS = new Set(["username", "password"]);

/**
 * 校验账号文件内容
 * @param raw - JSON.parse 结果
 * @returns 合法时返回账号数组（顺序保留），非法返回 undefined
 */
export function validateAuthUsers(raw: unknown): AuthAccount[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const seen = new Set<string>();
  const out: AuthAccount[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return undefined;
    }
    if (Object.keys(item).some((k) => !ACCOUNT_KEYS.has(k))) {
      return undefined;
    }
    const { username, password } = item as { username?: unknown; password?: unknown };
    if (typeof username !== "string" || !username || username.includes(":")) {
      return undefined;
    }
    if (typeof password !== "string") {
      return undefined;
    }
    if (seen.has(username)) {
      return undefined;
    }
    seen.add(username);
    out.push({ username, password });
  }

  return out;
}
