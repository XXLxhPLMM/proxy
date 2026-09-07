/**
 * connectors/base - 上游连接器基类（模板方法）+ 隧道公共件
 * 职责：
 * - BaseUpstreamConnector：固化 dial() 全流程（settled 仲裁 + guardDialing 守卫 + error 兜底），
 *   子类只实现 open()（怎么建 socket、建链成功算什么时机）；bridge() 稳态接线复用本文件 bridgeSockets
 * - bridgeSockets：稳态双向 pipe 唯一实现（forward/connect、forward/websocket、tunnelConnect 共用）
 * - tunnelConnect：直拨隧道建链（server/socks、server/tls 用），从 proxy-helpers 迁入以保依赖单向 base -> proxy-helpers
 * 本层零日志，观测经 onEvent 槽上抛
 */

import net from "node:net";
import type { Duplex } from "node:stream";
import { get } from "@/config/store.js";
import { createHelperEmitter, guardDialing } from "@/core/proxy-helpers.js";
import type { DialGuardOptions, HelperEventSink } from "@/core/proxy-helpers.js";
import { HTTP_200_CONNECTION_ESTABLISHED } from "@/utils/constants.js";
import type { DialHandle, DialResult } from "@/core/types/connector.js";
import type { ProxyProtocol } from "@/core/types/proxy.js";




/**
 * 稳态双向 pipe：建链成功后调用，只断不断写
 * 前提：已配 guardDialing（close 互杀与 client error 由它兜底），这里只补上游 error
 */
export function bridgeSockets(
  clientSocket: Duplex,
  upstreamSocket: Duplex,
  logPrefix = "tunnel",
  onEvent?: HelperEventSink,
): void {
  upstreamSocket.pipe(clientSocket);
  clientSocket.pipe(upstreamSocket);
  upstreamSocket.on("error", (err) => {
    try {
      onEvent?.({ type: "upstream-error", message: `[${logPrefix}] upstream error`, err });
    } catch {}
    if (!clientSocket.destroyed) clientSocket.destroy();
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  });
}


export abstract class BaseUpstreamConnector {
  /** 协议标识（超时错误信息用） */
  abstract readonly protocol: ProxyProtocol;

  /**
   * 建立底层 socket：子类实现 net.connect / tls.connect 等差异点
   * @param onConnected 建链成功时机由子类裁决（net=connect，tls=secureConnect），基类在此 resolve
   */
  protected abstract open(host: string, port: number, onConnected: () => void): Duplex;

  /** 拨号：建链成功 resolve({socket, dial})，失败/超时 reject（上游 socket 由守卫销毁） */
  dial(clientSocket: Duplex, host: string, port: number, guardOpts?: DialGuardOptions): Promise<DialResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };
      const upstreamSocket = this.open(host, port, () => {
        settle(() => resolve({ socket: upstreamSocket, dial }));
      });
      const dial: DialHandle = guardDialing(clientSocket, upstreamSocket, {
        timeout: get("upstreamTimeout"),
        target: `${host}:${port}`,
        ...guardOpts,
        onError: (err) => {
          guardOpts?.onError?.(err);
          settle(() => reject(err));
        },
        onTimeout: () => {
          guardOpts?.onTimeout?.();
          settle(() => reject(new Error(`[${this.protocol}] upstream timeout ${host}:${port}`)));
        },
      });
      upstreamSocket.once("error", (err) => {
        settle(() => reject(err));
      });
    });
  }

  /** 稳态双向 pipe（复用本文件 bridgeSockets）：dial 成功后由调用方择机接线，只断不断写 */
  bridge(clientSocket: Duplex, upstreamSocket: Duplex, logPrefix?: string, onEvent?: HelperEventSink): void {
    bridgeSockets(clientSocket, upstreamSocket, logPrefix, onEvent);
  }
}

/** 隧道拨号选项 */
export interface TunnelOptions {
  /** 客户端 socket（通常是 http 模块的 Duplex） */
  clientSocket: Duplex;
  /** 目标主机 */
  hostname: string;
  /** 目标端口 */
  port: number;
  /** 已读的粘包缓冲 */
  head: Buffer;
  /** 超时 ms */
  timeout: number;
  /** 事件槽：dial/established/超时/错误由此上抛，缺省静默（零日志） */
  onEvent?: HelperEventSink;
  /** 日志前缀，默认 "tunnel" */
  logPrefix?: string;
  /** 连接成功后写入 serverSocket 的预连接数据（SOCKS 帧等） */
  preConnectData?: Buffer;
  /** 自定义成功响应（默认 HTTP/1.1 200 Connection Established） */
  successResponse?: Buffer;
  /** 成功响应的字符串形式（与 successResponse 二选一，Buffer 类型优先） */
  successResponseStr?: string;
  /** 超时/错误销毁前回调（SOCKS 等协议可在此写入拒绝帧） */
  onBeforeDestroy?: (side: "timeout" | "error", err?: Error) => void;
}

/**
 * 统一隧道拨号逻辑 - net.connect → timeout → establish → pipe
 * 建链期守卫与稳态 pipe 复用 guardDialing / bridgeSockets（与转发管道同一套）
 * 注意：默认 error 不写兜底（SOCKS 等裸 socket 协议写 HTTP 文本即垃圾字节），
 * 有 ServerResponse 的调用方（forward/http）自行传 errorReply
 */
export function tunnelConnect(opts: TunnelOptions): void {
  const {
    clientSocket,
    hostname,
    port,
    head,
    timeout,
    onEvent,
    logPrefix = "tunnel",
    preConnectData,
    successResponse,
    successResponseStr,
    onBeforeDestroy,
  } = opts;
  const clientAddr = (clientSocket as unknown as net.Socket).remoteAddress ?? "unknown";

  const emit = createHelperEmitter(onEvent);

  emit({ type: "dial", message: `[${logPrefix}] dial ${clientAddr} -> ${hostname}:${port}` });
  const serverSocket = net.connect(port, hostname, () => {
    dial.established();
    emit({ type: "established", message: `[${logPrefix}] established ${clientAddr} -> ${hostname}:${port}` });
    if (successResponse) {
      clientSocket.write(successResponse);
    } else if (successResponseStr) {
      clientSocket.write(successResponseStr);
    } else {
      clientSocket.write(HTTP_200_CONNECTION_ESTABLISHED);
    }
    if (preConnectData?.length) serverSocket.write(preConnectData);
    if (head.length) serverSocket.write(head);
    bridgeSockets(clientSocket, serverSocket, logPrefix, onEvent);
  });

  const dial = guardDialing(clientSocket, serverSocket, {
    logPrefix,
    timeout,
    target: `${hostname}:${port}`,
    errorReply: "",
    onEvent,
    onTimeout: () => onBeforeDestroy?.("timeout"),
    onError: (err) => onBeforeDestroy?.("error", err),
  });
}
