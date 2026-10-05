/**
 * `[lifecycle]` 那一族两档共用的装配面：临时目录、真 logger、JSONL 读取，以及那两条跃迁逐字契约。
 *
 * @description
 * 主题级不变量与三条装配裁决归 `./AGENTS.md`，本模块只提供两档都要的那一套符号与 hook。
 *
 * ⚠️ **刻意住在 `tests/integration/logging/` 而不是 `tests/helpers/`**：`external-network-scan.ts`
 * 的 `SCAN_DIRS = ["unit","integration","library"]` 排除 `helpers/`，而 `walk()` 收目录下**全部**
 * `.ts` —— 搬进去等于让本文件从零外网扫描里**静默消失**（`no-external-network.test.ts` 的两条下界
 * 断言照样绿）。论证见 `./AGENTS.md`。
 *
 * @module tests/integration/logging
 */
import { afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore, configAccessorFromStore } from "@/config/index.js";
import { createLogger } from "@/utils/logger/index.js";
import { getFreePort } from "../../helpers/net.js";

/** 一条 JSONL 记录（剥 `ts` 之后逐字段比较用）。 */
export type Record_ = Record<string, unknown>;

/**
 * 一次完整 start/stop 的**恰好四次**跃迁。
 *
 * 口径取自 `core/server/base.ts` 的 `setState`（相同状态直接 return ⇒ 每跃迁恰好一条）：
 * `start()` 发 `idle→starting` / `starting→running`，`stop()` 发 `running→stopping` /
 * `stopping→stopped`。**这四条文本就是本目录的逐字契约**。
 */
export const TRANSITIONS: readonly string[] = [
  "[lifecycle] state idle -> starting protocol=http",
  "[lifecycle] state starting -> running protocol=http",
  "[lifecycle] state running -> stopping protocol=http",
  "[lifecycle] state stopping -> stopped protocol=http",
];

/**
 * 第二轮 `start` 的四条 —— **与第一轮只差 `prev`**：停机后状态是 `stopped` 而不是 `idle`
 * （`BaseProxy.start()` 允许从 `stopped` 重入），所以那一条是 `stopped -> starting`。
 * 逐条列出来而不是「第一轮的清单 ×2」：第二轮的 `prev` 变了，那正是「`prev` 取自信封
 * 而不是自己记一份状态」的直接证据。
 */
export const TRANSITIONS_ROUND2: readonly string[] = [
  "[lifecycle] state stopped -> starting protocol=http",
  "[lifecycle] state starting -> running protocol=http",
  "[lifecycle] state running -> stopping protocol=http",
  "[lifecycle] state stopping -> stopped protocol=http",
];

/** 本例的临时根 / 落盘基址 / 代理端口 —— 由下面那两个 hook 每例重建。 */
export let dir: string;
export let logDir: string;
export let port: number;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-lifelog-"));
  // 落盘基址与 configDir 分开两个子目录：断言「哪些文件是日志」时不被别的产物混进来
  logDir = path.join(dir, "logs");
  port = await getFreePort();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 落盘基址钉死到本例临时目录；控制台静音、落盘 debug 级（`[lifecycle]` 是 debug） */
export function baseConfig(): Record<string, unknown> {
  return {
    host: "127.0.0.1",
    port,
    logLevel: "silent",
    logFileLevel: "debug",
    proxyProtocol: "http",
    proxyMode: "server",
    upstreamProtocol: "http",
  };
}

/**
 * 库调用方注入的真 logger：`createLogger` 是包入口**唯一**导出的构造入口
 * （`LoggerImpl` 在 `src/index.ts` 上是 **type-only** re-export），所以走它才是真实的库故事。
 */
export function libraryLogger(): ReturnType<typeof createLogger> {
  const store = new ConfigStore({ logLevel: "silent", logFileLevel: "debug", logFile: logDir });
  return createLogger({ config: configAccessorFromStore(store) });
}

/** 读全部 JSONL 记录；`logger.flush()` 之后不必轮询 */
export async function readRecords(logger: { flush?(): Promise<void> }): Promise<Record_[]> {
  await logger.flush?.();
  const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.endsWith(".jsonl")) : [];
  const lines: Record_[] = [];
  for (const f of files) {
    for (const l of fs.readFileSync(path.join(logDir, f), "utf8").split("\n")) {
      if (l.trim() !== "") {
        lines.push(JSON.parse(l) as Record_);
      }
    }
  }
  return lines;
}

/** 只挑 `[lifecycle]` 那几行，剥 `ts`/`pid`（跨路径必然不同的两个字段）后按 JSON 排序 */
export function lifecycleLines(lines: Record_[]): Record_[] {
  return lines
    .filter((l) => String(l.msg).startsWith("[lifecycle]"))
    .map((l) => {
      const copy = { ...l };
      delete copy.ts;
      delete copy.pid;
      return copy;
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
