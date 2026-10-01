/**
 * @fileoverview `proxy-cli` 的**输出与退出码**面（纯格式化，零 IO）
 * @module admin/out
 * @description
 * 本模块是 CLI 与「人」之间唯一的接缝：所有写入都经 `AdminIo` 注入的三个回调，因此命令层
 * 没有任何一处 `console` / `process.stdout`（`.eslintrc.js` 的 `no-console` 在本目录同样是
 * `error`，而**更重要的是**：命令层要能在单测里断言输出，捕获 `console` 是一种会漏（异步
 * 交错、格式化被重定向）的间接做法）。
 *
 * 本目录的另一半（数据源操作）在 `@/ops/`：那边只出结构化数据与 `OpsError`，一个字都不渲染。
 *
 * **退出码只有三个**，理由见 `./args.ts` 文件头：`0` 成功 / `1` 操作失败 / `2` 用法错。
 *
 * @module
 */

/** 写入面：三个回调分别对应 stdout / stderr / 「操作成功并改变了数据」 */
export interface AdminIo {
  /** 正文（表格、明细、帮助） */
  readonly write: (line: string) => void;
  /** 诊断与错误（**警告与错误走这里**，好让 `proxy-cli ... > out.txt` 只留下结果） */
  readonly warn: (line: string) => void;
  /**
   * 一条「已经改完数据」的提示。
   * @description
   * 刻意与 `warn` 分开：成功提示是**给人看**的，而人通常在管道或重定向里跑脚本，那行提示
   * 会污染下游。分开之后 `write` 的输出是干净的、可直接喂给 `jq` / `awk`。
   */
  readonly changed: (line: string) => void;
}

/** 进程退出码 */
export const EXIT_OK = 0;
/** 操作失败（`@/ops` 抛出的 `OpsError`：读不到、写不了、形状非法、目标不存在……） */
export const EXIT_FAILED = 1;
/** @see ./args.ts:AdminUsageError */
export const EXIT_USAGE = 2;

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/**
 * 字节数的可读形态：**始终带上精确字节数**
 * @description
 * 「1.0 GiB」单独出现是不能用来对账的——配额是不是 1073741824，只有精确值能回答。所以两种
 * 形态都给，且**精确值在前**（它才是那个会去比对的数）。
 *
 * @param bytes - 字节数
 * @example formatBytes(1073741824) // => "1073741824 B (1.0 GiB)"
 * @example formatBytes(0) // => "0 B"
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return `${bytes}`;
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${bytes} B (${value.toFixed(1)} ${UNITS[unit]})`;
}

/**
 * 渲染一张左对齐的定宽表
 * @description
 * **不用 `console.table`**：它自己决定列宽与边框，且在没有 TTY 时格式会变——同一个命令在
 * 终端里好看、被 `awk` 处理时难用。自己算列宽的那 10 行换来「输出在任何地方都长得一样」。
 *
 * ⚠️ 本目录**独占**这张表：面向人的那个界面用它，而面向机器的那一层（JSON）自己排自己的版。
 * 数据源操作层（`@/ops/`）不 import 它——那边出的是结构化数据，本来就不该有列宽这回事。
 *
 * @param headers - 表头
 * @param rows - 行（每行长度必须与表头一致）
 */
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((h, i) =>
    rows.reduce((w, row) => Math.max(w, (row[i] ?? "").length), h.length),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i])))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

/** 一组「只有值」的配置事实 */
export function renderPairs(pairs: readonly (readonly [string, string])[]): string {
  const width = pairs.reduce((w, [k]) => Math.max(w, k.length), 0);
  return pairs.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join("\n");
}

/** `renderSections` 的一个小节：坐标 + 它那一节的条目 */
export interface AdminSection {
  /**
   * 小节的坐标（**不含条数**——条数是本模块排的，见 `renderSections`）
   * @description
   * 用**点分**形式（`upstream.whitelist`），与 `OpsChange.message` 里那条坐标、账号表字段名
   * `acl.target.whitelist` 是同一个词——同一份数据坐标在一个工具里只该有一种写法。
   */
  readonly title: string;
  /** 条目；空数组 = 这一节是空的（标题上的 `0 条` 就是它的全部信息） */
  readonly items: readonly string[];
}

/**
 * 渲染若干「标题 + 条目」小节：**标题行带条数，条目逐行缩进**
 * @description
 * 一条目一行的理由是**归属**：条目的主人就在它**上面那一行**。对照 `renderTable` 的一格 N 条目 ——
 * 那格宽过终端宽度时软换行，组名列落到**别的视觉行**上，于是「这条在哪个名单里」在一屏之内
 * 答不出来，而那正是 `acl show` 唯一的职责。
 *
 * ⚠️ **刻意不按终端宽度重排**：宽度得问 `process.stdout.columns`，而本模块是零 `process.*` 的纯格式化
 * （见 `@module`），且「输出在任何地方都长得一样」是 `renderTable` 明确要的性质。定宽排在任何终端
 * 宽度下都成立；宽终端上多出来的是右边空白，而不是被换行打散的归属。
 *
 * ⚠️ **空小节照样出标题行**：省掉它，「空的」与「没列出来的」就渲染成同一个东西（与 `renderPairs`
 * 那条「空串保持空串」同源：两种不同的事实不许渲染成同一个值）。
 *
 * @param sections - 小节（**顺序即呈现顺序**，本模块不排序）
 * @example renderSections([{ title: "target.whitelist", items: ["a.com"] }])
 * // => "target.whitelist  1 条\n  a.com"
 */
export function renderSections(sections: readonly AdminSection[]): string {
  const width = sections.reduce((w, s) => Math.max(w, s.title.length), 0);
  return sections
    .flatMap((s) => [
      `${s.title.padEnd(width)}  ${s.items.length} 条`,
      ...s.items.map((item) => `  ${item}`),
    ])
    .join("\n");
}