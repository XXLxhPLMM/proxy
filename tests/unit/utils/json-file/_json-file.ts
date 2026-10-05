/**
 * `readJsonCached` 两档（`read` / `events`）共用的沙箱与被测值形状
 *
 * @description
 * 四态事件、去重按回调隔离、版本字段契约与「每档独占一个临时目录」的理由在 `./AGENTS.md`，不复制进本文件。
 * 沙箱只能在本模块内登记（`dir` 是导出绑定，档自己那条 `beforeAll` 赋不了值），故 `useSandbox()`
 * 是**唯一**的入口：调一次即装好「建目录 → 每例清事件 → 收尾删目录」三个钩子。
 *
 * @module tests/unit/utils/json-file
 */

import { afterAll, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JsonFileEvent } from "@/utils/json-file/index.js";

/** 被测值类型：一个简单对象，便于构造「结构不符」 */
export interface Sample {
  n: number;
}

/** 校验器：仅当 raw 为非数组对象且 n 为 number 时通过 */
export function validateSample(raw: unknown): Sample | undefined {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const n = (raw as { n?: unknown }).n;
    if (typeof n === "number") {
      return { n };
    }
  }
  return undefined;
}

export const FALLBACK: Sample = { n: -1 };

/**
 * 事件收集器：json-file 已与 logger 解耦，档直接断言 onEvent 事件流
 * （错误去重 / 恢复 / 热加载 / 文件消失），无需拦截 logger，也不会写进仓库 log/。
 */
export const events: JsonFileEvent[] = [];

/** 订阅回调：把事件推进当前用例的收集器 */
export function collect(evt: JsonFileEvent): void {
  events.push(evt);
}

export const opts = { label: "测试配置文件", fallback: FALLBACK, onEvent: collect };

/** 每档独立临时目录，避免命中其它用例/其它档的节流缓存 */
export let dir: string;

/** 装好本目录两档共用的三个生命周期钩子 */
export function useSandbox(): void {
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-test-"));
  });

  beforeEach(() => {
    events.length = 0;
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}