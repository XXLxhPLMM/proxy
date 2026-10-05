/**
 * 账本驱动三档里 `drivers/` 两档（`equivalence` / `registry`）共用的装配面
 *
 * @description
 * 主题级不变量与变异表归同目录 `AGENTS.md`；这里只放两档真用到的那套「镜像 + 指定后端的数据源」。
 *
 * ⚠️ **临时目录的生命周期住在这里而不是各档**：两个档都要 `beforeEach` 建目录、`afterEach`
 * best-effort 回收，而 `dir` 本身是**活绑定**——档侧只读它，重建交给本模块，于是「谁在改这个变量」
 * 只有一个答案（拆开后两个档各写一份 `let dir` 会让这个变量有两个作者，而 `harness` 只会读到
 * 其中一个）。
 *
 * ⚠️ **`_*.ts` 不带 `.test.ts` 后缀**：vitest 收不到它，所以它不是一份空跑的空档；而它**必须**
 * 留在本目录（不许上提 `tests/helpers/`）——`tests/unit/` 在零外网扫描的范围内，`helpers/` 不在。
 */

import { afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SqliteUsageSource,
  quotaWindow,
  type QuotaWindow,
  type UsageQuota,
  type UsageSnapshot,
  type UsageSourceError,
} from "@/datasource/quota/index.js";
import { UsageMirror } from "@/datasource/quota/mirror.js";
import { JsonlUsageSource } from "@/datasource/quota/jsonl-source.js";

export const at = (y: number, m: number, d: number, h = 0): number =>
  new Date(y, m - 1, d, h, 0, 0, 0).getTime();

const QUOTA: UsageQuota = { bytes: 10_000_000, window: "day" };
export const day12 = at(2026, 3, 15, 12);

export let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-drivers-"));
});

afterEach(() => {
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      last = undefined;
      break;
    } catch (error) {
      last = error;
    }
  }
  if (last !== undefined) {
    throw last;
  }
});

/** 组一套「用量镜像 + 指定后端的数据源」，形状与 `buildDefaultServices` 逐字同构 */
export function harness(driver: "json" | "sqlite", quota: UsageQuota = QUOTA) {
  const clock = { now: day12 };
  const errors: UsageSourceError[] = [];
  const account = new UsageMirror(() => quota, {
    resetHour: () => 0,
    now: () => clock.now,
  });
  const shared = {
    dir: (): string => dir,
    flushMs: (): number => 3_600_000,
    resetHour: (): number => 0,
    windowFor: (): QuotaWindow => quotaWindow(quota.window),
    enabled: (): boolean => true,
    now: (): number => clock.now,
    onSnapshot: (r: UsageSnapshot): void => {
      account.absorb(r);
    },
    onError: (e: UsageSourceError): void => {
      errors.push(e);
    },
  };
  const source = driver === "json" ? new JsonlUsageSource(shared) : new SqliteUsageSource(shared);
  account.bindSink(source);
  return { account, source, errors, at: (t: number) => (clock.now = t) };
}
