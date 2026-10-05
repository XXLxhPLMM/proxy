/**
 * `config/loader` 三档共用的入参
 *
 * @description
 * 只放**两个以上档真用到**的东西。只被一档用到的入参留在那一档文件头（多一跳不如少一跳）。
 * ⚠️ 本模块刻意住在 `tests/unit/` 里面而不是 `tests/helpers/`：后者不在零外网扫描的
 * `SCAN_DIRS` 里，前导搬进去等于让那道护栏对这部分代码彻底失效且一声不吭。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** 临时配置目录；避免任何一条用例碰到仓库根的 `.env.development` 与 `cfg/`。 */
export async function withTmpConfigDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "proxy-loadconfig-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}