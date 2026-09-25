/**
 * @fileoverview 文件状态探测：一次 stat，三态分类
 * @module utils/json-file/probe
 * @description
 * 读配置前只问一个问题：**这个路径现在算不算「有一个可读的普通文件」**。
 * 答案分三态，缺一不可：
 * - `ok`：普通文件，可继续读
 * - `missing`：`ENOENT` / `ENOTDIR` / 目录等非普通文件 → 回退空配置，**不算错误**
 * - `stat-error`：其它 stat 错误（`EACCES` / `EPERM` / `ELOOP` / `ENAMETOOLONG` …）
 *   → 状态**不可观测**，保留上一份有效值并报 `error`，绝不伪装成 missing
 *   （否则 ACL 会因为一次权限问题静默变成全放行）
 *
 * 职责：
 * - `probeFile(absolutePath)` 分类
 * - `isMissingStatError(error)` errno 判定
 * - `errorMessage(error)` 抛错 → 文案（本目录**唯一**口径，`read-validate` 复用）
 *
 * 不负责：
 * - 不读文件内容、不做大小/JSON/结构校验（`read-validate.ts`）
 * - 不决定回退到哪份值、不派发事件（`json-file.ts` / `subscriber.ts`）
 */

import fs from "node:fs";

/** `errorMessage` 抛错 → 文案的唯一口径：Error 取 message，其余按字符串化 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 只有 `ENOENT`（路径不存在）与 `ENOTDIR`（路径前缀不是目录）算「文件缺失」 */
export function isMissingStatError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** stat 探测结果三态 */
export type FileProbe =
  /** 存在且是普通文件 */
  | { readonly kind: "ok"; readonly stats: fs.Stats }
  /** 缺失（ENOENT / ENOTDIR）或不是普通文件（目录、socket、fifo…） */
  | { readonly kind: "missing" }
  /** 状态不可观测：保留上一份有效值并报 error */
  | { readonly kind: "stat-error"; readonly message: string };

/**
 * 探测文件状态。**绝不抛**（stat 的任何失败都被归入三态之一）。
 *
 * @param absolutePath - 已绝对化的文件路径
 */
export function probeFile(absolutePath: string): FileProbe {
  let stats: fs.Stats;
  try {
    // 必须走 `fs.statSync` 属性访问：测试用 `vi.spyOn(fs, "statSync")` 打桩，
    // 顶层解构成局部常量会绕过 spy。
    stats = fs.statSync(absolutePath);
  } catch (error) {
    return isMissingStatError(error)
      ? { kind: "missing" }
      : { kind: "stat-error", message: errorMessage(error) };
  }
  // 目录、socket 等读不出 JSON 内容，按缺失处理
  return stats.isFile() ? { kind: "ok", stats } : { kind: "missing" };
}
