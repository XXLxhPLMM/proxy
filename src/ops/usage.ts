/**
 * @fileoverview 配额账本的**只读**读面
 * @module ops/usage
 * @description
 * 账本读法与 `runtime/services.ts:buildDefaultServices` 装配的那份**逐字同形**（同一个
 * `UsageSourceSpec` 形状、同一个窗口口径），所以「CLI 看到的数」与「代理用来判超限的数」是
 * 同一个口径下的同一个数——包括那个 `2P` 的滞后（`@/datasource/quota/mirror.ts:mirrorLagBoundMs`）：
 * **运行中的代理可能比账本落后至多一个 `2P`**（默认落盘周期下是秒级），故本命令的输出只说
 * 「账本此刻记着多少」，绝不说「这个账号现在还能用多少」——后者是代理进程内存里的数，不是这份文件。
 *
 * ## 为什么**没有** `usage reset`（这是「未做」，不是「没来得及」）
 *
 * 判定读的是**进程内镜像**，而镜像吸收回读时合并用 `max(本进程值, 权威值)`
 * （`UsageMirror.absorb`）。于是从第二个进程删掉账本里的行之后：
 *
 * ```
 * CLI 删掉 alice 的行    →  账本权威值 = 0
 * 运行中代理的镜像值    =  8 GiB（它自己这轮还没落盘的那部分，或上一轮回读的旧值）
 * absorb(0) → max(8 GiB, 0) = 8 GiB      ← 删除永不生效
 * ```
 *
 * 那个 `max` 是**正确性的一部分**（它防的是「重复计账导致用户莫名其妙提前撞顶」），不能为了
 * 支持 CLI 而改掉；而改成「取 min / 直接覆盖」会把多进程累加打回原形。于是：
 *
 * - 提供 `usage reset` 的话，它在**代理运行时静默无效**，退出码却是 0；
 * - 不提供的话，操作者拿到的是一句诚实的「这个工具不能清账」以及**为什么**。
 *
 * 本仓最恨的就是前一种形状（命令成功、结果没变、零信号）。要真的清账只有一条路：
 * **停掉代理 → 手工改账本 / 删库 → 重启**（重启后 `open()` 的首次回读就是新的起点）。
 *
 * @module
 */

import { mirrorLagBoundMs } from "@/datasource/quota/index.js";
import type { UsageSnapshot, WindowUsage } from "@/datasource/quota/index.js";
import { OpsError } from "./error.js";
import type { OpsSources } from "./sources.js";

/** 账本一次读面的结果（**结构化**：原始窗口记录 + 两项旁路事实，排序与呈现归调用方） */
export interface OpsUsageReading {
  /** 回读 / 落盘失败的旁路。本工具只读不写，理论上为空；非空即数据有问题 */
  readonly errors: readonly string[];
  /** 镜像误差上界：这个账本读数最多比运行中代理的判定新这么多毫秒 */
  readonly lagMs: number;
  /** 当前窗口**全部**用户的记录（账本里是什么顺序就是什么顺序，**未排序**） */
  readonly usage: ReadonlyMap<string, WindowUsage>;
}

/**
 * 打开账本读一次当前窗口的用量，然后立刻关掉
 * @description
 * 走的是数据源**既有的** `UsageSourceController.open/close`（都幂等，`open()` = 建存储 →
 * **回读一次** → 起周期循环）。本工具不需要那条周期循环，而端口上没有「只回读不起循环」的更小
 * 接口——于是用了 `open()` + `close()`：短命进程里那条定时器根本来不及跑，而 `close()` 顺带
 * 做掉了「最后一次同步 + 关存储」。
 *
 * **⚠️ 副作用是真的**：对 json 档，`open()` 会把账本文件物化出来（若不存在）。那是数据源自己
 * 「目标不存在就物化」的纪律，与本工具无关，但它意味着**「查一下用量」在空部署上会留下一个空账本
 * 文件**。如实说明好过悄悄留下。
 */
async function snapshotOnce(sources: OpsSources): Promise<{
  snapshot: UsageSnapshot;
  errors: string[];
}> {
  let snapshot: UsageSnapshot = new Map();
  const errors: string[] = [];

  const source = sources.usage({
    // `open()` 里的**第一次**回读就是我们要的那一份；此后每轮周期还会再推，但那需要一个周期
    // 才会发生，而本函数在它之前就 `close()` 了。故覆盖式赋值即可（多来一次也无害）。
    onSnapshot: (s) => {
      snapshot = s;
    },
    onError: (e) => {
      errors.push(`${e.path}: ${e.error instanceof Error ? e.error.message : String(e.error)}`);
    },
  });

  try {
    await source.open();
    return { snapshot, errors };
  } finally {
    // 幂等；失败也不该盖掉上面抛出的真错误
    await source.close().catch(() => undefined);
  }
}

/**
 * 读一次当前窗口的用量
 * @description
 * 账本只收「有身份且真被计量过」的用户，故**空表是一份合法答案**（空部署上就是空的）。
 * @throws {Error} 账本 `open()` 抛出的真错误（IO / 驱动），原样上抛
 */
export async function readUsage(sources: OpsSources): Promise<OpsUsageReading> {
  const { snapshot, errors } = await snapshotOnce(sources);
  return {
    errors,
    lagMs: mirrorLagBoundMs(sources.config.get("quotaFlushInterval")),
    usage: snapshot,
  };
}

/**
 * 从一次读面里取某个用户的当前用量
 * @throws {OpsError} `not-found`：账本里没有他当前窗口的记录
 */
export function usageFor(reading: OpsUsageReading, user: string): WindowUsage {
  const usage = reading.usage.get(user);
  if (usage === undefined) {
    throw new OpsError(
      "not-found",
      `账本里没有 ${user} 当前窗口的用量记录` +
        "（账本只收「有身份且真被计量过」的用户；没配配额也照常计量，所以「没记录」= 从没被计量过）",
    );
  }
  return usage;
}