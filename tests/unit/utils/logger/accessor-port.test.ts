import { afterEach, describe, expect, it, vi } from "vitest";
import { configAccessorFromStore, ConfigStore } from "@/config/index.js";
import { createConsoleLogger, createLogger, createNoopLogger, LoggerImpl } from "@/utils/logger/index.js";
import type { Logger } from "@/utils/logger/index.js";

describe("utils/logger 可注入端口", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("noop logger 四个方法可调用且不写 stdout/stderr", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const noop = createNoopLogger();

    expect(() => {
      noop.debug("debug");
      noop.info("info");
      noop.warn("warn");
      noop.error("error");
    }).not.toThrow();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("noop logger 的 flush 直接 resolve", async () => {
    const noop = createNoopLogger();

    expect(noop.flush).toBeTypeOf("function");
    await expect(noop.flush?.()).resolves.toBeUndefined();
  });

  it("console logger 的 silent level 不输出任何级别", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createConsoleLogger({ level: "silent" });

    log.debug("debug");
    log.info("info");
    log.warn("warn");
    log.error("error");

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("console logger 的 debug level 输出 debug 行到 stdout", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const log = createConsoleLogger({ level: "debug" });

    log.debug("debug-line", { source: "port" });

    expect(stdout).toHaveBeenCalledTimes(1);
    expect(String(stdout.mock.calls[0][0])).toContain("DEBUG");
    expect(String(stdout.mock.calls[0][0])).toContain("debug-line");
    expect(String(stdout.mock.calls[0][0])).toContain("source=port");
    expect(stderr).not.toHaveBeenCalled();
  });

  it("显式 logger 与独立替身都可实现最小 Logger 端口", () => {
    const port: Logger = createLogger();
    const injected: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };

    expect(port.warn).toBeTypeOf("function");
    expect(injected.info("injected")).toBeUndefined();
  });
});

describe("utils/logger 显式配置绑定", () => {
  it("只读取注入 accessor，且热改后无需重建 logger", () => {
    const store = new ConfigStore({ logLevel: "silent", logFileLevel: "silent", logFile: "" });
    const log = new LoggerImpl({ config: configAccessorFromStore(store), color: false });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    log.warn("muted");
    expect(warn).not.toHaveBeenCalled();

    store.set("logLevel", "warn");
    log.warn("visible");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("utils/logger 显式实例端口", () => {
  it("createLogger 返回值满足可注入 Logger 端口", () => {
    const port: Logger = createLogger();

    expect(port).toBeTypeOf("object");
    expect(port.warn).toBeTypeOf("function");
  });

  it("不再导出历史类构造别名 Logger（破坏性变更，不留兼容层）", async () => {
    const mod = await import("@/utils/logger/index.js");
    expect("Logger" in mod).toBe(false);
    expect(mod.LoggerImpl).toBeTypeOf("function");
  });
});