import { describe, expect, it, vi } from "vitest";
import { BaseProxy } from "@/core/base.js";
import type { ProxyOptions } from "@/core/types.js";
import { Auth } from "@/core/auth.js";

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
  async tryAuthorize(ctx: Parameters<BaseProxy["authorize"]>[0]): Promise<boolean> {
    return (this as unknown as { authorize(ctx: unknown): Promise<boolean> }).authorize(ctx);
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
    const throwing = { authenticate: async () => { throw new Error("auth down"); } };
    const p = new DummyProxy({}, throwing as unknown as Auth);
    const ok = await p.tryAuthorize({} as never);
    expect(ok).toBe(false);
  });

  it("onStarted 钩子可被覆盖", async () => {
    const p = new DummyProxy();
    const spy = vi.spyOn(p, "onStarted");
    await p.start();
    expect(spy).toHaveBeenCalledOnce();
    await p.stop();
  });
});
