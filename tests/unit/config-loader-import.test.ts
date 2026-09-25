import { describe, expect, it } from "vitest";
import { getAll } from "@/config/store.js";

/**
 * CLI 配置加载的 import 零副作用护栏。
 *
 * 保护的不变量：
 *  - import `cli.ts` 只定义进程入口，不因 `require.main !== module` 而初始化配置
 *  - import `loader.ts` 只导出 `initConfig` 函数，不读取 env/argv/文件、不写全局 store
 *  - 故意放置非法 env；若 import 期偷偷调用 initConfig，本用例会直接抛错而不是静默污染宿主
 */
describe("配置初始化 import 边界", () => {
  it("import CLI / loader 不会加载宿主配置", async () => {
    const savedEnv = { ...process.env };
    const globalBefore = getAll();

    process.env.PORT = "not-a-number";
    process.env.AUTH_ENABLED = "treu";
    process.env.UPSTREAM_URL = "not a url";
    const hostileEnv = { ...process.env };

    try {
      await expect(import("@/cli.js")).resolves.toBeDefined();
      expect({ ...process.env }).toEqual(hostileEnv);
      expect(getAll()).toEqual(globalBefore);

      const loader = await import("@/config/loader.js");
      expect(loader.initConfig).toBeTypeOf("function");
      expect({ ...process.env }).toEqual(hostileEnv);
      expect(getAll()).toEqual(globalBefore);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, savedEnv);
    }
  });
});
