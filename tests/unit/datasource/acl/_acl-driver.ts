/**
 * `datasource/acl/` 两档共用的**假名单驱动**接线面（`driver-wiring` + `driver-registry`）
 *
 * @description
 * 主题级不变量与变异表归同目录 `AGENTS.md`；这里只放两档真用到的入参与工厂。
 *
 * ⚠️ **前导留在测试侧，不许上提 `tests/helpers/`**：`CUSTOM_ACL` 带着一个公网 host 字面量，而
 * `external-network-scan.ts` 的 `SCAN_DIRS` 排除 `helpers/` —— 搬进去等于让那部分覆盖从零外网
 * 扫描里静默消失，而 `no-external-network.test.ts` 的下界断言照样绿。**可见的重复优于看不见的失效。**
 */

import { ConfigStore } from "@/config/index.js";
import {
  EMPTY_ACL,
  registerAclSource,
  type AclConfig,
  type AclReadOptions,
  type AclSource,
} from "@/datasource/acl/index.js";
import type { JsonFileRead } from "@/utils/json-file/index.js";

/** 自定义驱动名。刻意不像任何内置档，防止「恰好命中内置分支」的假绿。 */
export const CUSTOM = "unit-test-custom";

/** 两条驱动对同一主机的相反判定：判定类用例都拿它做对照。 */
export const DENIED_HOST = "banned-by-custom.example.com";

const CUSTOM_ACL: AclConfig = {
  clientIp: { whitelist: [], blacklist: [] },
  target: { whitelist: [], blacklist: [DENIED_HOST] },
  upstream: { whitelist: [], blacklist: [] },
};

/** 实现器工厂的记账：证明「装配点真的问过注册表」，而不是只断言最终判定值。 */
export interface Probe {
  factoryCalls: number;
  readCalls: number;
  startupCalls: number;
}

export function newProbe(): Probe {
  return { factoryCalls: 0, readCalls: 0, startupCalls: 0 };
}

/**
 * 假实现器：一份写死的名单 + 一次调用计数
 * @description 每次 `read` 返回**同一个** `AclConfig` 对象（与真实实现器「内容未变即同一份
 * 快照」的语义一致），否则判定层的编译缓存因每次新对象而永不命中，用例就变成在测缓存。
 */
export function fakeSource(probe: Probe, startupError?: string): AclSource {
  const locator = (): string => "unit-test://acl";
  return {
    driver: CUSTOM,
    locator,
    read(options?: AclReadOptions): JsonFileRead<AclConfig> {
      probe.readCalls += 1;
      options?.onEvent?.({ type: "reloaded", label: "unit-test", path: locator() });
      return { value: CUSTOM_ACL, path: locator(), exists: true };
    },
    async readStartup(): Promise<JsonFileRead<AclConfig>> {
      probe.startupCalls += 1;
      return {
        value: startupError ? EMPTY_ACL : CUSTOM_ACL,
        path: locator(),
        exists: startupError === undefined,
        error: startupError,
      };
    },
  };
}

/** 注册自定义驱动并返回退订闭包（退订后注册表回到出厂状态） */
export function register(probe: Probe, startupError?: string): () => void {
  return registerAclSource(CUSTOM, () => {
    probe.factoryCalls += 1;
    return fakeSource(probe, startupError);
  });
}

/** 一份**独立**的配置 store（记忆表按接线分槽，故每例的装配互不影响） */
export function storeWith(patch: { aclDriver?: string; aclFile?: string }): ConfigStore {
  return new ConfigStore(patch);
}
