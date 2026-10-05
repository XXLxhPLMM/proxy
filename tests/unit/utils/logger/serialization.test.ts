/**
 * `utils/logger` 的**序列化与落盘键集**：控制字符转义、单条日志恒为单行、`flush` 等齐在途落盘、
 * `file` / `both` / `notice` 三个方法各自的门控语义、四条通道落盘键集逐字相同。
 * ⚠️ **本档必须自带 `afterEach`**：`vi.spyOn(console, "info")` 连续几格都装在同一个控制台通道上，
 * 不 `restoreAllMocks` 的话后一格拿到的是**上一格累计过的**同一个 spy，
 * 「`expect(spy).not.toHaveBeenCalled()`」立刻红 —— 那是档内串扰，不是被测行为。
 * @module tests/unit/utils/logger
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LoggerImpl } from "@/utils/logger/index.js";
import { parseLines, readPersistedJson, readPersistedRaw, tmpDir, tmpDirs } from "./_logger.js";

describe("utils/logger 控制台/落盘双通道分级：序列化与落盘键集", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("控制字符转义：JSONL 中 msg 为可见转义文本且单条日志恒为单行", async () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
      prefix: "[t]",
      level: "info",
      fileLevel: "info",
      file: dir,
      color: false,
    });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    log.info("host", "evil\r\nINFO forged", "\x1b[31mred");
    const consoleText = spy.mock.calls[0].join(" ");
    expect(consoleText).toContain("evil\\r\\nINFO forged");
    expect(consoleText).not.toContain("\x1b[31mred");
    await vi.waitFor(() => {
      const raw = readPersistedRaw(dir) ?? "";
      // 伪造的 INFO 不构成独立行：整条日志仅一行 JSON
      expect(raw.split("\n").filter((line) => line !== "")).toHaveLength(1);
      expect(raw.includes("\u001b")).toBe(false);
      const [rec] = parseLines(raw);
      // 解析 JSON 后是可见的转义文本（\\r\\n），而非真实控制字符
      expect(String(rec.msg)).toContain("evil\\r\\nINFO forged");
      expect(String(rec.msg)).not.toContain("\x1b[31mred");
    });
  });

  it("persist 落盘路径非法（父级为文件）整体兜底不抛", async () => {
    const base = tmpDir();
    const blocker = path.join(base, "blocker");
    fs.writeFileSync(blocker, "x");
    const log = new LoggerImpl({
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

  it("flush 等齐在途落盘：无需轮询即可断言，且模块级集合覆盖 child 实例", async () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
      prefix: "[t]",
      level: "silent",
      fileLevel: "info",
      file: dir,
      color: false,
    });
    // child 走自己的 persist，但登记进共享集合：父实例 flush 也必须等到它
    log.child("c").info("flushed-line");
    await log.flush();
    const [rec] = readPersistedJson(dir);
    expect(rec.msg).toBe("flushed-line");
    expect(rec.prefix).toBe("[t]:c");
  });

  it("file 只入盘不输出控制台，且不受 fileLevel 门控", async () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
      prefix: "[t]",
      level: "silent",
      fileLevel: "silent",
      file: dir,
      color: false,
    });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    log.file("warn", "audit-line");
    expect(spy).not.toHaveBeenCalled();
    await log.flush();
    const [rec] = readPersistedJson(dir);
    expect(rec.msg).toBe("audit-line");
    expect(rec.level).toBe("warn");
  });

  it("both 双通道且不受双门控：门控内的 info 静默，both 照常输出并落盘", async () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
      prefix: "[t]",
      level: "silent",
      fileLevel: "silent",
      file: dir,
      color: false,
    });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    log.info("gated-out", { k: 0 });
    log.both("info", "forced-line", { k: "v" });
    expect(spy).toHaveBeenCalledTimes(1);
    const [header, msg, rendered] = spy.mock.calls[0];
    expect(String(header)).toContain("INFO");
    expect(String(header)).toContain("[t]");
    expect(msg).toBe("forced-line");
    expect(String(rendered)).toBe("k=v");
    await log.flush();
    const recs = readPersistedJson(dir);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ level: "info", prefix: "[t]", msg: "forced-line", k: "v" });
    expect(recs[0].pid).toBe(process.pid);
    expect(typeof recs[0].ts).toBe("string");
  });

  it("both/file 与 info 的落盘键集完全一致（同一 plain 管线）", async () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
      prefix: "[t]",
      level: "silent",
      fileLevel: "info",
      file: dir,
      color: false,
    });
    vi.spyOn(console, "info").mockImplementation(() => {});
    log.info("normal", { extra: 1 });
    log.file("warn", "file-only", { extra: 2 });
    log.both("error", "both-line", { extra: 3 });
    log.notice("info", "notice-line", { extra: 4 });
    await log.flush();
    const recs = readPersistedJson(dir);
    expect(recs).toHaveLength(4);
    // 三条记录键集逐字相同：fields 合并 + ts/level/pid/prefix/msg 保留键
    const keySets = recs.map((r) => Object.keys(r).sort().join(","));
    expect(new Set(keySets).size).toBe(1);
    expect(Object.keys(recs[0]).sort()).toEqual(["extra", "level", "msg", "pid", "prefix", "ts"]);
  });

  it("notice 控制台必达（silent 硬关闭除外），落盘按 fileLevel 门控", async () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
      prefix: "[t]",
      level: "error",
      fileLevel: "silent",
      file: dir,
      color: false,
    });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    log.info("gated-out");
    log.notice("info", "notice-line");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain("INFO");
    expect(spy.mock.calls[0][1]).toBe("notice-line");
    await log.flush();
    // fileLevel=silent：通知不强行落盘（与 both 的差别所在）
    expect(readPersistedRaw(dir)).toBeUndefined();

    log.setLevel("silent");
    log.notice("info", "hidden-line");
    // silent 是硬关闭：连通知也不输出
    expect(spy).toHaveBeenCalledTimes(1);
  });
});