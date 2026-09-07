/**
 * WebSocket/Upgrade 转发 - 协议升级请求的客户端↔上游转发
 * 流程：解析目标 → 自环 guard → 建 TCP → 写升级请求 → 等 101 → 双向 pipe
 * - server 模式：从请求 URL / Host 头解析目标
 * - client 模式：使用上游配置（upstreamHost/upstreamPort）
 * 设计：纯函数，无状态；本层零日志，事件经 PipeEventSink 上抛，缺省静默
 */

import http from "node:http";
import { get } from "@/config/store.js";
import { bridgeSockets, isSelfLoop } from "@/core/proxy-helpers.js";
import {
  CRLF,
  DOUBLE_CRLF,
  DOUBLE_CRLF_BUF,
  STATUS_SWITCHING_PROTOCOLS,
} from "@/utils/constants.js";
import type { PipeEventSink } from "../types/pipe.js";
import { createPipeEmitter, dialUpstream, rebuildHeaderLines, resolveHttpTarget } from "./shared.js";

/** 等上游响应头块：攒 Buffer 到 DOUBLE_CRLF 后一次性交判定（upgrade 101 判定用） */
function collectHeaderBlock(
  upstreamSocket: import("node:stream").Duplex,
  onBlock: (headerBlock: Buffer, rest: Buffer) => void,
): void {
  let pending = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf(DOUBLE_CRLF_BUF);
    if (end === -1) return;
    upstreamSocket.removeListener("data", onData);
    onBlock(pending.subarray(0, end + DOUBLE_CRLF_BUF.length), pending.subarray(end + DOUBLE_CRLF_BUF.length));
  };
  upstreamSocket.on("data", onData);
}

/**
 * WebSocket/Upgrade 协议升级转发
 * - server 模式：从请求 URL / Host 头解析目标
 * - client 模式：使用上游配置（upstreamHost/upstreamPort）
 * 流程：解析目标 → 自环 guard → 建 TCP → 写升级请求 → 等 101 → 双向 pipe
 */
export function forwardUpgrade(
  clientReq: http.IncomingMessage,
  clientSocket: import("node:stream").Duplex,
  head: Buffer,
  onEvent?: PipeEventSink,
): void {
  const emit = createPipeEmitter(onEvent);
  const mode = get("proxyMode");
  const target = resolveHttpTarget(clientReq, mode);
  if (!target) {
    emit({ type: "target-unresolved", url: clientReq.url });
    clientSocket.destroy();
    return;
  }

  // 防止循环转发：目标地址是代理自身
  if (isSelfLoop(target.host, target.port)) {
    emit({ type: "loop-detected", detail: `upgrade ${clientReq.url} -> ${target.host}:${target.port}` });
    clientSocket.destroy();
    return;
  }

  emit({ type: "debug", message: () => `upgrade ${clientReq.url} -> ${target.host}:${target.port} (mode: ${mode})` });

  // 无 ServerResponse 可写，建链失败只断开不写兜底
  dialUpstream(clientSocket, target.host, target.port, (upstreamSocket, dial) => {
    const upgradeRequest = buildUpgradeRequest(clientReq, target.host, target.port, target.path);
    emit({ type: "debug", message: () => `upgrade request:\n${upgradeRequest}` });
    upstreamSocket.write(upgradeRequest);

    // 转发 head 中的剩余数据
    if (head.length > 0) {
      upstreamSocket.write(head);
    }

    relayUpgradeHandshake(clientSocket, upstreamSocket, dial);
  }, { logPrefix: "upgrade", timeoutReply: "", errorReply: "" });
}

/** 重建 HTTP Upgrade 请求：相对路径 + rawHeaders 回填（proxy-* 头已滤），Host 重写为目标 */
function buildUpgradeRequest(
  clientReq: http.IncomingMessage,
  targetHost: string,
  targetPort: number,
  targetPath: string,
): string {
  const requestLine = `${clientReq.method} ${targetPath} HTTP/${clientReq.httpVersion}${CRLF}`;
  const headerPairs = rebuildHeaderLines(clientReq, `${targetHost}:${targetPort}`);
  return `${requestLine}${headerPairs.join(CRLF)}${DOUBLE_CRLF}`;
}

/** 等上游 101：成功则回 101 头 + 双向 pipe，失败把上游响应原样甩回客户端 */
function relayUpgradeHandshake(
  clientSocket: import("node:stream").Duplex,
  upstreamSocket: import("node:stream").Duplex,
  dial: { established: () => void },
): void {
  collectHeaderBlock(upstreamSocket, (headerBlock, rest) => {
    if (headerBlock.toString().includes(String(STATUS_SWITCHING_PROTOCOLS))) {
      dial.established();
      clientSocket.write(headerBlock);
      if (rest.length > 0) clientSocket.write(rest);
      bridgeSockets(clientSocket, upstreamSocket, "upgrade");
    } else {
      clientSocket.write(Buffer.concat([headerBlock, rest]));
      upstreamSocket.destroy();
      clientSocket.destroy();
    }
  });
}
