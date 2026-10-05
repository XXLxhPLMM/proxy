import type { ProxyRuntime } from "@/runtime/index.js";

/**
 * `createProxyRuntime` 各档共用的两样东西：runtime 的归属登记 + 进程快照观测器
 *
 * @description
 * `own` 是「本档造出来的 runtime 归谁收尾」的**唯一**登记口：`start()` 失败的那条路上
 * runtime 可能压根没起来，靠断言里的 `finally` 收尾就会漏，所以每个档把自己造的交进来，
 * 由各档的 `afterEach` 统一 `stop()`。`processSnapshot` 是「构造期零副作用」那条断言的
 * 观测器 —— env / argv / 进程监听器**三样一起**比，少比一样就漏掉一类副作用。
 *
 * ⚠️ 归本目录的 `_*.ts` 而不是 `tests/helpers/`：不带 `.test.ts` 后缀的文件不会被 vitest
 * 收集，放在这儿不会变成一份空跑的空档；而 `tests/helpers/` 在零外网扫描的 `SCAN_DIRS`
 * 之外，进出会让「本目录的判据仍被扫到」这件事变得不可见。
 */
const activeRuntimes: ProxyRuntime[] = [];

export function own(runtime: ProxyRuntime): ProxyRuntime {
  activeRuntimes.push(runtime);
  return runtime;
}

/** 收尾：`splice(0)` 抽干登记表。停机失败的 runtime 不阻断其余 runtime 的收尾。 */
export async function stopOwnedRuntimes(): Promise<void> {
  const runtimes = activeRuntimes.splice(0);
  for (const runtime of runtimes) {
    await runtime.stop().catch(() => undefined);
  }
}

export function processSnapshot(): {
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  eventNames: string[];
} {
  return {
    env: { ...process.env },
    argv: [...process.argv],
    eventNames: process
      .eventNames()
      .map((name) => String(name))
      .sort(),
  };
}