import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { BaseProxy } from "@/core/server/base.js";
import { HttpProxy } from "@/core/server/http.js";
import type { AuthResult, ProxyOptions } from "@/core/types/proxy.js";
import { Auth } from "@/core/auth.js";
import { get, set, ConfigStore } from "@/config/store.js";
import { configAccessorFromStore, globalConfigAccessor } from "@/core/config-access.js";
import { getFreePort } from "../helpers/net.js";

/** 最小可运行子类：doStart/doStop 仅翻标记 */
class DummyProxy extends BaseProxy {
  started = false;
  failNextStart = false;

  constructor(options: ProxyOptions = {}, auth = new Auth({ enabled: false })) {
    super("http", { ...options, auth });
  }

  protected async doStart(): Promise<void> {
    if (this.failNextStart) throw new Error("boom");
    this.started = true;
  }

  protected async doStop(): Promise<void> {
    this.started = false;
  }

  isRunning(): boolean {
    return this.started;
  }

  /** 暴露 authorize 供异常兜底测试 */
  async tryAuthorize(ctx: Parameters<BaseProxy["authorize"]>[0]): Promise<AuthResult> {
    return (this as unknown as { authorize(ctx: unknown): Promise<AuthResult> }).authorize(ctx);
  }
}

/**
 * 可控延迟子类：doStart 挂在 gate 上并真实 listen，
 * 用于模拟「start 在途（starting 态）」时调用 stop 的并发场景。
 * stop 若未串行等待，停完后 start 会继续建服并把状态改回 running（旧行为）。
 */
class SlowStartProxy extends BaseProxy {
  /** 基类已声明 protected server（默认 isRunning 读它），此处只能以同可见性覆盖 */
  protected server: net.Server | null = null;
  private readonly port: number;
  private readonly gate: Promise<void>;
  private releaseGate!: () => void;
  /** doStart 已进入并挂在 gate 上（对外信号） */
  readonly reachedGate: Promise<void>;
  private signalReached!: () => void;

  constructor(port: number) {
    super("http", { host: "127.0.0.1", port, auth: new Auth({ enabled: false }) });
    this.port = port;
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
    this.reachedGate = new Promise<void>((resolve) => {
      this.signalReached = resolve;
    });
  }

  /** 放行 doStart，让建服继续 */
  release(): void {
    this.releaseGate();
  }

  protected async doStart(): Promise<void> {
    this.signalReached();
    await this.gate;
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(this.port, "127.0.0.1", resolve));
    this.server = server;
  }

  protected async doStop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }

  isRunning(): boolean {
    return !!this.server?.listening;
  }
}

describe("core/BaseProxy lifecycle", () => {
  it("idle -> running -> stopped 流转并触发 stateChange", async () => {
    const p = new DummyProxy();
    const states: string[] = [];
    p.on("stateChange", (next: string) => states.push(next));
    expect(p.state).toBe("idle");
    await p.start();
    expect(p.state).toBe("running");
    expect(p.getStats().running).toBe(true);
    await p.stop();
    expect(p.state).toBe("stopped");
    expect(states).toEqual(["starting", "running", "stopping", "stopped"]);
  });

  it("start/stop 幂等，重复调用直接返回", async () => {
    const p = new DummyProxy();
    await p.start();
    await p.start();
    expect(p.state).toBe("running");
    await p.stop();
    await p.stop();
    expect(p.state).toBe("stopped");
    // stopped 后可重入 starting
    await p.start();
    expect(p.state).toBe("running");
    await p.stop();
  });

  it("doStart 抛错进入 error 态", async () => {
    const p = new DummyProxy();
    p.failNextStart = true;
    await expect(p.start()).rejects.toThrow("boom");
    expect(p.state).toBe("error");
  });

  it("authorize 异常兜底为 false（鉴权击穿防护）", async () => {
    const throwing = {
      authenticate: async () => {
        throw new Error("auth down");
      },
    };
    const p = new DummyProxy({}, throwing as unknown as Auth);
    const ok = await p.tryAuthorize({} as never);
    expect(ok.passed).toBe(false);
  });

  it("onStarted 钩子可被覆盖", async () => {
    const p = new DummyProxy();
    const spy = vi.spyOn(p, "onStarted");
    await p.start();
    expect(spy).toHaveBeenCalledOnce();
    await p.stop();
  });

  it("start 在途时调用 stop：等待启动落地并最终停在 stopped（无残留监听）", async () => {
    const port = await getFreePort();
    const p = new SlowStartProxy(port);

    const starting = p.start();
    // 等 start 进入 doStart 并挂起，此时状态为 starting
    await p.reachedGate;
    expect(p.state).toBe("starting");

    // stop 应串行等待在途 start，而不是抢先置 stopped
    const stopping = p.stop();
    p.release();

    await stopping;
    await starting;

    expect(p.state).toBe("stopped");
    expect(p.isRunning()).toBe(false);

    // 端口可再次绑定 => 无残留监听（旧行为会把套接字泄漏在 listening）
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(port, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  });

  it("存在 idle keep-alive 连接时 stop() 仍能在 3s 内 resolve", async () => {
    const port = await getFreePort();
    // AGENTS.md 写法：先 set host/port/proxyMode 再 new HttpProxy
    set("host", "127.0.0.1");
    set("port", port);
    set("proxyMode", "server");
    set("logLevel", "silent");

    const proxy = new HttpProxy({
      host: "127.0.0.1",
      port,
      auth: new Auth({ enabled: false }),
    });
    await proxy.start();

    // 保持一条 idle keep-alive 连接（不发请求），旧实现会让 server.close 回调永不触发
    const socket = net.connect({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });

    try {
      const stopped = proxy.stop().then(() => "stopped" as const);
      const timedOut = new Promise<"timeout">((resolve) => {
        const t = setTimeout(() => resolve("timeout"), 3000);
        t.unref();
      });
      await expect(Promise.race([stopped, timedOut])).resolves.toBe("stopped");
      expect(proxy.isRunning()).toBe(false);
    } finally {
      socket.destroy();
    }
  });
});

// ── ConfigAccessor 归一化护栏 ──
// 追加于既有断言之后，不改动任何原有断言：BaseProxy 构造期把
// `options.config ?? globalConfigAccessor` 归一进 `Required<ProxyOptions>`，
// 使 core 内部（转发器/鉴权/名单）可以无条件透传、无需判空；
// 缺省即全局单例 ⇒ 未注入的老调用方行为与改造前逐字一致。
describe("BaseProxy 配置访问器归一化", () => {
  it("缺省即 globalConfigAccessor，显式注入则原样保留", () => {
    const dflt = new DummyProxy();
    expect(dflt.options.config).toBe(globalConfigAccessor);

    const store = new ConfigStore({ port: 41002, proxyMode: "client" });
    const accessor = configAccessorFromStore(store);
    const injected = new DummyProxy({ config: accessor });
    expect(injected.options.config).toBe(accessor);
    expect(injected.options.config.get("port")).toBe(41002);
    // 显式注入不影响既有归一化项（port/host 等仍按老逻辑兜底）
    expect(injected.options.port).toBe(3000);
    expect(injected.options.host).toBe("0.0.0.0");
  });

  it("注入的访问器不污染全局单例", () => {
    const before = get("proxyMode");
    new DummyProxy({ config: configAccessorFromStore(new ConfigStore({ proxyMode: "client" })) });
    expect(get("proxyMode")).toBe(before);
  });
});
