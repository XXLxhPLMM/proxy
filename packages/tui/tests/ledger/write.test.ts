/**
 * 写面：落盘那一份的形状（往返、建目录、不留半成品、权限、次序）
 * @description
 * - write → read **逐字**往返，含 `selected` 与清单顺序（清单顺序靠 `rowid`，不是靠读回来再排）。
 * - ⚠️ **目录里除那份库与它的 WAL 伴随文件之外一个不多** —— 一次写崩在目录里留一份含明文 token 的
 *   半成品，是本层最容易留下、也最难被察觉的一种脏。
 * - ⚠️ **库文件在任何 token 落进去之前就已经是 0600**：判据取「chmod 那一刻量到的文件大小 == 0」，
 *   而不是「代码里写了 chmod」—— 后者对着一个注释也能通过。
 * - 给定一份坏台账即抛，且磁盘一个字节都没动（落盘恒是校验过的形态）。
 *
 * 目录级不变量见 `AGENTS.md`。
 *
 * @module tests/ledger
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LedgerError, closeLedgerDb, readLedger, writeLedger } from "@/services/config/index.js";
import { created, dump, firstTarget, tempDb, tempDir } from "./_shared.js";

afterEach(() => {
  closeLedgerDb();
  vi.restoreAllMocks();
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ledger 写面", () => {
  it("write → read 往返逐字相等（含 selected 与清单顺序）", () => {
    const file = path.join(tempDir(), "tui.db");
    const ledger = {
      version: 1 as const,
      selected: "prod",
      targets: [
        {
          id: "prod",
          name: "生产",
          baseUrl: "http://127.0.0.1:3010",
          token: "tok-a",
          timeoutMs: 3000,
        },
        {
          id: "lab",
          name: "实验室",
          baseUrl: "https://lab.example.net:8443",
          token: "tok-b",
          timeoutMs: 8000,
        },
      ],
    };

    writeLedger(file, ledger);
    expect(readLedger(file)).toEqual(ledger);
  });

  it("父目录不存在就建出来，且目录里除库与它的 WAL 伴随文件外**一个不多**", () => {
    const file = tempDb();
    writeLedger(file, { version: 1, selected: null, targets: [] });

    expect(fs.existsSync(file)).toBe(true);
    expect(strayEntries(path.dirname(file))).toEqual([]);
  });

  it("覆盖写（库已存在）之后同样不残留任何半成品", () => {
    const file = path.join(tempDir(), "tui.db");
    writeLedger(file, { version: 1, selected: null, targets: [] });
    writeLedger(file, { version: 1, selected: "a", targets: [{ ...firstTarget(), id: "a" }] });
    writeLedger(file, {
      version: 1,
      selected: "a",
      targets: [{ ...firstTarget(), id: "a", token: "换过的" }],
    });

    expect(strayEntries(path.dirname(file))).toEqual([]);
    expect(readLedger(file).targets[0].token).toBe("换过的");
  });

  it("库文件在**任何 token 落进去之前**就已经是 0600（次序不是随意的）", () => {
    // ⚠️ 这一条**不**依赖平台：权限位的**实际结果**只在 POSIX 上可判（见下面那条 skipIf），
    // 而「次序」在任何平台上都是同一段代码。故这里用透传式的 spy 记录真实调用序列，
    // 并在 chmod 的**那一刻**量一次大小：0 字节 ⇒ 那一刻里面还没有任何凭据。
    const file = tempDb();
    const events: string[] = [];
    const sizes: Record<string, number> = {};
    const realChmod = fs.chmodSync.bind(fs);
    vi.spyOn(fs, "chmodSync").mockImplementation((target, mode) => {
      events.push(`chmod ${String(target)} ${modeToOct(mode)}`);
      sizes[String(target)] = fs.statSync(String(target)).size;
      realChmod(target, mode);
    });

    writeLedger(file, { version: 1, selected: null, targets: [firstTarget()] });

    expect(events).toEqual([`chmod ${path.dirname(file)} 700`, `chmod ${file} 600`]);
    expect(sizes[file]).toBe(0);
  });

  it("给定一份坏台账 ⇒ 抛，且磁盘一个字节都没动（落盘恒是校验过的形态）", () => {
    const file = path.join(tempDir(), "tui.db");
    writeLedger(file, { version: 1, selected: "prod", targets: [firstTarget()] });
    const before = dump(file);

    // selected 指向不存在的端点：写盘必须拒掉，而不是把这份坏形状落下去
    expect(() =>
      writeLedger(file, { version: 1, selected: "查无此人", targets: [firstTarget()] }),
    ).toThrowError(LedgerError);
    expect(dump(file)).toBe(before);
  });

  // ⚠️ win32 上跳过：NTFS 的 ACL 不由 `chmod` 表达，Node 在 Windows 上只把 mode 映射到只读位，
  // 于是 `mode & 0o777` 在那里恒等于 666 —— 断言它「不是 600」会得到一个**测的是平台**的红。
  // POSIX 上的那一份权限是本模块唯一真正的防线，故只在它成立的地方断言。
  it.skipIf(process.platform === "win32")("POSIX：库文件 0600、目录 0700", () => {
    const file = tempDb();
    writeLedger(file, { version: 1, selected: null, targets: [firstTarget()] });

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });
});

/** 目录里「不是那份库、也不是它的 WAL 伴随文件」的条目；⚠️ WAL 下 `-wal` / `-shm` 是库的一部分，不是残留 */
function strayEntries(dir: string): readonly string[] {
  const known = new Set(["tui.db", "tui.db-wal", "tui.db-shm"]);
  return fs
    .readdirSync(dir)
    .filter((name) => !known.has(name))
    .sort();
}

/** 权限位在断言里一律写成八进制文本（`600` 而不是 `384`） */
function modeToOct(mode: unknown): string {
  return typeof mode === "number" ? mode.toString(8) : String(mode);
}
