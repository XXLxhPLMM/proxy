import { describe, expect, it } from "vitest";
import { ConfigStore } from "@/config/index.js";

/**
 * 配置 import 零副作用护栏。
 *
 * 这里刻意先放入非法宿主 env，再动态 import 唯一加载入口；调用时只给空 env/argv 与
 * 显式空 envFiles，并跳过文件校验。若 loader 偷读 process.env/process.argv 或在
 * import 期初始化，store 或宿主环境会出现变化，用例会直接失败。
 */
describe("配置加载器 import 边界", () => {
  it("import loadConfig 不会读取宿主配置，显式调用也不污染 env/store", async () => {
    const savedEnv = { ...process.env };
    const store = new ConfigStore();
    const storeBefore = store.getAll();

    process.env.PORT = "not-a-number";
    process.env.AUTH_ENABLED = "treu";
    process.env.UPSTREAM_URL = "not a url";
    const hostileEnv = { ...process.env };

    try {
      const loadModule = await import("@/config/load.js");
      expect(loadModule.loadConfig).toBeTypeOf("function");
      expect({ ...process.env }).toEqual(hostileEnv);
      expect(store.getAll()).toEqual(storeBefore);

      const context = await loadModule.loadConfig({
        env: {},
        envFiles: [],
        argv: [],
        store,
        skipFileValidation: true,
      });

      expect(context.store).toBe(store);
      expect(store.get("port")).toBe(3000);
      expect(store.get("authEnabled")).toBe(false);
      expect(store.getAll()).not.toEqual(storeBefore);
      expect({ ...process.env }).toEqual(hostileEnv);
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
