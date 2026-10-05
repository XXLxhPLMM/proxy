/**
 * `config/unknown-keys` 两档共用的入参
 *
 * @description
 * ⚠️ **与 `../loader/_config-loader.ts` 里的 `withTmpConfigDir` 同名不同物**：那是加载器那三档的
 * 入参，本模块服务的是未知键闸门那两档，各自的 `mkdtemp` 前缀也不同。判据是「两个以上档真用到」
 * 而不是「两处代码一样」—— 合成一份会造出一处跨目录的新耦合，复制两份则让改一处忘另一处。
 * ⚠️ 本模块刻意住在 `tests/unit/` 里面而不是 `tests/helpers/`：后者不在零外网扫描的
 * `SCAN_DIRS` 里，前导搬进去等于让那道护栏对这部分代码彻底失效且一声不吭。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { loadConfig } from "@/config/index.js";

/** 临时配置目录；避免任何一条用例碰到仓库根的 `.env.development` 与 `cfg/`。 */
export async function withTmpConfigDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "proxy-unknown-keys-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 所有加载调用的共同基座：`AUTH_ENABLED=false` 让断言不必顺带满足启动期账号表强校验。
 * @description `skipFileValidation` 避开启动期 JSON 强校验 —— 本目录验的是**未知键闸门**，
 * 名单内容不是它的被测面。
 */
export function loadOptions(cwd: string) {
  return {
    env: { AUTH_ENABLED: "false" },
    envFiles: [] as string[],
    argv: [] as string[],
    cwd,
    skipFileValidation: true,
  };
}

/** 只经 `loadConfig` 这一个入口断言（不留第二个真相源）。 */
export async function loadArgv(argv: string[], cwd: string) {
  return loadConfig({ ...loadOptions(cwd), argv });
}

/** 断言这一步**必须**让启动失败，并返回错误文案（文案本身就是被测面）。 */
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