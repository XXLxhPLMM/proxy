/**
 * 控制面装配点（`src/manager/control-plane.ts`）的单测
 *
 * @description
 * ## 为什么单独一档，而不是并进 `manager-http.test.ts`
 *
 * 那一档盯的是**传输面契约**（真 socket 上的鉴权 / 状态码 / 零泄露），它自己造路由表、不经过
 * 装配。本档盯的是装配本身那三件事，恰好都是「错了会怎样」的形状：
 * 1. **未启用 ⇒ `null` 且零副作用**。返回别的东西（一个没监听的句柄、或一次 throw）会让
 *    `MANAGER_ENABLED` 未设的部署**整个起不来** —— 那是一个可选功能变成了启动闸门。
 * 2. **启用 ⇒ 真的在监听，且看到的是注入进来的那份数据面事实**（不是某份默认值）。
 * 3. **`listen` 失败必须抛**，且 `EADDRINUSE` 那条要含修法。静默继续 = 运维以为控制面开着
 *    而它根本没开。
 *
 * ## 齿���全在真 socket 上
 *
 * 「真的在监听」「端口真的被占」这两件事只有真 `listen` 才作数（端口 0 → 真实分配；第二个
 * server 绑同一个固定端口 → 真 EADDRINUSE）。
 *
 * @module tests/unit/manager-control-plane
 */

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type ConfigContext } from "@/config/index.js";
import { startControlPlane, type ControlPlane } from "@/manager/control-plane.js";
import type { DataPlaneStatus } from "@/manager/routes/index.js";
import { createLogger, type LoggerImpl } from "@/utils/logger/index.js";

const TOKEN = "control-plane-canary-8d41";

let dir = "";
let logger: LoggerImpl;
const opened: ControlPlane[] = [];

/** 装配一份上下文：argv 恒空（测试不走配置键通路），env 文件候选与服务端同一份 */
async function contextWith(env: Record<string, string | undefined>): Promise<ConfigContext> {
  const merged = { NODE_ENV: "development", ...env };
  return loadConfig({
    env: merged,
    envFiles: [path.join(dir, ".env.development"), path.join(dir, ".env")],
    argv: [],
    cwd: dir,
  });
}

const facts = (over: Partial<DataPlaneStatus> = {}): DataPlaneStatus => ({
  mode: "running",
  protocol: "http",
  host: "0.0.0.0",
  port: 3000,
  running: true,
  startedAt: 1_700_000_000_000,
  uptimeMs: 5,
  ...over,
});

/** 打一发真的 HTTP 请求（带 token），只取状态码与解析后的 body */
function call(
  port: number,
  path: string,
  token: string | null,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
    }
    const req = http.request({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json: Record<string, unknown> | null = null;
        try {
          json = raw === "" ? null : (JSON.parse(raw) as Record<string, unknown>);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** 借系统分配一个当前空闲的端口（`MANAGER_PORT` 的字段契约是 1-65535，拿不到 0） */
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address();
  const port = address !== null && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolve) => {
    probe.close(() => resolve());
  });
  return port;
}

/** 端口号（控制面句柄只给 `address: "host:port"`） */
function portOf(plane: ControlPlane): number {
  return Number(plane.url.slice(plane.url.lastIndexOf(":") + 1));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-"));
  logger = createLogger({ level: "silent" });
});

afterEach(async () => {
  for (const plane of opened.splice(0)) {
    await plane.close();
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不应遮蔽用例结论
  }
});

describe("startControlPlane — 未启用", () => {
  it("`MANAGER_ENABLED=false`（缺省）⇒ `null`，且一个端口都不占", async () => {
    const control = await startControlPlane({
      context: await contextWith({}),
      logger,
      processFacts: {
        pid: 1,
        startedAt: 0,
        node: process.version,
        platform: process.platform,
        cwd: dir,
      },
      dataPlane: () => facts(),
    });
    expect(control).toBeNull();
  });

  it("显式写 `MANAGER_ENABLED=false` 与不写是同一件事（缺省即「没有这个面」）", async () => {
    const control = await startControlPlane({
      context: await contextWith({ MANAGER_ENABLED: "false", MANAGER_TOKEN: TOKEN }),
      logger,
      processFacts: {
        pid: 1,
        startedAt: 0,
        node: process.version,
        platform: process.platform,
        cwd: dir,
      },
      dataPlane: () => facts(),
    });
    expect(control).toBeNull();
  });
});

describe("startControlPlane — 启用", () => {
  it("真的在监听，且 `/api/status` 报的是**注入进来的**那份数据面事实", async () => {
    const port = await freePort();
    const control = await startControlPlane({
      context: await contextWith({
        MANAGER_ENABLED: "true",
        MANAGER_TOKEN: TOKEN,
        MANAGER_HOST: "127.0.0.1",
        MANAGER_PORT: String(port),
      }),
      logger,
      processFacts: {
        pid: 4242,
        startedAt: Date.now(),
        node: process.version,
        platform: process.platform,
        cwd: dir,
      },
      dataPlane: () => facts({ mode: "stopping", protocol: "socks5", port: 1080, running: false }),
    });
    expect(control).not.toBeNull();
    const plane = control as ControlPlane;
    opened.push(plane);

    const reply = await call(portOf(plane), "/api/status", TOKEN);
    expect(reply.status).toBe(200);
    expect(reply.json?.process).toMatchObject({ pid: 4242, cwd: dir });
    expect(reply.json?.proxy).toMatchObject({
      mode: "stopping",
      protocol: "socks5",
      port: 1080,
      running: false,
    });
    expect(plane.address).toContain(`:${port}`);
  });

  it("走的是**服务进程那一份**配置：argv 覆盖的值在 `/api/config` 里原样可见", async () => {
    // 这条锁的是「同进程里只允许一份配置快照」这条纪律。控制面若自己再 `loadConfig` 一次且
    // argv 传空，`--auth-users-file` 这类 CLI 覆盖就只改到数据面，控制面看到的还是缺省 ——
    // 而那正是「代理跑的是 A、这边改的是 B」这条事故。
    const usersFile = path.join(dir, "cli-users.json");
    const control = await startControlPlane({
      context: await loadConfig({
        env: {
          NODE_ENV: "development",
          MANAGER_ENABLED: "true",
          MANAGER_TOKEN: TOKEN,
          MANAGER_HOST: "127.0.0.1",
          MANAGER_PORT: String(await freePort()),
        },
        envFiles: [path.join(dir, ".env.development")],
        argv: [`--auth-users-file=${usersFile}`],
        cwd: dir,
      }),
      logger,
      processFacts: {
        pid: 1,
        startedAt: 0,
        node: process.version,
        platform: process.platform,
        cwd: dir,
      },
      dataPlane: () => facts(),
    });
    const plane = control as ControlPlane;
    expect(plane).toBeTruthy();
    opened.push(plane);

    const reply = await call(portOf(plane), "/api/config", TOKEN);
    const byKey = new Map(
      (reply.json?.keys as Array<Record<string, unknown>>).map((k) => [String(k.key), k]),
    );
    expect(byKey.get("authUsersFile")?.value).toBe(usersFile);
    expect(byKey.get("authUsersFile")?.fromArgv).toBe(true);
  });
});

describe("startControlPlane — 起不来时必须抛", () => {
  it("端口被占 ⇒ 抛错，且文案含修法（不是裸的 EADDRINUSE）", async () => {
    const port = await freePort();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(port, "127.0.0.1", () => resolve());
    });
    try {
      let thrown: unknown;
      try {
        await startControlPlane({
          context: await contextWith({
            MANAGER_ENABLED: "true",
            MANAGER_TOKEN: TOKEN,
            MANAGER_HOST: "127.0.0.1",
            MANAGER_PORT: String(port),
          }),
          logger,
          processFacts: {
            pid: 1,
            startedAt: 0,
            node: process.version,
            platform: process.platform,
            cwd: dir,
          },
          dataPlane: () => facts(),
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, "端口被占时必须抛错（静默继续 = 运维以为控制面开着）").toBeInstanceOf(Error);
      expect(String((thrown as Error).message)).toContain(`端口 ${port} 已被占用`);
      expect(String((thrown as Error).message)).toContain(`MANAGER_PORT=${port + 1}`);
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });
    }
  });

  it("空 token ⇒ 抛错（启动期那道闸门被移除时的兜底：宁可控制面不可用，也不开着大门）", async () => {
    // 用 `createConfigContext` 绕过 `loadConfig` 的 fail-closed，模拟「闸门被移除」那个世界
    const { ConfigStore, configAccessorFromStore, createConfigContext } =
      await import("@/config/index.js");
    const store = new ConfigStore();
    store.set("managerEnabled", true);
    store.set("managerPort", 0);
    const context = createConfigContext({ store, configDir: dir });
    expect(configAccessorFromStore(store).get("managerEnabled")).toBe(true);
    await expect(
      startControlPlane({
        context,
        logger,
        processFacts: {
          pid: 1,
          startedAt: 0,
          node: process.version,
          platform: process.platform,
          cwd: dir,
        },
        dataPlane: () => facts(),
      }),
    ).rejects.toThrow(/MANAGER_TOKEN/);
  });
});
