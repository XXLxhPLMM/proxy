/**
 * `tests/modal/` 各档共用的一圈东西：起一个弹窗、算弹窗里某一格的落点、造台账与假控制面
 * @description ⚠️ **坐标一律从 `@/lib/geometry` 现算**（`slotPointOf`），不写死屏幕行号 ——
 * 写死的后果是「几何一改、点就点空了而断言照旧绿」。⚠️ **槽位串就是那一列**（与
 * `@/components/layout/window-slots.js:slotsOf` 同序同长），而判据取 `windowRows` / `windowChecks` /
 * `windowInputs` 那些**投影**：它们只含自己那一档，于是下标就是「第几个可选项」。
 * ⚠️ **不带 `.test.ts` 后缀的那些不会被 vitest 收集**。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { COLUMNS, ROWS, typed } from "../input/_shared.js";
import { geometry, SIDEBAR_WIDTH, type Geometry, type WindowSlot } from "@/lib/geometry.js";
import {
  saveSession,
  upsertProvider,
  writeLedger,
  writeProviderModels,
  writeSessionModel,
  type Ledger,
  type ModelRecord,
  type ProviderRecord,
} from "@/services/config/index.js";

/** 一个空台账的路径（`readLedger` 对**不存在**的库返回空台账，故这里不必先建库） */
export function emptyLedger(): string {
  return join(mkdtempSync(join(tmpdir(), "swain-tui-modal-")), "tui.db");
}

/** 台账里的一条控制面（⚠️ 单独起个类型名：判据要引它时不必把 `Ledger` 那一份拉进来） */
export type ControlTarget = Ledger["targets"][number];

/** 一份有控制面的台账（⚠️ 端点指向一个**不存在的**端口：探活会失败，而那一档正好是「未知」） */
export function controlLedger(targets: readonly ControlTarget[] = [
  { id: "live-ok", name: "live-ok", baseUrl: "http://127.0.0.1:1", token: "t0ken", timeoutMs: 200 },
]): string {
  const file = emptyLedger();
  writeLedger(file, { version: 1, selected: targets[0]?.id ?? null, targets: [...targets] });
  return file;
}

/** 造会话（⚠️ **会话与模型选择都要先落盘** —— 改一个不存在的 `id` 是一次成功的 no-op） */
export function seedSession(file: string, id = "s1", name = "会话 1"): void {
  saveSession(file, { id, name, createdAt: 1, updatedAt: 1 });
}

/** 造一个提供商（⚠️ 凭据那一位是真值，而屏上读回来的恒是掩码） */
export function seedProvider(
  file: string,
  record: Partial<ProviderRecord> & { readonly id: string },
): void {
  upsertProvider(file, {
    name: record.id,
    baseUrl: "https://p.invalid/v1",
    api: "openai",
    apiKey: "sk-x",
    ...record,
  });
}

/** 造某个提供商的模型清单（⚠️ `modelId` 可含 `/` —— 存储键按**第一个** `/` 切） */
export function seedModels(
  file: string,
  providerId: string,
  models: readonly (readonly [string, string] | readonly [string, string, boolean])[],
): void {
  const rows: ModelRecord[] = models.map(([modelId, label, pinned]) => ({
    providerId,
    modelId,
    label,
    pinned: pinned === true,
  }));
  writeProviderModels(file, providerId, rows);
}

/** 给某一个会话选一个模型（⚠️ 那两列**单独一写**，而不进会话的身份定义） */
export function seedModelChoice(file: string, ref: string, sessionId = "s1"): void {
  writeSessionModel(file, sessionId, ref, "medium");
}

/** 敲一条命令打开弹窗（⚠️ **一个字都不留**在结果区 —— 弹窗自己回答「里面有哪些」） */
export function openCommand(name: string): string[] {
  return [...typed(`/${name}`), "\r"];
}

/** 那一档弹窗的几何（⚠️ 喂的槽位串**就是**那一列，于是投影里的下标就是「第几个可选项」） */
export function modalGeo(slots: readonly WindowSlot[]): Geometry {
  return geometry({
    columns: COLUMNS,
    rows: ROWS,
    sidebarWidth: SIDEBAR_WIDTH,
    sessionCount: 1,
    sessionsTop: 0,
    input: "",
    paletteCount: 0,
    window: slots,
    windowCloseHint: true,
    menu: null,
  });
}

/** 那一档的**可选项**投影（`row` / `check` 各自一份 —— 三个可选面不与彼此混） */
function slotsOf(slots: readonly WindowSlot[], kind: WindowSlot["kind"]): readonly WindowSlot[] {
  return slots.filter((one) => one.kind === kind);
}

/** 弹窗里**第 `at` 个可选项**的 SGR 落点（**1-based**；判据取自几何的投影，不写死屏幕行号） */
export function rowPoint(slots: readonly WindowSlot[], at: number): { x: number; y: number } {
  const rect = modalGeo(slots).windowRows[at];
  if (rect === undefined) throw new Error(`弹窗里没有第 ${String(at)} 个可选行`);
  return { x: rect.x + 2, y: rect.y + 1 };
}

/** 弹窗里**第 `at` 个勾选行**的 SGR 落点（**1-based**） */
export function checkPoint(slots: readonly WindowSlot[], at: number): { x: number; y: number } {
  const rect = modalGeo(slots).windowChecks[at];
  if (rect === undefined) throw new Error(`弹窗里没有第 ${String(at)} 个勾选行`);
  return { x: rect.x + 2, y: rect.y + 1 };
}

/** 弹窗里**第 `at` 个文本框**里「文字那一格」的 SGR 落点（⚠️ 整格含提示符，落点要按文字那一格算） */
export function inputPoint(slots: readonly WindowSlot[], at: number): { x: number; y: number } {
  const rect = modalGeo(slots).windowInputTexts[slotsOf(slots, "input").findIndex((_, i) => i === at)];
  if (rect === null || rect === undefined) throw new Error(`弹窗里没有第 ${String(at)} 个文本框`);
  return { x: rect.x + 1, y: rect.y + 1 };
}

/** 弹窗里**第 `at` 个下拉**的 SGR 落点（**1-based**） */
export function selectPoint(slots: readonly WindowSlot[], at: number): { x: number; y: number } {
  const rect = modalGeo(slots).windowSelects[at];
  if (rect === undefined) throw new Error(`弹窗里没有第 ${String(at)} 个下拉`);
  return { x: rect.x + 2, y: rect.y + 1 };
}

/** 一个控制面的账号清单（⚠️ **注入进来的**：控制面拨号点在替身后面，故「没选中控制面」与「它答错了」分得开） */
export function usersBody(names: readonly string[]): unknown {
  return {
    accounts: names.map((username) => ({
      username,
      password: { set: true },
      disabled: false,
      quota: { bytes: 1024 },
      expiresAtIso: null,
    })),
  };
}

/** 一条 SGR 鼠标报告（**1-based 坐标**，与真终端一致） */
export function report(button: number, column: number, row: number): string {
  return `\u001B[<${button};${column};${row}M`;
}

/**
 * 假控制面（⚠️ **按 URL 分流**而不是按次数：探活也在发请求，故按次数分流整个错位）
 * @description 记下**每个请求的方法与路径**，于是「一个请求都不许发」这条判据有形状可查。
 */
export function stubControlPlane(
  answer: (url: string, init: { readonly method?: string }) => unknown,
): { readonly calls: () => readonly { url: string; method: string }[]; readonly restore: () => void } {
  const calls: { url: string; method: string }[] = [];
  const stub = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    const body = answer(url, init ?? {});
    if (body === undefined) return { ok: false, status: 0, text: async () => "" };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
  vi.stubGlobal("fetch", stub);
  return {
    calls: () => calls,
    restore: (): void => {
      vi.unstubAllGlobals();
    },
  };
}

/** 「控制面只回了这一句」那一份假答案（写操作：`changed` 是**成功的 no-op**而不是错误） */
export const CHANGED = { changed: true, message: "写进去了" };

/** OpenAI 形状的模型清单（⚠️ `/models` 端点的返回体是 `{ data: [{ id }] }`） */
export function modelListing(ids: readonly string[]): unknown {
  return { data: ids.map((id) => ({ id })) };
}

/** 那一档「先证它真的开着」的自检（⚠️ **零变化的判据必须配它**，否则什么都没渲染也绿） */
export function expectPopup(output: string, needle: string): void {
  expect(strip(output)).toContain(needle);
}

/** 去掉转义序列（⚠️ 逐字符扫而不是一条正则：`no-control-regex` 是本包的纪律） */
export function strip(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "\u001B") {
      out += ch;
      i += 1;
      continue;
    }
    const bracket = text.indexOf("[", i);
    if (bracket === -1 || bracket > i + 2) {
      out += ch;
      i += 1;
      continue;
    }
    let end = bracket + 1;
    while (end < text.length && !/[A-Za-z]/u.test(text[end] as string)) end += 1;
    i = end < text.length ? end + 1 : text.length;
  }
  return out;
}

/** 判据自检：探测器坏掉时它恒红（根 `AGENTS.md`「写护栏时」那条） */
describe("这一档的判据自检", () => {
  it("`strip` 真的去掉了 SGR，而正文一个字都不许丢", () => {
    expect(strip("\u001B[1m● 会话 1\u001B[22m")).toBe("● 会话 1");
    expect(strip("❯ /help")).toBe("❯ /help");
  });

  it("槽位串 ⇒ 投影的下标就是「第几个可选项」（分组标题不占那个计数）", () => {
    const slots: WindowSlot[] = [{ kind: "group" }, { kind: "row" }, { kind: "row" }];
    expect(slotsOf(slots, "row")).toHaveLength(2);
    // ⚠️ **正向对照**：几何真的算出了两个可选项（零个的话「下标对得上」恒真）
    expect(modalGeo(slots).windowRows).toHaveLength(2);
    expect(modalGeo(slots).windowGroups).toHaveLength(1);
  });
});