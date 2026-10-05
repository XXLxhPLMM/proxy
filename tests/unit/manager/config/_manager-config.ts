/**
 * `manager/config` 五档共用的前导（`load` 这一个入口 / `TOKEN` / `withTmpDir` / `rejectionMessage`）
 *
 * @description
 * 目录级不变量归 `./AGENTS.md`，不复制进本文件。本模块只放**两个以上档真用到**的入参；
 * 只被一档用到的（`fields` 的 `fieldOf`、`snapshot` 的 `logConfigRecords`）留在那一档的文件头。
 *
 * ⚠️ **必须留在本目录**：`SCAN_DIRS` 排除 `tests/helpers/` 且 `walk()` 收目录下全部 `.ts`，
 * 而 `cors.test.ts` 的 origin 字面量带公网 host —— 搬进 `helpers/` 等于那部分覆盖从零外网扫描里
 * 静默消失，而下界断言照样绿。**可见的重复优于看不见的失效。**
 *
 * @module tests/unit/manager/config
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { loadConfig } from "@/config/index.js";

/**
 * 明文 canary：脱敏那一档拿它当「日志里一个字都不许出现」的探针
 * @description 必须**逐字不同**于 `jwtSecret` / `tlsPassphrase` 那两个 canary ——
 * 同值的话「这一组 secret 打码了」会连带把另外两组也判成过。
 */
export const TOKEN = "mgr-plaintext-canary-8f3a";

/** 临时配置目录；避免任何一条用例碰到仓库根的 `.env.development` 与 `cfg/`。 */
export async function withTmpDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "manager-config-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 只经 `loadConfig` 这一个入口；`skipFileValidation` 避开启动期 JSON 强校验（与本目录判据无关）
 */
export function load(cwd: string, options: { env?: Record<string, string>; argv?: string[] } = {}) {
  return loadConfig({
    env: options.env ?? {},
    envFiles: [],
    argv: options.argv ?? [],
    cwd,
    skipFileValidation: true,
  });
}

/** 把一次「启动必须失败」的结果取成**报错原文**：断言逐字文案的那几档全靠它。 */
export async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "这一步必须让启动失败").toBeInstanceOf(Error);
  return (thrown as Error).message;
}