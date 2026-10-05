/**
 * `MANAGER_PORT` 与 `PORT` 的两条交叉判据：端口撞车 → 启动期 abort；越界 / 非法值 → 同样 abort
 *
 * @description
 * 目录级不变量（fail-closed 由配置层自己保证、判据不看 `managerEnabled`、报错必须逐字给修法、
 * 正向对照组）归 `./AGENTS.md`，不复制进本文件。
 *
 * 牙齿：撞车那条点名两个键 + `EADDRINUSE` + 「空闲端口」；`enabled=false` 时照样 abort；
 * 两个 0 不算冲突（`listen(0)` 的系统分配语义）；越界 / 非数字 / 小数各自 abort 且**不半写 store**。
 */

import { describe, expect, it } from "vitest";
import { ConfigStore, defaults, loadConfig } from "@/config/index.js";
import { assertManagerConfig } from "@/config/schema/index.js";
import { TOKEN, load, rejectionMessage, withTmpDir } from "./_manager-config.js";

describe("端口撞车：两个 listener 抢同一个端口 → 启动期 abort（不看 managerEnabled）", () => {
  it("PORT 与 MANAGER_PORT 相等即 reject，报错点名两个键并给出修法", async () => {
    await withTmpDir(async (cwd) => {
      const message = await rejectionMessage(
        load(cwd, { env: { PORT: "3010", MANAGER_PORT: "3010" } }),
      );
      expect(message).toMatch(/^配置校验失败:/);
      expect(message).toContain("MANAGER_PORT=3010");
      expect(message).toContain("PORT=3010");
      expect(message).toContain("EADDRINUSE");
      expect(message).toContain("空闲端口");
    });
  });

  it("managerEnabled=false 时撞车照样 abort（把错配藏到启用那天只会更难查）", async () => {
    await withTmpDir(async (cwd) => {
      const message = await rejectionMessage(
        load(cwd, { env: { PORT: "3010", MANAGER_PORT: "3010", MANAGER_ENABLED: "false" } }),
      );
      expect(message).toContain("MANAGER_PORT=3010");
    });
  });

  it("两端口不同时正常加载（正向对照组：判据不是「永远报错」）", async () => {
    await withTmpDir(async (cwd) => {
      const { store } = await load(cwd, {
        env: { PORT: "3000", MANAGER_PORT: "3010", MANAGER_ENABLED: "true", MANAGER_TOKEN: TOKEN },
      });
      expect(store.get("managerPort")).toBe(3010);
      expect(store.get("port")).toBe(3000);
    });
  });

  it("两个 0 不算冲突（listen(0) 的「由系统分配」语义：绕开 loadConfig 的 library 调用方能拿到 0）", () => {
    expect(() =>
      assertManagerConfig({ port: 0, managerEnabled: false, managerPort: 0, managerToken: "", managerCorsOrigins: "" }),
    ).not.toThrow();
    // 0 与非 0 同理：只有「两个非 0 且相等」才是撞车
    expect(() =>
      assertManagerConfig({ port: 0, managerEnabled: false, managerPort: 3010, managerToken: "", managerCorsOrigins: "" }),
    ).not.toThrow();
  });
});

describe("MANAGER_PORT 越界 / 非法：即使 managerEnabled=false 也 abort", () => {
  it("0 / 70000 越界即 reject（0 是 listen(0) 的系统分配语义，不是可写进配置的取值）", async () => {
    await withTmpDir(async (cwd) => {
      for (const raw of ["0", "70000"]) {
        const message = await rejectionMessage(load(cwd, { env: { MANAGER_PORT: raw } }));
        expect(message, `MANAGER_PORT=${raw} 应当被拒`).toContain(`MANAGER_PORT=${raw} 越界`);
      }
    });
  });

  it("非数字 / 小数 → 解析失败即 abort（不静默回落缺省 3010）", async () => {
    await withTmpDir(async (cwd) => {
      const message = await rejectionMessage(load(cwd, { env: { MANAGER_PORT: "abc" } }));
      expect(message).toContain("MANAGER_PORT=abc");
      await expect(load(cwd, { env: { MANAGER_PORT: "1.5" } })).rejects.toThrow(/MANAGER_PORT=1\.5/);
    });
  });

  it("两端合法值认（1 与 65535）", async () => {
    await withTmpDir(async (cwd) => {
      expect((await load(cwd, { env: { MANAGER_PORT: "1" } })).store.get("managerPort")).toBe(1);
      expect((await load(cwd, { env: { MANAGER_PORT: "65535" } })).store.get("managerPort")).toBe(65535);
    });
  });

  it("非法值不半写 store（既有原子落库契约：失败不留半份配置）", async () => {
    await withTmpDir(async (cwd) => {
      const store = new ConfigStore({ port: 18100 });
      await expect(
        loadConfig({
          env: { MANAGER_PORT: "70000" },
          envFiles: [],
          argv: [],
          cwd,
          store,
          skipFileValidation: true,
        }),
      ).rejects.toThrow(/MANAGER_PORT=70000 越界/);
      expect(store.get("managerPort")).toBe(defaults.managerPort);
      expect(store.get("port")).toBe(18100);
    });
  });
});