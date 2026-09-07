/**
 * 转发管道公共件 - http/tunnel/websocket 三个转发文件共用的工具
 * 职责：目标解析、上游鉴权头、header 重建、建链包装、事件发射器
 * 设计：纯函数，无状态；本层零日志，事件经 PipeEventSink 上抛
 */

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { get, type AppConfig } from "@/config/store.js";
import {
  createEventEmitter,
  encodeBasicCredentials,
  isProxyHeaderName,
  parseTargetParts,
  type DialGuardOptions,
  type TargetParts,
} from "@/core/proxy-helpers.js";
import { buildProxyAuthValue } from "@/utils/constants.js";
import type { PipeEvent, PipeEventSink } from "../types/pipe.js";
import { NetUpstreamConnector } from "./connectors/net.js";
import { TlsUpstreamConnector, type TlsUpstreamOptions } from "./connectors/tls.js";
import type { Duplex } from "node:stream";

/** 普通 HTTP 目标解析：client 模式读上游配置，server 模式从 URL/Host 双来源解析，失败返回 null 由调用方 emit */
export function resolveHttpTarget(clientReq: http.IncomingMessage, mode: AppConfig["proxyMode"]): TargetParts | null {
  if (mode === "client") {
    return { host: get("upstreamHost"), port: get("upstreamPort"), path: clientReq.url ?? "/" };
  }
  return parseTargetParts(clientReq.url ?? "", clientReq.headers.host);
}

/**
 * 上游鉴权头值：只认显式 upstreamUsername/Password，未配返回 undefined（不带头）
 */
export function resolveUpstreamAuth(
  username: string = get("upstreamUsername"),
  password: string = get("upstreamPassword"),
): string | undefined {
  if (!username) return undefined;
  return buildProxyAuthValue(encodeBasicCredentials(username, password));
}

/** 构造事件发射器：PipeEvent 特化（存量兼容，内部即通用版） */
export function createPipeEmitter(onEvent?: PipeEventSink): (e: PipeEvent) => void {
  return createEventEmitter<PipeEvent>(onEvent);
}

/** 重建请求头行：rawHeaders 扁平数组回填，proxy-* 头过滤，hostRewrite 传了就重写 Host */
export function rebuildHeaderLines(
  clientReq: http.IncomingMessage,
  hostRewrite?: string,
): string[] {
  const lines: string[] = [];
  const raw = clientReq.rawHeaders ?? [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    if (isProxyHeaderName(name)) continue;
    if (hostRewrite !== undefined && name.toLowerCase() === "host") {
      lines.push(`Host: ${hostRewrite}`);
    } else {
      lines.push(`${name}: ${raw[i + 1]}`);
    }
  }
  return lines;
}

/** 可选文件读取：存在才返回内容（上游 CA 缺省回退系统信任库） */
function readOptionalFileShared(p: string): Buffer | undefined {
  return p && fs.existsSync(p) ? fs.readFileSync(p) : undefined;
}

/**
 * 建链收敛点：唯一拨号入口（tunnel/http、websocket 共用）
 * - server 模式或 upstreamProtocol=http → NetUpstreamConnector
 * - client + https/tls → TlsUpstreamConnector（servername/CA/insecure 同 upstream/https 逻辑）
 * 失败时守卫已写 502/504 兜底，这里只吞 reject 防未处理
 */
export function dialUpstream(
  clientSocket: Duplex,
  host: string,
  port: number,
  onConnect: (upstreamSocket: net.Socket, dial: { established: () => void }) => void,
  guardOpts?: DialGuardOptions,
): void {
  const mode = get("proxyMode");
  const upstreamProtocol = mode === "client" ? get("upstreamProtocol") : "http";
  const connector =
    upstreamProtocol === "https" || upstreamProtocol === "tls"
      ? new TlsUpstreamConnector({
          // IP 目标置空跳 SNI（RFC 6066），与 upstream/https 一致
          servername: net.isIP(host) ? "" : host,
          rejectUnauthorized: !get("upstreamInsecure"),
          ca: readOptionalFileShared(get("upstreamCa")),
        } as unknown as TlsUpstreamOptions & { servername: string })
      : new NetUpstreamConnector();

  connector.dial(clientSocket, host, port, guardOpts).then(
    ({ socket, dial }) => onConnect(socket as unknown as net.Socket, dial),
    () => {},
  );
}
