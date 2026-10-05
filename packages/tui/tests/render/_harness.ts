/**
 * 本目录各档共用的**造帧那一半**：从 `../layout/_harness.js` 转发那一套「喂 props + 取帧」，
 * 外加**渲染一个裸元素**的那一件（气泡那一块不是 `RegionProps` 的形状，它拿的是 `text` + `width` + `theme`）。
 *
 * ⚠️ **转发而不是搬**：`tests/layout/_harness.ts` 与 `_probe.ts` 是全 `tests/` 一份的造帧与读帧，
 * 而它们**历史上住在 `tests/layout/`** —— 跨目录引一次比搬动十来个档的 import 便宜。
 * ⚠️ 而**正解是把这两个模块提到 `tests/` 根**（它们现在的收件门槛是十来个档，两边都是「本来就在错的地方」）。
 * ⚠️ 转发清单**只列本目录真用到的那几个**（判据是「收件门槛是两个以上档真用到」）；要用别的
 * 从 `../layout/_harness.js` 直接引，不要往这里加一个「总有一天用得上」的转发。
 * ⚠️ 唯一不在转发清单里的是 `renderElement` —— 它只被本目录用（气泡那一块量不到整屏那一档）。
 *
 * ⚠️ **每一档仍要自带 `vi.hoisted` 那一句**：`FORCE_COLOR` 必须在 ink（因而 chalk）被 import 之前设好，
 * 而 `vi.hoisted` 只在**入口模块**里被提升到 import 之前 —— 放进这里就是一句普通调用，跑在 ink 之后。
 *
 * @module tests/render
 */

import { PassThrough } from "node:stream";
import { render } from "ink";
import { type ReactElement } from "react";
import { stripAnsi } from "../layout/_harness.js";

export { geoInput, props, renderRaw, renderScreen, stripAnsi } from "../layout/_harness.js";
export {
  bgAtColumn,
  bgSgrOf,
  columnOfIndex,
  fgSgrOf,
  indexOfText,
  rawIndexOfColumn,
  sgrColorAt,
} from "../layout/_probe.js";

/** 一个假 TTY（⚠️ Ink 只要求 `isTTY` / `columns` / `rows` / `write`；**每次取帧各起各的流**） */
function fakeStdout(columns: number, rows: number): PassThrough & {
  columns: number;
  rows: number;
  isTTY: boolean;
} {
  const stream = new PassThrough() as PassThrough & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };
  stream.columns = columns;
  stream.rows = rows;
  stream.isTTY = true;
  return stream;
}

/**
 * 真渲染**一个裸元素**，返回**带 ANSI 的原始帧**（按屏行号索引，空行留着）
 * @description 为什么需要它：气泡那一块**不是 `RegionProps` 的形状**（它拿 `text` + `width` + `theme`），
 * 而行模型今天还没有「用户消息」那一档 ⇒ 走 `@/app.js` 的整屏渲染量不到它。
 * ⚠️ 判据因此**只量那一个组件**：跨整屏去找那一格的话，行模型那一档落地之前它恒不存在。
 */
export async function renderElementRaw(
  element: ReactElement,
  columns: number,
  rows: number,
): Promise<readonly string[]> {
  const stdout = fakeStdout(columns, rows);
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const stdin = new PassThrough();
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
  });
  // ⚠️ **`interactive: false`**：它让 Ink 不排增量帧，而是在 `unmount()` 时把最后一帧一次性写出来，
  // 故缓冲里恰好一份纯文本帧（`tests/layout/_harness.ts` 那一档踩过两次「切出一帧半屏」）
  const instance = render(element, {
    stdout: stdout as never,
    stdin: stdin as never,
    patchConsole: false,
    exitOnCtrlC: false,
    interactive: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  instance.unmount();
  await new Promise((resolve) => setTimeout(resolve, 40));
  return output.split("\n");
}

/** 与 {@link renderElementRaw} 只差「剥 ANSI」—— ⚠️ 着色那几组断言要读 SGR，故它们读**原始**那一份 */
export async function renderElement(
  element: ReactElement,
  columns: number,
  rows: number,
): Promise<readonly string[]> {
  return (await renderElementRaw(element, columns, rows)).map((line) => stripAnsi(line));
}