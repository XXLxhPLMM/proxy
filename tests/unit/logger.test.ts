import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configAccessorFromStore } from "@/config/index.js";
import { ConfigStore } from "@/config/index.js";
import { createLogger, LoggerImpl, type Logger } from "@/utils/logger/index.js";

const tmpDirs: string[] = [];

/** 独立临时目录当落盘基址：无扩展名 -> toHourlyFile 在目录内生成小时文件 */
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** 目录内已落地的小时日志原始文本；未落盘返回 undefined */
function readPersistedRaw(dir: string): string | undefined {
  const [file] = fs.readdirSync(dir);
  if (file === undefined) {
    return undefined;
  }
  return fs.readFileSync(path.join(dir, file), "utf8");
}

/** 目录内第一个落盘文件名；未落盘返回 undefined */
function persistedFileName(dir: string): string | undefined {
  return fs.readdirSync(dir)[0];
}

/** 解析 JSONL 文本为对象数组（空行跳过） */
function parseLines(raw: string): Record<string, unknown>[] {
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 读取并解析目录内的小时文件（未落盘返回空数组） */
function readPersistedJson(dir: string): Record<string, unknown>[] {
  const raw = readPersistedRaw(dir);
  return raw === undefined ? [] : parseLines(raw);
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
