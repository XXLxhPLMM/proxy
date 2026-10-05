/**
 * `utils/logger/` 四档共用的落盘沙箱（每用例独占一个临时目录 + 读回那一族）
 *
 * @description
 * 双门控语义、五个保留键、单条日志恒为单行、不可序列化参数不许抛这几条共用判据在 `./AGENTS.md`，
 * 不复制进本文件。
 *
 * ⚠️ **共享的是「取一个新目录」的工厂与那份登记簿，不是一个 logger 单例**：logger 端口刻意没有全局状态
 * （`accessor-port.test.ts` 那一档），故这里只导出 `tmpDir()`，各档自己 `new LoggerImpl({ ... })`。
 *
 * @module tests/unit/utils/logger
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 本目录各档临时目录的登记簿：`tmpDir()` 登记，`afterEach` 逐个回收 */
export const tmpDirs: string[] = [];

/** 独立临时目录当落盘基址：无扩展名 -> toHourlyFile 在目录内生成小时文件 */
export function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-test-"));
  tmpDirs.push(dir);
  return dir;
}

/** 解析 JSONL 文本为对象数组（空行跳过） */
export function parseLines(raw: string): Record<string, unknown>[] {
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 目录内已落地的小时日志原始文本；未落盘返回 undefined */
export function readPersistedRaw(dir: string): string | undefined {
  const [file] = fs.readdirSync(dir);
  if (file === undefined) {
    return undefined;
  }
  return fs.readFileSync(path.join(dir, file), "utf8");
}

/** 读取并解析目录内的小时文件（未落盘返回空数组） */
export function readPersistedJson(dir: string): Record<string, unknown>[] {
  const raw = readPersistedRaw(dir);
  return raw === undefined ? [] : parseLines(raw);
}