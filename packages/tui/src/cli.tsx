/**
 * @fileoverview TUI 组合根：唯一的宿主采集面、全屏接管的时机与进程退出边界
 * @module cli
 * @description
 * 与根仓 `src/cli.ts` / `src/cli-admin.ts` **逐条对称**的五条纪律：
 * - **import 期零副作用**：本文件只导出函数，import 它不会渲染、不会读环境、不会碰终端。
 * - **第一次 `await` 之前快照全部宿主来源**（`env` / `os.homedir()` / 终端**宽高** / 版本号）。
 * - **宿主来源一律当 props 传下去**：`process.*` 是组合根的采集面，叶子模块自己去摸等于把
 *   「这份快照从哪来」从一处拆成 N 处（`@/ui/theme.ts` 文件头那条纪律）。
 * - **退出用 `process.exitCode`，不用 `process.exit()`**：见 {@link main} 里那一段的推导。
 * - **不 fork、不装信号处理、本进程不监听任何端口**：本包是纯客户端。
 *
 * ## 一屏长什么样：**全屏接管**，不是「终端里的几个面板」
 * @description
 * 备用屏幕（`?1049`）由 `render(…, { alternateScreen: true })` 负责（Ink 自己发 `?1049h` / `?1049l`），
 * 光标显隐与鼠标上报由 `@/terminal/screen.ts:enterFullScreen` 负责（**它一条 1049 都不许碰** ——
 * 发两遍会让终端的备用屏幕栈错位，且不会有任何一行报错）。
 * ⚠️ 两者的**先后**不是随意的：{@link enterFullScreen} 必须跑在 `render()` **之前** ——
 * 它写的「开鼠标上报」要早于第一帧被点，而 `?1049h` 会**清屏**，晚于它写的东西仍在同一块屏幕上。
 *
 * ## ⚠️ 收尾有**三条**到达路径，三条都要走同一个幂等收尾
 * @description
 * - `try/finally`（中途抛异常）
 * - `process.once("exit")`（`Ctrl+C` 与任何非正常退出）
 * - `waitUntilExit().then(…)`（正常退出）
 * 收尾两件事，**顺序固定**：先 `unmount()`（让 Ink 把 `?1049l` 与「显示光标」写出去），再撤本包
 * 自己的序列（关鼠标上报 + 显示光标）。⚠️ 顺序反了会怎样：先撤鼠标再 unmount 的话，中间那段
 * Ink 还在重绘，而鼠标已经关了 —— 用户在这几百毫秒里点下去什么都不会发生。
 * ⚠️ 而「把退出码设成什么」在**最后**：见 {@link main} 的推导。
 *
 * ## ⚠️ 入口判据：本包是 ESM，**没有 `require.main`**
 * @description
 * 硬理由写在 `../AGENTS.md`「产物必须是 ESM」：`ink` 有一句顶层 await，esbuild 的 `cjs` 输出格式
 * 表达不了它，故本包 `"type": "module"`。ESM 的等价判据是 `import.meta.url` 与入口路径的
 * `file:` URL 逐字相等。
 *
 * 代价写在文件头而不是藏起来：`require.main` 由 Node 在解析完模块图之后给出，对符号链接、大小写、
 * 路径写法一律容错；而逐字相等**不容错** —— `process.argv[1]` 与 `import.meta.url` 的路径写法只要
 * 不一致就落空，于是进程什么也不做就退出、退出码 0（那是本仓最恨的「零信号」形状）。
 * 实际用到的两种启动方式都相等：npm 的 `bin`（`.cmd` / shim 传进来的是解析后的绝对路径）与
 * `node dist/cli.js`；落空的那几种（`node -e`、被人为改写的 argv）**都不是**本包的入口。
 *
 * @module
 */

import os from "node:os";
import { pathToFileURL } from "node:url";
import { render, type Instance as InkInstance } from "ink";

import { targetsPath } from "@/ledger/index.js";
import { createMouseSource } from "@/terminal/mouse.js";
import { chainRestores, enterFullScreen, type ScreenRestore } from "@/terminal/screen.js";
import { App, FALLBACK_ROWS } from "./app/index.js";

/** 终端宽度拿不到时（重定向到文件、非 TTY）用它；`80` 是窄终端里排版仍然成立的那个数 */
const FALLBACK_COLUMNS = 80;

/** 不接受参数时的那一句（**只说一遍事实与去处**，不解释实现） */
const ARGV_REJECTED =
  "proxy-tui 不接受命令行参数：界面上没有命令。要加一个控制面端点，请在界面上敲 target add。";

/**
 * 标准输入不是终端时的那一句
 * @description 同样**只说事实与去处**。⚠️ 不解释「raw mode」—— 那是实现细节，而操作者要知道的
 * 只是一件事：这是个交互式界面，不能被管道喂。
 */
const NO_TTY_REJECTED =
  "proxy-tui 需要一个交互式终端，而标准输入不是终端（多半是被重定向或用管道喂进来的）。" +
  "请在终端里直接运行它。";

/**
 * 要不要上色
 * @description 判据在组合根（`@/ui/theme.ts` 文件头那条纪律）。`NO_COLOR` 按 no-color.org：
 * **存在且非空串**才禁色（空串 = 没设）。`TERM=dumb` 与 `CI` 一并归它 —— 三者的共同点是
 * 「这台终端没有颜色可显示」，而本包**不上色时全屏一样**（`@/ui/theme.ts` 的 `PLAIN`）。
 */
function colorOf(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env["NO_COLOR"]) return false;
  if (env["TERM"] === "dumb") return false;
  if (env["CI"] !== undefined) return false;
  return true;
}

/**
 * 起 TUI
 * @description 只跑一个进程、只渲染一棵树、退出时按 Ink 的收尾次序走。
 */
export function main(): void {
  // ⚠️ 第一次 await 之前快照全部宿主来源（与 `src/cli.ts` / `src/cli-admin.ts` 同纪律）。
  // ⚠️ 版本号**逐字**读 `process.env.APP_VERSION`：`build.mjs` 的 esbuild `define` 替换的就是
  // **这段文本**，写成 `{ ...process.env }["APP_VERSION"]` 就绕过了替换，产物里会拿到 undefined。
  const env = { ...process.env, APP_VERSION: process.env.APP_VERSION };
  // ⚠️ `os.homedir()` **只在这里调一次**：`@/ledger/path.ts` 把 `env` 与 `homedir` 都做成入参，
  // 正是为了让「台账落在哪儿」这件事只有一处会去问宿主。
  const homedir = os.homedir();
  // ⚠️ `cwd` **不采**：本包没有任何一处按 cwd 解析路径（`XDG_CONFIG_HOME` 的相对值被 `targetsPath`
  // 忽略，`../ledger/path.ts` 文件头有推导）—— 采一份没人用的快照只会给「这份快照从哪来」
  // 多添一个来源。
  const columns = process.stdout.columns ?? FALLBACK_COLUMNS;
  // ⚠️ **行数与列数同样重要**：全屏布局按 `rows` 分「结果区 / 输入区」，缺了它整个主区高度是 0，
  // 界面上只剩两个空框 —— 而这不是「屏太小」，是**根本没拿到屏有多高**。
  const rows = process.stdout.rows ?? FALLBACK_ROWS;
  const color = colorOf(env);
  const version = env["APP_VERSION"] ?? "";
  const ledgerFile = targetsPath(env, homedir);

  if (process.argv.length > 2) {
    // 参数**不是**「忽略掉」：静默忽略就是一次「命令成功、结果没变、零信号」
    process.stderr.write(`${ARGV_REJECTED}\n`);
    process.exitCode = 1;
    return;
  }

  // ⚠️ **在 `render()` 之前**拒掉非 TTY 的标准输入。
  // 不预检的话，Ink 在 `useInput` 的 effect 里抛「Raw mode is not supported…」，那份异常
  // 穿过它的错误边界后除了让 `waitUntilExit()` reject（我们能拿到一句 `message`）之外，
  // **还会让它自己往 stdout 打一份 React 组件栈** —— 二十来行 `commitPassiveMount…`，
  // 没有一个帧属于本仓，而操作者真正要的那句话被埋在最前面。
  // ⚠️ 只判 **stdin**：stdout 被重定向（`proxy-tui > out.txt`）时 Ink 自己会退化成无 ANSI 的
  // 逐帧输出，而终端宽高那两句已经由 {@link FALLBACK_COLUMNS} / {@link FALLBACK_ROWS} 兜住了 ——
  // 那条路是能用的，不该拒。
  // ⚠️ `isTTY` 是 `undefined` 时**按不是终端处理**：Windows 上少数终端不设这个标志，
  // 而「误拒一个能用的终端」比「放一个不能用的进来」更难排查（后者会立刻自己崩）。
  if (process.stdin.isTTY !== true) {
    process.stderr.write(`${NO_TTY_REJECTED}\n`);
    process.exitCode = 1;
    return;
  }

  const out = process.stdout;
  /**
   * 鼠标事件源（**挂在同一个 stdin 上**）
   * @description ⚠️ Ink 把未知 CSI 序列交给 `parseKeypress`，`ESC[<b;x;yM` 在那里既不成键、也没有
   * 上交通道 —— 故本包必须自己挂一个 `data` 监听（`@/terminal/mouse.ts` 文件头的完整推导）。
   * Node 的流把同一份字节**广播**给所有监听器，所以 Ink 与本模块都收得到，而本模块
   * **绝不回灌**（回灌一遍就是双发）。
   * ⚠️ 生命周期**归组合根**：`start()` / `stop()` 各自幂等，而 {@link App} 只订阅、不负责收。
   */
  const mouse = createMouseSource({ stdin: process.stdin, out });
  mouse.start();

  // ⚠️ **全屏接管在 `render()` 之前**（理由见文件头）：`?1049h` 会清屏，所以本模块写的东西
  // 必须在它之前就在这块屏幕上。
  const restoreScreen: ScreenRestore = enterFullScreen(out);
  /**
   * 收尾（**幂等**；三条到达路径都调它，见文件头）
   * @description ⚠️ `mouse.stop()` 在 {@link restoreScreen} **之后**：`?1049l` 之后终端正在恢复，
   * 而关鼠标上报写在那之后仍然有效（DECRST 对任何终端都成立）；反过来（先关鼠标再退备用屏）
   * 则会在 Ink 还在往那块屏上画的那几百毫秒里让用户的点击全部落空。
   */
  const restoreAll: ScreenRestore = chainRestores(restoreScreen, () => {
    mouse.stop();
  });

  /**
   * 兜底：`process.exit()` 那条路上 React 的收尾不会跑
   * @description ⚠️ 这是**唯一**能覆盖「进程被信号打死 / `process.exit()` 被别处调了」的路径。
   * 代价是收尾在这个时机只有同步的字节写入可用 —— 而 {@link ScreenRestore} 与 `mouse.stop()`
   * **只**做 `stdout.write`，不做任何别的（不 `await`、不读文件、不碰 `process.exitCode`），
   * 故它们在这里是完全安全的。⚠️ 也正因如此，本包**任何地方都不许**在收尾里做异步收尾。
   */
  process.once("exit", () => {
    try {
      restoreAll();
    } catch {
      // ⚠️ **`exit` 里抛异常只会打一份栈然后把退出码改成 1** —— 而我们正在收尾，
      // 一个非零退出码会把「正常退出」显示成「出错了」。收尾失败本身就是收尾失败，
      // 覆盖不掉退出码（组合根那一侧在 `finally` 之后才设 `exitCode`）。
    }
  });

  /**
   * Ink 的那个实例（**可能是 `undefined`**：`render()` 自己就抛了的时候）
   * @description ⚠️ 它必须**先**声明：`finish` 是一个函数声明（提升），而 `render()` 抛异常时
   * 那一支会调 `finish`，那时实例还不存在。用 `const` 在 `try` 里声明会让那一支引用到一个
   * 尚未初始化的绑定 → `ReferenceError` 把「收尾失败」换成「收尾本身崩了」。
   */
  let ink: InkInstance | undefined;

  try {
    ink = render(
      <App
        ledgerFile={ledgerFile}
        columns={columns}
        rows={rows}
        color={color}
        version={version}
        mouse={mouse}
      />,
      // ⚠️ **备用屏幕归 Ink**：本包**一个字**的 1049 都不许自己发（见文件头与
      // `@/terminal/screen.ts` 的文件头 —— 发两遍会让终端的备用屏幕栈错位，且零报错）。
      { alternateScreen: true },
    );

    // ⚠️ **先 unmount、等终端恢复，再设退出码**：`process.exit()` 会在 Ink 还没跑完收尾时把进程切断 ——
    // 光标还没 show、`?1049l` 还没写、raw mode 还没关，于是留下一个没有光标的终端、
    // 一个仍在吞鼠标上报的终端，且退出后屏幕停在全屏界面上。`waitUntilExit()` 在 Ink 把最后
    // 那一帧写完之后才 resolve，故此处设 `exitCode` 时终端已经是干净的，随后自然退出。
    void ink.waitUntilExit().then(
      () => {
        finish(0, null);
      },
      (err: unknown) => {
        // 能到这里的是 Ink 的错误边界兜住了什么（渲染期抛错 / 根模式不支持）。
        // 原样打出来，不套「失败: 」—— 那条文案已经自解释（与 `src/cli-admin.ts` 同形状）。
        finish(1, err instanceof Error ? err.message : String(err));
      },
    );
  } catch (err: unknown) {
    // `render()` 自己就抛了（罕见，但 raw mode 不可支持之类会走到这里）：收尾仍然必须走。
    finish(1, err instanceof Error ? err.message : String(err));
  }

  /**
   * 收尾 + 设退出码（**幂等**，三条到达路径共用这一个调用点）
   * @description ⚠️ 顺序是 **`unmount()` → 撤本包的序列 → 设退出码**：
   * - `unmount()` 在**最前**：Ink 拥有 `?1049l` 与它自己那一次「显示光标」，
   *   本包只拥有自己写的那一次光标显隐与鼠标上报。先退备用屏再撤本包的序列，
   *   用户看到的就是「退出后回到原来的画面、光标在、鼠标能拖选了」。
   * - ⚠️ **幂等**：Ink 的 `unmount()` 自带 `isUnmounted || isUnmounting` 守卫，而 `Ctrl+C`
   *   那条路（Ink 自己处理，它内部调的就是 `unmount()`）已经调过一次了 ——
   *   本函数再调一次是 no-op，不会写第二遍 `?1049l`。
   * - 设退出码在**最后**：反了就是「退出码已经是 0 而终端还没恢复」，进程随后自然退出，
   *   而那几百毫秒里用户的键盘还在往一个已经不存在的界面上敲。
   */
  function finish(code: number, message: string | null): void {
    try {
      ink?.unmount();
    } catch {
      // 收尾失败**不**改退出码（理由见下）
    }
    try {
      restoreAll();
    } catch {
      // ⚠️ 收尾失败**不**改退出码：它已经表示「界面正常结束了」，而收尾失败是终端的问题，
      // 覆盖掉它会让一次正常退出显示成「出错了」，而那反而更难排查。
    }
    if (message !== null) process.stderr.write(`${message}\n`);
    process.exitCode = code;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}