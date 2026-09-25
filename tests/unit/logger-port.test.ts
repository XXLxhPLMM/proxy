import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsoleLogger, createNoopLogger, globalLogger, logger } from "@/utils/logger.js";
import type { Logger } from "@/utils/logger.js";

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

  it("全局单例可赋值给最小 Logger 端口，独立替身也可实现该端口", () => {
    const port: Logger = globalLogger;
    const injected: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };

    expect(port).toBe(logger);
    expect(injected.info("injected")).toBeUndefined();
  });
});
