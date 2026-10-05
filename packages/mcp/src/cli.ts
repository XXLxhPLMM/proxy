#!/usr/bin/env node
/**
 * @fileoverview 进程入口 —— 组装工具表、挂上 stdio、退出码是唯一的失败出口
 * @module cli
 */

import { runStdioServer } from "./protocol/index.js";
import { TOOLS } from "./tools/index.js";
import { asMcpError } from "./utils/errors.js";

/**
 * 组合根
 * @description ⚠️ **stdout 属于协议** —— 诊断一律走 stderr。往 stdout 写一行「加载中」就会让
 * 客户端在解析 JSON 时炸掉，而那行字在终端上看着完全正常。
 */
async function main(): Promise<void> {
  await runStdioServer(TOOLS);
}

main().catch((err: unknown) => {
  // ⚠️ 退出码 1 + 一行可读的原因：起不来时模型与人都只会看到「进程死了」，
  // 而看不出是工具表里有重名还是协议层炸了
  process.stderr.write(`[swain-proxy-mcp] 起不来：${asMcpError(err).toReport()}\n`);
  process.exitCode = 1;
});
