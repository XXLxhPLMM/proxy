/**
 * `GET /api/status`：本进程事实 + 数据面活状态 + 数据源事实
 *
 * @description
 * 本档盯「数据面状态是**现读的真值**而不是推断」：改 `dataPlane.value` 后紧跟着的那次请求就看到新值，
 * 而「本进程还没有数据面」（组合根尚未装配完成）必须报 `mode:"inactive"` + 端口 null +
 * `running:false`（不许谎报在监听）。
 * `dataPlane` 是共用 fixture 的那个可变旋钮；主题级不变量见 `./AGENTS.md`。
 * @module tests/unit/manager/http
 */
import { describe, expect, it } from "vitest";
import { call, dataPlane, dir, port } from "./_manager-http.js";

describe("GET /api/status", () => {
  it("给出本进程事实 + 数据面活状态 + 数据源事实", async () => {
    const reply = await call(port, { path: "/api/status" });
    expect(reply.status).toBe(200);
    const body = reply.json as {
      process: Record<string, unknown>;
      proxy: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(body.process.pid).toBe(999);
    expect(body.process.cwd).toBe(dir);
    expect(body.proxy).toMatchObject({
      mode: "running",
      protocol: "http",
      host: "0.0.0.0",
      port: 3000,
      running: true,
    });
    expect(body.data.configDir).toBe(dir);
  });

  it("数据面状态是**现读**的（改判据后紧跟着的那次请求就看到新值）", async () => {
    const restore = dataPlane.value;
    dataPlane.value = {
      mode: "stopping",
      protocol: "socks5",
      host: "127.0.0.1",
      port: 1080,
      running: false,
      startedAt: null,
      uptimeMs: null,
    };
    try {
      const body = (await call(port, { path: "/api/status" })).json as {
        proxy: Record<string, unknown>;
      };
      expect(body.proxy.mode).toBe("stopping");
      expect(body.proxy.running).toBe(false);
    } finally {
      dataPlane.value = restore;
    }
  });

  it("没有数据面：mode=inactive 且端口 null、running 恒 false（不谎报端口在监听）", async () => {
    const restore = dataPlane.value;
    dataPlane.value = {
      mode: "inactive",
      protocol: null,
      host: null,
      port: null,
      running: false,
      startedAt: null,
      uptimeMs: null,
    };
    try {
      const body = (await call(port, { path: "/api/status" })).json as {
        proxy: Record<string, unknown>;
      };
      expect(body.proxy.mode).toBe("inactive");
      expect(body.proxy.running).toBe(false);
      expect(body.proxy.port).toBeNull();
    } finally {
      dataPlane.value = restore;
    }
  });

  it("必须带上「inactive 时本进程还没有数据面」那句限定", async () => {
    const reply = await call(port, { path: "/api/status" });
    const body = reply.json as { runningMeans: string };
    expect(body.runningMeans).toContain("inactive");
  });
});
