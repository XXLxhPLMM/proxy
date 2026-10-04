/**
 * 宿主告警过滤器的行为面：只摘 `node:sqlite` 那一条，其余一条不漏
 *
 * @description
 * ## 为什么这三条要在一个文件里、而不是一条断言
 * @description
 * 过滤器是那种**极易恒绿**的东西：`if (warning.name === "ExperimentalWarning") return;`
 * 就能让「SQLite 那条不见了」这一条绿，而它同时把 Node 未来每一条实验性警告都吞了。故这一档是
 * 「**吞该吞的** + **放过两条不同形状的**」三条合起来才叫断言 —— 后两条是前那条的负向对照。
 *
 * ## 「没装过滤器时确实会上屏」为什么要起子进程
 * @description
 * `node:sqlite` 在一个 vitest worker 里只会被加载**一次**（Node 的 builtin 模块有缓存），于是同一个
 * 档里第二次去加载它**不会再触发**那条警告 —— 拿它当正向判据就是恒绿。故那条对照走 `execFileSync`
 * 起一个**全新进程**去加载，stderr 上有没有那句话才是真的。
 *
 * @module tests/warnings
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeLedger, closeLedgerDb } from "@/services/config/index.js";
import { installSqliteWarningFilter } from "@/services/index.js";

/** Node 的 `emitWarning` 走 `process.nextTick`，故断言前要让出一个 tick */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    process.nextTick(resolve);
  });
}

/** 截住 stderr；⚠️ **必须在装过滤器之前**装：过滤器抓的是那批已有的监听器，而打印器每次都现读 `process.stderr` */
function captureStderr(): () => string {
  const seen: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    seen.push(String(chunk));
    return true;
  });
  return () => seen.join("");
}

const releases: (() => void)[] = [];

function installing(): void {
  releases.push(installSqliteWarningFilter());
}

/** 那一次真开库用的临时目录（`afterEach` 在**收掉库句柄之后**才删：句柄开着时 Windows 上删不掉） */
const created: string[] = [];

afterEach(() => {
  for (const release of releases.splice(0)) release();
  closeLedgerDb();
  vi.restoreAllMocks();
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("node:sqlite 那条 ExperimentalWarning 的过滤器", () => {
  it("吞掉 SQLite 那一条：加载 builtin **并且真的开一次库**之后 stderr 上没有它", async () => {
    const stderr = captureStderr();
    installing();

    await import("node:sqlite");
    await tick();
    // ⚠️ 真的开一次库：过滤器要压住的是「用着它的时候」那条，不是「import 它」那一刻
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swain-tui-warn-"));
    created.push(dir);
    writeLedger(path.join(dir, "tui.db"), { version: 1, selected: null, targets: [] });
    await tick();

    expect(stderr()).not.toContain("SQLite is an experimental feature");
    expect(stderr()).not.toContain("ExperimentalWarning");
  });

  it("放过 DeprecationWarning：那一类一条都不许被吞", async () => {
    const stderr = captureStderr();
    installing();

    process.emitWarning("这句话该上屏", "DeprecationWarning");
    await tick();

    expect(stderr()).toContain("这句话该上屏");
  });

  it("放过**非 SQLite 的** ExperimentalWarning（判据不许退化成「 ExperimentalWarning 全吞」）", async () => {
    const stderr = captureStderr();
    installing();

    // ⚠️ 文案里**不许**出现 "SQLite" 三个字母：判据是消息文本上的正则，写进去就是自证
    process.emitWarning("另一条实验性特性，与本包无关", "ExperimentalWarning");
    await tick();

    expect(stderr()).toContain("另一条实验性特性，与本包无关");
    expect(stderr()).toContain("ExperimentalWarning");
  });

  it("判据自检：**不装**过滤器时，真加载 `node:sqlite` 确实会在 stderr 上打那一条", () => {
    // 「探测器看得见」与「今天真的干净」合起来才叫断言；只写前面那条的话，过滤器写坏了照样绿
    const child = spawnSync(process.execPath, ["-e", "require('node:sqlite')"], {
      encoding: "utf8",
    });
    expect(child.stderr).toContain("SQLite is an experimental feature");
  });

  it("撤销是幂等的，且撤销之后警告回到默认打印器（重复调用不改变任何事）", async () => {
    const stderr = captureStderr();
    const release = installSqliteWarningFilter();
    release();
    release();
    release();

    process.emitWarning("撤销之后这句话该上屏", "DeprecationWarning");
    await tick();

    expect(stderr()).toContain("撤销之后这句话该上屏");
  });
});