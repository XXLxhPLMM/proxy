/**
 * @fileoverview 「一个操作工具 → 一次或多次请求」的形状 —— 扇出与聚合的那一层
 * @module tools/registry-tools
 * @description
 * 每个操作类工具的 body 都是同一个形状：**解出 targets → 逐个跑一个闭包 → 聚合成给模型看的文本**。
 * 那段「逐个跑 + 聚合」**只写一次**，因为它的三个决定不容许每个工具各选一次：
 *
 * ## ① **串行**，不并发
 * @description 这些工具写的是**别人的机器**上的账号表与名单。并发会让「a 改完 b 改」的顺序
 * 变成不确定的，而一个写操作序列的顺序是它的语义的一部分。
 *
 * ## ② **一个失败不停整批**
 * @description N 台里 2 台失败，另 3 台改成功 —— 那是一个**成功**的结果，模型需要看到哪两台
 * 没成以及为什么。一次失败就整批中止等于「前两台的写已经落地了，但模型不知道」。
 * ⚠️ 所以每台的结果**独立**记，且**逐台点名**。
 *
 * ## ③ 聚合输出是 **JSON**，不是给人看的表格
 * @description 消费面是模型，而模型要的是能自己挑字段的结构。表格会逼它从一列宽的文本里
 * 再解析一次 —— 那正是把「对面返回的事实」变成「模型转述的近似」的地方。
 */

import { createClient } from "../utils/request.js";
import { asMcpError } from "../utils/errors.js";
import { resolveTargets, type Target } from "../store/index.js";

/** 一台的结果（**成功与失败是同一个形状** —— 模型不必先判类型再读字段） */
export interface TargetOutcome {
  /** 逐台点名：⚠️ 返回值里必须能看出「这一条是谁的」 */
  readonly manager: string;
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  /** 失败时是 {@link asMcpError} 的 `toReport()`，**不含** baseUrl 与 key */
  readonly error?: string;
}

/** 一批结果的聚合体 */
export interface BatchReport {
  readonly scope: string;
  readonly total: number;
  readonly failed: number;
  readonly results: readonly TargetOutcome[];
}

/**
 * 扇出跑一遍
 * @param homedir 清单位置
 * @param refs `managers` 形参的原始值（`undefined` ⇒ 当前激活的环境）
 * @param run 每台要跑什么；⚠️ 抛异常即该台失败，**不许**自己吞
 */
export async function fanOut(
  homedir: string,
  refs: unknown,
  run: (target: Target) => Promise<unknown>,
): Promise<BatchReport> {
  const scope = resolveTargets(homedir, refs);
  const results: TargetOutcome[] = [];
  for (const target of scope.targets) {
    const { record } = target;
    try {
      // 串行：见文件头第 ① 条
      results.push({
        manager: record.name,
        id: record.id,
        ok: true,
        result: await run(target),
      });
    } catch (err) {
      results.push({
        manager: record.name,
        id: record.id,
        ok: false,
        error: asMcpError(err).toReport(),
      });
    }
  }
  return {
    scope: scope.reason,
    total: results.length,
    failed: results.filter((one) => !one.ok).length,
    results,
  };
}

/** 在一台上建 client 并跑（⚠️ client 每台建一个，不复用 —— 复用会让一个 baseUrl 的连接池跨地址共享） */
export function onTarget<T>(
  target: Target,
  run: (http: ReturnType<typeof createClient>) => Promise<T>,
): Promise<T> {
  return run(createClient(target.connection));
}

/** 聚合体 → 给模型的文本（⚠️ **一行一个 manager**，且失败排在前面） */
export function renderReport(report: BatchReport): string {
  const failed = report.results.filter((one) => !one.ok);
  const ok = report.results.filter((one) => one.ok);
  const parts: string[] = [
    `范围：${report.scope} · 共 ${String(report.total)} 台 · 失败 ${String(report.failed)} 台`,
  ];
  if (failed.length > 0) {
    // ⚠️ 失败在前：模型的注意力先落在「没成的事」上
    parts.push(`失败：\n${failed.map((one) => `  - ${one.manager}(${one.id})：${one.error ?? ""}`).join("\n")}`);
  }
  if (ok.length > 0) {
    parts.push(
      `成功：\n${ok
        .map((one) => `  - ${one.manager}(${one.id})：${JSON.stringify(one.result)}`)
        .join("\n")}`,
    );
  }
  return parts.join("\n");
}

/** 单台操作的便捷出口（清单类工具：读一次就够，不需要扇出） */
export async function oneShot(
  homedir: string,
  refs: unknown,
  run: (target: Target) => Promise<unknown>,
): Promise<string> {
  const report = await fanOut(homedir, refs, run);
  return renderReport(report);
}
