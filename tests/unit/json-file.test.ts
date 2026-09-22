import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonCached } from "@/utils/json-file.js";
import { Logger } from "@/utils/logger.js";

/** 被测值类型：一个简单对象，便于构造「结构不符」 */
interface Sample {
  n: number;
}

/** 校验器：仅当 raw 为非数组对象且 n 为 number 时通过 */
function validateSample(raw: unknown): Sample | undefined {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const n = (raw as { n?: unknown }).n;
    if (typeof n === "number") {
      return { n };
    }
  }
  return undefined;
}

const FALLBACK: Sample = { n: -1 };

/**
 * 拦截 logger：本文件刻意制造坏配置，`warn`/`info` 本身就是被测行为的一部分。
 * prototype 级 spy 同时做到三件事：不刷控制台、**不写进仓库的 log/ 目录**（否则测试日志会混进真实运行日志，
 * 且仓库 log/ 被 .gitignore 忽略，混进去很难察觉），并让「错误去重 / 恢复给 info」可以直接断言。
 */
const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
const info = vi.spyOn(Logger.prototype, "info").mockImplementation(() => {});

/** 每个文件独立临时目录，避免命中其它用例/其它进程的节流缓存 */
let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-test-"));
});

beforeEach(() => {
  warn.mockClear();
  info.mockClear();
});

afterAll(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const opts = { label: "测试配置文件", fallback: FALLBACK };

describe("utils/json-file readJsonCached", () => {
  it("文件缺失 → 返回 fallback 且 exists=false、无 error", () => {
    const r = readJsonCached(path.join(dir, "missing.json"), validateSample, opts);
    expect(r.exists).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual(FALLBACK);
  });

  it("目录路径（非普通文件）按缺失处理", () => {
    const r = readJsonCached(dir, validateSample, opts);
    expect(r.exists).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual(FALLBACK);
  });

  it("合法内容 → 解析值正确、无 error", () => {
    const p = path.join(dir, "ok.json");
    fs.writeFileSync(p, JSON.stringify({ n: 7 }));
    const r = readJsonCached(p, validateSample, opts);
    expect(r.exists).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual({ n: 7 });
  });

  it("非法 JSON → 保留上一份有效值并给出 error（force 强制重读）", () => {
    const p = path.join(dir, "bad-json.json");
    fs.writeFileSync(p, JSON.stringify({ n: 5 }));
    expect(readJsonCached(p, validateSample, opts).value).toEqual({ n: 5 });

    fs.writeFileSync(p, "{ 这不是合法 JSON");
    const r = readJsonCached(p, validateSample, { ...opts, force: true });
    expect(r.exists).toBe(true);
    expect(r.error).toBeTruthy();
    expect(r.value).toEqual({ n: 5 });
    // 坏内容必须留下一条 warn（含配置名与路径），否则线上无法察觉配置被拒绝
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("测试配置文件");
    expect(line).toContain(p);
    expect(line).toContain("沿用上一份有效配置");
  });

  it("坏文件持续期间只 warn 一次（去重），恢复后给一条 info", () => {
    const p = path.join(dir, "dedup.json");
    fs.writeFileSync(p, JSON.stringify({ n: 1 }));
    readJsonCached(p, validateSample, opts);
    expect(warn).not.toHaveBeenCalled();

    fs.writeFileSync(p, "{ 坏内容");
    readJsonCached(p, validateSample, { ...opts, force: true });
    expect(warn).toHaveBeenCalledTimes(1);
    // 再次强制重读：错误未变化 → 不刷屏
    readJsonCached(p, validateSample, { ...opts, force: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();

    fs.writeFileSync(p, JSON.stringify({ n: 2 }));
    const r = readJsonCached(p, validateSample, { ...opts, force: true });
    expect(r.value).toEqual({ n: 2 });
    expect(r.error).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain("已恢复");
  });

  it("结构不符（校验不过）→ 同样保留上一份有效值并给出 error", () => {
    const p = path.join(dir, "bad-shape.json");
    fs.writeFileSync(p, JSON.stringify({ n: 3 }));
    expect(readJsonCached(p, validateSample, opts).value).toEqual({ n: 3 });

    fs.writeFileSync(p, JSON.stringify({ n: "3" }));
    const r = readJsonCached(p, validateSample, { ...opts, force: true });
    expect(r.error).toBeTruthy();
    expect(r.value).toEqual({ n: 3 });
  });

  it("文件变更后用 force 重读拿到新值（不依赖真实时间）", () => {
    const p = path.join(dir, "change.json");
    fs.writeFileSync(p, JSON.stringify({ n: 1 }));
    expect(readJsonCached(p, validateSample, opts).value).toEqual({ n: 1 });

    // 变更必须让 size 也不同：Windows 同 ms 内的两次写入可能拿到相同 mtime+size，
    // 只改数字位（等长内容）会被「mtime/size 未变 → 复用缓存」误判为未变更
    fs.writeFileSync(p, JSON.stringify({ n: 22 }));
    expect(readJsonCached(p, validateSample, { ...opts, force: true }).value).toEqual({ n: 22 });
  });

  it("节流：窗口内返回缓存，越过 maxAgeMs 后自动重读（fake timers 控制时钟）", () => {
    vi.useFakeTimers();
    try {
      const p = path.join(dir, "throttle.json");
      fs.writeFileSync(p, JSON.stringify({ n: 1 }));
      expect(readJsonCached(p, validateSample, opts).value).toEqual({ n: 1 });

      // 内容已变但未过节流 → 仍是缓存旧值
      fs.writeFileSync(p, JSON.stringify({ n: 2 }));
      expect(readJsonCached(p, validateSample, opts).value).toEqual({ n: 1 });

      // 越过默认 1000ms 节流窗口 → 重新读取
      vi.advanceTimersByTime(1500);
      expect(readJsonCached(p, validateSample, opts).value).toEqual({ n: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("超过 maxBytes → 给出 error 且不采用该内容", () => {
    const p = path.join(dir, "big.json");
    fs.writeFileSync(p, JSON.stringify({ n: 1, pad: "x".repeat(128) }));
    const r = readJsonCached(p, validateSample, { ...opts, maxBytes: 16 });
    expect(r.error).toBeTruthy();
    expect(r.error).toContain("上限");
    expect(r.value).toEqual(FALLBACK);
  });
});
