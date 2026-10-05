/**
 * `utils/logger` 的**双通道分级**：`level`（控制台）与 `fileLevel`（落盘）两个门控各自独立，
 * `child` 继承、`setLevel` / `setFileLevel` 运行时分别覆写。
 * ⚠️ **落盘基址无扩展名 ⇒ 目录内按小时切片**（`YYYY-MM-DD-HH.jsonl`），所以每一档的落盘断言都必须先有
 * 自己那个 `mkdtemp` 目录 —— 这是四档共用 `_logger.ts` 的全部理由。`file` / `both` / `notice`
 * 三个方法的门控语义与「落盘键集唯一」在 `./AGENTS.md`。
 * @module tests/unit/utils/logger
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { LoggerImpl } from "@/utils/logger/index.js";
import { readPersistedJson, readPersistedRaw, tmpDir, tmpDirs } from "./_logger.js";

/** 目录内第一个落盘文件名；未落盘返回 undefined */
function persistedFileName(dir: string): string | undefined {
  return fs.readdirSync(dir)[0];
}

describe("utils/logger 控制台/落盘双通道分级", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("落盘为 JSONL：文件名 YYYY-MM-DD-HH.jsonl 且每行可 JSON.parse", async () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
      prefix: "[t]",
      level: "silent",
      fileLevel: "info",
      file: dir,
      color: false,
    });
    log.info("hello-jsonl");
    await vi.waitFor(() => {
      expect(readPersistedRaw(dir)).toContain("hello-jsonl");
    });
    // 文件名由 .log 改为 .jsonl，且为小时切片
    expect(persistedFileName(dir)).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}\.jsonl$/);
    const [rec] = readPersistedJson(dir);
    expect(rec.msg).toBe("hello-jsonl");
    expect(rec.level).toBe("info");
    expect(rec.prefix).toBe("[t]");
    expect(rec.pid).toBe(process.pid);
    expect(typeof rec.ts).toBe("string");
    expect(Number.isNaN(Date.parse(rec.ts as string))).toBe(false);
  });

  it("控制台 error + 落盘 debug：debug 只进文件不进终端", async () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
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
      const recs = readPersistedJson(dir);
      expect(recs.some((r) => r.msg === "file-only-line" && r.level === "debug")).toBe(true);
    });
  });

  it("控制台 silent + 落盘 info：终端静音，info 仍落盘", async () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
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
      expect(readPersistedRaw(dir)).toContain("quiet-console-line");
    });
  });

  it("控制台 debug + 落盘 silent：debug 只进终端不落盘", async () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
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
    expect(readPersistedRaw(dir)).toBeUndefined();
  });

  it("child 继承父级双通道等级", async () => {
    const dir = tmpDir();
    const parent = new LoggerImpl({
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
      const recs = readPersistedJson(dir);
      const rec = recs.find((r) => r.msg === "child-file-only");
      expect(rec?.prefix).toBe("[p]:c");
    });
  });

  it("setLevel / setFileLevel 可运行时分别覆写", async () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
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
      const recs = readPersistedJson(dir);
      expect(recs.some((r) => r.msg === "toggled-line" && r.level === "warn")).toBe(true);
    });
  });

  it("不可序列化参数（循环引用/BigInt/Symbol/函数）落盘不抛", async () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
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
      const recs = readPersistedJson(dir);
      expect(recs.some((r) => String(r.msg).includes("marker"))).toBe(true);
    });
  });

  it("Error 参数落盘为可读文本而非 {}（name/message/code 保留且单行）", async () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
      prefix: "[t]",
      level: "silent",
      fileLevel: "info",
      file: dir,
      color: false,
    });
    const err = new Error("connect ECONNREFUSED 1.2.3.4:443") as NodeJS.ErrnoException;
    err.code = "ECONNREFUSED";
    log.error("m", err);
    await vi.waitFor(() => {
      expect(readPersistedRaw(dir)).toContain("ECONNREFUSED");
    });
    const [rec] = readPersistedJson(dir);
    const msg = String(rec.msg);
    expect(msg).toContain(err.message);
    expect(msg).toContain("code=ECONNREFUSED");
    // 旧行为：JSON.stringify(Error) 只剩 {}，502 成因丢失
    expect(msg).not.toContain("{}");
    // stack 首帧里的换行不得漏进 JSONL 行结构：单条日志恒为单行
    const raw = readPersistedRaw(dir) ?? "";
    expect(raw.split("\n").filter((line) => line !== "")).toHaveLength(1);
  });

  it("控制台通道遇不可序列化参数也不抛", () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
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
});