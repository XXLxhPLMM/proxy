/**
 * 未知配置键闸门的**拒绝面**：argv 与 env 文件里的未知键一律让启动失败且报错可操作
 *
 * @description
 * 本档钉三件事：键名空间三种 argv 写法归一后共用一份、报错逐字点名键与来源、
 * 闸门落在唯一一次 merge 之前（失败不留半份配置）。反面（同键不误伤）归 `tolerance.test.ts`。
 * ⚠️ 逐条的「为什么」与变异锁点归**本目录 `AGENTS.md`** 的 ①–④ / ⑦ / ⑧。
 */
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigStore, defaults, loadConfig } from "@/config/index.js";
import {
  loadArgv,
  loadOptions,
  rejectionMessage,
  withTmpConfigDir,
} from "./_config-unknown-keys.js";

describe("未知 argv 键：fail-fast 且报错可操作", () => {
  it("argv 里的未知键让启动失败，错误逐字点名该键与来源", async () => {
    await withTmpConfigDir(async (cwd) => {
      const message = await rejectionMessage(
        loadArgv(["--quota-ledger-driver", "sqlite"], cwd),
      );
      expect(message).toMatch(/^配置校验失败:/);
      expect(message).toContain("QUOTA_LEDGER_DRIVER");
      expect(message).toContain("来源：CLI 参数");
    });
  });

  it("KEY=VALUE 写法的未知键同样被拦（三种 argv 写法归一后共用一个键名空间）", async () => {
    await withTmpConfigDir(async (cwd) => {
      const message = await rejectionMessage(loadArgv(["QUOTA_LEDGER_DRIVER=sqlite"], cwd));
      expect(message).toContain("QUOTA_LEDGER_DRIVER");
    });
  });

  it("编辑距离很近时给出最接近的合法键名", async () => {
    await withTmpConfigDir(async (cwd) => {
      const message = await rejectionMessage(loadArgv(["--quota-usage-di", "cfg/usage"], cwd));
      expect(message).toContain("QUOTA_USAGE_DI");
      expect(message).toContain("最接近的合法键是 QUOTA_USAGE_DIR");
    });
  });

  it("离所有合法键都很远的键不给建议（错建议比没建议更糟）", async () => {
    await withTmpConfigDir(async (cwd) => {
      const message = await rejectionMessage(loadArgv(["--cache-type", "memory"], cwd));
      expect(message).toContain("CACHE_TYPE");
      expect(message).not.toContain("最接近的合法键");
    });
  });

  it("多个未知键在一条错误里全部点名", async () => {
    await withTmpConfigDir(async (cwd) => {
      const message = await rejectionMessage(
        loadArgv(["--cache-type=memory", "--quota-ledger-driver=sqlite"], cwd),
      );
      expect(message).toContain("CACHE_TYPE");
      expect(message).toContain("QUOTA_LEDGER_DRIVER");
    });
  });

  it("未知 argv 键不半写 store（闸门在唯一一次 merge 之前）", async () => {
    await withTmpConfigDir(async (cwd) => {
      const store = new ConfigStore({ port: 18100 });
      await expect(
        loadConfig({ ...loadOptions(cwd), argv: ["--cache-type=memory"], store }),
      ).rejects.toThrow(/未知配置项 CACHE_TYPE/);
      expect(store.get("port")).toBe(18100);
    });
  });
});

describe("未知 env 文件键：fail-fast 且指名具体文件", () => {
  it("env 文件里的未知键点名那个文件路径", async () => {
    await withTmpConfigDir(async (cwd) => {
      const file = path.join(cwd, ".env.development");
      await writeFile(file, "PORT=18101\nCACHE_TYPE=memory\n", "utf8");
      const message = await rejectionMessage(
        loadConfig({ ...loadOptions(cwd), envFiles: [file] }),
      );
      expect(message).toContain("CACHE_TYPE");
      expect(message).toContain(`env 文件 ${file}`);
    });
  });

  it("多个 env 文件里各一个坏键时逐个点名各自的文件", async () => {
    await withTmpConfigDir(async (cwd) => {
      const first = path.join(cwd, "first.env");
      const second = path.join(cwd, "second.env");
      await writeFile(first, "CACHE_TYPE=memory\n", "utf8");
      await writeFile(second, "QUOTA_LEDGER_DRIVER=sqlite\n", "utf8");
      const message = await rejectionMessage(
        loadConfig({ ...loadOptions(cwd), envFiles: [first, second] }),
      );
      expect(message).toContain(`env 文件 ${first}`);
      expect(message).toContain("CACHE_TYPE");
      expect(message).toContain(`env 文件 ${second}`);
      expect(message).toContain("QUOTA_LEDGER_DRIVER");
    });
  });

  it("同键写在两个文件里时归给后写入的那个（与合并优先级一致）", async () => {
    await withTmpConfigDir(async (cwd) => {
      const first = path.join(cwd, "first.env");
      const second = path.join(cwd, "second.env");
      await writeFile(first, "CACHE_TYPE=memory\n", "utf8");
      await writeFile(second, "CACHE_TYPE=redis\n", "utf8");
      const message = await rejectionMessage(
        loadConfig({ ...loadOptions(cwd), envFiles: [first, second] }),
      );
      expect(message).toContain(`env 文件 ${second}`);
      expect(message).not.toContain(first);
    });
  });

  it("显式 env 已有的同名未知键不按文件来源报错（生效值由 env 给）", async () => {
    await withTmpConfigDir(async (cwd) => {
      const file = path.join(cwd, "one.env");
      await writeFile(file, "CACHE_TYPE=memory\n", "utf8");
      const context = await loadConfig({
        ...loadOptions(cwd),
        env: { AUTH_ENABLED: "false", CACHE_TYPE: "redis" },
        envFiles: [file],
      });
      expect(context.store.get("port")).toBe(defaults.port);
    });
  });

  it("未知 env 文件键不半写 store（闸门也在唯一一次 merge 之前）", async () => {
    await withTmpConfigDir(async (cwd) => {
      const file = path.join(cwd, "one.env");
      await writeFile(file, "PORT=18102\nCACHE_TYPE=memory\n", "utf8");
      const store = new ConfigStore({ port: 18100, host: "127.0.0.9" });
      await expect(
        loadConfig({ ...loadOptions(cwd), envFiles: [file], store }),
      ).rejects.toThrow(/未知配置项 CACHE_TYPE/);
      expect(store.get("port")).toBe(18100);
      expect(store.get("host")).toBe("127.0.0.9");
    });
  });
});

describe("显式 env 入参：未知键不报错（宿主环境的无关变量不是配置错误）", () => {
  it("显式 env 的未知键不报错且合法键照常生效", async () => {
    await withTmpConfigDir(async (cwd) => {
      const context = await loadConfig({
        ...loadOptions(cwd),
        env: { AUTH_ENABLED: "false", PORT: "18123", TOTALLY_UNRELATED: "1", PATH: "/x" },
      });
      expect(context.store.get("port")).toBe(18123);
      expect(context.sources.envKeys).toContain("TOTALLY_UNRELATED");
    });
  });
});