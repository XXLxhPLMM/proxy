/**
 * sqlite 档四档（`layout` / `durability` / `resilience` / `driver-split`）共用的装配面与真读面
 *
 * @description
 * 主题级不变量与变异表归同目录 `AGENTS.md`；这里只放两档以上真用到的那套入参与读库工具。
 *
 * ⚠️ **临时目录的生命周期住在这里而不是各档**：`dir` 是**活绑定**，档侧只读、重建交给本模块，
 * 于是「谁在改这个变量」只有一个答案。
 *
 * ⚠️ **`_*.ts` 不带 `.test.ts` 后缀**：vitest 收不到它，所以它不是一份空跑的空档；而它**必须**
 * 留在本目录（不许上提 `tests/helpers/`）——`tests/unit/` 在零外网扫描的范围内，`helpers/` 不在。
 *
 * ⚠️ **本模块是 `node:sqlite` 那个版本地板闸门所在的目录**：`driver-split.test.ts` 那档 builtin
 * 分支**真跑**内置驱动且**没有 `skipIf`**（低版本运行时是抛错而不是跳过，这是有意的，见根
 * `AGENTS.md`「开发必须 Node >= 22.13」一节）。搬动这条断言时**不许**给它加 `skipIf` 让它「稳定」。
 */

import { afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SqliteUsageSource,
  quotaWindow,
  windowKey,
  type QuotaWindow,
  type UsageQuota,
  type UsageSnapshot,
  type UsageSourceError,
} from "@/datasource/quota/index.js";
import { UsageMirror } from "@/datasource/quota/mirror.js";
import { openSqliteDriver } from "@/utils/sqlite/index.js";
import type { SqliteDriver, SqliteDriverChoice } from "@/utils/sqlite/index.js";

/** 本地构造某个时刻（时区无关地落在那一刻） */
export const at = (y: number, m: number, d: number, h = 0, mi = 0): number =>
  new Date(y, m - 1, d, h, mi, 0, 0).getTime();

/** 便捷：算出某时刻的窗口键（断言里表达「这个键等于当前窗口」而不是抄一份算法） */
export function windowKeyOf(nowMs: number, window: QuotaWindow, shiftHours: number): string {
  return windowKey(nowMs, window, shiftHours);
}

const UNLIMITED: UsageQuota = { bytes: 0 };
// ⚠️ **写成 `const` 箭头而不是 `export function`**：本仓的转换链（esbuild / oxc）不认
// 「函数声明 + 返回类型标注 + 箭头体」这个形态（`export function f(): T => ({…})` 直接解析失败），
// 而全仓也从不这么写。箭头 const 才是这一仓既有的形态。
export const withWindow = (window: QuotaWindow, rest: Partial<UsageQuota> = {}): UsageQuota => ({
  ...UNLIMITED,
  window,
  ...rest,
});

/**
 * 驱动工厂的形状（`openSqliteDriver()` 的返回值类型）
 * @description 显式声明而不是 `typeof openSqliteDriver`：后者是**零参**函数（它返回工厂），
 * 拿它当「工厂」类型会把 `driverOfKind("wasm")(file)` 判成「多传了一个参数」。
 */
export type DriverFactory = SqliteDriverChoice;

/**
 * 强制走某一档驱动的 `openSqliteDriver` 包装
 * @description `SqliteUsageSourceOptions.openDriver` 是可注入的驱动工厂（见该文件注释），
 * 理由就是「WASM 分支在 Node 22 上恒不执行 = 零覆盖」。本包装把 `kind` 固定住，
 * 实现仍取 `openSqliteDriver` 里那一份对应实现——**不复写驱动逻辑**，只固定分流结果。
 */
export function driverOfKind(kind: "builtin" | "wasm"): DriverFactory {
  // `openSqliteDriver(prefer)` 在指定档不可用时**抛**而不是静默回落——后者会让
  // 「这条用例其实测的是另一档」变成假绿（Node 22 上静默回落成 builtin，
  // 于是「wasm 档跑通了」这句话是假的）。
  return openSqliteDriver(kind);
}

export interface HarnessOptions {
  readonly quotas?: Record<string, UsageQuota>;
  readonly resetHour?: () => number;
  readonly flushMs?: () => number;
  readonly start?: number;
  readonly onError?: (event: UsageSourceError) => void;
  readonly dir?: string;
  /** 强制驱动档（缺省按运行时分流） */
  readonly driverKind?: "builtin" | "wasm";
}

export interface Harness {
  readonly account: UsageMirror;
  readonly ledger: SqliteUsageSource;
  readonly file: string;
  readonly errors: UsageSourceError[];
  readonly restored: UsageSnapshot[];
  /** 拨钟（**账本与判定共用同一个时钟源**，这正是「delta 与窗口键同一时刻」的由来） */
  at(t: number): Harness;
}

/**
 * 组一套「内存账本 + 它的落盘副本」
 * @description 刻意**不走** `runtime/services.ts` 的默认装配：那层要 ConfigAccessor 与
 * `users.json`，本目录要的是「窗口/时刻/目录/驱动档」四个可自由注入的口子。装配形状与
 * `buildDefaultServices` 逐字同构（同一个 `UsageMirror` + `bindSink` +
 * `onRestore → seed`），所以这里跑通的路径就是生产路径。
 */
export function harness(dir: string, options: HarnessOptions = {}): Harness {
  const clock = { now: options.start ?? at(2026, 3, 15, 12) };
  const resetHour = options.resetHour ?? ((): number => 0);
  const errors: UsageSourceError[] = [];
  const restored: UsageSnapshot[] = [];
  const account = new UsageMirror((user: string) => options.quotas?.[user], {
    resetHour,
    now: (): number => clock.now,
  });
  const ledger = new SqliteUsageSource({
    dir: (): string => dir,
    // 默认给一个「很长」的间隔：用例全部靠显式 `sync()` 驱动，**不依赖真实时钟**。
    // 定时器那条路径另有专门一条用例（短间隔 + 真 sleep）。
    flushMs: options.flushMs ?? ((): number => 3_600_000),
    resetHour,
    windowFor: (user: string): QuotaWindow => quotaWindow(options.quotas?.[user]?.window),
    now: (): number => clock.now,
    onSnapshot: (value: UsageSnapshot): void => {
      restored.push(value);
      account.absorb(value);
    },
    onError: (event: UsageSourceError): void => {
      errors.push(event);
      options.onError?.(event);
    },
    ...(options.driverKind === undefined
      ? {}
      : { openDriver: driverOfKind(options.driverKind) }),
  });
  account.bindSink(ledger);
  const self: Harness = {
    account,
    ledger,
    file: ledger.file,
    errors,
    restored,
    at: (t: number): Harness => {
      clock.now = t;
      return self;
    },
  };
  return self;
}

/**
 * 另开一个连接真读库（**不依赖账本实例的任何状态**）
 * @description 停机落盘与共享两条断言都要求「证明真的落盘了」，而 spy 证明不了 IO。
 * 另开连接是唯一诚实的做法——它同时顺带证明了「**别的进程也能读**」（多进程共享的
 * 必要条件）。用完必须 `close()`，否则 Windows 上文件句柄不释放会挡住 `rmSync`。
 */
function readUsage(file: string, user: string, w: string): number | undefined {
  const db: SqliteDriver = openSqliteDriver()(file);
  try {
    return db.get<{ v: number }>("SELECT v FROM usage WHERE u = ? AND w = ?", [user, w])?.v;
  } finally {
    db.close();
  }
}

/** 库里该用户**当前窗口**的合计用量（`windowKeyOf` 与被测实现共用同一个 `windowKey`） */
export function totalIn(file: string, user: string, w: string): number {
  return readUsage(file, user, w) ?? 0;
}

/** 库里全部行数（诊断表规模用） */
export function rowCount(file: string): number {
  const db = openSqliteDriver()(file);
  try {
    return db.get<{ c: number }>("SELECT COUNT(*) AS c FROM usage")?.c ?? 0;
  } finally {
    db.close();
  }
}

export let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "traffic-ledger-"));
});

/**
 * 清临时目录（**best-effort 重试**）
 * @description 账本是真 SQLite 库 → 有 `-wal` / `-shm` / `-journal` 三个旁挂文件，且
 * **Windows 上任何尚未释放的句柄都会让 `rmSync` 报 `EBUSY`**。WASM 驱动实测「不 close
 * 也能删」，但那不是可依赖的性质（不同文件系统、不同档位行为不同）。
 * 于是这里重试若干次：**清理失败不该把一条断言正确的用例判成失败**，而真失败
 * （文件确实被占用）会在重试耗尽后照常抛出来。
 */
function cleanupTemp(): void {
  let last: unknown;
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

afterEach(() => {
  cleanupTemp();
});

export const day12 = at(2026, 3, 15, 12);
export const DAY_KEY = windowKeyOf(day12, "day", 0);
