import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonCached, type JsonFileEvent, type JsonFileRead } from "@/utils/json-file.js";

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
 * 事件收集器：json-file 已与 logger 解耦，本文件直接断言 onEvent 事件流
 * （错误去重 / 恢复 / 热加载 / 文件消失），无需拦截 logger，也不会写进仓库 log/。
 */
let events: JsonFileEvent[] = [];

/** 订阅回调：把事件推进当前用例的收集器 */
function collect(evt: JsonFileEvent): void {
  events.push(evt);
}

/** 每个文件独立临时目录，避免命中其它用例/其它进程的节流缓存 */
let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-test-"));
});

beforeEach(() => {
  events = [];
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const opts = { label: "测试配置文件", fallback: FALLBACK, onEvent: collect };

describe("utils/json-file readJsonCached", () => {
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

  it("合法内容 → 解析值正确、无 error（首次加载静默，由启动摘要覆盖）", () => {
    const p = path.join(dir, "ok.json");
    fs.writeFileSync(p, JSON.stringify({ n: 7 }));
    const r = readJsonCached(p, validateSample, opts);
    expect(r.exists).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.value).toEqual({ n: 7 });
    expect(events).toHaveLength(0);
  });

  it("非法 JSON → 保留上一份有效值并抛一条 error 事件（force 强制重读）", () => {
    const p = path.join(dir, "bad-json.json");
    fs.writeFileSync(p, JSON.stringify({ n: 5 }));
    expect(readJsonCached(p, validateSample, opts).value).toEqual({ n: 5 });
    expect(events).toHaveLength(0);

    fs.writeFileSync(p, "{ 这不是合法 JSON");
    const r = readJsonCached(p, validateSample, { ...opts, force: true });
    expect(r.exists).toBe(true);
    expect(r.error).toBeTruthy();
    expect(r.value).toEqual({ n: 5 });
    // 坏内容必须抛一条 error 事件（含配置名/路径/原因），否则订阅方无法察觉配置被拒绝
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(events[0].label).toBe("测试配置文件");
    expect(events[0].path).toBe(p);
    expect(events[0].error).toBeTruthy();
  });

  it("坏文件持续期间只抛一次 error 事件（去重），恢复后给一条 recovered", () => {
    const p = path.join(dir, "dedup.json");
    fs.writeFileSync(p, JSON.stringify({ n: 1 }));
    readJsonCached(p, validateSample, opts);
    expect(events).toHaveLength(0);

    fs.writeFileSync(p, "{ 坏内容");
    readJsonCached(p, validateSample, { ...opts, force: true });
    expect(events).toHaveLength(1);
    // 再次强制重读：错误未变化 → 不重复抛事件
    readJsonCached(p, validateSample, { ...opts, force: true });
    expect(events).toHaveLength(1);

    fs.writeFileSync(p, JSON.stringify({ n: 2 }));
    const r = readJsonCached(p, validateSample, { ...opts, force: true });
    expect(r.value).toEqual({ n: 2 });
    expect(r.error).toBeUndefined();
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe("recovered");
  });

  it("已加载的文件被删除 → missing 事件一次且值回退 fallback，恢复后给一条 recovered", () => {
    const p = path.join(dir, "disappear.json");
    fs.writeFileSync(p, JSON.stringify({ n: 9 }));
    expect(readJsonCached(p, validateSample, opts).value).toEqual({ n: 9 });
    expect(events).toHaveLength(0);

    // 存在 → 缺失：ACL 场景会静默变「全放行」，必须抛一条 missing（warn 由订阅方落）
    fs.rmSync(p);
    const gone = readJsonCached(p, validateSample, { ...opts, force: true });
    expect(gone.exists).toBe(false);
    expect(gone.error).toBeUndefined();
    expect(gone.value).toEqual(FALLBACK);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("missing");
    expect(events[0].label).toBe("测试配置文件");
    expect(events[0].path).toBe(p);
    // missing 无文件可 stat：不带版本字段
    expect(events[0].mtimeMs).toBeUndefined();
    expect(events[0].size).toBeUndefined();

    // 持续缺失：不重复抛
    readJsonCached(p, validateSample, { ...opts, force: true });
    expect(events).toHaveLength(1);

    // 文件恢复：给一条 recovered 并采用新值
    fs.writeFileSync(p, JSON.stringify({ n: 10 }));
    const back = readJsonCached(p, validateSample, { ...opts, force: true });
    expect(back.exists).toBe(true);
    expect(back.value).toEqual({ n: 10 });
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe("recovered");
  });

  it("内容变更且校验通过 → 一条 reloaded 事件（首次加载静默）", () => {
    const p = path.join(dir, "reload.json");
    fs.writeFileSync(p, JSON.stringify({ n: 1 }));
    expect(readJsonCached(p, validateSample, opts).value).toEqual({ n: 1 });
    expect(events).toHaveLength(0);

    // 变更须让 size 也不同（Windows 同 ms 写入可能 mtime+size 相同，见下方 force 用例）
    fs.writeFileSync(p, JSON.stringify({ n: 22 }));
    expect(readJsonCached(p, validateSample, { ...opts, force: true }).value).toEqual({ n: 22 });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("reloaded");
    expect(events[0].label).toBe("测试配置文件");
    expect(events[0].path).toBe(p);
    // 版本标识随事件回传：日志层据此区分「同版本被多进程加载」与「文件被多次修改」
    expect(events[0].mtimeMs).toBeGreaterThan(0);
    expect(events[0].size).toBeGreaterThan(0);
  });

  it("订阅回调抛错不影响读取（绝不外抛契约）", () => {
    const p = path.join(dir, "callback-throw.json");
    fs.writeFileSync(p, JSON.stringify({ n: 1 }));
    readJsonCached(p, validateSample, opts); // 首次加载静默

    fs.writeFileSync(p, JSON.stringify({ n: 22 }));
    let r: JsonFileRead<Sample> | undefined;
    expect(() => {
      r = readJsonCached(p, validateSample, {
        ...opts,
        force: true,
        onEvent: () => {
          throw new Error("订阅方故障");
        },
      });
    }).not.toThrow();
    expect(r?.value).toEqual({ n: 22 });
  });

  it("结构不符（校验不过）→ 同样保留上一份有效值并给出 error", () => {
    const p = path.join(dir, "bad-shape.json");
    fs.writeFileSync(p, JSON.stringify({ n: 3 }));
    expect(readJsonCached(p, validateSample, opts).value).toEqual({ n: 3 });

    fs.writeFileSync(p, JSON.stringify({ n: "3" }));
    const r = readJsonCached(p, validateSample, { ...opts, force: true });
    expect(r.error).toBeTruthy();
    expect(r.value).toEqual({ n: 3 });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
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
      // 变更须让 size 也不同：Windows 同一时间戳 tick 内的两次写入可能拿到相同 mtime+size（同上方 force 用例）
      fs.writeFileSync(p, JSON.stringify({ n: 22 }));
      expect(readJsonCached(p, validateSample, opts).value).toEqual({ n: 1 });
      expect(events).toHaveLength(0);

      // 越过默认 1000ms 节流窗口 → 重新读取（并抛一条 reloaded）
      vi.advanceTimersByTime(1500);
      expect(readJsonCached(p, validateSample, opts).value).toEqual({ n: 22 });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("reloaded");
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
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });
});
