/**
 * 启动快照与配置闸门的三件事：token 脱敏落盘 / 未知键（`MANAGER_ENABELD`）拦下 / `--use-home-config`
 *
 * @description
 * `logConfig` 整份打印配置快照（`debug` 档进 JSONL 落盘），而日志的读者面远大于能读 `.env` 的人；
 * 未知键闸门则是「新增五个键之后还认得它们」的正面证据。目录级不变量（fail-closed 由配置层自己
 * 保证、报错必须逐字给修法、正向对照组）归 `./AGENTS.md`，不复制进本文件。
 *
 * 牙齿走**真实 logger 落盘**（控制台静音、落盘放行到 debug）：脱敏断言覆盖**整份落盘**的明文，
 * 另有非密字段的对照组；错名在 argv / env 文件两个来源都 reject 并逐字点名最接近的合法键；
 * `--use-home-config` 不放宽 `managerHost`。
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, type ConfigContext } from "@/config/index.js";
import { logConfig } from "@/server/log/config-log.js";
import { createLogger } from "@/utils/logger/index.js";
import { TOKEN, load, rejectionMessage, withTmpDir } from "./_manager-config.js";

/**
 * 跑一次真实 `logConfig` 并读回落盘的 JSONL 记录。
 * 控制台静音（level=silent）、落盘放行到 debug —— 断言的是**日志文件里真实写了什么**，
 * 而不是内存里某个中间对象。
 */
async function logConfigRecords(context: ConfigContext): Promise<{ records: Record<string, unknown>[]; raw: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manager-config-log-"));
  try {
    const logger = createLogger({ file: dir, level: "silent", fileLevel: "debug" });
    logConfig(context, logger);
    await logger.flush();
    const names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
    const raw = (
      await Promise.all(names.map(async (n) => readFile(path.join(dir, n), "utf8")))
    ).join("");
    const records = raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { records, raw };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("启动快照脱敏：logConfig 落盘里 token 是 ***，明文一个字都不许出现", () => {
  it("=== config === 那条记录里 managerToken 是 ***，且全部落盘行不含明文", async () => {
    await withTmpDir(async (cwd) => {
      const context = await load(cwd, {
        env: { MANAGER_ENABLED: "true", MANAGER_TOKEN: TOKEN },
      });
      const { records, raw } = await logConfigRecords(context);

      const snapshot = records.find((r) => r.msg === "=== config ===");
      expect(snapshot, "logConfig 必须真的打印了配置快照").toBeDefined();
      expect(snapshot?.managerToken).toBe("***");
      // 明文泄漏检查覆盖**整份落盘**：只看上面那个字段的话，把掩码改成 ""（等于不脱敏）也能过
      expect(raw).not.toContain(TOKEN);
      // 对照组：同一份快照里的非密字段照常打印（否则「什么都没打」也能满足上面两条）
      expect(snapshot?.managerEnabled).toBe(true);
      expect(snapshot?.managerPort).toBe(3010);
    });
  });

  it("token 为空时那一项仍是空串（不打码成 ***，否则「没配」与「配了」在快照里长得一样）", async () => {
    await withTmpDir(async (cwd) => {
      const context = await load(cwd);
      const { records } = await logConfigRecords(context);
      const snapshot = records.find((r) => r.msg === "=== config ===");
      expect(snapshot?.managerToken).toBe("");
      // 对照组：真的配了非空 token 时那一项就不是空串（否则上一条恒真）
      const filled = await loadConfig({
        env: { MANAGER_ENABLED: "true", MANAGER_TOKEN: TOKEN },
        envFiles: [],
        argv: [],
        cwd,
        skipFileValidation: true,
      });
      const filledRecords = await logConfigRecords(filled);
      expect(filledRecords.records.find((r) => r.msg === "=== config ===")?.managerToken).toBe("***");
    });
  });

  it("脱敏与 jwtSecret 同档（两组 secret 都打码，快照里没有任何一档明文）", async () => {
    await withTmpDir(async (cwd) => {
      const context = await load(cwd, {
        env: {
          MANAGER_ENABLED: "true",
          MANAGER_TOKEN: TOKEN,
          JWT_SECRET: "jwt-plaintext-canary",
          TLS_PASSPHRASE: "passphrase-canary",
        },
      });
      const { raw } = await logConfigRecords(context);
      expect(raw).not.toContain("jwt-plaintext-canary");
      expect(raw).not.toContain("passphrase-canary");
    });
  });
});

describe("未知键闸门：拼错的 MANAGER_ENABELD 必须让启动失败", () => {
  it("argv 里的错名 reject，并逐字点名错名与最接近的合法键", async () => {
    await withTmpDir(async (cwd) => {
      const message = await rejectionMessage(load(cwd, { argv: ["MANAGER_ENABELD=1"] }));
      expect(message).toMatch(/^配置校验失败:/);
      expect(message).toContain("MANAGER_ENABELD");
      expect(message).toContain("最接近的合法键是 MANAGER_ENABLED");
    });
  });

  it("env 文件里的错名同样 reject（闸门管的是两个「显式用户意图」来源）", async () => {
    await withTmpDir(async (cwd) => {
      const file = path.join(cwd, "one.env");
      await writeFile(file, "MANAGER_ENABELD=1\n", "utf8");
      const message = await rejectionMessage(
        loadConfig({
          env: {},
          envFiles: [file],
          argv: [],
          cwd,
          skipFileValidation: true,
        }),
      );
      expect(message).toContain("MANAGER_ENABELD");
      expect(message).toContain(file);
    });
  });

  it("真名在 argv / env 文件两个来源都不报错（闸门不是「拒绝一切」的反面）", async () => {
    await withTmpDir(async (cwd) => {
      await expect(load(cwd, { argv: ["MANAGER_ENABLED=false"] })).resolves.toBeDefined();
      const file = path.join(cwd, "ok.env");
      await writeFile(file, "MANAGER_ENABLED=false\nMANAGER_PORT=3010\n", "utf8");
      await expect(
        loadConfig({ env: {}, envFiles: [file], argv: [], cwd, skipFileValidation: true }),
      ).resolves.toBeDefined();
    });
  });
});

describe("useHomeConfig 不放宽管理面监听地址", () => {
  it("--use-home-config 下 managerHost 仍是 127.0.0.1（它换的是配置目录，不是谁能连上来）", async () => {
    await withTmpDir(async (cwd) => {
      const { store } = await load(cwd, { argv: ["--use-home-config"] });
      expect(store.get("useHomeConfig")).toBe(true);
      expect(store.get("managerHost")).toBe("127.0.0.1");
      // 对照组：确实能显式改宽（拦它等于把一种合法部署写死成不可表达）
      const widened = await load(cwd, {
        env: { MANAGER_HOST: "0.0.0.0", MANAGER_ENABLED: "true", MANAGER_TOKEN: TOKEN },
      });
      expect(widened.store.get("managerHost")).toBe("0.0.0.0");
    });
  });
});