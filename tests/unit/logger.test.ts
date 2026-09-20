import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Logger } from "@/utils/logger.js";

const tmpDirs: string[] = [];

/** 独立临时目录当落盘基址：无扩展名 -> toHourlyFile 在目录内生成小时文件 */
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** 读取目录内已落地的小时日志内容；未落盘返回 undefined */
function readPersisted(dir: string): string | undefined {
  const [file] = fs.readdirSync(dir);
  if (file === undefined) {
    return undefined;
  }
  return fs.readFileSync(path.join(dir, file), "utf8");
}

describe("utils/logger 控制台/落盘双通道分级", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("控制台 error + 落盘 debug：debug 只进文件不进终端", async () => {
    const dir = tmpDir();
    const log = new Logger({
      prefix: "[t]",
      level: "error",
      fileLevel: "debug",
      file: dir,
      color: false,
    });
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    log.debug("file-only-line");
    expect(spy).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(readPersisted(dir)).toContain("file-only-line");
    });
  });

  it("控制台 silent + 落盘 info：终端静音，info 仍落盘", async () => {
    const dir = tmpDir();
    const log = new Logger({
      prefix: "[t]",
      level: "silent",
      fileLevel: "info",
      file: dir,
      color: false,
    });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    log.info("quiet-console-line");
    expect(spy).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(readPersisted(dir)).toContain("quiet-console-line");
    });
  });

  it("控制台 debug + 落盘 silent：debug 只进终端不落盘", async () => {
    const dir = tmpDir();
    const log = new Logger({
      prefix: "[t]",
      level: "debug",
      fileLevel: "silent",
      file: dir,
      color: false,
    });
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    log.debug("console-only-line");
    expect(spy).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(readPersisted(dir)).toBeUndefined();
  });

  it("child 继承父级双通道等级", async () => {
    const dir = tmpDir();
    const parent = new Logger({
      prefix: "[p]",
      level: "error",
      fileLevel: "debug",
      file: dir,
      color: false,
    });
    const child = parent.child("c");
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    child.debug("child-file-only");
    expect(spy).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(readPersisted(dir)).toContain("child-file-only");
    });
  });

  it("setLevel / setFileLevel 可运行时分别覆写", async () => {
    const dir = tmpDir();
    const log = new Logger({
      prefix: "[t]",
      level: "silent",
      fileLevel: "silent",
      file: dir,
      color: false,
    });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    log.setLevel("warn");
    log.setFileLevel("warn");
    log.warn("toggled-line");
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(readPersisted(dir)).toContain("toggled-line");
    });
  });

  it("不可序列化参数（循环引用/BigInt/Symbol/函数）落盘不抛", async () => {
    const dir = tmpDir();
    const log = new Logger({
      prefix: "[t]",
      level: "silent",
      fileLevel: "info",
      file: dir,
      color: false,
    });
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => log.info("marker", circular, BigInt(10), Symbol("s"), () => 0)).not.toThrow();
    await vi.waitFor(() => {
      expect(readPersisted(dir)).toContain("marker");
    });
  });

  it("控制台通道遇不可序列化参数也不抛", () => {
    const dir = tmpDir();
    const log = new Logger({
      prefix: "[t]",
      level: "info",
      fileLevel: "silent",
      file: dir,
      color: false,
    });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log.info(circular, BigInt(10), Symbol("s"), () => 0)).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("persist 落盘路径非法（父级为文件）整体兜底不抛", async () => {
    const base = tmpDir();
    const blocker = path.join(base, "blocker");
    fs.writeFileSync(blocker, "x");
    const log = new Logger({
      prefix: "[t]",
      level: "silent",
      fileLevel: "info",
      file: path.join(blocker, "sub"),
      color: false,
    });
    expect(() => log.info("boom-line")).not.toThrow();
    // 给异步 appendFile 的 reject 留一拍，确认未冒泡为 unhandledRejection
    await new Promise((r) => setTimeout(r, 50));
  });
});
