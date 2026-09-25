import { createAuthFromConfig } from "@/core/auth.js";
import type { ConfigAccessor } from "@/core/config-access.js";
import type { AuthProvider } from "@/core/types/proxy.js";
import type { RuntimeServices } from "./types.js";

/**
 * 装配 runtime 的默认服务。
 *
 * 默认 auth 是动态 provider：它持有传入的配置访问器，后续配置变更可被 core
 * 在请求时读到；调用方显式注入的 auth 优先，且不会为了被覆盖的默认实现多做
 * 任何装配工作。
 */
export function buildDefaultServices(
  configAccessor: ConfigAccessor,
  overrides: Partial<RuntimeServices> = {},
): RuntimeServices {
  const auth: AuthProvider = overrides.auth ?? createAuthFromConfig(configAccessor);
  return { auth };
}
