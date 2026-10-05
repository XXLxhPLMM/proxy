/**
 * 喂数据的 stdio harness：把 `Readable` / `Writable` 注入协议层
 * @description
 * ⚠️ 存在的唯一理由是让协议层不依赖模块级 `process.stdin` 单例 ——
 * 单例的话测试只能靠真的换进程来驱动，而「一条 data 事件里塞两行」这类
 * 分片形态在进程外根本造不出来。
 */

import { PassThrough } from "node:stream";

import { serveStdio, type ToolDefinition } from "../../src/protocol/index.js";

export interface Harness {
  /** 结束输入并等协议层 resolve；⛔ 只能调一次 */
  readonly finish: () => Promise<void>;
  /** 原样写一串字节（不补换行），用来制造「分片」与「坏帧」 */
  readonly push: (text: string) => void;
  /** 逐条解析后的响应；⚠️ 只含 JSON-RPC 响应，协议层不写别的 */
  readonly responses: () => unknown[];
  /** 原始输出行（保留文本形态） */
  readonly rawLines: () => string[];
}

function parseLines(raw: string): unknown[] {
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

/** 起一个跑在两条 PassThrough 上的协议层 */
export function startServer(tools: readonly ToolDefinition[]): Harness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let raw = "";
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    raw += chunk;
  });

  const settled = serveStdio({ stdin, stdout }, tools);

  let finished = false;
  return {
    push: (text: string) => {
      stdin.write(text);
    },
    rawLines: () => raw.split("\n").filter((line) => line !== ""),
    responses: () => parseLines(raw),
    finish: async () => {
      if (!finished) {
        finished = true;
        stdin.end();
        await settled;
      }
    },
  };
}

export function request(id: number, method: string, params?: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`;
}

export function notification(method: string, params?: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`;
}

export const ECHO_TOOL: ToolDefinition = {
  name: "echo",
  description: "原样回显",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "要说的话" } },
    required: ["text"],
  },
  handler: async (args) => `echo:${String(args["text"])}`,
};

export const FAILING_TOOL: ToolDefinition = {
  name: "boom",
  description: "必炸",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    throw new Error("炸了");
  },
};