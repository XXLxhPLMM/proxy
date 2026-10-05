/**
 * `readJsonCached` 的**读面**：缺失 vs stat 失败、缓存与观察者隔离、相对路径绝对化。
 * ⚠️ **只有 `ENOENT` / `ENOTDIR` / 非普通文件算 `missing`**，其它 stat 错误（如 `EACCES`）保留上一份
 * 有效值并发 `error` ——「读不到」不是「没配」，判成后者等于让一份读不到的名单**静默变全放行**。
 * 牙齿用 `statSync` 属性访问注入而不是 `chmod`（本仓主战场是 Windows，那里 `chmod` 造不出稳定的
 * `EACCES`）。四态事件的形状与「每档独占一个临时目录」的理由在 `./AGENTS.md`。
 * @module tests/unit/utils/json-file
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readJsonCached, type JsonFileEvent, type JsonFileRead } from "@/utils/json-file/index.js";
import { FALLBACK, dir, events, opts, useSandbox, validateSample, type Sample } from "./_json-file.js";

useSandbox();

describe("utils/json-file readJsonCached：读取与缓存", () => {
  it("文件缺失 → 返回 fallback 且 exists=false、无 error、无事件", () => {
    const r = readJsonCached(path.join(dir, "missing.json"), validateSample, opts);
    expect(r.exists).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual(FALLBACK);
    expect(events).toHaveLength(0);
  });

  it("共享文件缓存不吞掉其它观察者的错误与恢复事件", () => {
    const file = path.join(dir, "multi-observer.json");
    const first: JsonFileEvent[] = [];
    const second: JsonFileEvent[] = [];
    const firstOpts = { ...opts, onEvent: (event: JsonFileEvent) => first.push(event) };
    const secondOpts = { ...opts, onEvent: (event: JsonFileEvent) => second.push(event) };

    fs.writeFileSync(file, JSON.stringify({ n: 1 }));
    readJsonCached(file, validateSample, firstOpts);
    readJsonCached(file, validateSample, secondOpts);

    fs.writeFileSync(file, "broken");
    readJsonCached(file, validateSample, { ...firstOpts, force: true });
    readJsonCached(file, validateSample, { ...secondOpts, force: true });
    expect(first.some((event) => event.type === "error")).toBe(true);
    expect(second.some((event) => event.type === "error")).toBe(true);

    fs.writeFileSync(file, JSON.stringify({ n: 2 }));
    readJsonCached(file, validateSample, { ...firstOpts, force: true });
    readJsonCached(file, validateSample, { ...secondOpts, force: true });
    expect(first.some((event) => event.type === "recovered")).toBe(true);
    expect(second.some((event) => event.type === "recovered")).toBe(true);

    fs.rmSync(file);
    readJsonCached(file, validateSample, { ...firstOpts, force: true });
    readJsonCached(file, validateSample, { ...secondOpts, force: true });
    expect(first.some((event) => event.type === "missing")).toBe(true);
    expect(second.some((event) => event.type === "missing")).toBe(true);
  });

  it("同一路径按配置类别隔离缓存，不让不同 validator 串型", () => {
    const file = path.join(dir, "shared.json");
    fs.writeFileSync(file, JSON.stringify({ n: 1 }));
    const asSample = readJsonCached(file, validateSample, { ...opts, force: true });
    const asAcl = readJsonCached(
      file,
      (raw) => ({ kind: String((raw as { kind?: unknown }).kind) }),
      { label: "acl", fallback: { kind: "empty" }, force: true },
    );

    expect(asSample.value).toEqual({ n: 1 });
    expect(asAcl.value).toEqual({ kind: "undefined" });
  });

  it("目录路径（非普通文件）按缺失处理", () => {
    const r = readJsonCached(dir, validateSample, opts);
    expect(r.exists).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual(FALLBACK);
    expect(events).toHaveLength(0);
  });

  it("stat 的 EACCES 保留有效缓存并发 error，不伪装 missing，恢复后发 recovered", () => {
    const p = path.join(dir, "stat-eacces.json");
    fs.writeFileSync(p, JSON.stringify({ n: 41 }));
    expect(readJsonCached(p, validateSample, opts).value).toEqual({ n: 41 });
    expect(events).toHaveLength(0);

    const statError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw statError;
    });
    let denied: JsonFileRead<Sample> | undefined;
    try {
      denied = readJsonCached(p, validateSample, { ...opts, force: true });
    } finally {
      statSpy.mockRestore();
    }

    expect(denied!.value).toEqual({ n: 41 });
    expect(denied!.exists).toBe(true);
    expect(denied!.error).toMatch(/^读取状态失败:/);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(events[0].mtimeMs).toBeGreaterThan(0);
    expect(events[0].size).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "missing")).toBe(false);

    const recovered = readJsonCached(p, validateSample, { ...opts, force: true });
    expect(recovered.value).toEqual({ n: 41 });
    expect(recovered.error).toBeUndefined();
    expect(events[events.length - 1]?.type).toBe("recovered");
  });

  it("首次 stat 错误使用 fallback 但仍报告 error", () => {
    const p = path.join(dir, "stat-first-error.json");
    const statError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw statError;
    });
    let result: JsonFileRead<Sample> | undefined;
    try {
      result = readJsonCached(p, validateSample, { ...opts, force: true });
    } finally {
      statSpy.mockRestore();
    }

    expect(result!.value).toEqual(FALLBACK);
    expect(result!.exists).toBe(false);
    expect(result!.error).toMatch(/^读取状态失败:/);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(events.some((event) => event.type === "missing")).toBe(false);
  });

  it("相对路径立即绝对化，chdir 后同一相对键命中同一缓存", () => {
    const absolute = path.join(dir, "relative-cache.json");
    fs.writeFileSync(absolute, JSON.stringify({ n: 52 }));
    const relative = path.relative(process.cwd(), absolute);
    const first = readJsonCached(relative, validateSample, { ...opts, force: true });
    expect(first.path).toBe(path.resolve(relative));

    const oldCwd = process.cwd();
    process.chdir(dir);
    try {
      const second = readJsonCached("relative-cache.json", validateSample, opts);
      expect(second.path).toBe(absolute);
      expect(second.value).toEqual({ n: 52 });
    } finally {
      process.chdir(oldCwd);
    }
    expect(events).toHaveLength(0);
  });
});