/**
 * `/targets` 那一档：控制面清单的增删改查（增删改全在这个弹窗里，而命令表**不留**那一族）
 * @description ⚠️ 这一档**不发一个请求**（台账是本机那一份 SQLite），于是「零请求」是它天然的一条判据。
 * ⚠️ 键位、槽位序与台账读面见 `./_shared.ts`。
 */

import { describe, expect, it, vi } from "vitest";

import { CTRL_A, CTRL_D, CTRL_E, DOWN, ENTER, ESC, TAB, UP, mount, typed } from "../input/_shared.js";
import {
  controlLedger,
  modalGeo,
  openCommand,
  rowPoint,
  seedSession,
  strip,
  type ControlTarget,
} from "./_shared.js";
import { readLedger } from "@/services/config/index.js";
import type { WindowSlot } from "@/lib/geometry.js";

vi.hoisted(() => {
  process.env["FORCE_COLOR"] = "3";
});

/** 一档弹窗的槽位串（⚠️ **就是那一列**：说明行在清单为空时才占第 0 槽） */
function slots(count: number): readonly WindowSlot[] {
  return count === 0
    ? [{ kind: "note" }]
    : Array.from({ length: count }, (): WindowSlot => ({ kind: "row" }));
}

/** 台账里那些显示名（⚠️ 判据读**显示名**而不是 `id`：屏上画的是名字，而 id 是台账内部那一份键） */
function namesOf(file: string): readonly string[] {
  return readLedger(file).targets.map((one) => one.name);
}

const TWO: readonly ControlTarget[] = [
  { id: "live-ok", name: "live-ok", baseUrl: "http://127.0.0.1:1", token: "t0ken", timeoutMs: 200 },
  { id: "other", name: "other", baseUrl: "http://127.0.0.1:2", token: "t0ken", timeoutMs: 200 },
];

describe("/targets：增删改查都在这个弹窗里", () => {
  it("⚠️ 弹窗逐行给出**链接**与超时，而高亮默认落在当前会话连的那台上", async () => {
    const file = controlLedger(TWO);
    seedSession(file);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("targets"));
    const output = strip(await ui.finish());
    expect(output).toContain("控制面（2）");
    expect(output).toContain("http://127.0.0.1:2");
    expect(output).toContain("超时 200ms");
    // ⚠️ **正向对照**：可选项就是清单那两行（不是「第几行」—— 说明行不占那个计数）
    expect(modalGeo(slots(2)).windowRows).toHaveLength(2);
    // ⚠️ 点第 2 行 ⇒ 高亮挪过去（点行只挪高亮，把「接到会话」留给 `Enter`）
    expect(rowPoint(slots(2), 1)).toEqual({
      x: modalGeo(slots(2)).windowRows[1]!.x + 2,
      y: modalGeo(slots(2)).windowRows[1]!.y + 1,
    });
  });

  it("⚠️ `Enter` = 把高亮那一台**接到当前会话**上，而关窗", async () => {
    const file = controlLedger(TWO);
    seedSession(file);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("targets"));
    // ⚠️ 高亮默认落在第 0 台（`live-ok`），`↓` 一次到 `other` —— 接的必须是**高亮那一个**
    await ui.feed([DOWN, ENTER]);
    const output = strip(await ui.finish());
    expect(output).not.toContain("控制面（2）");
    // ⚠️ **落盘那一侧**：台账的 `selected` 跟着换（而清单两台都还在）
    expect(readLedger(file).selected).toBe("other");
    expect(namesOf(file)).toEqual(["live-ok", "other"]);
  });

  it("⚠️ 表单校验不过 ⇒ **不关窗**，而说明行说清**哪一格**不对（且**不转述用户输入**）", async () => {
    const file = controlLedger([]);
    seedSession(file);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("targets"));
    await ui.feed([CTRL_A]);
    // ⚠️ 只填名字就提交 ⇒ 名字过了而地址没过
    await ui.feed([...typed("zzq"), ENTER]);
    const output = strip(await ui.finish());
    // ⚠️ **不转述用户输入**：说明会落进可滚动的结果区，而「zzq」是用户刚敲的 ——
    // ⚠️ 判据**只落在说明那一行**上（表单那一格本来就画着用户敲的字，那是它的职责）
    const note = output.split("\n").find((line) => line.includes("地址不能为空"));
    expect(note).toBeDefined();
    expect(note).not.toContain("zzq");
    // ⚠️ **不关窗**：标题还在（关掉的话窗口那一块整个消失）
    expect(output).toContain("新增控制面");
    // ⚠️ **正向对照**：台账一个字节都没变（校验不过就不许有副作用）
    expect(namesOf(file)).toEqual([]);
  });

  it("⚠️ 填满四格按 `Enter` ⇒ **一次落盘整份表单**（不是提交当前字段）", async () => {
    const file = controlLedger([]);
    seedSession(file);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("targets"));
    await ui.feed([CTRL_A]);
    // ⚠️ 四格顺序：名字 / 地址 / token / 超时（超时那格预填了缺省，插入符落在各格末尾）
    await ui.feed([...typed("zzq"), TAB]);
    await ui.feed([...typed("http://127.0.0.1:9"), TAB]);
    await ui.feed([...typed("t0k3n"), TAB]);
    await ui.feed([ENTER]);
    const output = strip(await ui.finish());
    // ⚠️ **落盘**：清单里有了那台，而 `selected` 指向它（`upsertTarget` 就是那个行为）
    expect(namesOf(file)).toEqual(["zzq"]);
    expect(readLedger(file).targets[0]?.baseUrl).toBe("http://127.0.0.1:9");
    expect(readLedger(file).targets[0]?.timeoutMs).toBe(5000);
    // ⚠️ **凭据永不明文上屏**：屏上从来没有那串 token
    expect(output).not.toContain("t0k3n");
  });

  it("⚠️ `Ctrl+D` **按两次**才删（第一次是**待确认**，而那一行仍在屏上）", async () => {
    const file = controlLedger(TWO);
    seedSession(file);
    // ⚠️ **第一段**：清单一个都没少
    const once = await mount({ interactive: false, ledgerFile: file });
    await once.feed(openCommand("targets"));
    await once.feed([UP, CTRL_D]);
    expect(strip(await once.finish())).toContain("other");
    expect(namesOf(file)).toEqual(["live-ok", "other"]);
    // ⚠️ **第二段**：真删
    const twice = await mount({ interactive: false, ledgerFile: file });
    await twice.feed(openCommand("targets"));
    await twice.feed([UP, CTRL_D, CTRL_D]);
    await twice.finish();
    // ⚠️ **默认高亮落在当前会话连的那台上**（`live-ok`），而 `↑` 已经在顶 ⇒ 走到底停住 ⇒ 删的就是它
    expect(namesOf(file)).toEqual(["other"]);
  });

  it("⚠️ `Ctrl+E` 开**编辑**表单，而 `token` 那一格**恒是掩码**（落盘之后不回显真值）", async () => {
    const file = controlLedger(TWO);
    seedSession(file);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("targets"));
    await ui.feed([CTRL_E]);
    const opened = strip(await ui.finish());
    expect(opened).toContain("编辑控制面");
    // ⚠️ **凭据那一格**：掩码在、真值不在（`redactTarget` 是唯一的打码出口）
    expect(opened).toContain("••••");
    expect(opened).not.toContain("t0ken");
  });

  it("⚠️ `Esc` 关窗，而**第一下**只取消待确认删除（挂着的「确认」比误删更可怕）", async () => {
    const file = controlLedger(TWO);
    seedSession(file);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("targets"));
    // ⚠️ 先挂上一个待确认，再按 `Esc` ⇒ **清单没变，而那一次 `Esc` 没有关窗**
    await ui.feed([UP, CTRL_D, ESC]);
    const output = strip(await ui.finish());
    expect(namesOf(file)).toEqual(["live-ok", "other"]);
    expect(output).toContain("控制面（2）");
    // ⚠️ **正向对照**：再来一下 `Esc` 才关窗（两级合成一个键，而差别由「有没有挂着待确认」回答）
    const closed = await mount({ interactive: false, ledgerFile: file });
    await closed.feed(openCommand("targets"));
    await closed.feed([UP, CTRL_D, ESC, ESC]);
    expect(strip(await closed.finish())).not.toContain("控制面（2）");
  });

  it("⚠️ 台账为空时窗口**仍然开**，并说清怎么加一个", async () => {
    const file = controlLedger([]);
    seedSession(file);
    const ui = await mount({ interactive: false, ledgerFile: file });
    await ui.feed(openCommand("targets"));
    const output = strip(await ui.finish());
    expect(output).toContain("控制面（0）");
    expect(output).toContain("Ctrl+A");
    // ⚠️ **正向对照**：那个「0 个」是**内容**，而弹窗真的开着（说明行占了第 0 槽）
    expect(modalGeo(slots(0)).windowRows).toHaveLength(0);
  });
});