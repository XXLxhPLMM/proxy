/**
 * 空 token：`MANAGER_ENABLED=true` 且没有 `MANAGER_TOKEN` → 启动期 abort，报文逐字给出修法
 *
 * @description
 * 空 token = 任何能连上该端口的人都是管理员。目录级不变量（fail-closed 由配置层自己保证、
 * 判据不看 `managerEnabled`、报错必须逐字给修法、正向对照组）归 `./AGENTS.md`，不复制进本文件。
 *
 * 牙齿：`MANAGER_ENABLED=true` 而 token 缺席 → 报错逐字含 `MANAGER_TOKEN=<随机串>` 与
 * `MANAGER_ENABLED=false` 两个修法；显式空串同样被拒；给了 token 放行；关着时空 token 合法；
 * 纯函数档逐条覆盖（撞车与空 token 是**两条独立判据**，谁先命中都不放行）。
 */

import { describe, expect, it } from "vitest";
import { assertManagerConfig } from "@/config/schema/index.js";
import { TOKEN, load, rejectionMessage, withTmpDir } from "./_manager-config.js";

describe("空 token：MANAGER_ENABLED=true 且没有 token → 启动期 abort", () => {
  it("reject 且报文字面给出 `MANAGER_TOKEN=<随机串>` 这个修法", async () => {
    await withTmpDir(async (cwd) => {
      const message = await rejectionMessage(load(cwd, { env: { MANAGER_ENABLED: "true" } }));
      expect(message).toMatch(/^配置校验失败:/);
      expect(message).toContain("MANAGER_ENABLED=true");
      expect(message).toContain("MANAGER_TOKEN");
      // 只说「不能为空」等于让运维去猜填什么：修法必须逐字在报错里
      expect(message).toContain("MANAGER_TOKEN=<随机串>");
      expect(message).toContain("MANAGER_ENABLED=false");
    });
  });

  it("显式写成空串同样被拒（`MANAGER_TOKEN=` 与「不配」在配置里是同一个事实）", async () => {
    await withTmpDir(async (cwd) => {
      const message = await rejectionMessage(
        load(cwd, { env: { MANAGER_ENABLED: "true", MANAGER_TOKEN: "" } }),
      );
      expect(message).toContain("MANAGER_TOKEN 为空");
    });
  });

  it("给了 token 就放行（正向对照组：判据不是「开启即失败」）", async () => {
    await withTmpDir(async (cwd) => {
      const { store } = await load(cwd, {
        env: { MANAGER_ENABLED: "true", MANAGER_TOKEN: TOKEN },
      });
      expect(store.get("managerEnabled")).toBe(true);
      expect(store.get("managerToken")).toBe(TOKEN);
    });
  });

  it("关着时 token 为空合法（默认形态必须能加载出来）", async () => {
    await withTmpDir(async (cwd) => {
      const { store } = await load(cwd, { env: { MANAGER_ENABLED: "false" } });
      expect(store.get("managerToken")).toBe("");
    });
  });

  it("纯函数档逐条覆盖：撞车与空 token 是两条独立判据，谁先命中都不放行", () => {
    const ok = {
      port: 3000,
      managerEnabled: true,
      managerPort: 3010,
      managerToken: TOKEN,
      managerCorsOrigins: "",
    };
    expect(() => assertManagerConfig(ok)).not.toThrow();
    expect(() => assertManagerConfig({ ...ok, managerPort: 3000 })).toThrow(/MANAGER_PORT=3000/);
    expect(() => assertManagerConfig({ ...ok, managerToken: "" })).toThrow(/MANAGER_TOKEN 为空/);
  });
});