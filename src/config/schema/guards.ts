/**
 * 跨字段守卫 - 判定「组合起来是否自洽」
 *
 * 与 `validate.ts` 的分工：那边逐字段看「这个值本身合法吗」，这里看「几个字段
 * 凑在一起是不是自相矛盾」。凡是单字段看不出问题的坑（开了鉴权却选 none、
 * 开了 basic 却没账号、开了 jwt 却没密钥）都归这里。
 *
 * 保持为导出的纯函数：便于单测（无需起子进程），也便于 `load.ts` 在启动期和
 * runtime candidate 两条路径上复用同一份判定。
 */

/**
 * 鉴权组合的跨字段校验：开启鉴权时必须能真正拦人（fail-closed，任一项不成立即阻止启动）
 * @description
 * - `authEnabled + none`：开了鉴权却不选方式 = 全部放行，属自相矛盾配置
 * - `authEnabled + basic/uid + 账号表为空`：无账号可比对时一律判否是徒劳的「拒绝一切」，
 *   真正原因是 AUTH_USERS_FILE 没配好（路径写错/文件为空），必须让启动失败而不是静默全拒
 * - `authEnabled + jwt + 空 JWT_SECRET`：无密钥的 JWT 校验没有意义
 * @param cfg - 待校验组合（authEnabled / authType / accountCount / jwtSecret）
 * @throws {Error} 配置非法时抛 `配置校验失败: ...`
 * @example assertAuthConfig({ authEnabled: true, authType: "basic", accountCount: 0 }); // throws
 * @example assertAuthConfig({ authEnabled: true, authType: "basic", accountCount: 2 }); // ok
 */
export function assertAuthConfig(cfg: {
  authEnabled: boolean;
  authType: string;
  accountCount: number;
  jwtSecret?: string;
}): void {
  if (!cfg.authEnabled) {
    return;
  }
  if (cfg.authType === "none") {
    throw new Error(
      "配置校验失败: AUTH_ENABLED=true 但 AUTH_TYPE=none（不会校验任何凭证）；确需关闭鉴权请设 AUTH_ENABLED=false",
    );
  }
  if ((cfg.authType === "basic" || cfg.authType === "uid") && cfg.accountCount === 0) {
    throw new Error(
      `配置校验失败: 账号表为空（AUTH_ENABLED=true 且 AUTH_TYPE=${cfg.authType}）；请检查 AUTH_USERS_FILE 指向的文件是否存在且至少配置一个账号`,
    );
  }
  if (cfg.authType === "jwt" && !cfg.jwtSecret) {
    throw new Error("配置校验失败: JWT_SECRET 为空（AUTH_ENABLED=true 且 AUTH_TYPE=jwt）");
  }
}
