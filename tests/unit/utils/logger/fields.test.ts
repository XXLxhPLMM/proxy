/**
 * `utils/logger` 的**结构化字段**：末位 plain object 才算 fields、五个保留键优先、控制台以 `k=v`
 * 追加而落盘把 fields 合并进记录、`infoSync` 走同一套渲染。
 * ⚠️ **只认最后一个参数**：`log.info({ a: 1 }, "tail")` 那个 object 落在非末位，于是它进 `msg`
 * 而不被当成 fields 吞掉 —— 刻意的形态约束，不是「尽量识别」。保留键优先与两条渲染管线的分工
 * 与「落盘键集唯一」在 `./AGENTS.md`。
 * @module tests/unit/utils/logger
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { LoggerImpl } from "@/utils/logger/index.js";
import { readPersistedJson, readPersistedRaw, tmpDir, tmpDirs } from "./_logger.js";

describe("utils/logger 结构化字段", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("末位 plain object 视为 fields：自定义字段与保留键共存", async () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
      prefix: "[t]",
      level: "silent",
      fileLevel: "info",
      file: dir,
      color: false,
    });
    log.info("hello", { custom: "v", n: 1, nested: { a: 1 } });
    await vi.waitFor(() => {
      expect(readPersistedRaw(dir)).toContain("hello");
    });
    const [rec] = readPersistedJson(dir);
    expect(rec.custom).toBe("v");
    expect(rec.n).toBe(1);
    expect(rec.nested).toEqual({ a: 1 });
    // msg 只含非字段参数
    expect(rec.msg).toBe("hello");
    expect(rec.level).toBe("info");
    expect(rec.prefix).toBe("[t]");
  });

  it("保留键优先：同名字段被 ts/level/pid/prefix/msg 覆盖", async () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
      prefix: "[t]",
      level: "silent",
      fileLevel: "info",
      file: dir,
      color: false,
    });
    log.info("x", { ts: "fake", level: "fake", pid: -1, prefix: "fake", msg: "fake", keep: 1 });
    await vi.waitFor(() => {
      expect(readPersistedRaw(dir)).toContain("x");
    });
    const [rec] = readPersistedJson(dir);
    expect(rec.ts).not.toBe("fake");
    expect(Number.isNaN(Date.parse(rec.ts as string))).toBe(false);
    expect(rec.level).toBe("info");
    expect(rec.pid).toBe(process.pid);
    expect(rec.prefix).toBe("[t]");
    expect(rec.msg).toBe("x");
    expect(rec.keep).toBe(1);
  });

  it("落盘时 undefined 字段被 JSON 省略、null 保留", async () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
      prefix: "[t]",
      level: "silent",
      fileLevel: "info",
      file: dir,
      color: false,
    });
    log.info("m", { a: undefined, b: null });
    await vi.waitFor(() => {
      expect(readPersistedRaw(dir)).toContain("m");
    });
    const [rec] = readPersistedJson(dir);
    expect("a" in rec).toBe(false);
    expect(rec.b).toBeNull();
  });

  it("仅识别最后一个参数：非末位 plain object 仍进 msg", async () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
      prefix: "[t]",
      level: "silent",
      fileLevel: "info",
      file: dir,
      color: false,
    });
    log.info({ a: 1 }, "tail");
    await vi.waitFor(() => {
      expect(readPersistedRaw(dir)).toContain("tail");
    });
    const [rec] = readPersistedJson(dir);
    expect(rec.msg).toBe('{"a":1} tail');
    expect("a" in rec).toBe(false);
  });

  it("非 plain object（Error/Array/Date/Map/Buffer/类实例）不作为 fields", () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
      prefix: "[t]",
      level: "info",
      fileLevel: "silent",
      file: dir,
      color: false,
    });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    class Box {
      v = 1;
    }
    const candidates: unknown[] = [
      new Error("boom"),
      [1, 2],
      new Date(0),
      new Map(),
      Buffer.from("x"),
      new Box(),
    ];
    for (const v of candidates) {
      spy.mockClear();
      log.info("m", v);
      // header + msg + 原样参数（未被当作 fields 吞掉，故无字段渲染切片）
      expect(spy.mock.calls[0]).toHaveLength(3);
      expect(spy.mock.calls[0][2]).toBe(v);
    }
  });

  it("控制台 fields 以 k=v 追加：undefined/null 跳过，对象/数组 JSON 化", () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
      prefix: "[t]",
      level: "info",
      fileLevel: "silent",
      file: dir,
      color: false,
    });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    log.info("hello", {
      n: 42,
      ok: true,
      s: "x\ny",
      skip: undefined,
      nul: null,
      nested: { a: 1 },
      arr: [1, 2],
    });
    const [header, msg, rendered] = spy.mock.calls[0];
    expect(msg).toBe("hello");
    expect(String(header)).toContain("[t]");
    // string 净化、number/boolean 直出、对象/数组 JSON、undefined/null 跳过
    expect(String(rendered)).toBe('n=42 ok=true s=x\\ny nested={"a":1} arr=[1,2]');
    expect(String(rendered)).not.toContain("skip");
    expect(String(rendered)).not.toContain("nul");
  });

  it("控制台字段中的 Error 渲染为可读文本而非 {}", () => {
    const dir = tmpDir();
    const log = new LoggerImpl({
      prefix: "[t]",
      level: "info",
      fileLevel: "silent",
      file: dir,
      color: false,
    });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    log.info("m", { err: new Error("boom") });
    const rendered = String(spy.mock.calls[0][2]);
    expect(rendered).toContain("err=Error: boom");
    expect(rendered).not.toContain("{}");
  });

  it("infoSync 按新控制台渲染并识别结构化字段", () => {
    const log = new LoggerImpl({
      prefix: "[t]",
      level: "info",
      fileLevel: "silent",
      file: undefined,
      color: false,
    });
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    log.infoSync("sync-line", { k: 1, skip: undefined });
    expect(spy).toHaveBeenCalledTimes(1);
    const out = String(spy.mock.calls[0][0]);
    expect(out).toContain("sync-line");
    expect(out).toContain("k=1");
    expect(out).not.toContain("skip");
  });
});