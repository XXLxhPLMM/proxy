/**
 * @fileoverview 组合根：宿主采集面、**告警过滤器**、全屏接管的时机、进程退出边界（import 期零副作用）
 */
// ⚠️ **退出只经 `/exit` 与 `/quit`**，`exitOnCtrlC: false` 是这个决定的一半：Ink 的两道门（`App.js:151`
// 退出 / `use-input.js:104` 跳过监听器）都挂在 `exitOnCtrlC` 上，故它**一个字都不许改成 `true`**
// —— 改成 true 就等于给退出加了一条绕过「忙就拒绝」那条守卫的后门。牙齿：`tests/input/exit.test.ts`

import os from "node:os";
import { pathToFileURL } from "node:url";
import { render, type Instance as InkInstance } from "ink";

import {
  chainRestores,
  createMouseSource,
  enterFullScreen,
  type ScreenRestore,
} from "@/services/terminal/index.js";
import { installSqliteWarningFilter } from "@/services/index.js";
import { closeLedgerDb, dbPath } from "@/services/config/index.js";
import { App } from "@/AppState.js";
import { FALLBACK_ROWS } from "@/store/index.js";

/** 终端宽度拿不到时（重定向到文件、非 TTY）用它 */
const FALLBACK_COLUMNS = 80;

const ARGV_REJECTED =
  "proxy-tui 不接受命令行参数：界面上没有命令。要加一个控制面端点，请在界面上敲 target add。";

/** 标准输入不是终端时的那一句 */
const NO_TTY_REJECTED =
  "proxy-tui 需要一个交互式终端，而标准输入不是终端（多半是被重定向或用管道喂进来的）。" +
  "请在终端里直接运行它。";

/** 禁色判据：`NO_COLOR` 存在且非空 / `TERM=dumb` / `CI`，三者任一（按 no-color.org） */
function colorOf(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env["NO_COLOR"]) return false;
  if (env["TERM"] === "dumb") return false;
  if (env["CI"] !== undefined) return false;
  return true;
}

/**
 * 退出边界要用的那几件事（**全部注入**：走真 TTY 才看得到的那一半在这里是字节与计数器，
 * 而「注入」这件事就是为「退出码是 0」与「连续两次调用」能被逐字断言）
 */
export interface ExitSteps {
  /** Ink 自己那次 `unmount`（⚠️ `?1049l` 与显示光标归它，故它必须排在最前面） */
  readonly unmount: () => void;
  /** 撤掉**本包**发的那些序列（`chainRestores` 的产物；⚠️ 它自带 `done` 守卫，故重复调用是空操作） */
  readonly restore: ScreenRestore;
  readonly releaseWarnings: () => void;
  readonly closeLedgerDb: () => void;
  readonly writeStderr: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}

/** 收尾那四步，**每步各兜各的**（⚠️ 捆进一个 try 的话头一步抛了会把库句柄留在 WAL 上没人收） */
function runTeardown(steps: ExitSteps): void {
  for (const step of [steps.unmount, steps.restore, steps.releaseWarnings, steps.closeLedgerDb]) {
    try {
      step();
    } catch {
      // ⚠️ 不改退出码：那会把一次「正常退出」显示成「出错了」
    }
  }
}

/**
 * 收尾 + 设退出码（**幂等**：每一步自己带守卫，故第二次调用是空操作）
 * @description 三条到达路径（`/exit` 的命令 / `waitUntilExit()` / `render()` 自己抛）共用这一个调用点
 */
export function exitBoundary(steps: ExitSteps): (code: number, message: string | null) => void {
  return (code, message) => {
    // ⚠️ 收库必须在**撤掉过滤器之后**、而两者都在 `unmount()` 之后：库里存着 provider 凭据，
    // 撤得太早就有一个真的 warning 打出去，而它那时已经没地方可去了
    runTeardown(steps);
    if (message !== null) steps.writeStderr(`${message}\n`);
    // ⚠️ **最后**才设退出码：`process.exit()` 会在收尾完成前把进程切断
    steps.setExitCode(code);
  };
}

export function main(): void {
  // ⚠️ 必须是 `main()` 的第一句：驱动在**第一次真正需要**时才加载 `node:sqlite`，而那条
  // `ExperimentalWarning` 打在 stderr 上会把全屏首帧糊掉 —— 过滤器晚一步装就来不及了。
  const releaseWarnings = installSqliteWarningFilter();
  // ⚠️ 版本号**逐字**读 `process.env.APP_VERSION`：`build.mjs` 的 esbuild `define` 替换的就是这段
  // 文本，写成 `{ ...process.env }["APP_VERSION"]` 就绕过了替换（产物里是 undefined）
  const env = { ...process.env, APP_VERSION: process.env.APP_VERSION };
  const homedir = os.homedir();
  const columns = process.stdout.columns ?? FALLBACK_COLUMNS;
  const rows = process.stdout.rows ?? FALLBACK_ROWS;
  const color = colorOf(env);
  const version = env["APP_VERSION"] ?? "";
  const ledgerFile = dbPath(homedir);

  if (process.argv.length > 2) {
    // 参数不是「忽略掉」：静默忽略就是一次「命令成功、结果没变、零信号」
    process.stderr.write(`${ARGV_REJECTED}\n`);
    process.exitCode = 1;
    return;
  }

  // ⚠️ 必须在 `render()` 之前拒掉非 TTY 的 stdin：不预检的话 Ink 在 `useInput` 的 effect 里抛，那份
  // React 组件栈会盖住操作者要看的提示（`isTTY` 为 `undefined` 一律按不是终端处理）
  if (process.stdin.isTTY !== true) {
    process.stderr.write(`${NO_TTY_REJECTED}\n`);
    process.exitCode = 1;
    return;
  }

  const out = process.stdout;
  // ⚠️ Ink 的 `parseKeypress` 不认 `ESC[<b;x;yM`，故本包自己挂 `data`；绝不回灌（回灌即双发）
  const mouse = createMouseSource({ stdin: process.stdin, out });
  mouse.start();

  // ⚠️ 全屏接管必须在 `render()` 之前（`?1049h` 清屏）；⚠️ 备用屏幕归 Ink，本包一条 1049 都不许发
  const restoreScreen: ScreenRestore = enterFullScreen(out);
  // ⚠️ `mouse.stop()` 排在 `restoreScreen` 之后：反过来会让 Ink 还在重绘的那几百毫秒里点击落空
  const restoreAll: ScreenRestore = chainRestores(restoreScreen, () => {
    mouse.stop();
  });

  // ⚠️ 必须先声明：`render()` 抛异常那一支会调 `finish`，那时实例还不存在
  let ink: InkInstance | undefined;
  const steps: ExitSteps = {
    unmount: () => ink?.unmount(),
    restore: restoreAll,
    releaseWarnings,
    closeLedgerDb,
    writeStderr: (text) => {
      process.stderr.write(text);
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };

  /** 兜底：`process.exit()` 那条路上 React 的收尾不会跑；⚠️ 收尾在这个时机只有同步字节写入可用，故 `ScreenRestore` 与 `mouse.stop()` 只 `write` */
  process.once("exit", () => {
    runTeardown(steps);
  });

  const finish = exitBoundary(steps);

  try {
    ink = render(
      <App
        ledgerFile={ledgerFile}
        columns={columns}
        rows={rows}
        color={color}
        version={version}
        mouse={mouse}
        // ⚠️ **退出码 0**（正常退出）：`/exit` 与 `/quit` 的唯一去处就是这一个幂等 `finish`
        exit={() => finish(0, null)}
      />,
      // ⚠️ **`exitOnCtrlC: false` 不许改**（理由在文件头：退出只经命令，而这一格是那个决定的一半）
      { alternateScreen: true, incrementalRendering: true, exitOnCtrlC: false },
    );

    // ⚠️ 先 unmount、等终端恢复，再设退出码（`process.exit()` 会在 Ink 收尾完成前把进程切断）
    void ink.waitUntilExit().then(
      () => {
        finish(0, null);
      },
      (err: unknown) => {
        finish(1, err instanceof Error ? err.message : String(err));
      },
    );
  } catch (err: unknown) {
    // `render()` 自己就抛了（raw mode 不可支持之类）：收尾仍然必须走
    finish(1, err instanceof Error ? err.message : String(err));
  }
}

// ⚠️ 入口判据（ESM 无 `require.main`）：`import.meta.url` 与 `process.argv[1]` 的 `file:` URL 逐字相等
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
