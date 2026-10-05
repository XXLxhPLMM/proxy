/**
 * 退出**那一跳**：命令落地 ⇒ `request-exit` ⇒ 注入点被调；以及组合根那个幂等 `finish(0, null)`
 *
 * @description
 * ⚠️ 这一档与 `exit.test.ts` **分工**：那一档从屏上那一帧的字节读「退没退成」，而这一档读的是
 * **最后一跳本身** ——「`request-exit` 真的落到了注入点上」与「退出码真的是 0 且收尾幂等」。
 * ⚠️ 后者**没有真 TTY 就验不到**：`process.exitCode` 只能在组合根那一格里设，而组合根要一个
 * 交互式终端才起得来。故判据是「`exitBoundary` 的出参真的被以 `code = 0` 调到」这个**注入点**，
 * 而不是真跑一次子进程。
 *
 * ⚠️ 共用的不变量见 `./AGENTS.md`。
 *
 * @module tests/input
 */

import { describe, expect, it } from "vitest";

import { exitBoundary, type ExitSteps } from "@/cli.js";
import { ENTER, mount, typed } from "./_shared.js";

/** 一份记数的退出边界（⚠️ `restore` / `closeLedgerDb` 各自带**幂等守卫**，而守卫住在实现里而不是这里） */
function counted(): { readonly steps: ExitSteps; readonly codes: number[]; readonly closes: number[] } {
  const codes: number[] = [];
  const closes: number[] = [];
  let restored = false;
  let closed = false;
  return {
    codes,
    closes,
    steps: {
      unmount: () => undefined,
      restore: () => {
        if (restored) return;
        restored = true;
      },
      releaseWarnings: () => undefined,
      closeLedgerDb: () => {
        if (closed) return;
        closed = true;
        closes.push(1);
      },
      writeStderr: () => undefined,
      setExitCode: (code) => codes.push(code),
    },
  };
}

describe("最后一跳：`/exit` ⇒ `request-exit` ⇒ 注入点被调", () => {
  it("⚠️ `/exit` 与 `/quit` 都落到**同一个**注入点上，而每一条各调一次", async () => {
    for (const line of ["/exit", "/quit"]) {
      let hits = 0;
      const ui = await mount({
        interactive: false,
        exit: () => {
          hits += 1;
        },
      });
      await ui.feed([...typed(line), ENTER]);
      await ui.finish();
      // ⚠️ **判据是那个注入点的调用次数**：它就是 `cli.tsx` 里 `finish(0, null)` 的唯一落点，
      // 而「退得成」这件事在组合根之外没有任何别的可观察后果
      expect(hits, line).toBe(1);
    }
  });

  it("⚠️ 别的命令**不会**碰到那个注入点（正向对照：这条判据不是恒真）", async () => {
    let hits = 0;
    const ui = await mount({
      interactive: false,
      exit: () => {
        hits += 1;
      },
    });
    await ui.feed([...typed("/help"), ENTER]);
    await ui.finish();
    expect(hits).toBe(0);
  });
});

describe("退出码 0 与 `finish` 的幂等（组合根那一格，注入点断）", () => {
  it("⚠️ `finish(0, null)` ⇒ 退出码是 **0**，而收尾那四步按顺序各走一次", () => {
    const order: string[] = [];
    const steps: ExitSteps = {
      unmount: () => order.push("unmount"),
      restore: () => order.push("restore"),
      releaseWarnings: () => order.push("releaseWarnings"),
      closeLedgerDb: () => order.push("closeLedgerDb"),
      writeStderr: () => order.push("writeStderr"),
      setExitCode: () => order.push("setExitCode"),
    };
    const finish = exitBoundary(steps);
    finish(0, null);
    // ⚠️ **核心判据**：退出码是 0（`/exit` 是正常退出，而它绝不许显示成「出错了」）
    expect(order[order.length - 1]).toBe("setExitCode");
    // ⚠️ **顺序也是判据**：`unmount()` → 撤本包的序列 → 收过滤器 → 收库，而收库**在**撤过滤器之后 ——
    // 库里存着 provider 的凭据，撤得太早就有一个真的 warning 打出去
    expect(order).toEqual([
      "unmount",
      "restore",
      "releaseWarnings",
      "closeLedgerDb",
      "setExitCode",
    ]);
  });

  it("⚠️ 有话说时它写进 stderr，而**写完之后**才设退出码", () => {
    const lines: string[] = [];
    const order: string[] = [];
    const finish = exitBoundary({
      unmount: () => undefined,
      restore: () => undefined,
      releaseWarnings: () => undefined,
      closeLedgerDb: () => undefined,
      writeStderr: (text) => {
        order.push("writeStderr");
        lines.push(text);
      },
      setExitCode: () => order.push("setExitCode"),
    });
    finish(1, "boom");
    expect(lines).toEqual(["boom\n"]);
    // ⚠️ 判据是**次序**：`process.exit()` 会在收尾完成前把进程切断，故先写后设
    expect(order).toEqual(["writeStderr", "setExitCode"]);
    // ⚠️ **反向自检**：没有话说时 stderr 一个字节都不写（而不是写一个空行）
    const quiet: string[] = [];
    exitBoundary({
      unmount: () => undefined,
      restore: () => undefined,
      releaseWarnings: () => undefined,
      closeLedgerDb: () => undefined,
      writeStderr: (text) => quiet.push(text),
      setExitCode: () => undefined,
    })(0, null);
    expect(quiet).toEqual([]);
  });

  it("⚠️ **幂等**：连续两次调用的可观察后果是「终端恢复序列只发一次、库只收一次、退出码仍是 0」", () => {
    const countedOnce = counted();
    const finish = exitBoundary(countedOnce.steps);
    finish(0, null);
    finish(0, null);
    // ⚠️ **为什么这样就成立**：幂等不是 `finish` 自己记一个「已释放」标志发绿牌，而是它调的那几件
    // 东西**各自**带守卫（`chainRestores` 的 `done` / `closeLedgerDb` 的「先清引用」）⇒ 第二次是空操作
    expect(countedOnce.closes).toEqual([1]);
    expect(countedOnce.codes).toEqual([0, 0]);
    // ⚠️ **正向对照**：守卫真的认得第二次 —— 一份**没有**守卫的收尾连着跑两次会收两次库
    let naive = 0;
    exitBoundary({
      unmount: () => undefined,
      restore: () => undefined,
      releaseWarnings: () => undefined,
      closeLedgerDb: () => {
        naive += 1;
      },
      writeStderr: () => undefined,
      setExitCode: () => undefined,
    })(0, null);
    exitBoundary({
      unmount: () => undefined,
      restore: () => undefined,
      releaseWarnings: () => undefined,
      closeLedgerDb: () => {
        naive += 1;
      },
      writeStderr: () => undefined,
      setExitCode: () => undefined,
    })(0, null);
    expect(naive).toBe(2);
  });

  it("⚠️ **头一步抛了也照样收库**（四步各兜各的，捆在一个 try 里会留下一个没人收的句柄）", () => {
    const closed: string[] = [];
    exitBoundary({
      unmount: () => {
        throw new Error("Ink 收尾失败");
      },
      restore: () => {
        throw new Error("终端恢复失败");
      },
      releaseWarnings: () => {
        throw new Error("过滤器撤销失败");
      },
      closeLedgerDb: () => closed.push("closed"),
      writeStderr: () => undefined,
      setExitCode: () => undefined,
    })(0, null);
    // ⚠️ 判据是**库真的收了**：三步都抛而第四步没跑 ⇒ WAL 上留一个没人收的句柄
    expect(closed).toEqual(["closed"]);
  });
});