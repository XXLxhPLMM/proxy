/**
 * 读面：从一份**坏**台账读出来会怎样
 * @description
 * - **库不存在 ⇒ 空台账，且不因此建库**：「看一眼配置」不该在磁盘上留痕迹。
 * - ⚠️ **坏内容即拒**：七种坏形状逐条点名出错的那个字段，而判据落在**抛错之后磁盘上那份数据**
 *   （不是「抛了没有」）—— 一个「抛错前先把整张表清空」的实现照样能过后者。
 * - 错误文案里一个 token 字节都不许有；手改出来的尾斜杠在**读出时**就归一。
 *
 * 目录级不变量（真库而不是 mock 掉驱动 · 「改坏形状必须从外面来」）见 `AGENTS.md`。
 *
 * @module tests/ledger
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  LedgerError,
  closeLedgerDb,
  readLedger,
  selectedTarget,
  writeLedger,
  type Ledger,
} from "@/services/config/index.js";
import { SCHEMA_VERSION } from "@/services/config/tables.js";
import { corrupt, created, dump, firstTarget, tempDb, tempDir } from "./_shared.js";

afterEach(() => {
  closeLedgerDb();
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 一份形状正确的台账（各组按需改字段） */
function goodLedger(overrides: Partial<Ledger> = {}): Ledger {
  return { version: 1, selected: null, targets: [firstTarget()], ...overrides };
}

describe("ledger 读面", () => {
  it("库不存在 ⇒ 空台账，且**不**因此创建那个库", () => {
    const file = tempDb();
    expect(fs.existsSync(file)).toBe(false);
    expect(readLedger(file)).toEqual({ version: 1, selected: null, targets: [] });
    // 「看一眼配置」不该在磁盘上留痕迹：痕迹会让下一次「库在不在」这个判断失去意义
    expect(fs.existsSync(file)).toBe(false);
  });

  it("那个文件不是 SQLite 库 ⇒ LedgerError(unreadable)，且**原文件逐字未变**", () => {
    const file = path.join(tempDir(), "tui.db");
    const garbage = "这不是一个 SQLite 库";
    fs.writeFileSync(file, garbage, "utf8");

    expect(() => readLedger(file)).toThrowError(LedgerError);
    // ⚠️ 这条才是重点：坏内容绝不能被「空台账」悄悄覆盖掉（丢的是管理员凭据）
    expect(fs.readFileSync(file, "utf8")).toBe(garbage);
  });

  it("形状坏时逐条点名出错的那个字段，且库里那份数据逐字未变", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      // ⚠️ **比 {@link SCHEMA_VERSION} 大一档**：写死一个数的话版本一升这一条会静默地不再成立
      // （它当时就是写死的 3，而 `SCHEMA_VERSION` 升到 3 之后「比本包新」那一档变成了「恰好等于」）
      ["台账 version 比本包新", `PRAGMA user_version = ${String(SCHEMA_VERSION + 1)};`, "version"],
      [
        "targets 是别人建的同名表",
        "DROP TABLE targets; CREATE TABLE targets (id TEXT PRIMARY KEY, title TEXT, url TEXT, token TEXT, timeout_ms INTEGER);",
        "targets",
      ],
      ["target 缺 token", "ALTER TABLE targets DROP COLUMN token;", "token"],
      [
        "selected 指向不存在的端点",
        "INSERT INTO meta(key,value) VALUES('selected','查无此人');",
        "selected",
      ],
      ["id 不是 slug", "UPDATE targets SET id = '有 大写';", "id"],
      ["baseUrl 不是可用的地址", "UPDATE targets SET base_url = 'not a url';", "baseUrl"],
      ["timeout 越界", "UPDATE targets SET timeout_ms = 5;", "timeoutMs"],
    ];

    for (const [label, sql, field] of cases) {
      const file = path.join(tempDir(), "tui.db");
      writeLedger(file, goodLedger());
      corrupt(file, sql);
      const before = dump(file);

      let thrown: unknown;
      try {
        readLedger(file);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `${label} 应当抛`).toBeInstanceOf(LedgerError);
      expect((thrown as LedgerError).code, `${label} 的档位`).toBe("unreadable");
      expect((thrown as LedgerError).message, `${label} 的文案必须点名出错字段`).toContain(field);
      // 「抛了」不够 —— 必须证明那份库没被降级成空台账改掉
      expect(dump(file), `${label} 之后磁盘上的数据被改了`).toBe(before);
    }
  });

  it("坏台账的错误文案里一个 token 字节都不许有（哪怕库里躺着两份真凭据）", () => {
    // ⚠️ 这条必须让库里**真的有**两份 token 才成立：一份「token 被改成非字符串」的坏样本让断言恒真 ——
    // 那种坏法下任何错误文案都不可能提到真 token，而它证明不了「判据不引用内容」。
    const file = path.join(tempDir(), "tui.db");
    writeLedger(
      file,
      goodLedger({
        targets: [firstTarget(), { ...firstTarget(), id: "lab", token: "另一份-token" }],
      }),
    );
    corrupt(file, "UPDATE targets SET base_url = 'nope' WHERE id = 'lab';");

    let thrown: unknown;
    try {
      readLedger(file);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LedgerError);
    expect((thrown as LedgerError).message).not.toContain("s3cr3t-token");
    expect((thrown as LedgerError).message).not.toContain("另一份-token");
  });

  it("手改出来的尾斜杠在**读出时**就归一（不推迟到网络上才失败）", () => {
    const file = path.join(tempDir(), "tui.db");
    writeLedger(file, goodLedger({ selected: "prod" }));
    corrupt(file, "UPDATE targets SET base_url = 'http://127.0.0.1:3010/';");

    const ledger = readLedger(file);
    expect(selectedTarget(ledger)?.baseUrl).toBe("http://127.0.0.1:3010");
    // 且下一次写把它固化下来
    writeLedger(file, ledger);
    expect(readLedger(file).targets[0].baseUrl).toBe("http://127.0.0.1:3010");
  });
});
