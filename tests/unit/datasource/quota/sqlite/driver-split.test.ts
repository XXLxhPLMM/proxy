/**
 * sqlite 档的**驱动分流**：Node 22 内置 `node:sqlite` / Node 16–22 的 WASM 库，两档都真跑
 *
 * @description
 * 主题级不变量与变异表归同目录 `AGENTS.md`（本目录只放「这一档管哪一段 + 指向 `AGENTS.md`」）。
 * ⚠️ **本档是全仓的 Node 版本地板闸门**：builtin 档**真跑** `node:sqlite`（不是 stub），而
 * `node:sqlite` 在 22.5 出生、**22.13 才免 `--experimental-sqlite` flag**。本文件**零处
 * `skipIf`** —— 低版本运行时它**抛错而不是跳过**，而那是**有意的**：`engines` 与 `devEngines`
 * 都不拦 pnpm 的开发环境（实测都是退出码 0），真正强制地板的就是这条断言。
 * **搬动它时不许加 `skipIf` 让它「稳定」** —— 那等于把全仓的版本防线拆掉（根 `AGENTS.md`
 * 「开发必须 Node >= 22.13 由谁保证」一节）。
 *
 * 两档都真跑的另一个理由：只测当前运行时那一档，等于让另一半用户吃零测试覆盖；而「不可测」
 * 在本机是**失败**而不是静默 skip。
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openSqliteDriver } from "@/utils/sqlite/index.js";
import {
  DAY_KEY,
  day12,
  dir,
  driverOfKind,
  harness,
  totalIn,
  withWindow,
} from "./_usage-source.js";

/**
 * 用**指定那一档**驱动读库
 * @description 只给「分档跑」那组用。理由见调用点注释：跨档读同一个 `.db` 会撞上
 * 「no such table」这类像 bug 的现象（两个驱动各自维护自己的连接状态）。
 */
function readWithKind(
  file: string,
  user: string,
  w: string,
  kind: "builtin" | "wasm",
): number | undefined {
  const db = driverOfKind(kind)(file);
  try {
    return db.get<{ v: number }>("SELECT v FROM usage WHERE u = ? AND w = ?", [user, w])?.v;
  } finally {
    db.close();
  }
}

describe("@/datasource/quota sqlite-source：驱动分流（Node 22 内置 / 16–22 WASM）", () => {
  it("当前运行时选中的那一档真的能开库并记账", async () => {
    const kind = openSqliteDriver().kind;
    const h = harness(dir, { quotas: { alice: withWindow("day", { bytes: 10_000_000 }) } });
    await h.ledger.open();
    h.at(day12);
    h.account.consume("alice", "up", 512);
    await h.ledger.close();
    expect(totalIn(h.file, "alice", DAY_KEY), `${kind} 档记账可用`).toBe(512);
  });

  // Node 22 用户走内置档、Node 16 用户走 WASM 档 —— 两个部署形态都必须有覆盖。
  // 「不可测」在本机是**失败**而不是静默 skip：那正是另一个部署形态没人测过的地方。
  for (const kind of ["builtin", "wasm"] as const) {
    it(`${kind} 档：建库 → 累加 → 另开连接读回（该档真跑，不是 stub）`, async () => {
      const h = harness(dir, {
        quotas: { alice: withWindow("day", { bytes: 10_000_000 }) },
        driverKind: kind,
      });
      await h.ledger.open();
      h.at(day12);
      for (let i = 0; i < 5; i++) {
        h.account.consume("alice", "up", 100);
      }
      await h.ledger.close();
      // ⚠️ **必须用同一档去读**：WASM 档与内置档读同一个 `.db` 时，表是**各自连接**建的，
      // 跨档读会撞上「no such table」这类看起来像 bug 的现象（实测）。所以这条断言顺带
      // 钉住一件事：**两档的 `.db` 文件是各自自洽的**，而生产上同一台机器只会有一种档。
      expect(readWithKind(h.file, "alice", DAY_KEY, kind)).toBe(500);
    });
  }

  it("WASM 档并发写同一行：合计精确（实测口径：无 WAL，靠 busy_timeout 串行化）", async () => {
    // 这条断言是 WASM 档**存在的理由**：它没有 WAL（`PRAGMA journal_mode` 读回 `delete`），
    // 并发写完全靠 `busy_timeout` + 幂等 UPSERT。若哪天这两个被摘掉，这里会红。
    try {
      const probe = driverOfKind("wasm")(path.join(dir, "probe.db"));
      probe.close();
    } catch {
      // 本机没有 WASM 档（依赖未装）→ 这条对当前运行时不可测，如实说明而不是假装通过
      expect.unreachable("WASM 驱动不可用：node-sqlite3-wasm 应随 dependencies 安装");
      return;
    }
    const shared = path.join(dir, "shared");
    fs.mkdirSync(shared, { recursive: true });
    const quotas = { alice: withWindow("day", { bytes: 1_000_000_000 }) };
    const instances = Array.from({ length: 3 }, () =>
      harness(shared, { quotas, driverKind: "wasm" }),
    );
    for (const h of instances) {
      await h.ledger.open();
      h.at(day12);
    }
    for (const h of instances) {
      for (let i = 0; i < 100; i++) {
        h.account.consume("alice", "up", 4);
      }
    }
    await Promise.all(instances.map((h) => h.ledger.sync()));
    for (const h of instances) {
      await h.ledger.close();
    }
    expect(
      readWithKind(instances[0].file, "alice", DAY_KEY, "wasm"),
      "3×100×4 精确",
    ).toBe(3 * 100 * 4);
  });
});
